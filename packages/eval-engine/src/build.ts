#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as esbuild from "esbuild";

const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const entry = path.resolve(packageRoot, "src", "entry.ts");
const execFileAsync = promisify(execFile);

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
    ORI_CLI_VERSION: JSON.stringify("0.4.0-eval-system")
  },
  entryPoints: [entry],
  format: "esm",
  minify: true,
  outfile: output,
  packages: "external",
  platform: "node"
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
  platform: "node"
});

const packageTsconfig = path.join(packageRoot, "tsconfig.json");
const hasPackageTsconfig = await access(packageTsconfig).then(
  () => true,
  () => false
);
if (hasPackageTsconfig) {
  const declarationConfig = path.join(packageRoot, "tsconfig.declarations.tmp.json");
  await writeFile(
    declarationConfig,
    `${JSON.stringify(
      {
        extends: "./tsconfig.json",
        compilerOptions: {
          declaration: true,
          declarationMap: false,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: "./dist",
          rootDir: "./src"
        },
        include: ["src/index.ts"],
        exclude: ["test"]
      },
      null,
      2
    )}\n`
  );
  try {
    await execFileAsync(
      process.execPath,
      [path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", declarationConfig],
      { cwd: packageRoot }
    );
  } finally {
    await rm(declarationConfig, { force: true });
  }

  const declarationEntries = await readdir(path.join(packageRoot, "dist"), {
    recursive: true,
    withFileTypes: true
  });
  for (const entry of declarationEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
    const declarationPath = path.join(entry.parentPath, entry.name);
    const declaration = await readFile(declarationPath, "utf8");
    const portableDeclaration = declaration.replace(
      /((?:from\s+|import\()\s*["'][^"']+)\.ts(["'])/gu,
      "$1.js$2"
    );
    if (portableDeclaration !== declaration) {
      await writeFile(declarationPath, portableDeclaration);
    }
  }
}
console.log(output);
