# Loading Mind Final Report Rules

Date: 2026-06-10

## Purpose

Loading Mind final reports are decision-oriented research reports. The graph owns process visibility; the report owns the user-facing answer.

The report must:

- Answer first, then explain the basis.
- Keep sources, evidence links, visual blocks, and claim graphs traceable through appendices and `sourceNodeIds`.
- Avoid exposing internal workflow state such as `verified`, `weak`, `supportCount`, `证据主题`, or cross-check mechanics in the main prose.
- State uncertainty only when it changes the answer, risk, or next action.

## Standard Main Report Structure

Use these sections unless the topic clearly needs fewer:

1. 执行结论
2. 研究问题与范围
3. 关键事实与数据
4. 分析维度/对比矩阵
5. 场景与案例
6. 风险边界与不确定性
7. 选择建议与下一步
8. 局限性

Every section must bind at least one `sourceNodeIds` entry. If source material is insufficient, say what is missing instead of inventing facts.

## Required Appendices

Final artifacts keep the existing `Artifact` shape and use `blocks` for traceability:

- `source_matrix`: citation labels such as `[S1]`, source title, node id, key information, and decision use.
- `table`: decision table, comparison matrix, or key fact table.
- `mermaid`: research flow or decision structure when it compresses useful information.
- `claim_graph`: claim/evidence mapping with public review state labels, not internal verification terms.

## Quality Gate

A report passes only if it:

- Directly answers the user topic.
- Includes an execution conclusion.
- Includes facts, data, benchmarks, cases, cost, market, or user evidence where relevant.
- Organizes information into dimensions, standards, comparisons, or scenarios.
- States risk boundaries, limitations, uncertainty, or counterexamples.
- Provides concrete advice, next actions, decisions, validation paths, or checklists.
- Covers the decision-report structure above.
- Gives every section traceable source nodes.
- Avoids internal source-audit wording, image dumps, URL dumps, and raw source fragments.

## Research Mode References

- OpenAI Deep Research: multi-step agentic research with source-backed synthesis and citations.
- Gemini Deep Research: planning, searching, reading, writing, and streamed long-running research tasks.
- Claude Research: iterative searches across web and connected context with inspectable citations.
- Perplexity Sonar Deep Research: high-source-count deep research API with citations and usage metadata.
- Microsoft 365 Copilot Researcher: workplace research across web and internal work data, producing structured cited reports.
