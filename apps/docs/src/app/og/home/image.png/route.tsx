import { ImageResponse } from "next/og";
import { OG_IMAGE_SIZE, OgCard } from "@/components/og-card";
import { loadBrandMark } from "@/lib/og-image";

export const revalidate = false;

export async function GET() {
  return new ImageResponse(
    <OgCard
      title="RouteKit | One gateway for your coding subscriptions"
      description="Use supported models across Codex, Claude Code, Cursor, and OpenAI-compatible clients. Pool subscription accounts and share one reliable gateway."
      brandMark={await loadBrandMark()}
    />,
    OG_IMAGE_SIZE
  );
}
