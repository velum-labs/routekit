"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const SAMPLE = `schemaVersion: 1
experimentId: coding-router-pilot
objective: Compare a local classifier with a pinned hosted model
code:
  image: coding-router-runner@sha256:${"a".repeat(64)}
  sourceCommit: ${"b".repeat(40)}
dataset:
  id: development-v1
  hash: ${"c".repeat(64)}
  role: development
matrix:
  treatments:
    - id: embedding-knn
      executor: sandbox
      image: coding-router-runner@sha256:${"a".repeat(64)}
      configuration:
        method: embedding_knn
      command:
        executable: node
        args: ["/app/runner.mjs"]
      estimatedInfrastructureCostUsd: 0
    - id: luna
      executor: hosted-model
      configuration:
        model: openrouter/luna
      estimatedProviderCostUsd: 0.02
  seeds: [181081, 206369, 233021]
tasks:
  - id: task-1
    inputArtifact: inputs/sha256/00/${"0".repeat(64)}.json
schedule:
  type: paired_interleave
  maximumHostedCallsInFlight: 16
  maximumSandboxes: 4
selection:
  primaryMetric: area_brier
  secondaryMetrics: [area_hit_at_1, scope_hit_at_1]
  maximumPromotedTreatments: 1
budget:
  providerMaximumUsd: 20
  vercelMaximumUsd: 25
dataAccess:
  lockedTest: false
`;

export function SubmitForm() {
  const router = useRouter();
  const [manifest, setManifest] = useState(SAMPLE);
  const [token, setToken] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit() {
    setState("submitting");
    setMessage("");
    const response = await fetch("/api/experiments", {
      method: "POST",
      headers: {
        "content-type": "text/yaml",
        ...(token === "" ? {} : { authorization: `Bearer ${token}` })
      },
      body: manifest
    });
    const payload = (await response.json()) as {
      experiment?: { experimentId?: string; status?: string };
      error?: string;
    };
    if (!response.ok) {
      setState("error");
      setMessage(payload.error ?? "Submission failed");
      return;
    }
    setState("success");
    setMessage(
      `${payload.experiment?.experimentId ?? "Experiment"} created as ${
        payload.experiment?.status ?? "queued"
      }.`
    );
    router.refresh();
  }

  return (
    <div className="form-grid">
      <div className="field full">
        <label htmlFor="manifest">Frozen experiment manifest (YAML or JSON)</label>
        <textarea
          id="manifest"
          value={manifest}
          onChange={(event) => setManifest(event.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="field">
        <label htmlFor="token">Admin API token</label>
        <input
          id="token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Required in production"
        />
      </div>
      <div className="field">
        <label>&nbsp;</label>
        <button type="button" onClick={submit} disabled={state === "submitting"}>
          {state === "submitting" ? "Validating…" : "Validate and submit"}
        </button>
      </div>
      {message !== "" ? (
        <div className={`field full ${state === "error" ? "error" : "success"}`}>{message}</div>
      ) : null}
    </div>
  );
}
