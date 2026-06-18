import { describe, expect, it } from "vitest";
import {
  assertToolOk,
  buildAnalyticalSynthesis,
  classifyReportIntent,
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
  reportNeedsRewrite,
  scoreReportQuality,
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

function providerReportContent(summary = "结论：应按场景选择，并用同一套真实任务验证。建议先小规模试点。") {
  return JSON.stringify({
    summary,
    sections: [
      {
        id: "section-summary",
        title: "一、执行结论",
        body: "结论：这个问题不能只看单一指标，应按目标场景、真实任务、成本和风险一起判断。",
        sourceNodeIds: ["research-plan", "source-1"]
      },
      {
        id: "section-research-scope",
        title: "二、研究问题与范围",
        body: "研究问题是用户提交的决策问题，研究范围限定在当前 run 收集的来源、摘录和案例内，结论必须能反向追溯。",
        sourceNodeIds: ["research-plan", "source-1"]
      },
      {
        id: "section-key-facts",
        title: "三、关键事实与数据",
        body: "关键事实包括 benchmark、成本、延迟、上下文能力和案例表现；这些数据决定结论是否能落地。",
        sourceNodeIds: ["source-1", "evidence-1"]
      },
      {
        id: "section-analysis",
        title: "四、分析维度",
        body: "分析维度应覆盖能力、速度、成本、集成难度、场景适配和失败恢复，而不是只看搜索来源数量。",
        sourceNodeIds: ["claim-1", "evidence-2"]
      },
      {
        id: "section-scenarios",
        title: "五、场景与案例",
        body: "案例上，短任务更看响应节奏，长链路任务更看上下文、工具调用和稳定恢复。",
        sourceNodeIds: ["source-2", "evidence-3"]
      },
      {
        id: "section-risk",
        title: "六、风险边界",
        body: "风险边界包括榜单口径不同、样本任务偏差、线上成本变化和版本更新导致的结论漂移。",
        sourceNodeIds: ["source-3", "evidence-4"]
      },
      {
        id: "section-recommendations",
        title: "七、选择建议与下一步",
        body: "建议下一步建立 20 条真实任务回归集，记录成功率、延迟、成本和人工返工，再做最终选择。",
        sourceNodeIds: ["research-plan", "claim-2"]
      },
      {
        id: "section-limitations",
        title: "八、局限性",
        body: "局限性是本次报告只使用当前 run 收集的信息，仍需要补充一手数据和生产环境验证。",
        sourceNodeIds: ["research-plan", "source-4"]
      }
    ]
  });
}

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

    expect(finalReport?.sections?.length).toBe(8);
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
              content: providerReportContent("结论：live provider 已基于来源包写出研究回答。建议按真实任务验证。")
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
    const reportToolNode = snapshot.events
      .map((event) => event.graphEvent?.node)
      .find((node) => node?.kind === "tool_call" && node.toolCall?.toolName === "report_write" && node.toolCall.status === "succeeded");
    const finalReport = snapshot.events.find((event) => event.finalReport)?.finalReport;

    expect(snapshot.run.runMode).toBe("live");
    expect(snapshot.run.status).toBe("completed");
    expect(searchToolNode?.attributes.provider).toBe("tavily");
    expect(searchToolNode?.attributes.requestId).toBe("tvly-request-1");
    expect(searchToolNode?.attributes.credits).toBe("1");
    expect(reportToolNode?.attributes.provider).toBe("openai");
    expect(reportToolNode?.attributes.model).toBe("model");
    expect(reportToolNode?.attributes.format).toBe("json");
    expect(reportToolNode?.attributes.provider).not.toBe("deterministic_fallback");
    expect(finalReport?.body).toContain("live provider");
    expect(finalReport?.sections?.[0]?.body).toContain("结论");
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
              content: providerReportContent("结论：Brave fallback 搜索后仍由 provider 写出研究回答。建议按同一任务集复测。")
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
              content: providerReportContent("结论：部分搜索分支失败后，provider 仍基于可用来源写出研究回答。建议标注风险并继续验证。")
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
              content: providerReportContent("结论：部分抓取失败后，provider 使用可用摘要和正文写出研究回答。建议补抓关键来源。")
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

  it("falls back to deterministic report when provider output is not usable", async () => {
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

    const finalReport = snapshot.events.find((event) => event.finalReport)?.finalReport;
    const reportToolNode = snapshot.events
      .map((event) => event.graphEvent?.node)
      .find((node) => node?.kind === "tool_call" && node.toolCall?.toolName === "report_write" && node.toolCall.status === "succeeded");
    const fallbackBlock = finalReport?.blocks?.find((block) => block.id === "appendix-provider-fallback");

    expect(snapshot.run.runMode).toBe("live");
    expect(snapshot.run.status).toBe("completed");
    expect(snapshot.events.some((event) => event.type === "run_completed")).toBe(true);
    expect(snapshot.errorLogs ?? []).toHaveLength(0);
    expect(finalReport?.kind).toBe("final");
    expect(finalReport?.quality?.passed).toBe(true);
    expect(reportToolNode?.attributes.mode).toBe("live_deterministic_fallback");
    expect(reportToolNode?.attributes.providerFailure).toMatch(/expected at least 5 answer sections|quality gate/);
    expect(fallbackBlock?.body).toContain("Live report provider 未能生成可用报告");
    expect(snapshot.events.some((event) => event.graphEvent?.node?.sourceRefs?.some((ref) => ref.startsWith("demo://")))).toBe(false);
  });

  it("records a deterministic fallback when the provider fails", async () => {
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

    const finalReport = snapshot.events.find((event) => event.finalReport)?.finalReport;
    const reportToolNode = snapshot.events
      .map((event) => event.graphEvent?.node)
      .find((node) => node?.kind === "tool_call" && node.toolCall?.toolName === "report_write" && node.toolCall.status === "succeeded");
    const fallbackBlock = finalReport?.blocks?.find((block) => block.id === "appendix-provider-fallback");

    expect(snapshot.run.status).toBe("completed");
    expect(snapshot.events.some((event) => event.type === "run_completed")).toBe(true);
    expect(snapshot.errorLogs ?? []).toHaveLength(0);
    expect(finalReport?.kind).toBe("final");
    expect(finalReport?.quality?.passed).toBe(true);
    expect(reportToolNode?.attributes.mode).toBe("live_deterministic_fallback");
    expect(reportToolNode?.attributes.providerFailure).toContain("provider outage");
    expect(fallbackBlock?.body).toContain("provider outage");
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

  it("adds official source queries when the topic requires authoritative model information", () => {
    const plan = createResearchPlan({
      question: "调研一下最新claude fable 5模型能力",
      scope: "模型发布时间、官方来源、benchmark 和定价",
      sourceBudget: 12
    });

    expect(plan.searchQueries[0]).toContain("site:anthropic.com");
    expect(plan.searchQueries[1]).toContain("site:platform.claude.com");
    expect(plan.officialSources).toHaveLength(2);
    expect(plan.officialSources[0].url).toContain("introducing-claude-fable-5-and-claude-mythos-5");
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
    outputs[0].items[1].url = "https://www.anthropic.com/news/claude-fable-5";
    outputs[0].items[2].url = "https://reddit.com/r/Anthropic/comments/example";
    outputs[0].items[3].url = "https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5";

    const sources = dedupeSearchSources(outputs, 12);

    expect(sources.length).toBe(12);
    expect(new Set(sources.map((source) => source.url)).size).toBe(12);
    expect(sources.find((source) => source.url.includes("anthropic.com"))?.sourceType).toBe("official");
    expect(sources.find((source) => source.url.includes("platform.claude.com"))?.sourceType).toBe("official");
    expect(sources.find((source) => source.url.includes("reddit.com"))?.sourceType).toBe("community");
    expect(sources.find((source) => source.url.includes("example.com/shared"))?.sourceType).toBe("reference");
  });

  it("does not treat Google Sites pages as official Google sources", () => {
    const sources = dedupeSearchSources([{
      queryId: "query-1",
      query: "official model docs",
      items: [{
        title: "OpenAI Nebula 7 mirror",
        url: "https://sites.google.com/view/openai-nebula-7",
        text: "Unofficial mirror page"
      }]
    }], 8);

    expect(sources[0]?.sourceType).toBe("reference");
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
    expect(synthesis.executiveSummary).toContain("不能只看单项榜单");
    expect(synthesis.executiveSummary).not.toContain("verified");
    expect(synthesis.executiveSummary).not.toContain("weak");
    expect(synthesis.matrixRows.length).toBeGreaterThanOrEqual(3);
    expect(synthesis.recommendation).toContain("建议");
    expect(synthesis.limitations).toContain("本报告只使用本次 run 已收集信息");
  });

  it("classifies report intent by report shape instead of domain", () => {
    expect(classifyReportIntent("对比一下国产大模型的最新模型能力", "")).toBe("comparison");
    expect(classifyReportIntent("机器人咖啡亭如何进入社区商业？", "市场机会")).toBe("market_analysis");
    expect(classifyReportIntent("Postgres 和 ClickHouse 该怎么做技术选型？", "技术方案")).toBe("comparison");
    expect(classifyReportIntent("新品冷启动的三个月产品策略怎么做？", "")).toBe("strategy_plan");
    expect(classifyReportIntent("上线支付系统有哪些风险？", "")).toBe("risk_assessment");
  });

  it("keeps benchmark comparison reports actionable instead of exposing evidence status", () => {
    const evidenceCards = [
      {
        id: "evidence-1",
        title: "Qwen benchmark",
        source: "Qwen official",
        sourceId: "source-1",
        quote: "Qwen3-235B-A22B 支持 128K 上下文，并覆盖 AIME、GPQA、LiveCodeBench 等 benchmark。",
        claim: "对比一下国产大模型的最新模型能力：关键事实和 benchmark 数据决定模型能力判断",
        confidence: 0.86
      },
      {
        id: "evidence-2",
        title: "Kimi benchmark",
        source: "Kimi official",
        sourceId: "source-2",
        quote: "Kimi K2.6 在 SWE-bench Verified 上报告 80.2，适合 agentic coding 场景。",
        claim: "对比一下国产大模型的最新模型能力：关键事实和 benchmark 数据决定模型能力判断",
        confidence: 0.85
      },
      {
        id: "evidence-3",
        title: "DeepSeek benchmark",
        source: "DeepSeek official",
        sourceId: "source-3",
        quote: "DeepSeek V3.2-Exp 公布 AIME 2025、GPQA-Diamond、LiveCodeBench 和 SWE Verified 等指标。",
        claim: "对比一下国产大模型的最新模型能力：适用场景决定模型选择",
        confidence: 0.84
      },
      {
        id: "evidence-4",
        title: "GLM benchmark",
        source: "GLM official",
        sourceId: "source-4",
        quote: "GLM-4.6 官方强调 200K 上下文、编程任务和工具调用能力。",
        claim: "对比一下国产大模型的最新模型能力：适用场景决定模型选择",
        confidence: 0.83
      }
    ];
    const verification = crossCheckEvidence(evidenceCards);
    const synthesis = buildAnalyticalSynthesis({
      question: "对比一下国产大模型的最新模型能力",
      scope: "能力、benchmark、适用场景和选择建议",
      sources: evidenceCards.map((card, index) => ({ id: `source-${index + 1}`, title: card.source })),
      evidenceCards,
      verification
    });
    const visibleText = [
      synthesis.executiveSummary,
      synthesis.recommendation,
      ...synthesis.themes.map((theme) => `${theme.title}\n${theme.body}`),
      ...synthesis.matrixRows.map((row) => Object.values(row).join(" "))
    ].join("\n");

    expect(synthesis.intent).toBe("comparison");
    expect(visibleText).toContain("结论");
    expect(visibleText).toMatch(/AIME|GPQA|LiveCodeBench|SWE-bench/);
    expect(visibleText).toContain("建议");
    expect(visibleText).not.toMatch(/当前是\s*verified|verified claim|个 verified|weak claim|\bsupportCount\b|证据主题/i);
  });

  it("keeps the final report artifact free of evidence-audit wording", async () => {
    const snapshot = await createRunSnapshot({
      question: "对比一下国产大模型的最新模型能力",
      scope: "能力、benchmark、适用场景和选择建议",
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
    const checkpoints = snapshot.events.filter((event) => event.checkpoint).map((event) => event.checkpoint);
    const artifactText = JSON.stringify(finalReport);
    const visibleReportText = JSON.stringify({
      body: finalReport?.body,
      sections: finalReport?.sections
    });
    const claimGraph = finalReport?.blocks?.find((block) => block.type === "claim_graph");

    expect(checkpoints.length).toBeGreaterThanOrEqual(3);
    expect(checkpoints.map((checkpoint) => checkpoint.title).join(" ")).toContain("Live Brief");
    expect(finalReport?.quality?.passed).toBe(true);
    expect(finalReport?.sections?.[0]?.body).toContain("结论");
    expect(finalReport?.sections?.some((section) => section.title.includes("研究问题与范围"))).toBe(true);
    expect(finalReport?.sections?.every((section) => section.sourceNodeIds.length > 0)).toBe(true);
    expect(artifactText).toMatch(/建议|下一步|决策|选择/);
    expect(visibleReportText).not.toMatch(/当前是\s*verified|verified claim|个 verified|weak claim|\bsupportCount\b|证据主题|交叉验证与证据强度|来源可靠性审计/i);
    expect(visibleReportText).not.toContain("\"verified\"");
    const sourceMatrix = finalReport?.blocks?.find((block) => block.id === "appendix-source-matrix");
    expect(sourceMatrix?.type).toBe("source_matrix");
    expect(sourceMatrix?.columns).toEqual(["citation", "title", "nodeId", "type", "url", "keyInformation", "decisionUse"]);
    expect(sourceMatrix?.rows?.[0]?.citation).toBe("[S1]");
    expect(sourceMatrix?.rows?.[0]).toHaveProperty("url");
    expect(finalReport?.sourceLabelMap?.["source-1"]).toMatch(/^\[S1]/);
    expect(claimGraph?.claims?.[0]).toMatchObject({
      reviewState: "source-linked"
    });
    expect(claimGraph?.claims?.[0]).not.toHaveProperty("supportCount");
  });

  it("allows deployment environment variables to override the default provider target", async () => {
    const previousBaseUrl = process.env.LOADING_MIND_PROVIDER_BASE_URL;
    const previousModel = process.env.LOADING_MIND_PROVIDER_MODEL;
    const previousProtocol = process.env.LOADING_MIND_PROVIDER_PROTOCOL;
    const previousMaxTokens = process.env.LOADING_MIND_PROVIDER_MAX_TOKENS;
    process.env.LOADING_MIND_PROVIDER_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    process.env.LOADING_MIND_PROVIDER_MODEL = "deepseek-v4-flash";
    process.env.LOADING_MIND_PROVIDER_PROTOCOL = "openai";
    process.env.LOADING_MIND_PROVIDER_MAX_TOKENS = "2200";
    try {
      const snapshot = await createRunSnapshot({
        question: "测试部署环境 provider 覆盖",
        scope: "验证 Vercel 环境变量可以覆盖前端默认 provider",
        depth: "standard",
        sources: ["web_search"],
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

      expect(snapshot.run.provider).toMatchObject({
        protocol: "openai",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "deepseek-v4-flash",
        maxTokens: 2200
      });
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.LOADING_MIND_PROVIDER_BASE_URL;
      } else {
        process.env.LOADING_MIND_PROVIDER_BASE_URL = previousBaseUrl;
      }
      if (previousModel === undefined) {
        delete process.env.LOADING_MIND_PROVIDER_MODEL;
      } else {
        process.env.LOADING_MIND_PROVIDER_MODEL = previousModel;
      }
      if (previousProtocol === undefined) {
        delete process.env.LOADING_MIND_PROVIDER_PROTOCOL;
      } else {
        process.env.LOADING_MIND_PROVIDER_PROTOCOL = previousProtocol;
      }
      if (previousMaxTokens === undefined) {
        delete process.env.LOADING_MIND_PROVIDER_MAX_TOKENS;
      } else {
        process.env.LOADING_MIND_PROVIDER_MAX_TOKENS = previousMaxTokens;
      }
    }
  });

  it("builds useful reports across non-model topics", () => {
    const samples = [
      {
        question: "机器人咖啡亭如何进入社区商业？",
        scope: "市场机会、运营路径和风险",
        quote: "社区商业点位需要结合租金、早晚高峰客流、复购频率和运维成本测算。"
      },
      {
        question: "Postgres 和 ClickHouse 应该如何做技术选型？",
        scope: "技术架构、成本和查询模式",
        quote: "Postgres 更适合事务和复杂关系查询，ClickHouse 更适合高吞吐 OLAP 聚合。"
      },
      {
        question: "一个 ToB AI 产品三个月冷启动策略怎么做？",
        scope: "产品策略、获客和验证路径",
        quote: "冷启动应先选择高痛点垂直场景，限定 ICP，并用试点客户验证 ROI。"
      }
    ];

    for (const sample of samples) {
      const evidenceCards = [
        { id: "evidence-1", title: "Source A", source: "Source A", sourceId: "source-1", quote: sample.quote, claim: `${sample.question}：核心事实决定行动路径`, confidence: 0.84 },
        { id: "evidence-2", title: "Source B", source: "Source B", sourceId: "source-2", quote: `${sample.quote} 下一步需要转成可验证假设和行动清单。`, claim: `${sample.question}：核心事实决定行动路径`, confidence: 0.82 }
      ];
      const verification = crossCheckEvidence(evidenceCards);
      const synthesis = buildAnalyticalSynthesis({
        question: sample.question,
        scope: sample.scope,
        sources: [{ id: "source-1", title: "Source A" }, { id: "source-2", title: "Source B" }],
        evidenceCards,
        verification
      });
      const visibleText = [
        synthesis.executiveSummary,
        synthesis.recommendation,
        ...synthesis.themes.map((theme) => theme.body),
        ...synthesis.matrixRows.map((row) => Object.values(row).join(" "))
      ].join("\n");

      expect(visibleText).toContain("结论");
      expect(visibleText).toMatch(/建议|下一步|行动|决策|执行/);
      expect(visibleText).not.toMatch(/当前是\s*verified|verified claim|个 verified|weak claim|\bsupportCount\b|证据主题/i);
    }
  });

  it("uses domain-specific dimensions for technical and market reports", () => {
    expect(classifyReportIntent(
      "调研机器人咖啡亭进入社区商业的机会",
      "用户需求、点位选择、成本结构、运营模式"
    )).toBe("market_analysis");

    const technical = buildAnalyticalSynthesis({
      question: "对比 Postgres 和 ClickHouse 在实时分析系统中的技术选型",
      scope: "吞吐、延迟、数据模型、运维成本",
      sources: [{ id: "source-1", title: "ClickHouse and PostgreSQL" }],
      evidenceCards: [{
        id: "evidence-1",
        title: "ClickHouse and PostgreSQL",
        source: "ClickHouse and PostgreSQL",
        sourceId: "source-1",
        quote: "ClickHouse is optimized for OLAP aggregation, throughput, compression and low latency analytics. PostgreSQL is stronger for OLTP and row updates.",
        claim: "技术选型：吞吐与延迟决定分析系统架构",
        confidence: 0.85
      }],
      verification: { claims: [] }
    });
    expect(technical.matrixRows.map((row) => row.dimension).join(" ")).toMatch(/吞吐与延迟|数据模型与查询模式|扩展性与存储成本/);
    expect(technical.matrixRows.map((row) => row.dimension).join(" ")).not.toMatch(/多模态|Agent|Benchmark/);
    expect(technical.executiveSummary).toMatch(/组合使用|事务|分析查询/);
    expect(JSON.stringify({
      executiveSummary: technical.executiveSummary,
      themes: technical.themes.map((theme) => theme.body),
      matrixRows: technical.matrixRows,
      recommendation: technical.recommendation
    })).not.toMatch(/推理和数学能力|代码和 agent 能力|这份.*需要直接给出判断|有用报告应先明确/);

    const market = buildAnalyticalSynthesis({
      question: "调研机器人咖啡亭进入社区商业的机会",
      scope: "用户需求、点位选择、成本结构、运营模式",
      sources: [{ id: "source-1", title: "机器人咖啡亭案例" }],
      evidenceCards: [{
        id: "evidence-1",
        title: "机器人咖啡亭案例",
        source: "机器人咖啡亭案例",
        sourceId: "source-1",
        quote: "社区点位、租金、人工成本、复购和早晚高峰需求决定机器人咖啡亭试点是否成立。",
        claim: "机器人咖啡亭：点位与成本决定社区商业机会",
        confidence: 0.82
      }],
      verification: { claims: [] }
    });
    expect(market.matrixRows.map((row) => row.dimension).join(" ")).toMatch(/需求与用户场景|点位、渠道与运营|成本结构与商业模式/);
    expect(market.matrixRows.map((row) => row.dimension).join(" ")).not.toMatch(/多模态|Agent|Benchmark/);
    expect(market.executiveSummary).toMatch(/试点|复购|单杯经济模型|维护补货/);
    expect(JSON.stringify({
      executiveSummary: market.executiveSummary,
      themes: market.themes.map((theme) => theme.body),
      matrixRows: market.matrixRows,
      recommendation: market.recommendation
    })).not.toMatch(/报告主文应分开呈现|这部分信息应转化|用于补充适用场景|补充同口径数据/);
  });

  it("keeps insufficient-source synthesis explicit instead of inventing facts", () => {
    const synthesis = buildAnalyticalSynthesis({
      question: "一个很新的未知产品是否值得进入？",
      scope: "市场机会和风险",
      sources: [],
      evidenceCards: [],
      verification: { claims: [] }
    });

    expect(synthesis.executiveSummary).toContain("需要补充事实、数据、案例或 benchmark");
    expect(synthesis.limitations).toContain("本报告只使用本次 run 已收集信息");
    expect(synthesis.matrixRows).toEqual([]);
  });

  it("flags source-audit style reports for rewrite", () => {
    expect(reportNeedsRewrite("summary", [{
      id: "section-bad",
      title: "四、交叉验证与证据强度",
      body: "证据主题 2 当前是 verified，由 4 个来源支撑。supportCount=4。",
      sourceNodeIds: ["claim-1"]
    }])).toBe(true);
    expect(reportNeedsRewrite("结论：应按场景选择。", [{
      id: "section-good",
      title: "选择建议",
      body: "建议先按预算、性能和落地成本做小规模试点，下一步记录同一任务的耗时和质量。",
      sourceNodeIds: ["source-1"]
    }])).toBe(false);
    expect(reportNeedsRewrite("结论：需要继续核验。", [{
      id: "section-noisy",
      title: "关键事实与数据",
      body: "关键材料：Loading... Loading... Cookie settings We use cookies to deliver and improve our services.",
      sourceNodeIds: ["source-1"]
    }])).toBe(true);
    expect(reportNeedsRewrite("结论：需要比较。建议下一步验证。", [{
      id: "section-placeholder",
      title: "关键事实与分析维度",
      body: "Demo sandbox comparison evidence says the models should be compared by decision dimensions.",
      sourceNodeIds: ["source-1"]
    }])).toBe(true);
  });

  it("flags image-heavy source dumps as invalid reports", () => {
    const broken = [{
      id: "section-source-dump",
      title: "关键事实",
      body: [
        "结论：需要继续观察。建议下一步比较模型能力。",
        "《Claude Fable 5 review》提供的信息是：# Claude Fable 5 he new Mythos model gets right and very wrong.",
        "![Image 1: Lenny's Newsletter](https://substackcdn.com/image/fetch/example.png)",
        "https://example.com/a https://example.com/b https://example.com/c https://example.com/d https://example.com/e"
      ].join("\n"),
      sourceNodeIds: ["source-1"]
    }];

    const score = scoreReportQuality("结论：需要继续观察。建议下一步比较模型能力。", broken);

    expect(reportNeedsRewrite("结论：需要继续观察。建议下一步比较模型能力。", broken)).toBe(true);
    expect(score.passed).toBe(false);
    expect(score.issues).toContain("避免图片和来源原文堆砌");
  });

  it("flags web navigation fragments and generic fallback wording as invalid reports", () => {
    const noisySections = [{
      id: "section-noisy",
      title: "关键事实与数据",
      body: [
        "结论：需要继续核验。建议下一步验证。",
        "* English * Japanese Sign in ClickHouse 产品 + ClickHouse Cloud 探索 100 多种集成",
        "By clicking Continue to join LinkedIn, you agree to the User Agreement.",
        "账号设置我的关注 企业号 企服点评 内容 首页 快讯 个人中心 我的消息 退出登录"
      ].join("\n"),
      sourceNodeIds: ["source-1"]
    }];
    const genericSections = [{
      id: "section-generic",
      title: "分析维度",
      body: "这份对比决策报告应先回答主题本身。把这条信息转成可验证假设，本次材料涉及 Math。",
      sourceNodeIds: ["source-1"]
    }];
    const liveFragmentSections = [{
      id: "section-live-fragments",
      title: "关键事实与数据",
      body: [
        "结论：需要继续核验。建议下一步验证。",
        "关键材料：* 体验 ClickHouse 的最佳方式 适用于 AWS、GCP 和 Azure + ClickHouse 使用开源版 ClickHouse 自行部署数据库。",
        "推出托管 ClickStack：大规模的 * 英语 * 日语 * 英语 * 日语 45.8k登录 ClickHouse 和 PostgreSQL。",
        "2023-10-02 21:38:20 发布 报告显示2022年全球机器人咖啡亭市场规模达 亿元。",
        "Skip to content Sign in Appearance settings Search code, repositories, users, issues, pull requests."
      ].join("\n"),
      sourceNodeIds: ["source-1"]
    }];
    const metaReportSections = [{
      id: "section-meta",
      title: "执行结论",
      body: "这份市场机会分析需要直接给出判断。有用报告应先明确研究问题，材料需要被压缩成关键事实。建议下一步补充同口径数据、真实案例或成本测算。",
      sourceNodeIds: ["source-1"]
    }];

    expect(reportNeedsRewrite("结论：需要继续核验。建议下一步验证。", noisySections)).toBe(true);
    expect(scoreReportQuality("结论：需要继续核验。建议下一步验证。", noisySections).issues).toContain("避免图片和来源原文堆砌");
    expect(reportNeedsRewrite("结论：需要继续核验。建议下一步验证。", genericSections)).toBe(true);
    expect(scoreReportQuality("结论：需要继续核验。建议下一步验证。", genericSections).issues).toContain("避免来源审计话术");
    expect(reportNeedsRewrite("结论：需要继续核验。建议下一步验证。", liveFragmentSections)).toBe(true);
    expect(scoreReportQuality("结论：需要继续核验。建议下一步验证。", liveFragmentSections).issues).toContain("避免图片和来源原文堆砌");
    expect(reportNeedsRewrite("结论：需要继续核验。建议下一步验证。", metaReportSections)).toBe(true);
    expect(scoreReportQuality("结论：需要继续核验。建议下一步验证。", metaReportSections).issues).toContain("避免来源审计话术");
  });

  it("labels OpenAI official source gaps as OpenAI instead of Anthropic", async () => {
    const snapshot = await createRunSnapshot({
      question: "调研一下最新 OpenAI Nebula 7 模型能力",
      scope: "官方来源、模型发布时间、价格和 benchmark",
      depth: "standard",
      sources: ["web_search", "web_fetch"],
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
    const text = JSON.stringify({
      body: finalReport?.body,
      sections: finalReport?.sections
    });

    expect(text).toContain("OpenAI 官方来源");
    expect(text).not.toContain("Anthropic 官方来源直接确认");
  });

  it("keeps fetched markdown fragments out of deterministic reports", async () => {
    const snapshot = await createRunSnapshot({
      question: "对比一下国产大模型的最新模型能力",
      scope: "能力、benchmark、适用场景和选择建议",
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
    const text = JSON.stringify({
      body: finalReport?.body,
      sections: finalReport?.sections
    });

    expect(finalReport?.quality?.passed).toBe(true);
    expect(text).not.toMatch(/!\[[^\]]*]\([^)]+\)|\[[^\]]*]\([^)]+\)/);
  });

  it("scores report quality across useful and broken reports", () => {
    const good = scoreReportQuality("结论：优先按场景选择。", [
      {
        id: "section-summary",
        title: "执行结论",
        body: "结论：优先按场景选择。建议下一步用真实任务复测。",
        sourceNodeIds: ["research-plan"]
      },
      {
        id: "section-scope",
        title: "研究问题与范围",
        body: "研究问题是模型能力选型，研究范围包括 benchmark、成本和适用场景。",
        sourceNodeIds: ["research-plan"]
      },
      {
        id: "section-analysis",
        title: "关键事实、数据与分析维度",
        body: "关键事实包括 AIME、GPQA benchmark 和成本数据。分析维度包括推理、代码、成本和场景。",
        sourceNodeIds: ["source-1"]
      },
      {
        id: "section-risk-action",
        title: "风险边界与选择建议",
        body: "风险边界是榜单口径不同。选择建议是下一步用真实任务复测，并记录延迟、成本和失败类型。",
        sourceNodeIds: ["source-2"]
      }
    ]);
    const sourceAudit = scoreReportQuality("summary", [{
      id: "section-bad",
      title: "交叉验证与证据强度",
      body: "证据主题 2 当前是 verified，由 4 个来源支撑。supportCount=4。",
      sourceNodeIds: ["claim-1"]
    }]);
    const noAction = scoreReportQuality("结论：市场有机会。", [{
      id: "section-no-action",
      title: "关键事实与分析维度",
      body: "关键事实包括用户增长数据和案例。风险边界是渠道成本较高。",
      sourceNodeIds: ["source-1"]
    }]);

    expect(good.passed).toBe(true);
    expect(good.score).toBe(100);
    expect(sourceAudit.passed).toBe(false);
    expect(sourceAudit.issues).toContain("避免来源审计话术");
    expect(noAction.passed).toBe(false);
    expect(noAction.issues).toContain("包含行动建议");
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
      sourceCount: 1,
      reviewState: "review",
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
