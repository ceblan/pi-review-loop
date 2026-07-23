# Tests

Test suite in `test/core.test.ts` using Node.js built-in `node:test` runner. Tests exercise the git layer, feedback composition, web bundle integrity, and the full checkpoint→delta cycle against a real temporary Git repository.

## Test helper: fakePi

Creates a minimal `ExtensionAPI` stub that delegates `exec` to `execFileAsync`. Returns `{ code, stdout, stderr, killed }` matching pi's exec result shape. Non-zero exit codes are captured from the thrown error's `code` property.

## Porcelain parsing

Tests for `parsePorcelainPaths` covering standard, rename, and untracked entries.

### parses porcelain paths including renames

Verifies `parsePorcelainPaths` handles:

- Standard modified entries (` M src/a.ts`).
- Rename entries (`R  src/new.ts` followed by `src/old.ts` as the next NUL field) — both old and new paths are included.
- Untracked entries (`?? new file.ts`) — paths with spaces are preserved.
- Deduplication via `Set`.

## Feedback composition

Tests for `composeFeedback` output format and location labels.

### formats compact actionable feedback

Verifies `composeFeedback` output for two comments:

1. A line comment on the modified pane → `src/a.ts:12 (current)`.
2. A file-level note with a multi-line body → `README.md` with indented continuation lines.

Asserts the exact output string including the header, numbering, and indentation.

## Web bundle integrity

Validates the esbuild-produced `web/dist/index.html` is complete and parseable.

### bundled webview is self-contained and syntactically valid

Reads `web/dist/index.html` and asserts:

1. No unresolved `__PLACEHOLDER__` tokens remain (`/__[A-Z_]+__/` must not match).
2. The app bundle is present as `(0, eval)(atob("..."))`.
3. The worker bundle is present as `__reviewWorkerSource = atob("...")`.
4. Both base64-decoded bundles parse as valid JavaScript via `new Function(...)`.

## Checkpoint and delta cycle

End-to-end integration test exercising checkpoint creation, override decoding, and incremental delta scanning against a real temporary Git repo.

### checkpoint stores dirty state and produces only the next delta

End-to-end integration test against a real temporary Git repo:

1. **Setup**: Creates a temp repo with `app.ts` (committed) and `clean.ts` (committed).
2. **Dirty state**: Modifies `app.ts`, creates untracked `untracked.ts`.
3. **Checkpoint**: Calls `createCheckpoint` with both paths.
4. **Override verification**: Asserts `decodeStored` returns the exact dirty content for both files.
5. **Zero delta**: `scanAgainstCheckpoint` immediately after checkpoint returns `[]` (nothing changed since the snapshot).
6. **HEAD mode**: Creates a `WorkspaceModel` with the checkpoint, refreshes, switches to `"head"` mode. Asserts `pendingFiles` is empty (checkpoint mode has no changes), `recentPaths` contains both files, and all files have numeric `recentAt`.
7. **New changes**: Modifies `app.ts` again, modifies `clean.ts`, modifies `untracked.ts`.
8. **Delta scan**: `scanAgainstCheckpoint` returns exactly `["app.ts", "clean.ts", "untracked.ts"]`.
9. **Original content**: Asserts the `originalContent` for each file matches the checkpoint snapshot (not HEAD), proving the override mechanism works correctly even for files that were clean at checkpoint time (`clean.ts` falls back to HEAD via `readRevision`).
10. **Disk integrity**: Asserts the on-disk file still contains the latest content (scanning is non-destructive).
11. **Cleanup**: Removes the temp directory.
