import { timingSafeEqual } from "node:crypto";

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

export function requireMutationAuthorization(request: Request): void {
  const configured = process.env.EXPERIMENT_PLATFORM_API_TOKEN;
  if (configured === undefined || configured.length === 0) {
    if (process.env.VERCEL === "1" || process.env.NODE_ENV === "production") {
      throw new Error("EXPERIMENT_PLATFORM_API_TOKEN is required in production");
    }
    return;
  }
  const authorization = request.headers.get("authorization");
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!equalSecret(supplied, configured)) throw new Error("unauthorized");
}

export function actorFromRequest(request: Request, fallback = "api"): string {
  return request.headers.get("x-experiment-actor")?.trim() || fallback;
}
