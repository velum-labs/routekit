"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ExperimentApprovalStage } from "@velum-labs/routekit-eval-contracts";

const LABELS: Readonly<Record<ExperimentApprovalStage, string>> = {
  paid_execution: "Approve paid execution",
  confirmation: "Authorize confirmation data",
  locked_test: "Authorize locked test"
};

export function ApprovalForm({
  experimentId,
  stages
}: {
  experimentId: string;
  stages: readonly ExperimentApprovalStage[];
}) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);

  async function approve(stage: ExperimentApprovalStage) {
    setWorking(true);
    const response = await fetch(`/api/experiments/${encodeURIComponent(experimentId)}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === "" ? {} : { authorization: `Bearer ${token}` })
      },
      body: JSON.stringify({
        stage,
        actor: "dashboard"
      })
    });
    const payload = (await response.json()) as { error?: string };
    setMessage(response.ok ? "Approval recorded." : (payload.error ?? "Approval failed"));
    setWorking(false);
    router.refresh();
  }

  return (
    <div className="form-grid">
      <div className="field">
        <label htmlFor="approval-token">Admin API token</label>
        <input
          id="approval-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </div>
      <div className="field actions">
        <label>&nbsp;</label>
        {stages.map((stage) => (
          <button type="button" onClick={() => approve(stage)} disabled={working} key={stage}>
            {working ? "Approving…" : LABELS[stage]}
          </button>
        ))}
      </div>
      {message !== "" ? <div className="field full small">{message}</div> : null}
    </div>
  );
}
