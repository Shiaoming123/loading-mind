import { describe, expect, it } from "vitest";
import {
  assertToolOk,
  classifyWebFetchFailure,
  createDefaultToolRegistry,
  createResearchPlan,
  createRunSnapshot,
  crossCheckEvidence,
  dedupeSearchSources,
  extractEvidenceCards,
  hasUsableSearchObservation,
  retryRunTool,
  ToolRegistry
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

    expect(snapshot.run.runMode).toBe("demo");
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
    expect(addedNodes.some((node) => node.kind === "source" && node.sourceRefs?.some((ref) => ref.startsWith("demo://")))).toBe(true);
  });

  it("fails a Live run loudly when Tavily is not configured", async () => {
    const previousTavilyKey = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;

    const snapshot = await createRunSnapshot({
      question: "What is the current agent search landscape?",
      scope: "Live mode",
      depth: "standard",
      sources: ["web_search", "web_fetch", "document_read"],
      runMode: "live",
      providerConfig: {
        protocol: "openai",
        baseUrl: "https://provider.example/v1",
        anthropicBaseUrl: "https://provider.example/anthropic",
        apiKey: "provider-key",
        model: "model",
        temperature: 0.35,
        maxTokens: 1408
      }
    });

    if (previousTavilyKey === undefined) {
      delete process.env.TAVILY_API_KEY;
    } else {
      process.env.TAVILY_API_KEY = previousTavilyKey;
    }

    expect(snapshot.run.runMode).toBe("live");
    expect(snapshot.run.status).toBe("failed");
    expect(snapshot.events.some((event) => event.type === "run_completed")).toBe(false);
    expect(snapshot.events.some((event) => event.error?.includes("TAVILY_API_KEY"))).toBe(true);
    expect(snapshot.events.some((event) => event.graphEvent?.node?.sourceRefs?.some((ref) => ref.startsWith("demo://")))).toBe(false);
  });

  it("records Tavily usage metadata during Live search", async () => {
    const previousTavilyKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "tvly-test";
    const fetchImpl = async (url) => {
      const urlText = String(url);
      if (urlText === "https://api.tavily.com/search") {
        return new Response(JSON.stringify({
          request_id: "tvly-request-1",
          response_time: 1.2,
          usage: { credits: 1 },
          results: Array.from({ length: 8 }, (_, index) => ({
            title: `Live Source ${index + 1}`,
            url: `https://example.com/source-${index + 1}`,
            content: `Snippet ${index + 1}`,
            raw_content: `# Raw ${index + 1}`,
            score: 0.9 - index * 0.01,
            favicon: "https://example.com/favicon.ico"
          }))
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlText.startsWith("https://example.com/source-")) {
        return new Response("<main>Fetched live source body with enough detail for ranking and evidence extraction.</main>", { status: 200 });
      }
      if (urlText === "https://provider.example/v1/chat/completions") {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                summary: "live provider summary",
                sections: [{
                  id: "section-live",
                  title: "Live section",
                  body: "Live section body",
                  sourceNodeIds: ["research-plan", "source-1"]
                }]
              })
            }
          }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected fetch ${urlText}`);
    };

    const snapshot = await createRunSnapshot({
      question: "What is the current agent search landscape?",
      scope: "Live mode",
      depth: "standard",
      sources: ["web_search", "web_fetch", "document_read"],
      runMode: "live",
      providerConfig: {
        protocol: "openai",
        baseUrl: "https://provider.example/v1",
        anthropicBaseUrl: "https://provider.example/anthropic",
        apiKey: "provider-key",
        model: "model",
        temperature: 0.35,
        maxTokens: 1408
      }
    }, {
      fetchImpl
    });

    if (previousTavilyKey === undefined) {
      delete process.env.TAVILY_API_KEY;
    } else {
      process.env.TAVILY_API_KEY = previousTavilyKey;
    }

    const searchToolNode = snapshot.events
      .map((event) => event.graphEvent?.node)
      .find((node) => node?.kind === "tool_call" && node.toolCall?.toolName === "search" && node.toolCall.status === "succeeded");

    expect(snapshot.run.runMode).toBe("live");
    expect(snapshot.run.status).toBe("completed");
    expect(searchToolNode?.attributes.provider).toBe("tavily");
    expect(searchToolNode?.attributes.requestId).toBe("tvly-request-1");
    expect(searchToolNode?.attributes.credits).toBe("1");
    expect(snapshot.events.some((event) => event.graphEvent?.node?.sourceRefs?.some((ref) => ref.startsWith("demo://")))).toBe(false);
  });

  it("recovers Live report_write markdown provider output without demo fallback", async () => {
    const previousTavilyKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "tvly-test";
    const fetchImpl = async (url) => {
      const urlText = String(url);
      if (urlText === "https://api.tavily.com/search") {
        return new Response(JSON.stringify({
          request_id: "tvly-request-recovery",
          response_time: 1.1,
          usage: { credits: 1 },
          results: Array.from({ length: 8 }, (_, index) => ({
            title: `Recovery Source ${index + 1}`,
            url: `https://example.com/recovery-${index + 1}`,
            content: `Recovery snippet ${index + 1}`,
            raw_content: `# Recovery raw ${index + 1}`,
            score: 0.9 - index * 0.01
          }))
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlText.startsWith("https://example.com/recovery-")) {
        return new Response("<main>Fetched recovery source body with enough detail for evidence extraction and ranking.</main>", { status: 200 });
      }
      if (urlText === "https://provider.example/v1/chat/completions") {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: "# Live recovered report\n\nProvider returned markdown instead of strict JSON."
            }
          }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected fetch ${urlText}`);
    };

    const snapshot = await createRunSnapshot({
      question: "What is the current agent search landscape?",
      scope: "Live mode",
      depth: "standard",
      sources: ["web_search", "web_fetch", "document_read"],
      runMode: "live",
      providerConfig: {
        protocol: "openai",
        baseUrl: "https://provider.example/v1",
        anthropicBaseUrl: "https://provider.example/anthropic",
        apiKey: "provider-key",
        model: "model",
        temperature: 0.35,
        maxTokens: 1408
      }
    }, {
      fetchImpl
    });

    if (previousTavilyKey === undefined) {
      delete process.env.TAVILY_API_KEY;
    } else {
      process.env.TAVILY_API_KEY = previousTavilyKey;
    }

    const reportToolNode = snapshot.events
      .map((event) => event.graphEvent?.node)
      .find((node) => node?.kind === "tool_call" && node.toolCall?.toolName === "report_write" && node.toolCall.status === "succeeded");
    const finalReport = snapshot.events.find((event) => event.finalReport)?.finalReport;

    expect(snapshot.run.runMode).toBe("live");
    expect(snapshot.run.status).toBe("completed");
    expect(reportToolNode?.attributes.provider).toBe("openai");
    expect(reportToolNode?.attributes.model).toBe("model");
    expect(reportToolNode?.attributes.format).toBe("raw_markdown_recovered");
    expect(reportToolNode?.attributes.parseError).toMatch(/not valid JSON/i);
    expect(finalReport?.sections?.[0]?.body).toContain("Provider returned markdown");
    expect(snapshot.events.some((event) => event.graphEvent?.node?.sourceRefs?.some((ref) => ref.startsWith("demo://")))).toBe(false);
  });

  it("keeps failed report_write visible attributes small while preserving debug input", async () => {
    const previousTavilyKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "tvly-test";
    const fetchImpl = async (url) => {
      const urlText = String(url);
      if (urlText === "https://api.tavily.com/search") {
        return new Response(JSON.stringify({
          request_id: "tvly-request-failure",
          response_time: 1.1,
          usage: { credits: 1 },
          results: Array.from({ length: 8 }, (_, index) => ({
            title: `Failure Source ${index + 1}`,
            url: `https://example.com/failure-${index + 1}`,
            content: `Failure snippet ${index + 1}`,
            raw_content: `# Failure raw ${index + 1}`,
            score: 0.9 - index * 0.01
          }))
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlText.startsWith("https://example.com/failure-")) {
        return new Response("<main>Fetched failure source body with enough detail for evidence extraction and ranking.</main>", { status: 200 });
      }
      if (urlText === "https://provider.example/v1/chat/completions") {
        return new Response(JSON.stringify({ error: { message: "provider outage" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
      throw new Error(`Unexpected fetch ${urlText}`);
    };

    const snapshot = await createRunSnapshot({
      question: "What is the current agent search landscape?",
      scope: "Live mode",
      depth: "standard",
      sources: ["web_search", "web_fetch", "document_read"],
      runMode: "live",
      providerConfig: {
        protocol: "openai",
        baseUrl: "https://provider.example/v1",
        anthropicBaseUrl: "https://provider.example/anthropic",
        apiKey: "provider-key",
        model: "model",
        temperature: 0.35,
        maxTokens: 1408
      }
    }, {
      fetchImpl
    });

    if (previousTavilyKey === undefined) {
      delete process.env.TAVILY_API_KEY;
    } else {
      process.env.TAVILY_API_KEY = previousTavilyKey;
    }

    const failedReportToolNode = snapshot.events
      .map((event) => event.graphEvent?.node)
      .find((node) => node?.kind === "tool_call" && node.toolCall?.toolName === "report_write" && node.toolCall.status === "failed");

    expect(snapshot.run.status).toBe("failed");
    expect(snapshot.events.some((event) => event.type === "run_completed")).toBe(false);
    expect(snapshot.events.some((event) => event.error?.includes("provider outage"))).toBe(true);
    expect(failedReportToolNode?.attributes.input).toBeUndefined();
    expect(failedReportToolNode?.attributes.error).toContain("provider outage");
    expect(failedReportToolNode?.toolCall.input.deepResearch).toBe(true);
  });

  it("retries the original failed tool runner once and marks retryOf", async () => {
    let calls = 0;
    const registry = new ToolRegistry().register({
      name: "custom_tool",
      label: "Custom Tool",
      runner: "local",
      failurePolicy: "record",
      execute: (input) => {
        calls += 1;
        return {
          summary: `retried ${input.value}`,
          toolAttributes: { provider: "test-runner" }
        };
      }
    });
    const run = {
      meta: {
        id: "run-retry-test",
        status: "failed",
        updatedAt: Date.now()
      },
      events: [{
        id: "failed-event",
        runId: "run-retry-test",
        phase: "drafting",
        elapsedMs: 0,
        graphEvent: {
          type: "node_updated",
          node: {
            id: "custom_tool-1",
            kind: "tool_call",
            toolCall: {
              id: "custom_tool-1",
              toolName: "custom_tool",
              input: { value: 7 },
              startedAt: Date.now(),
              endedAt: Date.now(),
              status: "failed",
              error: "previous failure"
            }
          }
        }
      }],
      clients: new Set(),
      excludedEvidenceIds: new Set(),
      startedAt: Date.now(),
      virtualElapsedMs: 0,
      toolIndex: 1,
      persistEvents: false
    };

    const result = await retryRunTool(run, registry, "custom_tool-1");
    const retryNode = run.events
      .map((event) => event.graphEvent?.node)
      .find((node) => node?.kind === "tool_call" && node.toolCall?.retryOf === "custom_tool-1" && node.toolCall.status === "succeeded");
    const retryEdge = run.events
      .map((event) => event.graphEvent?.edge)
      .find((edge) => edge?.from === "custom_tool-1" && edge.to === retryNode?.id);

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      retryOf: "custom_tool-1",
      toolName: "custom_tool",
      status: "succeeded",
      summary: "retried 7"
    });
    expect(retryNode?.attributes.retryOf).toBe("custom_tool-1");
    expect(retryNode?.attributes.provider).toBe("test-runner");
    expect(retryEdge?.kind).toBe("retry_of");
    expect(run.events.some((event) => event.type === "retry_recorded" && /Rerun the task/.test(event.message))).toBe(true);
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

  it("derives evidence claims from the submitted theme instead of fixed demo topics", () => {
    const result = extractEvidenceCards({
      question: "机器人咖啡亭如何进入社区商业？",
      rankedSources: [
        {
          id: "source-1",
          title: "社区商业机器人咖啡案例",
          snippet: "社区门店通过无人咖啡设备降低夜间运营成本。",
          qualityScore: 0.86,
          sourceType: "case",
          independence: "high"
        },
        {
          id: "source-2",
          title: "商场租金与客流分析",
          fetchedText: "商场点位需要结合租金、客流和复购频率评估机器人咖啡亭。",
          qualityScore: 0.82,
          sourceType: "analysis",
          independence: "medium"
        }
      ]
    });

    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.claim.includes("机器人咖啡亭"))).toBe(true);
    expect(result.items.some((item) => item.quote.includes("社区门店"))).toBe(true);
    expect(result.items.map((item) => item.claim)).not.toContain("深研体验需要显式规划");
    expect(result.items.map((item) => item.claim)).not.toContain("结构化可视化能降低复杂研究的理解成本");
  });

  it("keeps demo deep research reports bound to non-Loading Mind user themes", async () => {
    const snapshot = await createRunSnapshot({
      question: "机器人咖啡亭如何进入社区商业？",
      scope: "评估社区点位、运营风险和商业化路径",
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

    const finalReport = snapshot.events.find((event) => event.finalReport)?.finalReport;
    const claimNodes = snapshot.events
      .map((event) => event.graphEvent?.node)
      .filter((node) => node?.kind === "claim");
    const reportText = [
      finalReport?.title,
      finalReport?.body,
      ...(finalReport?.sections ?? []).map((section) => `${section.title} ${section.body}`),
      ...claimNodes.map((node) => `${node.label} ${node.summary}`)
    ].join("\n");

    expect(snapshot.run.status).toBe("completed");
    expect(finalReport?.title).toContain("机器人咖啡亭");
    expect(finalReport?.body).toContain("机器人咖啡亭");
    expect(reportText).toContain("社区商业");
    expect(reportText).not.toContain("等待即过程资产");
    expect(reportText).not.toContain("Loading Mind 应把深研过程");
    expect(claimNodes.every((node) => node.summary.includes("机器人咖啡亭"))).toBe(true);
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
