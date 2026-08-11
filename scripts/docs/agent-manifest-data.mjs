const commandReference = "/docs/reference/commands";

function docs(...routes) {
  return [...new Set([commandReference, ...routes])];
}

function verify(argv, description) {
  return { argv, description };
}

const policies = new Map();

function add(paths, policy) {
  for (const path of paths) {
    if (policies.has(path)) throw new Error(`duplicate agent command policy: ${path}`);
    policies.set(path, {
      visibility: "public",
      interaction: "none",
      jsonOutput: "supported",
      secretOutput: "none",
      sensitiveInputs: [],
      docs: docs(),
      ...policy
    });
  }
}

add(["setup"], {
  category: "setup",
  effect: "write",
  target: "local",
  interaction: "required",
  jsonOutput: "unsupported",
  docs: docs("/docs/getting-started/installation", "/docs/getting-started/agent-guide"),
  verification: verify(["routekit", "status", "--json"], "Confirm the gateway is ready.")
});

add(["remote install"], {
  category: "remote",
  effect: "write",
  target: "ssh-host-and-local-metadata",
  interaction: "conditional",
  docs: docs("/docs/guides/remote-gateway"),
  verification: verify(
    ["routekit", "remote", "show", "<name>", "--json"],
    "Probe the enrolled remote and inspect its stored metadata."
  )
});
add(["remote add"], {
  category: "remote",
  effect: "write",
  target: "ssh-host-and-local-metadata",
  interaction: "conditional",
  sensitiveInputs: ["--join <join-credential>"],
  docs: docs("/docs/guides/remote-gateway"),
  verification: verify(
    ["routekit", "remote", "show", "<name>", "--json"],
    "Probe the enrolled remote and inspect its stored metadata."
  )
});
add(["remote list", "remote show"], {
  category: "remote",
  effect: "read",
  target: "local-metadata-and-remote-probe",
  docs: docs("/docs/guides/remote-gateway")
});
add(["remote use", "remote remove"], {
  category: "remote",
  effect: "write",
  target: "local-metadata",
  docs: docs("/docs/guides/remote-gateway"),
  verification: verify(
    ["routekit", "remote", "list", "--json"],
    "Inspect the resulting remote selection and inventory."
  )
});

add(["peer add"], {
  category: "access",
  effect: "write",
  target: "local-account",
  sensitiveInputs: ["<join-credential>"],
  docs: docs("/docs/guides/remote-gateway"),
  verification: verify(
    ["routekit", "peer", "show", "--json"],
    "Confirm the peer pointer and public daemon record."
  )
});
add(["peer show"], {
  category: "access",
  effect: "read",
  target: "local-account",
  docs: docs("/docs/guides/remote-gateway")
});
add(["peer remove"], {
  category: "access",
  effect: "write",
  target: "local-account",
  docs: docs("/docs/guides/remote-gateway"),
  verification: verify(
    ["routekit", "peer", "show", "--json"],
    "Confirm that no peer pointer remains."
  )
});

add(["token issue"], {
  category: "access",
  effect: "write",
  target: "selected-daemon",
  secretOutput: "plaintext-once",
  docs: docs("/docs/guides/remote-gateway", "/docs/concepts/privacy"),
  verification: verify(
    ["routekit", "token", "list", "--json"],
    "Confirm the token record without exposing its plaintext."
  )
});
add(["token list"], {
  category: "access",
  effect: "read",
  target: "selected-daemon",
  docs: docs("/docs/guides/remote-gateway", "/docs/concepts/privacy")
});
add(["token revoke"], {
  category: "access",
  effect: "write",
  target: "selected-daemon",
  docs: docs("/docs/guides/remote-gateway", "/docs/concepts/privacy"),
  verification: verify(
    ["routekit", "token", "list", "--json"],
    "Confirm that the named token is revoked."
  )
});
add(["token shell"], {
  category: "access",
  effect: "read",
  target: "local-native-client-credentials",
  visibility: "advanced",
  jsonOutput: "unsupported",
  secretOutput: "plaintext-managed-credentials",
  docs: docs("/docs/guides/coding-tools", "/docs/concepts/privacy")
});

add(["accounts login"], {
  category: "subscriptions",
  effect: "write",
  target: "selected-daemon",
  interaction: "required",
  jsonOutput: "unsupported",
  docs: docs("/docs/guides/subscription-pooling", "/docs/getting-started/agent-guide"),
  verification: verify(
    ["routekit", "accounts", "status", "--json"],
    "Confirm credential, pool, and relay readiness."
  )
});
add(["accounts add"], {
  category: "subscriptions",
  effect: "write",
  target: "selected-daemon",
  sensitiveInputs: ["current official CLI credential file"],
  docs: docs("/docs/guides/subscription-pooling"),
  verification: verify(
    ["routekit", "accounts", "status", "--json"],
    "Confirm the resulting subscription inventory and readiness."
  )
});
add(["accounts rename", "accounts remove"], {
  category: "subscriptions",
  effect: "write",
  target: "selected-daemon",
  docs: docs("/docs/guides/subscription-pooling"),
  verification: verify(
    ["routekit", "accounts", "status", "--json"],
    "Confirm the resulting subscription inventory and readiness."
  )
});
add(["accounts list", "accounts status"], {
  category: "subscriptions",
  effect: "read",
  target: "selected-daemon",
  docs: docs("/docs/guides/subscription-pooling", "/docs/guides/operations")
});

add(["providers add", "providers remove"], {
  category: "configuration",
  effect: "write",
  target: "selected-daemon",
  docs: docs("/docs/reference/configuration"),
  verification: verify(
    ["routekit", "providers", "status", "--json"],
    "Run live authentication and model discovery."
  )
});
add(["providers status"], {
  category: "configuration",
  effect: "read",
  target: "selected-daemon",
  docs: docs("/docs/reference/configuration", "/docs/guides/operations")
});

add(["config path", "config show"], {
  category: "configuration",
  effect: "read",
  target: "selected-daemon",
  docs: docs("/docs/reference/configuration")
});
add(["config init"], {
  category: "configuration",
  effect: "write",
  target: "local",
  docs: docs("/docs/getting-started/installation", "/docs/reference/configuration"),
  verification: verify(
    ["routekit", "config", "show", "--json"],
    "Inspect the validated canonical router document."
  )
});
add(["config edit"], {
  category: "configuration",
  effect: "write",
  target: "selected-daemon",
  interaction: "required",
  jsonOutput: "unsupported",
  docs: docs("/docs/reference/configuration"),
  verification: verify(
    ["routekit", "config", "show", "--json"],
    "Inspect the validated document after the atomic reload."
  )
});
add(["config import"], {
  category: "configuration",
  effect: "write",
  target: "selected-daemon",
  sensitiveInputs: ["--from <path> may reference operator-owned configuration"],
  docs: docs("/docs/reference/configuration"),
  verification: verify(
    ["routekit", "config", "show", "--json"],
    "Inspect the complete imported document and revision."
  )
});
add(["start"], {
  category: "lifecycle",
  effect: "service-control",
  target: "local",
  sensitiveInputs: ["--auth-token <token>"],
  docs: docs("/docs/getting-started/installation", "/docs/guides/operations"),
  verification: verify(
    ["routekit", "status", "--json"],
    "Inspect the resulting daemon and gateway state."
  )
});
add(["stop"], {
  category: "lifecycle",
  effect: "service-control",
  target: "local",
  docs: docs("/docs/getting-started/installation", "/docs/guides/operations"),
  verification: verify(
    ["routekit", "status", "--json"],
    "Inspect the resulting daemon and gateway state."
  )
});

add(["daemon restart", "daemon upgrade"], {
  category: "lifecycle",
  effect: "service-control",
  target: "local",
  visibility: "advanced",
  docs: docs("/docs/guides/operations"),
  verification: verify(
    ["routekit", "status", "--json"],
    "Inspect the local daemon after the lifecycle operation."
  )
});
add(["daemon reload"], {
  category: "lifecycle",
  effect: "service-control",
  target: "local",
  visibility: "advanced",
  docs: docs("/docs/guides/operations"),
  verification: verify(
    ["routekit", "status", "--json"],
    "Confirm configuration, providers, and accounts after reload."
  )
});
add(["daemon auth show"], {
  category: "access",
  effect: "read",
  target: "local",
  visibility: "advanced",
  secretOutput: "private-owner-token",
  docs: docs("/docs/concepts/privacy")
});
add(["daemon logs"], {
  category: "operations",
  effect: "read",
  target: "local",
  visibility: "advanced",
  jsonOutput: "unsupported",
  docs: docs("/docs/guides/operations", "/docs/guides/troubleshooting")
});
add(["daemon service install", "daemon service uninstall"], {
  category: "lifecycle",
  effect: "service-control",
  target: "local-os-service",
  visibility: "advanced",
  sensitiveInputs: ["--auth-token <token>"],
  docs: docs("/docs/guides/operations"),
  verification: verify(
    ["routekit", "daemon", "service", "status", "--json"],
    "Inspect the OS supervisor state."
  )
});
add(["daemon service status"], {
  category: "lifecycle",
  effect: "read",
  target: "local-os-service",
  visibility: "advanced",
  docs: docs("/docs/guides/operations")
});

add(["codex", "claude"], {
  category: "coding-tools",
  effect: "launch",
  target: "selected-gateway-and-native-client",
  interaction: "required",
  jsonOutput: "unsupported",
  sensitiveInputs: ["--auth-token <token>"],
  docs: docs(
    "/docs/guides/coding-tools",
    "/docs/reference/client-compatibility",
    "/docs/reference/model-catalog"
  )
});
add(["codex install", "claude install"], {
  category: "coding-tools",
  effect: "write",
  target: "local-native-client-and-selected-gateway",
  docs: docs("/docs/guides/coding-tools", "/docs/concepts/privacy"),
  verification: verify(
    ["routekit", "models", "list", "--json"],
    "Confirm the selected gateway exposes models before opening the native picker."
  )
});
add(["codex uninstall", "claude uninstall"], {
  category: "coding-tools",
  effect: "write",
  target: "local-native-client-and-selected-gateway",
  docs: docs("/docs/guides/coding-tools"),
  verification: verify(
    ["routekit", "token", "list", "--json"],
    "Confirm the tracked dedicated token is revoked when one existed."
  )
});

add(["status"], {
  category: "operations",
  effect: "read",
  target: "selected-daemon",
  jsonOutput: "conditional",
  jsonNotes: "JSON is supported for snapshots, not with --watch.",
  docs: docs("/docs/guides/operations")
});
add(["usage"], {
  category: "operations",
  effect: "read",
  target: "selected-daemon",
  jsonOutput: "conditional",
  jsonNotes: "JSON is supported for snapshots, not with --watch.",
  docs: docs("/docs/guides/operations", "/docs/guides/subscription-pooling")
});
add(["usage redeem"], {
  category: "subscriptions",
  effect: "write",
  target: "selected-daemon-and-provider-account",
  interaction: "conditional",
  jsonNotes: "JSON or non-input execution requires the global --yes flag.",
  docs: docs("/docs/guides/operations"),
  verification: verify(
    ["routekit", "usage", "--json"],
    "Refresh subscription usage and reset-credit state."
  )
});
add(["leaderboard", "calls inspect", "models list", "models info", "doctor"], {
  category: "operations",
  effect: "read",
  target: "selected-daemon",
  docs: docs("/docs/guides/operations", "/docs/guides/troubleshooting")
});

add(["self-update"], {
  category: "maintenance",
  effect: "write",
  target: "local-cli-installation",
  docs: docs("/docs/getting-started/installation"),
  verification: verify(
    ["routekit", "version", "--json"],
    "Confirm the installed CLI version, then upgrade any running daemon separately."
  )
});
add(["telemetry status", "telemetry schema"], {
  category: "maintenance",
  effect: "read",
  target: "local",
  docs: docs("/docs/concepts/privacy")
});
add(["telemetry on", "telemetry off", "telemetry category", "telemetry reset"], {
  category: "maintenance",
  effect: "write",
  target: "local",
  docs: docs("/docs/concepts/privacy"),
  verification: verify(
    ["routekit", "telemetry", "status", "--json"],
    "Inspect the resulting telemetry consent and category state."
  )
});
add(["completion"], {
  category: "maintenance",
  effect: "read",
  target: "local",
  visibility: "advanced",
  jsonOutput: "unsupported",
  docs: docs()
});
add(["version"], {
  category: "maintenance",
  effect: "read",
  target: "local",
  docs: docs("/docs/getting-started/installation")
});

export const commandPolicies = Object.fromEntries(
  [...policies.entries()].sort(([left], [right]) => left.localeCompare(right))
);

export const internalCommandPaths = new Set([
  "daemon run",
  "daemon exec",
  "credential get",
  "__complete",
  "__self-inspect"
]);

export const commandSummaryOverrides = {
  "telemetry status": "show telemetry consent and category state",
  "telemetry on": "enable anonymous telemetry",
  "telemetry off": "disable anonymous telemetry"
};

export const errorCatalog = [
  {
    code: "error",
    surface: "cli",
    meaning: "An uncategorized CLI or dependency failure occurred.",
    retry: "unknown",
    diagnostics: [
      ["routekit", "doctor", "--json"],
      ["routekit", "status", "--json"]
    ],
    guidance:
      "Use error.tryArgv when present. Otherwise inspect the message and diagnostics before retrying.",
    docs: ["/docs/guides/troubleshooting"]
  },
  {
    code: "bad_request",
    surface: "cli-or-control",
    meaning: "Arguments, option values, or requested state failed validation.",
    retry: "after-correction",
    diagnostics: [],
    guidance:
      "Correct the request. Consult the command manifest or run the exact command with --help.",
    docs: ["/docs/reference/commands"]
  },
  {
    code: "unauthorized",
    surface: "control",
    meaning:
      "The control-plane credential is absent, invalid, or not authorized for the operation.",
    retry: "after-remediation",
    diagnostics: [["routekit", "status", "--json"]],
    guidance:
      "Confirm the selected local or remote target. Never print or copy an owner token into logs to diagnose this error.",
    docs: ["/docs/guides/remote-gateway", "/docs/concepts/privacy"]
  },
  {
    code: "not_found",
    surface: "cli-or-control",
    meaning:
      "The requested account, token, remote, model-adjacent object, or other resource does not exist.",
    retry: "after-correction",
    diagnostics: [["routekit", "status", "--json"]],
    guidance: "List the relevant resource type and correct the identifier before retrying.",
    docs: ["/docs/guides/troubleshooting"]
  },
  {
    code: "conflict",
    surface: "control",
    meaning: "The requested mutation conflicts with current state or a newer revision.",
    retry: "after-refresh",
    diagnostics: [
      ["routekit", "status", "--json"],
      ["routekit", "config", "show", "--json"]
    ],
    guidance: "Refresh state, reconsider the intended mutation, and do not force a retry blindly.",
    docs: ["/docs/guides/troubleshooting", "/docs/reference/configuration"]
  },
  {
    code: "unavailable",
    surface: "cli-or-control",
    meaning: "A daemon, SSH host, provider, or required service cannot currently be reached.",
    retry: "after-remediation",
    diagnostics: [
      ["routekit", "doctor", "--json"],
      ["routekit", "status", "--json"],
      ["routekit", "providers", "status", "--json"]
    ],
    guidance:
      "Restore the unavailable dependency and verify it before retrying the original command.",
    docs: ["/docs/guides/troubleshooting", "/docs/guides/remote-gateway"]
  },
  {
    code: "internal",
    surface: "control",
    meaning: "The daemon or control relay encountered an unexpected internal failure.",
    retry: "unknown",
    diagnostics: [
      ["routekit", "status", "--json"],
      ["routekit", "daemon", "logs", "--lines", "100"]
    ],
    guidance:
      "Capture redacted diagnostics. Do not include tokens, credentials, or complete secret files.",
    docs: ["/docs/guides/troubleshooting", "/docs/concepts/privacy"]
  },
  {
    code: "upgrade_required",
    surface: "control",
    meaning: "The CLI and daemon control protocol are incompatible.",
    retry: "after-remediation",
    diagnostics: [["routekit", "daemon", "status", "--json"]],
    recovery: ["routekit", "daemon", "upgrade", "--force"],
    guidance: "Upgrade the running local daemon to the installed CLI, verify status, then retry.",
    docs: ["/docs/guides/operations"]
  },
  {
    code: "model_not_found",
    surface: "cli",
    meaning: "The requested model is not present in the live, policy-filtered catalog.",
    retry: "after-correction",
    diagnostics: [["routekit", "models", "list", "--json"]],
    guidance: "Select an exact namespaced ID returned by models list; do not guess model IDs.",
    docs: ["/docs/reference/model-catalog"]
  },
  {
    code: "daemon_upgrade_required",
    surface: "cli",
    meaning: "The running daemon does not implement a contract required by the installed CLI.",
    retry: "after-remediation",
    diagnostics: [["routekit", "daemon", "status", "--json"]],
    recovery: ["routekit", "daemon", "upgrade", "--force"],
    guidance: "Upgrade the running daemon, verify status, then retry the original command.",
    docs: ["/docs/guides/operations"]
  },
  {
    code: "call_not_found",
    surface: "cli",
    meaning: "The model-call ID is unknown or has expired from bounded retention.",
    retry: "not-useful",
    diagnostics: [],
    guidance:
      "Use a current x-routekit-model-call-id. Increasing retries cannot restore an expired record.",
    docs: ["/docs/guides/operations"]
  },
  {
    code: "subscription_usage_unavailable",
    surface: "cli",
    meaning: "RouteKit cannot obtain a usable subscription usage snapshot.",
    retry: "after-remediation",
    diagnostics: [
      ["routekit", "accounts", "status", "--json"],
      ["routekit", "providers", "status", "--json"],
      ["routekit", "doctor", "--json"]
    ],
    guidance:
      "Check enrolled accounts, credential readiness, quota state, and provider connectivity.",
    docs: ["/docs/guides/operations", "/docs/guides/subscription-pooling"]
  }
];
