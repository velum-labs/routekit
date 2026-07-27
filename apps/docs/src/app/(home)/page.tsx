import Link from "next/link";

export default function HomePage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center px-6 py-24">
      <h1 className="mb-4 text-4xl font-bold tracking-tight">RouteKit</h1>
      <p className="mb-8 max-w-xl text-fd-muted-foreground">
        Configure providers once, run a stable OpenAI-compatible gateway, and launch coding agents
        against it.
      </p>
      <Link href="/docs" className="font-medium text-fd-primary underline">
        Read the docs
      </Link>
    </div>
  );
}
