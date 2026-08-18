/** One decoded SSE event. `data` is the joined payload. */
export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export class SseParseError extends Error {
  readonly snippet: string | undefined;

  constructor(message: string, snippet?: string) {
    super(message);
    this.name = "SseParseError";
    this.snippet = snippet;
  }
}

const SNIPPET_LIMIT = 200;

export function decodeBufferedSse(text: string): SseEvent[] {
  const decoder = new SseDecoder();
  const events = decoder.feed(text);
  try {
    events.push(...decoder.flush());
  } catch (error) {
    if (!(error instanceof SseParseError)) throw error;
  }
  return events;
}

export class SseDecoder {
  readonly #textDecoder = new TextDecoder();
  #buffer = "";
  #scanPos = 0;
  #dataLines: string[] = [];
  #event: string | undefined;
  #id: string | undefined;

  feed(chunk: Uint8Array | string): SseEvent[] {
    const text =
      typeof chunk === "string" ? chunk : this.#textDecoder.decode(chunk, { stream: true });
    if (text.length > 0) this.#buffer += text;
    return this.#drain();
  }

  flush(): SseEvent[] {
    const tail = this.#textDecoder.decode();
    if (tail.length > 0) this.#buffer += tail;
    const events = this.#drain();
    const hasPendingFields =
      this.#dataLines.length > 0 || this.#event !== undefined || this.#id !== undefined;
    if (this.#buffer.length > 0 || hasPendingFields) {
      const snippet = (this.#buffer.length > 0 ? this.#buffer : this.#dataLines.join("\n")).slice(
        0,
        SNIPPET_LIMIT
      );
      throw new SseParseError(
        "SSE stream ended mid-event (trailing partial data was buffered)",
        snippet
      );
    }
    return events;
  }

  #drain(): SseEvent[] {
    const events: SseEvent[] = [];
    let lineStart = 0;
    let searchFrom = this.#scanPos;
    for (;;) {
      const index = this.#buffer.indexOf("\n", searchFrom);
      if (index === -1) break;
      let line = this.#buffer.slice(lineStart, index);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#processLine(line, events);
      lineStart = index + 1;
      searchFrom = index + 1;
    }
    if (lineStart > 0) this.#buffer = this.#buffer.slice(lineStart);
    this.#scanPos = this.#buffer.length;
    return events;
  }

  #processLine(line: string, events: SseEvent[]): void {
    if (line === "") {
      this.#dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.#dataLines.push(value);
        break;
      case "event":
        this.#event = value;
        break;
      case "id":
        this.#id = value;
        break;
    }
  }

  #dispatch(events: SseEvent[]): void {
    if (this.#dataLines.length === 0) {
      this.#event = undefined;
      this.#id = undefined;
      return;
    }
    const event: SseEvent = { data: this.#dataLines.join("\n") };
    if (this.#event !== undefined) event.event = this.#event;
    if (this.#id !== undefined) event.id = this.#id;
    events.push(event);
    this.#dataLines = [];
    this.#event = undefined;
    this.#id = undefined;
  }
}
