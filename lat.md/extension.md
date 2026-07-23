# Extension Entry Point

The default export `reviewLoop(pi: ExtensionAPI)` in `src/index.ts` is the pi extension entry point declared in `package.json` under `pi.extensions`. It registers the `/diff-review` command and wires the session shutdown hook.

## Command registration

`pi.registerCommand("diff-review", ...)` registers the slash command. The handler:

1. Checks `ctx.mode === "tui"` — refuses to run outside interactive TUI mode with a warning notification.
2. Lazily creates a `ReviewController` singleton via `getController()`.
3. Calls `controller.openOrShow(ctx)`.
4. On error, nulls the controller reference and shows an error notification.

Running `/diff-review` while the window is already open brings the existing window forward and shows an info notification; it does not create a second window.

## Controller lifecycle

The controller reference is held in a closure variable. It is set to `null` in two cases:

- `onClosed` callback passed to `ReviewController` constructor — fires when the Glimpse window is closed by the user or an error.
- `session_shutdown` event — fires when pi shuts down, switches sessions, or reloads extensions. Calls `controller.close()` to stop the watcher and close the window.

After nulling, the next `/diff-review` invocation creates a fresh controller.

## Session shutdown hook

```ts
pi.on("session_shutdown", async () => {
  const active = controller;
  controller = null;
  await active?.close();
});
```

The local `active` capture prevents a race where a new controller is created between the null assignment and the `close()` call.
