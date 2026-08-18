import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import "./styles.css";

export const metadata: Metadata = {
  title: "RouteKit Experiment Platform",
  description: "Submit, monitor, approve, and compare reproducible experiments."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            RouteKit <span>Experiments</span>
          </Link>
          <div className="environment">{process.env.VERCEL_ENV ?? "local"}</div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
