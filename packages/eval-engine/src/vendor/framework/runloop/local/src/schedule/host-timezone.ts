/**
 * The host's IANA timezone, read once at module load.
 *
 * The runner arms a schedule under `schedule.definition.timezone ?? HOST_TIMEZONE`,
 * and the catch-up pass and the introspection view must resolve the SAME default
 * or they disagree with the armed cadence about when a fire was due. Sharing one
 * const is what makes that agreement structural instead of three copies that can
 * drift.
 *
 * A plain const, not an Effect: `Intl.DateTimeFormat().resolvedOptions()` is a
 * pure, deterministic read of the host environment with no I/O and nothing to
 * inject — schedules override it per-definition with `timezone`.
 */
export const HOST_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
