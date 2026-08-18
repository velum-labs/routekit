/**
 * One-directional contract drift guard.
 *
 * `Actual` may be a structural superset of `Expected`; the invariant is only
 * that every decoded/encoded schema value is assignable to the contract shape.
 * This intentionally is not strict type equality.
 */
type AssertAssignable<_Actual extends Expected, Expected> = true;

type _AssignablePasses = AssertAssignable<
  { readonly value: string },
  { readonly value: string }
>;

type _AssignablePassesSuperset = AssertAssignable<
  { readonly extra: number; readonly value: string },
  { readonly value: string }
>;

export type { AssertAssignable };
