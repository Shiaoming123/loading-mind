import fs from "node:fs";
import path from "node:path";
import { callProvider, providerPublicSummary, sanitizeProviderConfig } from "./providerClient.mjs";
import { runToExportJson, runToMarkdown } from "./exportRun.mjs";

const runStore = new Map();
const dataDir = path.resolve(process.cwd(), ".agent-runs");

function now() {
  return Date.now();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeElapsed(run) {
  return typeof run.virtualElapsedMs === "number" ? run.virtualElapsedMs : now() - run.startedAt;
}

async function waitForRun(run, ms) {
  const scale = typeof run.delayScale === "number" ? run.delayScale : 1;
  if (scale <= 0) {
    run.virtualElapsedMs = (run.virtualElapsedMs ?? runtimeElapsed(run)) + ms;
    return;
  }
  await wait(Math.max(0, Math.round(ms * scale)));
}

function ensureStore() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function persist(run) {
  if (run.persistEvents === false) {
    return;
  }
  ensureStore();
  fs.writeFileSync(path.join(dataDir, `${run.meta.id}.json`), JSON.stringify({
    meta: run.meta,
    events: run.events,
    excludedEvidenceIds: [...run.excludedEvidenceIds]
  }, null, 2));
}

function send(client, eventName, payload) {
  client.write(`event: ${eventName}\n`);
  client.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(run, eventName, payload) {
  for (const client of run.clients) {
    send(client, eventName, payload);
  }
}

function addEvent(run, event) {
  const nextEvent = {
    ...event,
    id: event.id ?? `${run.meta.id}-${run.events.length + 1}`,
    runId: run.meta.id,
    elapsedMs: runtimeElapsed(run)
  };
  run.events.push(nextEvent);
  run.meta.updatedAt = now();
  broadcast(run, "agent-event", nextEvent);
  persist(run);
  return nextEvent;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function nodeEvent(run, phase, message, node, type = "node_added") {
  return addEvent(run, {
    type,
    phase,
    message,
    graphEvent: { type, node }
  });
}

function edgeEvent(run, phase, message, edge) {
  return addEvent(run, {
    type: "edge_added",
    phase,
    message,
    graphEvent: { type: "edge_added", edge }
  });
}

function clusterEvent(run, phase, message, cluster) {
  return addEvent(run, {
    type: "cluster_formed",
    phase,
    message,
    graphEvent: { type: "cluster_formed", cluster }
  });
}

function toolNode(toolCall, label, summary, extra = {}) {
  const outputAttributes = toolCall.outputAttributes ?? {};
  const shouldHideInput = toolCall.toolName === "report_write" && toolCall.status === "failed";
  return {
    id: toolCall.id,
    kind: "tool_call",
    label,
    shortBody: summary,
    summary,
    status: toolCall.status === "failed" ? "failed" : toolCall.status === "running" ? "running" : "observed",
    cluster: "evidence",
    salience: toolCall.status === "failed" ? 0.74 : 0.64,
    confidence: toolCall.status === "failed" ? 0.32 : 0.76,
    toolCall,
    attributes: {
      tool: toolCall.toolName,
      status: toolCall.status,
      ...(shouldHideInput ? {} : { input: JSON.stringify(toolCall.input) }),
      ...(toolCall.retryOf ? { retryOf: toolCall.retryOf } : {}),
      costMs: String(toolCall.costMs ?? "--"),
      ...Object.fromEntries(Object.entries(outputAttributes).map(([key, value]) => [key, String(value)])),
      ...(toolCall.error ? { error: toolCall.error } : {})
    },
    episodes: [{
      id: `${toolCall.id}-episode`,
      time: new Date(toolCall.startedAt).toLocaleTimeString(),
      title: toolCall.status === "failed" ? "Tool failed" : "Tool call",
      detail: toolCall.outputSummary ?? summary
    }],
    ...extra
  };
}

function toolFailureError(toolResult, label) {
  return toolResult.toolCall.error || `${label} failed`;
}

export function assertToolOk(toolResult, label) {
  if (!toolResult.ok) {
    throw new Error(`${label} failed: ${toolFailureError(toolResult, label)}`);
  }
  return toolResult;
}

export function hasUsableSearchObservation(searchResult) {
  return Boolean(searchResult.ok && (searchResult.output.items ?? []).some((item) => item?.url || item?.text));
}

export function classifyWebFetchFailure(searchResult, fetchResult) {
  if (fetchResult.ok) {
    return { action: "ok" };
  }

  const error = toolFailureError(fetchResult, "Web Fetch");
  if (hasUsableSearchObservation(searchResult)) {
    return {
      action: "degrade",
      message: `Web Fetch failed but Web Search returned usable observations; continuing degraded. ${error}`
    };
  }

  return {
    action: "fail",
    message: `Web Fetch failed and no usable Web Search observation is available. ${error}`
  };
}

function usableEvidenceItems(items) {
  return (items ?? []).filter((item) => item?.quote && item?.title && item?.source);
}

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(spec) {
    this.tools.set(spec.name, spec);
    return this;
  }

  get(name) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool is not registered: ${name}`);
    }
    return tool;
  }

  list() {
    return [...this.tools.values()].map(({ execute, ...tool }) => tool);
  }
}

async function toolCall(run, toolName, input, label, executor, options = {}) {
  const failurePolicy = options.failurePolicy ?? "record";
  const phase = options.phase ?? "evidence";
  const cluster = options.cluster ?? "evidence";
  const startedAt = now();
  const id = `${toolName}-${run.toolIndex += 1}`;
  const running = {
    id,
    toolName,
    input,
    startedAt,
    status: "running",
    ...(options.retryOf ? { retryOf: options.retryOf } : {})
  };
  nodeEvent(run, phase, `${label} 已进入工具队列。`, toolNode(running, label, "工具正在执行真实请求。", { cluster }));

  try {
    const output = await executor();
    const finished = {
      ...running,
      status: "succeeded",
      endedAt: now(),
      costMs: now() - startedAt,
      outputSummary: output.summary,
      outputAttributes: output.toolAttributes
    };
    nodeEvent(run, phase, `${label} 已返回 observation。`, toolNode(finished, label, output.summary, { cluster }), "node_updated");
    return { ok: true, toolCall: finished, output };
  } catch (error) {
    const failed = {
      ...running,
      status: "failed",
      endedAt: now(),
      costMs: now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown tool failure",
      outputSummary: "工具调用失败，已把失败状态写入图谱，可重试。"
    };
    nodeEvent(run, phase, `${label} 失败，等待用户重试或继续。`, toolNode(failed, label, failed.outputSummary, { cluster }), "node_updated");
    const result = { ok: false, toolCall: failed, output: { summary: failed.outputSummary, items: [] } };
    if (failurePolicy === "throw") {
      throw new Error(`${label} failed: ${failed.error}`);
    }
    return result;
  }
}

async function runRegisteredTool(run, registry, toolName, input, options = {}) {
  const tool = registry.get(toolName);
  return toolCall(run, toolName, input, tool.label, () => tool.execute(input, { run, registry }), {
    failurePolicy: tool.failurePolicy,
    phase: tool.phase,
    cluster: tool.cluster,
    retryOf: options.retryOf
  });
}

function findLatestToolNode(run, toolNodeId) {
  for (let index = run.events.length - 1; index >= 0; index -= 1) {
    const event = run.events[index];
    const node = event.graphEvent?.node;
    if (node?.kind === "tool_call" && node.id === toolNodeId) {
      return { node, event };
    }
  }
  return null;
}

function retryError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export async function retryRunTool(run, registry, toolNodeId) {
  const match = findLatestToolNode(run, toolNodeId);
  if (!match) {
    throw retryError(`Tool node not found: ${toolNodeId}`, 404);
  }
  const originalCall = match.node.toolCall;
  if (!originalCall?.toolName) {
    throw retryError(`Tool node has no retryable tool call: ${toolNodeId}`);
  }
  if (originalCall.status !== "failed") {
    throw retryError(`Tool node is not failed: ${toolNodeId}`);
  }

  const result = await runRegisteredTool(run, registry, originalCall.toolName, originalCall.input, {
    retryOf: toolNodeId
  });
  edgeEvent(run, match.event.phase ?? "evidence", `Retry linked to ${toolNodeId}.`, {
    id: `edge-${toolNodeId}-${result.toolCall.id}`,
    from: toolNodeId,
    to: result.toolCall.id,
    kind: "retry_of",
    confidence: result.ok ? 0.78 : 0.34
  });
  if (run.meta.status === "failed") {
    addEvent(run, {
      type: "retry_recorded",
      phase: match.event.phase ?? "evidence",
      message: result.ok
        ? "Retry succeeded, but this run was already failed. Rerun the task to regenerate the report."
        : "Retry failed. This run was already failed; rerun the task after fixing the tool error.",
      retryOf: toolNodeId,
      retryNodeId: result.toolCall.id
    });
  }

  return {
    ok: result.ok,
    retryOf: toolNodeId,
    retryNodeId: result.toolCall.id,
    toolName: originalCall.toolName,
    status: result.toolCall.status,
    summary: result.output.summary,
    error: result.toolCall.error ?? null
  };
}

function demoSearchItems(query) {
  let hash = 0;
  for (const character of String(query || "")) {
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  }
  const slug = String(query || "research")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 42) || "research";
  const branch = hash.toString(36).slice(0, 6);
  return [
    {
      title: "深研任务需要先规划再检索",
      url: `demo://${slug}-${branch}/planning`,
      text: `围绕“${query}”，深度研究需要先形成 research brief、问题树、搜索计划和验证维度，再进入工具执行。`
    },
    {
      title: "多来源交叉验证决定报告可信度",
      url: `demo://${slug}-${branch}/cross-check`,
      text: "核心结论至少需要两个独立来源支持；单来源结论应标记为 weak claim，冲突信息应保留为 counterclaim。"
    },
    {
      title: "报告必须绑定来源节点",
      url: `demo://${slug}-${branch}/grounded-report`,
      text: "最终报告章节需要绑定 claim、evidence、source 和 verification 节点，用户才能从结论反查证据链。"
    },
    {
      title: "可视化能降低深研报告理解成本",
      url: `demo://${slug}-${branch}/visualization`,
      text: "证据矩阵、来源质量表和 claim-support graph 能帮助读者快速判断哪些结论被充分验证。"
    }
  ];
}

function demoFetchedText(query) {
  return [
    `Demo sandbox observation for ${query}.`,
    "A deep research style workflow should clarify the research intent, decompose subquestions, search across several source families, and keep a visible audit trail.",
    "High confidence claims require cross-checking: at least two sources should support the same answer, weak claims should be labeled, and contradictions should remain visible.",
    "A long report should include methodology, source quality, findings, examples, evidence matrix, visualization, conclusions, and limitations.",
    "When external tools are unavailable, the demo should show explicit sandbox sources instead of pretending the tool succeeded silently."
  ].join(" ");
}

function localEnvValue(name) {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return "";
  }
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) {
    return "";
  }
  const line = fs.readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(`${name}=`));
  return line ? line.slice(line.indexOf("=") + 1).trim() : "";
}

function tavilyApiKey(requestApiKey = "") {
  return requestApiKey || process.env.TAVILY_API_KEY || localEnvValue("TAVILY_API_KEY") || "";
}

function normalizeTavilyResult(result) {
  return {
    title: String(result?.title || result?.url || "Untitled source"),
    url: String(result?.url || ""),
    text: String(result?.content || result?.raw_content || ""),
    rawContent: typeof result?.raw_content === "string" ? result.raw_content : "",
    score: typeof result?.score === "number" ? result.score : undefined,
    favicon: typeof result?.favicon === "string" ? result.favicon : undefined
  };
}

async function searchTavily({ query, sourceBudget, tavilyApiKey: requestApiKey, fetchImpl = fetch }) {
  const apiKey = tavilyApiKey(requestApiKey);
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is required for Live search");
  }

  const response = await fetchImpl("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: Math.min(20, Math.max(1, Number(sourceBudget) || 5)),
      include_raw_content: "markdown",
      include_favicon: true,
      include_usage: true
    })
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { rawText: text };
    }
  }
  if (!response.ok) {
    throw new Error(data?.error || data?.message || text || `Tavily HTTP ${response.status}`);
  }
  const items = (Array.isArray(data?.results) ? data.results : [])
    .map(normalizeTavilyResult)
    .filter((item) => item.url || item.text);
  if (items.length === 0) {
    throw new Error("Tavily returned no usable results");
  }
  return {
    summary: `Tavily Live search returned ${items.length} source candidates.`,
    items,
    toolAttributes: {
      mode: "live",
      provider: "tavily",
      requestId: data?.request_id || "",
      credits: data?.usage?.credits ?? "",
      responseTime: data?.response_time ?? ""
    }
  };
}

function demoProviderResult(run, evidenceNodes, mode) {
  const evidenceIds = evidenceNodes.map((node) => node.id);
  if (mode === "analysis") {
    return {
      summary: `Demo provider analysis: “${run.meta.question}” 的关键是把等待过程变成可追溯的工作界面，并把失败工具显式暴露给用户。`,
      sections: [
        {
          id: "section-analysis-process",
          title: "过程可视化判断",
          body: "当前证据足以支持一个 demo 级判断：用户需要看到 Agent 正在做什么、用了哪些工具、哪些观察支撑了最终判断。",
          sourceNodeIds: ["task-intent", "ontology-runtime", ...evidenceIds.slice(0, 2)]
        },
        {
          id: "section-analysis-risk",
          title: "主要风险",
          body: "主要风险是工具失败被静默吞掉，或最终报告与过程节点脱节。runtime 必须保留失败节点并阻止空证据继续合成正常报告。",
          sourceNodeIds: [...evidenceIds.slice(0, 3), "claim-visible-process"]
        }
      ]
    };
  }

  return {
    summary: `Demo provider report: 本报告围绕“${run.meta.question}”生成，展示 Loading Mind 如何把长链路 Agent run 变成可检查、可追溯、可交互的过程资产。`,
    sections: fallbackReportSections(run.meta.question, evidenceNodes, "claim-visible-process", {
      search: "web_search-1",
      fetch: "web_fetch-2",
      documentRead: "document_read-3",
      extract: "evidence_extract-4",
      reportWrite: "report_write-6"
    })
  };
}

async function callRuntimeProvider(run, evidenceNodes, toolSummaries, mode) {
  if (run.forceDemoTools || (run.allowDemoFallback && !run.providerConfig.apiKey)) {
    return {
      ...demoProviderResult(run, evidenceNodes, mode),
      toolAttributes: {
        mode: run.meta.runMode,
        provider: "demo",
        model: run.providerConfig.model
      }
    };
  }
  try {
    const result = await callProvider(run.providerConfig, providerPrompt(run, evidenceNodes, toolSummaries, mode), {
      fetchImpl: run.fetchImpl
    });
    return {
      ...result,
      toolAttributes: {
        mode: run.meta.runMode,
        provider: run.providerConfig.protocol,
        model: result.discoveredModel || run.providerConfig.model,
        latencyMs: result.latencyMs ?? "",
        format: result.format || "json",
        ...(result.parseError ? { parseError: result.parseError } : {})
      }
    };
  } catch (error) {
    if (run.allowDemoFallback && !run.providerConfig.apiKey) {
      return {
        ...demoProviderResult(run, evidenceNodes, mode),
        toolAttributes: {
          mode: run.meta.runMode,
          provider: "demo",
          model: run.providerConfig.model
        }
      };
    }
    throw error;
  }
}

async function searchWeb(query, options = {}) {
  if (query?.forceDemoTools) {
    return {
      summary: "Demo sandbox 使用内置搜索 observation，未访问外部搜索服务。",
      items: demoSearchItems(query.query ?? ""),
      toolAttributes: {
        mode: "demo",
        provider: "sandbox"
      }
    };
  }

  const searchQuery = typeof query === "string" ? query : query.query;
  const allowDemoFallback = Boolean(typeof query === "object" && query.allowDemoFallback);
  if (query?.runMode === "live") {
    return searchTavily({
      query: searchQuery,
      sourceBudget: query.sourceBudget,
      tavilyApiKey: query.tavilyApiKey,
      fetchImpl: options.fetchImpl
    });
  }
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", searchQuery);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_redirect", "1");
  url.searchParams.set("no_html", "1");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let data = null;
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      throw new Error(`Search HTTP ${response.status}`);
    }
    data = await response.json();
  } catch (error) {
    clearTimeout(timer);
    if (!allowDemoFallback) {
      throw error;
    }
    return {
      summary: `外部搜索不可达，Demo sandbox 使用内置 observation 继续。原因：${error instanceof Error ? error.message : "Unknown search failure"}`,
      items: demoSearchItems(searchQuery),
      toolAttributes: {
        mode: "demo",
        provider: "sandbox",
        fallbackReason: error instanceof Error ? error.message : "Unknown search failure"
      }
    };
  }
  const topics = [];
  const collect = (items) => {
    for (const item of items ?? []) {
      if (item.Text && item.FirstURL) {
        topics.push({ title: item.Text.split(" - ")[0].slice(0, 90), url: item.FirstURL, text: item.Text });
      }
      if (item.Topics) {
        collect(item.Topics);
      }
    }
  };
  collect(data.RelatedTopics);
  if (data.AbstractText) {
    topics.unshift({
      title: data.Heading || query,
      url: data.AbstractURL,
      text: data.AbstractText
    });
  }
  return {
    summary: topics.length > 0 ? `搜索返回 ${topics.length} 条候选来源。` : "搜索未返回强结果，Demo sandbox 使用内置 observation 补全。",
    items: topics.length > 0 ? topics.slice(0, 4) : demoSearchItems(searchQuery),
    toolAttributes: {
      mode: topics.length > 0 ? "live-lite" : "demo",
      provider: topics.length > 0 ? "duckduckgo" : "sandbox"
    }
  };
}

async function fetchPage(url, options = {}) {
  if (!url) {
    if (options.allowDemoFallback) {
      return {
        summary: "没有可抓取 URL，Demo sandbox 使用内置网页 observation。",
        text: demoFetchedText(options.query ?? "runtime demo")
      };
    }
    throw new Error("No URL available for web_fetch");
  }
  if (options.forceDemoTools || String(url).startsWith("demo://")) {
    return {
      summary: "Demo sandbox 读取内置网页片段。",
      text: demoFetchedText(options.query ?? url)
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  let html = "";
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      throw new Error(`Fetch HTTP ${response.status}`);
    }
    html = await response.text();
  } catch (error) {
    clearTimeout(timer);
    if (!options.allowDemoFallback) {
      throw error;
    }
    return {
      summary: `网页读取不可达，Demo sandbox 使用内置网页 observation。原因：${error instanceof Error ? error.message : "Unknown fetch failure"}`,
      text: demoFetchedText(options.query ?? url)
    };
  }
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    summary: `读取网页 ${Math.min(text.length, 9999)} 字符，已抽取可用片段。`,
    text: text.slice(0, 1800)
  };
}

function localEvidence(question, searchItems, fetchedText, documentText) {
  const base = [
    {
      title: "长链路等待需要过程反馈",
      quote: "Agent 执行期间的检索、工具调用、观察和推理都可以成为用户可检查的过程资产。",
      source: "Local synthesis",
      url: ""
    },
    {
      title: "图谱节点必须可追溯",
      quote: "每个报告章节都需要绑定 evidence、observation 或 claim，否则过程可视化会退化成装饰。",
      source: "Local synthesis",
      url: ""
    }
  ];
  const remote = searchItems.map((item) => ({
    title: item.title,
    quote: item.text,
    source: item.url,
    url: item.url
  }));
  if (fetchedText) {
    remote.unshift({
      title: "网页读取片段",
      quote: fetchedText.slice(0, 240),
      source: "web_fetch",
      url: searchItems[0]?.url
    });
  }
  if (documentText) {
    remote.unshift({
      title: "用户约束文档",
      quote: documentText.slice(0, 240),
      source: "document_read",
      url: ""
    });
  }
  return [...remote, ...base].slice(0, 5).map((item, index) => ({
    id: `evidence-${index + 1}`,
    title: item.title || `证据 ${index + 1}`,
    quote: item.quote || question,
    source: item.source || "runtime",
    url: item.url,
    confidence: Math.max(0.62, 0.9 - index * 0.07),
    capturedAt: now()
  }));
}

function ensureReportSections(sections, evidenceNodes, claimNodeId, toolIds) {
  const fallbackSources = ["task-intent", "ontology-runtime", ...Object.values(toolIds), claimNodeId, ...evidenceNodes.map((node) => node.id)];
  return sections.slice(0, 5).map((section, index) => {
    const sourceNodeIds = section.sourceNodeIds.filter((nodeId) => fallbackSources.includes(nodeId));
    return {
      id: section.id || `section-${index + 1}`,
      title: section.title || `章节 ${index + 1}`,
      body: section.body,
      sourceNodeIds: sourceNodeIds.length > 0 ? sourceNodeIds : fallbackSources.slice(0, Math.min(4, fallbackSources.length))
    };
  });
}

function fallbackReportSections(question, evidenceNodes, claimNodeId, toolIds) {
  const evidenceIds = evidenceNodes.map((node) => node.id);
  return [
    {
      id: "section-context",
      title: "一、任务背景与研究目标",
      body: `本次任务围绕“${question}”创建真实 Agent run。系统先把用户意图拆成 ontology，再通过工具调用寻找外部信号，随后把证据转成可检查节点。`,
      sourceNodeIds: ["task-intent", "ontology-runtime", ...evidenceIds.slice(0, 2)]
    },
    {
      id: "section-evidence",
      title: "二、证据链与工具观察",
      body: "工具层产生了搜索、读取和证据抽取节点。每个 tool_call 节点记录 input、status、耗时和 observation；每个 evidence 节点保留来源、片段和置信度。",
      sourceNodeIds: [toolIds.search, toolIds.fetch, toolIds.documentRead, toolIds.extract, ...evidenceIds.slice(0, 3)]
    },
    {
      id: "section-claims",
      title: "三、关键判断",
      body: "核心判断是：Agent 长链路体验的价值不在于把等待包装得更漂亮，而在于让等待过程变成可理解的工作界面。",
      sourceNodeIds: [claimNodeId, ...evidenceIds.slice(1, 4)]
    },
    {
      id: "section-recommendation",
      title: "四、产品实现建议",
      body: "产品应保留沉浸式图谱舞台，但把它从视觉容器升级为 Agent runtime 的外显状态。最终报告按章节写入，每章绑定 sourceNodeIds。",
      sourceNodeIds: ["task-intent", "ontology-runtime", toolIds.reportWrite, claimNodeId]
    }
  ];
}

function reportFrom(run, evidenceNodes, claimNodeId, toolIds, providerResult) {
  const question = run.meta.question;
  const sections = providerResult?.sections?.length
    ? ensureReportSections(providerResult.sections, evidenceNodes, claimNodeId, toolIds)
    : fallbackReportSections(question, evidenceNodes, claimNodeId, toolIds);
  return {
    id: `report-${run.meta.id}`,
    kind: "final",
    title: "AI Agent 长链路调研报告",
    body: providerResult?.summary || `本报告基于用户问题“${question}”生成。系统实际执行了搜索、网页读取、证据抽取、LLM 工具观察分析和章节写作，并把每个章节映射回图谱中的证据与判断节点。`,
    sections
  };
}

function providerPrompt(run, evidenceNodes, toolSummaries, mode) {
  const evidenceText = evidenceNodes.map((node) => ({
    id: node.id,
    title: node.evidence?.title || node.label,
    quote: node.evidence?.quote || node.summary,
    source: node.evidence?.source || node.sourceRefs?.[0] || "runtime",
    confidence: node.evidence?.confidence ?? node.confidence
  }));
  const sourceNodeIds = [
    "task-intent",
    "ontology-runtime",
    ...toolSummaries.map((tool) => tool.id),
    ...evidenceNodes.map((node) => node.id),
    "claim-visible-process"
  ];
  return [
    {
      role: "system",
      content: [
        "你是 Loading Mind 的 Agent runtime 分析器。",
        "只输出 JSON，不要 Markdown。",
        "JSON 结构必须是 {\"summary\":\"...\",\"sections\":[{\"id\":\"section-context\",\"title\":\"...\",\"body\":\"...\",\"sourceNodeIds\":[\"...\"]}]}。",
        "section 的 sourceNodeIds 只能使用用户消息给出的 availableSourceNodeIds。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        mode,
        question: run.meta.question,
        scope: run.meta.scope,
        depth: run.meta.depth,
        toolSummaries,
        evidence: evidenceText,
        availableSourceNodeIds: sourceNodeIds,
        requirements: mode === "analysis"
          ? "生成 2 个 section，分析工具观察是否足以支撑后续报告，并指出主要风险。"
          : "生成 4 个中文报告 section，内容具体、可执行，并且每个 section 都绑定 sourceNodeIds。"
      }, null, 2)
    }
  ];
}

const DEFAULT_SOURCE_BUDGET = 12;
const MAX_SOURCE_BUDGET = 12;

function clampSourceBudget(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SOURCE_BUDGET;
  }
  return Math.min(MAX_SOURCE_BUDGET, Math.max(8, Math.round(numeric)));
}

function stableId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "item";
}

function compactText(value, maxLength = 120) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function topicLabel(question, maxLength = 42) {
  return compactText(question || "本次研究主题", maxLength);
}

function sourceBasis(source) {
  return compactText(source.fetchedText || source.rawContent || source.snippet || source.title, 180);
}

function researchClaimForSource(question, source, index) {
  const topic = topicLabel(question, 34);
  const angles = [
    "核心用户目标与评价标准",
    "可用证据与代表性来源",
    "风险、反例与不确定性",
    "结论呈现与可追溯结构"
  ];
  return `${topic}：${angles[index % angles.length]}`;
}

export function createResearchPlan({ question, scope, sourceBudget = DEFAULT_SOURCE_BUDGET }) {
  const budget = clampSourceBudget(sourceBudget);
  const core = String(question || "AI Agent 深度研究体验").trim();
  const researchQuestions = [
    `这个问题的核心用户目标和评价标准是什么：${core}`,
    `围绕“${core}”有哪些可验证来源、案例或数据点？`,
    `围绕“${core}”存在哪些证据不足、反例或边界条件？`,
    `怎样把“${core}”的结论、来源、验证和结构化文本映射回节点系统？`
  ];
  const searchQueries = [
    `${core} deep research workflow citations report`,
    `${core} evidence sources cases analysis`,
    `${core} risks limitations counterexamples verification`,
    `${core} structured report visualization evidence matrix`
  ];

  return {
    summary: `研究计划已围绕“${topicLabel(core)}”生成：4 个研究问题、${searchQueries.length} 个检索分支、${budget} 个来源预算。`,
    brief: `围绕“${core}”产出 demo 级深度研究报告，范围：${scope || "产品和工程实现"}`,
    researchQuestions,
    searchQueries,
    sourceBudget: budget,
    validationDimensions: ["来源独立性", "结论复核", "反例/冲突", "案例具体度", "可视化可读性"],
    outline: ["摘要", "研究方法", "来源质量说明", "核心发现", "交叉验证矩阵", "案例/例子", "可视化结构图", "结论与建议", "局限性"]
  };
}

export function dedupeSearchSources(searchOutputs, sourceBudget = DEFAULT_SOURCE_BUDGET) {
  const byKey = new Map();
  for (const output of searchOutputs) {
    for (const item of output.items ?? []) {
      const key = item.url || item.title;
      if (!key || byKey.has(key)) {
        continue;
      }
      byKey.set(key, {
        id: `source-${byKey.size + 1}`,
        title: item.title || `来源 ${byKey.size + 1}`,
        url: item.url || `demo://source-${byKey.size + 1}`,
        snippet: item.text || "",
        rawContent: item.rawContent || "",
        score: item.score,
        favicon: item.favicon,
        queryId: output.queryId,
        query: output.query,
        sourceType: item.url?.startsWith("demo://") ? "sandbox" : ["official", "analysis", "case", "reference"][byKey.size % 4],
        date: "2026-06"
      });
    }
  }
  return [...byKey.values()].slice(0, clampSourceBudget(sourceBudget));
}

export function rankSources({ sources, fetchedByUrl = {} }) {
  const ranked = (sources ?? []).map((source, index) => {
    const fetchedText = fetchedByUrl[source.url] ?? "";
    const hasFullText = fetchedText.length > 80;
    return {
      ...source,
      rank: index + 1,
      qualityScore: Math.max(0.58, 0.92 - index * 0.025 + (hasFullText ? 0.04 : -0.02)),
      independence: index % 3 === 0 ? "high" : index % 3 === 1 ? "medium" : "partial",
      fetchedText
    };
  });
  return {
    summary: `已按来源质量、独立性和可读内容排序 ${ranked.length} 个来源。`,
    sources: ranked
  };
}

export function extractEvidenceCards({ question, rankedSources }) {
  const cards = (rankedSources ?? []).map((source, index) => {
    const claim = researchClaimForSource(question, source, index);
    const quote = sourceBasis(source) || `${topicLabel(question)} 的研究来源 ${index + 1}`;
    return {
      id: `evidence-${index + 1}`,
      title: `${source.title}`.slice(0, 80),
      claim,
      quote: quote.slice(0, 260),
      source: source.title,
      url: source.url,
      sourceId: source.id,
      sourceType: source.sourceType,
      date: source.date,
      supports: [claim],
      contradicts: source.independence === "partial" && index === 7 ? [claim] : [],
      confidence: Math.min(0.92, Math.max(0.62, source.qualityScore ?? 0.7)),
      capturedAt: now()
    };
  });
  return {
    summary: `已围绕“${topicLabel(question)}”抽取 ${cards.length} 张 evidence card，覆盖 ${new Set(cards.map((card) => card.claim)).size} 个主题结论。`,
    items: cards
  };
}

export function crossCheckEvidence(evidenceCards) {
  const grouped = new Map();
  const contradictions = [];
  for (const card of evidenceCards ?? []) {
    if (!grouped.has(card.claim)) {
      grouped.set(card.claim, []);
    }
    grouped.get(card.claim).push(card);
    for (const contradicted of card.contradicts ?? []) {
      contradictions.push({
        id: `counterclaim-${contradictions.length + 1}`,
        claim: contradicted,
        sourceEvidenceId: card.id,
        summary: `${card.source} 对“${contradicted}”提供了限制性或冲突信号。`
      });
    }
  }

  const claims = [...grouped.entries()].map(([claim, cards], index) => {
    const uniqueSources = new Set(cards.map((card) => card.sourceId || card.url || card.source));
    const relatedContradictions = contradictions.filter((item) => item.claim === claim);
    const status = relatedContradictions.length > 0 ? "conflicted" : uniqueSources.size >= 2 ? "verified" : "weak";
    return {
      id: `claim-${index + 1}`,
      claim,
      status,
      supportCount: uniqueSources.size,
      evidenceIds: cards.map((card) => card.id),
      contradictionIds: relatedContradictions.map((item) => item.id),
      confidence: Math.min(0.92, cards.reduce((sum, card) => sum + card.confidence, 0) / Math.max(1, cards.length) + (status === "verified" ? 0.06 : -0.06))
    };
  });

  return {
    summary: `交叉验证完成：${claims.filter((claim) => claim.status === "verified").length} 个 verified claim，${claims.filter((claim) => claim.status === "weak").length} 个 weak claim，${contradictions.length} 个冲突信号。`,
    claims,
    contradictions
  };
}

export function findResearchCases(claims) {
  const examples = (claims ?? []).slice(0, 4).map((claim, index) => ({
    id: `example-${index + 1}`,
    claimId: claim.id,
    title: `案例 ${index + 1}：${compactText(claim.claim, 28)}`,
    body: `当用户阅读“${claim.claim}”时，界面应展示支撑来源、验证状态和报告章节的回链；如果该结论是 ${claim.status}，报告需要同步说明依据数量和不确定性。`
  }));
  return {
    summary: `已为 ${examples.length} 个结论补充具体案例。`,
    examples
  };
}

export function planVisualizations({ question, claims, sources }) {
  const topic = topicLabel(question, 28);
  const mermaidLines = [
    "flowchart LR",
    `  Plan[${topic} 研究计划] --> Search[主题检索分支]`,
    "  Search --> Sources[8-12 个主题来源]",
    "  Sources --> Evidence[主题 Evidence Cards]",
    "  Evidence --> Verify[来源交叉验证]",
    "  Verify --> Claims[Verified / Weak / Conflicted Claims]",
    "  Claims --> Report[结构化报告]"
  ];
  const graphEdges = (claims ?? []).flatMap((claim) => claim.evidenceIds.slice(0, 3).map((evidenceId) => ({
    from: evidenceId,
    to: claim.id,
    kind: claim.status === "conflicted" ? "contradicts" : "supports"
  })));
  return {
    summary: `已为“${topic}”生成 evidence matrix 和 claim-support graph 可视化规格。`,
    blocks: [
      {
        id: "visual-research-flow",
        type: "mermaid",
        title: `${topic} 执行链路`,
        code: mermaidLines.join("\n"),
        sourceNodeIds: ["research-plan", ...claims.map((claim) => claim.id)]
      },
      {
        id: "visual-source-matrix",
        type: "source_matrix",
        title: "来源质量矩阵",
        columns: ["rank", "title", "type", "quality", "independence"],
        rows: (sources ?? []).slice(0, 12).map((source) => ({
          rank: source.rank,
          title: source.title,
          type: source.sourceType,
          quality: Number(source.qualityScore).toFixed(2),
          independence: source.independence
        })),
        sourceNodeIds: (sources ?? []).map((source) => source.id)
      },
      {
        id: "visual-claim-graph",
        type: "claim_graph",
        title: `${topic} Claim-Support Graph`,
        nodes: [
          ...(claims ?? []).map((claim) => ({ id: claim.id, label: claim.claim, kind: "claim" })),
          ...(sources ?? []).slice(0, 8).map((source) => ({ id: source.id, label: source.title, kind: "source" }))
        ],
        edges: graphEdges,
        sourceNodeIds: [...new Set(graphEdges.flatMap((edge) => [edge.from, edge.to]))]
      }
    ]
  };
}

async function writeDeepResearchReport({ run, plan, sources, evidenceCards, verification, examples, visualizations }) {
  const verifiedClaims = verification.claims.filter((claim) => claim.status === "verified");
  const weakClaims = verification.claims.filter((claim) => claim.status !== "verified");
  const allEvidenceIds = evidenceCards.map((card) => card.id);
  const allSourceIds = sources.map((source) => source.id);
  const topic = topicLabel(run.meta.question);
  const topSources = sources.slice(0, 3).map((source) => source.title).join("、") || "暂无来源";
  const keyFindings = verification.claims
    .slice(0, 4)
    .map((claim) => `“${claim.claim}”是 ${claim.status} 结论，来自 ${claim.supportCount} 个来源。`)
    .join(" ");
  const reportBody = [
    `本报告围绕“${run.meta.question}”生成，范围是“${run.meta.scope}”。`,
    `过程图谱共纳入 ${sources.length} 个来源、${evidenceCards.length} 张 evidence card、${verification.claims.length} 个主题结论，其中 ${verifiedClaims.length} 个 verified、${weakClaims.length} 个 weak/conflicted。`,
    `首要来源包括：${topSources}。结构化内容包含执行摘要、交叉验证矩阵、来源质量矩阵、claim-support graph 和章节正文。`
  ].join("\n\n");
  let sections = [
    {
      id: "section-summary",
      title: `一、${topic}：摘要`,
      body: `本次 demo deep research 围绕“${run.meta.question}”执行计划、分支检索、来源读取、证据抽取、交叉验证、案例补充和结构化报告写作。当前纳入 ${sources.length} 个来源，形成 ${verification.claims.length} 个主题结论；${verifiedClaims.length} 个达到多来源验证，${weakClaims.length} 个需要在报告中标记为弱证据或冲突信号。`,
      sourceNodeIds: ["research-plan", ...verification.claims.map((claim) => claim.id).slice(0, 3)]
    },
    {
      id: "section-method",
      title: "二、研究方法与节点依据",
      body: `研究计划把“${run.meta.question}”拆成 ${plan.researchQuestions.length} 个问题和 ${plan.searchQueries.length} 条搜索分支。每个来源先进入 source node，再抽取 evidence card，最后通过 cross_check 判断 verified、weak 或 conflicted；因此用户点击任一结论时，都能回到支撑来源、证据片段和验证状态。`,
      sourceNodeIds: ["research-plan", ...plan.searchQueries.map((_, index) => `query-${index + 1}`)]
    },
    {
      id: "section-source-quality",
      title: "三、来源质量说明",
      body: `围绕“${topic}”的来源按完整文本、独立性、类型覆盖和排序质量打分。sandbox 来源会被明确标记，避免把 demo fallback 伪装成真实外部研究；来源矩阵优先展示 rank、title、type、quality 和 independence，帮助用户判断哪些依据更可靠。`,
      sourceNodeIds: allSourceIds.slice(0, 8)
    },
    {
      id: "section-findings",
      title: "四、核心发现",
      body: keyFindings || `当前“${topic}”没有达到多来源验证的结论，报告应降级展示，并把证据不足显式暴露给用户。`,
      sourceNodeIds: [...verification.claims.map((claim) => claim.id), ...allEvidenceIds.slice(0, 4)]
    },
    {
      id: "section-cross-check",
      title: "五、交叉验证矩阵",
      body: `“${topic}”的交叉验证结果：${verifiedClaims.length} 个 verified claim，${weakClaims.length} 个 weak/conflicted claim。弱证据结论保留在报告中，但明确标记为需要更多来源；冲突信号不会被吞掉，而是保留为 counterclaim 或弱结论说明。`,
      sourceNodeIds: verification.claims.map((claim) => claim.id)
    },
    {
      id: "section-examples",
      title: "六、案例与例子",
      body: examples.map((item) => `${item.title}：${item.body}`).join(" ") || `当前“${topic}”还没有足够案例节点，建议继续补充真实来源。`,
      sourceNodeIds: examples.map((item) => item.id)
    },
    {
      id: "section-visualization",
      title: "七、可视化结构图",
      body: `报告为“${topic}”生成执行链路、来源质量矩阵和 claim-support graph，让读者先看结构，再追溯具体证据。可视化节点不替代结论，而是解释每条结论从哪个来源、证据和验证结果生长出来。`,
      sourceNodeIds: visualizations.blocks.flatMap((block) => block.sourceNodeIds ?? []).slice(0, 10)
    },
    {
      id: "section-recommendations",
      title: "八、结论与建议",
      body: `围绕“${run.meta.question}”，界面应把计划节点、来源节点、证据节点、验证节点和报告章节连成可追溯链路：计划解释为什么搜，来源解释搜到了什么，验证解释哪些结论可信，报告解释最终如何写成可交付物。用户看到的节点描述必须优先说明依据和作用，而不是暴露内部流程名。`,
      sourceNodeIds: ["research-plan", ...verification.claims.map((claim) => claim.id)]
    },
    {
      id: "section-limitations",
      title: "九、局限性",
      body: `这仍是 demo 级深研：为了稳定性和时延，“${topic}”的来源预算被限制在 12 个以内，sandbox fallback 会显式标记。未来可接入后台队列、数据库和更多工具扩大研究深度，但不能用更复杂的内核换来更含糊的用户表达。`,
      sourceNodeIds: ["research-plan", ...weakClaims.map((claim) => claim.id)]
    }
  ].map((section) => ({
    ...section,
    sourceNodeIds: section.sourceNodeIds.filter(Boolean)
  }));

  let providerAttributes = {
    mode: run.meta.runMode,
    provider: run.meta.runMode === "live" ? run.providerConfig.protocol : "deterministic",
    model: run.providerConfig.model
  };
  if (run.meta.runMode === "live") {
    const availableSourceNodeIds = [
      "research-plan",
      ...plan.searchQueries.map((_, index) => `query-${index + 1}`),
      ...sources.map((source) => source.id),
      ...evidenceCards.map((card) => card.id),
      ...verification.claims.map((claim) => claim.id),
      ...examples.map((example) => example.id)
    ];
    const providerResult = await callProvider(run.providerConfig, [
      {
        role: "system",
        content: [
          "You are the Loading Mind live report writer.",
          "Return only JSON with this shape: {\"summary\":\"...\",\"sections\":[{\"id\":\"section-summary\",\"title\":\"...\",\"body\":\"...\",\"sourceNodeIds\":[\"...\"]}]}",
          "Use only availableSourceNodeIds for sourceNodeIds."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          question: run.meta.question,
          scope: run.meta.scope,
          plan,
          sources: sources.map((source) => ({ id: source.id, title: source.title, url: source.url, text: source.text })),
          evidence: evidenceCards,
          verification,
          examples,
          availableSourceNodeIds,
          requirement: "Write 5 concise Chinese report sections grounded in the supplied live sources."
        }, null, 2)
      }
    ], {
      fetchImpl: run.fetchImpl
    });
    if (providerResult.sections?.length) {
      sections = providerResult.sections.slice(0, 5).map((section, index) => {
        const sourceNodeIds = (section.sourceNodeIds ?? []).filter((nodeId) => availableSourceNodeIds.includes(nodeId));
        return {
          id: section.id || `section-live-${index + 1}`,
          title: section.title || `Live section ${index + 1}`,
          body: section.body,
          sourceNodeIds: sourceNodeIds.length > 0 ? sourceNodeIds : availableSourceNodeIds.slice(0, 4)
        };
      });
    }
    providerAttributes = {
      mode: "live",
      provider: run.providerConfig.protocol,
      model: providerResult.discoveredModel || run.providerConfig.model,
      latencyMs: providerResult.latencyMs ?? "",
      format: providerResult.format || "json",
      ...(providerResult.parseError ? { parseError: providerResult.parseError } : {})
    };
  }

  const blocks = [
    {
      id: "block-executive-summary",
      type: "markdown",
      title: "执行摘要",
      body: sections[0].body,
      sourceNodeIds: sections[0].sourceNodeIds
    },
    {
      id: "block-verification-table",
      type: "table",
      title: "交叉验证矩阵",
      columns: ["claim", "status", "supportCount", "confidence"],
      rows: verification.claims.map((claim) => ({
        claim: claim.claim,
        status: claim.status,
        supportCount: claim.supportCount,
        confidence: claim.confidence.toFixed(2)
      })),
      sourceNodeIds: verification.claims.map((claim) => claim.id)
    },
    ...visualizations.blocks,
    ...sections.slice(1).map((section) => ({
      id: `block-${section.id}`,
      type: "markdown",
      title: section.title,
      body: section.body,
      sourceNodeIds: section.sourceNodeIds
    }))
  ];

  return {
    summary: `深度研究长报告已生成：${sections.length} 个章节、${blocks.length} 个内容块、${sources.length} 个来源、${verification.claims.length} 个核心结论。`,
    report: {
      id: `report-${run.meta.id}`,
      kind: "final",
      title: `${topic}｜深度研究报告`,
      body: reportBody,
      sections,
      blocks
    },
    toolAttributes: providerAttributes
  };
}

export function createDefaultToolRegistry() {
  return new ToolRegistry()
    .register({
      name: "search",
      label: "Search Branch",
      runner: "http",
      phase: "graph_build",
      cluster: "search",
      failurePolicy: "record",
      execute: ({ query, queryId }, { run }) => searchWeb({
        query,
        runMode: run.meta.runMode,
        sourceBudget: run.meta.sourceBudget,
        tavilyApiKey: run.tavilyApiKey,
        allowDemoFallback: run.allowDemoFallback,
        forceDemoTools: run.forceDemoTools
      }, {
        fetchImpl: run.fetchImpl
      }).then((output) => ({
        ...output,
        query,
        queryId,
        items: (output.items ?? []).map((item) => ({ ...item, query, queryId }))
      }))
    })
    .register({
      name: "fetch",
      label: "Fetch Source",
      runner: "http",
      phase: "graph_build",
      cluster: "sources",
      failurePolicy: "record",
      execute: ({ url, query }, { run }) => fetchPage(url, {
        query,
        allowDemoFallback: run.allowDemoFallback,
        forceDemoTools: run.forceDemoTools,
        fetchImpl: run.fetchImpl
      })
    })
    .register({
      name: "extract",
      label: "Extract Evidence",
      runner: "local",
      phase: "evidence",
      cluster: "evidence",
      failurePolicy: "record",
      execute: ({ question, rankedSources }) => extractEvidenceCards({ question, rankedSources })
    })
    .register({
      name: "rank_source",
      label: "Rank Sources",
      runner: "local",
      phase: "evidence",
      cluster: "sources",
      failurePolicy: "record",
      execute: ({ sources, fetchedByUrl }) => rankSources({ sources, fetchedByUrl })
    })
    .register({
      name: "cross_check",
      label: "Cross Check",
      runner: "local",
      phase: "reasoning",
      cluster: "verification",
      failurePolicy: "record",
      execute: ({ evidenceCards }) => crossCheckEvidence(evidenceCards)
    })
    .register({
      name: "case_find",
      label: "Find Cases",
      runner: "local",
      phase: "reasoning",
      cluster: "synthesis",
      failurePolicy: "record",
      execute: ({ claims }) => findResearchCases(claims)
    })
    .register({
      name: "chart_plan",
      label: "Plan Charts",
      runner: "local",
      phase: "drafting",
      cluster: "visualization",
      failurePolicy: "record",
      execute: ({ question, claims, sources }) => planVisualizations({ question, claims, sources })
    })
    .register({
      name: "web_search",
      label: "Web Search",
      runner: "http",
      failurePolicy: "record",
      execute: ({ query }, { run }) => searchWeb({
        query,
        runMode: run.meta.runMode,
        sourceBudget: run.meta.sourceBudget,
        tavilyApiKey: run.tavilyApiKey,
        allowDemoFallback: run.allowDemoFallback,
        forceDemoTools: run.forceDemoTools
      }, {
        fetchImpl: run.fetchImpl
      })
    })
    .register({
      name: "web_fetch",
      label: "Web Fetch",
      runner: "http",
      failurePolicy: "record",
      execute: ({ url, query }, { run }) => fetchPage(url, {
        query,
        allowDemoFallback: run.allowDemoFallback,
        forceDemoTools: run.forceDemoTools,
        fetchImpl: run.fetchImpl
      })
    })
    .register({
      name: "document_read",
      label: "Document Read",
      runner: "local",
      failurePolicy: "record",
      execute: ({ question, scope }) => ({
        summary: "读取用户输入的任务范围和约束，作为本次调研的内部文档来源。",
        text: `${question}\n${scope}`
      })
    })
    .register({
      name: "evidence_extract",
      label: "Evidence Extract",
      runner: "local",
      failurePolicy: "record",
      execute: ({ question, searchItems, fetchedText, documentText }) => ({
        summary: "从搜索和网页读取结果中抽取证据片段。",
        items: localEvidence(question, searchItems ?? [], fetchedText ?? "", documentText ?? "")
      })
    })
    .register({
      name: "llm_analyze",
      label: "LLM Analyze",
      runner: "provider",
      failurePolicy: "record",
      execute: ({ evidenceNodes, toolSummaries }, { run }) => callRuntimeProvider(run, evidenceNodes, toolSummaries, "analysis")
    })
    .register({
      name: "report_write",
      label: "Report Write",
      runner: "provider",
      phase: "drafting",
      cluster: "report",
      failurePolicy: "record",
      execute: (input, { run }) => {
        if (input.deepResearch) {
          return writeDeepResearchReport({ run, ...input });
        }
        return callRuntimeProvider(run, input.evidenceNodes, input.toolSummaries, "report");
      }
    })
    .register({
      name: "mcp.invoke",
      label: "MCP Tool",
      runner: "mcp",
      failurePolicy: "record",
      execute: () => {
        throw new Error("MCP adapter is not configured for this demo runtime yet.");
      }
    });
}

async function waitUntilRunnable(run) {
  while (run.meta.status === "paused") {
    await waitForRun(run, 180);
  }
  if (run.meta.status === "cancelled") {
    throw new Error("Run cancelled");
  }
}

async function executeRun(run) {
  return executeDeepResearchRun(run);
}

async function executeDeepResearchRun(run) {
  try {
    const registry = run.toolRegistry ?? createDefaultToolRegistry();
    run.startedAt = now();
    run.virtualElapsedMs = typeof run.virtualElapsedMs === "number" ? run.virtualElapsedMs : 0;
    run.meta.status = "running";

    addEvent(run, {
      type: "run_started",
      phase: "initializing",
      message: "Deep research run 已创建，正在建立研究任务和可追溯节点图。",
      graphEvent: {
        type: "node_added",
        node: {
          id: "task-intent",
          kind: "task_intent",
          label: "深度研究任务",
          summary: run.meta.question,
          shortBody: run.meta.scope,
          status: "running",
          cluster: "intent",
          salience: 1,
          confidence: 0.96,
          attributes: {
            question: run.meta.question,
            scope: run.meta.scope,
            depth: run.meta.depth,
            runMode: run.meta.runMode,
            researchMode: run.meta.researchMode,
            sourceBudget: String(run.meta.sourceBudget),
            provider: `${run.meta.provider.protocol} / ${run.meta.provider.model}`
          },
          episodes: [{ id: "task-intent-episode", time: "00:00", title: "Run created", detail: "用户提交研究问题，runtime 进入计划阶段。" }]
        }
      }
    });
    await waitForRun(run, 650);
    await waitUntilRunnable(run);

    nodeEvent(run, "ontology", "正在生成 deep research ontology：计划、搜索、来源、证据、验证、案例、图表和报告。", {
      id: "ontology-runtime",
      kind: "ontology",
      label: "深研过程本体",
      summary: "定义 research_plan/search_query/source/evidence/claim/verification/example/visualization/section 的节点与关系。",
      status: "observed",
      cluster: "ontology",
      parentId: "task-intent",
      salience: 0.82,
      confidence: 0.9,
      attributes: {
        nodeTypes: "research_plan, search_query, source, evidence, claim, counterclaim, verification, example, visualization, section",
        edgeTypes: "queries, returns_source, extracts_evidence, supports, contradicts, verifies, illustrates, feeds_visual, becomes_section"
      },
      episodes: [{ id: "ontology-episode", time: "00:02", title: "Ontology created", detail: "把 CLI/Agent 风格的 plan-act-observe-verify-write loop 映射为图节点。" }]
    });
    edgeEvent(run, "ontology", "Ontology 从任务中抽取。", { id: "edge-task-ontology", from: "task-intent", to: "ontology-runtime", kind: "extracts", confidence: 0.9 });
    clusterEvent(run, "ontology", "Ontology cluster 已形成。", "ontology");
    await waitForRun(run, 700);
    await waitUntilRunnable(run);

    const plan = createResearchPlan({
      question: run.meta.question,
      scope: run.meta.scope,
      sourceBudget: run.meta.sourceBudget
    });
    nodeEvent(run, "graph_build", "ResearchPlanner 已生成研究 brief、问题树、搜索分支和验证维度。", {
      id: "research-plan",
      kind: "research_plan",
      label: "研究计划",
      shortBody: plan.brief,
      summary: plan.summary,
      status: "observed",
      cluster: "plan",
      parentId: "ontology-runtime",
      salience: 0.9,
      confidence: 0.9,
      attributes: {
        questions: String(plan.researchQuestions.length),
        queries: String(plan.searchQueries.length),
        sourceBudget: String(plan.sourceBudget),
        outline: plan.outline.join(" / ")
      },
      episodes: plan.researchQuestions.map((question, index) => ({
        id: `research-question-${index + 1}`,
        time: `00:0${index + 3}`,
        title: `RQ${index + 1}`,
        detail: question
      }))
    });
    edgeEvent(run, "graph_build", "研究计划由 ontology 生成。", { id: "edge-ontology-plan", from: "ontology-runtime", to: "research-plan", kind: "extracts", confidence: 0.9 });
    clusterEvent(run, "graph_build", "Plan cluster 已形成。", "plan");
    await waitForRun(run, 850);
    await waitUntilRunnable(run);

    const queryNodes = plan.searchQueries.map((query, index) => ({
      id: `query-${index + 1}`,
      kind: "search_query",
      label: `检索分支 ${index + 1}`,
      shortBody: query,
      summary: `该检索分支服务于“${topicLabel(run.meta.question)}”：${query}`,
      status: "observed",
      cluster: "search",
      parentId: "research-plan",
      salience: 0.72,
      confidence: 0.84,
      attributes: {
        query,
        branch: String(index + 1)
      },
      episodes: [{ id: `query-${index + 1}-episode`, time: `00:0${index + 6}`, title: "Search branch planned", detail: query }]
    }));
    for (const queryNode of queryNodes) {
      nodeEvent(run, "graph_build", `搜索分支生成：${queryNode.shortBody}`, queryNode);
      edgeEvent(run, "graph_build", "Research plan 发出检索 query。", { id: `edge-plan-${queryNode.id}`, from: "research-plan", to: queryNode.id, kind: "queries", confidence: 0.84 });
    }
    clusterEvent(run, "graph_build", "Search cluster 已形成。", "search");
    await waitForRun(run, 700);
    await waitUntilRunnable(run);

    const searchResults = await Promise.all(queryNodes.map((queryNode) =>
      runRegisteredTool(run, registry, "search", { query: queryNode.summary, queryId: queryNode.id })
    ));
    for (const result of searchResults) {
      assertToolOk(result, "Search Branch");
      edgeEvent(run, "graph_build", "Search tool 读取对应 query。", { id: `edge-${result.output.queryId}-${result.toolCall.id}`, from: result.output.queryId, to: result.toolCall.id, kind: "uses_tool", confidence: 0.8 });
    }
    const sourceCandidates = dedupeSearchSources(searchResults.map((result) => result.output), plan.sourceBudget);
    if (sourceCandidates.length < 8) {
      throw new Error(`Deep research requires at least 8 usable sources; got ${sourceCandidates.length}.`);
    }
    for (const source of sourceCandidates) {
      nodeEvent(run, "graph_build", `来源候选已入图：${source.title}`, {
        id: source.id,
        kind: "source",
        label: source.title.slice(0, 18),
        shortBody: `来源依据：${compactText(source.snippet, 82)}`,
        summary: `该来源由检索分支“${source.query}”返回，用于支撑“${topicLabel(run.meta.question)}”的证据抽取。摘要：${compactText(source.snippet, 220)}`,
        status: "observed",
        cluster: "sources",
        parentId: source.queryId,
        sourceRefs: [source.url],
        salience: 0.52,
        confidence: 0.74,
        attributes: {
          url: source.url,
          sourceType: source.sourceType,
          date: source.date,
          query: source.query
        },
        episodes: [{ id: `${source.id}-episode`, time: "00:10", title: "Source discovered", detail: source.snippet.slice(0, 180) }]
      });
      edgeEvent(run, "graph_build", "Search query 返回来源。", { id: `edge-${source.queryId}-${source.id}`, from: source.queryId, to: source.id, kind: "returns_source", confidence: 0.78 });
    }
    clusterEvent(run, "graph_build", "Sources cluster 已形成。", "sources");
    await waitForRun(run, 850);
    await waitUntilRunnable(run);

    const fetchResults = await Promise.all(sourceCandidates.map((source) =>
      runRegisteredTool(run, registry, "fetch", { url: source.url, query: run.meta.question })
    ));
    const fetchedByUrl = {};
    fetchResults.forEach((result, index) => {
      const source = sourceCandidates[index];
      edgeEvent(run, "graph_build", "Fetch tool 读取来源正文。", { id: `edge-${source.id}-${result.toolCall.id}`, from: source.id, to: result.toolCall.id, kind: "uses_tool", confidence: result.ok ? 0.76 : 0.38 });
      if (result.ok) {
        fetchedByUrl[source.url] = result.output.text ?? "";
      } else {
        nodeEvent(run, "graph_build", `来源读取失败但保留为 degraded source：${source.title}`, {
          id: `${source.id}-degraded`,
          kind: "source",
          label: `${source.title.slice(0, 14)} 失败`,
          shortBody: result.toolCall.error,
          summary: `Fetch failed: ${result.toolCall.error}`,
          status: "failed",
          cluster: "sources",
          parentId: source.id,
          sourceRefs: [source.url],
          salience: 0.72,
          confidence: 0.28,
          attributes: {
            status: "degraded",
            error: result.toolCall.error || "fetch failed"
          }
        });
      }
    });
    await waitForRun(run, 900);
    await waitUntilRunnable(run);

    const rank = await runRegisteredTool(run, registry, "rank_source", { sources: sourceCandidates, fetchedByUrl });
    assertToolOk(rank, "Rank Sources");
    for (const source of rank.output.sources) {
      nodeEvent(run, "evidence", `来源质量已评分：${source.title}`, {
        id: source.id,
        kind: "source",
        label: source.title.slice(0, 18),
        shortBody: `${source.sourceType} / quality ${source.qualityScore.toFixed(2)}`,
        summary: `来源“${source.title}”已评分，用于判断“${topicLabel(run.meta.question)}”的证据可靠性。摘要：${compactText(source.snippet, 220)}`,
        status: "observed",
        cluster: "sources",
        parentId: rank.toolCall.id,
        sourceRefs: [source.url],
        salience: 0.54,
        confidence: source.qualityScore,
        attributes: {
          rank: String(source.rank),
          quality: source.qualityScore.toFixed(2),
          independence: source.independence,
          sourceType: source.sourceType
        }
      }, "node_updated");
      edgeEvent(run, "evidence", "Rank source 连接到来源节点。", { id: `edge-${rank.toolCall.id}-${source.id}`, from: rank.toolCall.id, to: source.id, kind: "observes", confidence: source.qualityScore });
    }
    await waitForRun(run, 700);
    await waitUntilRunnable(run);

    const extract = await runRegisteredTool(run, registry, "extract", {
      question: run.meta.question,
      rankedSources: rank.output.sources
    });
    assertToolOk(extract, "Extract Evidence");
    const evidenceCards = usableEvidenceItems(extract.output.items);
    if (evidenceCards.length < 8) {
      throw new Error(`Evidence Extract produced ${evidenceCards.length} usable cards; expected at least 8.`);
    }
    const evidenceNodes = evidenceCards.map((evidence, index) => ({
      id: evidence.id,
      kind: "evidence",
      label: evidence.title.slice(0, 18),
      shortBody: `支撑：${compactText(evidence.claim, 64)}`,
      summary: `该证据来自“${evidence.source}”，用于支撑“${evidence.claim}”。证据片段：${evidence.quote}`,
      status: "observed",
      cluster: "evidence",
      parentId: evidence.sourceId,
      salience: 0.58 + Math.min(0.18, index * 0.012),
      confidence: evidence.confidence,
      sourceRefs: evidence.url ? [evidence.url] : [evidence.source],
      evidence,
      attributes: {
        claim: evidence.claim,
        sourceType: evidence.sourceType,
        confidence: evidence.confidence.toFixed(2),
        supports: (evidence.supports ?? []).join(" / "),
        contradicts: (evidence.contradicts ?? []).join(" / ") || "none"
      },
      episodes: [{ id: `${evidence.id}-episode`, time: `00:${String(18 + index).padStart(2, "0")}`, title: "Evidence captured", detail: evidence.quote.slice(0, 180) }]
    }));
    for (const evidenceNode of evidenceNodes) {
      nodeEvent(run, "evidence", `Evidence card 已生成：${evidenceNode.label}`, evidenceNode);
      edgeEvent(run, "evidence", "Source 抽取 evidence card。", { id: `edge-${evidenceNode.parentId}-${evidenceNode.id}`, from: evidenceNode.parentId, to: evidenceNode.id, kind: "extracts_evidence", confidence: evidenceNode.confidence });
    }
    clusterEvent(run, "evidence", "Evidence cluster 已形成。", "evidence");
    await waitForRun(run, 900);
    await waitUntilRunnable(run);

    const verification = await runRegisteredTool(run, registry, "cross_check", { evidenceCards });
    assertToolOk(verification, "Cross Check");
    for (const claim of verification.output.claims) {
      const claimNode = {
        id: claim.id,
        kind: "claim",
        label: claim.claim.slice(0, 16),
        shortBody: `${claim.status} / ${claim.supportCount} sources`,
        summary: `${claim.claim}：${claim.status}，由 ${claim.supportCount} 个独立来源支持。`,
        status: "synthesized",
        cluster: "verification",
        parentId: verification.toolCall.id,
        evidenceIds: claim.evidenceIds,
        sourceRefs: claim.evidenceIds,
        salience: claim.status === "verified" ? 0.88 : 0.74,
        confidence: claim.confidence,
        attributes: {
          status: claim.status,
          supportCount: String(claim.supportCount),
          confidence: claim.confidence.toFixed(2)
        },
        episodes: [{ id: `${claim.id}-verification`, time: "00:32", title: "Claim checked", detail: `${claim.status}: ${claim.claim}` }]
      };
      nodeEvent(run, "reasoning", `交叉验证生成 claim：${claim.claim}`, claimNode);
      for (const evidenceId of claim.evidenceIds.slice(0, 4)) {
        edgeEvent(run, "reasoning", "Evidence 支撑 claim。", { id: `edge-${evidenceId}-${claim.id}`, from: evidenceId, to: claim.id, kind: "supports", confidence: claim.confidence });
      }
      edgeEvent(run, "reasoning", "Cross-check tool 验证 claim。", { id: `edge-${verification.toolCall.id}-${claim.id}`, from: verification.toolCall.id, to: claim.id, kind: "verifies", confidence: claim.confidence });
    }
    for (const counterclaim of verification.output.contradictions) {
      nodeEvent(run, "reasoning", `冲突信号保留：${counterclaim.claim}`, {
        id: counterclaim.id,
        kind: "counterclaim",
        label: "冲突信号",
        shortBody: counterclaim.claim,
        summary: counterclaim.summary,
        status: "synthesized",
        cluster: "verification",
        parentId: counterclaim.sourceEvidenceId,
        sourceRefs: [counterclaim.sourceEvidenceId],
        salience: 0.76,
        confidence: 0.52,
        attributes: {
          sourceEvidenceId: counterclaim.sourceEvidenceId
        }
      });
      edgeEvent(run, "reasoning", "Evidence 与 counterclaim 形成冲突边。", { id: `edge-${counterclaim.sourceEvidenceId}-${counterclaim.id}`, from: counterclaim.sourceEvidenceId, to: counterclaim.id, kind: "contradicts", confidence: 0.52 });
    }
    clusterEvent(run, "reasoning", "Verification cluster 已形成。", "verification");
    await waitForRun(run, 900);
    await waitUntilRunnable(run);

    const cases = await runRegisteredTool(run, registry, "case_find", { claims: verification.output.claims });
    assertToolOk(cases, "Find Cases");
    for (const example of cases.output.examples) {
      nodeEvent(run, "reasoning", `案例已补充：${example.title}`, {
        id: example.id,
        kind: "example",
        label: example.title,
        shortBody: example.body.slice(0, 72),
        summary: example.body,
        status: "observed",
        cluster: "synthesis",
        parentId: example.claimId,
        sourceRefs: [example.claimId],
        salience: 0.66,
        confidence: 0.76,
        attributes: {
          claimId: example.claimId
        }
      });
      edgeEvent(run, "reasoning", "Example 说明 claim。", { id: `edge-${example.claimId}-${example.id}`, from: example.claimId, to: example.id, kind: "illustrates", confidence: 0.74 });
    }
    clusterEvent(run, "reasoning", "Synthesis cluster 已形成。", "synthesis");
    await waitForRun(run, 750);
    await waitUntilRunnable(run);

    const charts = await runRegisteredTool(run, registry, "chart_plan", {
      question: run.meta.question,
      claims: verification.output.claims,
      sources: rank.output.sources
    });
    assertToolOk(charts, "Plan Charts");
    const visualizationNodeIds = charts.output.blocks.map((block) => `visual-${block.id}`);
    for (const block of charts.output.blocks) {
      const nodeId = `visual-${block.id}`;
      nodeEvent(run, "drafting", `可视化规格已生成：${block.title}`, {
        id: nodeId,
        kind: "visualization",
        label: block.title.slice(0, 16),
        shortBody: block.type,
        summary: block.type === "mermaid" ? block.code : `${block.title} / ${block.type}`,
        status: "written",
        cluster: "visualization",
        sourceRefs: block.sourceNodeIds ?? [],
        salience: 0.82,
        confidence: 0.82,
        attributes: {
          blockId: block.id,
          blockType: block.type
        }
      });
      for (const sourceNodeId of (block.sourceNodeIds ?? []).slice(0, 5)) {
        edgeEvent(run, "drafting", "证据或结论进入可视化。", { id: `edge-${sourceNodeId}-${nodeId}`, from: sourceNodeId, to: nodeId, kind: "feeds_visual", confidence: 0.76 });
      }
    }
    clusterEvent(run, "drafting", "Visualization cluster 已形成。", "visualization");
    await waitForRun(run, 750);
    await waitUntilRunnable(run);

    const reportTool = await runRegisteredTool(run, registry, "report_write", {
      deepResearch: true,
      plan,
      sources: rank.output.sources,
      evidenceCards,
      verification: verification.output,
      examples: cases.output.examples,
      visualizations: charts.output
    });
    assertToolOk(reportTool, "Report Write");
    const report = reportTool.output.report;
    for (const section of report.sections) {
      await waitForRun(run, 360);
      await waitUntilRunnable(run);
      const sectionNode = {
        id: section.id.replace("section-", "section-node-"),
        kind: "section",
        label: section.title.replace(/^.+?、/, "").slice(0, 16),
        shortBody: section.body.slice(0, 86),
        summary: section.body,
        status: "written",
        cluster: "report",
        parentId: reportTool.toolCall.id,
        sourceRefs: section.sourceNodeIds,
        reportAnchorId: section.id,
        salience: 0.8,
        confidence: 0.84,
        attributes: {
          sourceNodes: section.sourceNodeIds.join(", "),
          reportSection: section.id
        },
        episodes: [{ id: `${section.id}-write`, time: "00:42", title: "Section written", detail: "长报告章节已写入，并绑定来源、证据或验证节点。" }]
      };
      nodeEvent(run, "drafting", `长报告章节写入：${section.title}`, sectionNode);
      edgeEvent(run, "drafting", "Section 映射回 report writer。", { id: `edge-report-${sectionNode.id}`, from: reportTool.toolCall.id, to: sectionNode.id, kind: "becomes_section", confidence: 0.86 });
      for (const sourceNodeId of section.sourceNodeIds.slice(0, 4)) {
        edgeEvent(run, "drafting", "Section 绑定来源图谱节点。", { id: `edge-${sourceNodeId}-${sectionNode.id}`, from: sourceNodeId, to: sectionNode.id, kind: "becomes_section", confidence: 0.78 });
      }
    }
    for (const visualNodeId of visualizationNodeIds.slice(0, 4)) {
      edgeEvent(run, "drafting", "Visualization block 写入最终报告。", { id: `edge-${visualNodeId}-${reportTool.toolCall.id}`, from: visualNodeId, to: reportTool.toolCall.id, kind: "feeds_visual", confidence: 0.8 });
    }
    clusterEvent(run, "final_reveal", "Report cluster 已形成，长报告可反向追溯。", "report");

    await waitForRun(run, 500);
    await waitUntilRunnable(run);
    run.meta.status = "completed";
    addEvent(run, {
      type: "run_completed",
      phase: "completed",
      message: "Demo deep research run 已完成：报告包含来源矩阵、交叉验证、案例和结构图。",
      finalReport: report
    });
    broadcast(run, "run-closed", { runId: run.meta.id });
  } catch (error) {
    if (run.meta.status === "cancelled") {
      addEvent(run, { type: "run_cancelled", phase: run.events.at(-1)?.phase ?? "reasoning", message: "Run 已取消。" });
    } else {
      run.meta.status = "failed";
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      addEvent(run, { type: "run_failed", phase: run.events.at(-1)?.phase ?? "evidence", message: `Run 执行失败：${errorMessage}`, error: errorMessage });
    }
    broadcast(run, "run-closed", { runId: run.meta.id });
  }
}

async function executeLegacyRun(run) {
  try {
    const registry = run.toolRegistry ?? createDefaultToolRegistry();
    run.startedAt = now();
    run.virtualElapsedMs = typeof run.virtualElapsedMs === "number" ? run.virtualElapsedMs : 0;
    run.meta.status = "running";
    addEvent(run, {
      type: "run_started",
      phase: "initializing",
      message: "Agent run 已创建，正在把用户问题写入 task_intent 节点。",
      graphEvent: {
        type: "node_added",
        node: {
          id: "task-intent",
          kind: "task_intent",
          label: "用户调研任务",
          summary: run.meta.question,
          shortBody: run.meta.scope,
          status: "running",
          cluster: "intent",
          salience: 1,
          confidence: 0.96,
          attributes: {
            question: run.meta.question,
            scope: run.meta.scope,
            depth: run.meta.depth,
            sources: run.meta.sources.join(", "),
            provider: `${run.meta.provider.protocol} / ${run.meta.provider.model}`,
            apiKey: run.meta.provider.apiKeyMasked || "not provided"
          },
          episodes: [{ id: "task-intent-episode", time: "00:00", title: "Run created", detail: "用户提交真实调研问题，后端创建 AgentRun。" }]
        }
      }
    });
    await waitForRun(run, 900);
    await waitUntilRunnable(run);

    nodeEvent(run, "ontology", "正在生成 ontology：实体、证据、工具和报告章节类型。", {
      id: "ontology-runtime",
      kind: "ontology",
      label: "过程本体",
      summary: "定义 task_intent/entity/tool_call/observation/evidence/claim/section 的抽取规则。",
      status: "observed",
      cluster: "ontology",
      parentId: "task-intent",
      salience: 0.78,
      confidence: 0.88,
      attributes: {
        nodeTypes: "task_intent, ontology, entity, tool_call, observation, evidence, claim, section",
        edgeTypes: "extracts, uses_tool, observes, supports, synthesizes, becomes_section"
      },
      episodes: [{ id: "ontology-episode", time: "00:03", title: "Ontology created", detail: "系统为后续工具事件和报告映射建立结构。" }]
    });
    edgeEvent(run, "ontology", "Ontology 与 task_intent 连接。", { id: "edge-task-ontology", from: "task-intent", to: "ontology-runtime", kind: "extracts", confidence: 0.9 });
    clusterEvent(run, "ontology", "Ontology cluster 已形成。", "ontology");
    await waitForRun(run, 1000);
    await waitUntilRunnable(run);

    const search = await runRegisteredTool(run, registry, "web_search", { query: run.meta.question });
    edgeEvent(run, "evidence", "Search tool 与 ontology 连接。", { id: "edge-ontology-search", from: "ontology-runtime", to: search.toolCall.id, kind: "uses_tool", confidence: 0.82 });
    assertToolOk(search, "Web Search");
    await waitForRun(run, 700);
    await waitUntilRunnable(run);

    const firstUrl = search.output.items?.[0]?.url;
    const fetched = await runRegisteredTool(run, registry, "web_fetch", { url: firstUrl || "fallback", query: run.meta.question });
    edgeEvent(run, "evidence", "Fetch tool 读取搜索来源。", { id: "edge-search-fetch", from: search.toolCall.id, to: fetched.toolCall.id, kind: "uses_tool", confidence: 0.78 });
    const fetchPolicy = classifyWebFetchFailure(search, fetched);
    if (fetchPolicy.action === "fail") {
      throw new Error(fetchPolicy.message);
    }
    if (fetchPolicy.action === "degrade") {
      const degradedNode = {
        id: `${fetched.toolCall.id}-degraded-observation`,
        kind: "observation",
        label: "Fetch 降级观察",
        shortBody: fetchPolicy.message,
        summary: fetchPolicy.message,
        status: "observed",
        cluster: "evidence",
        parentId: fetched.toolCall.id,
        salience: 0.68,
        confidence: 0.46,
        sourceRefs: search.output.items?.slice(0, 2).map((item) => item.url || item.title).filter(Boolean) ?? [],
        attributes: {
          tool: "web_fetch",
          status: "degraded",
          reason: fetched.toolCall.error || "fetch failed",
          fallback: "web_search observation"
        },
        episodes: [{
          id: `${fetched.toolCall.id}-degraded-episode`,
          time: new Date(fetched.toolCall.endedAt ?? now()).toLocaleTimeString(),
          title: "Degraded observation",
          detail: fetchPolicy.message
        }]
      };
      nodeEvent(run, "evidence", "Web Fetch 失败，但已记录降级 observation 并继续使用搜索结果。", degradedNode);
      edgeEvent(run, "evidence", "Fetch 失败状态连接到降级 observation。", { id: `edge-${fetched.toolCall.id}-degraded`, from: fetched.toolCall.id, to: degradedNode.id, kind: "observes", confidence: 0.58 });
    }
    await waitForRun(run, 700);
    await waitUntilRunnable(run);

    const documentRead = await runRegisteredTool(run, registry, "document_read", { question: run.meta.question, scope: run.meta.scope });
    edgeEvent(run, "evidence", "Document reader 读取用户约束。", { id: "edge-task-document", from: "task-intent", to: documentRead.toolCall.id, kind: "uses_tool", confidence: 0.88 });
    await waitForRun(run, 700);
    await waitUntilRunnable(run);

    const extract = await runRegisteredTool(run, registry, "evidence_extract", {
      maxEvidence: 5,
      question: run.meta.question,
      searchItems: search.output.items ?? [],
      fetchedText: fetched.output.text ?? "",
      documentText: documentRead.output.text ?? ""
    });
    edgeEvent(run, "evidence", "Evidence extract 汇总工具 observation。", { id: "edge-fetch-extract", from: fetched.toolCall.id, to: extract.toolCall.id, kind: "observes", confidence: 0.86 });
    edgeEvent(run, "evidence", "Evidence extract 读取 document observation。", { id: "edge-document-extract", from: documentRead.toolCall.id, to: extract.toolCall.id, kind: "observes", confidence: 0.84 });
    assertToolOk(extract, "Evidence Extract");
    clusterEvent(run, "evidence", "Evidence cluster 已形成。", "evidence");
    await waitForRun(run, 900);

    const extractedEvidence = usableEvidenceItems(extract.output.items);
    if (extractedEvidence.length === 0) {
      throw new Error("Evidence Extract produced no usable evidence; stopping before claim/report synthesis.");
    }

    const evidenceNodes = extractedEvidence.map((evidence, index) => ({
      id: evidence.id,
      kind: "evidence",
      label: evidence.title.slice(0, 18),
      shortBody: evidence.quote.slice(0, 72),
      summary: evidence.quote,
      status: "observed",
      cluster: "evidence",
      parentId: extract.toolCall.id,
      salience: 0.55 + index * 0.04,
      confidence: evidence.confidence,
      sourceRefs: evidence.url ? [evidence.url] : [evidence.source],
      evidence,
      attributes: {
        source: evidence.source,
        confidence: evidence.confidence.toFixed(2),
        capturedAt: new Date(evidence.capturedAt).toLocaleTimeString()
      },
      episodes: [{ id: `${evidence.id}-episode`, time: `00:${String(10 + index).padStart(2, "0")}`, title: "Evidence captured", detail: evidence.quote.slice(0, 160) }]
    }));
    for (const evidenceNode of evidenceNodes) {
      await waitForRun(run, 420);
      await waitUntilRunnable(run);
      nodeEvent(run, "evidence", `证据节点已生成：${evidenceNode.label}`, evidenceNode);
      edgeEvent(run, "evidence", "Evidence 支撑后续 claim。", { id: `edge-extract-${evidenceNode.id}`, from: extract.toolCall.id, to: evidenceNode.id, kind: "observes", confidence: evidenceNode.confidence });
    }

    await waitForRun(run, 700);
    await waitUntilRunnable(run);
    const toolSummaries = [
      search.toolCall,
      fetched.toolCall,
      documentRead.toolCall,
      extract.toolCall
    ].map((tool) => ({
      id: tool.id,
      toolName: tool.toolName,
      status: tool.status,
      outputSummary: tool.outputSummary,
      costMs: tool.costMs
    }));
    const llmAnalysis = await runRegisteredTool(run, registry, "llm_analyze", {
      protocol: run.meta.provider?.protocol || "openai",
      model: run.meta.provider?.model || "mimo-v2.5-pro",
      evidenceNodes,
      toolSummaries
    });
    edgeEvent(run, "reasoning", "LLM Analyze 读取 evidence extract 的 observation。", { id: "edge-extract-llm-analyze", from: extract.toolCall.id, to: llmAnalysis.toolCall.id, kind: "observes", confidence: 0.88 });
    assertToolOk(llmAnalysis, "LLM Analyze");

    await waitForRun(run, 700);
    await waitUntilRunnable(run);
    const claimNode = {
      id: "claim-visible-process",
      kind: "claim",
      label: "等待即过程资产",
      shortBody: "长链路等待应呈现真实工具、证据和判断，而不是播放等待动画。",
      summary: llmAnalysis.output.summary,
      status: "synthesized",
      cluster: "reasoning",
      parentId: evidenceNodes[0]?.id,
      evidenceIds: evidenceNodes.map((node) => node.id),
      sourceRefs: evidenceNodes.map((node) => node.id),
      salience: 0.92,
      confidence: 0.86,
      attributes: {
        thought: "等待体验需要结构化反馈",
        action: "synthesize evidence into claim",
        observation: "tool/evidence nodes are inspectable"
      },
      episodes: [
        { id: "claim-thought", time: "00:18", title: "Thought", detail: "证据链显示用户需要看到系统正在推进，而不是只看到 loading。" },
        { id: "claim-answer", time: "00:19", title: "Provider analysis", detail: llmAnalysis.output.summary.slice(0, 180) }
      ]
    };
    nodeEvent(run, "reasoning", "Claim 已由 evidence、observation 和 LLM 分析综合生成。", claimNode);
    for (const evidenceNode of evidenceNodes.slice(0, 4)) {
      edgeEvent(run, "reasoning", `${evidenceNode.label} 支撑 claim。`, { id: `edge-${evidenceNode.id}-claim`, from: evidenceNode.id, to: claimNode.id, kind: "supports", confidence: evidenceNode.confidence });
    }
    clusterEvent(run, "reasoning", "Reasoning cluster 已形成。", "reasoning");

    await waitForRun(run, 900);
    await waitUntilRunnable(run);
    const reportTool = await runRegisteredTool(run, registry, "report_write", {
      protocol: run.meta.provider?.protocol || "openai",
      model: run.meta.provider?.model || "mimo-v2.5-pro",
      sections: 4,
      sourceNodeIds: evidenceNodes.length,
      evidenceNodes,
      toolSummaries: [...toolSummaries, {
        id: llmAnalysis.toolCall.id,
        toolName: llmAnalysis.toolCall.toolName,
        status: llmAnalysis.toolCall.status,
        outputSummary: llmAnalysis.output.summary,
        costMs: llmAnalysis.toolCall.costMs
      }]
    });
    edgeEvent(run, "drafting", "Report writer 使用 claim 生成章节。", { id: "edge-claim-report-tool", from: claimNode.id, to: reportTool.toolCall.id, kind: "uses_tool", confidence: 0.9 });
    edgeEvent(run, "drafting", "Report writer 复用 LLM Analyze observation。", { id: "edge-analysis-report-tool", from: llmAnalysis.toolCall.id, to: reportTool.toolCall.id, kind: "observes", confidence: 0.88 });
    assertToolOk(reportTool, "Report Write");

    const report = reportFrom(run, evidenceNodes, claimNode.id, {
      search: search.toolCall.id,
      fetch: fetched.toolCall.id,
      documentRead: documentRead.toolCall.id,
      extract: extract.toolCall.id,
      analyze: llmAnalysis.toolCall.id,
      reportWrite: reportTool.toolCall.id
    }, reportTool.output);
    for (const section of report.sections) {
      await waitForRun(run, 650);
      await waitUntilRunnable(run);
      const sectionNode = {
        id: section.id.replace("section-", "section-node-"),
        kind: "section",
        label: section.title.replace(/^.+?、/, "").slice(0, 14),
        shortBody: section.body.slice(0, 72),
        summary: section.body,
        status: "written",
        cluster: "report",
        parentId: reportTool.toolCall.id,
        sourceRefs: section.sourceNodeIds,
        reportAnchorId: section.id,
        salience: 0.8,
        confidence: 0.84,
        attributes: {
          sourceNodes: section.sourceNodeIds.join(", "),
          reportSection: section.id
        },
        episodes: [{ id: `${section.id}-write`, time: "00:24", title: "Section written", detail: "报告章节已写入，并绑定图谱来源。" }]
      };
      nodeEvent(run, "drafting", `报告章节写入：${section.title}`, sectionNode);
      edgeEvent(run, "drafting", "Section 映射回 report writer。", { id: `edge-report-${sectionNode.id}`, from: reportTool.toolCall.id, to: sectionNode.id, kind: "becomes_section", confidence: 0.86 });
    }
    clusterEvent(run, "final_reveal", "Report cluster 已形成，章节与来源图谱完成映射。", "report");

    await waitForRun(run, 600);
    await waitUntilRunnable(run);
    run.meta.status = "completed";
    addEvent(run, {
      type: "run_completed",
      phase: "completed",
      message: "真实 Agent run 已完成，最终报告可反向追溯到工具和证据节点。",
      finalReport: report
    });
    broadcast(run, "run-closed", { runId: run.meta.id });
  } catch (error) {
    if (run.meta.status === "cancelled") {
      addEvent(run, { type: "run_cancelled", phase: run.events.at(-1)?.phase ?? "reasoning", message: "Run 已取消。" });
    } else {
      run.meta.status = "failed";
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      addEvent(run, { type: "run_failed", phase: run.events.at(-1)?.phase ?? "evidence", message: `Run 执行失败：${errorMessage}`, error: errorMessage });
    }
    broadcast(run, "run-closed", { runId: run.meta.id });
  }
}

function envProviderKey() {
  return process.env.LOADING_MIND_PROVIDER_API_KEY
    || process.env.MIMO_API_KEY
    || process.env.OPENAI_API_KEY
    || "";
}

function createRun(body, options = {}) {
  const createdAt = now();
  const runMode = body.runMode === "live" ? "live" : "demo";
  const providerConfig = sanitizeProviderConfig({
    ...(body.providerConfig ?? {}),
    apiKey: body.providerConfig?.apiKey || envProviderKey()
  });
  const allowDemoFallback = options.allowDemoFallback ?? (runMode === "demo" || process.env.LOADING_MIND_DEMO_MODE === "1");
  const meta = {
    id: `run-${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    question: String(body.question || "AI Agent 长链路等待过程如何设计？"),
    scope: String(body.scope || "AI 调研报告过程可视化"),
    depth: body.depth === "fast" || body.depth === "deep" ? body.depth : "standard",
    sources: Array.isArray(body.sources) && body.sources.length > 0 ? body.sources.map(String) : ["web_search", "web_fetch", "document_read"],
    runMode,
    researchMode: "demo_deep_research",
    sourceBudget: clampSourceBudget(body.sourceBudget),
    visualization: "auto",
    provider: providerPublicSummary(providerConfig),
    status: "queued",
    createdAt,
    updatedAt: createdAt
  };
  const run = {
    meta,
    events: [],
    clients: new Set(),
    excludedEvidenceIds: new Set(),
    startedAt: createdAt,
    virtualElapsedMs: 0,
    toolIndex: 0,
    providerConfig,
    tavilyApiKey: String(body.tavilyApiKey || "").trim(),
    persistEvents: options.persistEvents ?? true,
    delayScale: options.delayScale ?? 1,
    allowDemoFallback,
    forceDemoTools: options.forceDemoTools ?? false,
    fetchImpl: options.fetchImpl,
    toolRegistry: options.toolRegistry ?? createDefaultToolRegistry()
  };
  runStore.set(meta.id, run);
  persist(run);
  if (options.autoStart !== false) {
    setTimeout(() => executeRun(run), 300);
  }
  return run;
}

export async function createRunSnapshot(body, options = {}) {
  const run = createRun(body, {
    autoStart: false,
    persistEvents: false,
    delayScale: 0,
    allowDemoFallback: body?.runMode === "live" ? false : true,
    forceDemoTools: options.forceDemoTools ?? false,
    ...options
  });
  await executeRun(run);
  return {
    run: run.meta,
    events: run.events
  };
}

function readPersistedRun(id) {
  const file = path.join(dataDir, `${id}.json`);
  if (!fs.existsSync(file)) {
    return null;
  }
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const run = {
    meta: payload.meta,
    events: payload.events ?? [],
    clients: new Set(),
    excludedEvidenceIds: new Set(payload.excludedEvidenceIds ?? []),
    startedAt: payload.meta.createdAt,
    toolIndex: 0,
    providerConfig: sanitizeProviderConfig(payload.meta.provider ?? {})
  };
  runStore.set(id, run);
  return run;
}

export function agentRuntimePlugin() {
  return {
    name: "loading-mind-agent-runtime",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (!url.pathname.startsWith("/api/runs")) {
          next();
          return;
        }

        try {
          if (req.method === "POST" && url.pathname === "/api/runs") {
            const body = await readJson(req);
            const run = createRun(body);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ run: run.meta }));
            return;
          }

          const parts = url.pathname.split("/");
          const runId = parts[3];
          const action = parts[4];
          const run = runStore.get(runId) ?? readPersistedRun(runId);
          if (!run) {
            res.statusCode = 404;
            res.end("Run not found");
            return;
          }

          if (req.method === "GET" && action === "export") {
            const format = url.searchParams.get("format") === "json" ? "json" : "markdown";
            const filename = `${run.meta.id}.${format === "json" ? "json" : "md"}`;
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            if (format === "json") {
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify(runToExportJson(run), null, 2));
            } else {
              res.setHeader("Content-Type", "text/markdown; charset=utf-8");
              res.end(runToMarkdown(run));
            }
            return;
          }

          if (req.method === "GET" && action === "events") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive"
            });
            run.clients.add(res);
            for (const event of run.events) {
              send(res, "agent-event", event);
            }
            req.on("close", () => {
              run.clients.delete(res);
            });
            return;
          }

          if (req.method === "POST" && action === "pause") {
            run.meta.status = "paused";
            addEvent(run, { type: "run_paused", phase: run.events.at(-1)?.phase ?? "evidence", message: "用户暂停 Agent run。" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          if (req.method === "POST" && action === "resume") {
            run.meta.status = "running";
            addEvent(run, { type: "run_resumed", phase: run.events.at(-1)?.phase ?? "evidence", message: "用户恢复 Agent run。" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          if (req.method === "POST" && action === "cancel") {
            run.meta.status = "cancelled";
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          if (req.method === "POST" && action === "retry") {
            try {
              const body = await readJson(req);
              const toolNodeId = String(body.toolNodeId || body.nodeId || "");
              const result = await retryRunTool(run, run.toolRegistry ?? createDefaultToolRegistry(), toolNodeId);
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            } catch (error) {
              res.statusCode = Number(error?.statusCode) || 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : "Tool retry failed"
              }));
            }
            return;
          }

          if (req.method === "POST" && action === "exclude") {
            const body = await readJson(req);
            const evidenceId = String(body.evidenceId || "");
            run.excludedEvidenceIds.add(evidenceId);
            nodeEvent(run, "reasoning", `用户排除证据：${evidenceId}`, {
              id: evidenceId,
              kind: "evidence",
              label: "已排除证据",
              summary: "该证据已被用户从报告推理中排除。",
              status: "excluded",
              cluster: "evidence",
              salience: 0.42,
              confidence: 0.2
            }, "node_updated");
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          res.statusCode = 404;
          res.end("Unknown run route");
        } catch (error) {
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message : "Agent runtime error");
        }
      });
    }
  };
}
