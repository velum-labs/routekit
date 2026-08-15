export interface NamedContributionEntry<Value> {
  readonly featureId: string;
  readonly name: string;
  readonly value: Value;
}
