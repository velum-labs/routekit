/**
 * @velum-labs/routekit-cli-ui — a brand-configurable terminal UX layer.
 *
 * One presenter contract, two implementations: rich Ink (React) rendering on
 * interactive TTYs, ordered plain-text lines everywhere else (CI, pipes,
 * `ROUTEKIT_NO_TUI=1`). All UI goes to stderr; stdout stays reserved for
 * machine payloads and the launched tool's output.
 */
import { InkPresenter } from "./ink/presenter.js";
import { PlainPresenter } from "./plain.js";
import type { Presenter } from "./presenter.js";
import { isInteractive } from "./runtime.js";

export * from "./format.js";
export type { FuzzyMatch, FuzzyResult } from "./fuzzy.js";
export { fuzzyFilter, fuzzyMatch } from "./fuzzy.js";
export { InkPresenter, mountInk, settleInk } from "./ink/presenter.js";
export {
  PlainPresenter,
  renderErrorPanelLines,
  renderKeyValueLines,
  renderTableLines
} from "./plain.js";
export * from "./presenter.js";
export type { Back, SelectOption } from "./prompt.js";
export {
  autocompleteText,
  BACK,
  confirm,
  done,
  fuzzySelect,
  multiselect,
  note,
  select,
  text
} from "./prompt.js";
export * from "./runtime.js";
export * from "./theme.js";
export type { WizardStep } from "./wizard.js";
export { runWizard } from "./wizard.js";

/**
 * The presenter for this invocation: Ink when attached to an interactive TTY,
 * plain line logs otherwise. Callers that own non-interactive modes pass
 * `interactive: false` for that invocation rather than mutating process state.
 */
export function createPresenter(options: { interactive?: boolean } = {}): Presenter {
  const interactive = options.interactive ?? isInteractive();
  return interactive ? new InkPresenter() : new PlainPresenter();
}
