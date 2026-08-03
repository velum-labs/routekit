import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import type { ReactNode } from "react";
import { getSiteUrl } from "@/lib/site-url";
import "./global.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-instrument-serif"
});

// Relative metadata URLs, including generated Open Graph images, resolve against
// the deployment origin. Production sets NEXT_PUBLIC_DOCS_URL to the custom
// domain; previews use Vercel's deployment URL.
const siteUrl = getSiteUrl();

export const metadata: Metadata = {
  title: {
    default: "RouteKit Documentation",
    template: "%s · RouteKit"
  },
  description:
    "Install, configure, and operate RouteKit—the authenticated model gateway for coding tools, API providers, and subscription pools.",
  metadataBase: siteUrl,
  openGraph: {
    title: "RouteKit Documentation",
    description:
      "One authenticated model gateway for coding tools, providers, and subscription pools.",
    type: "website"
  },
  robots: { index: true, follow: true }
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${geistMono.variable} ${instrumentSerif.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
