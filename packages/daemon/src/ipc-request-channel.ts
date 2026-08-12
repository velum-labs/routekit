export type RequestReplyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: Error };

export type RequestReplyChannelOptions<Input, Outbound, Response> = {
  readonly idPrefix: string;
  readonly timeoutMs: number;
  readonly encode: (input: Input, requestId: string) => Outbound;
  readonly send: (message: Outbound) => void;
  readonly requestId: (response: Response) => string;
  readonly decode: (response: Response) => RequestReplyResult;
};

export type RequestOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

type PendingRequest = {
  readonly timer: NodeJS.Timeout;
  readonly removeAbortListener?: () => void;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
};

export class RequestReplyChannel<Input, Outbound, Response> {
  readonly #options: RequestReplyChannelOptions<Input, Outbound, Response>;
  readonly #pending = new Map<string, PendingRequest>();
  #sequence = 0;
  #closedError: Error | undefined;

  constructor(options: RequestReplyChannelOptions<Input, Outbound, Response>) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("request/reply channel timeout must be positive");
    }
    this.#options = options;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  async request<T>(input: Input, options: RequestOptions = {}): Promise<T> {
    if (this.#closedError !== undefined) throw this.#closedError;
    if (options.signal?.aborted === true) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("IPC request aborted");
    }
    const requestId = `${this.#options.idPrefix}-${++this.#sequence}`;
    const timeoutMs = options.timeoutMs ?? this.#options.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("IPC request timeout must be positive");
    }
    const response = new Promise<T>((resolve, reject) => {
      const settleAbort = () => {
        const pending = this.#take(requestId);
        if (pending === undefined) return;
        pending.reject(
          options.signal?.reason instanceof Error
            ? options.signal.reason
            : new Error("IPC request aborted")
        );
      };
      const timer = setTimeout(() => {
        const pending = this.#take(requestId);
        if (pending === undefined) return;
        pending.reject(new Error(`IPC request ${requestId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const removeAbortListener =
        options.signal === undefined
          ? undefined
          : () => options.signal?.removeEventListener("abort", settleAbort);
      options.signal?.addEventListener("abort", settleAbort, { once: true });
      this.#pending.set(requestId, {
        timer,
        ...(removeAbortListener !== undefined ? { removeAbortListener } : {}),
        resolve: (value) => resolve(value as T),
        reject
      });
    });
    try {
      this.#options.send(this.#options.encode(input, requestId));
    } catch (error) {
      const pending = this.#take(requestId);
      pending?.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return await response;
  }

  accept(response: Response): boolean {
    const pending = this.#take(this.#options.requestId(response));
    if (pending === undefined) return false;
    const result = this.#options.decode(response);
    if (result.ok) pending.resolve(result.value);
    else pending.reject(result.error);
    return true;
  }

  close(reason: Error = new Error("IPC request channel closed")): void {
    if (this.#closedError !== undefined) return;
    this.#closedError = reason;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.removeAbortListener?.();
      request.reject(reason);
    }
  }

  #take(requestId: string): PendingRequest | undefined {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return undefined;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    return pending;
  }
}
