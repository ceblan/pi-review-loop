# Architecture

pi-review-loop is a pi extension that opens a persistent native Glimpse window with a Monaco diff editor, watches the Git working tree, and checkpoints review progress as pi session entries.

It has five layers: an [[extension]] entry point, a [[controller]], a [[workspace]] model, a [[git]] layer, and a [[web-ui]].

## Component overview

The extension has five layers:

| Layer | File | Responsibility |
|-------|------|----------------|
| Entry point | [[extension]] | Registers `/diff-review` command, manages controller singleton, handles session shutdown |
| Controller | [[controller]] | Owns the Glimpse window, working-tree polling watcher, message routing, and checkpoint submission |
| Workspace model | [[workspace]] | Maintains dual-mode (checkpoint / HEAD) file-pair state, exposes `WorkspaceState` |
| Git layer | [[git]] | All Git subprocess calls, porcelain parsing, checkpoint creation, file content reads |
| Web UI | [[web-ui]] | Monaco diff editor, sidebar file lists, inline comment system, scroll memory |

## Data flow

The sequence of messages between user, host, and window for the three main interactions.

```
User runs /diff-review
  → ReviewController.openOrShow()
    → WorkspaceModel.create() + refresh() + initial workspaceSignature
    → startPolling() (2s interval, git-status based)
    → Glimpse window opens with bundled HTML
    → initial WorkspaceState pushed immediately

Poll tick (every 2s)
  → workspaceSignature() (HEAD + branch + git status, excludes honored)
  → if signature changed: WorkspaceModel.refresh()
  → HostMessage { type: "workspace", state } sent to window

User selects a file in the sidebar
  → WindowMessage { type: "request-file" }
  → await WorkspaceModel.getFile()  (lazy content read, capped)
  → HostMessage { type: "file", file } sent to window

User clicks Submit
  → WindowMessage { type: "submit-review", comments }
  → composeFeedback() → feedback string
  → createCheckpoint() → ReviewCheckpoint (large files skipped)
  → pi.appendEntry() persists checkpoint to session
  → ctx.ui.pasteToEditor(feedback) inserts into pi editor
  → HostMessage { type: "review-submitted" } sent to window
```

## Diff modes

Two modes control what "original" content means:

- **Since review** (`checkpoint`): original = last checkpoint content (or HEAD if no checkpoint yet). Shows only changes since the last review.
- **vs HEAD** (`head`): original = current Git HEAD. Shows the full working-tree diff including already-reviewed changes.

Switching modes does not alter the checkpoint. Submitting always checkpoints the current workspace regardless of active mode.

## Session persistence

Checkpoints are `review-loop/checkpoint` custom entries in the active pi session branch. On resume, the latest checkpoint on the active branch is restored; session branching also branches review state.

Custom entries do not participate in model context.

## Key dependencies

External packages the extension relies on at runtime.

- `glimpseui` — native window (WebView) with bidirectional JS messaging. On Linux the native WebKitGTK backend is primary: it needs the `webkitgtk-6.0` system package and a built binary at `node_modules/glimpseui/src/glimpse` (produced by `npm run build:linux`, which requires `CARGO_NET_GIT_FETCH_WITH_CLI=true` for its git submodule fetch). Without that binary, Glimpse auto-falls back to a Chromium-CDP backend (`chromium-backend.mjs`) that spawns a system Chromium. The native backend normally opens as a gtk4-layer-shell `Overlay` surface, which Hyprland cannot tile and renders with no window chrome; `scripts/patch-glimpseui.mjs` (run via the `postinstall` hook) patches `main.rs` to open as a normal GTK toplevel so the compositor tiles it next to the focused window (the kitty running pi). The patch is idempotent and best-effort (logs and skips if the source context changed, leaving the Chromium fallback intact).
- `monaco-editor` — diff editor in the bundled web UI (esbuild-bundled, self-contained HTML)

No filesystem-watcher dependency: the working tree is observed by polling `git status` (see [[controller#Working-tree polling]]), which honors the full git exclude chain and avoids the inotify exhaustion / heap blowup that the previous recursive `chokidar` watcher caused in large repos (225k+ files, 35k+ directories).
