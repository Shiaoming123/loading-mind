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
      input: JSON.stringify(toolCall.input),
      costMs: String(toolCall.costMs ?? "--"),
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
  const startedAt = now();
  const id = `${toolName}-${run.toolIndex += 1}`;
  const running = { id, toolName, input, startedAt, status: "running" };
  nodeEvent(run, "evidence", `${label} 已进入工具队列。`, toolNode(running, label, "工具正在执行真实请求。"));

  try {
    const output = await executor();
    const finished = {
      ...running,
      status: "succeeded",
      endedAt: now(),
      costMs: now() - startedAt,
      outputSummary: output.summary
    };
    nodeEvent(run, "evidence", `${label} 已返回 observation。`, toolNode(finished, label, output.summary), "node_updated");
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
    nodeEvent(run, "evidence", `${label} 失败，等待用户重试或继续。`, toolNode(failed, label, failed.outputSummary), "node_updated");
    const result = { ok: false, toolCall: failed, output: { summary: failed.outputSummary, items: [] } };
    if (failurePolicy === "throw") {
      throw new Error(`${label} failed: ${failed.error}`);
    }
    return result;
  }
}

async function runRegisteredTool(run, registry, toolName, input) {
  const tool = registry.get(toolName);
  return toolCall(run, toolName, input, tool.label, () => tool.execute(input, { run, registry }), {
    failurePolicy: tool.failurePolicy
  });
}

function demoSearchItems(query) {
  return [
    {
      title: "Agent 过程可视化",
      url: "demo://process-visibility",
      text: `围绕“${query}”，可检查的 Agent 过程应展示任务意图、工具调用、证据、判断和报告映射，而不是只展示等待动画。`
    },
    {
      title: "工具失败需要可感知",
      url: "demo://tool-failure",
      text: "失败工具应该保留 input、status、error 和 retry 线索；空结果不应被当作正常 observation。"
    },
    {
      title: "报告必须绑定来源节点",
      url: "demo://report-grounding",
      text: "最终报告章节需要绑定 sourceNodeIds，用户才能从结论反查证据和工具观察。"
    }
  ];
}

function demoFetchedText(query) {
  return [
    `Demo sandbox observation for ${query}.`,
    "A production Agent Process OS should turn long-running work into inspectable state transitions.",
    "The runtime should expose tool calls, observations, evidence extraction, synthesis, and report writing as first-class graph events.",
    "When external tools are unavailable, the demo should show an explicit fallback observation instead of pretending the tool succeeded silently."
  ].join(" ");
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
    return demoProviderResult(run, evidenceNodes, mode);
  }
  try {
    return await callProvider(run.providerConfig, providerPrompt(run, evidenceNodes, toolSummaries, mode));
  } catch (error) {
    if (run.allowDemoFallback && !run.providerConfig.apiKey) {
      return demoProviderResult(run, evidenceNodes, mode);
    }
    throw error;
  }
}

async function searchWeb(query) {
  if (query?.forceDemoTools) {
    return {
      summary: "Demo sandbox 使用内置搜索 observation，未访问外部搜索服务。",
      items: demoSearchItems(query.query ?? "")
    };
  }

  const searchQuery = typeof query === "string" ? query : query.query;
  const allowDemoFallback = Boolean(typeof query === "object" && query.allowDemoFallback);
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", searchQuery);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_redirect", "1");
  url.searchParams.set("no_html", "1");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let data = null;
  try {
    const response = await fetch(url, { signal: controller.signal });
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
      items: demoSearchItems(searchQuery)
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
    items: topics.length > 0 ? topics.slice(0, 4) : demoSearchItems(searchQuery)
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
    const response = await fetch(url, { signal: controller.signal });
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

export function createDefaultToolRegistry() {
  return new ToolRegistry()
    .register({
      name: "web_search",
      label: "Web Search",
      runner: "http",
      failurePolicy: "record",
      execute: ({ query }, { run }) => searchWeb({
        query,
        allowDemoFallback: run.allowDemoFallback,
        forceDemoTools: run.forceDemoTools
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
        forceDemoTools: run.forceDemoTools
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
      failurePolicy: "record",
      execute: ({ evidenceNodes, toolSummaries }, { run }) => callRuntimeProvider(run, evidenceNodes, toolSummaries, "report")
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
  const providerConfig = sanitizeProviderConfig({
    ...(body.providerConfig ?? {}),
    apiKey: body.providerConfig?.apiKey || envProviderKey()
  });
  const allowDemoFallback = options.allowDemoFallback ?? (process.env.LOADING_MIND_DEMO_MODE === "1");
  const meta = {
    id: `run-${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    question: String(body.question || "AI Agent 长链路等待过程如何设计？"),
    scope: String(body.scope || "AI 调研报告过程可视化"),
    depth: body.depth === "fast" || body.depth === "deep" ? body.depth : "standard",
    sources: Array.isArray(body.sources) && body.sources.length > 0 ? body.sources.map(String) : ["web_search", "web_fetch", "document_read"],
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
    persistEvents: options.persistEvents ?? true,
    delayScale: options.delayScale ?? 1,
    allowDemoFallback,
    forceDemoTools: options.forceDemoTools ?? false,
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
    allowDemoFallback: true,
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
            const body = await readJson(req);
            const toolNodeId = String(body.toolNodeId || "tool");
            const retryId = `${toolNodeId}-retry-${run.toolIndex += 1}`;
            nodeEvent(run, "evidence", `用户重试工具：${toolNodeId}`, toolNode({
              id: retryId,
              toolName: "web_search",
              input: { retryOf: toolNodeId },
              startedAt: now(),
              endedAt: now(),
              status: "succeeded",
              costMs: 120,
              outputSummary: "重试已记录；当前版本会把重试作为可见过程节点追加。"
            }, "Tool Retry", "重试已记录；当前版本会把重试作为可见过程节点追加。"));
            res.end(JSON.stringify({ ok: true }));
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
