import { describe, expect, it } from "vitest";
import {
  assertToolOk,
  classifyWebFetchFailure,
  createDefaultToolRegistry,
  createResearchPlan,
  createRunSnapshot,
  crossCheckEvidence,
  dedupeSearchSources,
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
    const finalReport = snapshot.events.find((event) => event.finalReport)?.finalReport;
    const addedNodes = snapshot.events
      .filter((event) => event.graphEvent?.type === "node_added")
      .map((event) => event.graphEvent.node);

    expect(finalReport?.sections?.length).toBeGreaterThan(8);
    expect(finalReport?.blocks?.some((block) => block.type === "source_matrix")).toBe(true);
    expect(finalReport?.blocks?.some((block) => block.type === "mermaid")).toBe(true);
    expect(addedNodes.filter((node) => node.kind === "source").length).toBeGreaterThanOrEqual(8);
    expect(addedNodes.filter((node) => node.kind === "claim").length).toBeGreaterThanOrEqual(3);
    expect(addedNodes.some((node) => node.kind === "visualization")).toBe(true);
  });

  it("exposes registered tool runner metadata including the MCP adapter slot", () => {
    const registry = createDefaultToolRegistry();
    const tools = registry.list();

    expect(tools.map((tool) => tool.name)).toContain("search");
    expect(tools.map((tool) => tool.name)).toContain("cross_check");
    expect(tools.find((tool) => tool.name === "mcp.invoke")?.runner).toBe("mcp");
  });

  it("plans demo deep research with bounded source budget and query branches", () => {
    const plan = createResearchPlan({
      question: "Deep research UX",
      scope: "demo",
      sourceBudget: 30
    });

    expect(plan.researchQuestions.length).toBeGreaterThanOrEqual(3);
    expect(plan.researchQuestions.length).toBeLessThanOrEqual(5);
    expect(plan.searchQueries.length).toBeGreaterThanOrEqual(3);
    expect(plan.sourceBudget).toBe(12);
  });

  it("dedupes and caps search sources", () => {
    const outputs = Array.from({ length: 5 }, (_, queryIndex) => ({
      queryId: `query-${queryIndex + 1}`,
      query: `query ${queryIndex + 1}`,
      items: Array.from({ length: 4 }, (_, itemIndex) => ({
        title: `Source ${queryIndex}-${itemIndex}`,
        url: itemIndex === 0 ? "https://example.com/shared" : `https://example.com/${queryIndex}-${itemIndex}`,
        text: "text"
      }))
    }));

    const sources = dedupeSearchSources(outputs, 12);

    expect(sources.length).toBe(12);
    expect(new Set(sources.map((source) => source.url)).size).toBe(12);
  });

  it("marks weak and conflicted claims during cross-check", () => {
    const result = crossCheckEvidence([
      { id: "e1", claim: "A", sourceId: "s1", source: "S1", confidence: 0.8 },
      { id: "e2", claim: "A", sourceId: "s2", source: "S2", confidence: 0.82 },
      { id: "e3", claim: "B", sourceId: "s3", source: "S3", confidence: 0.7 },
      { id: "e4", claim: "A", sourceId: "s4", source: "S4", confidence: 0.66, contradicts: ["A"] }
    ]);

    expect(result.claims.find((claim) => claim.claim === "A")?.status).toBe("conflicted");
    expect(result.claims.find((claim) => claim.claim === "B")?.status).toBe("weak");
    expect(result.contradictions.length).toBe(1);
  });
});
