export const TELEMETRY_SURFACES = {
  code: "surface-code",
  dev: "surface-dev",
  direct: "surface-direct",
  eval: "surface-eval",
  start: "surface-start",
  schedule: "surface-schedule",
  tui: "surface-tui",
  unknown: "surface-unknown",
} as const;

export type TelemetrySurfaceId =
  (typeof TELEMETRY_SURFACES)[keyof typeof TELEMETRY_SURFACES];

export const TELEMETRY_SURFACE_INTERNAL = "internal";

export type TelemetrySurfaceInput =
  | "code"
  | "dev"
  | "direct"
  | "eval"
  | "internal"
  | "schedule"
  | "start"
  | "tui";

export const telemetrySurfaceInput = (
  surface: string | undefined
): TelemetrySurfaceInput | undefined => {
  switch (surface) {
    case undefined: {
      return undefined;
    }
    case "code":
    case "dev":
    case "direct":
    case "eval":
    case "internal":
    case "schedule":
    case "start":
    case "tui": {
      return surface;
    }
    default: {
      return undefined;
    }
  }
};

export const telemetrySurfaceId = (surface?: string): TelemetrySurfaceId => {
  if (surface === undefined) {
    return TELEMETRY_SURFACES.unknown;
  }
  switch (surface) {
    case "code": {
      return TELEMETRY_SURFACES.code;
    }
    case "dev": {
      return TELEMETRY_SURFACES.dev;
    }
    case "direct": {
      return TELEMETRY_SURFACES.direct;
    }
    case "eval": {
      return TELEMETRY_SURFACES.eval;
    }
    case "start": {
      return TELEMETRY_SURFACES.start;
    }
    case "schedule": {
      return TELEMETRY_SURFACES.schedule;
    }
    case "tui": {
      return TELEMETRY_SURFACES.tui;
    }
    default: {
      return TELEMETRY_SURFACES.unknown;
    }
  }
};
