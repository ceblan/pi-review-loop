# Git Layer

`src/git.ts` contains all Git subprocess interactions, file content encoding/decoding, and checkpoint creation. Every Git call goes through `pi.exec("git", args, { cwd })` so the extension never spawns processes directly.

The scan path is **lazy**: a scan computes only paths, statuses, and a cheap stat-based fingerprint — it never reads file contents into the host heap. Contents are read on demand by `getFileContents` when the UI requests a specific file. This keeps the host alive in very large dirty trees; the previous design read every candidate's full content on every refresh and retained it in memory, which OOM-killed pi in repos with thousands of changed files.

## Bounded resources

Three exported constants cap resource use so the extension cannot OOM pi or crash the WebKit window regardless of repo size.

- **`MAX_CANDIDATES`** (`2000`) — maximum number of candidate paths a single scan enumerates. Beyond this the scan is truncated and `WorkspaceState.filesCapped` is set so the UI reports "too many changed files".
- **`MAX_FILE_BYTES`** (`2 MiB`) — files larger than this are never read into the host heap. `getFileContents` returns a placeholder; `createCheckpoint` skips snapshotting them (the baseline falls back to the HEAD revision instead).
- **`POOL_CONCURRENCY`** (`8`) — internal cap on in-flight per-file subprocess/stat ops, preventing EMFILE/fork storms.

## Core helpers

Low-level wrappers used by all other functions in this module.

### git(pi, cwd, args, allowFailure?)

Low-level wrapper. Runs `git` via `pi.exec`, throws on non-zero exit unless `allowFailure` is true (returns `""` on failure).

### mapPool(items, concurrency, fn)

Runs `fn` over `items` with at most `concurrency` in flight, preserving order. Used by every per-file scan/checkpoint loop.

### splitZero(value)

Splits a NUL-delimited Git output string into a filtered array.

## Repo introspection

Functions that query basic repository metadata via Git plumbing commands.

| Function | Git command | Returns |
|----------|-------------|---------|
| `getRepoRoot` | `rev-parse --show-toplevel` | Absolute repo root path |
| `getHeadSha` | `rev-parse --verify HEAD` (allowFailure) | HEAD SHA or `null` (empty repo) |
| `getBranchName` | `branch --show-current` (allowFailure) | Branch name or `null` (detached HEAD) |

## Porcelain parsing

Parsers for the two NUL-delimited git outputs the scan path consumes.

### parsePorcelainPaths(output)

Parses `git status --porcelain=v1 -z` output into a deduplicated path list. Handles standard entries and renames/copies (`R`/`C`), which carry a second NUL field for the old path. Exported for testing.

### parseNameStatus(output)

Parses `git diff --name-status -z` output into `{ path, status }` entries. Exported for testing.

With `-z`, status letter and path are separate NUL-delimited fields (no tab), so fields alternate: `M\0path\0A\0path\0R100\0new\0old\0`. Renames/copies consume a third field (the old name).

## File scanning

Functions that enumerate changed/untracked paths and read file content from disk or Git revisions, all capped to protect the host heap.

### dirtyPaths(pi, repoRoot)

`git status --porcelain=v1 -z --untracked-files=all` → all dirty + untracked paths. Used only by `createCheckpoint` (user-triggered, rare) where exact enumeration of untracked files is required.

### untrackedPaths(pi, repoRoot)

`git ls-files --others --exclude-standard -z` → untracked-only paths. Respects the full exclude chain.

### currentPaths(pi, repoRoot)

`git ls-files --cached --others --exclude-standard -z` → all tracked + untracked paths. Used when `revision` is `null` (empty repo, no HEAD).

### changedAgainst(pi, repoRoot, revision)

`git diff --name-status -z <revision> --` parsed by `parseNameStatus` → entries with status letters.

Falls back to listing every tracked+untracked path as `"A"` when `revision` is `null`. Uses `--name-status` so status letters come directly from git without content reads.

### statFingerprint(repoRoot, path)

Stat-based fingerprint for the working-tree side: `"${size}:${mtimeMs}"`, or `"deleted"` when missing or non-regular.

This is the scheme used in **both** `FilePair.fingerprint` and `FileContents.fingerprint`. The UI compares the two for equality to decide whether to re-request a file, and equality is all it needs (not a content hash). Using one cheap scheme in both places avoids re-requesting unchanged files on every poll tick.

### readCurrentCapped(repoRoot, path)

Reads a file from disk but never loads more than `MAX_FILE_BYTES` into the heap and refuses binary files (NUL byte in the first 8 KiB). Returns a discriminated union: `missing` | `large` | `binary` | `content`.

### readRevisionCapped(pi, repoRoot, revision, path)

`git show <revision>:<path>` with the same large/binary guards as `readCurrentCapped`. Oversized revisions are treated as placeholders rather than loaded.

## Fingerprinting

Content hashing used only for checkpoint override equality comparison (does a working-tree file still match its stored snapshot?).

### fingerprint(content)

SHA-256 hex digest of the content string. Returns `"deleted"` for `null`. Not used for the UI remount contract, which uses `statFingerprint` instead — only for `StoredFile.fingerprint` and override equality checks.

## Status inference

Derives `ChangeStatus` from a git diff name-status letter plus presence flags.

### letterToStatus(letter, originalMissing, modifiedMissing)

`A`→added, `D`→deleted, otherwise presence-based inference (modified/deleted/added).

## Checkpoint encoding

Serializes and deserializes file content for storage inside checkpoint overrides.

### encodeStored(content)

Serializes file content into a `StoredFile` for checkpoint storage.

- `null` → `{ state: "deleted" }`.
- string → `{ state: "present", fingerprint, encoding: "gzip+base64", content }` (gzip-compressed then base64).

### decodeStored(file)

Reverses `encodeStored`. Exported for testing.

## getFileContents(pi, repoRoot, checkpoint, path, fingerprintValue)

Builds a `FileContents` for a single path on demand (called by `WorkspaceModel.getFile`). Reads the baseline (checkpoint override if present, else `readRevisionCapped` against `checkpoint.headSha`) and the working-tree file via `readCurrentCapped`.

Large/binary/missing sides are replaced with placeholder text so the editor always shows something instead of crashing. The `fingerprint` field is the stat-based value passed in from the `FilePair`, keeping the UI equality contract consistent.

## scanAgainstCheckpoint(pi, repoRoot, checkpoint)

Returns `{ pairs: FilePair[]; truncated: boolean }`. `FilePair` carries only `path`, `status`, and the stat fingerprint — **no content**.

1. Candidate set = union of `changedAgainst` (with status letters), `untrackedPaths`, and `Object.keys(checkpoint.overrides)`.
2. For **every** override path, computes the current content hash and compares it to the stored `StoredFile.fingerprint`. If equal, the path is excluded — it is still dirty vs HEAD but unchanged since the checkpoint, so it is not a new change.

   This check runs for all override paths, not only override-only paths: a path can be reported as changed by git AND still match its checkpoint snapshot (file was dirty at checkpoint time and hasn't changed since), and that case must be excluded from the delta.

3. For each remaining candidate (pooled at `POOL_CONCURRENCY`), computes `statFingerprint` and derives status from the git letter (or presence for override-only paths).
4. Sorts alphabetically; if the sorted set exceeds `MAX_CANDIDATES`, takes the prefix and sets `truncated`.

### scanAgainstHead(pi, repoRoot)

Wrapper: `scanAgainstCheckpoint` with `{ headSha: currentHEAD, overrides: {} }`. Also returns `{ pairs, truncated }`.

## createCheckpoint(pi, repoRoot, reviewedPaths, feedback)

Creates a `ReviewCheckpoint` capturing the current HEAD SHA and a snapshot of all dirty files.

1. Captures current HEAD SHA.
2. Snapshots all dirty paths (`dirtyPaths`) into `overrides` via `encodeStored`, pooled and skipping files larger than `MAX_FILE_BYTES` (their baseline falls back to the HEAD revision on the next scan). This bounds the size of the persisted session entry.
3. Returns `{ version: 1, id: randomUUID(), repoRoot, createdAt: Date.now(), headSha, overrides, reviewedPaths, feedback }`.

The overrides map is the critical piece: it stores the exact content of every (small enough) dirty file at checkpoint time, so future `scanAgainstCheckpoint` calls can diff against this snapshot even if HEAD moves.

## workspaceSignature(pi, repoRoot)

Cheap working-tree signature used by the [[controller#Working-tree polling]] watcher.

Combines HEAD SHA + branch name + the full `git status --porcelain=v1 -z --untracked-files=normal` output into a single string. Git honors the full exclude chain here, so heavy directories never pollute the signature and the poll stays cheap even in 225k-file repos. One exec per piece (~3 cheap git calls per tick).

## Utility

Small helpers for file metadata and path operations.

| Function | Purpose |
|----------|---------|
| `fileMtime(repoRoot, path)` | File mtime; falls back to parent directory mtime for deleted files, then `0` |
| `repoName(repoRoot)` | `basename(repoRoot)` |
| `pathExists(repoRoot, path)` | `existsSync` check |
