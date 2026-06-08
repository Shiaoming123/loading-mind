# Changelog

## 2026-06-08 - First Public Version

- Published the first public Loading Mind prototype.
- Added a live local Agent runtime with SSE events and graph-backed process visualization.
- Added visible runtime failure handling for `web_search`, `web_fetch`, `evidence_extract`, `llm_analyze`, and `report_write`.
- Improved canvas clarity for running, observed, succeeded, failed, synthesized, and written nodes.
- Moved the desktop center readout into a safer upper layout area while preserving mobile document flow.
- Added Vercel-compatible snapshot delivery for public demos, with frontend event replay and demo-safe tool fallbacks.
- Added a tool registry foundation with HTTP, local, provider, and MCP adapter metadata exposed through diagnostics.
- Added project update rules for future changes.
