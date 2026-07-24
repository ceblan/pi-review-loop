# ReviewController

`ReviewController` in `src/controller.ts` owns the Glimpse window, the polling working-tree watcher, the `WorkspaceModel`, and all host↔window message routing. One instance exists at a time.

It is created lazily by the [[extension]] entry point and destroyed on window close or session shutdown.

## Lazy dependency imports

`glimpseui` is imported with `await import(...)` inside `openOrShow`, not at the top of the module (only `import type` sits at the top).

This keeps the module loadable when the runtime dep is missing, so `registerCommand("diff-review")` always runs and `/diff-review` never silently falls through to another extension's same-named command. A missing dep surfaces as a clear error at invocation instead. See [[command-collision]].

The previous `chokidar` dynamic import was removed when the recursive watcher was replaced by polling (see [[controller#Working-tree polling]]).

## Construction

Creates a controller bound to the pi API and a close callback.

```ts
new ReviewController(pi: ExtensionAPI, onClosed: () => void)
```

- `pi` — the pi extension API, used for `exec`, `appendEntry`, and UI notifications.
- `onClosed` — called once when the window is disposed; the entry point uses it to null its controller reference.

## openOrShow(ctx)

Idempotent open. If the window already exists, calls `window.show()` and notifies. Otherwise:

1. Resolves the Git repo root via `getRepoRoot(pi, ctx.cwd)`.
2. Creates a `WorkspaceModel` with the latest checkpoint found on the active session branch (`latestCheckpoint`).
3. Calls `model.refresh()` to populate initial file pairs and captures the initial `workspaceSignature` so the first poll tick does not redundantly re-refresh.
4. Starts the polling watcher (`startPolling`).
5. Opens an empty Glimpse window (1480×920) and, on its `ready` event, calls `window.loadFile(getReviewHtmlPath())` to navigate the backend to `file://…/web/dist/index.html`.
6. Wires `message`, `closed`, and `error` event handlers.
7. Pushes the initial `WorkspaceState` immediately so the window does not have to wait for the first poll tick.

## Working-tree polling

`startPolling()` replaces the previous recursive chokidar watcher with a `setInterval` every `POLL_INTERVAL_MS` (2 s).

It calls `workspaceSignature(pi, repoRoot)` and, only when the signature changed, enqueues a `model.refresh()` + `send({ type: "workspace", state })`. The `enqueue` method serializes all async operations (polls, message handlers, submissions) through a promise chain, preventing concurrent refresh/submit races.

`workspaceSignature` combines HEAD SHA + branch name + the full `git status --porcelain=v1 -z --untracked-files=normal` output. Git honors the entire exclude chain (`.gitignore`, `.git/info/exclude`, `core.excludesFile`) for that command, so heavy directories (vendor/, build/, pg_data, …) never appear in the signature and the poll stays cheap even in 225k-file repos. The recursive chokidar watcher previously traversed the whole tree and exhausted inotify on large worktrees; the poll never traverses — git does, with its index cache.

Trade-off: `--untracked-files=normal` collapses an untracked directory to a single `dir/` entry, so adding a file *inside an already-untracked* directory does not change the signature and will not trigger a refresh until something else does. New files at the top level or inside tracked directories are detected normally. This is acceptable for a review tool watching agent edits.

## Message handling

`handleMessage(message: WindowMessage, ctx)` dispatches on `message.type`:

| Type | Action |
|------|--------|
| `ready` | Sends current `WorkspaceState` to the window (initial sync) |
| `set-mode` | Calls `model.setMode()`, sends updated state |
| `request-file` | `await`s `model.getFile()` (now async — contents are read lazily), sends `FileContents` or `file-error` |
| `submit-review` | Runs the full checkpoint submission flow (see below) |
| `close` | Calls `window.close()` (handled before the `model` null-guard); the backend emits `Closed` and exits, firing `disposeWindow` |

The `submitting` flag prevents concurrent submissions.

## Checkpoint submission flow

On `submit-review`:

1. `composeFeedback(message.comments)` produces the feedback string.
2. `model.checkpointChangedPaths()` returns all paths changed since the last checkpoint.
3. `createCheckpoint(pi, repoRoot, reviewedPaths, feedback)` snapshots dirty files (skipping those above [[src/git.ts#MAX_FILE_BYTES]] to keep the session entry bounded).
4. `pi.appendEntry(CHECKPOINT_ENTRY, checkpoint)` persists the checkpoint to the active session branch.
5. `model.setCheckpoint(checkpoint)` updates the model; the next refresh shows only new changes.
6. If feedback is non-empty, `ctx.ui.pasteToEditor(feedback)` inserts it into pi's editor. Feedback is **not auto-sent**; the user inspects/edits it before submitting to the agent.
7. Sends `review-submitted` to the window and a notification to pi.

## Window communication

`send(message: HostMessage)` serializes the message to JSON, escapes `<`, `>`, `&` for safe inline injection, and calls `window.send("window.__reviewReceive(...)")`. The Glimpse window exposes `window.__reviewReceive` as the receive callback.

Payloads larger than `MAX_SEND_BYTES` (4 MiB) are dropped instead of sent, to avoid crashing the WebKit web process with a giant JS eval. In practice contents are bounded by [[src/git.ts#MAX_FILE_BYTES]] and the candidate cap, so this is a safety net.

## disposeWindow

Called on `closed` or `error` events. Nulls the window reference, stops the poll timer, and calls `onClosed()`. Guards against stale window references with an identity check.

## close()

Public async method called on session shutdown. Stops the poll timer and closes the window. Does not call `onClosed` (the entry point handles its own nulling).
