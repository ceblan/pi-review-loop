# Feedback Composition

`composeFeedback` in `src/prompt.ts` transforms an array of `ReviewComment` objects into a plain-text feedback string that is inserted into pi's editor for the user to review and submit to the agent.

## Algorithm

Filters, formats, and assembles the final feedback string.

1. Filters out comments with empty or whitespace-only `body`.
2. If no valid comments remain, returns `""` (no feedback inserted).
3. Builds a numbered list with a header line.

## Location formatting

The `location(comment)` helper produces the location prefix for each comment:

| Condition | Output |
|-----------|--------|
| `side === "file"` or `line == null` | `path` (file-level note) |
| `side === "original"`, `mode === "head"` | `path:line (HEAD)` |
| `side === "original"`, `mode === "checkpoint"` | `path:line (reviewed)` |
| `side === "modified"` | `path:line (current)` |

The suffix disambiguates which pane the comment refers to:

- **(HEAD)** — the left pane in vs-HEAD mode (content at Git HEAD).
- **(reviewed)** — the left pane in Since-review mode (content at the last checkpoint).
- **(current)** — the right pane (on-disk content).

## Output format

```
Please address the following review feedback:

1. src/a.ts:12 (current)
   Handle the empty case.

2. README.md
   Clarify setup.
   Add an example.
```

Multi-line comment bodies are indented with three spaces on continuation lines. The final string is trimmed.

## Design intent

Feedback is **not sent automatically** to the agent. It is pasted into pi's editor via `ctx.ui.pasteToEditor()`, allowing the user to inspect, edit, or discard it before submitting. This keeps the human in the loop.
