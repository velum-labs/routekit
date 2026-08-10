import type { ResumeCursor, SessionHandle } from "./contract.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export class SessionRegistry<T extends Pick<SessionHandle, "stop">> {
  readonly #sessions = new Set<T>();

  add(session: T): T {
    this.#sessions.add(session);
    return session;
  }

  async dispose(): Promise<void> {
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    for (const session of sessions) await session.stop();
  }
}

export function resumeStringField(
  resume: ResumeCursor | undefined,
  kind: ResumeCursor["kind"],
  field: string
): string | undefined {
  if (resume === undefined || resume.kind !== kind || resume.data === null) return undefined;
  if (typeof resume.data !== "object" || Array.isArray(resume.data)) return undefined;
  const value = (resume.data as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
