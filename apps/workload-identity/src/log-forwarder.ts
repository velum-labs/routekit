import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  type InputLogEvent,
  PutLogEventsCommand,
  ResourceAlreadyExistsException
} from "@aws-sdk/client-cloudwatch-logs";
import { metadata, metadataToken } from "./imds.js";

type JournalRecord = {
  __REALTIME_TIMESTAMP?: unknown;
  MESSAGE?: unknown;
  _SYSTEMD_UNIT?: unknown;
  _SYSTEMD_USER_UNIT?: unknown;
  PRIORITY?: unknown;
};

const UNIT_GROUP = new Map([
  ["routekit-runtime-supervisor.service", "supervisor"],
  ["routekit-workload-connector.service", "routekit-connector"],
  ["t3code.service", "t3"]
]);

export function parseJournalRecord(line: string): { group: string; event: InputLogEvent } | null {
  let record: JournalRecord;
  try {
    record = JSON.parse(line) as JournalRecord;
  } catch {
    return null;
  }
  const unit =
    typeof record._SYSTEMD_UNIT === "string"
      ? record._SYSTEMD_UNIT
      : typeof record._SYSTEMD_USER_UNIT === "string"
        ? record._SYSTEMD_USER_UNIT
        : undefined;
  const group = unit === undefined ? undefined : UNIT_GROUP.get(unit);
  if (group === undefined || typeof record.MESSAGE !== "string") return null;
  const micros =
    typeof record.__REALTIME_TIMESTAMP === "string"
      ? Number.parseInt(record.__REALTIME_TIMESTAMP, 10)
      : Number.NaN;
  const timestamp = Number.isSafeInteger(micros) ? Math.floor(micros / 1_000) : Date.now();
  const priority = typeof record.PRIORITY === "string" ? record.PRIORITY : "6";
  return {
    group,
    event: {
      timestamp,
      message: JSON.stringify({ unit, priority, message: record.MESSAGE.slice(0, 240_000) })
    }
  };
}

export async function runLogForwarder(): Promise<never> {
  const token = await metadataToken();
  const document = JSON.parse(await metadata("dynamic/instance-identity/document", token)) as {
    instanceId?: unknown;
    region?: unknown;
  };
  const trustDomain = await metadata("meta-data/tags/instance/routekit:trust-domain", token);
  if (
    typeof document.instanceId !== "string" ||
    typeof document.region !== "string" ||
    !/^[a-z][a-z0-9-]{2,63}$/.test(trustDomain)
  ) {
    throw new Error("invalid runtime identity for log forwarding");
  }
  const instanceId = document.instanceId;
  const region = document.region;

  const client = new CloudWatchLogsClient({ region });
  const streams = new Map<string, string>();
  for (const group of new Set(UNIT_GROUP.values())) {
    const groupName = `/routekit/runtime/${trustDomain}/${group}`;
    try {
      await client.send(
        new CreateLogStreamCommand({
          logGroupName: groupName,
          logStreamName: instanceId
        })
      );
    } catch (error) {
      if (!(error instanceof ResourceAlreadyExistsException)) throw error;
    }
    streams.set(group, groupName);
  }

  const queues = new Map<string, InputLogEvent[]>();
  let flushing = false;
  const flush = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;
    try {
      for (const [group, events] of queues) {
        if (events.length === 0) continue;
        const batch = events.splice(0, 100).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        try {
          await client.send(
            new PutLogEventsCommand({
              logGroupName: streams.get(group),
              logStreamName: instanceId,
              logEvents: batch
            })
          );
        } catch (error) {
          events.unshift(...batch);
          throw error;
        }
      }
    } finally {
      flushing = false;
    }
  };

  const journal = spawn(
    "/usr/bin/journalctl",
    [
      "--follow",
      "--lines=100",
      "--output=json",
      "--unit=routekit-runtime-supervisor.service",
      "--unit=routekit-workload-connector.service",
      "--user-unit=t3code.service"
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  if (journal.stdout === null) throw new Error("journalctl stdout unavailable");
  const reader = createInterface({ input: journal.stdout });
  reader.on("line", (line) => {
    const parsed = parseJournalRecord(line);
    if (parsed === null) return;
    const queue = queues.get(parsed.group) ?? [];
    queue.push(parsed.event);
    if (queue.length > 10_000) queue.splice(0, queue.length - 10_000);
    queues.set(parsed.group, queue);
  });
  const exit = new Promise<never>((_, reject) => {
    journal.once("exit", (code) => {
      reject(new Error(`journalctl exited unexpectedly with status ${code ?? "signal"}`));
    });
  });

  for (;;) {
    await Promise.race([new Promise((resolve) => setTimeout(resolve, 1_000)), exit]);
    await flush();
  }
}
