# Types

`src/types.ts` defines all shared TypeScript types for the extension. These types form the contract between the host (Node.js) and the web UI (browser), and between the controller and the git/workspace layers.

## Review mode

Discriminant for the two diff baselines the extension supports.

```ts
type ReviewMode = "checkpoint" | "head";
```

- `"checkpoint"` — Since-review mode: diff against the last checkpoint (or initial HEAD).
- `"head"` — vs-HEAD mode: diff against the current Git HEAD.

## Change status

```ts
type ChangeStatus = "modified" | "added" | "deleted";
```

Inferred by comparing original and modified content: `null` original → added, `null` modified → deleted, both present → modified.

## ChangedFile

A lightweight file descriptor sent to the UI in `WorkspaceState`. Does not include file content.

| Field | Type | Purpose |
|-------|------|---------|
| `path` | `string` | Repo-relative path |
| `status` | `ChangeStatus` | Added/modified/deleted |
| `fingerprint` | `string` | SHA-256 of current content (or `"deleted"`) |
| `recentAt?` | `number` | Filesystem mtime in ms; used for Recently Changed ordering |

## WorkspaceState

The full state snapshot sent to the window on every refresh and mode change.

| Field | Type | Purpose |
|-------|------|---------|
| `repoRoot` | `string` | Absolute repo root |
| `repoName` | `string` | `basename(repoRoot)` |
| `branch` | `string \| null` | Current branch name |
| `mode` | `ReviewMode` | Active diff mode |
| `hasCheckpoint` | `boolean` | Whether a checkpoint exists |
| `checkpointCreatedAt?` | `number` | Timestamp of the last checkpoint |
| `files` | `ChangedFile[]` | Files changed in the active mode |
| `pendingFiles` | `ChangedFile[]` | Files changed in checkpoint mode (always, regardless of active mode) |
| `recentPaths` | `string[]` | Active mode paths sorted by mtime descending |

## FileContents

Full file content pair returned when the UI requests a specific file.

| Field | Type | Purpose |
|-------|------|---------|
| `path` | `string` | Repo-relative path |
| `mode` | `ReviewMode` | Mode this content was resolved for |
| `fingerprint` | `string` | SHA-256 of modified content |
| `originalContent` | `string` | Left-pane content (checkpoint baseline or HEAD) |
| `modifiedContent` | `string` | Right-pane content (current on-disk) |

## ReviewComment

A single review comment authored in the UI.

| Field | Type | Purpose |
|-------|------|---------|
| `path` | `string` | File the comment belongs to |
| `mode?` | `ReviewMode` | Mode active when the comment was created |
| `side` | `"original" \| "modified" \| "file"` | Which pane, or file-level note |
| `line` | `number \| null` | Line number (`null` for file-level notes) |
| `body` | `string` | Comment text |

## StoredFile

Serialized file state inside a checkpoint's `overrides` map.

- `StoredFilePresent`: `{ state: "present", fingerprint, encoding: "gzip+base64", content }` — gzip+base64 encoded content.
- `StoredFileDeleted`: `{ state: "deleted" }` — file did not exist at checkpoint time.

## ReviewCheckpoint

The persistent checkpoint record stored as a pi session custom entry.

| Field | Type | Purpose |
|-------|------|---------|
| `version` | `1` | Schema version (always `1`) |
| `id` | `string` | UUID |
| `repoRoot` | `string` | Repo root at checkpoint time |
| `createdAt` | `number` | Timestamp ms |
| `headSha` | `string \| null` | HEAD at checkpoint time |
| `overrides` | `Record<string, StoredFile>` | Snapshot of all dirty files at checkpoint time |
| `reviewedPaths` | `string[]` | Paths marked reviewed |
| `feedback` | `string` | Composed feedback text |

## WindowMessage (UI → host)

Messages sent from the Glimpse window to the Node.js host via `window.glimpse.send()`.

| Type | Payload | Purpose |
|------|---------|---------|
| `ready` | — | Window loaded; requests initial state |
| `set-mode` | `mode: ReviewMode` | User switched diff mode |
| `request-file` | `path, mode, requestId` | UI requests full file content |
| `submit-review` | `comments: ReviewComment[]` | User submitted the review |
| `close` | — | User clicked the in-window close button |

## HostMessage (host → UI)

Messages sent from the host to the window via `window.__reviewReceive()`.

| Type | Payload | Purpose |
|------|---------|---------|
| `workspace` | `state: WorkspaceState` | Updated workspace state |
| `file` | `requestId, file: FileContents` | Requested file content |
| `file-error` | `requestId, message` | File request failed |
| `review-submitted` | `checkpointAt, insertedFeedback` | Checkpoint saved confirmation |
