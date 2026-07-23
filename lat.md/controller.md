# ReviewController

`ReviewController` in `src/controller.ts` owns the Glimpse window, chokidar watcher, `WorkspaceModel`, and all host↔window message routing. One instance exists at a time.

It is created lazily by the [[extension]] entry point and destroyed on window close or session shutdown.

## Lazy dependency imports

`glimpseui` and `chokidar` are imported with `await import(...)` inside `openOrShow` and `startWatcher`, not at the top of the module (only `import type` sits at the top).

This keeps the module loadable when those runtime deps are missing, so `registerCommand("diff-review")` always runs and `/diff-review` never silently falls through to another extension's same-named command. A missing dep surfaces as a clear error at invocation instead. See [[command-collision]].

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
3. Calls `model.refresh()` to populate initial file pairs.
4. Starts the chokidar watcher (`startWatcher`).
5. Opens the Glimpse window with the bundled HTML (`loadReviewHtml()`), size 1480×920.
6. Wires `message`, `closed`, and `error` event handlers.

## File watcher

`startWatcher()` creates a chokidar watcher on `repoRoot` with:

- `ignoreInitial: true` — no event storm on startup.
- Ignores `.git/` and `node_modules/` subtrees.

Every `all` event calls `scheduleRefresh()`, which debounces at 100ms then enqueues an async task that calls `model.refresh()` and sends the updated `WorkspaceState` to the window.

The `enqueue` method serializes all async operations through a promise chain, preventing concurrent refresh/submit races.

## Message handling

`handleMessage(message: WindowMessage, ctx)` dispatches on `message.type`:

| Type | Action |
|------|--------|
| `ready` | Sends current `WorkspaceState` to the window (initial sync) |
| `set-mode` | Calls `model.setMode()`, sends updated state |
| `request-file` | Calls `model.getFile()`, sends `FileContents` or `file-error` |
| `submit-review` | Runs the full checkpoint submission flow (see below) |

The `submitting` flag prevents concurrent submissions.

## Checkpoint submission flow

On `submit-review`:

1. `composeFeedback(message.comments)` produces the feedback string.
2. `model.checkpointChangedPaths()` returns all paths changed since the last checkpoint.
3. `createCheckpoint(pi, repoRoot, reviewedPaths, feedback)` snapshots all dirty files.
4. `pi.appendEntry(CHECKPOINT_ENTRY, checkpoint)` persists the checkpoint to the active session branch.
5. `model.setCheckpoint(checkpoint)` updates the model; the next refresh shows only new changes.
6. If feedback is non-empty, `ctx.ui.pasteToEditor(feedback)` inserts it into pi's editor. Feedback is **not auto-sent**; the user inspects/edits it before submitting to the agent.
7. Sends `review-submitted` to the window and a notification to pi.

## Window communication

`send(message: HostMessage)` serializes the message to JSON, escapes `<`, `>`, `&` for safe inline injection, and calls `window.send("window.__reviewReceive(...)")`. The Glimpse window exposes `window.__reviewReceive` as the receive callback.

## disposeWindow

Called on `closed` or `error` events. Nulls the window reference, clears the refresh timer, closes the watcher, and calls `onClosed()`. Guards against stale window references with an identity check.

## close()

Public async method called on session shutdown. Clears the refresh timer, closes the watcher, and closes the window. Does not call `onClosed` (the entry point handles its own nulling).
