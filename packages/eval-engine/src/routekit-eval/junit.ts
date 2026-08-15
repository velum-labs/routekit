/**
 * Adapted from RouteKit Eval's Node JUnit parser.
 *
 * Vendored source mapping:
 * framework/cli/src/commands/eval/junit.ts
 */
import type { EvalTestRow } from "../model.js";

const XML_ENTITIES: readonly (readonly [string, string])[] = [
  ["&quot;", '"'],
  ["&apos;", "'"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&amp;", "&"]
];

const unescapeXml = (value: string): string => {
  let decoded = value;
  for (const [entity, character] of XML_ENTITIES) decoded = decoded.replaceAll(entity, character);
  return decoded;
};

const parseSeconds = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
};

const ATTRIBUTES = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
const TESTCASE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/giu;

const parseAttributes = (raw: string): Readonly<Record<string, string>> => {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTES)) {
    const name = match[1];
    if (name !== undefined) attributes[name] = unescapeXml(match[2] ?? match[3] ?? "");
  }
  return attributes;
};

export const parseNodeJunit = (xml: string): readonly EvalTestRow[] => {
  const rows: EvalTestRow[] = [];
  for (const match of xml.matchAll(TESTCASE)) {
    const attributes = parseAttributes(match[1] ?? "");
    const inner = match[2] ?? "";
    const durationMs = parseSeconds(attributes.time);
    const file = attributes.file;
    const failed = attributes.failure !== undefined || /<(?:failure|error)\b/iu.test(inner);
    const skipped = /<skipped\b/iu.test(inner);
    rows.push({
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(file === undefined || file === "" ? {} : { file }),
      name: attributes.name ?? "",
      status: failed ? "fail" : skipped ? "skipped" : "pass"
    });
  }
  return rows;
};

export type { EvalTestRow } from "../model.js";
