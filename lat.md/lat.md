# pi-review-loop

A persistent, incremental diff review extension for [pi](https://pi.dev). Keeps a native review window open while the agent works, enabling human reviewers to inspect changes, leave inline comments, and checkpoint progress without interrupting the agent.

## Sections

All documentation sections for this extension.

- [[architecture]] — system overview, data flow, and component relationships
- [[extension]] — entry point, command registration, and lifecycle hooks
- [[controller]] — ReviewController: window management, file watcher, message dispatch, checkpoint submission
- [[workspace]] — WorkspaceModel: dual-mode workspace state, refresh cycle, file access
- [[git]] — Git layer: repo introspection, porcelain parsing, checkpoint creation, file scanning
- [[prompt]] — feedback composition from review comments
- [[types]] — all TypeScript types, interfaces, and message protocols
- [[web-ui]] — Monaco-based diff viewer, sidebar, inline comments, scroll persistence
- [[tests]] — test specifications and coverage
- [[command-collision]] — the `/diff-review` name clash with visual-explainer and the collision-proof naming fix
