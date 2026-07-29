import Link from "next/link";
import { RouteKitMark } from "@/components/routekit-mark";

export default function NotFound() {
  return (
    <main className="not-found-shell">
      <RouteKitMark label="RouteKit documentation" surface="dark" />
      <p className="not-found-code">404 · ROUTE NOT FOUND</p>
      <h1>This route does not exist.</h1>
      <p>The documentation may have moved, or the requested model route was never configured.</p>
      <nav aria-label="404 navigation">
        <Link href="/">Documentation home</Link>
        <Link href="/docs">Browse the docs</Link>
        <Link href="/docs/reference/routes-and-billing">Routes and billing</Link>
      </nav>
    </main>
  );
}
