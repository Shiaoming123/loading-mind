# Changelog

## 2026-06-09 - Reliable Report Runs and Failure Diagnostics

- Added structured run error logs with redacted tool input summaries, retryability, and next-action guidance.
- Added failure reports so failed runs still render a readable report drawer instead of leaving users with a bare 500 or empty preview.
- Added final report artifact validation and normalization before `run_completed`.
- Added Live search fallback from Tavily to Brave Search to Firecrawl Search, plus Firecrawl scrape fallback for source content.
- Added a read-only MCP allowlist adapter for `tavily.search`, `firecrawl.search`, `firecrawl.scrape`, and `exa.search`.
- Added provider diagnostics metadata for Tavily, Brave, Firecrawl, Exa, LLM provider, and MCP allowlist status.
- Added local form fields for optional Brave, Firecrawl, and Exa keys.

## 2026-06-08 - First Public Version

- Added explicit Demo and Live run modes. Live mode uses Tavily search when `TAVILY_API_KEY` is configured and no longer silently replays demo fallbacks when real tools fail.
- Added a Tavily Search API Key input to the run configuration form for local Live runs.
- Replaced the fixed final report panel with a collapsible right-side report drawer that renders Markdown, Mermaid, tables, and claim graphs.
- Removed the particle toggle and System visual mode to keep the process graph focused on runtime state rather than decorative effects.
- Published the first public Loading Mind prototype.
- Added a live local Agent runtime with SSE events and graph-backed process visualization.
- Added visible runtime failure handling for `web_search`, `web_fetch`, `evidence_extract`, `llm_analyze`, and `report_write`.
- Improved canvas clarity for running, observed, succeeded, failed, synthesized, and written nodes.
- Moved the desktop center readout into a safer upper layout area while preserving mobile document flow.
- Added Vercel-compatible snapshot delivery for public demos, with frontend event replay and demo-safe tool fallbacks.
- Added a tool registry foundation with HTTP, local, provider, and MCP adapter metadata exposed through diagnostics.
- Upgraded the default run to demo deep research orchestration with planning, multi-branch search, 12-source budget, source ranking, evidence cards, cross-checking, examples, visualization blocks, and a long report.
- Added project update rules for future changes.
