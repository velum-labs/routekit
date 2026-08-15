export const isInteractiveTerminal = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isStdinTty: boolean;
}): boolean => input.isStdinTty && input.env.CI !== "true";
