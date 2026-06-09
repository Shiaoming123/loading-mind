import { describe, expect, it } from "vitest";
import {
  assertToolOk,
  buildAnalyticalSynthesis,
  classifyWebFetchFailure,
  createDefaultToolRegistry,
  createRunErrorLog,
  createResearchPlan,
  createRunSnapshot,
  crossCheckEvidence,
  dedupeSearchSources,
  extractEvidenceCards,
  hasUsableSearchObservation,
  retryRunTool,
  planVisualizations,
  ToolRegistry,
  validateAndNormalizeArtifact
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

  it("normalizes malformed report artifacts before completion", () => {
    const run = {
      meta: { id: "run-artifact", runMode: "demo" },
      events: [{
        graphEvent: {
          node: { id: "source-1" }
        }
      }]
    };

    const artifact = validateAndNormalizeArtifact({
      id: "report-bad",
      kind: "final",
      title: "",
      body: "",
      sections: [{ id: "section-empty-source", title: "", body: "Recovered body", sourceNodeIds: ["missing-source"] }],
      blocks: [{
        id: "bad-mermaid",
        type: "mermaid",
        title: "Bad diagram",
        code: "not mermaid",
        sourceNodeIds: ["source-1"]
      }, {
        id: "table",
        type: "table",
        title: "Table",
        columns: ["field", "value"],
        rows: [{ field: "status" }]
      }]
    }, run);

    expect(artifact.title).toBe("Loading Mind Report");
    expect(artifact.body).toBe("Recovered body");
    expect(artifact.sections[0].sourceNodeIds).toEqual(["task-intent"]);
    expect(artifact.blocks[0]).toMatchObject({ type: "markdown", title: "Bad diagram" });
    expect(artifact.blocks[1].rows[0]).toEqual({ field: "status", value: "" });
  });

  it("classifies invalid provider keys as auth errors", () => {
    const run = {
      meta: { id: "run-auth", runMode: "live", provider: { protocol: "openai" } },
      events: [{
        phase: "drafting",
        graphEvent: {
          node: {
            id: "report_write-1",
            kind: "tool_call",
            attributes: { provider: "openai" },
            toolCall: {
              id: "report_write-1",
              toolName: "report_write",
              input: { apiKey: "secret-key", question: "Q" },
              status: "failed"
            }
          }
        }
      }]
    };

    const log = createRunErrorLog(run, new Error("Invalid API Key"));

    expect(log.errorType).toBe("auth");
    expect(log.retryable).toBe(false);
    expect(log.redactedInputSummary).toContain("[redacted]");
    expect(log.redactedInputSummary).not.toContain("secret-key");
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
    const previousBraveKey = process.env.BRAVE_SEARCH_API_KEY;
    const previousFirecrawlKey = process.env.FIRECRAWL_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;

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
    if (previousBraveKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = previousBraveKey;
    }
    if (previousFirecrawlKey === undefined) {
      delete process.env.FIRECRAWL_API_KEY;
    } else {
      process.env.FIRECRAWL_API_KEY = previousFirecrawlKey;
    }

    expect(snapshot.run.runMode).toBe("live");
    expect(snapshot.run.status).toBe("failed");
    expect(snapshot.events.some((event) => event.type === "run_completed")).toBe(false);
    expect(snapshot.events.some((event) => event.error?.includes("TAVILY_API_KEY"))).toBe(true);
    expect(snapshot.errorLogs?.[0]).toMatchObject({ errorType: "missing_key", retryable: false });
    expect(snapshot.events.find((event) => event.finalReport)?.finalReport?.kind).toBe("failure");
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

  it("falls back from Tavily to Brave Search during Live search", async () => {
    const previousTavilyKey = process.env.TAVILY_API_KEY;
    const previousBraveKey = process.env.BRAVE_SEARCH_API_KEY;
    process.env.TAVILY_API_KEY = "tvly-test";
    process.env.BRAVE_SEARCH_API_KEY = "brave-test";
    let braveCalls = 0;
    const fetchImpl = async (url) => {
      const urlText = String(url);
      if (urlText === "https://api.tavily.com/search") {
        return new Response(JSON.stringify({ error: "tavily outage" }), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (urlText.startsWith("https://api.search.brave.com/res/v1/web/search")) {
        braveCalls += 1;
        return new Response(JSON.stringify({
          web: {
            results: Array.from({ length: 4 }, (_, index) => ({
              title: `Brave Source ${braveCalls}-${index + 1}`,
              url: `https://example.com/brave-${braveCalls}-${index + 1}`,
              description: `Brave snippet ${braveCalls}-${index + 1}`
            }))
          }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlText.startsWith("https://example.com/brave-")) {
        return new Response("<main>Fetched Brave fallback source body with enough detail for evidence extraction.</main>", { status: 200 });
      }
      if (urlText === "https://provider.example/v1/chat/completions") {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                summary: "brave fallback report",
                sections: [{
                  id: "section-live",
                  title: "Live Brave fallback section",
                  body: "Live Brave fallback section body",
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
    if (previousBraveKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = previousBraveKey;
    }

    const searchToolNode = snapshot.events
      .map((event) => event.graphEvent?.node)
      .find((node) => node?.kind === "tool_call" && node.toolCall?.toolName === "search" && node.toolCall.status === "succeeded");

    expect(snapshot.run.status).toBe("completed");
    expect(searchToolNode?.attributes.provider).toBe("brave");
    expect(searchToolNode?.attributes.providerChain).toContain("tavily:failed -> brave:ok");
  });

  it("completes Live deep research when one search branch fails but enough sources remain", async () => {
    const previousTavilyKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "tvly-test";
    let searchCalls = 0;
    const fetchImpl = async (url) => {
      const urlText = String(url);
      if (urlText === "https://api.tavily.com/search") {
        searchCalls += 1;
        if (searchCalls === 2) {
          return new Response(JSON.stringify({ error: "temporary search outage" }), {
            status: 503,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({
          request_id: `tvly-partial-${searchCalls}`,
          response_time: 1.1,
          usage: { credits: 1 },
          results: Array.from({ length: 4 }, (_, index) => ({
            title: `Partial Source ${searchCalls}-${index + 1}`,
            url: `https://example.com/partial-${searchCalls}-${index + 1}`,
            content: `Partial snippet ${searchCalls}-${index + 1}`,
            raw_content: `# Partial raw ${searchCalls}-${index + 1}`,
            score: 0.9 - index * 0.01
          }))
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlText.startsWith("https://example.com/partial-")) {
        return new Response("<main>Fetched partial source body with enough detail for ranking and evidence extraction.</main>", { status: 200 });
      }
      if (urlText === "https://provider.example/v1/chat/completions") {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                summary: "partial search report",
                sections: [{
                  id: "section-live",
                  title: "Live partial section",
                  body: "Live partial section body",
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
      question: "Compare Codex and Claude Code",
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

    const nodes = snapshot.events.map((event) => event.graphEvent?.node).filter(Boolean);
    const searchSummary = nodes.find((node) => node.id === "search-summary");
    const failedSearchTool = nodes.find((node) => node.kind === "tool_call" && node.toolCall?.toolName === "search" && node.toolCall.status === "failed");
    const executionEdges = snapshot.events.map((event) => event.graphEvent?.edge).filter((edge) => edge?.kind === "execution_flow");

    expect(snapshot.run.status).toBe("completed");
    expect(snapshot.events.some((event) => event.type === "run_completed")).toBe(true);
    expect(snapshot.events.find((event) => event.finalReport)?.finalReport).toBeTruthy();
    expect(searchSummary?.executionStep).toMatchObject({ stepId: "search", stepStatus: "degraded" });
    expect(searchSummary?.attributes.failedBranches).toBe("1");
    expect(failedSearchTool?.importance).toBeLessThan(0.5);
    expect(executionEdges.map((edge) => `${edge.from}->${edge.to}`)).toContain("research-plan->search-summary");
  });

  it("completes Live deep research when most fetches fail and uses a degraded fetch summary", async () => {
    const previousTavilyKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "tvly-test";
    const fetchImpl = async (url) => {
      const urlText = String(url);
      if (urlText === "https://api.tavily.com/search") {
        return new Response(JSON.stringify({
          request_id: "tvly-fetch-degrade",
          response_time: 1.1,
          usage: { credits: 1 },
          results: Array.from({ length: 8 }, (_, index) => ({
            title: `Fetch Degrade Source ${index + 1}`,
            url: `https://example.com/fetch-degrade-${index + 1}`,
            content: `Fetch degrade snippet ${index + 1}`,
            raw_content: `# Fetch degrade raw ${index + 1}`,
            score: 0.9 - index * 0.01
          }))
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlText.startsWith("https://example.com/fetch-degrade-1") || urlText.startsWith("https://example.com/fetch-degrade-2")) {
        return new Response("<main>Fetched source body with enough detail for ranking.</main>", { status: 200 });
      }
      if (urlText.startsWith("https://example.com/fetch-degrade-")) {
        return new Response("blocked", { status: 403 });
      }
      if (urlText === "https://provider.example/v1/chat/completions") {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                summary: "fetch degraded report",
                sections: [{
                  id: "section-live",
                  title: "Live fetch degraded section",
                  body: "Live fetch degraded section body",
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
      question: "Compare Codex and Claude Code",
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

    const nodes = snapshot.events.map((event) => event.graphEvent?.node).filter(Boolean);
    const fetchSummary = nodes.find((node) => node.id === "fetch-summary");
    const failedFetchTools = nodes.filter((node) => node.kind === "tool_call" && node.toolCall?.toolName === "fetch" && node.toolCall.status === "failed");
    const degradedSourceNodes = nodes.filter((node) => node.kind === "source" && node.id.endsWith("-degraded"));

    expect(snapshot.run.status).toBe("completed");
    expect(snapshot.events.some((event) => event.type === "run_completed")).toBe(true);
    expect(fetchSummary?.executionStep).toMatchObject({ stepId: "fetch", stepStatus: "degraded" });
    expect(Number(fetchSummary?.attributes.degraded)).toBeGreaterThanOrEqual(6);
    expect(failedFetchTools.length).toBeGreaterThanOrEqual(6);
    expect(failedFetchTools.every((node) => node.importance < 0.4)).toBe(true);
    expect(degradedSourceNodes).toHaveLength(0);
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

  it("completes Live report writing with deterministic fallback when the provider fails", async () => {
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

    const reportToolNode = snapshot.events
      .map((event) => event.graphEvent?.node)
      .find((node) => node?.kind === "tool_call" && node.toolCall?.toolName === "report_write" && node.toolCall.status === "succeeded");
    const finalReport = snapshot.events.find((event) => event.finalReport)?.finalReport;

    expect(snapshot.run.status).toBe("completed");
    expect(snapshot.events.some((event) => event.type === "run_completed")).toBe(true);
    expect(snapshot.errorLogs?.[0]?.message).toContain("provider outage");
    expect(snapshot.errorLogs?.[0]?.toolName).toBe("report_write");
    expect(reportToolNode?.attributes.provider).toBe("deterministic_fallback");
    expect(reportToolNode?.attributes.fallbackReason).toContain("provider outage");
    expect(reportToolNode?.toolCall.input.deepResearch).toBe(true);
    expect(finalReport?.blocks?.some((block) => block.id === "block-provider-fallback")).toBe(true);
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

  it("rejects non-allowlisted MCP tools", async () => {
    const registry = createDefaultToolRegistry();
    const run = {
      meta: { id: "run-mcp", question: "MCP", sourceBudget: 8 },
      tavilyApiKey: "",
      firecrawlApiKey: "",
      exaApiKey: "",
      auditLogs: []
    };

    await expect(registry.get("mcp.invoke").execute({ tool: "filesystem.write", input: {} }, {
      run
    })).rejects.toThrow("MCP tool is not allowlisted");
    expect(run.auditLogs[0]).toMatchObject({
      toolName: "mcp.invoke",
      mcpTool: "filesystem.write",
      status: "failed"
    });
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
    expect(result.items.map((item) => item.claim).join("\n")).not.toContain("结论呈现与可追溯结构");
  });

  it("builds article-style synthesis for comparison reports", () => {
    const evidenceCards = [
      {
        id: "evidence-1",
        title: "Codex speed note",
        source: "Source A",
        sourceId: "source-1",
        quote: "Codex 输出速度快，但推理时间较长。",
        claim: "对比一下 codex 和 claude code：速度与响应节奏决定短任务体感，但需要区分首响速度、推理深度和可见输出速度",
        confidence: 0.86
      },
      {
        id: "evidence-2",
        title: "Claude workflow note",
        source: "Source B",
        sourceId: "source-2",
        quote: "Claude Code 的工作流入口和长链路工程体验更稳定。",
        claim: "对比一下 codex 和 claude code：工作流入口和分支能力决定工具能否融入真实开发节奏",
        confidence: 0.82
      },
      {
        id: "evidence-3",
        title: "Cost note",
        source: "Source C",
        sourceId: "source-3",
        quote: "成本和额度会影响高频使用。",
        claim: "对比一下 codex 和 claude code：成本与额度约束会影响高频工程使用，不能只看单次生成质量",
        confidence: 0.8
      },
      {
        id: "evidence-4",
        title: "Cost note 2",
        source: "Source D",
        sourceId: "source-4",
        quote: "付费限制和额度差异需要单独评估。",
        claim: "对比一下 codex 和 claude code：成本与额度约束会影响高频工程使用，不能只看单次生成质量",
        confidence: 0.78
      }
    ];
    const verification = crossCheckEvidence(evidenceCards);
    const synthesis = buildAnalyticalSynthesis({
      question: "对比一下 codex 和 claude code",
      scope: "工具选择",
      sources: evidenceCards.map((card, index) => ({ id: `source-${index + 1}`, title: card.source })),
      evidenceCards,
      verification
    });

    expect(synthesis.comparison).toBe(true);
    expect(synthesis.executiveSummary).toContain("结论");
    expect(synthesis.executiveSummary).toContain("不应被写成“谁绝对更好”");
    expect(synthesis.matrixRows.length).toBeGreaterThanOrEqual(3);
    expect(synthesis.recommendation).toContain("建议");
    expect(synthesis.limitations).toContain("本报告只使用本次 run 已收集来源");
  });

  it("normalizes legacy claim graph blocks into readable claim cards", () => {
    const run = {
      meta: { id: "run-claim-graph", runMode: "demo" },
      events: [
        { graphEvent: { node: { id: "claim-1" } } },
        { graphEvent: { node: { id: "evidence-1" } } }
      ]
    };

    const artifact = validateAndNormalizeArtifact({
      id: "report-claim-graph",
      kind: "final",
      title: "Report",
      body: "Body",
      blocks: [{
        id: "visual-claim-graph",
        type: "claim_graph",
        title: "Claim graph",
        nodes: [{ id: "claim-1", label: "成本与额度约束会影响高频工程使用", kind: "claim" }],
        edges: [{ from: "evidence-1", to: "claim-1", kind: "supports" }],
        sourceNodeIds: ["claim-1", "evidence-1"]
      }]
    }, run);

    const block = artifact.blocks.find((item) => item.type === "claim_graph");
    expect(block.claims[0]).toMatchObject({
      id: "claim-1",
      label: "成本与额度约束会影响高频工程使用",
      supportCount: 1,
      evidenceIds: ["evidence-1"]
    });
    expect(block.claims[0].sourceTitles).toEqual(["evidence-1"]);
  });

  it("plans claim graph blocks with readable claims and source titles", () => {
    const output = planVisualizations({
      question: "对比一下 codex 和 claude code",
      sources: [{ id: "source-1", title: "Codex vs Claude 分析", rank: 1, sourceType: "analysis", qualityScore: 0.9, independence: "high" }],
      evidenceCards: [{ id: "evidence-1", title: "Evidence", source: "Codex vs Claude 分析", sourceId: "source-1", quote: "速度和成本是主要差异。" }],
      claims: [{
        id: "claim-1",
        claim: "对比一下 codex 和 claude code：成本与额度约束会影响高频工程使用，不能只看单次生成质量",
        status: "verified",
        supportCount: 1,
        confidence: 0.86,
        evidenceIds: ["evidence-1"]
      }]
    });

    const block = output.blocks.find((item) => item.type === "claim_graph");
    expect(block.claims[0].sourceTitles).toEqual(["Codex vs Claude 分析"]);
    expect(block.evidence[0]).toMatchObject({ id: "evidence-1", sourceTitle: "Codex vs Claude 分析" });
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
