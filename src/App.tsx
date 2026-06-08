import { AnimatePresence, motion } from "framer-motion";
import { Download, FlaskConical, Pause, Play, RotateCcw, Send, Sparkles, Square } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { defaultRunRequest } from "./agentProtocol";
import { getPhaseIndex, phases } from "./demoData";
import { ForceNebulaGraph } from "./ForceNebulaGraph";
import { computeSceneInsets } from "./graphPhysics";
import { MindstreamCanvas } from "./MindstreamCanvas";
import { useMindstream } from "./useMindstream";
import type { ArtifactBlock, GraphSceneSnapshot, LoadingPhase, ProviderConfig, ProviderProtocol, VisualMode } from "./types";

const phaseCopy: Record<LoadingPhase, string> = {
  initializing: "任务 seed 正在建立",
  ontology: "Ontology 正在生成",
  graph_build: "实体关系正在生长",
  evidence: "证据 episode 正在聚合",
  reasoning: "ReACT 推理正在形成判断",
  drafting: "报告章节正在写入",
  final_reveal: "图谱正在收束为报告",
  completed: "报告已完成"
};

function formatTime(ms: number) {
  return `${Math.min(30, Math.floor(ms / 1000)).toString().padStart(2, "0")}s`;
}

const emptyScene: GraphSceneSnapshot = {
  viewport: {
    width: 1,
    height: 1,
    offsetX: 0,
    offsetY: 0
  },
  nodes: [],
  edges: [],
  clusters: [],
  focusNodeId: null,
  selectedNodeId: null,
  activePathIds: []
};

const calibrationTopics = [
  "AI Agent 长链路任务中，如何判断用户需要过程可视化还是只需要最终答案？",
  "企业知识库问答系统上线前，应该如何设计评估指标、失败回退和人工复核流程？",
  "一个面向产品团队的数据分析 Agent，如何把工具调用、证据来源和结论置信度展示给非技术用户？"
];

function maskedProvider(provider: ProviderConfig) {
  const key = provider.apiKey.trim();
  return key ? `${key.slice(0, 6)}...${key.slice(-3)}` : "API key required";
}

function sourceLabel(sourceNodeIds: string[] = []) {
  return sourceNodeIds.slice(0, 5).join(" / ");
}

function ReportBlock({
  block,
  onFocusSource
}: {
  block: ArtifactBlock;
  onFocusSource: (nodeId: string | null) => void;
}) {
  const firstSource = block.sourceNodeIds?.[0] ?? null;
  return (
    <section className={`report-block block-${block.type}`}>
      <button
        className="report-block-focus"
        type="button"
        onClick={() => onFocusSource(firstSource)}
        disabled={!firstSource}
      >
        {block.title ?? "Report block"}
      </button>
      {block.type === "markdown" && <p>{block.body}</p>}
      {(block.type === "table" || block.type === "source_matrix") && (
        <div className="report-table-wrap">
          <table>
            <thead>
              <tr>
                {block.columns.map((column) => <th key={column}>{column}</th>)}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={`${block.id}-${index}`}>
                  {block.columns.map((column) => <td key={column}>{String(row[column] ?? "")}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {block.type === "mermaid" && <pre className="mermaid-block">{block.code}</pre>}
      {block.type === "claim_graph" && (
        <div className="claim-graph-block">
          <div>
            <strong>{block.nodes.length}</strong>
            <span>nodes</span>
          </div>
          <div>
            <strong>{block.edges.length}</strong>
            <span>edges</span>
          </div>
          <p>{block.nodes.slice(0, 5).map((node) => node.label).join(" / ")}</p>
        </div>
      )}
      {block.sourceNodeIds && block.sourceNodeIds.length > 0 && <em>{sourceLabel(block.sourceNodeIds)}</em>}
    </section>
  );
}

export function App() {
  const { state, submitTask, pause, resume, cancel, retryTool, excludeEvidence } = useMindstream();
  const [particlesEnabled, setParticlesEnabled] = useState(false);
  const [visualMode, setVisualMode] = useState<VisualMode>("cinematic");
  const [scene, setScene] = useState<GraphSceneSnapshot>(emptyScene);
  const [viewport, setViewport] = useState({ width: 1440, height: 900 });
  const [reportFocusNodeId, setReportFocusNodeId] = useState<string | null>(null);
  const [taskDraft, setTaskDraft] = useState(defaultRunRequest().question);
  const [scopeDraft, setScopeDraft] = useState(defaultRunRequest().scope);
  const [providerConfig, setProviderConfig] = useState<ProviderConfig>(defaultRunRequest().providerConfig);
  const [calibrationQueue, setCalibrationQueue] = useState<string[]>([]);
  const [calibrationIndex, setCalibrationIndex] = useState<number | null>(null);
  const currentPhaseIndex = getPhaseIndex(state.phase);
  const progress = state.status === "completed" ? 100 : Math.min(98, Math.round((state.elapsed / 30000) * 100));
  const latestEvent = state.events[state.events.length - 1];
  const finalArtifact = state.finalReport;
  const sceneInsets = useMemo(() => computeSceneInsets(viewport), [viewport]);
  const centerHeadline = state.status === "failed" ? "运行失败，需要处理工具错误" : phaseCopy[state.phase];
  const centerEventLine = state.status === "failed" && state.error
    ? state.error
    : latestEvent?.message ?? "提交一个调研问题，Agent 将真实调用工具，并把检索、读取、证据、判断和报告写作过程实时映射到图谱。";
  const handleSceneUpdate = useCallback((nextScene: GraphSceneSnapshot) => {
    setScene(nextScene);
  }, []);

  useEffect(() => {
    const syncViewport = () => {
      setViewport({
        width: window.innerWidth,
        height: window.innerHeight
      });
    };

    syncViewport();
    window.addEventListener("resize", syncViewport);
    return () => window.removeEventListener("resize", syncViewport);
  }, []);

  useEffect(() => {
    if (state.status !== "completed") {
      setReportFocusNodeId(null);
    }
  }, [state.status]);

  const handleReplay = useCallback(() => {
    setReportFocusNodeId(null);
    submitTask({
      question: state.run?.question ?? (taskDraft.trim() || defaultRunRequest().question),
      scope: state.run?.scope ?? (scopeDraft.trim() || defaultRunRequest().scope),
      depth: state.run?.depth ?? "standard",
      sources: state.run?.sources ?? ["web_search", "web_fetch", "document_read"],
      providerConfig
    });
  }, [providerConfig, scopeDraft, state.run, submitTask, taskDraft]);

  const updateProvider = useCallback(<Key extends keyof ProviderConfig>(key: Key, value: ProviderConfig[Key]) => {
    setProviderConfig((current) => ({ ...current, [key]: value }));
  }, []);

  const buildRequest = useCallback((question: string, scope: string = scopeDraft.trim() || defaultRunRequest().scope) => ({
    question: question.trim() || defaultRunRequest().question,
    scope,
    depth: "standard" as const,
    sources: ["web_search", "web_fetch", "document_read"],
    providerConfig
  }), [providerConfig, scopeDraft]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setReportFocusNodeId(null);
    setCalibrationQueue([]);
    setCalibrationIndex(null);
    submitTask(buildRequest(taskDraft, scopeDraft.trim() || defaultRunRequest().scope));
  }, [buildRequest, scopeDraft, submitTask, taskDraft]);

  const handleStartCalibration = useCallback(() => {
    setReportFocusNodeId(null);
    const [firstTopic, ...remainingTopics] = calibrationTopics;
    setCalibrationQueue(remainingTopics);
    setCalibrationIndex(1);
    setTaskDraft(firstTopic);
    setScopeDraft("完整长跑校准：验证真实 API 调用、工具观察分析、报告生成和导出链路。");
    submitTask(buildRequest(firstTopic, "完整长跑校准：验证真实 API 调用、工具观察分析、报告生成和导出链路。"));
  }, [buildRequest, submitTask]);

  useEffect(() => {
    if (state.status !== "completed" || calibrationQueue.length === 0 || calibrationIndex === null) {
      return;
    }
    const [nextTopic, ...remainingTopics] = calibrationQueue;
    const timer = window.setTimeout(() => {
      setReportFocusNodeId(null);
      setCalibrationQueue(remainingTopics);
      setCalibrationIndex((index) => index === null ? null : index + 1);
      setTaskDraft(nextTopic);
      submitTask(buildRequest(nextTopic, "完整长跑校准：验证真实 API 调用、工具观察分析、报告生成和导出链路。"));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [buildRequest, calibrationIndex, calibrationQueue, state.status, submitTask]);

  useEffect(() => {
    if (state.status === "failed" || state.status === "cancelled") {
      setCalibrationQueue([]);
      setCalibrationIndex(null);
    }
  }, [state.status]);

  const exportRun = useCallback((format: "markdown" | "json") => {
    if (!state.run) {
      return;
    }
    window.open(`/api/runs/${state.run.id}/export?format=${format}`, "_blank", "noopener,noreferrer");
  }, [state.run]);

  const isRunning = state.status === "running" || state.status === "queued";

  return (
    <main className={`app-shell mode-${visualMode} phase-${state.phase}`}>
      <MindstreamCanvas
        phase={state.phase}
        status={state.status}
        graphStats={{
          nodeCount: state.graphNodes.length,
          edgeCount: state.graphEdges.length,
          clusterCount: state.formedClusters.length
        }}
        particlesEnabled={particlesEnabled}
        visualMode={visualMode}
        scene={scene}
      />
      <div className="grain" />
      <div className="top-bar">
        <motion.div
          className="brand"
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        >
          <span className="brand-mark">LM</span>
          <span>
            <strong>Loading Mind</strong>
            <small>Agent Process OS</small>
          </span>
        </motion.div>
        <motion.div
          className="task-pill"
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        >
          AI Agent 长链路 · 过程可视化
        </motion.div>
      </div>

      <section className="stage-rail" aria-label="Task stages">
        {phases.map((phase, index) => {
          const isActive = phase.id === state.phase;
          const isDone = index < currentPhaseIndex || state.phase === "completed";
          return (
            <motion.div
              className={`stage-node ${isActive ? "active" : ""} ${isDone ? "done" : ""}`}
              key={phase.id}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.08 * index, duration: 0.55 }}
            >
              <span className="stage-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="stage-dot" />
              <span className="stage-text">
                <strong>{phase.label}</strong>
                <small>{phase.caption}</small>
              </span>
            </motion.div>
          );
        })}
      </section>

      <section className="center-readout" aria-live="polite">
        <motion.p
          className="eyebrow"
          key={`eyebrow-${state.phase}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          PROCESS STATE
        </motion.p>
        <motion.h1
          key={state.phase}
          initial={{ opacity: 0, y: 16, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
        >
          {centerHeadline}
        </motion.h1>
        <motion.p
          className="event-line"
          key={latestEvent?.id ?? "empty"}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          {centerEventLine}
        </motion.p>
      </section>

      <AnimatePresence>
        {state.status === "idle" && (
          <motion.form
            className="task-composer"
            onSubmit={handleSubmit}
            initial={{ opacity: 0, y: 28, filter: "blur(14px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: 20, filter: "blur(10px)" }}
            transition={{ duration: 0.48, ease: [0.16, 1, 0.3, 1] }}
          >
            <span>LIVE AGENT RUN</span>
            <label>
              <strong>Research Question</strong>
              <textarea value={taskDraft} onChange={(event) => setTaskDraft(event.target.value)} rows={4} />
            </label>
            <label>
              <strong>Scope</strong>
              <input value={scopeDraft} onChange={(event) => setScopeDraft(event.target.value)} />
            </label>
            <div className="provider-config" aria-label="Provider configuration">
              <div className="provider-config-header">
                <strong>Provider</strong>
                <span>{providerConfig.protocol} · {providerConfig.model} · {maskedProvider(providerConfig)}</span>
              </div>
              <div className="protocol-switch" aria-label="API protocol">
                {(["openai", "anthropic"] as ProviderProtocol[]).map((protocol) => (
                  <button
                    className={providerConfig.protocol === protocol ? "active" : ""}
                    key={protocol}
                    type="button"
                    onClick={() => updateProvider("protocol", protocol)}
                    aria-pressed={providerConfig.protocol === protocol}
                  >
                    {protocol === "openai" ? "OpenAI" : "Anthropic"}
                  </button>
                ))}
              </div>
              <label>
                <strong>OpenAI Base URL</strong>
                <input value={providerConfig.baseUrl} onChange={(event) => updateProvider("baseUrl", event.target.value)} />
              </label>
              <label>
                <strong>Anthropic Base URL</strong>
                <input value={providerConfig.anthropicBaseUrl} onChange={(event) => updateProvider("anthropicBaseUrl", event.target.value)} />
              </label>
              <div className="provider-grid">
                <label>
                  <strong>Model</strong>
                  <input value={providerConfig.model} onChange={(event) => updateProvider("model", event.target.value)} />
                </label>
                <label>
                  <strong>Temperature</strong>
                  <input
                    max="1"
                    min="0"
                    step="0.05"
                    type="number"
                    value={providerConfig.temperature}
                    onChange={(event) => updateProvider("temperature", Number(event.target.value))}
                  />
                </label>
                <label>
                  <strong>Max Tokens</strong>
                  <input
                    min="256"
                    step="128"
                    type="number"
                    value={providerConfig.maxTokens}
                    onChange={(event) => updateProvider("maxTokens", Number(event.target.value))}
                  />
                </label>
              </div>
              <label>
                <strong>API Key</strong>
                <input
                  autoComplete="off"
                  placeholder="Paste runtime key"
                  type="password"
                  value={providerConfig.apiKey}
                  onChange={(event) => updateProvider("apiKey", event.target.value)}
                />
              </label>
            </div>
            <div className="composer-actions">
              <button type="submit">
                <Send size={16} />
                Start real process
              </button>
              <button className="secondary-action" type="button" onClick={handleStartCalibration}>
                <FlaskConical size={16} />
                Full calibration
              </button>
            </div>
            {calibrationIndex !== null && (
              <p className="calibration-status">Calibration {calibrationIndex} / {calibrationTopics.length}</p>
            )}
          </motion.form>
        )}
      </AnimatePresence>

      <section className="telemetry" aria-label="Runtime controls">
        <div className="meter-row">
          <span>{formatTime(state.elapsed)}</span>
          <span>{state.run ? state.run.id.slice(-7).toUpperCase() : `${progress}%`}</span>
        </div>
        <div className="meter">
          <motion.span animate={{ width: `${progress}%` }} transition={{ duration: 0.3 }} />
        </div>
        <div className="controls">
          <div className="mode-switch" aria-label="Visual mode">
            {(["cinematic", "system"] as VisualMode[]).map((mode) => (
              <button
                className={visualMode === mode ? "active" : ""}
                key={mode}
                type="button"
                onClick={() => setVisualMode(mode)}
                aria-pressed={visualMode === mode}
              >
                {mode === "cinematic" ? "Cinematic" : "System"}
              </button>
            ))}
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={state.status === "paused" ? resume : pause}
            disabled={!isRunning && state.status !== "paused"}
            aria-label={state.status === "paused" ? "Resume" : "Pause"}
            title={state.status === "paused" ? "Resume" : "Pause"}
          >
            {state.status === "paused" ? <Play size={17} /> : <Pause size={17} />}
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={cancel}
            disabled={!isRunning && state.status !== "paused"}
            aria-label="Cancel run"
            title="Cancel run"
          >
            <Square size={15} />
          </button>
          <button className="icon-button" type="button" onClick={handleReplay} aria-label="Replay" title="Replay">
            <RotateCcw size={17} />
          </button>
          <button
            className={`icon-button ${particlesEnabled ? "active" : ""}`}
            type="button"
            onClick={() => setParticlesEnabled((enabled) => !enabled)}
            aria-label={particlesEnabled ? "Disable particles" : "Enable particles"}
            title={particlesEnabled ? "Disable particles" : "Enable particles"}
          >
            <Sparkles size={16} />
          </button>
        </div>
      </section>

      <ForceNebulaGraph
        nodes={state.graphNodes}
        edges={state.graphEdges}
        formedClusters={state.formedClusters}
        emphasizedNodeId={state.emphasizedNodeId}
        status={state.status}
        particlesEnabled={particlesEnabled}
        visualMode={visualMode}
        sceneInsets={sceneInsets}
        reportFocusNodeId={reportFocusNodeId}
        reportSections={finalArtifact?.sections ?? []}
        onSceneUpdate={handleSceneUpdate}
        onRetryTool={retryTool}
        onExcludeEvidence={excludeEvidence}
      />

      <AnimatePresence>
        {state.status === "completed" && finalArtifact && (
          <motion.section
            className="final-panel"
            initial={{ opacity: 0, y: 28, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.75, ease: [0.16, 1, 0.3, 1] }}
          >
            <span>FINAL REPORT</span>
            <h2>{finalArtifact.title}</h2>
            <p>{finalArtifact.body}</p>
            {finalArtifact.sections && (
              <nav className="report-toc" aria-label="Report table of contents">
                {finalArtifact.sections.map((section) => (
                  <button
                    key={`toc-${section.id}`}
                    type="button"
                    onClick={() => setReportFocusNodeId(section.sourceNodeIds[0] ?? null)}
                  >
                    {section.title}
                  </button>
                ))}
              </nav>
            )}
            {finalArtifact.blocks && (
              <article className="report-blocks" aria-label="Structured report blocks">
                {finalArtifact.blocks.map((block) => (
                  <ReportBlock block={block} key={block.id} onFocusSource={setReportFocusNodeId} />
                ))}
              </article>
            )}
            {finalArtifact.sections && (
              <article className="report-article" aria-label="Generated report article">
                {finalArtifact.sections.map((section) => {
                  const nodeId = section.sourceNodeIds[0] ?? null;
                  return (
                    <button
                      className={reportFocusNodeId === nodeId ? "active" : ""}
                      key={section.id}
                      type="button"
                      onClick={() => setReportFocusNodeId(nodeId)}
                    >
                      <strong>{section.title}</strong>
                      <span>{section.body}</span>
                      <em>{section.sourceNodeIds.join(" / ")}</em>
                    </button>
                  );
                })}
              </article>
            )}
            <div className="final-actions">
              <button type="button" onClick={handleReplay}>
                <RotateCcw size={15} />
                Run again
              </button>
              <button type="button" onClick={() => exportRun("markdown")}>
                <Download size={15} />
                Markdown
              </button>
              <button type="button" onClick={() => exportRun("json")}>
                <Download size={15} />
                JSON
              </button>
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </main>
  );
}
