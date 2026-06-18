import { describe, expect, it } from "vitest";
import { initialState } from "./mindstreamReducer";
import { reportToMarkdown } from "./reportExport";
import type { MindstreamState } from "./types";

function exportState(): MindstreamState {
  return {
    ...initialState,
    status: "completed",
    run: {
      id: "run-export",
      question: "对比一下国产大模型的最新模型能力",
      scope: "能力、benchmark、适用场景和选择建议",
      depth: "standard",
      sources: ["web_search"],
      runMode: "demo",
      status: "completed",
      createdAt: 1,
      updatedAt: 2
    },
    finalReport: {
      id: "report-export",
      kind: "final",
      title: "国产大模型能力｜深度研究报告",
      body: "结论：不能只看单项榜单，应按场景选择。",
      sections: [{
        id: "section-summary",
        title: "一、执行结论",
        body: "结论：按推理、代码、成本和风险分层选择。建议下一步用同一任务集复测。",
        sourceNodeIds: ["source-1"]
      }, {
        id: "section-scope",
        title: "二、研究问题与范围",
        body: "研究问题是模型能力选型，范围包括 benchmark 和适用场景。",
        sourceNodeIds: ["research-plan"]
      }],
      blocks: [{
        id: "appendix-source-matrix",
        type: "source_matrix",
        title: "附录：来源与引用矩阵",
        columns: ["citation", "title", "nodeId", "keyInformation"],
        rows: [{
          citation: "[S1]",
          title: "Qwen model card",
          nodeId: "source-1",
          keyInformation: "AIME、GPQA benchmark 信息"
        }],
        sourceNodeIds: ["source-1"]
      }]
    }
  };
}

describe("report export", () => {
  it("exports the final report content with traceability appendices", () => {
    const markdown = reportToMarkdown(exportState(), {
      "source-1": "[S1] Qwen model card",
      "research-plan": "研究计划"
    });

    expect(markdown).toContain("# 国产大模型能力｜深度研究报告");
    expect(markdown).toContain("## 一、执行结论");
    expect(markdown).toContain("## 二、研究问题与范围");
    expect(markdown).toContain("# Traceability Appendices");
    expect(markdown).toContain("| [S1] | Qwen model card | source-1 | AIME、GPQA benchmark 信息 |");
    expect(markdown).toContain("Source nodes: [S1] Qwen model card");
    expect(markdown).not.toContain("Tool Calls");
    expect(markdown).not.toContain("Audit Logs");
  });
});
