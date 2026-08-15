// RFC 0011 / RFC 0002: mirrors the generated SDK's `ori/logger` module so
// builtins import the same surface an external feature project does. Named
// re-exports keep the explicit surface and avoid the `no-barrel-file` lint.
export {
  installFeatureLog,
  log,
  resetFeatureLog,
} from "../../../contracts/author/src/logger.ts";
