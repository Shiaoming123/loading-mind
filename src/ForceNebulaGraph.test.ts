import { describe, expect, it } from "vitest";
import { summarizeToolInput, visibleNodeAttributes } from "./ForceNebulaGraph";

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
});
