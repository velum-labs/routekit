import { Context, Layer, Option } from "effect";

export const EXTERNAL_SKILLS_FEATURE_ID = "@routekit-eval-builtins/external-skills";

export interface ExternalSkillsConfigShape {
  readonly root: Option.Option<string>;
}

export class ExternalSkillsConfig extends Context.Service<
  ExternalSkillsConfig,
  ExternalSkillsConfigShape
>()("routekit-eval/runtime/ExternalSkillsConfig") {
  static readonly disabled = Layer.succeed(ExternalSkillsConfig)(
    ExternalSkillsConfig.of({ root: Option.none() })
  );

  static readonly fromRoot = (
    root: string
  ): Layer.Layer<ExternalSkillsConfig> =>
    Layer.succeed(ExternalSkillsConfig)(
      ExternalSkillsConfig.of({ root: Option.some(root) })
    );
}
