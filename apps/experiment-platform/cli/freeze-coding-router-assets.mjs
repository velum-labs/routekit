#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const argv = process.argv.slice(2);

function argument(name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

const labRoot = path.resolve(
  argument(
    "--lab-root",
    "/home/benjamin/repos/ori-runtime-lab/experiments/coding-router-lab"
  )
);
const outputDirectory = path.resolve(
  argument("--output-directory", ".routekit-experiment-assets/coding-router-20260817")
);
const sourceConfig = path.join(
  labRoot,
  "data/private/natural-hard-cohort-v2-48/performance-config.json"
);
const retrievalRoot = path.join(
  labRoot,
  "artifacts/luna-performance-retrieval-48-20260816/retrieval"
);

const sha256Bytes = (value) => createHash("sha256").update(value).digest("hex");
const sha256File = async (file) => sha256Bytes(await readFile(file));

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function readJsonl(file) {
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function writeJsonl(file, values) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, {
    mode: 0o600
  });
}

function safeId(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");
}

async function deterministicArchive(source, destination) {
  await execFileAsync(
    "tar",
    [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--pax-option=delete=atime,delete=ctime",
      "-I",
      "zstd -19 -T0",
      "-cf",
      destination,
      "-C",
      path.dirname(source),
      path.basename(source)
    ],
    { maxBuffer: 16 * 1024 * 1024 }
  );
}

async function artifactRecord(kind, id, file) {
  const digest = await sha256File(file);
  return {
    kind,
    id,
    file,
    digest,
    size: (await stat(file)).size,
    pathname: `${kind}/${safeId(id)}/sha256/${digest.slice(0, 2)}/${digest}.tar.zst`
  };
}

async function copyRetrievals(episodeIds, destination) {
  const ids = new Set(episodeIds);
  for (const variant of await readdir(retrievalRoot, { withFileTypes: true })) {
    if (!variant.isDirectory()) continue;
    const target = path.join(destination, "retrieval", variant.name);
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const episodeId of ids) {
      const source = path.join(retrievalRoot, variant.name, `${episodeId}.json`);
      await cp(source, path.join(target, `${episodeId}.json`));
    }
  }
}

async function buildDatasetPartition(input) {
  const staging = path.join(outputDirectory, "staging", input.id);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await writeJsonl(path.join(staging, "episodes.jsonl"), input.episodes);
  await writeJsonl(path.join(staging, "labels.jsonl"), input.labels);
  await copyRetrievals(
    input.episodes.map((episode) => episode.id),
    staging
  );
  const repositories = [];
  for (const repository of input.config.repositories) {
    const repositoryId = safeId(repository.repositoryId);
    const directory = path.join(staging, "repositories", repositoryId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await cp(path.resolve(labRoot, repository.profile), path.join(directory, "profile.json"));
    await cp(path.resolve(labRoot, repository.areas), path.join(directory, "area-cards.jsonl"));
    repositories.push({
      repositoryId: repository.repositoryId,
      profile: `repositories/${repositoryId}/profile.json`,
      areas: `repositories/${repositoryId}/area-cards.jsonl`
    });
  }
  const memberHashes = {};
  for (const relative of ["episodes.jsonl", "labels.jsonl"]) {
    memberHashes[relative] = await sha256File(path.join(staging, relative));
  }
  await writeJson(path.join(staging, "dataset-manifest.json"), {
    schemaVersion: 1,
    id: input.id,
    role: input.role,
    source: {
      repository: "velum-labs/ori",
      labRoot,
      sourceConfig,
      sourceCommit: input.sourceCommit
    },
    cases: input.episodes.length,
    episodeIds: input.episodes.map((episode) => episode.id),
    repositories,
    memberHashes,
    safeguards: {
      taskAwareContextOnly: true,
      lockedTestDataIncluded: false,
      labelsStoredSeparatelyFromRuntimeInputs: true,
      exactPreTaskSnapshotsRequired: true
    }
  });
  const archive = path.join(outputDirectory, `${input.id}.tar.zst`);
  await deterministicArchive(staging, archive);
  return artifactRecord("datasets", input.id, archive);
}

async function buildRepositoryStore(repository, snapshots) {
  const repositoryId = safeId(repository.repositoryId);
  const staging = path.join(outputDirectory, "staging", `${repositoryId}-snapshots.git`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
  await execFileAsync("git", ["init", "--bare", "--quiet", staging]);
  for (const snapshot of snapshots) {
    await execFileAsync(
      "git",
      [
        "-C",
        staging,
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        repository.repository,
        `${snapshot}:refs/snapshots/${snapshot}`
      ],
      { maxBuffer: 64 * 1024 * 1024 }
    );
  }
  await execFileAsync("git", ["-C", staging, "repack", "-ad"]);
  await rm(path.join(staging, "FETCH_HEAD"), { force: true });
  await rm(path.join(staging, "hooks"), { recursive: true, force: true });
  await writeJson(path.join(staging, "routekit-snapshots.json"), {
    schemaVersion: 1,
    repositoryId: repository.repositoryId,
    sourceRepository: repository.repository,
    snapshots
  });
  for (const snapshot of snapshots) {
    await execFileAsync("git", ["-C", staging, "cat-file", "-e", `${snapshot}^{tree}`]);
    await execFileAsync("git", ["-C", staging, "archive", "--format=tar", snapshot, "-o", "/dev/null"], {
      maxBuffer: 64 * 1024 * 1024
    });
  }
  const archive = path.join(outputDirectory, `${repositoryId}-snapshots.git.tar.zst`);
  await deterministicArchive(staging, archive);
  return artifactRecord("repositories", `${repositoryId}-snapshots`, archive);
}

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const config = JSON.parse(await readFile(sourceConfig, "utf8"));
const episodes = await readJsonl(path.resolve(labRoot, config.episodes));
const labels = await readJsonl(path.resolve(labRoot, config.labels));
const labelsById = new Map(labels.map((label) => [label.taskEpisodeId, label]));
const developmentIds = new Set(config.developmentEpisodeIds);
const sourceCommit = (
  await execFileAsync("git", ["-C", path.resolve(labRoot, "../.."), "rev-parse", "HEAD"], {
    encoding: "utf8"
  })
).stdout.trim();

const developmentEpisodes = episodes.filter((episode) => developmentIds.has(episode.id));
const confirmationEpisodes = episodes.filter((episode) => !developmentIds.has(episode.id));
const partitions = [
  {
    id: "natural-hard-v2-development-24",
    role: "development",
    episodes: developmentEpisodes
  },
  {
    id: "natural-hard-v2-confirmation-24",
    role: "confirmation",
    episodes: confirmationEpisodes
  }
];
const artifacts = [];
for (const partition of partitions) {
  artifacts.push(
    await buildDatasetPartition({
      ...partition,
      labels: partition.episodes.map((episode) => labelsById.get(episode.id)),
      config,
      sourceCommit
    })
  );
}
for (const repository of config.repositories) {
  const snapshots = [
    ...new Set(
      episodes
        .filter((episode) => episode.repositoryId === repository.repositoryId)
        .map((episode) => episode.repositorySnapshot)
    )
  ].sort();
  artifacts.push(await buildRepositoryStore(repository, snapshots));
}
await writeJson(path.join(outputDirectory, "artifact-inventory.json"), {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceCommit,
  lockedTestDataIncluded: false,
  artifacts
});
console.log(
  JSON.stringify(
    {
      ok: true,
      outputDirectory,
      artifacts: artifacts.map(({ kind, id, digest, size, pathname }) => ({
        kind,
        id,
        digest,
        size,
        pathname
      }))
    },
    null,
    2
  )
);
