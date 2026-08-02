import Link from "next/link";
import { RouteKitMark } from "@/components/routekit-mark";

const navigation = [
  { href: "/#why-routekit", label: "Why RouteKit" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/docs", label: "Docs" },
  { href: "https://github.com/velum-labs/routekit", label: "GitHub" }
] as const;

export function ProductHeader() {
  return (
    <header className="rk-header">
      <div className="rk-header-inner">
        <Link className="rk-header-brand" href="/" aria-label="RouteKit home">
          <RouteKitMark surface="dark" />
        </Link>

        <nav className="rk-desktop-nav" aria-label="Main navigation">
          {navigation.map((item) => (
            <Link href={item.href} key={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>

        <Link className="rk-header-install" href="/docs/getting-started/installation">
          Install <span aria-hidden="true">↗</span>
        </Link>

        <details className="rk-mobile-menu">
          <summary aria-label="Open navigation">Menu</summary>
          <nav aria-label="Mobile navigation">
            {navigation.map((item) => (
              <Link href={item.href} key={item.href}>
                {item.label}
              </Link>
            ))}
            <Link className="rk-mobile-install" href="/docs/getting-started/installation">
              Install RouteKit
            </Link>
          </nav>
        </details>
      </div>
    </header>
  );
}
