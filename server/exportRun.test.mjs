import { describe, expect, it } from "vitest";
import { runToExportJson, runToMarkdown } from "./exportRun.mjs";

function runFixture() {
  return {
    meta: {
      id: "run-test",
      question: "Question",
      scope: "Scope",
      depth: "standard",
      sources: ["web_search"],
      provider: {
        protocol: "openai",
        baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        anthropicBaseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
        model: "mimo-v2.5-pro",
        temperature: 0.35,
        maxTokens: 1400,
        apiKeyMasked: "tp-c21...vc6"
      },
      status: "completed",
      createdAt: 1,
      updatedAt: 2
    },
    excludedEvidenceIds: new Set(),
    events: [
      {
        id: "tool",
        graphEvent: {
          type: "node_added",
          node: {
            id: "llm-1",
            kind: "tool_call",
            label: "LLM Analyze",
            toolCall: {
              id: "llm-1",
              toolName: "llm_analyze",
              input: { model: "mimo-v2.5-pro" },
              startedAt: 1,
              status: "succeeded",
              costMs: 88,
              outputSummary: "analysis ok"
            }
          }
        }
      },
      {
        id: "evidence",
        graphEvent: {
          type: "node_added",
          node: {
            id: "evidence-1",
            kind: "evidence",
            label: "Evidence",
            evidence: {
              id: "evidence-1",
              title: "Evidence",
              quote: "Quote",
              source: "Source",
              confidence: 0.8,
              capturedAt: 1
            }
          }
        }
      },
      {
        id: "done",
        finalReport: {
          id: "report",
          kind: "final",
          title: "Report",
          body: "Report body",
          sections: [{
            id: "section-context",
            title: "Context",
            body: "Section body",
            sourceNodeIds: ["llm-1", "evidence-1"]
          }]
        }
      }
    ]
  };
}

describe("exportRun", () => {
  it("exports markdown without the full API key", () => {
    const markdown = runToMarkdown(runFixture());

    expect(markdown).toContain("# Report");
    expect(markdown).toContain("LLM Analyze");
    expect(markdown).toContain("tp-c21...vc6");
    expect(markdown).not.toContain("tp-c21wxh0dkb0bc24n2i9fs5ng5wc2xwhw0mrxesbmnqdw0vc6");
  });

  it("exports structured JSON with report, tools, and evidence", () => {
    const payload = runToExportJson(runFixture());

    expect(payload.finalReport.title).toBe("Report");
    expect(payload.toolCalls[0].toolName).toBe("llm_analyze");
    expect(payload.evidence[0].title).toBe("Evidence");
  });
});
