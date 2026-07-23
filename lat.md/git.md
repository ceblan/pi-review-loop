# Git Layer

`src/git.ts` contains all Git subprocess interactions, file content encoding/decoding, and checkpoint creation. Every Git call goes through `pi.exec("git", args, { cwd })` so the extension never spawns processes directly.

## Core helpers

Low-level wrappers used by all other functions in this module.

### git(pi, cwd, args, allowFailure?)

Low-level wrapper. Runs `git` via `pi.exec`, throws on non-zero exit unless `allowFailure` is true (returns `""` on failure).

### splitZero(value)

Splits a NUL-delimited Git output string into a filtered array. Used for `-z` flag outputs.

## Repo introspection

Functions that query basic repository metadata via Git plumbing commands.

| Function | Git command | Returns |
|----------|-------------|---------|
| `getRepoRoot` | `rev-parse --show-toplevel` | Absolute repo root path |
| `getHeadSha` | `rev-parse --verify HEAD` (allowFailure) | HEAD SHA or `null` (empty repo) |
| `getBranchName` | `branch --show-current` (allowFailure) | Branch name or `null` (detached HEAD) |

## Porcelain parsing

Parses `git status --porcelain=v1 -z` output into a deduplicated path list.

### parsePorcelainPaths(output)

Parses `git status --porcelain=v1 -z` output. Handles:

- Standard entries: `XY path` (3-char prefix: 2 status chars + space).
- Renames/copies (`R`/`C` status): consumes the next NUL field as the old path and includes both paths.
- Deduplicates via `Set`.

Exported for direct testing.

## File scanning

Functions that enumerate changed, untracked, or tracked paths and read file content from disk or Git revisions.

### dirtyPaths(pi, repoRoot)

`git status --porcelain=v1 -z --untracked-files=all` → all dirty + untracked paths.

### untrackedPaths(pi, repoRoot)

`git ls-files --others --exclude-standard -z` → untracked-only paths.

### currentPaths(pi, repoRoot)

`git ls-files --cached --others --exclude-standard -z` → all tracked + untracked paths. Used when `revision` is `null` (empty repo, no HEAD).

### changedAgainst(pi, repoRoot, revision)

`git diff --name-only -z <revision> --` → paths differing from a revision. Falls back to `currentPaths` when `revision` is `null`.

### readCurrent(repoRoot, path)

Reads a file from disk via `fs.readFile`. Returns `null` for missing files or non-regular files.

### readRevision(pi, repoRoot, revision, path)

`git show <revision>:<path>` → file content at a revision. Returns `null` if the revision is `null` or the file doesn't exist at that revision.

## Fingerprinting

Content hashing used to detect whether a file has changed since the UI last mounted it.

### fingerprint(content)

SHA-256 hex digest of the content string. Returns the literal string `"deleted"` for `null` content. Used to detect whether a file's content has changed since the UI last mounted it, avoiding redundant re-renders.

## Status inference

Determines the `ChangeStatus` from the presence or absence of original and modified content.

### statusFor(original, modified)

| original | modified | status |
|----------|----------|--------|
| `null` | any | `"added"` |
| any | `null` | `"deleted"` |
| non-null | non-null | `"modified"` |

## Checkpoint encoding

Serializes and deserializes file content for storage inside checkpoint overrides.

### encodeStored(content)

Serializes file content into a `StoredFile` for checkpoint storage.

- `null` → `{ state: "deleted" }`.
- string → `{ state: "present", fingerprint, encoding: "gzip+base64", content }` where content is gzip-compressed then base64-encoded.

### decodeStored(file)

Reverses `encodeStored`. `gunzipSync(base64decode(content))` for present files; `null` for deleted.

Exported for testing.

## baselineContent(pi, repoRoot, checkpoint, path)

Resolves the "original" content for a path in checkpoint mode:

1. If `checkpoint.overrides[path]` exists → `decodeStored(override)`.
2. Otherwise → `readRevision(pi, repoRoot, checkpoint.headSha, path)`.

This is the key mechanism: overrides capture the exact file state at checkpoint time, so even if HEAD advances (new commits), the checkpoint baseline remains stable.

## scanAgainstCheckpoint(pi, repoRoot, checkpoint)

Builds the full list of `FilePair` objects for checkpoint mode:

1. Candidate set = union of:
   - `changedAgainst(pi, repoRoot, checkpoint.headSha)` — files changed vs the checkpoint's HEAD.
   - `untrackedPaths(pi, repoRoot)` — new untracked files.
   - `Object.keys(checkpoint.overrides)` — files that were dirty at checkpoint time.
2. For each candidate, reads `baselineContent` and `readCurrent` in parallel.
3. Filters out pairs where original === modified (no actual change).
4. Sorts alphabetically by path.

### scanAgainstHead(pi, repoRoot)

Convenience wrapper: `scanAgainstCheckpoint` with `{ headSha: currentHEAD, overrides: {} }`.

## createCheckpoint(pi, repoRoot, reviewedPaths, feedback)

Creates a `ReviewCheckpoint`:

1. Captures current HEAD SHA.
2. Snapshots all dirty paths (`dirtyPaths`) into `overrides` via `encodeStored(readCurrent(...))`.
3. Returns `{ version: 1, id: randomUUID(), repoRoot, createdAt: Date.now(), headSha, overrides, reviewedPaths, feedback }`.

The overrides map is the critical piece: it stores the exact content of every dirty file at checkpoint time, so future `scanAgainstCheckpoint` calls can diff against this snapshot even if HEAD moves.

## Utility

Small helpers for file metadata and path operations.

| Function | Purpose |
|----------|---------|
| `fileMtime(repoRoot, path)` | File mtime; falls back to parent directory mtime for deleted files, then `0` |
| `repoName(repoRoot)` | `basename(repoRoot)` |
| `pathExists(repoRoot, path)` | `existsSync` check |
