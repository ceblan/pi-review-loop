# Web UI

The web frontend in `web/src/` is bundled by esbuild into a self-contained `web/dist/index.html` loaded by Glimpse. No external network requests are made at runtime.

## Bundle structure

`build-web.mjs` produces three artifacts embedded in `index.html`:

1. **App bundle** — `web/src/app.ts` + Monaco editor, base64-encoded and evaluated via `(0, eval)(atob(...))`.
2. **Worker bundle** — Monaco's `editor.worker.js`, stored in `window.__reviewWorkerSource` as base64 and instantiated via `Blob` URL.
3. **CSS** — `web/src/styles.css` inlined in a `<style>` tag.

The test suite validates that both bundles are syntactically valid JavaScript and that no unresolved `__PLACEHOLDER__` tokens remain.

## Bundle loading

The host loads the bundle via `file://`, never by passing the HTML string to `open()`.

Passing the string would base64-encode it into a `data:text/html;base64` URL, and the 4.4 MB bundle (~6 MB as a data URL) is too large for Chrome to navigate to — the page never loads and the window stays blank white. Instead the controller opens an empty window and calls `window.loadFile(getReviewHtmlPath())` on `ready`, which sends the `file` message to the Glimpse backend, navigating it to `file://…/web/dist/index.html`. `file://` has no such size limit, and the bundle renders fully (verified: all sidebar/editor elements present in the DOM). The backend is the native WebKitGTK binary on Linux (see [[architecture#Architecture#Key dependencies]]); the Chromium-CDP path (`chromium-backend.mjs`) is only a zero-compile fallback used when the native binary is absent, and was the source of the EPIPE trace on close. The path is resolved from `import.meta.url` via `fileURLToPath`, so it works from the installed package too.

## Monaco diff editor

A `monaco.editor.createDiffEditor` instance with:

- Read-only, side-by-side mode.
- Custom `review-loop` theme (dark, Tokyo Night-inspired palette).
- Minimap with proportional slider, overview ruler with 3 lanes.
- Glyph margin enabled for inline comment indicators.
- Language detection via file extension (`inferLanguage`): TypeScript, JavaScript, JSON, CSS, HTML, Markdown, Python, Rust, Go, Java, Kotlin, Shell, YAML.

## Sidebar

Two sections, both following the active diff mode:

### Recently Changed

Flat list ordered by filesystem mtime (most recent first). Each row shows:

- Status letter (M/A/D) with color coding.
- File basename + parent directory.
- Relative time label (e.g., "3m", "2h"), refreshed every 10 seconds.
- Comment count badge (if comments exist for that file).
- In vs-HEAD mode: green ✓ for files matching the last checkpoint, blue dot for pending files.

### Files

Directory tree view of the same mode's files. Directories are collapsible (chevron toggle, state persisted in `collapsedDirs` set). Files show the same status letter, comment badge, and pending/reviewed indicators.

### File filter

`Ctrl+K` / `Cmd+K` focuses the search input. Filters both sidebar sections by path substring match (case-insensitive).

## Inline comments

Line-level and file-level review comments rendered inside the Monaco diff editor.

### Adding comments

Hovering a line number in either pane reveals a `+` glyph (via `review-glyph-plus` decoration). Clicking it creates an inline comment:

- A Monaco **view zone** (128px tall) is inserted after the target line.
- The zone contains a textarea for the comment body.
- The comment is tagged with `side` (`"original"` or `"modified"`), `line`, `path`, and the active `mode`.
- If a comment already exists for that side+line, the existing textarea is focused instead.

### Comment decorations

Lines with comments get:

- `review-comment-line` — whole-line background highlight.
- `review-comment-glyph` — glyph margin indicator.

Applied via `deltaDecorations` on the appropriate editor (original or modified).

### File-level notes

The "Add file note" button opens a draft panel below the editor for comments not tied to a specific line (`side: "file"`, `line: null`). `Ctrl+Enter` / `Cmd+Enter` submits the draft; `Escape` cancels.

### Comment lifecycle

How comments are stored, updated, deleted, and cleared across the review session.

- Comments are stored in a flat `UiComment[]` array (extends `ReviewComment` with a unique `id`).
- Deleting a comment removes it from the array, re-renders decorations and view zones, and updates sidebar badges.
- On `review-submitted`, all comments are cleared.

## Scroll position memory

Scroll positions (top + left for both panes) are saved per `mode:path` key in a `Map<string, ScrollPosition>`. Saved on:

- File switch (`saveMountedScroll` before mounting new file).
- Workspace state update (before re-render).
- Model disposal.

Restored after mounting a file via `requestAnimationFrame` + 30ms `setTimeout` (to account for Monaco layout settling). First-time opens start at top-left (0,0).

## Fingerprint-based remounting

Each `FileContents` carries a SHA-256 `fingerprint`. The UI skips re-requesting a file when the fingerprint is unchanged.

When a workspace update arrives with a different fingerprint for the active file, `mountedFingerprint` is reset to force a fresh `request-file`.

## Mode switching

Clicking "Since review" or "vs HEAD" sends `{ type: "set-mode", mode }` to the host. The host updates the model and sends back a full `WorkspaceState`. The UI preserves scroll positions across mode switches via the `mode:path` keying.

## Submit flow

The sequence of UI and host actions when the user clicks the submit button.

1. User clicks the submit button (disabled when no pending files and no comments).
2. Button shows "Saving…" and disables.
3. `{ type: "submit-review", comments }` sent to host.
4. On `review-submitted` response: comments cleared, toast shown, sidebar re-rendered.
5. A 5-second timeout re-enables the button as a safety net.

## Ready handshake

On load, the UI sends `{ type: "ready" }` immediately and retries every 250ms until a `workspace` message arrives (clears the interval on receipt). This handles the race where the window loads before the host has wired the message handler.
