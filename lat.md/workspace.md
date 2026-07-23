# WorkspaceModel

`WorkspaceModel` in `src/workspace.ts` maintains the in-memory representation of the workspace diff state for both review modes. It is the single source of truth for what the web UI displays.

## Construction

```ts
WorkspaceModel.create(pi, repoRoot, checkpoint: ReviewCheckpoint | null)
```

Static async factory. Captures the current HEAD SHA as `initialHead` (used as the baseline when no checkpoint exists yet). The private constructor stores `pi`, `repoRoot`, `checkpoint`, and `initialHead`.

## Dual-mode state

The model maintains two independent `Map<string, FilePair>` caches keyed by path:

- `"checkpoint"` — files differing from the checkpoint baseline (or `initialHead` if no checkpoint).
- `"head"` — files differing from the current Git HEAD.

Both maps are rebuilt on every `refresh()` call. The active mode (`this.mode`) determines which map drives `state().files` and `state().recentPaths`.

## checkpointBaseline()

Returns the effective baseline for checkpoint mode:

- If a checkpoint exists: `{ headSha: checkpoint.headSha, overrides: checkpoint.overrides }`.
- Otherwise: `{ headSha: initialHead, overrides: {} }` — falls back to the HEAD captured at model creation.

## refresh()

Runs three operations in parallel:

1. `scanAgainstCheckpoint(pi, repoRoot, checkpointBaseline())` — checkpoint-mode pairs.
2. `scanAgainstHead(pi, repoRoot)` — HEAD-mode pairs.
3. `getBranchName(pi, repoRoot)` — current branch name.

Then collects mtimes for all paths across both modes via `fileMtime`. Returns `state()`.

## state(): WorkspaceState

Builds the serializable state object sent to the window:

| Field | Source |
|-------|--------|
| `repoRoot` | Constructor arg |
| `repoName` | `basename(repoRoot)` |
| `branch` | Last `getBranchName` result |
| `mode` | Active mode |
| `hasCheckpoint` | `checkpoint != null` |
| `checkpointCreatedAt` | `checkpoint?.createdAt` |
| `files` | Active mode's pairs as `ChangedFile[]` |
| `pendingFiles` | Always checkpoint-mode pairs (used for submit button count and reviewed/pending indicators) |
| `recentPaths` | Active mode's paths sorted by mtime descending, then alphabetically |

## getFile(path, mode): FileContents

Looks up the `FilePair` for `path` in the given mode's cache and returns its content pair.

Throws if the file is no longer changed in that mode (e.g., reverted between the state push and the request).

## setCheckpoint(checkpoint)

Replaces the current checkpoint and clears both pair caches and the mtime map. The next `refresh()` rebuilds from scratch against the new baseline.

## setMode(mode)

Sets the active mode. Does not trigger a refresh; the controller sends the updated `state()` immediately after.

## checkpointChangedPaths()

Returns all paths currently in the checkpoint-mode cache. Used by the controller to record which paths were marked reviewed at submission time.
