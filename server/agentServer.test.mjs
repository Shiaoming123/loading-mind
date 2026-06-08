import { describe, expect, it } from "vitest";
import {
  assertToolOk,
  classifyWebFetchFailure,
  createDefaultToolRegistry,
  createRunSnapshot,
  hasUsableSearchObservation
} from "./agentServer.mjs";

const failedSearch = {
  ok: false,
  toolCall: {
    id: "web_search-1",
    toolName: "web_search",
    status: "failed",
    error: "Search HTTP 500"
  },
  output: { summary: "failed", items: [] }
};

const usableSearch = {
  ok: true,
  toolCall: {
    id: "web_search-1",
    toolName: "web_search",
    status: "succeeded"
  },
  output: {
    summary: "搜索返回 1 条候选来源。",
    items: [{ title: "Source", url: "https://example.com", text: "source text" }]
  }
};

const failedFetch = {
  ok: false,
  toolCall: {
    id: "web_fetch-2",
    toolName: "web_fetch",
    status: "failed",
    error: "Fetch HTTP 403"
  },
  output: { summary: "failed", items: [] }
};

describe("agent runtime failure helpers", () => {
  it("fails loud for failed web_search results", () => {
    expect(() => assertToolOk(failedSearch, "Web Search")).toThrow("Web Search failed: Search HTTP 500");
    expect(hasUsableSearchObservation(failedSearch)).toBe(false);
  });

  it("degrades web_fetch when search observations are still usable", () => {
    const policy = classifyWebFetchFailure(usableSearch, failedFetch);

    expect(policy.action).toBe("degrade");
    expect(policy.message).toContain("continuing degraded");
  });

  it("fails web_fetch when no usable source remains", () => {
    const emptySearch = {
      ...usableSearch,
      output: { summary: "搜索未返回强结果。", items: [] }
    };

    const policy = classifyWebFetchFailure(emptySearch, failedFetch);

    expect(policy.action).toBe("fail");
    expect(policy.message).toContain("no usable Web Search observation");
  });

  it("runs a Vercel-compatible snapshot with demo tools and no provider key", async () => {
    const snapshot = await createRunSnapshot({
      question: "How should a visible agent process demo work?",
      scope: "Vercel public demo",
      depth: "standard",
      sources: ["web_search", "web_fetch", "document_read"],
      providerConfig: {
        protocol: "openai",
        baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        anthropicBaseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
        apiKey: "",
        model: "mimo-v2.5-pro",
        temperature: 0.35,
        maxTokens: 1408
      }
    }, {
      forceDemoTools: true
    });

    expect(snapshot.run.status).toBe("completed");
    expect(snapshot.events.some((event) => event.type === "run_completed")).toBe(true);
    expect(snapshot.events.find((event) => event.finalReport)?.finalReport?.sections?.length).toBeGreaterThan(3);
    expect(snapshot.events.some((event) => event.graphEvent?.type === "node_added")).toBe(true);
  });

  it("exposes registered tool runner metadata including the MCP adapter slot", () => {
    const registry = createDefaultToolRegistry();
    const tools = registry.list();

    expect(tools.map((tool) => tool.name)).toContain("web_search");
    expect(tools.find((tool) => tool.name === "mcp.invoke")?.runner).toBe("mcp");
  });
});
