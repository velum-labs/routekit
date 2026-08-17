import assert from "node:assert/strict";
import { test } from "node:test";
import { setupAgent, setupJudge } from "routekit/eval";

const candidateModels = [
  "claude-code/claude-haiku-4-5-20251001",
  "codex/gpt-5.4-mini"
] as const;
const judge = setupJudge({
  agent: setupAgent({ model: "claude-code/claude-sonnet-4-5-20250929" }),
  minScore: 0.8,
});

const cases = [
  {
    "id": "readme-why-routekit",
    "prompt": "Explain how a user should apply the \"Why RouteKit\" section to complete the documented workflow. Include concrete actions and important constraints.",
    "context": "Source: README.md\n\n## Why RouteKit\n\nCoding agents increasingly support multiple model backends, but each tool has\nits own configuration, model names, credentials, and account state. Switching\ntools or providers often means rebuilding that setup.\n\nRouteKit puts one local control plane and authenticated gateway in the middle:\n\n- configure providers and subscription accounts once;\n- discover canonical, namespaced model IDs;\n- launch Codex or Claude Code against a selected route;\n- point OpenAI-, Responses-, or Anthropic-compatible clients at the same\n  gateway; and\n- inspect which provider and account handled a request.",
    "rubric": "The response must accurately apply the \"Why RouteKit\" section, include its actionable details, and introduce no unsupported claims."
  },
  {
    "id": "readme-quickstart",
    "prompt": "Explain how a user should apply the \"Quickstart\" section to complete the documented workflow. Include concrete actions and important constraints.",
    "context": "Source: README.md\n\n## Quickstart\n\nRouteKit supports macOS and Linux. If Node.js 22 or newer is installed:\n\n```sh\nnpm install -g @velum-labs/routekit\nroutekit setup\nroutekit status\n```\n\n`routekit setup` walks through the routes you want to connect, validates API\nproviders, enrolls selected subscriptions, starts the daemon, and asks you to\nchoose a default model. API keys stay in environment variables; RouteKit does\nnot prompt for or store them.\n\nLaunch your preferred coding tool from any project:\n\n```sh\ncd ~/code/my-project\n\nroutekit codex\nroutekit claude\n```\n\nRouteKit opens the native coding tool in the current directory and connects it\nto the gateway. The session starts with a suitable model, and the compatible\nRouteKit catalog is available in the tool's native model picker. Switch models\ninside the tool in",
    "rubric": "The response must accurately apply the \"Quickstart\" section, include its actionable details, and introduce no unsupported claims."
  },
  {
    "id": "readme-what-you-can-connect",
    "prompt": "Explain how a user should apply the \"What you can connect\" section to complete the documented workflow. Include concrete actions and important constraints.",
    "context": "Source: README.md\n\n## What you can connect\n\n### Subscription accounts\n\nEnroll one or more accounts from either supported subscription kind:\n\n```sh\nroutekit config init --empty\nroutekit accounts login codex --name personal\nroutekit accounts login codex --name work\nroutekit accounts login claude-code --name team\n\nroutekit accounts status\nroutekit usage\n```\n\nRouteKit discovers model eligibility and selects an available account from the\nmatching pool.\n\n### API providers\n\nThe guided setup supports OpenAI, Anthropic, OpenRouter, and Amazon Bedrock.\nFor automation, initialize a provider directly:\n\n```sh\nexport ANTHROPIC_API_KEY='your-key'\nroutekit config init --provider anthropic\nroutekit providers status\nroutekit models list --provider anthropic\n```\n\n### Coding tools\n\nFrom a project directory, launch Codex or Clau",
    "rubric": "The response must accurately apply the \"What you can connect\" section, include its actionable details, and introduce no unsupported claims."
  }
] as const;

for (const model of candidateModels) {
  const candidate = setupAgent({ model });
  for (const testCase of cases) {
    test(`${model} / ${testCase.id}`, async () => {
      const candidatePrompt = [
        testCase.prompt,
        "",
        "Reference material:",
        "-----",
        testCase.context,
        "-----",
      ].join("\n");
      const run = await candidate.run(candidatePrompt);
      run.toComplete();
      assert.ok(run.text.trim().length > 0, "candidate returned empty text");
      await judge.autoEvals({
        criteria: [
          "Correct and complete",
          "",
          "Case-specific rubric:",
          testCase.rubric,
          "Reject unsupported claims and answers that omit required facts.",
        ].join("\n"),
        prompt: candidatePrompt,
        run,
      });
    });
  }
}
