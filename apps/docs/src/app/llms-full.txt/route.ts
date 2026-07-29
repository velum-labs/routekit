import { getAllLLMText } from "@/lib/llm-content";

export const revalidate = false;

export async function GET() {
  return new Response(await getAllLLMText(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
