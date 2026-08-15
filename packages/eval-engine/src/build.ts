#!/usr/bin/env node

import * as esbuild from "esbuild";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const entry = path.resolve(packageRoot, "src", "entry.ts");

const optionValue = (args: readonly string[], name: string): string | undefined => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const defaultOutput = path.join(packageRoot, "dist", "ori-eval-system.mjs");
const output = path.resolve(optionValue(process.argv.slice(2), "--outfile") ?? defaultOutput);

await mkdir(path.dirname(output), { recursive: true });

await esbuild.build({
  bundle: true,
  define: {
    ORI_CLI_COMPILED: "false",
    ORI_CLI_PACKAGE_NAME: JSON.stringify("@ori/eval-system"),
    ORI_CLI_VERSION: JSON.stringify("0.4.0-eval-system"),
  },
  entryPoints: [entry],
  format: "esm",
  minify: true,
  outfile: output,
  packages: "external",
  platform: "node",
});

const SHEBANG = "#!/usr/bin/env node\n";
const bundled = await readFile(output, "utf8");
const withoutShebangs = bundled.replace(/^(?:#![^\n]*\n)+/u, "");
await writeFile(output, `${SHEBANG}${withoutShebangs}`);
await chmod(output, 0o755);
await esbuild.build({
  bundle: true,
  entryPoints: [path.join(packageRoot, "src", "index.ts")],
  format: "esm",
  outfile: path.join(packageRoot, "dist", "index.js"),
  packages: "external",
  platform: "node",
});
await writeFile(
  path.join(packageRoot, "dist", "index.d.ts"),
  ['export * from "../src/index.ts";', ""].join("\n"),
);
console.log(output);
