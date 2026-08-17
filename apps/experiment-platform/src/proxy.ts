import { NextResponse, type NextRequest } from "next/server";

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="RouteKit Experiments"' }
  });
}

export function proxy(request: NextRequest): NextResponse {
  const user = process.env.EXPERIMENT_PLATFORM_DASHBOARD_USER;
  const password = process.env.EXPERIMENT_PLATFORM_DASHBOARD_PASSWORD;
  if (!user || !password) {
    if (process.env.VERCEL === "1" || process.env.NODE_ENV === "production") {
      return new NextResponse("Dashboard authentication is not configured", { status: 503 });
    }
    return NextResponse.next();
  }
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) return unauthorized();
  let decoded = "";
  try {
    decoded = atob(authorization.slice(6));
  } catch {
    return unauthorized();
  }
  return decoded === `${user}:${password}` ? NextResponse.next() : unauthorized();
}

export const config = {
  matcher: ["/", "/experiments/:path*"]
};
