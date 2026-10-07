import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, expect, test } from "vitest";

import { runGitCommand, type RunGitCommand } from "../utils/run-git-command.js";
import { fetchWorkspaceGitRemote } from "./workspace-git-fetch.js";

// Repro for #3335: a background fetch that outlives its timeout is SIGKILLed,
// and every killed attempt leaves a partial `tmp_pack_*` behind. The daemon
// retries every 180s, so a fetch that needs longer than the timeout grows
// `.git/objects/pack` without bound.

const FETCH_TIMEOUT_MS = 300;
const cleanupPaths: string[] = [];
let checkout: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "paseo-fetch-timeout-"));
  cleanupPaths.push(root);
  const upstream = join(root, "upstream.git");
  const seed = join(root, "seed");
  checkout = join(root, "checkout");
  git(root, ["init", "-q", "--bare", "-b", "main", upstream]);
  git(root, ["init", "-q", "-b", "main", seed]);
  git(seed, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
  git(seed, ["push", "-q", upstream, "main"]);
  git(root, ["clone", "-q", "--no-local", upstream, checkout]);
  // Advance upstream with incompressible content so the next fetch takes
  // longer than FETCH_TIMEOUT_MS to transfer. More than git's default
  // `fetch.unpackLimit` (100 objects) so the fetch keeps a pack, like any
  // large fetch does, instead of exploding into loose objects.
  for (let i = 0; i < 200; i += 1) {
    writeFileSync(join(seed, `blob-${i}.bin`), randomBytes(1024 * 1024));
  }
  git(seed, ["add", "."]);
  git(seed, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "-m",
    "large",
  ]);
  git(seed, ["push", "-q", upstream, "main"]);
}, 120_000);

afterAll(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function packDirectory(): { tmpPacks: string[] } {
  const entries = readdirSync(join(checkout, ".git", "objects", "pack"));
  return { tmpPacks: entries.filter((entry) => entry.startsWith("tmp_pack_")) };
}

// The daemon's runner, with the fetch budget shortened from 120s so a local
// fetch outlives it the way a large repository's fetch outlives 120s.
const runWithShortFetchTimeout: RunGitCommand = (args, options) =>
  runGitCommand(
    args,
    args[0] === "fetch" ? { ...options, timeout: FETCH_TIMEOUT_MS } : options
  );

test("a background fetch that times out leaves no partial pack behind", async () => {
  const before = packDirectory();
  const observations: { error: string | null; tmpPacks: number }[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await fetchWorkspaceGitRemote(
      checkout,
      { onRefSnapshot() {} },
      runWithShortFetchTimeout
    );
    const after = packDirectory();
    observations.push({
      error: result.error instanceof Error ? result.error.message : null,
      tmpPacks: after.tmpPacks.length,
    });
  }

  expect(observations).toEqual([
    {
      error: expect.stringContaining("timed out"),
      tmpPacks: before.tmpPacks.length,
    },
    {
      error: expect.stringContaining("timed out"),
      tmpPacks: before.tmpPacks.length,
    },
    {
      error: expect.stringContaining("timed out"),
      tmpPacks: before.tmpPacks.length,
    },
  ]);
}, 60_000);
