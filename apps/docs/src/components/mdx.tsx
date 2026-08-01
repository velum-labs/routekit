import defaultMdxComponents from "fumadocs-ui/mdx";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import type { MDXComponents } from "mdx/types";
import {
  AnthropicModel,
  ClaudeCodeModel,
  CodexModel,
  GoogleModel,
  OpenAIModel,
  OpenRouterModel,
  RouteKitDefaultOpenAIModel,
  RouteKitVersion
} from "@/components/docs-values";
import { Mermaid } from "@/components/mermaid";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    AnthropicModel,
    ClaudeCodeModel,
    CodexModel,
    GoogleModel,
    Mermaid,
    OpenAIModel,
    OpenRouterModel,
    RouteKitDefaultOpenAIModel,
    RouteKitVersion,
    Tab,
    Tabs,
    ...components
  };
}
