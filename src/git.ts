import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangeStatus, FileContents, ReviewCheckpoint, StoredFile } from "./types.js";

/** Maximum number of candidate files a single scan will enumerate. Beyond this
 * the scan is truncated and the UI reports "too many changed files". Keeps the
 * host alive in very large dirty trees (worktrees of 225k tracked files). */
export const MAX_CANDIDATES = 2000;

/** Files larger than this are never read into the host heap: scan skips them
 * for content comparison and getFile returns a placeholder. Protects the V8
 * heap and the WebKit web process from multi-MB payloads. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB

/** Concurrency cap for per-file subprocess/stat ops during scans. Prevents
 * EMFILE / fork storms when a repo has thousands of candidates. */
const POOL_CONCURRENCY = 8;

export interface FilePair {
  path: string;
  status: ChangeStatus;
  /** `size:mtimeMs` of the working-tree file, or `"deleted"`. Same scheme is
   * used in {@link FileContents.fingerprint} so the UI can compare the two for
   * equality to decide whether to re-request a file. The UI only needs equality
   * comparison — it does not require a content hash. */
  fingerprint: string;
}

export interface ScanResult {
  pairs: FilePair[];
  truncated: boolean;
}

async function git(pi: ExtensionAPI, cwd: string, args: string[], allowFailure = false): Promise<string> {
  const result = await pi.exec("git", args, { cwd });
  if (result.code !== 0) {
    if (allowFailure) return "";
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

/** Run `fn` over `items` with at most `concurrency` in flight, preserving order. */
async function mapPool<T, U>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<U>): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const root = await git(pi, cwd, ["rev-parse", "--show-toplevel"]);
  return root.trim();
}

export async function getHeadSha(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const sha = (await git(pi, repoRoot, ["rev-parse", "--verify", "HEAD"], true)).trim();
  return sha || null;
}

export async function getBranchName(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const branch = (await git(pi, repoRoot, ["branch", "--show-current"], true)).trim();
  return branch || null;
}

export function parsePorcelainPaths(output: string): string[] {
  const fields = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const status = field.slice(0, 2);
    paths.push(field.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const oldPath = fields[index + 1];
      if (oldPath) paths.push(oldPath);
      index += 1;
    }
  }
  return [...new Set(paths)];
}

/** Parsed entry from `git diff --name-status -z`: a status letter + path. */
interface NameStatusEntry {
  path: string;
  status: string;
}

/** Parse `git diff --name-status -z` output into entries, handling renames/copy
 * (R/C) which carry a second NUL path field (the old name). With `-z` the
 * status letter and the path are separate NUL-delimited fields (no tab), so
 * fields alternate: `M\0path\0A\0path\0R100\0new\0old\0`. */
export function parseNameStatus(output: string): NameStatusEntry[] {
  const fields = output.split("\0").filter(Boolean);
  const entries: NameStatusEntry[] = [];
  for (let index = 0; index < fields.length; ) {
    const letter = fields[index]!;
    if (letter.length < 1) { index += 1; continue; }
    const status = letter[0]!;
    const path = fields[index + 1];
    if (path == null) break;
    entries.push({ path, status });
    if (status === "R" || status === "C") {
      const oldPath = fields[index + 2];
      if (oldPath != null) entries.push({ path: oldPath, status });
      index += 3;
    } else {
      index += 2;
    }
  }
  return entries;
}

async function dirtyPaths(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
  const output = await git(pi, repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return parsePorcelainPaths(output);
}

async function untrackedPaths(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
  return splitZero(await git(pi, repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"], true));
}

async function currentPaths(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
  return splitZero(await git(pi, repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], true));
}

/** `git diff --name-status -z <revision> --` parsed to entries. Falls back to
 * listing every tracked+untracked path as "added" when there is no HEAD. */
async function changedAgainst(pi: ExtensionAPI, repoRoot: string, revision: string | null): Promise<NameStatusEntry[]> {
  if (revision == null) {
    return (await currentPaths(pi, repoRoot)).map((path) => ({ path, status: "A" }));
  }
  const output = await git(pi, repoRoot, ["diff", "--name-status", "-z", revision, "--"], true);
  return parseNameStatus(output);
}

function splitZero(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

/** Stat-based fingerprint for the working-tree side. Same scheme used in both
 * {@link FilePair.fingerprint} and {@link FileContents.fingerprint} so the UI
 * equality check (`file.fingerprint === mountedFingerprint`) works. */
export async function statFingerprint(repoRoot: string, path: string): Promise<string> {
  const absolute = join(repoRoot, path);
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return "deleted";
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return "deleted";
  }
}

type ReadOutcome =
  | { kind: "missing" }
  | { kind: "large"; size: number }
  | { kind: "binary"; size: number }
  | { kind: "content"; content: string; size: number };

/** Read a file from disk, but never load more than {@link MAX_FILE_BYTES} into
 * the heap and refuse binary files (NUL byte in the first 8 KiB). */
async function readCurrentCapped(repoRoot: string, path: string): Promise<ReadOutcome> {
  const absolute = join(repoRoot, path);
  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return { kind: "missing" };
    size = info.size;
  } catch {
    return { kind: "missing" };
  }
  if (size > MAX_FILE_BYTES) return { kind: "large", size };
  try {
    const content = await readFile(absolute, "utf8");
    if (content.includes("\0")) return { kind: "binary", size };
    return { kind: "content", content, size };
  } catch {
    return { kind: "missing" };
  }
}

/** Read file content at a Git revision via `git show`. Capped: returns null
 * placeholder marker for oversized or binary content. */
async function readRevisionCapped(pi: ExtensionAPI, repoRoot: string, revision: string | null, path: string): Promise<{ content: string | null; missing: boolean; large: boolean; binary: boolean }> {
  if (revision == null) return { content: null, missing: true, large: false, binary: false };
  const result = await pi.exec("git", ["show", `${revision}:${path}`], { cwd: repoRoot });
  if (result.code !== 0) return { content: null, missing: true, large: false, binary: false };
  const stdout = result.stdout;
  if (stdout.includes("\0")) return { content: null, missing: false, large: false, binary: true };
  // Heuristic: pi.exec may truncate on maxBuffer; treat a length at the cap as
  // "too large" rather than showing a truncated file silently.
  if (stdout.length >= MAX_FILE_BYTES) return { content: null, missing: false, large: true, binary: false };
  return { content: stdout, missing: false, large: false, binary: false };
}

export function fingerprint(content: string | null): string {
  if (content == null) return "deleted";
  return createHash("sha256").update(content).digest("hex");
}

function letterToStatus(letter: string, originalMissing: boolean, modifiedMissing: boolean): ChangeStatus {
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  if (modifiedMissing) return "deleted";
  if (originalMissing) return "added";
  return "modified";
}

function encodeStored(content: string | null): StoredFile {
  if (content == null) return { state: "deleted" };
  return {
    state: "present",
    fingerprint: fingerprint(content),
    encoding: "gzip+base64",
    content: gzipSync(Buffer.from(content, "utf8")).toString("base64"),
  };
}

export function decodeStored(file: StoredFile): string | null {
  if (file.state === "deleted") return null;
  return gunzipSync(Buffer.from(file.content, "base64")).toString("utf8");
}

/** Placeholder string shown in the editor when a file side is too large or binary. */
function placeholder(label: string, size?: number): string {
  return size == null ? `--- ${label} ---` : `--- ${label} (${(size / 1024).toFixed(1)} KiB) ---`;
}

/** Build a {@link FileContents} for a single path by reading the baseline
 * (checkpoint override or HEAD revision) and the working-tree file on demand.
 * Never loads more than {@link MAX_FILE_BYTES} per side; large/binary/missing
 * sides are replaced with placeholder text. The fingerprint is the stat-based
 * value from the {@link FilePair} (not a content hash) so the UI equality check
 * against {@link FilePair.fingerprint} holds. */
export async function getFileContents(
  pi: ExtensionAPI,
  repoRoot: string,
  checkpoint: Pick<ReviewCheckpoint, "headSha" | "overrides">,
  path: string,
  fingerprintValue: string,
): Promise<FileContents> {
  const override = checkpoint.overrides[path];
  let original: string;
  if (override != null) {
    original = decodeStored(override) ?? placeholder("binary or undecodable checkpoint override");
  } else {
    const rev = await readRevisionCapped(pi, repoRoot, checkpoint.headSha, path);
    original = rev.content ?? (rev.missing ? placeholder("file did not exist at this revision") : rev.large ? placeholder("original too large to display") : rev.binary ? placeholder("original is binary") : placeholder("original unavailable"));
  }

  const modified = await readCurrentCapped(repoRoot, path);
  let modifiedContent: string;
  switch (modified.kind) {
    case "missing": modifiedContent = placeholder("file deleted"); break;
    case "large": modifiedContent = placeholder("file too large to display", modified.size); break;
    case "binary": modifiedContent = placeholder("binary file", modified.size); break;
    case "content": modifiedContent = modified.content; break;
  }

  return {
    path,
    mode: "checkpoint",
    fingerprint: fingerprintValue,
    originalContent: original,
    modifiedContent: modifiedContent,
  };
}

export async function scanAgainstCheckpoint(
  pi: ExtensionAPI,
  repoRoot: string,
  checkpoint: Pick<ReviewCheckpoint, "headSha" | "overrides">,
): Promise<ScanResult> {
  const [changed, untracked] = await Promise.all([
    changedAgainst(pi, repoRoot, checkpoint.headSha),
    untrackedPaths(pi, repoRoot),
  ]);

  // Map of path -> candidate. Changed/untracked paths get a cheap stat-based
  // fingerprint and a status derived from the git letter; override-only paths
  // (no longer reported as changed by git) need a content comparison to detect
  // whether they were reverted to the checkpoint snapshot.
  const byPath = new Map<string, { path: string; status?: string; override?: true }>();
  for (const entry of changed) byPath.set(entry.path, { path: entry.path, status: entry.status });
  for (const path of untracked) {
    if (!byPath.has(path)) byPath.set(path, { path, status: "A" });
  }
  for (const path of Object.keys(checkpoint.overrides)) {
    if (!byPath.has(path)) byPath.set(path, { path, override: true });
  }

  // Compare EVERY override path's current content to its stored snapshot. A
  // path can be reported as changed by git AND still match the checkpoint
  // snapshot (file was dirty at checkpoint time and hasn't changed since) —
  // that is NOT a new change and must be excluded from the delta. Checking
  // only override-only paths would miss that case and show stale-dirty files
  // as newly changed.
  const overridePaths = Object.keys(checkpoint.overrides);
  const overrideEqual = new Set<string>();
  await mapPool(overridePaths, POOL_CONCURRENCY, async (path) => {
    const stored = checkpoint.overrides[path];
    if (stored == null || stored.state !== "present") return;
    const outcome = await readCurrentCapped(repoRoot, path);
    if (outcome.kind !== "content") {
      // Missing/large/binary — not "equal", include so the user sees the state.
      return;
    }
    if (fingerprint(outcome.content) === stored.fingerprint) overrideEqual.add(path);
  });

  const sortedPaths = [...byPath.keys()].sort((a, b) => a.localeCompare(b));
  const truncated = sortedPaths.length > MAX_CANDIDATES;
  const limited = truncated ? sortedPaths.slice(0, MAX_CANDIDATES) : sortedPaths;

  const pairs = await mapPool(limited, POOL_CONCURRENCY, async (path): Promise<FilePair | null> => {
    const candidate = byPath.get(path)!;
    const modifiedFp = await statFingerprint(repoRoot, path);
    const modifiedMissing = modifiedFp === "deleted";

    if (checkpoint.overrides[path] != null && overrideEqual.has(path)) {
      // Working tree matches the checkpoint snapshot exactly — no change to show.
      return null;
    }

    let status: ChangeStatus;
    if (candidate.status != null) {
      // From git diff name-status or untracked. Determine original presence:
      // untracked => no original; "A" => no original; "D" => deleted; else modified.
      const originalMissing = candidate.status === "A" || (untracked.includes(path) && !changed.some((c) => c.path === path));
      status = letterToStatus(candidate.status, originalMissing, modifiedMissing);
    } else {
      // Override-only path: original existed (checkpoint stored it). Status from presence.
      status = modifiedMissing ? "deleted" : "modified";
    }

    return { path, status, fingerprint: modifiedFp };
  });

  return { pairs: pairs.filter((pair): pair is FilePair => pair != null), truncated };
}

export async function scanAgainstHead(pi: ExtensionAPI, repoRoot: string): Promise<ScanResult> {
  return scanAgainstCheckpoint(pi, repoRoot, { headSha: await getHeadSha(pi, repoRoot), overrides: {} });
}

export async function createCheckpoint(
  pi: ExtensionAPI,
  repoRoot: string,
  reviewedPaths: string[],
  feedback: string,
): Promise<ReviewCheckpoint> {
  const headSha = await getHeadSha(pi, repoRoot);
  const dirty = await dirtyPaths(pi, repoRoot);
  const overrides: Record<string, StoredFile> = {};
  let skippedLarge = 0;
  // Only snapshot files small enough to keep the session entry bounded. Larger
  // files fall back to the HEAD revision as the baseline on the next scan.
  await mapPool(dirty, POOL_CONCURRENCY, async (path) => {
    const absolute = join(repoRoot, path);
    try {
      const info = await stat(absolute);
      if (!info.isFile()) return;
      if (info.size > MAX_FILE_BYTES) { skippedLarge += 1; return; }
    } catch {
      overrides[path] = encodeStored(null);
      return;
    }
    const outcome = await readCurrentCapped(repoRoot, path);
    if (outcome.kind === "content") {
      overrides[path] = encodeStored(outcome.content);
    } else if (outcome.kind === "missing") {
      overrides[path] = encodeStored(null);
    } else {
      // large/binary dirty file: skip snapshotting (baseline falls back to HEAD).
      skippedLarge += 1;
    }
  });

  return {
    version: 1,
    id: randomUUID(),
    repoRoot,
    createdAt: Date.now(),
    headSha,
    overrides,
    reviewedPaths: [...new Set(reviewedPaths)].sort(),
    feedback,
  };
}

export async function fileMtime(repoRoot: string, path: string): Promise<number> {
  const absolute = join(repoRoot, path);
  try {
    return (await stat(absolute)).mtimeMs;
  } catch {
    try {
      return (await stat(dirname(absolute))).mtimeMs;
    } catch {
      return 0;
    }
  }
}

/** Cheap signature of the working tree used by the polling watcher to decide
 * whether a full refresh is needed. Combines HEAD SHA + branch name + the full
 * `git status --porcelain -z --untracked-files=normal` output. Git honors the
 * entire exclude chain (.gitignore, .git/info/exclude, core.excludesFile) here,
 * so heavy directories (vendor/, build/, pg_data, ...) never appear and never
 * pollute the signature. One exec per piece, ~3 cheap git calls per poll tick. */
export async function workspaceSignature(pi: ExtensionAPI, repoRoot: string): Promise<string> {
  const [sha, branch, status] = await Promise.all([
    git(pi, repoRoot, ["rev-parse", "--verify", "HEAD"], true),
    git(pi, repoRoot, ["branch", "--show-current"], true),
    git(pi, repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], true),
  ]);
  return `${sha.trim()}|${branch.trim()}|${status}`;
}

export function repoName(repoRoot: string): string {
  return basename(repoRoot);
}

export function pathExists(repoRoot: string, path: string): boolean {
  return existsSync(join(repoRoot, path));
}
