# Command Collision

Documents the `/diff-review` name clash between this extension and the visual-explainer plugin, why `/diff-review` once generated an HTML page instead of opening the review window, and how the naming is made collision-proof.

## Root cause

The extension was **installed but failed to load**, so its `/diff-review` command was never registered and the bare name fell through to visual-explainer's prompt template of the same name. This is reproducible in any session, not specific to DVAS-SPH.

The trigger is a missing-dependency load failure, not a missing install:

- `src/index.ts:2` imports `./controller.js`, and `src/controller.ts:2`/`:4` import `chokidar` and `glimpseui` at the top level.
- When those packages are not installed (no `node_modules` — `npm install` never run in the repo), the module import throws `ERR_MODULE_NOT_FOUND`.
- pi's loader catches the throw (`~/git-hub/pi-mono` `loader.ts:476-479`) and returns `{ extension: null, error: "Failed to load extension: …" }`, so the `reviewLoop` factory never runs and `registerCommand("diff-review")` never executes.
- The failure is surfaced only as a quiet diagnostic (`interactive-mode.ts:1574-1577`), easy to miss — the user sees no blocking error.
- With no extension command registered, `getCommand("diff-review")` returns `undefined` and `/diff-review` falls through to the prompt template.

The name clash is what makes the fallthrough silently do the **wrong thing** (generate an HTML page) instead of reporting an unknown command:

- This extension registers an **extension command**: `pi.registerCommand("diff-review", ...)` ([[extension]]).
- visual-explainer ships a **prompt template** `commands/diff-review.md` with frontmatter `name: diff-review`.
- pi dispatches extension commands **before** prompt templates, so when this extension loads cleanly its command shadows the template and the window opens; when it fails to load (or is absent), the template expands and an HTML page is generated.

## Resolution mechanism in pi

pi tries `_tryExecuteExtensionCommand` first and only expands prompt templates if no extension command matched. The `:1`/`:2` renaming applies only within the extension-command pool, so it never fires between this command and a prompt template.

Key facts (verified against `~/git-hub/pi-mono`):

- `agent-session.ts:1110` dispatches extension commands first; `agent-session.ts:1143` expands prompt templates second.
- `runner.ts:595-628` renames duplicate **extension commands** to `name:1`/`name:2`; `getCommand` (`runner.ts:644`) matches `invocationName` exactly.
- `expandPromptTemplate` (`prompt-templates.ts:269`) matches the first template by bare name and substitutes `$@`.
- No diagnostic exists for an extension-command-vs-prompt-template name clash; the shadowing is silent.

## Correction

The primary fix is a code-level change in this repo that prevents the whole silent-fallthrough class, not just this one incident.

### 1. Lazy runtime imports (implemented)

`glimpseui` and `chokidar` are imported **dynamically inside the methods that use them** (`openOrShow` / `startWatcher`), never at the top level of `src/controller.ts`. Only `import type` remains at the top (erased at compile).

- The module graph then has **zero third-party runtime top-level dependencies**, so `src/index.ts` always loads and `reviewLoop` always runs `registerCommand("diff-review")`.
- Once the command is registered, pi claims `/diff-review`. `_tryExecuteExtensionCommand` returns `true` even when the handler throws (`agent-session.ts`), so pi **never** falls through to visual-explainer's template.
- A missing dep now surfaces at **invocation** time: the handler's `try/catch` in `src/index.ts` calls `ctx.ui.notify("Could not open Review Loop: …", "error")` with the real cause.
- Verified with pi's own loader (jiti): with `glimpseui`+`chokidar` absent, the module loads and registers `["diff-review"]`.

### 2. Install dependencies (operational, immediate)

Run `npm install` in the extension repo (or wherever pi resolves it) so the window can actually open. This fixes the trigger; the lazy imports fix the class.

### 3. Optional: collision-proof alias

Register a unique canonical `/review-loop` alongside `/diff-review` (same handler).

`registerCommand` is a name-keyed map (`loader.ts:254`), so two names for one handler is valid. With fix #1 the alias is no longer required to avoid the fallthrough, but it gives this extension a unique name that can never clash with visual-explainer.
