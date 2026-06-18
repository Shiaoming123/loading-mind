# Report Quality Audit

Date: 2026-06-10

Topic used for acceptance:

> 对比一下国产大模型的最新模型能力

Scope:

> 能力、benchmark、适用场景和选择建议

## Human Baseline Report

### 执行结论

国产大模型的“最新能力”不能用一个总榜单判断。更合理的结论是按场景分层：

- 如果目标是复杂推理、数学和科学问答，Qwen3-235B-A22B-Thinking-2507 与 DeepSeek-R1-0528 是第一梯队候选。
- 如果目标是代码修复、长链路 agent 和工具调用，Kimi K2/K2.6、GLM 系列和 DeepSeek-R1-0528 需要放进同一套 SWE-bench/LiveCodeBench/真实仓库任务里复测。
- 如果目标是生产部署，benchmark 只是第一层，还要比较上下文长度、输出长度、API 稳定性、推理成本、延迟、工具调用成功率和失败恢复。
- 团队选型时不应问“哪个模型最强”，而应问“我的任务属于推理、代码、搜索研究、企业流程还是低成本高并发”，然后按同一任务集复测。

### Benchmark Snapshot

| Model | Strong Signals | Reported Data Points | Best-fit Use |
| --- | --- | --- | --- |
| Qwen3-235B-A22B-Thinking-2507 | Reasoning, math, coding, long context | Qwen model card reports AIME25 92.3, GPQA 81.1, LiveCodeBench v6 74.1, BFCL-v3 71.9, native 262K context. | 高难推理、数学、长文本理解、需要开源生态的场景 |
| DeepSeek-R1-0528 | Reasoning depth, coding, function calling | DeepSeek model card reports AIME 2025 from 70.0 to 87.5, GPQA-Diamond 81.0, LiveCodeBench 73.3, SWE Verified 57.6. | 复杂推理、成本敏感的开放模型部署、函数调用增强场景 |
| Kimi K2 / K2.6 | Agentic coding, long-horizon coding, tool use | Kimi K2 card reports SWE-bench Verified 65.8 single-attempt and 71.6 with parallel test-time compute; K2.6 materials emphasize long-horizon coding and agent orchestration. | 编程 agent、仓库级任务、工具链自动化 |
| GLM-4.5 / later GLM line | Agentic reasoning and coding | Z.ai reports GLM-4.5 score 63.2 across 12 benchmarks; public SWE-bench pages track later GLM coding-agent performance. | 代码、agent、企业可控部署，需要结合实际工具链复测 |

### 分析维度

1. 推理能力：看 AIME、GPQA、HLE 等，但要注意采样次数、思考 token 和是否允许工具。
2. 编程能力：看 LiveCodeBench、SWE-bench Verified、SWE-bench Pro，并补充团队自己的真实仓库任务。
3. Agent 能力：看工具调用、浏览、长链路任务、失败恢复和多步骤一致性，不只看单轮问答。
4. 上下文与输出限制：长上下文对文档分析和代码库理解有价值，但成本和延迟会同步上升。
5. 生产可用性：API 兼容、吞吐、价格、限流、稳定性、日志审计和部署形态会改变真实选择。

### 选择建议

- 做通用推理/研究助手：优先试 Qwen3 Thinking 与 DeepSeek-R1-0528。
- 做 coding agent：优先试 Kimi K2/K2.6、GLM 系列、DeepSeek-R1-0528，并用同一仓库 issue 集复测。
- 做企业内嵌功能：把模型能力降为一项指标，重点比较 SLA、成本、数据边界、私有化或可控部署。
- 做公开产品：至少建立 20-50 条真实任务回归集，每次模型更新都记录成功率、延迟、单任务成本和人工返工次数。

### 风险边界

- 不同模型卡的 benchmark 口径不完全一致，不能直接横向相减。
- SWE-bench 类指标受 scaffold、工具、max tokens、是否多次采样影响很大。
- “开源/开放权重”不等于低部署成本，大 MoE 模型的显存、推理框架和吞吐优化是实际门槛。
- 2026 年模型更新频繁，结论需要按月复测。

## Why The Previous System Output Failed

The old output was not a research report. It exposed internal workflow state:

- It treated `verified`, `weak`, `supportCount`, and `证据主题` as report content.
- It explained how evidence was cross-checked instead of answering the topic.
- It did not build a benchmark table or decision matrix from the searched material.
- It lacked a direct "so what" path: which model to choose for which scenario, and how to verify the choice.

## Code Changes Made From This Audit

- `buildAnalyticalSynthesis` now starts from source insights and excerpts instead of claim status ranking.
- Live report writer no longer receives the full `verification` object; it receives `sourceInsights`, `benchmarkTerms`, excerpts, and a deterministic draft.
- Deterministic fallback sections now use report-shaped sections: conclusion, analysis dimensions, decision table, risk boundary, examples, and next steps.
- Final artifact claim graph now uses public `reviewState/sourceCount` instead of `status/supportCount`.
- Report UI and markdown export now show linked excerpts instead of evidence status wording.

## Current System Output Check

Local end-to-end snapshot after the fix:

- Topic: `对比一下国产大模型的最新模型能力`
- Report contains conclusion: yes.
- Report contains action/decision advice: yes.
- Visible report bad-language check: false.
- Final artifact bad-language check: false.
- Claim graph public state: `source-linked`, not `verified`.

This does not claim the demo sandbox data is a good model benchmark source. It proves the report pipeline now shapes any collected source material into an analytical report and blocks the previous evidence-audit style from reaching the user.

## Sources Used For The Baseline

- Qwen3-235B-A22B-Thinking-2507 model card: https://huggingface.co/Qwen/Qwen3-235B-A22B-Thinking-2507
- Qwen3 technical report: https://arxiv.org/pdf/2505.09388
- DeepSeek-R1-0528 model card: https://huggingface.co/deepseek-ai/DeepSeek-R1-0528
- Kimi K2 repository/model data: https://github.com/moonshotai/kimi-k2
- Kimi K2.6 model card: https://huggingface.co/moonshotai/Kimi-K2.6
- GLM-4.5 Z.ai blog/model information: https://z.ai/blog/glm-4.5
- SWE-bench official leaderboard/methodology: https://www.swebench.com/
