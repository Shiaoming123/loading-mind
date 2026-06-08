# Project Update Rules

These rules keep Loading Mind changes reviewable, reproducible, and easy to roll forward.

## Update Scope

- Keep changes surgical. A commit should describe one coherent product or engineering update.
- Do not mix runtime behavior changes, visual redesigns, dependency upgrades, and documentation-only edits unless they are required for the same outcome.
- If a change touches tool failure behavior, graph rendering, or report generation, include tests that can fail when that behavior regresses.

## Branches And Commits

- Use `main` for the published public baseline.
- Use short feature branches for future work, preferably `codex/<change-name>` for agent-authored updates.
- Commit messages should be imperative and specific, for example `Harden tool failure propagation`.
- Do not commit generated output such as `dist/`, `.agent-runs/`, `.codegraph/`, `.playwright-cli/`, or `node_modules/`.

## Required Verification

Run these before pushing a code change:

```bash
npm test
npm run build
```

For visual or interaction changes, also check the app manually in a browser at desktop and mobile widths. At minimum use:

- Desktop: `1280x720`
- Mobile: `390x844`

## Changelog

- Update `CHANGELOG.md` for user-visible behavior, runtime rules, interface changes, and release-worthy fixes.
- Keep entries grouped by date or version.
- Each entry should explain what changed and why it matters, not just list files.

## Runtime Change Policy

- Critical tool failures must be surfaced through graph nodes and `run_failed` events.
- Degraded execution must be explicit in the graph and in event text.
- Normal reports must not be generated from failed tools that produced no usable observations.
- New runtime rules should have helper tests or reducer tests.

## Deployment Change Policy

- Vercel-facing API changes should keep `POST /api/runs` serverless-compatible: no required long-lived memory, background workers, or persistent SSE connection.
- If snapshot delivery changes, update the frontend replay path, `README.md`, and a runtime smoke test together.
- Tool orchestration changes should keep registered runner metadata visible through diagnostics so HTTP, local, provider, and future MCP adapters can be inspected.

## UI Change Policy

- The canvas is the primary product surface. Center readouts, panels, and controls must not obscure core process nodes at common desktop widths.
- Failed, running, observed, synthesized, and written states must remain visually distinguishable without relying only on text.
- Mobile layouts should keep document-flow behavior unless the change explicitly targets mobile.

## Release Checklist

1. Confirm `git status` only includes intended source and documentation changes.
2. Run `npm test`.
3. Run `npm run build`.
4. Update `CHANGELOG.md` when behavior changed.
5. Push to GitHub.
6. Confirm the public repository README renders correctly.
