import { readFile } from "node:fs/promises";

import type { FreshModuleBuildPlugin } from "../module-loader.ts";

import { loaderForPath, preserveLiteralImportMetaAssetUrls } from "./rewrite.ts";

export const preserveImportMetaAssetUrlsPlugin: FreshModuleBuildPlugin = {
  name: "ori-preserve-import-meta-asset-urls",
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]s$/u }, async (args) => {
      const source = await readFile(args.path, "utf8");
      return {
        contents: preserveLiteralImportMetaAssetUrls(source, args.path),
        loader: loaderForPath(args.path),
      };
    });
  },
};
