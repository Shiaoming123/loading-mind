# Loading Mind

Loading Mind is a runnable Agent Process OS prototype for long-running AI research tasks. It turns waiting time into an observable work surface: tool calls, observations, evidence, claims, and report sections are streamed into a live process graph while the run is still happening.

The product is no longer a prerecorded loading demo. A user submits a research question, the local Agent runtime creates a run, streams live events over SSE, calls limited real tools, grows a knowledge graph, and writes a final report whose sections map back to source nodes. Tool failure is also first-class: failed calls remain visible in the graph and stop or degrade the run according to explicit runtime rules.

## What It Does

- Runs a local Agent runtime through Vite middleware.
- Streams run events over Server-Sent Events.
- Visualizes task intent, ontology, tool calls, observations, evidence, claims, and report sections as a force-directed canvas.
- Exposes tool I/O, source refs, episodes, attributes, and report mapping through a node inspector.
- Fails loudly when critical tools fail instead of silently synthesizing from empty results.
- Persists local run events under `.agent-runs/` for inspection while keeping them out of git.

## Tech Stack

- React 18
- Vite
- TypeScript
- D3 force simulation
- Framer Motion
- Vitest
- Local Node/Vite middleware for the runtime API

## Run

```bash
npm install
npm run dev
```

Open the local Vite URL shown in the terminal.

The Vite dev server also mounts the local runtime API:

- `POST /api/runs` creates an Agent run.
- `GET /api/runs/:runId/events` streams Agent events with SSE.
- `POST /api/runs/:runId/pause` pauses the run.
- `POST /api/runs/:runId/resume` resumes the run.
- `POST /api/runs/:runId/cancel` cancels the run.
- `POST /api/runs/:runId/retry` appends a visible retry node for a failed tool.
- `POST /api/runs/:runId/exclude` marks an evidence node as excluded.

Recorded run events are persisted under `.agent-runs/` and ignored by git.

## Vercel Demo Deployment

The app can run as a public Vercel demo without long-lived server memory. In production, `POST /api/runs` returns a completed run snapshot with replayable events, and the frontend replays those events locally. This keeps the demo compatible with serverless functions while preserving the visible Agent process.

Vercel endpoints:

- `POST /api/runs` creates and completes a serverless snapshot run.
- `GET /api/diagnostics` reports delivery mode, registered tool runners, and basic network probes.

Useful environment variables:

- `LOADING_MIND_PROVIDER_API_KEY`, `MIMO_API_KEY`, or `OPENAI_API_KEY` supplies the provider key server-side.
- `LOADING_MIND_DEMO_MODE=1` allows demo fallback observations when external tools are unavailable.
- `LOADING_MIND_FORCE_DEMO_TOOLS=1` forces built-in demo tool outputs for public trial stability.

Local development still uses the Vite middleware and SSE runtime so pause, resume, cancel, retry, and exclude interactions remain available while iterating.

## Demo Script

1. Enter a real research question and start the run.
2. Watch the graph grow from task intent to ontology, tool calls, evidence, claims, and report sections.
3. Click a node to inspect summary, attributes, episodes, source refs, tool input/output, and report mapping.
4. Pause/resume/cancel the run from the control cluster.
5. Retry a failed tool node or exclude an evidence node from the inspector.
6. When the report appears, click a section to highlight the source graph path.

## Design Intent

- Waiting is treated as an observable work surface, not an empty spinner.
- Tool calls are first-class graph nodes; success and failure are both visible.
- Evidence nodes carry source refs and quotes, so users can inspect what the Agent used.
- Claims and report sections are generated from visible process nodes.
- The final report is not detached from the process; every section maps back to source node IDs.

## Runtime Failure Rules

- `web_search` failure stops the run and emits `run_failed`.
- `web_fetch` failure can continue only when search still returned usable observations; the graph records a degraded observation.
- `evidence_extract`, `llm_analyze`, and `report_write` failures stop the run before normal report synthesis.
- Failed tool nodes stay visible and inspectable instead of being replaced by empty evidence.

## Project Updates

Project update rules live in [docs/PROJECT_UPDATES.md](docs/PROJECT_UPDATES.md). Keep user-facing changes reflected in [CHANGELOG.md](CHANGELOG.md), and run the verification commands below before publishing.

## Verification

```bash
npm test
npm run build
```

## Repository Status

This repository is the first public version of the Loading Mind prototype. The project is intended for product and engineering iteration, not production deployment.
