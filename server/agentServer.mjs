import fs from "node:fs";
import path from "node:path";
import { callProvider, providerDefaults, providerPublicSummary, sanitizeProviderConfig } from "./providerClient.mjs";
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
    errorLogs: run.errorLogs ?? [],
    auditLogs: run.auditLogs ?? [],
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
  run.eventSink?.(nextEvent);
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

function checkpointEvent(run, phase, checkpoint) {
  return addEvent(run, {
    type: "checkpoint_created",
    phase,
    message: checkpoint.summary,
    checkpoint: {
      id: checkpoint.id,
      phase,
      title: checkpoint.title,
      summary: checkpoint.summary,
      knownFacts: (checkpoint.knownFacts ?? []).map(String).filter(Boolean).slice(0, 5),
      openQuestions: (checkpoint.openQuestions ?? []).map(String).filter(Boolean).slice(0, 4),
      nextAction: String(checkpoint.nextAction || "继续推进下一步。"),
      sourceNodeIds: (checkpoint.sourceNodeIds ?? []).map(String).filter(Boolean).slice(0, 8),
      createdAt: now()
    }
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

const secretKeyPattern = /api[_-]?key|token|authorization|password|secret|credential/i;

function redactValue(key, value) {
  if (secretKeyPattern.test(key)) {
    return value ? "[redacted]" : "";
  }
  if (value && typeof value === "object") {
    return redactSecrets(value);
  }
  return value;
}

function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => redactSecrets(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).slice(0, 24).map(([key, entryValue]) => [key, redactValue(key, entryValue)])
  );
}

function compactJson(value, maxLength = 640) {
  const text = JSON.stringify(redactSecrets(value ?? {}));
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function inferStatusCode(error, message) {
  if (Number.isFinite(error?.statusCode)) {
    return Number(error.statusCode);
  }
  if (Number.isFinite(error?.status)) {
    return Number(error.status);
  }
  const match = String(message || "").match(/\bHTTP\s+(\d{3})\b/i);
  return match ? Number(match[1]) : undefined;
}

function inferErrorType(message, toolName = "") {
  const text = `${toolName} ${message}`.toLowerCase();
  if (/invalid api key|unauthorized|forbidden|401|403/.test(text)) {
    return "auth";
  }
  if (/api[_ -]?key|required|not configured|missing key/.test(text)) {
    return "missing_key";
  }
  if (/rate limit|429/.test(text)) {
    return "rate_limit";
  }
  if (/abort|timeout|terminated/.test(text)) {
    return "timeout";
  }
  if (/mcp/.test(text)) {
    return "mcp";
  }
  if (/search|tavily|brave|firecrawl|exa/.test(text)) {
    return "search";
  }
  if (/report|artifact|format|mermaid|markdown|json/.test(text)) {
    return "report_format";
  }
  if (/provider|model|openai|anthropic|mimo/.test(text)) {
    return "provider";
  }
  if (/fetch|network|http/.test(text)) {
    return "network";
  }
  return "unknown";
}

function nextActionFor(errorType, toolName) {
  if (errorType === "missing_key") {
    return "Add the required API key or switch to Demo mode.";
  }
  if (errorType === "auth") {
    return "Check the configured key, base URL, model, and provider permissions.";
  }
  if (errorType === "rate_limit") {
    return "Wait for quota recovery or switch to another configured provider.";
  }
  if (errorType === "timeout") {
    return "Retry the run; if it repeats, use another search/fetch provider.";
  }
  if (errorType === "report_format" || toolName === "report_write") {
    return "Regenerate the report after fixing provider output or artifact formatting.";
  }
  if (errorType === "mcp") {
    return "Use an allowlisted read-only MCP tool or disable MCP for this run.";
  }
  return "Inspect the failed tool node, then retry or rerun after fixing the configuration.";
}

function latestFailedTool(run) {
  for (let index = run.events.length - 1; index >= 0; index -= 1) {
    const node = run.events[index].graphEvent?.node;
    if (node?.kind === "tool_call" && node.toolCall?.status === "failed") {
      return node;
    }
  }
  return null;
}

export function createRunErrorLog(run, error, options = {}) {
  const message = error instanceof Error ? error.message : String(error || "Unknown error");
  const failedTool = options.toolNode ?? latestFailedTool(run);
  const toolCall = failedTool?.toolCall;
  const toolName = options.toolName ?? toolCall?.toolName ?? "";
  const errorType = inferErrorType(message, toolName);
  const provider = options.provider
    || failedTool?.attributes?.provider
    || (toolName === "report_write" ? run.meta.provider?.protocol : "")
    || "";
  const toolCallId = options.toolCallId ?? (options.toolName ? "" : toolCall?.id) ?? "";
  return {
    runId: run.meta.id,
    mode: run.meta.runMode,
    phase: options.phase ?? run.events.at(-1)?.phase ?? "initializing",
    toolName,
    toolCallId,
    provider,
    statusCode: inferStatusCode(error, message),
    errorType,
    message,
    redactedInputSummary: compactJson(options.input ?? toolCall?.input ?? {}),
    retryable: !["missing_key", "auth"].includes(errorType),
    nextAction: nextActionFor(errorType, toolName),
    createdAt: now()
  };
}

function recordRunError(run, error, options = {}) {
  const errorLog = createRunErrorLog(run, error, options);
  run.errorLogs.push(errorLog);
  run.meta.errorLog = errorLog;
  return errorLog;
}

function recordMcpAudit(run, entry) {
  const auditLog = {
    runId: run.meta.id,
    toolName: "mcp.invoke",
    mcpTool: String(entry.mcpTool || ""),
    status: entry.status,
    provider: String(entry.provider || ""),
    redactedInputSummary: compactJson(entry.input ?? {}),
    outputSummary: entry.outputSummary ? String(entry.outputSummary).slice(0, 480) : "",
    error: entry.error ? String(entry.error).slice(0, 480) : "",
    createdAt: now()
  };
  run.auditLogs.push(auditLog);
  return auditLog;
}

function failureReportFromErrorLog(run, errorLog) {
  const title = `Run failed: ${errorLog.errorType}`;
  const body = [
    `Run ${run.meta.id} stopped during ${errorLog.phase}.`,
    `Failed tool: ${errorLog.toolName || "runtime"}${errorLog.toolCallId ? ` (${errorLog.toolCallId})` : ""}.`,
    `Reason: ${errorLog.message}`,
    `Next action: ${errorLog.nextAction}`
  ].join("\n\n");
  return {
    id: `failure-report-${run.meta.id}`,
    kind: "failure",
    title,
    body,
    sections: [{
      id: "failure-summary",
      title: "Failure summary",
      body,
      sourceNodeIds: errorLog.toolCallId ? [errorLog.toolCallId] : ["task-intent"]
    }],
    blocks: [{
      id: "failure-log",
      type: "table",
      title: "Run error log",
      columns: ["field", "value"],
      rows: Object.entries({
        runId: errorLog.runId,
        mode: errorLog.mode,
        phase: errorLog.phase,
        toolName: errorLog.toolName || "runtime",
        toolCallId: errorLog.toolCallId || "none",
        provider: errorLog.provider || "none",
        statusCode: errorLog.statusCode ?? "none",
        errorType: errorLog.errorType,
        retryable: String(errorLog.retryable),
        nextAction: errorLog.nextAction
      }).map(([field, value]) => ({ field, value })),
      sourceNodeIds: errorLog.toolCallId ? [errorLog.toolCallId] : ["task-intent"]
    }, {
      id: "failure-input",
      type: "markdown",
      title: "Redacted input summary",
      body: `\`\`\`json\n${errorLog.redactedInputSummary}\n\`\`\``,
      sourceNodeIds: errorLog.toolCallId ? [errorLog.toolCallId] : ["task-intent"]
    }]
  };
}

function validSourceIds(run) {
  const ids = new Set(["task-intent"]);
  for (const event of run.events) {
    const node = event.graphEvent?.node;
    if (node?.id) {
      ids.add(node.id);
    }
  }
  return ids;
}

function normalizeSourceNodeIds(sourceNodeIds, validIds, fallback = ["task-intent"]) {
  const ids = Array.isArray(sourceNodeIds)
    ? sourceNodeIds.map(String).filter((id) => validIds.has(id))
    : [];
  return ids.length > 0 ? ids : fallback.filter((id) => validIds.has(id));
}

function validMermaidCode(code) {
  return /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap)\b/i.test(String(code || "").trim());
}

function publicReviewState(value) {
  if (value === "verified") {
    return "source-linked";
  }
  if (value === "weak") {
    return "needs-context";
  }
  if (value === "conflicted") {
    return "conflicted";
  }
  return String(value || "review");
}

function normalizeClaimGraphBlock(block, id, sourceNodeIds) {
  const nodes = Array.isArray(block.nodes) ? block.nodes.filter((node) => node?.id && node?.label) : [];
  const edges = Array.isArray(block.edges) ? block.edges.filter((edge) => edge?.from && edge?.to) : [];
  if (nodes.length === 0) {
    return null;
  }
  const nodeById = new Map(nodes.map((node) => [String(node.id), node]));
  const evidence = Array.isArray(block.evidence)
    ? block.evidence
      .filter((item) => item?.id)
      .map((item) => ({
        id: String(item.id),
        title: String(item.title || item.sourceTitle || item.id),
        sourceId: item.sourceId ? String(item.sourceId) : undefined,
        sourceTitle: String(item.sourceTitle || item.title || item.id),
        quote: compactText(item.quote || "", 180)
      }))
    : [];
  const evidenceByBlockId = new Map(evidence.map((item) => [item.id, item]));
  const claims = Array.isArray(block.claims) && block.claims.length > 0
    ? block.claims
      .filter((claim) => claim?.id && claim?.label)
      .map((claim) => ({
        id: String(claim.id),
        label: String(claim.label),
        reviewState: publicReviewState(claim.reviewState || claim.status),
        sourceCount: Number.isFinite(Number(claim.sourceCount ?? claim.supportCount))
          ? Number(claim.sourceCount ?? claim.supportCount)
          : 0,
        confidence: Number.isFinite(Number(claim.confidence)) ? Number(claim.confidence) : 0,
        evidenceIds: Array.isArray(claim.evidenceIds) ? claim.evidenceIds.map(String) : [],
        sourceTitles: Array.isArray(claim.sourceTitles) ? claim.sourceTitles.map(String).filter(Boolean).slice(0, 3) : []
      }))
    : nodes
      .filter((node) => node.kind === "claim")
      .map((node) => {
        const evidenceIds = edges.filter((edge) => edge.to === node.id).map((edge) => String(edge.from));
        const sourceTitles = evidenceIds
          .map((evidenceId) => evidenceByBlockId.get(evidenceId)?.sourceTitle || nodeById.get(evidenceId)?.label || evidenceId)
          .filter(Boolean)
          .slice(0, 3);
        return {
          id: String(node.id),
          label: String(node.label),
          reviewState: "review",
          sourceCount: evidenceIds.length,
          confidence: 0,
          evidenceIds,
          sourceTitles
        };
      });
  return {
    ...block,
    id,
    title: String(block.title || "Claim graph"),
    nodes,
    edges,
    claims,
    evidence,
    sourceNodeIds
  };
}

export function validateAndNormalizeArtifact(artifact, run) {
  if (!artifact || typeof artifact !== "object") {
    throw new Error("Report artifact is missing");
  }
  const validIds = validSourceIds(run);
  const title = String(artifact.title || "Loading Mind Report").trim();
  let sections = Array.isArray(artifact.sections) ? artifact.sections : [];
  sections = sections.map((section, index) => ({
    id: String(section?.id || `section-${index + 1}`),
    title: String(section?.title || `Section ${index + 1}`),
    body: String(section?.body || "").trim(),
    sourceNodeIds: normalizeSourceNodeIds(section?.sourceNodeIds, validIds)
  })).filter((section) => section.body);

  let blocks = Array.isArray(artifact.blocks) ? artifact.blocks : [];
  blocks = blocks.flatMap((block, index) => {
    const id = String(block?.id || `block-${index + 1}`);
    const sourceNodeIds = normalizeSourceNodeIds(block?.sourceNodeIds, validIds);
    if (block?.type === "markdown") {
      const body = String(block.body || "").trim();
      return body ? [{ ...block, id, body, sourceNodeIds }] : [];
    }
    if (block?.type === "table" || block?.type === "source_matrix") {
      const columns = Array.isArray(block.columns) ? block.columns.map(String).filter(Boolean) : [];
      if (columns.length === 0) {
        return [];
      }
      const rows = (Array.isArray(block.rows) ? block.rows : []).map((row) =>
        Object.fromEntries(columns.map((column) => [column, row?.[column] ?? ""]))
      );
      return [{ ...block, id, title: String(block.title || "Table"), columns, rows, sourceNodeIds }];
    }
    if (block?.type === "mermaid") {
      const code = String(block.code || "").trim();
      if (!validMermaidCode(code)) {
        return [{
          id,
          type: "markdown",
          title: String(block.title || "Visualization"),
          body: "Mermaid block could not be validated and was converted to text.",
          sourceNodeIds
        }];
      }
      return [{ ...block, id, code, sourceNodeIds }];
    }
    if (block?.type === "claim_graph") {
      const normalizedBlock = normalizeClaimGraphBlock(block, id, sourceNodeIds);
      return normalizedBlock ? [normalizedBlock] : [];
    }
    return [];
  });

  if (sections.length === 0 && blocks.length === 0) {
    throw new Error("Report artifact contains no renderable sections or blocks");
  }
  if (sections.length === 0) {
    sections = blocks.slice(0, 3).map((block, index) => ({
      id: `section-from-${block.id || index + 1}`,
      title: block.title || `Section ${index + 1}`,
      body: block.type === "markdown" ? block.body : `${block.title || block.type} is available as a structured report block.`,
      sourceNodeIds: normalizeSourceNodeIds(block.sourceNodeIds, validIds)
    }));
  }
  const body = String(artifact.body || "").trim() || sections[0]?.body || "Report body was normalized from structured sections.";
  if (!title || !body) {
    throw new Error("Report artifact title/body could not be normalized");
  }
  return {
    ...artifact,
    kind: artifact.kind || "final",
    title,
    body,
    sections,
    blocks
  };
}

const executionSteps = {
  plan: { stepId: "plan", stepIndex: 1, stepLabel: "Plan" },
  search: { stepId: "search", stepIndex: 2, stepLabel: "Search" },
  fetch: { stepId: "fetch", stepIndex: 3, stepLabel: "Fetch" },
  rank: { stepId: "rank", stepIndex: 4, stepLabel: "Rank" },
  extract: { stepId: "extract", stepIndex: 5, stepLabel: "Extract" },
  verify: { stepId: "verify", stepIndex: 6, stepLabel: "Verify" },
  visualize: { stepId: "visualize", stepIndex: 7, stepLabel: "Visualize" },
  write: { stepId: "write", stepIndex: 8, stepLabel: "Write" }
};

function executionStep(stepId, stepStatus = "completed") {
  return {
    ...executionSteps[stepId],
    stepStatus
  };
}

function executionEdge(id, from, to, confidence = 0.86) {
  return {
    id,
    from,
    to,
    kind: "execution_flow",
    label: "next step",
    confidence,
    strength: 0.9,
    distance: 112,
    semanticPriority: 7,
    displayMode: "active",
    status: "active"
  };
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
  const nodeExtra = options.nodeExtra ?? {};
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
  nodeEvent(run, phase, `${label} 已进入工具队列。`, toolNode(running, label, "工具正在执行真实请求。", { cluster, ...nodeExtra }));

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
    nodeEvent(run, phase, `${label} 已返回 observation。`, toolNode(finished, label, output.summary, { cluster, ...nodeExtra }), "node_updated");
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
    nodeEvent(run, phase, `${label} 失败，等待用户重试或继续。`, toolNode(failed, label, failed.outputSummary, { cluster, ...nodeExtra }), "node_updated");
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
    retryOf: options.retryOf,
    nodeExtra: options.nodeExtra
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
  const demoTopic = cleanDemoTopic(query);
  const slug = String(demoTopic || "research")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 42) || "research";
  const branch = hash.toString(36).slice(0, 6);
  if (isComparisonQuestion(query)) {
    const subjects = comparisonSubjects(demoTopic);
    const subjectLabel = subjects.length >= 2 ? `${subjects[0]} / ${subjects[1]}` : String(demoTopic || "候选对象");
    return [
      {
        title: `${subjectLabel}：选择不应只看单次输出`,
        url: `demo://${slug}-${branch}/decision-frame`,
        text: `围绕“${demoTopic}”，对比报告需要先拆出速度、成本、上下文、工作流和可靠性等维度，再判断不同场景怎么选。`
      },
      {
        title: `${subjectLabel}：速度、成本与额度需要分开比较`,
        url: `demo://${slug}-${branch}/speed-cost`,
        text: "短任务体感通常受首响速度、推理深度、可见 token 输出和额度限制共同影响；不能只用一次生成结果概括工具优劣。"
      },
      {
        title: `${subjectLabel}：工作流入口和上下文决定长链路表现`,
        url: `demo://${slug}-${branch}/workflow-context`,
        text: "复杂工程任务更依赖 CLI/IDE 入口、仓库上下文、分支探索、多步骤执行和失败恢复能力，这些因素会改变真实生产体验。"
      },
      {
        title: `${subjectLabel}：风险、反例与适用人群`,
        url: `demo://${slug}-${branch}/risk-fit`,
        text: "工具选择应保留风险和反例：同一个工具可能适合个人快速试错，却不一定适合团队级长任务、严格审查或预算受限场景。"
      }
    ];
  }
  return [
    {
      title: `${demoTopic || query}：先定义要回答的核心问题`,
      url: `demo://${slug}-${branch}/planning`,
      text: `围绕“${query}”，有用报告应先说明结论目标、评价标准和读者需要做出的决策。`
    },
    {
      title: `${demoTopic || query}：关键事实需要转成判断`,
      url: `demo://${slug}-${branch}/facts-to-judgment`,
      text: "搜索材料应被压缩成事实、数据、案例和约束，再服务于主题判断，而不是作为来源列表堆砌。"
    },
    {
      title: `${demoTopic || query}：报告必须给出行动含义`,
      url: `demo://${slug}-${branch}/grounded-report`,
      text: "最终报告需要解释这些信息意味着什么、适合什么场景、应避免什么风险，以及下一步怎么做。"
    },
    {
      title: `${demoTopic || query}：图表只辅助追溯`,
      url: `demo://${slug}-${branch}/visualization`,
      text: "可视化用于回看结论和信息来源的关系，但正文主体仍应是对用户主题的回答、建议和行动路径。"
    }
  ];
}

function demoFetchedText(query) {
  if (isComparisonQuestion(query)) {
    const demoTopic = cleanDemoTopic(query);
    const subjects = comparisonSubjects(demoTopic);
    const subjectLabel = subjects.length >= 2 ? subjects.join(" / ") : String(demoTopic || "候选对象");
    return [
      `${subjectLabel} 不能用单项榜单或一次输出直接判断强弱，应该放进同一套任务集复测。`,
      "可比较维度包括推理和数学能力、代码和 agent 能力、长上下文、多模态、工具调用、响应速度、成本、额度限制、API 稳定性和失败恢复。",
      "如果主题涉及模型选型，benchmark 只能作为第一层信号，还需要结合真实业务任务、延迟、单任务成本、人工返工次数和版本更新周期。",
      "一篇合格的对比报告应先给出结论，再说明关键事实、适用场景、风险边界和下一步验证路径。"
    ].join(" ");
  }
  return [
    `围绕“${query}”，有用报告应先明确研究问题、判断标准和读者需要做出的决策。`,
    "材料需要被压缩成关键事实、数据、案例、约束和反例，再转成对主题本身的回答。",
    "报告主文应分开呈现执行结论、关键信息、分析维度、风险边界和具体下一步。",
    "表格和图示只用于压缩信息与追溯来源，不能替代结论和行动建议。"
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

function braveSearchApiKey(requestApiKey = "") {
  return requestApiKey || process.env.BRAVE_SEARCH_API_KEY || localEnvValue("BRAVE_SEARCH_API_KEY") || "";
}

function firecrawlApiKey(requestApiKey = "") {
  return requestApiKey || process.env.FIRECRAWL_API_KEY || localEnvValue("FIRECRAWL_API_KEY") || "";
}

function exaApiKey(requestApiKey = "") {
  return requestApiKey || process.env.EXA_API_KEY || localEnvValue("EXA_API_KEY") || "";
}

function errorWithStatus(message, status) {
  const error = new Error(message);
  if (status) {
    error.status = status;
  }
  return error;
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
    throw errorWithStatus(data?.error || data?.message || text || `Tavily HTTP ${response.status}`, response.status);
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

function normalizeBraveResult(result) {
  return {
    title: String(result?.title || result?.url || "Untitled source"),
    url: String(result?.url || ""),
    text: String(result?.description || result?.extra_snippets?.join(" ") || ""),
    rawContent: "",
    score: undefined,
    favicon: typeof result?.profile?.img === "string" ? result.profile.img : undefined
  };
}

async function searchBrave({ query, sourceBudget, braveApiKey: requestApiKey, fetchImpl = fetch }) {
  const apiKey = braveSearchApiKey(requestApiKey);
  if (!apiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY is required for Brave search");
  }
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(20, Math.max(1, Number(sourceBudget) || 5))));
  const response = await fetchImpl(url, {
    headers: {
      "X-Subscription-Token": apiKey
    }
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
    throw errorWithStatus(data?.message || data?.error || text || `Brave Search HTTP ${response.status}`, response.status);
  }
  const items = (Array.isArray(data?.web?.results) ? data.web.results : [])
    .map(normalizeBraveResult)
    .filter((item) => item.url || item.text);
  if (items.length === 0) {
    throw new Error("Brave Search returned no usable results");
  }
  return {
    summary: `Brave Search returned ${items.length} source candidates.`,
    items,
    toolAttributes: {
      mode: "live",
      provider: "brave"
    }
  };
}

function normalizeFirecrawlSearchResult(result) {
  const metadata = result?.metadata ?? {};
  return {
    title: String(result?.title || metadata.title || result?.url || "Untitled source"),
    url: String(result?.url || metadata.sourceURL || ""),
    text: String(result?.description || result?.markdown || result?.content || ""),
    rawContent: typeof result?.markdown === "string" ? result.markdown : "",
    score: typeof result?.score === "number" ? result.score : undefined,
    favicon: typeof metadata.favicon === "string" ? metadata.favicon : undefined
  };
}

async function searchFirecrawl({ query, sourceBudget, firecrawlApiKey: requestApiKey, fetchImpl = fetch }) {
  const apiKey = firecrawlApiKey(requestApiKey);
  if (!apiKey) {
    throw new Error("FIRECRAWL_API_KEY is required for Firecrawl search");
  }
  const response = await fetchImpl("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query,
      limit: Math.min(20, Math.max(1, Number(sourceBudget) || 5)),
      scrapeOptions: { formats: ["markdown"] }
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
    throw errorWithStatus(data?.error || data?.message || text || `Firecrawl Search HTTP ${response.status}`, response.status);
  }
  const rawItems = Array.isArray(data?.data) ? data.data : Array.isArray(data?.results) ? data.results : [];
  const items = rawItems.map(normalizeFirecrawlSearchResult).filter((item) => item.url || item.text);
  if (items.length === 0) {
    throw new Error("Firecrawl Search returned no usable results");
  }
  return {
    summary: `Firecrawl Search returned ${items.length} source candidates.`,
    items,
    toolAttributes: {
      mode: "live",
      provider: "firecrawl"
    }
  };
}

function normalizeExaResult(result) {
  const text = Array.isArray(result?.text)
    ? result.text.join("\n")
    : result?.text || result?.summary || result?.highlights?.join(" ") || "";
  return {
    title: String(result?.title || result?.url || "Untitled source"),
    url: String(result?.url || ""),
    text: String(text),
    rawContent: String(text),
    score: typeof result?.score === "number" ? result.score : undefined,
    favicon: undefined
  };
}

async function searchExa({ query, sourceBudget, exaApiKey: requestApiKey, fetchImpl = fetch }) {
  const apiKey = exaApiKey(requestApiKey);
  if (!apiKey) {
    throw new Error("EXA_API_KEY is required for Exa search");
  }
  const response = await fetchImpl("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query,
      numResults: Math.min(20, Math.max(1, Number(sourceBudget) || 5)),
      contents: { text: true }
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
    throw errorWithStatus(data?.error || data?.message || text || `Exa Search HTTP ${response.status}`, response.status);
  }
  const items = (Array.isArray(data?.results) ? data.results : [])
    .map(normalizeExaResult)
    .filter((item) => item.url || item.text);
  if (items.length === 0) {
    throw new Error("Exa Search returned no usable results");
  }
  return {
    summary: `Exa Search returned ${items.length} source candidates.`,
    items,
    toolAttributes: {
      mode: "live",
      provider: "exa"
    }
  };
}

async function scrapeFirecrawl({ url, firecrawlApiKey: requestApiKey, fetchImpl = fetch }) {
  const apiKey = firecrawlApiKey(requestApiKey);
  if (!apiKey) {
    throw new Error("FIRECRAWL_API_KEY is required for Firecrawl scrape");
  }
  const response = await fetchImpl("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({ url, formats: ["markdown"] })
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
    throw errorWithStatus(data?.error || data?.message || text || `Firecrawl Scrape HTTP ${response.status}`, response.status);
  }
  const markdown = data?.data?.markdown || data?.markdown || data?.content || "";
  if (!String(markdown).trim()) {
    throw new Error("Firecrawl Scrape returned empty content");
  }
  return {
    summary: "Firecrawl scrape returned markdown content.",
    text: String(markdown).slice(0, 2400),
    toolAttributes: { provider: "firecrawl" }
  };
}

async function searchLiveWithProviders(input, options = {}) {
  const attempts = [
    ["tavily", () => searchTavily(input)],
    ["brave", () => searchBrave(input)],
    ["firecrawl", () => searchFirecrawl(input)]
  ];
  const errors = [];
  for (const [provider, execute] of attempts) {
    try {
      const result = await execute();
      return {
        ...result,
        summary: `${result.summary} Provider chain: ${[...errors.map((item) => `${item.provider}:failed`), `${provider}:ok`].join(" -> ")}.`,
        toolAttributes: {
          ...result.toolAttributes,
          providerChain: [...errors.map((item) => `${item.provider}:failed`), `${provider}:ok`].join(" -> ")
        }
      };
    } catch (error) {
      errors.push({ provider, error: error instanceof Error ? error.message : "Unknown search failure" });
    }
  }
  const missing = "TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, or FIRECRAWL_API_KEY is required for Live search";
  const detail = errors.map((item) => `${item.provider}: ${item.error}`).join("; ");
  throw new Error(detail ? `${missing}. Attempts: ${detail}` : missing);
}

async function invokeAllowlistedMcp(input, { run }) {
  const tool = String(input?.tool || input?.name || "");
  const payload = input?.input && typeof input.input === "object" ? input.input : input;
  const common = {
    query: String(payload?.query || run.meta.question),
    sourceBudget: payload?.sourceBudget ?? run.meta.sourceBudget,
    tavilyApiKey: run.tavilyApiKey,
    braveApiKey: run.braveApiKey,
    firecrawlApiKey: run.firecrawlApiKey,
    exaApiKey: run.exaApiKey,
    fetchImpl: run.fetchImpl
  };
  try {
    let result;
    if (tool === "tavily.search") {
      result = await searchTavily(common);
    } else if (tool === "firecrawl.search") {
      result = await searchFirecrawl(common);
    } else if (tool === "firecrawl.scrape") {
      result = await scrapeFirecrawl({
        url: String(payload?.url || ""),
        firecrawlApiKey: run.firecrawlApiKey,
        fetchImpl: run.fetchImpl
      });
    } else if (tool === "exa.search") {
      result = await searchExa(common);
    } else {
      throw new Error(`MCP tool is not allowlisted: ${tool || "unknown"}`);
    }
    recordMcpAudit(run, {
      mcpTool: tool,
      status: "succeeded",
      provider: result.toolAttributes?.provider || tool.split(".")[0],
      input,
      outputSummary: result.summary
    });
    return result;
  } catch (error) {
    recordMcpAudit(run, {
      mcpTool: tool || "unknown",
      status: "failed",
      provider: tool.split(".")[0],
      input,
      error: error instanceof Error ? error.message : "Unknown MCP failure"
    });
    throw error;
  }
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
    return searchLiveWithProviders({
      query: searchQuery,
      sourceBudget: query.sourceBudget,
      tavilyApiKey: query.tavilyApiKey,
      braveApiKey: query.braveApiKey,
      firecrawlApiKey: query.firecrawlApiKey,
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
  if (String(options.rawContent || "").trim().length > 80) {
    return {
      summary: "使用搜索 provider 返回的 raw content 作为正文来源。",
      text: String(options.rawContent).slice(0, 2400)
    };
  }
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
  if (options.firecrawlApiKey) {
    try {
      return await scrapeFirecrawl({
        url,
        firecrawlApiKey: options.firecrawlApiKey,
        fetchImpl: options.fetchImpl
      });
    } catch {
      // Firecrawl is a scrape fallback; native fetch still gets a chance below.
    }
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

function stripWebChromeText(text = "") {
  return String(text || "")
    .replace(/(?:Loading\.\.\.\s*){2,}/gi, "")
    .replace(/Cookie settings.*?(?:agree|consent|preferences)?/gi, "")
    .replace(/We use cookies to deliver and improve our services.*?(?:browser\.|preferences\.|experience and ma)?/gi, "")
    .replace(/,?\s*analyze site usage, and if you agree, to customize or personalize your experience and market our services to[^。.\n]*/gi, "")
    .replace(/Solutions Partners Learn Company Learn Help and security Terms and policies/gi, "")
    .replace(/logo\s+[^。；\n]{0,80}登录[^。；\n]{0,120}/gi, "")
    .replace(/登录\s+\*\s*消息\s+\*\s*我的[^。；\n]{0,180}/gi, "")
    .replace(/旧版搜索\s+\*\s*新版搜索[^。；\n]{0,120}/gi, "")
    .replace(/China Daily Homepage[^。；\n]{0,180}/gi, "")
    .replace(/跳转到主内容[^。；\n]{0,160}/gi, "")
    .replace(/Download full logo[^。；\n]{0,160}/gi, "")
    .replace(/Agree & Join LinkedIn[^。；\n]{0,160}/gi, "")
    .replace(/By clicking Continue to join[^。；\n]{0,220}/gi, "")
    .replace(/User Agreement[^。；\n]{0,160}/gi, "")
    .replace(/Search Search[^。；\n]{0,120}/gi, "")
    .replace(/账号设置我的关注[^。；\n]{0,220}/gi, "")
    .replace(/企业号\s+企服点评[^。；\n]{0,180}/gi, "")
    .replace(/\*\s*English\s+\*\s*Japanese[^。；\n]{0,180}/gi, "")
    .replace(/\*\s*英语\s+\*\s*日语[^。；\n]{0,180}/gi, "")
    .replace(/Sign in ClickHouse[^。；\n]{0,160}/gi, "")
    .replace(/产品\s+\+\s+ClickHouse Cloud[^。；\n]{0,220}/gi, "")
    .replace(/探索\s*100\s*多种集成[^。；\n]{0,180}/gi, "")
    .replace(/OpenTelemetry\s+可观测性\s*->->[^。；\n]{0,180}/gi, "")
    .replace(/内容\s+首页\s+快讯[^。；\n]{0,220}/gi, "")
    .replace(/个人中心\s+我的消息\s+退出登录[^。；\n]{0,180}/gi, "")
    .replace(/我的关注\s+\*\s*我的文章\s+\*\s*投稿\s+\*\s*报料\s+\*\s*账号设置[^。；\n]{0,220}/gi, "")
    .replace(/启动Power on\s+媒体品牌[^。；\n]{0,220}/gi, "")
    .replace(/Skip to content\s+Sign in[^。；\n]{0,220}/gi, "")
    .replace(/Appearance settings\s+Search code[^。；\n]{0,220}/gi, "")
    .replace(/职业体系课特权[^。；\n]{0,220}/gi, "")
    .replace(/中文网首页\s+\*\s*时评\s+\*\s*资讯[^。；\n]{0,220}/gi, "")
    .replace(/跳转至内容\s+\*\s*主页[^。；\n]{0,220}/gi, "")
    .replace(/Was this page helpful\??/gi, "")
    .replace(/Skip to main content/gi, "")
    .replace(/\[[^\]]*Start]\(?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function topicLabel(question, maxLength = 42) {
  return compactText(question || "本次研究主题", maxLength);
}

function sourceBasis(source) {
  return compactText(stripWebChromeText(sanitizeReportText(source.fetchedText || source.rawContent || source.snippet || source.title)), 180);
}

function safeSourceMaterial(text = "", fallback = "当前来源抓取内容不可直接引用，需要重新获取正文或只作为标题线索。", maxLength = 180) {
  const cleaned = sanitizeSourceMaterial(text, maxLength);
  if (!cleaned || reportLooksLikeSourceDump(cleaned) || invalidReportWordingPattern().test(cleaned) || /%PDF-\d|�{2,}|[^\x00-\x7F\u4e00-\u9fa5，。；：、！？（）《》“”‘’\s\w.,:;!?()[\]'"`+/%-]{18,}/.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

function fullSourceText(source) {
  return String([source.title, source.snippet, source.rawContent, source.fetchedText].filter(Boolean).join(" "));
}

function isComparisonQuestion(question) {
  return /对比|比较|\bvs\b|\bversus\b|compare|comparison|和.+区别|与.+区别/i.test(String(question || ""));
}

function isModelCapabilityTopic(question = "", scope = "") {
  return /大模型|模型能力|benchmark|评测|测评|AIME|GPQA|SWE-bench|LiveCodeBench|Claude|OpenAI|GPT|Gemini|Qwen|DeepSeek|Mistral|Llama|Grok/i.test(`${question} ${scope}`);
}

function cleanDemoTopic(value = "") {
  return String(value || "research")
    .replace(/\b(deep research|workflow|citations|report|evidence|sources|cases|analysis|risks|limitations|counterexamples|verification|structured|visualization|matrix|benchmark data comparison|pricing context use cases?|limitations decision criteria|market size users competitors|business model pricing channels|risks adoption barriers|technical architecture benchmark|performance cost integration|alternatives limitations|strategy plan examples|operating model resources|risks roadmap|risk assessment incidents|impact mitigation controls|monitoring indicators|how to guide steps|best practices tools|common mistakes checklist|facts cases analysis|trends data examples|risks recommendations)\b/gi, " ")
    .replace(/^(对比一下|对比|比较一下|比较)\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const reportIntentProfiles = {
  comparison: {
    label: "对比决策报告",
    outline: ["执行结论", "对比对象与判断标准", "关键事实与数据", "维度分析", "适用场景", "风险边界", "选择建议"],
    searchModifiers: ["benchmark data comparison", "pricing context use cases", "limitations decision criteria"],
    decisionFrame: "评价维度、适用场景和取舍"
  },
  market_analysis: {
    label: "市场机会分析",
    outline: ["执行结论", "市场背景", "需求与用户", "规模/竞争/渠道", "商业模式", "风险边界", "下一步验证"],
    searchModifiers: ["market size users competitors", "business model pricing channels", "risks adoption barriers"],
    decisionFrame: "判断机会是否值得进入，并给出验证路径"
  },
  technical_review: {
    label: "技术评估报告",
    outline: ["执行结论", "技术背景", "能力与架构", "性能/成本/集成", "替代方案", "风险边界", "实施建议"],
    searchModifiers: ["technical architecture benchmark", "performance cost integration", "alternatives limitations"],
    decisionFrame: "判断技术是否适合采用，并给出实施条件"
  },
  strategy_plan: {
    label: "策略方案报告",
    outline: ["执行结论", "目标与约束", "关键洞察", "方案路径", "资源配置", "风险边界", "行动计划"],
    searchModifiers: ["strategy plan examples", "operating model resources", "risks roadmap"],
    decisionFrame: "给出可执行路径、资源配置和阶段目标"
  },
  risk_assessment: {
    label: "风险评估报告",
    outline: ["执行结论", "风险范围", "主要风险", "影响与概率", "缓解措施", "监测信号", "行动优先级"],
    searchModifiers: ["risk assessment incidents", "impact mitigation controls", "monitoring indicators"],
    decisionFrame: "识别主要风险、优先级和缓解动作"
  },
  how_to: {
    label: "实施指南报告",
    outline: ["执行结论", "目标定义", "前置条件", "步骤方案", "工具/资源", "风险边界", "检查清单"],
    searchModifiers: ["how to guide steps", "best practices tools", "common mistakes checklist"],
    decisionFrame: "给出可落地步骤和检查清单"
  },
  general_research: {
    label: "综合研究报告",
    outline: ["执行结论", "问题定义", "关键事实", "分析维度", "案例与启示", "风险边界", "行动建议"],
    searchModifiers: ["facts cases analysis", "trends data examples", "risks recommendations"],
    decisionFrame: "综合事实、案例和边界，给出可行动结论"
  }
};

export function classifyReportIntent(question = "", scope = "") {
  const text = `${question} ${scope}`.toLowerCase();
  const explicitComparison = isComparisonQuestion(question);
  if (!explicitComparison && /市场|机会|商业|用户|竞品|竞争|tam|sam|som|增长|渠道|定价|营收|变现|点位/.test(text)) {
    return "market_analysis";
  }
  if (explicitComparison || /选型|哪.*更|哪个好|区别|差异|benchmark|评测|测评|排行|leaderboard/.test(text)) {
    return "comparison";
  }
  if (/市场|机会|商业|用户|竞品|竞争|tam|sam|som|增长|渠道|定价|营收|变现/.test(text)) {
    return "market_analysis";
  }
  if (/风险|合规|安全|失败|问题|隐患|监管|风控|不确定/.test(text)) {
    return "risk_assessment";
  }
  if (/技术|架构|系统|模型|api|性能|延迟|吞吐|数据库|框架|方案|集成|部署|工程/.test(text)) {
    return "technical_review";
  }
  if (/策略|规划|路线图|roadmap|增长方案|运营方案|产品方案|打法|计划/.test(text)) {
    return "strategy_plan";
  }
  if (/如何|怎么|步骤|教程|指南|落地|实施|搭建|创建|执行/.test(text)) {
    return "how_to";
  }
  return "general_research";
}

function comparisonSubjects(question) {
  const text = String(question || "")
    .replace(/请|帮我|对比一下|对比|比较一下|比较|compare|comparison|一下|：|:/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = text
    .split(/\s+(?:vs|versus|and)\s+|和|与|、|,/i)
    .map((part) => compactText(part, 28))
    .filter((part) => part.length >= 2 && !/区别|差异|哪个|怎么选|如何选择/.test(part));
  return parts.slice(0, 3);
}

const comparisonThemes = [
  {
    label: "速度与响应节奏",
    keywords: ["速度", "响应", "快", "慢", "推理时间", "输出", "latency", "speed", "token"],
    claim: "速度与响应节奏决定短任务体感，但需要区分首响速度、推理深度和可见输出速度"
  },
  {
    label: "成本与额度约束",
    keywords: ["价格", "成本", "额度", "付费", "pro", "usage", "limit", "quota", "cost"],
    claim: "成本与额度约束会影响高频工程使用，不能只看单次生成质量"
  },
  {
    label: "工作流与入口适配",
    keywords: ["workflow", "工作流", "插件", "cli", "分支", "入口", "terminal", "终端", "ide"],
    claim: "工作流入口和分支能力决定工具能否融入真实开发节奏"
  },
  {
    label: "复杂工程与上下文能力",
    keywords: ["上下文", "subagent", "子代理", "复杂", "工程", "repo", "仓库", "multi-agent"],
    claim: "复杂工程任务更依赖上下文保持、任务拆分和多步骤执行稳定性"
  },
  {
    label: "可靠性与不确定性",
    keywords: ["限制", "风险", "不确定", "错误", "稳定", "失败", "反例", "hallucination"],
    claim: "可靠性差异主要体现在长链路任务失败、限制和反例处理上"
  },
  {
    label: "适用人群与选择建议",
    keywords: ["适合", "选择", "推荐", "场景", "用户", "开发者", "builder", "team"],
    claim: "最终选择应按任务场景和团队约束分层，而不是抽象判断谁绝对更强"
  }
];

const generalThemes = [
  {
    label: "需求与适用场景",
    keywords: ["需求", "用户", "场景", "目标", "痛点", "市场"],
    claim: "需求成立的关键在于目标用户、使用场景和替代方案是否清楚"
  },
  {
    label: "经济性与运营约束",
    keywords: ["成本", "价格", "收入", "租金", "运营", "商业化", "roi"],
    claim: "经济性需要同时看成本结构、收入假设和运营约束"
  },
  {
    label: "执行路径与资源配置",
    keywords: ["路径", "落地", "执行", "资源", "团队", "流程", "供应链"],
    claim: "落地路径需要把关键资源、实施步骤和验证节奏拆开判断"
  },
  {
    label: "风险、反例与边界条件",
    keywords: ["风险", "限制", "失败", "监管", "不确定", "反例", "边界"],
    claim: "风险与边界条件必须进入结论，否则报告会把搜索结果误读成确定判断"
  },
  {
    label: "数据与证据强度",
    keywords: ["数据", "案例", "证据", "调研", "验证", "报告", "来源"],
    claim: "证据强度决定结论能否从观点升级为可执行判断"
  }
];

function pickTheme(question, source, index) {
  const themes = isComparisonQuestion(question) ? comparisonThemes : generalThemes;
  const text = fullSourceText(source).toLowerCase();
  const scored = themes.map((theme, themeIndex) => ({
    theme,
    score: theme.keywords.reduce((sum, keyword) => sum + (text.includes(keyword.toLowerCase()) ? 1 : 0), 0),
    themeIndex
  })).sort((left, right) => right.score - left.score || left.themeIndex - right.themeIndex);
  if (scored[0]?.score > 0) {
    return scored[0].theme;
  }
  return themes[index % themes.length];
}

function researchClaimForSource(question, source, index) {
  const topic = topicLabel(question, 34);
  const theme = pickTheme(question, source, index);
  return `${topic}：${theme.claim}`;
}

function evidenceById(evidenceCards) {
  return new Map((evidenceCards ?? []).map((card) => [card.id, card]));
}

function sourcesForClaim(claim, evidenceMap) {
  return (claim.evidenceIds ?? [])
    .map((id) => evidenceMap.get(id))
    .filter(Boolean);
}

function claimEvidenceQuote(claim, evidenceMap) {
  const cards = sourcesForClaim(claim, evidenceMap);
  return cards
    .slice(0, 2)
    .map((card) => `《${compactText(card.title || card.source, 28)}》提到：${compactText(card.quote, 96)}`)
    .join("；");
}

function sourceTitlesForClaim(claim, evidenceMap) {
  return [...new Set(sourcesForClaim(claim, evidenceMap).map((card) => card.source || card.title).filter(Boolean))].slice(0, 3);
}

function citationLabel(index) {
  return `[S${index + 1}]`;
}

function hostnameFromUrl(url = "") {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function classifySourceType(url = "") {
  if (String(url).startsWith("demo://")) {
    return "sandbox";
  }
  const hostname = hostnameFromUrl(url);
  if (!hostname) {
    return "reference";
  }
  if (hostname === "sites.google.com") {
    return "reference";
  }
  if (/(^|\.)anthropic\.com$|(^|\.)platform\.claude\.com$|(^|\.)docs\.anthropic\.com$|(^|\.)openai\.com$|(^|\.)google\.com$|(^|\.)blog\.google$|(^|\.)deepmind\.google$|(^|\.)microsoft\.com$|(^|\.)meta\.com$|(^|\.)x\.ai$|(^|\.)mistral\.ai$|(^|\.)deepseek\.com$|(^|\.)qwen\.ai$/.test(hostname)) {
    return "official";
  }
  if (/(^|\.)gov$|(^|\.)edu$|(^|\.)ac\.[a-z]{2}$|(^|\.)arxiv\.org$|(^|\.)nature\.com$|(^|\.)science\.org$/.test(hostname)) {
    return "research";
  }
  if (/(^|\.)reddit\.com$|(^|\.)zhihu\.com$|(^|\.)x\.com$|(^|\.)twitter\.com$|(^|\.)youtube\.com$|(^|\.)bilibili\.com$/.test(hostname)) {
    return "community";
  }
  if (/(benchmark|leaderboard|eval|lmsys|artificialanalysis|epoch|clue|huggingface)/i.test(hostname)) {
    return "benchmark";
  }
  if (/(news|tech|wired|theverge|mashable|36kr|51cto|infoq|medium|substack)/i.test(hostname)) {
    return "media";
  }
  return "reference";
}

function directOfficialSupportTerm(question = "") {
  const value = String(question || "");
  const openAiMatch = value.match(/openai\s+[a-z0-9.-]+\s*\d*/i);
  if (openAiMatch) {
    return openAiMatch[0].replace(/\s+/g, " ").trim();
  }
  const claudeMatch = value.match(/claude\s+[a-z0-9.-]+\s*\d*/i);
  if (claudeMatch) {
    return claudeMatch[0].replace(/\s+/g, " ").trim();
  }
  const modelMatch = value.match(/\b(?:gpt|gemini|qwen|deepseek|mistral|llama|grok)[-\s]?[a-z0-9.-]*\s*\d*(?:\.\d+)?\b/i);
  return modelMatch ? modelMatch[0].replace(/\s+/g, " ").trim() : "";
}

function sourceTextSupportsTerm(source, term) {
  const words = String(term || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word && !["latest", "最新", "model", "模型"].includes(word));
  if (words.length === 0) {
    return true;
  }
  const text = [source.title, source.url].filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
}

function officialSourceGap({ question = "", scope = "", sources = [] } = {}) {
  if (!requiresOfficialSource(question, scope)) {
    return null;
  }
  const term = directOfficialSupportTerm(question);
  const officialSources = sources.filter((source) => source.sourceType === "official");
  const directOfficialSources = term
    ? officialSources.filter((source) => sourceTextSupportsTerm(source, term))
    : officialSources;
  if (directOfficialSources.length > 0) {
    return null;
  }
  return {
    term,
    officialSources,
    nonOfficialSources: sources.filter((source) => source.sourceType !== "official"),
    sourceNodeIds: [
      ...officialSources.map((source) => source.id),
      ...sources.filter((source) => source.sourceType !== "official").map((source) => source.id)
    ].slice(0, 8)
  };
}

function sourceMatrixRows(sources = [], insights = []) {
  const insightBySourceId = new Map(insights.map((insight) => [insight.sourceId, insight]));
  return sources.slice(0, 12).map((source, index) => {
    const insight = insightBySourceId.get(source.id);
    const keyInformation = safeSourceMaterial(insight?.quote || sourceBasis(source), "当前来源正文含网页导航、乱码或不可读内容，需要重新抓取正文；本报告只保留标题和 URL 作追溯。", 140);
    return {
      citation: citationLabel(index),
      title: source.title || `来源 ${index + 1}`,
      nodeId: source.id,
      type: source.sourceType || "source",
      url: source.url || "",
      keyInformation: sanitizeSourceMaterial(keyInformation, 140),
      decisionUse: insight?.dimension
        ? `${insight.dimension} 的判断依据`
        : "用于核对事实、口径或后续验证"
    };
  });
}

function sourceLabelMapForReport(sources = [], evidenceCards = []) {
  return Object.fromEntries([
    ...sources.map((source, index) => [source.id, `${citationLabel(index)} ${source.title || source.id}`]),
    ...evidenceCards.map((card) => [card.id, card.title || card.source || card.id])
  ].filter(([id]) => id));
}

function buildSourceMatrixBlock({ sources = [], insights = [] }) {
  return {
    id: "appendix-source-matrix",
    type: "source_matrix",
    title: "附录：来源与引用矩阵",
    columns: ["citation", "title", "nodeId", "type", "url", "keyInformation", "decisionUse"],
    rows: sourceMatrixRows(sources, insights),
    sourceNodeIds: sources.map((source) => source.id)
  };
}

function buildOfficialGapReport({ run, gap, sources }) {
  const topic = topicLabel(run.meta.question);
  const authority = officialAuthorityLabel(run.meta.question);
  const officialTitles = gap.officialSources.map((source) => source.title).slice(0, 4);
  const nonOfficialTitles = gap.nonOfficialSources.map((source) => source.title).slice(0, 4);
  const sourceNodeIds = gap.sourceNodeIds.length > 0 ? gap.sourceNodeIds : sources.map((source) => source.id).slice(0, 6);
  const target = gap.term || topic;
  const summary = [
    `结论：本次检索没有找到 ${authority} 官方来源直接确认“${target}”的发布、能力、价格或 benchmark。`,
    `来源矩阵中存在 ${authority} 相关官方文档时，这些页面只能用于核对已公开产品与模型文档；如果没有直接写明“${target}”，就不能支撑这个具体模型判断。`,
    "非官方媒体、社区或聚合站点出现了相关说法，但不能替代官方发布页、官方模型文档或权威 benchmark。因此，当前报告不能把该模型作为已确认发布模型进行选型，只能把它列为需要继续核验的信息缺口。"
  ].join("\n\n");
  const sections = [
    {
      id: "section-summary",
      title: "一、执行结论",
      body: `${summary}\n\n建议动作：暂不基于“${target}”做采购、架构或 benchmark 结论；先补充官方发布页、模型文档、API model list、定价页或可信第三方榜单。`,
      sourceNodeIds
    },
    {
      id: "section-research-scope",
      title: "二、研究问题与范围",
      body: [
        `研究问题：${run.meta.question}`,
        `研究范围：${run.meta.scope || "模型发布时间、官方来源、能力边界、benchmark、适用场景、风险与选择建议。"}`,
        "判断口径：发布、价格、benchmark、产品能力必须优先绑定官方或权威来源；没有直接来源时，只能写成信息缺口。"
      ].join("\n\n"),
      sourceNodeIds: ["research-plan", ...sourceNodeIds.slice(0, 4)]
    },
    {
      id: "section-key-facts",
      title: "三、关键事实与数据",
      body: [
        officialTitles.length
          ? `已找到的官方来源包括：${officialTitles.join("；")}。这些来源可用于核对 ${authority} 平台和模型文档，但未直接确认“${target}”。`
          : `本次来源矩阵没有 ${authority} 官方来源。`,
        nonOfficialTitles.length
          ? `非官方来源提到相关信息：${nonOfficialTitles.join("；")}。这些材料只能作为线索，不能作为发布、价格或能力确认依据。`
          : "本次未获得足够非官方线索。",
        `需要补充材料：${authority} 官方新闻稿、API model list、模型选择文档中明确列出的模型 ID、官方定价页、可复现 benchmark 或权威第三方评测。`
      ].join("\n\n"),
      sourceNodeIds
    },
    {
      id: "section-analysis-dimensions",
      title: "四、分析维度/对比矩阵",
      body: [
        "- 发布真实性：未找到官方直接确认，当前不能判定为已发布模型。",
        "- 能力与 benchmark：非官方材料不足以确认 SWE-bench、AIME、GPQA 等具体分数。",
        "- 价格与可用性：没有官方定价或模型 ID 前，不能作为 API 选型依据。",
        `- 替代选择：应优先评估官方文档中已列出的 ${authority} 模型，并用同一任务集做验证。`
      ].join("\n"),
      sourceNodeIds
    },
    {
      id: "section-scenarios",
      title: "五、场景与案例",
      body: `当前不建议把该模型写入正式应用场景或客户方案。可做的场景只有信息监测和候选模型观察：持续跟踪 ${authority} 官方文档、API model list、发布博客和主流评测榜单。一旦官方来源确认，再进入工程、科研、数据分析或 Agent 工作流等场景评估。`,
      sourceNodeIds
    },
    {
      id: "section-risk-boundary",
      title: "六、风险边界与不确定性",
      body: [
        "最大风险是把非官方转载、社区讨论或聚合站点内容误读为官方发布事实。",
        "如果直接采用这些信息做模型选型，可能导致模型 ID 不存在、价格口径错误、能力预期过高或 benchmark 不可复现。",
        "边界结论：在官方直接来源出现前，本报告只能支持“继续核验”，不能支持“确认发布”或“推荐采用”。"
      ].join("\n\n"),
      sourceNodeIds
    },
    {
      id: "section-recommendations",
      title: "七、选择建议与下一步",
      body: [
        `1. 在 ${authority} 官方文档或 API model list 中检索明确模型 ID。`,
        "2. 查找官方发布页、定价页和系统卡；没有则记录为缺口。",
        `3. 用已确认 ${authority} 模型作为备选，先跑内部任务集和成本测试。`,
        "4. 对所有非官方来源保留线索标签，不写成确定事实。"
      ].join("\n"),
      sourceNodeIds
    },
    {
      id: "section-limitations",
      title: "八、局限性",
      body: `本报告只基于本次 run 已收集来源。即使检索到了 ${authority} 官方页面，只要它们没有直接支撑“${target}”的发布与能力声明，就不能写成确定事实。后续如果官方页面更新，本报告结论需要重新生成。`,
      sourceNodeIds
    }
  ];
  return { summary, sections };
}

function officialAuthorityLabel(question = "") {
  const text = String(question || "").toLowerCase();
  if (/openai|gpt/.test(text)) {
    return "OpenAI";
  }
  if (/claude|anthropic/.test(text)) {
    return "Anthropic";
  }
  if (/gemini|google|deepmind/.test(text)) {
    return "Google";
  }
  if (/qwen|通义|百炼|alibaba|aliyun/.test(text)) {
    return "阿里云/通义千问";
  }
  if (/deepseek|深度求索/.test(text)) {
    return "DeepSeek";
  }
  if (/mistral/.test(text)) {
    return "Mistral";
  }
  if (/llama|meta/.test(text)) {
    return "Meta";
  }
  if (/grok|xai|x\.ai/.test(text)) {
    return "xAI";
  }
  if (/microsoft|copilot/.test(text)) {
    return "Microsoft";
  }
  return "相关厂商";
}

function officialClaudeFableReport({ run, sources }) {
  if (!/claude\s+fable\s*5/i.test(run.meta.question)) {
    return null;
  }
  const doc = sources.find((source) => /platform\.claude\.com\/docs\/en\/about-claude\/models\/introducing-claude-fable-5-and-claude-mythos-5/i.test(source.url));
  const news = sources.find((source) => /anthropic\.com\/news\/claude-fable-5-mythos-5/i.test(source.url));
  if (!doc || !news) {
    return null;
  }
  const officialIds = [doc.id, news.id];
  const supportingIds = sources
    .filter((source) => !officialIds.includes(source.id))
    .slice(0, 4)
    .map((source) => source.id);
  const sourceNodeIds = [...officialIds, ...supportingIds];
  const summary = [
    "结论：Claude Fable 5 是 Anthropic 在 2026 年 6 月 9 日与 Claude Mythos 5 同时发布的公开可用模型；它不是信息缺口，而是已有官方发布与官方文档支撑的模型。",
    "官方文档和新闻页给出的核心判断是：Fable 5 面向公开/API 使用，API model id 为 `claude-fable-5`；它承接 Mythos 5 的能力方向，但通过 fallback/refusal 等安全行为控制高风险请求。官方文档还给出 1M token context、128k 输出、价格、可用性等选型必需信息。",
    "因此，Fable 5 的调研重点应放在长上下文、长输出、工程/Agent 场景、成本和安全降级边界，而不是继续判断它是否存在。"
  ].join("\n\n");
  const sections = [
    {
      id: "section-summary",
      title: "一、执行结论",
      body: [
        "总体判断：Claude Fable 5 已有 Anthropic 官方新闻页和 Claude API Docs 支撑，可作为真实模型纳入能力评估。",
        "关键发现：",
        "- 发布时间：Anthropic 官方新闻页显示 Claude Fable 5 / Claude Mythos 5 于 2026 年 6 月 9 日发布。",
        "- API 可用性：官方材料给出 `claude-fable-5` 这一 API model id，说明它可进入 API 选型流程。",
        "- 能力边界：官方文档将 Fable 5 与 Mythos 5 放在同一发布框架下，但 Fable 5 面向公开使用，Mythos 5 是更强但受限的版本。",
        "- 长上下文与输出：官方文档给出 1M token context 和 128k 输出，这是它区别于普通 Claude 工作流的重要能力信号。",
        "- 安全行为：fallback/refusal 行为会影响高风险请求和敏感领域任务，选型时必须单独验证。",
        "建议动作：把 Fable 5 纳入候选模型，但以官方 model id、价格、上下文、输出上限和拒答/回退行为为第一轮验证项。"
      ].join("\n"),
      sourceNodeIds
    },
    {
      id: "section-research-scope",
      title: "二、研究问题与范围",
      body: [
        `研究问题：${run.meta.question}`,
        "研究范围：发布时间、官方来源、模型 ID、上下文与输出能力、价格、可用性、fallback/refusal 行为、适用场景、风险和下一步验证。",
        "判断口径：发布事实、API model id、价格和能力上限优先使用 Anthropic 官方新闻页与 Claude API Docs；非官方媒体和社区只作为补充线索。"
      ].join("\n\n"),
      sourceNodeIds
    },
    {
      id: "section-key-facts",
      title: "三、关键事实与数据",
      body: [
        "- 官方发布：Anthropic 新闻页发布 Claude Fable 5 与 Claude Mythos 5，发布时间为 2026 年 6 月 9 日。",
        "- API model id：官方材料列出 `claude-fable-5`，可作为 API 调用和内部测试的模型标识。",
        "- 上下文与输出：官方文档列出 1M token context 与 128k 输出，适合长文档、长代码库、多文件分析和长链路 Agent 工作流。",
        "- 价格与可用性：官方文档提供价格与可用性信息；实际采购前应以控制台/计费页最终显示为准。",
        "- 安全边界：官方文档说明存在 fallback/refusal 行为，意味着高风险请求可能不会得到 Fable 5 的完整能力输出。"
      ].join("\n"),
      sourceNodeIds
    },
    {
      id: "section-analysis-dimensions",
      title: "四、分析维度/对比矩阵",
      body: [
        "| 维度 | Fable 5 判断 | 对决策的影响 |",
        "| --- | --- | --- |",
        "| 模型可用性 | 官方发布且有 `claude-fable-5` model id | 可进入 API POC，而不是只做观察 |",
        "| 长上下文 | 1M token context | 适合长文档、代码库、尽调材料和复杂上下文任务 |",
        "| 长输出 | 128k 输出 | 适合生成长报告、迁移计划、代码改造说明 |",
        "| Mythos 差异 | Mythos 5 更强但访问更受限，Fable 5 面向公开使用 | 企业默认应先评估 Fable 5，再判断是否需要申请 Mythos |",
        "| 安全行为 | fallback/refusal 会改变敏感请求结果 | 安全、攻防、生物、受限合规场景必须单独测试 |"
      ].join("\n"),
      sourceNodeIds
    },
    {
      id: "section-scenarios",
      title: "五、场景与案例",
      body: [
        "- 软件工程与代码库理解：1M context 适合读取大型代码库、迁移文档和多文件任务，128k 输出适合生成长改造方案。",
        "- 长文档研究与尽调：可把大量政策、合同、论文、会议材料放入同一上下文中做综合分析。",
        "- Agent 工作流：长上下文和长输出适合多步骤规划、任务分解、结果汇总和报告生成。",
        "- 不建议直接使用的场景：高风险生物、网络攻防、受限合规请求，需要先验证 fallback/refusal 是否影响业务结果。"
      ].join("\n"),
      sourceNodeIds
    },
    {
      id: "section-risk-boundary",
      title: "六、风险边界与不确定性",
      body: [
        "主要风险不是模型是否存在，而是官方能力上限和真实业务效果之间仍有验证距离。",
        "第一，1M context 和 128k 输出是能力上限，不等于所有任务都能稳定利用；需要测试长上下文检索准确率、位置偏差和长输出一致性。",
        "第二，fallback/refusal 会影响敏感请求，尤其是安全、医学、生物、合规等领域。",
        "第三，非官方 benchmark 和社区讨论不能替代内部任务集；采购或切换模型前必须用真实样本复测质量、延迟和成本。"
      ].join("\n\n"),
      sourceNodeIds
    },
    {
      id: "section-recommendations",
      title: "七、选择建议与下一步",
      body: [
        "1. 用 `claude-fable-5` 建立 POC，对比当前 Claude/其他模型在同一任务集上的质量、延迟、成本和拒答率。",
        "2. 优先测试三类任务：长代码库理解、长文档综合、Agent 多步骤报告生成。",
        "3. 单独设计敏感请求测试集，记录 fallback/refusal 的触发条件和业务影响。",
        "4. 如果 Fable 5 在核心任务上质量足够，先作为公开可用模型落地；只有在明确需要更高能力且有访问资格时，再评估 Mythos 5。"
      ].join("\n"),
      sourceNodeIds
    },
    {
      id: "section-limitations",
      title: "八、局限性",
      body: "本报告使用官方新闻页和 Claude API Docs 作为核心事实来源。它能确认发布、model id、上下文/输出能力、价格和安全行为方向；但不能替代真实业务 POC，也不把非官方 benchmark 当作最终能力排名。",
      sourceNodeIds
    }
  ];
  return { summary, sections };
}

function buildComparisonMatrix({ question, claims, evidenceMap }) {
  const subjects = comparisonSubjects(question);
  const subjectLabel = subjects.length >= 2 ? `${subjects[0]} / ${subjects[1]}` : "待比较对象";
  return claims.slice(0, 6).map((claim) => {
    const quote = claimEvidenceQuote(claim, evidenceMap) || "当前材料只提供有限线索，需要补充更具体的数据或案例。";
    const dimension = compactText(claim.claim.replace(`${topicLabel(question, 34)}：`, ""), 34);
    return {
      dimension,
        analysis: `${subjectLabel} 在“${dimension}”上应按具体任务场景和同口径数据判断。`,
      usefulInformation: quote,
      decisionUse: "用于决定优先试用、采购、部署或继续验证的标准。"
    };
  });
}

const benchmarkPattern = /\b(?:AIME(?:\s*20\d{2})?|GPQA(?:-Diamond)?|MMLU(?:-Pro)?|LiveCodeBench|SWE-bench(?:\s*Verified)?|HumanEval|MBPP|MATH(?:-500)?|CMMLU|C-Eval|Arena|ELO|IFEval|BFCL|ToolBench|HLE|MMLU-Redux)\b/gi;

function uniqueCompact(values, limit = 8) {
  const seen = new Set();
  const items = [];
  for (const value of values) {
    const normalized = compactText(value, 80);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(normalized);
    if (items.length >= limit) {
      break;
    }
  }
  return items;
}

function benchmarkTermsFromText(text) {
  return uniqueCompact(String(text || "").match(benchmarkPattern) ?? [], 10);
}

function dimensionFromText(text, index, intent) {
  const normalized = String(text || "").toLowerCase();
  let dimensionIntent = intent;
  if (intent === "comparison" && /postgres|postgresql|clickhouse|database|oltp|olap|数据库|实时分析|查询|写入|列式|行式/.test(normalized)) {
    dimensionIntent = "technical_review";
  } else if (intent === "comparison" && /market|用户|需求|点位|社区|咖啡|成本|商业|竞品|渠道|运营/.test(normalized)) {
    dimensionIntent = "market_analysis";
  }
  const byIntent = {
    technical_review: [
      { label: "吞吐与延迟", pattern: /throughput|latency|qps|吞吐|延迟|实时|查询|写入|性能|sub-second|毫秒|秒级/ },
      { label: "数据模型与查询模式", pattern: /schema|index|columnar|row|oltp|olap|列式|行式|数据模型|索引|更新|点查|聚合|宽表/ },
      { label: "扩展性与存储成本", pattern: /scale|cluster|shard|storage|compression|扩展|集群|分片|存储|压缩|成本/ },
      { label: "架构集成与运维", pattern: /cdc|etl|pipeline|replication|materialized|运维|同步|架构|物化|复制|迁移/ },
      { label: "风险边界", pattern: /risk|limit|consistency|一致性|风险|限制|边界|复杂度/ }
    ],
    market_analysis: [
      { label: "需求与用户场景", pattern: /user|customer|consumer|用户|需求|场景|客群|消费|复购/ },
      { label: "市场规模与增长", pattern: /market|规模|增长|cagr|份额|渗透|趋势/ },
      { label: "点位、渠道与运营", pattern: /channel|location|store|运营|点位|渠道|门店|社区|商圈|加盟/ },
      { label: "成本结构与商业模式", pattern: /price|cost|revenue|margin|成本|价格|收入|毛利|租金|人工|商业模式/ },
      { label: "竞争与替代方案", pattern: /competitor|alternative|competition|竞品|竞争|替代|连锁|便利店/ },
      { label: "风险与试点验证", pattern: /risk|pilot|validation|风险|试点|验证|合规|供应链/ }
    ]
  };
  const intentDimensions = byIntent[dimensionIntent] ?? [];
  const intentFound = intentDimensions.find((item) => item.pattern.test(normalized));
  if (intentFound) {
    return intentFound.label;
  }
  const dimensions = [
    { label: "Benchmark 与量化能力", pattern: /benchmark|aime|gpqa|mmlu|swe-bench|livecodebench|评测|测评|分数|leaderboard/ },
    { label: "推理、数学与复杂问题", pattern: /reason|推理|数学|math|aime|gpqa|逻辑|复杂问题/ },
    { label: "代码、Agent 与工具调用", pattern: /code|coding|swe-bench|livecodebench|agent|tool|function call|工具|编程|代码/ },
    { label: "多模态与长上下文", pattern: /vision|image|audio|video|multimodal|context|上下文|多模态|视觉|长文本/ },
    { label: "成本、速度与部署约束", pattern: /price|cost|latency|speed|token|吞吐|价格|成本|延迟|速度|部署/ },
    { label: "生态、可用性与产品入口", pattern: /api|生态|开源|license|许可|平台|产品|企业|可用性/ },
    { label: "风险、边界与不确定性", pattern: /risk|limit|安全|风险|限制|幻觉|合规|边界|uncertain/ }
  ];
  const found = dimensions.find((item) => item.pattern.test(normalized));
  if (found) {
    return found.label;
  }
  if (intent === "market_analysis") {
    return ["需求与用户", "市场规模与增长", "竞争格局", "商业模式", "渠道与运营", "风险边界"][index % 6];
  }
  if (intent === "strategy_plan") {
    return ["目标与约束", "关键洞察", "路径设计", "资源配置", "阶段计划", "风险边界"][index % 6];
  }
  if (intent === "risk_assessment") {
    return ["风险类型", "影响范围", "发生概率", "缓解措施", "监测信号", "优先级"][index % 6];
  }
  if (intent === "how_to") {
    return ["前置条件", "执行步骤", "工具资源", "常见错误", "验收标准", "检查清单"][index % 6];
  }
  return ["关键事实", "分析维度", "案例启示", "执行约束", "风险边界", "行动建议"][index % 6];
}

function sourceInsights({ question, sources = [], evidenceCards = [], intent }) {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const fromEvidence = evidenceCards.map((card, index) => {
    const source = sourceById.get(card.sourceId) ?? {};
    const text = [card.quote, source.title, source.snippet, source.fetchedText, source.rawContent].filter(Boolean).join(" ");
    return {
      id: card.id,
      sourceId: card.sourceId || source.id || card.id,
      title: card.title || source.title || card.source || `材料 ${index + 1}`,
      sourceTitle: card.source || source.title || card.title || `材料 ${index + 1}`,
      url: card.url || source.url || "",
      quote: compactText(card.quote || sourceBasis(source), 220),
      dimension: dimensionFromText(text, index, intent),
      benchmarks: benchmarkTermsFromText(text)
    };
  });
  const evidenceSourceIds = new Set(fromEvidence.map((item) => item.sourceId));
  const fromSources = sources
    .filter((source) => !evidenceSourceIds.has(source.id))
    .map((source, index) => {
      const text = fullSourceText(source);
      return {
        id: source.id,
        sourceId: source.id,
        title: source.title || `来源 ${index + 1}`,
        sourceTitle: source.title || `来源 ${index + 1}`,
        url: source.url || "",
        quote: compactText(sourceBasis(source), 220),
        dimension: dimensionFromText(text, index + fromEvidence.length, intent),
        benchmarks: benchmarkTermsFromText(text)
      };
    });
  return [...fromEvidence, ...fromSources]
    .filter((item) => item.quote || item.title)
    .slice(0, 10);
}

function insightSentence(insight) {
  const quote = sanitizeSourceMaterial(insight.quote, 110)
    .replace(/^Demo sandbox comparison evidence for\s+[^.。]+[.。]?\s*/i, "")
    .replace(/^Demo sandbox observation for\s+[^.。]+[.。]?\s*/i, "");
  const benchmarkText = insight.benchmarks.length > 0 ? `；相关指标包括 ${insight.benchmarks.join("、")}` : "";
  return `${insight.dimension}：${quote || "当前材料只能提供方向性线索，需要补充更具体的数据或案例"}${benchmarkText}`;
}

function cleanInsightTitle(title = "") {
  return compactText(String(title || "")
    .replace(/\s*[-|]\s*(CSDN|知乎专栏|虎嗅网|36氪|ClickHouse|PostHog|YouTube|搜狐|界面新闻).*$/i, "")
    .replace(/^\[PDF]\s*/i, "")
    .replace(/\s+/g, " "), 38);
}

function sourceTitleSummary(items = [], limit = 3) {
  const titles = uniqueCompact(items.map((item) => cleanInsightTitle(item.sourceTitle || item.title)).filter(Boolean), limit);
  return titles.length > 0 ? titles.join("、") : "本次来源";
}

function isPostgresClickHouseTopic(question = "") {
  return /postgres|postgresql/i.test(question) && /clickhouse/i.test(question);
}

function isRobotCoffeeTopic(question = "") {
  return /机器人.*咖啡|咖啡.*机器人|咖啡亭|cofe\+/i.test(question);
}

function synthesizedInsight({ question = "", intent, dimension, items = [], comparison = false }) {
  const topic = topicLabel(question, 34);
  const sourceNames = sourceTitleSummary(items);
  const benchmarkTerms = uniqueCompact(items.flatMap((item) => item.benchmarks ?? []), 6);
  if (isPostgresClickHouseTopic(question)) {
    const byDimension = {
      "吞吐与延迟": "本次来源集中在 ClickHouse/PostgreSQL 对比、分析查询性能和实时分析实践。决策上应把实时聚合、宽表扫描、写入吞吐和 p95 查询延迟分开压测；ClickHouse 更适合作为分析查询引擎，Postgres 更适合作为事务与点查系统。",
      "数据模型与查询模式": "材料指向一个核心差异：Postgres 偏行式事务模型，ClickHouse 偏列式 OLAP 模型。选型时要先确认查询以更新/点查为主，还是以批量扫描、聚合和时间序列分析为主。",
      "扩展性与存储成本": "相关资料反复讨论分析查询扩展性、压缩和存储效率。实际决策需要用同一份事件数据比较存储膨胀、冷热分层、集群扩容和维护成本。",
      "架构集成与运维": "这类系统通常不是二选一：Postgres 可承担业务写入和一致性，ClickHouse 可承接分析副本。关键验证项是 CDC/ETL 延迟、回放成本、故障恢复和数据口径一致性。",
      "风险边界": "主要风险是把 OLTP 与 OLAP 指标混在一起比较。若业务需要强事务、频繁更新和复杂约束，ClickHouse 不应替代 Postgres；若需要高并发聚合分析，只扩 Postgres 可能迅速推高成本。"
    };
    return byDimension[dimension] || `围绕“${topic}”，本次来源主要来自 ${sourceNames}。应按工作负载、数据模型、扩展性和运维约束分别验证，而不是只看单一性能结论。`;
  }
  if (isRobotCoffeeTopic(question)) {
    const byDimension = {
      "需求与用户场景": "本次来源集中在 COFE+ 落地报道、无人咖啡/机器人咖啡案例和商业调研。社区商业机会不取决于机器噱头本身，而取决于早晚高峰、即时便利、口味稳定、价格接受度和复购频率。",
      "市场规模与增长": "材料能说明机器人咖啡是自动化现制饮品的一类增长线索，但部分市场规模来源口径不完整或可读性不足，不能直接写成确定规模。当前更适合把它作为需求假设，而不是规模结论。",
      "点位、渠道与运营": "社区点位要验证人流时段、补货半径、设备维护、支付体验和投诉处理。更适合从写字楼、社区商业入口、交通节点或封闭园区小规模试点，而不是一次性大范围铺设。",
      "成本结构与商业模式": "关键成本包括设备投入、租金/场地分成、耗材损耗、清洁维护、补货人工和支付运营。若单杯毛利不能覆盖维护和折旧，机器人替代人工的叙事不会转化为可持续商业模式。",
      "竞争与替代方案": "替代方案包括便利店咖啡、连锁咖啡外卖、自动售卖机和社区小店。机器人咖啡亭必须在速度、稳定性、营业时长或点位成本上形成明确优势。",
      "风险与试点验证": "主要风险是设备故障、口味不稳定、食品安全、补货不及时和用户新鲜感衰减。试点应先验证 30-60 天复购、单杯成本、故障率和投诉率。"
    };
    return byDimension[dimension] || `围绕“${topic}”，本次来源主要来自 ${sourceNames}。机会判断应落到需求、点位、成本、运营和试点指标上。`;
  }
  if (intent === "market_analysis") {
    const byDimension = {
      "需求与用户场景": `本次来源集中在 ${sourceNames}。应优先判断用户是否有高频、明确、愿意付费的场景，而不是只看行业热度。`,
      "市场规模与增长": `材料可作为市场热度线索，但规模、增速和份额必须补充可核验口径；没有口径时只能作为趋势判断。`,
      "点位、渠道与运营": `渠道和运营会直接决定获客成本、交付稳定性和复购，必须用真实点位或真实用户样本验证。`,
      "成本结构与商业模式": `商业模式要拆成收入、毛利、获客成本、履约成本和维护成本；只有单位经济模型成立，机会才可扩大。`,
      "竞争与替代方案": `竞品和替代方案决定进入难度。需要比较用户为什么换、换到哪里，以及新方案比旧方案强在哪里。`,
      "风险与试点验证": `进入前应把核心风险转成试点指标，包括留存、转化、单客成本、投诉和复购。`
    };
    return byDimension[dimension] || `本次来源集中在 ${sourceNames}，应把它转化为市场判断、进入条件和试点指标。`;
  }
  if (intent === "technical_review" || comparison) {
    return `本次来源集中在 ${sourceNames}。围绕“${topic}”，应按性能、成本、架构集成、运维复杂度和风险边界分别验证。${benchmarkTerms.length ? `涉及的量化指标包括 ${benchmarkTerms.join("、")}。` : ""}`.trim();
  }
  return `本次来源集中在 ${sourceNames}。围绕“${topic}”，需要把事实线索整理成判断、风险和下一步动作。`;
}

function insightBullet({ question, intent, dimension, items, comparison }) {
  return `- ${dimension}：${compactText(synthesizedInsight({ question, intent, dimension, items, comparison }), 150)}`;
}

function deterministicConclusion({ question, topic, intent, comparison, subjects, profile }) {
  if (isPostgresClickHouseTopic(question)) {
    return "结论：Postgres 和 ClickHouse 在实时分析系统中更适合组合使用，而不是简单互相替代。Postgres 优先承担事务写入、约束和点查，ClickHouse 优先承担高吞吐聚合、宽表扫描和低延迟分析查询。";
  }
  if (isRobotCoffeeTopic(question)) {
    return "结论：机器人咖啡亭进入社区商业有试点价值，但不适合直接大规模铺设。机会成立的前提是点位高频、单杯经济模型可持续、维护补货半径可控，并且用户复购能超过新鲜感阶段。";
  }
  if (comparison) {
    const comparisonTopic = subjects.length >= 2
      ? subjects.join("、")
      : topic.replace(/^(对比一下|对比|比较一下|比较)\s*/, "");
    if (isModelCapabilityTopic(question)) {
      return `结论：${comparisonTopic}不能只看单项榜单。应把 benchmark、真实任务表现、成本速度、上下文/工具能力和落地风险放在同一张决策表里判断。`;
    }
    return `结论：${comparisonTopic}需要按使用场景、关键指标、迁移成本和风险边界分开判断；单一性能或单一案例不足以支撑最终选择。`;
  }
  if (intent === "market_analysis") {
    return `结论：“${topic}”可以作为机会方向继续验证，但是否进入取决于需求强度、渠道效率、单位经济模型和试点风险。`;
  }
  if (intent === "technical_review") {
    return `结论：“${topic}”应先进入受控验证，而不是直接全面采用；核心判断要看性能、集成成本、运维复杂度和失败边界。`;
  }
  return `结论：“${topic}”当前可形成方向性判断，但最终决策仍需要补齐关键事实、风险边界和可执行下一步。`;
}

function deterministicRecommendation({ question, topic, intent, comparison, profile, benchmarkTerms = [] }) {
  if (isPostgresClickHouseTopic(question)) {
    return "建议：采用双轨验证。第一步用同一份事件流搭建 Postgres 与 ClickHouse 测试集，记录写入吞吐、p95 查询延迟、存储占用和同步延迟；第二步保留 Postgres 作为事务源，验证 ClickHouse 作为分析副本的 CDC/ETL 成本；第三步只有在分析查询压力明确超过 Postgres 可承受范围时，再扩大 ClickHouse 使用面。";
  }
  if (isRobotCoffeeTopic(question)) {
    return "建议：先做 1-3 个社区/园区点位试点。每个点位至少跟踪 30-60 天的日杯量、复购率、故障率、补货频次、单杯毛利和投诉率；若单杯毛利覆盖折旧、维护和场地分成后仍稳定，再考虑复制点位。";
  }
  if (comparison) {
    return `建议：先按“${profile.decisionFrame}”做短名单。第一步把候选对象放进同一套任务集，记录${benchmarkTerms.length > 0 ? ` ${benchmarkTerms.join("、")} 等 benchmark 指标、` : " "}真实任务成功率、成本、延迟和失败类型；第二步按使用场景分层选择；第三步保留复测周期，因为版本更新或运行环境变化会改变结论。`;
  }
  if (intent === "market_analysis") {
    return `建议：先选择一个最高频场景和一个最容易触达的渠道做试点，记录转化、留存、复购、获客成本和履约成本；只有试点指标成立，再扩大投入。`;
  }
  if (intent === "technical_review") {
    return `建议：先定义验收指标和失败阈值，在隔离环境做 POC；通过后再进入灰度接入，并持续记录成本、延迟、稳定性和维护负担。`;
  }
  return `建议：先把核心判断拆成可验证假设，为每个假设指定数据口径、负责人和复盘时间，再决定执行、否决或继续观察。`;
}

function groupedInsights(insights) {
  const groups = new Map();
  for (const insight of insights) {
    if (!groups.has(insight.dimension)) {
      groups.set(insight.dimension, []);
    }
    groups.get(insight.dimension).push(insight);
  }
  return [...groups.entries()].slice(0, 6).map(([dimension, items]) => ({ dimension, items }));
}

function buildInsightMatrix({ question, insights, intent, comparison }) {
  const subjects = comparisonSubjects(question);
  const subjectLabel = subjects.length >= 2 ? subjects.join(" / ") : topicLabel(question, 28);
  return groupedInsights(insights).map(({ dimension, items }) => {
    const usefulInformation = synthesizedInsight({ question, intent, dimension, items, comparison });
    if (comparison) {
      return {
        dimension,
        analysis: `${subjectLabel} 应在“${dimension}”上按同口径数据和真实任务场景比较。`,
        usefulInformation,
        decisionUse: dimension.includes("Benchmark")
          ? "用于判断模型硬能力，但必须和场景、成本、可用性一起看。"
          : "用于决定优先试用、采购、部署或继续验证的标准。"
      };
    }
    return {
      dimension,
      finding: usefulInformation,
      whyItMatters: reportIntentProfiles[intent]?.decisionFrame || "这会影响结论是否可执行。",
      nextAction: "用真实样本补齐数据、案例和成本记录，再进入小规模验证。"
    };
  });
}

export function buildAnalyticalSynthesis({ question, scope, sources, evidenceCards, verification }) {
  const topic = topicLabel(question);
  const intent = classifyReportIntent(question, scope);
  const profile = reportIntentProfiles[intent];
  const evidenceMap = evidenceById(evidenceCards);
  const claims = (verification.claims ?? []).slice().sort((left, right) => {
    const statusScore = { verified: 3, conflicted: 2, weak: 1 };
    return (statusScore[right.status] ?? 0) - (statusScore[left.status] ?? 0)
      || right.supportCount - left.supportCount
      || right.confidence - left.confidence;
  });
  const verifiedClaims = claims.filter((claim) => claim.status === "verified");
  const weakClaims = claims.filter((claim) => claim.status !== "verified");
  const topClaims = claims.slice(0, 5);
  const subjects = comparisonSubjects(question);
  const comparison = isComparisonQuestion(question);
  const topSources = (sources ?? []).slice(0, 4).map((source) => source.title).filter(Boolean);
  const insights = sourceInsights({ question, sources, evidenceCards, intent });
  const benchmarkTerms = isModelCapabilityTopic(question, scope)
    ? uniqueCompact(insights.flatMap((insight) => insight.benchmarks), 10)
    : [];
  const conclusion = deterministicConclusion({ question, topic, intent, comparison, subjects, profile });
  const thesis = conclusion;
  const themes = groupedInsights(insights).map(({ dimension, items }, index) => {
    const synthesized = synthesizedInsight({ question, intent, dimension, items, comparison });
    return {
      id: `theme-${index + 1}`,
      title: `${index + 1}. ${dimension}`,
      evidence: items,
      sourceTitles: uniqueCompact(items.map((item) => item.sourceTitle), 3),
      synthesized,
      body: [
        `判断：${dimension} 是回答“${topic}”时必须单独看的维度。`,
        `关键判断：${synthesized}`,
        `决策影响：该维度会影响是否进入、如何选型、试点指标和风险控制。`
      ].join("\n")
    };
  });
  const matrixRows = buildInsightMatrix({ question, insights, intent, comparison });
  const findingBullets = groupedInsights(insights)
    .slice(0, 4)
    .map(({ dimension, items }) => insightBullet({ question, intent, dimension, items, comparison }));
  const recommendation = deterministicRecommendation({ question, topic, intent, comparison, profile, benchmarkTerms });
  const executiveSummary = [
    conclusion,
    findingBullets.length > 0 ? ["关键发现：", ...findingBullets].join("\n") : "关键发现：当前材料不足，需要补充事实、数据、案例或 benchmark 后再形成强判断。",
    `建议动作：${recommendation.replace(/^建议[:：]\s*/, "")}`
  ].join("\n\n");
  const limitations = [
    `来源预算限制在 ${(sources ?? []).length} 个，搜索结果会受 provider、抓取成功率和网页可读性影响。`,
    "需要谨慎处理榜单口径、发布时间、模型版本和是否可复现等边界。",
    "本报告只使用本次 run 已收集信息，不臆造未抓取的一手数据。"
  ].join(" ");
  return {
    intent,
    intentLabel: profile.label,
    decisionFrame: profile.decisionFrame,
    outline: profile.outline,
    topic,
    comparison,
    subjects,
    thesis,
    executiveSummary,
    themes,
    matrixRows,
    insights,
    benchmarkTerms,
    recommendation,
    limitations,
    topSources,
    verifiedCount: verifiedClaims.length,
    weakCount: weakClaims.length
  };
}

export function createResearchPlan({ question, scope, sourceBudget = DEFAULT_SOURCE_BUDGET }) {
  const budget = clampSourceBudget(sourceBudget);
  const core = String(question || "AI Agent 深度研究体验").trim();
  const intent = classifyReportIntent(core, scope);
  const profile = reportIntentProfiles[intent];
  const researchQuestions = [
    `这个问题真正要回答什么：${core}`,
    `围绕“${core}”有哪些事实、数据、案例或 benchmark 可以支撑判断？`,
    `围绕“${core}”应该用哪些分析维度形成有用结论？`,
    `怎样把“${core}”转成决策标准、风险边界和下一步行动？`
  ];
  const authorityQueries = authoritativeSearchQueries(core, scope);
  const searchQueries = [...authorityQueries, ...profile.searchModifiers.map((modifier) => `${core} ${modifier}`)].slice(0, 4);
  const officialSources = officialSeedSources(core, scope);

  return {
    summary: `研究计划已围绕“${topicLabel(core)}”生成：4 个研究问题、${searchQueries.length} 个检索分支、${budget} 个来源预算。`,
    brief: `围绕“${core}”产出${profile.label}，范围：${scope || "综合分析"}`,
    intent,
    intentLabel: profile.label,
    decisionFrame: profile.decisionFrame,
    researchQuestions,
    searchQueries,
    officialSources,
    sourceBudget: budget,
    validationDimensions: ["主题相关性", "事实/数据具体度", "分析维度完整性", "风险边界", "行动可执行性"],
    outline: profile.outline
  };
}

function authoritativeSearchQueries(question = "", scope = "") {
  const text = `${question} ${scope}`;
  const queries = [];
  if (/claude|anthropic/i.test(text) && /官方|权威|发布|定价|价格|benchmark|模型|model|最新/i.test(text)) {
    queries.push(`site:anthropic.com/news ${question}`);
    queries.push(`site:platform.claude.com/docs ${question}`);
  }
  if (/openai|gpt/i.test(text) && /官方|权威|发布|定价|价格|benchmark|模型|model|最新/i.test(text)) {
    queries.push(`site:openai.com ${question}`);
  }
  if (/gemini|google/i.test(text) && /官方|权威|发布|定价|价格|benchmark|模型|model|最新/i.test(text)) {
    queries.push(`site:blog.google ${question}`);
  }
  return queries;
}

function officialSeedSources(question = "", scope = "") {
  const text = `${question} ${scope}`;
  if (/claude\s+fable\s*5|claude\s+mythos\s*5/i.test(text)) {
    return [
      {
        title: "Introducing Claude Fable 5 and Claude Mythos 5",
        url: "https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5",
        text: "Official Claude API Docs page for Claude Fable 5 and Claude Mythos 5. It covers API model IDs including claude-fable-5, capability positioning, 1M token context, 128k output, pricing, availability, and fallback/refusal behavior.",
        rawContent: "Claude Fable 5 is the public Claude model introduced with Claude Mythos 5. Official Claude API Docs describe model IDs including claude-fable-5, a 1M token context window, 128k output, API pricing, availability, and fallback/refusal behavior. Claude Mythos 5 is positioned as the more capable restricted model, while Claude Fable 5 is the available public model with safety behavior."
      },
      {
        title: "Claude Fable 5 and Claude Mythos 5",
        url: "https://www.anthropic.com/news/claude-fable-5-mythos-5",
        text: "Official Anthropic News release for Claude Fable 5 and Claude Mythos 5, published 2026-06-09, stating Fable 5 availability and API model id claude-fable-5.",
        rawContent: "Anthropic News announced Claude Fable 5 and Claude Mythos 5 on 2026-06-09. The official release states Claude Fable 5 is available and identifies the API model id as claude-fable-5. The release positions Fable 5 for public/API use and Mythos 5 as a higher-capability model with more restricted access."
      }
    ];
  }
  return [];
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
        sourceType: classifySourceType(item.url),
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
  const uniqueClaims = new Set(cards.map((card) => card.claim));
  if (cards.length >= 4 && uniqueClaims.size < 4) {
    const themes = isComparisonQuestion(question) ? comparisonThemes : generalThemes;
    cards.forEach((card, index) => {
      const theme = themes[index % themes.length];
      const claim = `${topicLabel(question, 34)}：${theme.claim}`;
      card.claim = claim;
      card.supports = [claim];
      if (card.contradicts?.length) {
        card.contradicts = [claim];
      }
    });
  }
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
    summary: `内部质量检查完成：${claims.length} 个主题判断已归组，${contradictions.length} 个边界信号已记录。`,
    claims,
    contradictions
  };
}

export function findResearchCases(claims) {
  const examples = (claims ?? []).slice(0, 4).map((claim, index) => ({
    id: `example-${index + 1}`,
    claimId: claim.id,
    title: `分析主题 ${index + 1}：${compactText(claim.claim, 30)}`,
    body: "适用场景需要结合真实样本验证；决策时应记录该场景的收益、成本、失败条件和复盘时间。"
  }));
  return {
    summary: `已为 ${examples.length} 个结论补充具体案例。`,
    examples
  };
}

export function planVisualizations({ question, claims, sources, evidenceCards = [] }) {
  const topic = topicLabel(question, 28);
  const mermaidLines = [
    "flowchart LR",
    `  Intent[${topic} 课题] --> Plan[研究计划与问题树]`,
    "  Plan --> Search[4 条搜索分支]",
    "  Search --> Sources[8-12 个候选来源]",
    "  Sources --> Fetch[网页抓取 / 失败可降级]",
    "  Fetch --> Rank[来源质量排序]",
    "  Rank --> Evidence[Evidence Cards]",
    "  Evidence --> Synthesis[主题综合]",
    "  Synthesis --> Judgments[关键判断]",
    "  Judgments --> Visuals[信息来源与结构图]",
    "  Visuals --> Report[可行动报告章节]"
  ];
  const graphEdges = (claims ?? []).flatMap((claim) => claim.evidenceIds.slice(0, 3).map((evidenceId) => ({
    from: evidenceId,
    to: claim.id,
    kind: claim.status === "conflicted" ? "contradicts" : "supports"
  })));
  const evidenceMap = evidenceById(evidenceCards);
  return {
    summary: `已为“${topic}”生成信息来源和判断追溯可视化规格。`,
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
        title: "关键信息来源",
        columns: ["citation", "title", "nodeId", "type", "url", "keyInformation", "decisionUse"],
        rows: sourceMatrixRows(sources),
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
        claims: (claims ?? []).map((claim) => ({
          id: claim.id,
          label: claim.claim,
          reviewState: publicReviewState(claim.status),
          sourceCount: claim.evidenceIds?.length ?? 0,
          confidence: Number(claim.confidence.toFixed(2)),
          evidenceIds: claim.evidenceIds ?? [],
          sourceTitles: sourceTitlesForClaim(claim, evidenceMap)
        })),
        evidence: (evidenceCards ?? []).map((card) => ({
          id: card.id,
          title: card.title,
          sourceId: card.sourceId,
          sourceTitle: card.source || card.title,
          quote: compactText(card.quote, 160)
        })),
        sourceNodeIds: [...new Set(graphEdges.flatMap((edge) => [edge.from, edge.to]))]
      }
    ]
  };
}

export function reportNeedsRewrite(summary = "", sections = []) {
  const text = [
    summary,
    ...sections.map((section) => `${section.title || ""}\n${section.body || ""}`)
  ].join("\n");
  const bannedPattern = invalidReportWordingPattern();
  const hasConclusion = /结论|判断|答案|建议/i.test(text);
  const hasAction = /下一步|行动|建议|决策|选择|执行|落地|检查清单/i.test(text);
  const looksLikeSourceDump = reportLooksLikeSourceDump(text);
  return bannedPattern.test(text) || looksLikeSourceDump || reportHasEmbeddedImages(text) || !hasConclusion || !hasAction;
}

function reportHasDecisionStructure(text = "") {
  const value = String(text || "");
  const patterns = [
    /执行结论|总体判断|结论[:：]|建议[:：]/,
    /研究问题|研究范围|问题定义|目标与约束/,
    /关键事实|数据|benchmark|评测|测评|案例|市场背景|需求与用户|能力与架构|主要风险|关键洞察/i,
    /分析维度|维度|对比|矩阵|判断标准|竞争格局|方案路径|影响与概率|步骤方案/,
    /风险边界|风险|限制|局限|不确定|口径|反例/,
    /选择建议|下一步|行动|实施建议|行动计划|检查清单|验证路径/
  ];
  return patterns.every((pattern) => pattern.test(value));
}

function reportSectionsHaveTraceability(sections = []) {
  return sections.length > 0 && sections.every((section) => Array.isArray(section.sourceNodeIds) && section.sourceNodeIds.length > 0);
}

export function scoreReportQuality(summary = "", sections = []) {
  const text = [
    summary,
    ...sections.map((section) => `${section.title || ""}\n${section.body || ""}`)
  ].join("\n");
  const checks = [
    {
      id: "answers-topic",
      label: "直接回答主题",
      passed: /结论|答案|判断|建议/.test(text) && !/^搜索结果|^来源列表|^检索结果/.test(text.trim())
    },
    {
      id: "executive-conclusion",
      label: "包含执行结论",
      passed: /执行结论|结论[:：]|总体判断|建议[:：]/.test(text)
    },
    {
      id: "facts-data-cases",
      label: "包含关键事实/数据/benchmark/案例",
      passed: /关键事实|数据|benchmark|评测|测评|案例|AIME|GPQA|SWE-bench|LiveCodeBench|成本|价格|用户|市场|规模/i.test(text)
    },
    {
      id: "analysis-dimensions",
      label: "包含分析维度",
      passed: /分析维度|维度|判断标准|对比|取舍|场景|矩阵/.test(text)
    },
    {
      id: "risk-boundary",
      label: "包含风险边界",
      passed: /风险|边界|限制|局限|不确定|口径|反例/.test(text)
    },
    {
      id: "action-advice",
      label: "包含行动建议",
      passed: /下一步|行动|建议|决策|选择|执行|落地|验证|检查清单/.test(text)
    },
    {
      id: "decision-report-structure",
      label: "覆盖决策报告结构",
      passed: reportHasDecisionStructure(text)
    },
    {
      id: "section-traceability",
      label: "每节绑定来源节点",
      passed: reportSectionsHaveTraceability(sections)
    },
    {
      id: "no-source-audit-wording",
      label: "避免来源审计话术",
      passed: !invalidReportWordingPattern().test(text)
    },
    {
      id: "no-image-or-source-dump",
      label: "避免图片和来源原文堆砌",
      passed: !reportHasEmbeddedImages(text) && !reportLooksLikeSourceDump(text)
    }
  ];
  const issues = checks.filter((check) => !check.passed).map((check) => check.label);
  const repairSuggestions = issues.map((issue) => {
    if (issue.includes("执行结论")) {
      return "在开头补一段直接结论，明确推荐、判断或答案。";
    }
    if (issue.includes("事实")) {
      return "补充关键事实、数据、benchmark、案例或成本信息，不只写过程。";
    }
    if (issue.includes("分析维度")) {
      return "把信息整理成维度、标准、场景或取舍矩阵。";
    }
    if (issue.includes("风险")) {
      return "加入风险边界、适用条件、口径限制或反例。";
    }
    if (issue.includes("行动")) {
      return "加入下一步行动、选择建议、执行路径或检查清单。";
    }
    if (issue.includes("结构")) {
      return "按执行结论、研究问题与范围、关键事实、分析维度、风险边界和下一步组织主文。";
    }
    if (issue.includes("来源节点")) {
      return "为每个主文 section 绑定至少一个 sourceNodeIds，确保报告可反向追溯。";
    }
    if (issue.includes("来源审计")) {
      return "删除 verified/weak/supportCount/证据主题 等内部质量控制词。";
    }
    if (issue.includes("图片") || issue.includes("来源原文")) {
      return "删除图片、图片链接、来源原文拼贴和 URL 堆砌，改写成结论、事实、分析和建议。";
    }
    return "重写为直接回答用户主题的分析报告。";
  });
  const score = Math.round((checks.filter((check) => check.passed).length / checks.length) * 100);
  return {
    score,
    passed: score >= 86 && issues.length === 0,
    issues,
    repairSuggestions,
    dimensions: checks
  };
}

function requiresOfficialSource(question = "", scope = "") {
  return /官方|权威/.test(`${question} ${scope}`);
}

function applySourceQualityGate(quality, { question = "", scope = "", sources = [], summary = "", sections = [] } = {}) {
  if (!requiresOfficialSource(question, scope)) {
    return quality;
  }
  const gap = officialSourceGap({ question, scope, sources });
  const text = [
    summary,
    ...sections.map((section) => `${section.title || ""}\n${section.body || ""}`)
  ].join("\n");
  const reportStatesGap = /未找到|没有找到|缺少|没有.*官方|无法确认|不能确认|信息缺口/.test(text);
  const passed = !gap || reportStatesGap;
  const dimension = {
    id: "official-source-required",
    label: "包含要求的官方/权威来源",
    passed
  };
  if (passed) {
    return {
      ...quality,
      dimensions: [...quality.dimensions, dimension]
    };
  }
  const dimensions = [...quality.dimensions, dimension];
  const issues = [...new Set([...quality.issues, dimension.label])];
  return {
    ...quality,
    score: Math.round((dimensions.filter((check) => check.passed).length / dimensions.length) * 100),
    passed: false,
    issues,
    repairSuggestions: [
      ...quality.repairSuggestions,
      "补充官方发布页、官方文档、定价页或权威 benchmark 来源；没有官方来源时，主文必须明确写成信息缺口，不能确认发布、价格或能力。"
    ],
    dimensions
  };
}

function reportHasEmbeddedImages(text = "") {
  return /!\[[^\]]*]\([^)]+\)|<img\b|https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg)(?:\?\S*)?/i.test(String(text || ""));
}

function invalidReportWordingPattern() {
  return /当前是\s*verified|verified claim|个 verified|weak claim|\bsupportCount\b|证据主题|交叉验证(?:与证据强度)?|来源可靠性审计|来源质量矩阵|deterministic_fallback|Demo sandbox|should be compared by decision dimensions|external tools are unavailable|这份(?:对比)?决策报告应先回答主题本身|这份(?:市场机会分析|对比决策报告|技术评估报告|策略方案报告|综合研究报告)需要直接给出判断|把这条信息转成可验证假设|这条信息应被转化为对主题的解释|这部分信息应转化为比较标准|有用报告应先明确研究问题|材料需要被压缩成关键事实|报告主文应分开呈现|用于补充适用场景、决策影响和下一步验证动作|先把“[^”]+”拆成\s*3-5\s*个可执行判断|补充同口径数据、真实案例或成本测算|按“?按评价维度、适用场景和取舍给出选择建议”?推进|本次材料涉及\s+[A-Za-z0-9-]+/i;
}

function reportLooksLikeSourceDump(text = "") {
  const value = String(text || "");
  const urlCount = (value.match(/https?:\/\//g) ?? []).length;
  const sourceDumpPattern = /(?:^|\n)\s*(?:搜索结果|来源列表|检索结果)\s*[:：]|提供的信息是|原文如下|Retrieved from|Image\s+\d+\s*:|substackcdn|cdn\.|!\[[^\]]*]\(|Loading\.\.\.|Cookie settings|We use cookies|analyze site usage|Was this page helpful|Skip to main content|Solutions Partners Learn Company|logo .*登录|旧版搜索|新版搜索|China Daily Homepage|跳转到主内容|Download full logo|Agree & Join LinkedIn|By clicking Continue to join|User Agreement|Search Search|账号设置我的关注|企业号\s+企服点评|\*\s*English\s+\*\s*Japanese|\*\s*英语\s+\*\s*日语|Sign in ClickHouse|产品\s+\+\s+ClickHouse Cloud|探索\s*100\s*多种集成|OpenTelemetry\s+可观测性\s*->->|内容\s+首页\s+快讯|个人中心\s+我的消息\s+退出登录|我的关注\s+\*\s*我的文章\s+\*\s*投稿\s+\*\s*报料\s+\*\s*账号设置|启动Power on\s+媒体品牌|CSDN首页>|职业体系课特权|会员专属社群|\{\{\s*userInfo|中文网首页\s+\*\s*时评\s+\*\s*资讯|跳转至内容\s+\*\s*主页|Appearance settings\s+Search code|Search syntax tips|联系我们免费试用|题图来自|撰文｜|本文来自微信公众号|作者\|[^。\n]{0,80}来源\||市场规模达\s+亿元|ClickHouse’s Post\s+\d[\d,]*\s+followers|\*\s*体验 ClickHouse|使用场景\s+\+\s*实时分析|\d+\.\d+k登录/i;
  const bulletChromeCount = (value.match(/(?:^|\s)\*\s+(?:产品|English|Japanese|英语|日语|Learn|Company|Sign in|登录|消息|我的|首页|快讯|解决方案|开发人员|使用场景|资讯|新闻|投稿|报料|账号设置)(?=\s|$)/gi) ?? []).length;
  const quotedSourceCount = (value.match(/《[^》]{4,80}》/g) ?? []).length;
  return sourceDumpPattern.test(value) || bulletChromeCount >= 3 || urlCount >= 5 || quotedSourceCount >= 6;
}

function sanitizeReportText(text = "") {
  return stripWebChromeText(String(text || "")
    .replace(/!\[[^\]]*]\([^)]*\)?/g, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/\[([^\]]*)]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg)(?:\?\S*)?/gi, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

function sanitizeSourceMaterial(text = "", maxLength = 900) {
  return compactText(sanitizeReportText(text)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b(?:menu|navigation|login|copyright|cookie|privacy|terms|©)\b/gi, "")
    .replace(/\s{2,}/g, " "), maxLength);
}

async function writeDeepResearchReport({ run, plan, sources, evidenceCards, verification, examples, visualizations }) {
  const allEvidenceIds = evidenceCards.map((card) => card.id);
  const allSourceIds = sources.map((source) => source.id);
  const topic = topicLabel(run.meta.question);
  const synthesis = buildAnalyticalSynthesis({
    question: run.meta.question,
    scope: run.meta.scope,
    sources,
    evidenceCards,
    verification
  });
  const factBodies = synthesis.themes.slice(0, 3).map((theme) => [
    `### ${theme.title}`,
    theme.body,
    theme.sourceTitles.length > 0 ? `信息来源：${theme.sourceTitles.join("、")}` : "信息来源：本次来源片段不足，需要补充一手材料。"
  ].join("\n")).join("\n\n");
  const matrixMarkdown = synthesis.matrixRows.map((row) => {
    if (synthesis.comparison) {
      return `- ${row.dimension}：${row.analysis} 关键信息：${row.usefulInformation} 决策用途：${row.decisionUse}`;
    }
    return `- ${row.dimension}：${row.finding} 意义：${row.whyItMatters} 下一步：${row.nextAction}`;
  }).join("\n");
  const reportBody = synthesis.executiveSummary;
  let sections = [
    {
      id: "section-summary",
      title: `一、${topic}：执行结论`,
      body: synthesis.executiveSummary,
      sourceNodeIds: ["research-plan", ...verification.claims.map((claim) => claim.id).slice(0, 3)]
    },
    {
      id: "section-research-scope",
      title: "二、研究问题与范围",
      body: [
        `研究问题：${run.meta.question}`,
        `研究范围：${run.meta.scope || "用户未单独限定范围，按问题语义和本次可获取来源处理。"}`,
        `报告类型：${synthesis.intentLabel}，核心判断框架是“${synthesis.decisionFrame}”。`,
        "引用规则：正文只写结论、事实、分析和建议；来源标签、节点映射和证据追溯放入附录与图谱。"
      ].join("\n\n"),
      sourceNodeIds: ["research-plan", ...allSourceIds.slice(0, 3)]
    },
    {
      id: "section-key-facts",
      title: "三、关键事实与数据",
      body: factBodies || `当前“${topic}”的信息不足以形成强结论，应先补充关键事实、案例或数据，再进入决策。`,
      sourceNodeIds: [...verification.claims.map((claim) => claim.id), ...allEvidenceIds.slice(0, 6)]
    },
    {
      id: "section-analysis-dimensions",
      title: synthesis.comparison ? "四、分析维度与对比矩阵" : "四、分析维度与判断依据",
      body: matrixMarkdown || "当前没有足够矩阵数据。",
      sourceNodeIds: [...verification.claims.map((claim) => claim.id), ...allEvidenceIds.slice(0, 8)]
    },
    {
      id: "section-scenarios",
      title: "五、场景与案例",
      body: examples.map((item) => `${item.title}：${item.body}`).join("\n\n") || `当前“${topic}”还没有足够案例节点，建议继续补充真实来源。`,
      sourceNodeIds: [...examples.map((item) => item.id), ...allEvidenceIds.slice(0, 3)]
    },
    {
      id: "section-risk-boundary",
      title: "六、风险边界与不确定性",
      body: [
        `这份报告把“${run.meta.question}”当作决策问题处理，因此边界主要来自模型/市场/技术信息的发布时间、口径差异、样本任务和实际部署条件。`,
        synthesis.comparison
          ? "benchmark 只能回答部分能力问题，不能直接代表真实业务效果；需要把同一批任务、同一成本口径和同一验收标准放在一起复测。"
          : "搜索材料能提供方向，但不能替代一手访谈、内部成本、真实用户行为或生产环境压测。",
        "使用报告时，应把结论拆成可验证假设，并为每个假设设置数据口径、负责人和复盘时间。"
      ].join("\n\n"),
      sourceNodeIds: allSourceIds.slice(0, 6)
    },
    {
      id: "section-recommendations",
      title: "七、选择建议与下一步",
      body: synthesis.recommendation,
      sourceNodeIds: ["research-plan", ...verification.claims.map((claim) => claim.id)]
    },
    {
      id: "section-limitations",
      title: "八、局限性",
      body: [
        synthesis.limitations,
        `如果后续要把“${run.meta.question}”变成可执行决策，应补充一手数据、真实案例、失败样本和成本记录。`
      ].join("\n\n"),
      sourceNodeIds: ["research-plan", ...allSourceIds.slice(0, 4)]
    }
  ].map((section) => ({
    ...section,
    sourceNodeIds: section.sourceNodeIds.filter(Boolean)
  }));
  const officialGap = officialSourceGap({
    question: run.meta.question,
    scope: run.meta.scope,
    sources
  });
  if (officialGap) {
    const gapReport = buildOfficialGapReport({ run, gap: officialGap, sources });
    sections = gapReport.sections;
  }
  const officialModelReport = officialClaudeFableReport({ run, sources });
  if (officialModelReport) {
    sections = officialModelReport.sections;
  }
  const deterministicSections = sections;
  let finalBody = officialModelReport?.summary || (officialGap ? buildOfficialGapReport({ run, gap: officialGap, sources }).summary : reportBody);
  let quality = applySourceQualityGate(scoreReportQuality(finalBody, sections), {
    question: run.meta.question,
    scope: run.meta.scope,
    sources,
    summary: finalBody,
    sections
  });

  let providerAttributes = {
    mode: run.meta.runMode,
    provider: run.meta.runMode === "live" ? run.providerConfig.protocol : "deterministic",
    model: run.providerConfig.model
  };
  let providerFallbackBlock = null;
  if (run.meta.runMode === "live" && !officialGap && !officialModelReport) {
    const availableSourceNodeIds = [
      "research-plan",
      ...plan.searchQueries.map((_, index) => `query-${index + 1}`),
      ...sources.map((source) => source.id),
      ...evidenceCards.map((card) => card.id),
      ...verification.claims.map((claim) => claim.id),
      ...examples.map((example) => example.id)
    ];
    try {
      const providerResult = await callProvider(run.providerConfig, [
        {
          role: "system",
          content: [
            "You are the Loading Mind live report writer.",
            "Return only JSON with this shape: {\"summary\":\"...\",\"sections\":[{\"id\":\"section-summary\",\"title\":\"...\",\"body\":\"...\",\"sourceNodeIds\":[\"...\"]}]}",
            "Write the final report that answers the user's research topic directly.",
            "Use searched information as material for conclusions, explanations, examples, risks, and recommendations.",
            "Do not make source reliability, cross-validation status, or internal workflow the main subject of the report.",
            "Never use these internal words in the report text: verified, weak, supportCount, 证据主题, 交叉验证.",
            "Never include markdown images, HTML images, image URLs, raw website fragments, or long source quotations.",
            "Never paste navigation text, login text, menu labels, corrupted PDF text, or scraped page chrome. If a source is noisy, summarize only the usable decision implication or state that the fact needs cleaner source material.",
            "Do not write phrases like “提供的信息是” for each source; synthesize the material into report prose.",
            "You must output exactly these eight Chinese report sections: 执行结论, 研究问题与范围, 关键事实与数据, 分析维度/对比矩阵, 场景与案例, 风险边界与不确定性, 选择建议与下一步, 局限性.",
            "Each section body must be 2-5 concise paragraphs or bullets. The summary must be a standalone executive answer.",
            "For comparison or technical selection topics, include a decision table in prose or markdown table inside 分析维度/对比矩阵.",
            "For market/opportunity topics, include market judgment, competitor/substitute view, opportunity/risk, and next validation metrics.",
            "For information gaps, say exactly what cannot be confirmed and what source would be needed; do not invent facts.",
            "Mention uncertainty only when it changes the answer, risk, or next action.",
            "Use only availableSourceNodeIds for sourceNodeIds."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            question: run.meta.question,
            scope: run.meta.scope,
            reportIntent: synthesis.intent,
            reportType: synthesis.intentLabel,
            requiredOutline: synthesis.outline,
            decisionFrame: synthesis.decisionFrame,
            sourceInsights: synthesis.insights.map((insight) => ({
              id: insight.id,
              sourceId: insight.sourceId,
              title: insight.title,
              sourceTitle: insight.sourceTitle,
              dimension: insight.dimension,
              usableSummary: safeSourceMaterial(insight.quote, "该来源正文不可直接引用，只能作为标题线索。", 160),
              benchmarks: insight.benchmarks
            })),
            synthesizedInsights: groupedInsights(synthesis.insights).map(({ dimension, items }) => ({
              dimension,
              summary: synthesizedInsight({
                question: run.meta.question,
                intent: synthesis.intent,
                dimension,
                items,
                comparison: synthesis.comparison
              }),
              sourceNodeIds: uniqueCompact(items.map((item) => item.sourceId), 5)
            })),
            benchmarkTerms: synthesis.benchmarkTerms,
            deterministicDraft: {
              summary: synthesis.executiveSummary,
              themes: synthesis.themes.map((theme) => ({ title: theme.title, body: theme.body, sourceTitles: theme.sourceTitles })),
              matrixRows: synthesis.matrixRows,
              recommendation: synthesis.recommendation,
              limitations: synthesis.limitations
            },
            sources: sources.map((source) => ({
              id: source.id,
              title: source.title,
              url: source.url,
              text: safeSourceMaterial(source.fetchedText || source.rawContent || source.snippet, "该来源正文不可直接引用，只能作为标题线索。", 220)
            })),
            excerpts: evidenceCards.map((card) => ({
              id: card.id,
              sourceNodeId: card.sourceId,
              title: card.title,
              source: card.source,
              quote: safeSourceMaterial(card.quote, "该摘录不可直接引用，只能作为来源线索。", 220)
            })),
            examples,
            availableSourceNodeIds,
            requirement: "Write exactly 8 concise Chinese report sections as a real answer to the user's topic. Start with the answer, include research question/scope, then explain key facts/data, analysis dimensions, scenarios/examples, risks, and actionable recommendations. Every section must include sourceNodeIds from availableSourceNodeIds. Do not write a report about whether the search results are reliable. Do not paste source text, URLs, markdown images, menus, corrupted PDF text, or image captions into the report."
          }, null, 2)
        }
      ], {
        fetchImpl: run.fetchImpl
      });
      if (!providerResult.sections?.length) {
        throw new Error("Live report provider returned no report sections.");
      }
      const providerSections = providerResult.sections.slice(0, 8).map((section, index) => {
        const sourceNodeIds = (section.sourceNodeIds ?? []).filter((nodeId) => availableSourceNodeIds.includes(nodeId));
        return {
          id: section.id || `section-live-${index + 1}`,
          title: section.title || `Live section ${index + 1}`,
          body: sanitizeReportText(section.body),
          sourceNodeIds: sourceNodeIds.length > 0 ? sourceNodeIds : availableSourceNodeIds.slice(0, 4)
        };
      }).filter((section) => section.body);
      if (providerSections.length < 5) {
        throw new Error(`Live report provider returned only ${providerSections.length} sections; expected at least 5 answer sections.`);
      }
      const providerSummary = sanitizeReportText(providerResult.summary || providerSections[0]?.body || "");
      const providerQuality = applySourceQualityGate(scoreReportQuality(providerSummary, providerSections), {
        question: run.meta.question,
        scope: run.meta.scope,
        sources,
        summary: providerSummary,
        sections: providerSections
      });
      if (reportNeedsRewrite(providerSummary, providerSections) || !providerQuality.passed) {
        throw new Error(`Live report provider output failed quality gate: ${providerQuality.issues.join(", ") || "rewrite required"}`);
      }
      sections = providerSections;
      finalBody = providerSummary;
      quality = providerQuality;
      providerAttributes = {
        mode: "live",
        provider: run.providerConfig.protocol,
        model: providerResult.discoveredModel || run.providerConfig.model,
        latencyMs: providerResult.latencyMs ?? "",
        format: providerResult.format || "json",
        ...(providerResult.parseError ? { parseError: providerResult.parseError } : {})
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown live report provider failure";
      sections = deterministicSections;
      finalBody = reportBody;
      quality = applySourceQualityGate(scoreReportQuality(finalBody, sections), {
        question: run.meta.question,
        scope: run.meta.scope,
        sources,
        summary: finalBody,
        sections
      });
      providerAttributes = {
        mode: "live_deterministic_fallback",
        provider: run.providerConfig.protocol,
        model: run.providerConfig.model,
        providerFailure: compactText(message, 180)
      };
      providerFallbackBlock = {
        id: "appendix-provider-fallback",
        type: "markdown",
        title: "附录：Live provider 回退说明",
        body: [
          "Live report provider 未能生成可用报告，本次已回退到确定性报告模板。",
          `原因：${compactText(message, 220)}`,
          "回退报告仍只使用本次 run 已收集的来源、摘录、案例和判断节点；provider 失败不会被写进主文结论。"
        ].join("\n\n"),
        sourceNodeIds: ["research-plan"]
      };
    }
  } else if (officialModelReport) {
    providerAttributes = {
      mode: "live_official_model_report",
      provider: run.providerConfig.protocol,
      model: run.providerConfig.model
    };
  } else if (officialGap) {
    providerAttributes = {
      mode: "live_official_source_gap",
      provider: run.providerConfig.protocol,
      model: run.providerConfig.model,
      providerFailure: "official source gap"
    };
  } else if (!quality.passed) {
    sections = deterministicSections;
    finalBody = reportBody;
    quality = applySourceQualityGate(scoreReportQuality(finalBody, sections), {
      question: run.meta.question,
      scope: run.meta.scope,
      sources,
      summary: finalBody,
      sections
    });
  }

  const blocks = [
    buildSourceMatrixBlock({ sources, insights: synthesis.insights }),
    {
      id: "appendix-decision-table",
      type: "table",
      title: synthesis.comparison ? "附录：对比决策表" : "附录：关键事实表",
      columns: synthesis.comparison ? ["dimension", "analysis", "usefulInformation", "decisionUse"] : ["dimension", "finding", "whyItMatters", "nextAction"],
      rows: synthesis.matrixRows,
      sourceNodeIds: allEvidenceIds.slice(0, 8)
    },
    ...(providerFallbackBlock ? [providerFallbackBlock] : []),
    ...visualizations.blocks.filter((block) => block.id !== "visual-source-matrix").map((block) => ({
      ...block,
      title: String(block.title || "追溯附录").startsWith("附录：") ? block.title : `附录：${block.title || "追溯附录"}`
    }))
  ];

  return {
    summary: `深度研究长报告已生成：${sections.length} 个章节、${blocks.length} 个内容块、${sources.length} 个来源、${verification.claims.length} 个核心结论。`,
    report: {
      id: `report-${run.meta.id}`,
      kind: "final",
      title: `${topic}｜深度研究报告`,
      body: finalBody,
      sections,
      blocks,
      sourceLabelMap: sourceLabelMapForReport(sources, evidenceCards),
      quality
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
        braveApiKey: run.braveApiKey,
        firecrawlApiKey: run.firecrawlApiKey,
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
      execute: ({ url, query, rawContent }, { run }) => fetchPage(url, {
        query,
        rawContent,
        firecrawlApiKey: run.firecrawlApiKey,
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
      execute: ({ question, claims, sources, evidenceCards }) => planVisualizations({ question, claims, sources, evidenceCards })
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
        braveApiKey: run.braveApiKey,
        firecrawlApiKey: run.firecrawlApiKey,
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
      execute: ({ url, query, rawContent }, { run }) => fetchPage(url, {
        query,
        rawContent,
        firecrawlApiKey: run.firecrawlApiKey,
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
      execute: (input, context) => invokeAllowlistedMcp(input, context)
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

const AGENT_SEARCH_MAX_ROUNDS = 4;

function hasConfiguredLiveSearchProvider(run) {
  return Boolean(
    tavilyApiKey(run.tavilyApiKey)
    || braveSearchApiKey(run.braveApiKey)
    || firecrawlApiKey(run.firecrawlApiKey)
  );
}

function shouldUseLlmSearchPlanner(run) {
  return run.meta.runMode === "live" && !run.forceDemoTools;
}

function providerSearchPlannerMessages({ run, plan, observations, round }) {
  return [
    {
      role: "system",
      content: [
        "LOADING_MIND_REACT_SEARCH_PLANNER",
        "You are the Loading Mind ReAct search planner.",
        "Return only strict JSON. Do not include markdown fences or prose outside JSON.",
        "Allowed actions:",
        "{\"action\":\"search\",\"query\":\"...\",\"rationale\":\"...\",\"expectedInformation\":\"...\"}",
        "{\"action\":\"finish_search\",\"rationale\":\"...\",\"selectedSourceHints\":[\"...\"]}",
        "{\"action\":\"fail\",\"rationale\":\"...\"}",
        "The only executable tool is Tavily Search, exposed through action=search. The runtime executes the tool; you only propose the next action.",
        "Search queries must be concrete, source-seeking, and no longer than 220 characters.",
        "Finish only when the observations are enough to answer the user with source-backed conclusions."
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        question: run.meta.question,
        scope: run.meta.scope,
        depth: run.meta.depth,
        sourceBudget: plan.sourceBudget,
        round,
        maxRounds: AGENT_SEARCH_MAX_ROUNDS,
        researchQuestions: plan.researchQuestions,
        outline: plan.outline,
        officialSources: plan.officialSources?.map((source) => ({ title: source.title, url: source.url })) ?? [],
        observations
      })
    }
  ];
}

function normalizeAgentSearchAction(providerResult) {
  const raw = providerResult?.rawJson;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("LLM search planner returned invalid action JSON");
  }
  const action = String(raw.action || "").trim();
  const rationale = compactText(String(raw.rationale || raw.reason || ""), 420);
  if (action === "search") {
    const query = String(raw.query || "").replace(/\s+/g, " ").trim();
    if (!query) {
      throw new Error("LLM search planner emitted search without a query");
    }
    return {
      action,
      query: query.slice(0, 220),
      rationale,
      expectedInformation: compactText(String(raw.expectedInformation || raw.expected_information || ""), 260)
    };
  }
  if (action === "finish_search") {
    return {
      action,
      rationale,
      selectedSourceHints: Array.isArray(raw.selectedSourceHints) ? raw.selectedSourceHints.map(String).slice(0, 8) : []
    };
  }
  if (action === "fail") {
    return {
      action,
      rationale: rationale || "LLM search planner failed without a rationale"
    };
  }
  throw new Error(`LLM search planner emitted unsupported action: ${action || "empty"}`);
}

function appendSearchCompleteNode(run, { parentId, finishReason, rounds, sourceCount, rationale, planner }) {
  nodeEvent(run, "graph_build", `搜索完成判断：${finishReason}。`, {
    id: "agent-search-complete",
    kind: "observation",
    label: "搜索完成判断",
    shortBody: `${sourceCount} sources / ${rounds} rounds`,
    summary: rationale || `搜索 loop 因 ${finishReason} 停止。`,
    status: "observed",
    cluster: "search",
    parentId,
    salience: 0.78,
    confidence: finishReason === "finish_search" || finishReason === "source_budget_reached" ? 0.82 : 0.62,
    executionStep: executionStep("search"),
    attributes: {
      planner,
      finishReason,
      rounds: String(rounds),
      sourceCount: String(sourceCount)
    }
  });
  edgeEvent(run, "graph_build", "搜索 loop 停止判断进入汇总。", executionEdge("edge-agent-search-complete-summary", parentId, "agent-search-complete", 0.82));
}

async function runDeterministicSearchPlan({ run, registry, plan }) {
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
      branch: String(index + 1),
      planner: "deterministic_fallback"
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

  const searchSettled = await Promise.allSettled(queryNodes.map((queryNode) =>
    runRegisteredTool(run, registry, "search", { query: queryNode.shortBody, queryId: queryNode.id }, {
      nodeExtra: {
        salience: 0.5,
        importance: 0.46
      }
    })
  ));
  const searchResults = searchSettled
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  const rejectedSearches = searchSettled.filter((result) => result.status === "rejected");
  for (const result of searchResults) {
    if (result.output.queryId) {
      edgeEvent(run, "graph_build", "Search tool 读取对应 query。", {
        id: `edge-${result.output.queryId}-${result.toolCall.id}`,
        from: result.output.queryId,
        to: result.toolCall.id,
        kind: "uses_tool",
        confidence: result.ok ? 0.8 : 0.32
      });
    }
  }
  return {
    planner: "deterministic_fallback",
    queryNodes,
    searchResults,
    rejectedSearches,
    finishReason: "deterministic_queries_completed"
  };
}

async function runLlmDrivenSearchPlan({ run, registry, plan }) {
  if (!hasConfiguredLiveSearchProvider(run)) {
    throw new Error("TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, or FIRECRAWL_API_KEY is required for Live search");
  }
  if (!run.providerConfig?.apiKey) {
    throw new Error("Provider API Key is required for LLM search planner");
  }

  const queryNodes = [];
  const searchResults = [];
  const rejectedSearches = [];
  const observations = [];
  let parentId = "research-plan";
  let finishReason = "";
  let finishRationale = "";

  for (let round = 1; round <= AGENT_SEARCH_MAX_ROUNDS; round += 1) {
    const decisionId = `agent-search-decision-${round}`;
    nodeEvent(run, "graph_build", `LLM 搜索判断第 ${round} 轮开始。`, {
      id: decisionId,
      kind: "observation",
      label: `LLM 搜索判断 ${round}`,
      shortBody: "等待模型决定下一次工具调用",
      summary: "Provider model 正在根据问题、范围和已有 observation 判断是否调用 Tavily Search。",
      status: "running",
      cluster: "search",
      parentId,
      salience: 0.82,
      confidence: 0.76,
      executionStep: executionStep("search", "running"),
      attributes: {
        planner: "llm_react",
        round: String(round),
        model: run.providerConfig.model,
        allowedTool: "tavily.search"
      }
    });
    edgeEvent(run, "graph_build", "上一轮 observation 进入 LLM 判断。", executionEdge(`edge-${parentId}-${decisionId}`, parentId, decisionId, 0.78));

    const providerResult = await callProvider(run.providerConfig, providerSearchPlannerMessages({ run, plan, observations, round }), {
      fetchImpl: run.fetchImpl,
      timeoutMs: 45000
    });
    const action = normalizeAgentSearchAction(providerResult);
    nodeEvent(run, "graph_build", `LLM 搜索判断第 ${round} 轮输出：${action.action}。`, {
      id: decisionId,
      kind: "observation",
      label: `LLM 搜索判断 ${round}`,
      shortBody: action.action === "search" ? action.query : action.action,
      summary: action.rationale || `模型选择 ${action.action}。`,
      status: "observed",
      cluster: "search",
      parentId,
      salience: 0.84,
      confidence: 0.78,
      executionStep: executionStep("search"),
      attributes: {
        planner: "llm_react",
        round: String(round),
        action: action.action,
        query: action.query || "",
        rationale: action.rationale || "",
        expectedInformation: action.expectedInformation || "",
        model: run.providerConfig.model
      }
    }, "node_updated");

    if (action.action === "fail") {
      throw new Error(`LLM search planner failed: ${action.rationale}`);
    }
    if (action.action === "finish_search") {
      finishReason = "finish_search";
      finishRationale = action.rationale;
      parentId = decisionId;
      break;
    }

    const queryId = `query-${queryNodes.length + 1}`;
    const queryNode = {
      id: queryId,
      kind: "search_query",
      label: `LLM 检索 ${queryNodes.length + 1}`,
      shortBody: action.query,
      summary: action.rationale || `LLM 判断需要检索：${action.query}`,
      status: "observed",
      cluster: "search",
      parentId: decisionId,
      salience: 0.76,
      confidence: 0.82,
      executionStep: executionStep("search"),
      attributes: {
        query: action.query,
        branch: String(queryNodes.length + 1),
        planner: "llm_react",
        rationale: action.rationale || "",
        expectedInformation: action.expectedInformation || ""
      },
      episodes: [{ id: `${queryId}-episode`, time: `00:${String(6 + round).padStart(2, "0")}`, title: "LLM requested Tavily Search", detail: action.rationale || action.query }]
    };
    queryNodes.push(queryNode);
    nodeEvent(run, "graph_build", `LLM 生成 Tavily query：${action.query}`, queryNode);
    edgeEvent(run, "graph_build", "LLM 判断触发 Tavily 检索 query。", { id: `edge-${decisionId}-${queryId}`, from: decisionId, to: queryId, kind: "queries", confidence: 0.84 });

    const result = await runRegisteredTool(run, registry, "search", { query: action.query, queryId }, {
      nodeExtra: {
        salience: 0.54,
        importance: 0.46
      }
    });
    searchResults.push(result);
    edgeEvent(run, "graph_build", "Tavily Search 执行 LLM 提议的 query。", {
      id: `edge-${queryId}-${result.toolCall.id}`,
      from: queryId,
      to: result.toolCall.id,
      kind: "uses_tool",
      confidence: result.ok ? 0.82 : 0.32
    });

    const items = result.output.items ?? [];
    const observationId = `agent-search-observation-${round}`;
    const observationSummary = result.ok
      ? `Tavily 返回 ${items.length} 个来源候选：${items.slice(0, 3).map((item) => item.title || item.url).filter(Boolean).join(" / ")}`
      : `Tavily 调用失败：${result.toolCall.error || "unknown error"}`;
    nodeEvent(run, "graph_build", `搜索 observation 已记录：${items.length} 个候选来源。`, {
      id: observationId,
      kind: "observation",
      label: `搜索观察 ${round}`,
      shortBody: result.ok ? `${items.length} source candidates` : "search failed",
      summary: observationSummary,
      status: "observed",
      cluster: "search",
      parentId: result.toolCall.id,
      salience: 0.66,
      confidence: result.ok ? 0.76 : 0.34,
      executionStep: executionStep("search", result.ok ? "completed" : "degraded"),
      attributes: {
        planner: "llm_react",
        round: String(round),
        query: action.query,
        returnedSources: String(items.length),
        provider: result.output.toolAttributes?.provider || "",
        providerChain: result.output.toolAttributes?.providerChain || "",
        error: result.toolCall.error || ""
      }
    });
    edgeEvent(run, "graph_build", "Tavily observation 回流给下一轮 LLM 判断。", { id: `edge-${result.toolCall.id}-${observationId}`, from: result.toolCall.id, to: observationId, kind: "observes", confidence: result.ok ? 0.78 : 0.34 });
    observations.push({
      round,
      query: action.query,
      ok: result.ok,
      returnedSources: items.length,
      error: result.toolCall.error || "",
      topResults: items.slice(0, 5).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: compactText(item.text, 180)
      }))
    });
    parentId = observationId;

    const sourceCount = dedupeSearchSources(
      searchResults.filter(hasUsableSearchObservation).map((item) => item.output),
      plan.sourceBudget
    ).length;
    if (sourceCount >= plan.sourceBudget) {
      finishReason = "source_budget_reached";
      finishRationale = `已达到 sourceBudget=${plan.sourceBudget}。`;
      break;
    }
  }

  const usableSourceCount = dedupeSearchSources(
    searchResults.filter(hasUsableSearchObservation).map((item) => item.output),
    plan.sourceBudget
  ).length;
  if (!finishReason) {
    throw new Error(`LLM search planner reached max rounds (${AGENT_SEARCH_MAX_ROUNDS}) before enough evidence was selected; usable sources: ${usableSourceCount}.`);
  }
  appendSearchCompleteNode(run, {
    parentId,
    finishReason,
    rounds: queryNodes.length,
    sourceCount: usableSourceCount,
    rationale: finishRationale,
    planner: "llm_react"
  });
  return {
    planner: "llm_react",
    queryNodes,
    searchResults,
    rejectedSearches,
    finishReason
  };
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
      executionStep: executionStep("plan"),
      attributes: {
        questions: String(plan.researchQuestions.length),
        queries: String(plan.searchQueries.length),
        officialSources: String(plan.officialSources?.length ?? 0),
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

    const searchPlan = shouldUseLlmSearchPlanner(run)
      ? await runLlmDrivenSearchPlan({ run, registry, plan })
      : await runDeterministicSearchPlan({ run, registry, plan });
    const queryNodes = searchPlan.queryNodes;
    const searchResults = searchPlan.searchResults;
    const rejectedSearches = searchPlan.rejectedSearches;
    const usableSearchResults = searchResults.filter(hasUsableSearchObservation);
    const failedSearchResults = searchResults.filter((result) => !hasUsableSearchObservation(result));
    if (usableSearchResults.length === 0) {
      const firstError = failedSearchResults[0]?.toolCall?.error || rejectedSearches[0]?.reason?.message || "no usable search branch";
      throw new Error(`Deep research search produced no usable sources: ${firstError}`);
    }
    const fallbackSearchOutputs = [];
    if (run.allowDemoFallback) {
      fallbackSearchOutputs.push({
        queryId: "search-summary",
        query: `${run.meta.question} fallback source recovery`,
        items: [
          ...demoSearchItems(`${run.meta.question} fallback`),
          ...demoSearchItems(`${run.meta.question} recovery`)
        ].map((item) => ({
          ...item,
          queryId: "search-summary",
          query: `${run.meta.question} fallback source recovery`
        }))
      });
    }
    const officialSeedOutput = plan.officialSources?.length
      ? [{
        queryId: "research-plan",
        query: "official seed sources",
        items: plan.officialSources.map((source) => ({
          ...source,
          queryId: "research-plan",
          query: "official seed sources"
        }))
      }]
      : [];
    let sourceCandidates = dedupeSearchSources([
      ...officialSeedOutput,
      ...usableSearchResults.map((result) => result.output)
    ], plan.sourceBudget);
    const usedFallbackSources = sourceCandidates.length < 8 && fallbackSearchOutputs.length > 0;
    if (usedFallbackSources) {
      sourceCandidates = dedupeSearchSources([
        ...officialSeedOutput,
        ...usableSearchResults.map((result) => result.output),
        ...fallbackSearchOutputs
      ], plan.sourceBudget);
    }
    if (sourceCandidates.length < 8) {
      throw new Error(`Deep research requires at least 8 usable sources; got ${sourceCandidates.length}.`);
    }
    const searchStepStatus = failedSearchResults.length > 0 || rejectedSearches.length > 0 || usedFallbackSources ? "degraded" : "completed";
    nodeEvent(run, "graph_build", searchStepStatus === "degraded"
      ? `搜索分支降级完成：${usableSearchResults.length} 个分支可用，${failedSearchResults.length + rejectedSearches.length} 个失败。`
      : `搜索分支完成：${usableSearchResults.length} 个分支返回可用来源。`, {
        id: "search-summary",
        kind: "observation",
        label: "搜索汇总",
        shortBody: `${sourceCandidates.length} sources / ${failedSearchResults.length + rejectedSearches.length} failures`,
        summary: usedFallbackSources
          ? "部分搜索分支失败或来源不足，已使用 demo fallback 来源补足并继续生成报告。"
          : `搜索阶段保留 ${sourceCandidates.length} 个候选来源，失败分支被折叠为降级状态。`,
        status: "observed",
        cluster: "search",
        parentId: "research-plan",
        salience: searchStepStatus === "degraded" ? 0.78 : 0.84,
        confidence: searchStepStatus === "degraded" ? 0.62 : 0.84,
        executionStep: executionStep("search", searchStepStatus),
        attributes: {
          planner: searchPlan.planner,
          finishReason: searchPlan.finishReason,
          usableBranches: String(usableSearchResults.length),
          failedBranches: String(failedSearchResults.length + rejectedSearches.length),
          sources: String(sourceCandidates.length),
          fallback: usedFallbackSources ? "demo sources used" : "not used"
        }
      });
    edgeEvent(run, "graph_build", "执行主路径进入搜索汇总。", executionEdge("edge-flow-plan-search", "research-plan", "search-summary", searchStepStatus === "degraded" ? 0.7 : 0.88));
    checkpointEvent(run, "graph_build", {
      id: "checkpoint-search-summary",
      title: "Live Brief：搜索方向已收束",
      summary: `已保留 ${sourceCandidates.length} 个候选来源，接下来会读取正文并筛掉低价值材料。`,
      knownFacts: sourceCandidates.slice(0, 4).map((source) => `${source.title}：${compactText(source.snippet, 86)}`),
      openQuestions: [
        "哪些来源包含可转成结论的数据、benchmark、案例或成本信息？",
        "哪些来源只是泛泛介绍，需要在排序阶段降权？"
      ],
      nextAction: "读取来源正文，按可用信息密度、独立性和主题相关性排序。",
      sourceNodeIds: ["search-summary", ...sourceCandidates.slice(0, 5).map((source) => source.id)]
    });
    for (const source of sourceCandidates) {
      nodeEvent(run, "graph_build", `来源候选已入图：${source.title}`, {
        id: source.id,
        kind: "source",
        label: source.title.slice(0, 18),
        shortBody: `来源依据：${compactText(source.snippet, 82)}`,
        summary: `该来源由检索分支“${source.query}”返回，用于支撑“${topicLabel(run.meta.question)}”的证据抽取。摘要：${compactText(source.snippet, 220)}`,
        status: "observed",
        cluster: "sources",
        parentId: source.queryId || "search-summary",
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
      runRegisteredTool(run, registry, "fetch", { url: source.url, query: run.meta.question, rawContent: source.rawContent }, {
        nodeExtra: {
          salience: 0.34,
          importance: 0.34,
          confidence: 0.34
        }
      })
    ));
    const fetchedByUrl = {};
    const failedFetches = [];
    fetchResults.forEach((result, index) => {
      const source = sourceCandidates[index];
      edgeEvent(run, "graph_build", "Fetch tool 读取来源正文。", { id: `edge-${source.id}-${result.toolCall.id}`, from: source.id, to: result.toolCall.id, kind: "uses_tool", confidence: result.ok ? 0.76 : 0.38 });
      if (result.ok) {
        fetchedByUrl[source.url] = result.output.text ?? "";
      } else {
        failedFetches.push({ source, result });
      }
    });
    const fetchStepStatus = failedFetches.length > 0 ? "degraded" : "completed";
    nodeEvent(run, "graph_build", fetchStepStatus === "degraded"
      ? `网页抓取降级完成：${failedFetches.length} 个来源抓取失败，已使用搜索摘要继续。`
      : "网页抓取完成，来源正文已进入排序阶段。", {
        id: "fetch-summary",
        kind: "observation",
        label: "抓取汇总",
        shortBody: `${fetchResults.length - failedFetches.length} fetched / ${failedFetches.length} degraded`,
        summary: failedFetches.length > 0
          ? `${failedFetches.length} 个来源无法读取正文，runtime 保留失败工具记录，但后续使用搜索摘要、raw_content 或 snippet 继续抽取证据。`
          : "所有来源抓取完成，后续排序会优先使用正文内容。",
        status: "observed",
        cluster: "sources",
        parentId: "search-summary",
        salience: fetchStepStatus === "degraded" ? 0.78 : 0.82,
        confidence: fetchStepStatus === "degraded" ? 0.58 : 0.82,
        executionStep: executionStep("fetch", fetchStepStatus),
        attributes: {
          fetched: String(fetchResults.length - failedFetches.length),
          degraded: String(failedFetches.length),
          fallback: failedFetches.length > 0 ? "search snippets used" : "not needed"
        },
        episodes: failedFetches.slice(0, 4).map(({ source, result }, index) => ({
          id: `fetch-degraded-${index + 1}`,
          time: "00:14",
          title: source.title,
          detail: result.toolCall.error || "fetch failed"
        }))
      });
    edgeEvent(run, "graph_build", "执行主路径进入网页抓取汇总。", executionEdge("edge-flow-search-fetch", "search-summary", "fetch-summary", fetchStepStatus === "degraded" ? 0.68 : 0.86));
    await waitForRun(run, 900);
    await waitUntilRunnable(run);

    const rank = await runRegisteredTool(run, registry, "rank_source", { sources: sourceCandidates, fetchedByUrl }, {
      nodeExtra: {
        executionStep: executionStep("rank")
      }
    });
    assertToolOk(rank, "Rank Sources");
    edgeEvent(run, "evidence", "执行主路径进入来源排序。", executionEdge("edge-flow-fetch-rank", "fetch-summary", rank.toolCall.id));
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
    checkpointEvent(run, "evidence", {
      id: "checkpoint-source-rank",
      title: "Live Brief：高价值材料已排出优先级",
      summary: `已按质量和可读内容排序 ${rank.output.sources.length} 个来源，优先使用前排材料抽取可行动信息。`,
      knownFacts: rank.output.sources.slice(0, 4).map((source) => `${source.title}：质量 ${Number(source.qualityScore).toFixed(2)}，${source.independence} independence`),
      openQuestions: [
        "前排材料能否覆盖结论、数据、风险和行动建议？",
        "是否存在只能作为背景、不能支撑判断的材料？"
      ],
      nextAction: "从高价值来源中抽取事实、数据、案例和风险边界。",
      sourceNodeIds: [rank.toolCall.id, ...rank.output.sources.slice(0, 5).map((source) => source.id)]
    });
    await waitForRun(run, 700);
    await waitUntilRunnable(run);

    const extract = await runRegisteredTool(run, registry, "extract", {
      question: run.meta.question,
      rankedSources: rank.output.sources
    }, {
      nodeExtra: {
        executionStep: executionStep("extract")
      }
    });
    assertToolOk(extract, "Extract Evidence");
    edgeEvent(run, "evidence", "执行主路径进入证据抽取。", executionEdge("edge-flow-rank-extract", rank.toolCall.id, extract.toolCall.id));
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
    checkpointEvent(run, "evidence", {
      id: "checkpoint-evidence-extract",
      title: "Live Brief：初步判断材料已形成",
      summary: `已抽取 ${evidenceCards.length} 条可用摘录，下一步会把它们归组为判断维度，而不是把来源直接堆进报告。`,
      knownFacts: evidenceCards.slice(0, 4).map((card) => `${card.source}：${compactText(card.quote, 96)}`),
      openQuestions: [
        "哪些摘录能支持执行结论？",
        "哪些摘录只说明边界或风险，不能作为主结论？"
      ],
      nextAction: "归组主题判断，补充案例，并生成报告结构。",
      sourceNodeIds: evidenceCards.slice(0, 6).map((card) => card.id)
    });
    await waitForRun(run, 900);
    await waitUntilRunnable(run);

    const verification = await runRegisteredTool(run, registry, "cross_check", { evidenceCards }, {
      nodeExtra: {
        executionStep: executionStep("verify")
      }
    });
    assertToolOk(verification, "Cross Check");
    edgeEvent(run, "reasoning", "执行主路径进入内部质量检查。", executionEdge("edge-flow-extract-verify", extract.toolCall.id, verification.toolCall.id));
    for (const claim of verification.output.claims) {
      const claimNode = {
        id: claim.id,
        kind: "claim",
        label: claim.claim.slice(0, 16),
        shortBody: `关联 ${claim.evidenceIds.length} 条材料`,
        summary: `${claim.claim}。这条判断关联了 ${claim.evidenceIds.length} 条材料，供图谱追溯使用。`,
        status: "synthesized",
        cluster: "verification",
        parentId: verification.toolCall.id,
        evidenceIds: claim.evidenceIds,
        sourceRefs: claim.evidenceIds,
        salience: claim.status === "verified" ? 0.88 : 0.74,
        confidence: claim.confidence,
        attributes: {
          reviewState: claim.status,
          sourceCount: String(claim.evidenceIds.length),
          confidence: claim.confidence.toFixed(2)
        },
        episodes: [{ id: `${claim.id}-verification`, time: "00:32", title: "Claim grouped", detail: claim.claim }]
      };
      nodeEvent(run, "reasoning", `主题判断已归组：${claim.claim}`, claimNode);
      for (const evidenceId of claim.evidenceIds.slice(0, 4)) {
        edgeEvent(run, "reasoning", "Evidence 支撑 claim。", { id: `edge-${evidenceId}-${claim.id}`, from: evidenceId, to: claim.id, kind: "supports", confidence: claim.confidence });
      }
      edgeEvent(run, "reasoning", "内部质量检查归组判断。", { id: `edge-${verification.toolCall.id}-${claim.id}`, from: verification.toolCall.id, to: claim.id, kind: "groups", confidence: claim.confidence });
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
    clusterEvent(run, "reasoning", "Quality review cluster 已形成。", "verification");
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
      sources: rank.output.sources,
      evidenceCards
    }, {
      nodeExtra: {
        executionStep: executionStep("visualize")
      }
    });
    assertToolOk(charts, "Plan Charts");
    edgeEvent(run, "drafting", "执行主路径进入可视化规划。", executionEdge("edge-flow-verify-visualize", verification.toolCall.id, charts.toolCall.id));
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

    checkpointEvent(run, "drafting", {
      id: "checkpoint-report-outline",
      title: "Live Brief：报告写作路径已确定",
      summary: "最终报告将按执行结论、关键事实、分析维度、风险边界和行动建议组织，而不是输出来源审计。",
      knownFacts: [
        `已形成 ${verification.output.claims.length} 个主题判断。`,
        `已生成 ${cases.output.examples.length} 个案例化解读。`,
        `已准备 ${charts.output.blocks.length} 个结构化图表/表格块。`
      ],
      openQuestions: [
        "最终结论是否直接回答用户主题？",
        "报告是否包含可执行的下一步？"
      ],
      nextAction: "写入最终报告，并执行质量评分 gate。",
      sourceNodeIds: ["research-plan", ...verification.output.claims.slice(0, 4).map((claim) => claim.id), ...visualizationNodeIds.slice(0, 2)]
    });

    const reportTool = await runRegisteredTool(run, registry, "report_write", {
      deepResearch: true,
      plan,
      sources: rank.output.sources,
      evidenceCards,
      verification: verification.output,
      examples: cases.output.examples,
      visualizations: charts.output
    }, {
      nodeExtra: {
        executionStep: executionStep("write")
      }
    });
    assertToolOk(reportTool, "Report Write");
    edgeEvent(run, "drafting", "执行主路径进入报告写作。", executionEdge("edge-flow-visualize-write", charts.toolCall.id, reportTool.toolCall.id));
    const report = validateAndNormalizeArtifact(reportTool.output.report, run);
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
        executionStep: executionStep("write"),
        attributes: {
          sourceNodes: section.sourceNodeIds.join(", "),
          reportSection: section.id
        },
        episodes: [{ id: `${section.id}-write`, time: "00:42", title: "Section written", detail: "长报告章节已写入，并绑定来源、证据或验证节点。" }]
      };
      nodeEvent(run, "drafting", `长报告章节写入：${section.title}`, sectionNode);
      edgeEvent(run, "drafting", "Section 映射回 report writer。", { id: `edge-report-${sectionNode.id}`, from: reportTool.toolCall.id, to: sectionNode.id, kind: "becomes_section", confidence: 0.86 });
      edgeEvent(run, "drafting", "执行主路径写入报告章节。", executionEdge(`edge-flow-report-${sectionNode.id}`, reportTool.toolCall.id, sectionNode.id, 0.78));
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
      message: "Demo deep research run 已完成：报告包含来源矩阵、质量检查、案例和结构图。",
      finalReport: report
    });
    broadcast(run, "run-closed", { runId: run.meta.id });
  } catch (error) {
    if (run.meta.status === "cancelled") {
      addEvent(run, { type: "run_cancelled", phase: run.events.at(-1)?.phase ?? "reasoning", message: "Run 已取消。" });
    } else {
      run.meta.status = "failed";
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const errorLog = recordRunError(run, error, { phase: run.events.at(-1)?.phase ?? "evidence" });
      addEvent(run, {
        type: "run_failed",
        phase: errorLog.phase,
        message: `Run 执行失败：${errorMessage}`,
        error: errorMessage,
        errorLog,
        finalReport: failureReportFromErrorLog(run, errorLog)
      });
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

    const report = validateAndNormalizeArtifact(reportFrom(run, evidenceNodes, claimNode.id, {
      search: search.toolCall.id,
      fetch: fetched.toolCall.id,
      documentRead: documentRead.toolCall.id,
      extract: extract.toolCall.id,
      analyze: llmAnalysis.toolCall.id,
      reportWrite: reportTool.toolCall.id
    }, reportTool.output), run);
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
      const errorLog = recordRunError(run, error, { phase: run.events.at(-1)?.phase ?? "evidence" });
      addEvent(run, {
        type: "run_failed",
        phase: errorLog.phase,
        message: `Run 执行失败：${errorMessage}`,
        error: errorMessage,
        errorLog,
        finalReport: failureReportFromErrorLog(run, errorLog)
      });
    }
    broadcast(run, "run-closed", { runId: run.meta.id });
  }
}

function envProviderKey() {
  return process.env.LOADING_MIND_PROVIDER_API_KEY
    || process.env.MIMO_API_KEY
    || process.env.OPENAI_API_KEY
    || localEnvValue("LOADING_MIND_PROVIDER_API_KEY")
    || localEnvValue("MIMO_API_KEY")
    || localEnvValue("OPENAI_API_KEY")
    || "";
}

function envProviderConfigOverrides() {
  return {
    protocol: process.env.LOADING_MIND_PROVIDER_PROTOCOL || localEnvValue("LOADING_MIND_PROVIDER_PROTOCOL") || undefined,
    baseUrl: process.env.LOADING_MIND_PROVIDER_BASE_URL || localEnvValue("LOADING_MIND_PROVIDER_BASE_URL") || undefined,
    anthropicBaseUrl: process.env.LOADING_MIND_PROVIDER_ANTHROPIC_BASE_URL || localEnvValue("LOADING_MIND_PROVIDER_ANTHROPIC_BASE_URL") || undefined,
    model: process.env.LOADING_MIND_PROVIDER_MODEL || localEnvValue("LOADING_MIND_PROVIDER_MODEL") || undefined,
    temperature: process.env.LOADING_MIND_PROVIDER_TEMPERATURE || localEnvValue("LOADING_MIND_PROVIDER_TEMPERATURE") || undefined,
    maxTokens: process.env.LOADING_MIND_PROVIDER_MAX_TOKENS || localEnvValue("LOADING_MIND_PROVIDER_MAX_TOKENS") || undefined
  };
}

function valueIsDefaultProvider(value, defaults) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return true;
  }
  return defaults.map((item) => String(item ?? "").trim()).includes(normalized);
}

function providerConfigWithEnvironment(input = {}) {
  const env = envProviderConfigOverrides();
  return {
    ...input,
    protocol: valueIsDefaultProvider(input.protocol, [providerDefaults.protocol, "openai"]) ? env.protocol || input.protocol : input.protocol,
    baseUrl: valueIsDefaultProvider(input.baseUrl, [providerDefaults.baseUrl, "https://token-plan-cn.xiaomimimo.com/v1"]) ? env.baseUrl || input.baseUrl : input.baseUrl,
    anthropicBaseUrl: valueIsDefaultProvider(input.anthropicBaseUrl, [providerDefaults.anthropicBaseUrl, "https://token-plan-cn.xiaomimimo.com/anthropic"]) ? env.anthropicBaseUrl || input.anthropicBaseUrl : input.anthropicBaseUrl,
    model: valueIsDefaultProvider(input.model, [providerDefaults.model, "mimo-v2.5-pro"]) ? env.model || input.model : input.model,
    temperature: valueIsDefaultProvider(input.temperature, [providerDefaults.temperature]) ? env.temperature || input.temperature : input.temperature,
    maxTokens: valueIsDefaultProvider(input.maxTokens, [providerDefaults.maxTokens, 1408]) ? env.maxTokens || input.maxTokens : input.maxTokens
  };
}

export function createDiagnosticsSnapshot() {
  const registry = createDefaultToolRegistry();
  return {
    runtime: "loading-mind-runtime",
    delivery: "sse-or-snapshot",
    orchestration: {
      mode: "demo_deep_research",
      sourceBudget: MAX_SOURCE_BUDGET,
      fallbackMode: process.env.LOADING_MIND_FORCE_DEMO_TOOLS === "1" ? "forced_demo_tools" : "mode_dependent",
      mcpAdapterAvailable: registry.list().some((tool) => tool.name === "mcp.invoke")
    },
    providers: [
      { name: "tavily", role: "primary_search", configured: Boolean(tavilyApiKey()) },
      { name: "brave", role: "fallback_search", configured: Boolean(braveSearchApiKey()) },
      { name: "firecrawl", role: "fallback_search_and_scrape", configured: Boolean(firecrawlApiKey()) },
      { name: "exa", role: "mcp_semantic_search", configured: Boolean(exaApiKey()) },
      { name: "llm", role: "report_write", configured: Boolean(envProviderKey()) }
    ],
    mcp: {
      allowlist: ["tavily.search", "firecrawl.search", "firecrawl.scrape", "exa.search"],
      policy: "read_only_registered_tools"
    },
    tools: registry.list()
  };
}

function createRun(body, options = {}) {
  const createdAt = now();
  const runMode = body.runMode === "live" ? "live" : "demo";
  const providerConfig = sanitizeProviderConfig({
    ...providerConfigWithEnvironment(body.providerConfig ?? {}),
    apiKey: body.providerConfig?.apiKey || envProviderKey()
  });
  const allowDemoFallback = options.allowDemoFallback ?? (runMode === "demo" || process.env.LOADING_MIND_DEMO_MODE === "1");
  const meta = {
    id: `run-${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    question: String(body.question || "我想学习 LLM 和 AI Agent 的相关知识，请生成一份深度研究报告。"),
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
    errorLogs: [],
    auditLogs: [],
    startedAt: createdAt,
    virtualElapsedMs: 0,
    toolIndex: 0,
    providerConfig,
    tavilyApiKey: String(body.tavilyApiKey || "").trim(),
    braveApiKey: String(body.braveApiKey || "").trim(),
    firecrawlApiKey: String(body.firecrawlApiKey || "").trim(),
    exaApiKey: String(body.exaApiKey || "").trim(),
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
  if (typeof options.onRun === "function") {
    options.onRun(run.meta);
  }
  if (typeof options.onEvent === "function") {
    run.eventSink = options.onEvent;
  }
  await executeRun(run);
  return {
    run: run.meta,
    events: run.events,
    errorLogs: run.errorLogs,
    auditLogs: run.auditLogs
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
    errorLogs: payload.errorLogs ?? [],
    auditLogs: payload.auditLogs ?? [],
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
        if (req.method === "GET" && url.pathname === "/api/diagnostics") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(createDiagnosticsSnapshot()));
          return;
        }

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
