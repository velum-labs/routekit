export function tmuxClientEnvironment(env = process.env) {
  return Object.fromEntries(
    [
      ["PATH", env.PATH],
      ["HOME", env.HOME],
      ["TMPDIR", env.TMPDIR],
      ["LANG", env.LANG ?? "en_US.UTF-8"],
      ["TERM", "xterm-256color"]
    ].filter((entry) => entry[1] !== undefined)
  );
}
