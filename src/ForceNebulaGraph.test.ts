import { describe, expect, it } from "vitest";
import { nodeMeaningSections, summarizeToolInput, visibleNodeAttributes } from "./ForceNebulaGraph";

describe("ForceNebulaGraph inspector helpers", () => {
  it("summarizes tool input and hides full input from visible attributes", () => {
    const longInput = JSON.stringify({
      deepResearch: true,
      evidence: Array.from({ length: 12 }, (_, index) => ({ id: `evidence-${index}` }))
    });

    const visible = visibleNodeAttributes({
      tool: "report_write",
      status: "failed",
      input: longInput,
      error: "Expected ',' after array element in JSON"
    });

    expect(visible.map((item) => item.key)).toEqual(["tool", "status", "error"]);
    expect(visible.some((item) => item.value.includes("evidence-11"))).toBe(false);
    expect(summarizeToolInput({ deepResearch: true, evidence: Array.from({ length: 12 }) })).toContain("evidence: 12 items");
  });

  it("describes a minimal node from its kind and graph relations", () => {
    const sections = nodeMeaningSections(
      { id: "claim-1", kind: "claim", label: "结论" },
      [{ id: "edge-1", from: "evidence-1", to: "claim-1", kind: "supports", label: "supports" }],
      [
        { id: "claim-1", kind: "claim", label: "结论" },
        { id: "evidence-1", kind: "evidence", label: "证据片段" }
      ]
    );

    expect(sections.find((section) => section.title === "任务含义")?.body).toContain("结论节点");
    expect(sections.find((section) => section.title === "关系")?.body).toContain("证据片段");
  });

  it("describes tool execution from tool call state", () => {
    const sections = nodeMeaningSections({
      id: "search-1",
      kind: "tool_call",
      label: "Search",
      toolCall: {
        id: "search-1",
        toolName: "search",
        input: { query: "agent graph", filters: ["official", "case"] },
        outputSummary: "3 usable sources",
        startedAt: 1,
        status: "succeeded"
      }
    });

    expect(sections.find((section) => section.title === "执行动作")?.body).toContain("调用 search");
    expect(sections.find((section) => section.title === "产出")?.body).toBe("3 usable sources");
  });

  it("describes evidence nodes from the captured quote", () => {
    const sections = nodeMeaningSections({
      id: "evidence-1",
      kind: "evidence",
      label: "Evidence",
      evidence: {
        id: "evidence-1",
        title: "Source title",
        quote: "Agent process visibility reduces uncertainty during long-running work.",
        source: "Source A",
        claim: "Process visibility matters",
        confidence: 0.84,
        capturedAt: 1
      }
    });

    expect(sections.find((section) => section.title === "任务含义")?.body).toBe("Process visibility matters");
    expect(sections.find((section) => section.title === "产出")?.body).toContain("reduces uncertainty");
  });
});
