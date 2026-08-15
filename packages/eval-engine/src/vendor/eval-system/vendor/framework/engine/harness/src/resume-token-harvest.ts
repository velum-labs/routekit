import type { AgentResumeToken, AgentSession } from "../../../contracts/author/src/index.ts";

// A runtime-driven drop must carry the conversation across, so the token is
// harvested before release and a failed harvest surfaces instead of quietly
// starting the next turn from an empty history. A session with nothing to
// harvest still clears any older token, so nothing rewinds to it later.
export const harvestResumeToken = async (
  tokens: Map<string, AgentResumeToken>,
  session: AgentSession,
  identities: ReadonlySet<string>
): Promise<unknown> => {
  const harvested =
    session.resumeToken === undefined
      ? {
          ok: true as const,
          token: undefined,
        }
      : await session.resumeToken().then(
          (token: AgentResumeToken | undefined) => ({
            ok: true as const,
            token,
          }),
          (error: unknown) => ({
            error,
            ok: false as const,
          })
        );
  if (!harvested.ok) {
    return harvested.error;
  }
  for (const identity of identities) {
    if (harvested.token === undefined) {
      tokens.delete(identity);
    } else {
      tokens.set(identity, harvested.token);
    }
  }
  return undefined;
};
