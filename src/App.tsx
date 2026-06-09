import { AnimatePresence, motion } from "framer-motion";
import { FlaskConical, Pause, Play, RotateCcw, Send, Square } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { defaultRunRequest } from "./agentProtocol";
import { getPhaseIndex, phases } from "./demoData";
import { ForceNebulaGraph } from "./ForceNebulaGraph";
import { computeSceneInsets } from "./graphPhysics";
import { MindstreamCanvas } from "./MindstreamCanvas";
import { ReportDrawer } from "./ReportDrawer";
import { useMindstream } from "./useMindstream";
import type { GraphSceneSnapshot, LoadingPhase, ProviderConfig, ProviderProtocol, RunMode } from "./types";

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

const localRuntimeSettingsKey = "loading-mind.runtime-settings";

type LocalRuntimeSettings = {
  tavilyApiKey?: string;
  providerConfig?: Partial<ProviderConfig>;
};

function readLocalRuntimeSettings(): LocalRuntimeSettings {
  try {
    const raw = window.localStorage.getItem(localRuntimeSettingsKey);
    return raw ? JSON.parse(raw) as LocalRuntimeSettings : {};
  } catch {
    return {};
  }
}

function writeLocalRuntimeSettings(settings: LocalRuntimeSettings) {
  try {
    window.localStorage.setItem(localRuntimeSettingsKey, JSON.stringify(settings));
  } catch {
    // Local persistence is a convenience; unavailable storage should not block a run.
  }
}

function savedProviderConfig(fallback: ProviderConfig) {
  const saved = readLocalRuntimeSettings().providerConfig ?? {};
  return {
    ...fallback,
    ...saved
  };
}

export function App() {
  const { state, submitTask, pause, resume, cancel, retryTool, excludeEvidence } = useMindstream();
  const [runMode, setRunMode] = useState<RunMode>(defaultRunRequest().runMode);
  const [scene, setScene] = useState<GraphSceneSnapshot>(emptyScene);
  const [viewport, setViewport] = useState({ width: 1440, height: 900 });
  const [reportFocusNodeId, setReportFocusNodeId] = useState<string | null>(null);
  const [taskDraft, setTaskDraft] = useState(defaultRunRequest().question);
  const [scopeDraft, setScopeDraft] = useState(defaultRunRequest().scope);
  const [tavilyApiKey, setTavilyApiKey] = useState(() => readLocalRuntimeSettings().tavilyApiKey ?? defaultRunRequest().tavilyApiKey ?? "");
  const [providerConfig, setProviderConfig] = useState<ProviderConfig>(() => savedProviderConfig(defaultRunRequest().providerConfig));
  const [calibrationQueue, setCalibrationQueue] = useState<string[]>([]);
  const [calibrationIndex, setCalibrationIndex] = useState<number | null>(null);
  const currentPhaseIndex = getPhaseIndex(state.phase);
  const progress = state.status === "completed" ? 100 : Math.min(98, Math.round((state.elapsed / 30000) * 100));
  const latestEvent = state.events[state.events.length - 1];
  const finalArtifact = state.finalReport;
  const sourceLabelMap = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const node of state.graphNodes) {
      if (node.label.trim()) {
        labels[node.id] = node.label;
      }
    }
    return {
      ...labels,
      ...finalArtifact?.sourceLabelMap
    };
  }, [finalArtifact?.sourceLabelMap, state.graphNodes]);
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
      const visualViewport = window.visualViewport;
      setViewport({
        width: visualViewport?.width ?? window.innerWidth,
        height: visualViewport?.height ?? window.innerHeight
      });
    };

    syncViewport();
    window.addEventListener("resize", syncViewport);
    window.visualViewport?.addEventListener("resize", syncViewport);
    window.visualViewport?.addEventListener("scroll", syncViewport);
    return () => {
      window.removeEventListener("resize", syncViewport);
      window.visualViewport?.removeEventListener("resize", syncViewport);
      window.visualViewport?.removeEventListener("scroll", syncViewport);
    };
  }, []);

  useEffect(() => {
    if (state.status !== "completed") {
      setReportFocusNodeId(null);
    }
  }, [state.status]);

  useEffect(() => {
    writeLocalRuntimeSettings({
      tavilyApiKey,
      providerConfig
    });
  }, [providerConfig, tavilyApiKey]);

  const handleReplay = useCallback(() => {
    setReportFocusNodeId(null);
    submitTask({
      question: state.run?.question ?? (taskDraft.trim() || defaultRunRequest().question),
      scope: state.run?.scope ?? (scopeDraft.trim() || defaultRunRequest().scope),
      depth: state.run?.depth ?? "standard",
      sources: state.run?.sources ?? ["web_search", "web_fetch", "document_read"],
      runMode: state.run?.runMode ?? runMode,
      tavilyApiKey,
      providerConfig
    });
  }, [providerConfig, runMode, scopeDraft, state.run, submitTask, taskDraft, tavilyApiKey]);

  const updateProvider = useCallback(<Key extends keyof ProviderConfig>(key: Key, value: ProviderConfig[Key]) => {
    setProviderConfig((current) => ({ ...current, [key]: value }));
  }, []);

  const buildRequest = useCallback((question: string, scope: string = scopeDraft.trim() || defaultRunRequest().scope) => ({
    question: question.trim() || defaultRunRequest().question,
    scope,
    depth: "standard" as const,
    sources: ["web_search", "web_fetch", "document_read"],
    runMode,
    tavilyApiKey,
    providerConfig
  }), [providerConfig, runMode, scopeDraft, tavilyApiKey]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setReportFocusNodeId(null);
    setCalibrationQueue([]);
    setCalibrationIndex(null);
    submitTask(buildRequest(taskDraft, scopeDraft.trim() || defaultRunRequest().scope));
  }, [buildRequest, scopeDraft, submitTask, taskDraft]);

  const handleStartCalibration = useCallback(() => {
    setReportFocusNodeId(null);
    const [firstTopic] = calibrationTopics;
    setCalibrationQueue([]);
    setCalibrationIndex(1);
    setTaskDraft(firstTopic);
    setScopeDraft("完整长跑校准：验证真实 API 调用、工具观察分析、报告生成和导出链路。");
    submitTask(buildRequest(firstTopic, "完整长跑校准：验证真实 API 调用、工具观察分析、报告生成和导出链路。"));
  }, [buildRequest, submitTask]);

  useEffect(() => {
    if (state.status === "completed") {
      setCalibrationQueue([]);
      setCalibrationIndex(null);
    }
  }, [state.status]);

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
    <main className={`app-shell phase-${state.phase}`}>
      <MindstreamCanvas
        phase={state.phase}
        status={state.status}
        graphStats={{
          nodeCount: state.graphNodes.length,
          edgeCount: state.graphEdges.length,
          clusterCount: state.formedClusters.length
        }}
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
            <span>{runMode === "demo" ? "DEMO AGENT RUN" : "LIVE AGENT RUN"}</span>
            <label>
              <strong>Research Question</strong>
              <textarea value={taskDraft} onChange={(event) => setTaskDraft(event.target.value)} rows={4} />
            </label>
            <label>
              <strong>Scope</strong>
              <input value={scopeDraft} onChange={(event) => setScopeDraft(event.target.value)} />
            </label>
            <div className="provider-config" aria-label="Provider configuration">
              <div className="run-mode-switch" aria-label="Run mode">
                {(["demo", "live"] as RunMode[]).map((mode) => (
                  <button
                    className={runMode === mode ? "active" : ""}
                    key={mode}
                    type="button"
                    onClick={() => setRunMode(mode)}
                    aria-pressed={runMode === mode}
                  >
                    {mode === "demo" ? "Demo" : "Live"}
                  </button>
                ))}
              </div>
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
                <strong>Tavily Search API Key</strong>
                <input
                  autoComplete="off"
                  placeholder="Paste Tavily key"
                  type="password"
                  value={tavilyApiKey}
                  onChange={(event) => setTavilyApiKey(event.target.value)}
                />
              </label>
              <label>
                <strong>LLM API Key</strong>
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
                {runMode === "demo" ? "Start demo process" : "Start live process"}
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
        </div>
      </section>

      <ForceNebulaGraph
        nodes={state.graphNodes}
        edges={state.graphEdges}
        formedClusters={state.formedClusters}
        emphasizedNodeId={state.emphasizedNodeId}
        status={state.status}
        sceneInsets={sceneInsets}
        reportFocusNodeId={reportFocusNodeId}
        reportSections={finalArtifact?.sections ?? []}
        onSceneUpdate={handleSceneUpdate}
        onRetryTool={retryTool}
        onExcludeEvidence={excludeEvidence}
      />

      <ReportDrawer
        artifact={state.status === "completed" ? finalArtifact : null}
        focusNodeId={reportFocusNodeId}
        onExport={exportRun}
        onFocusSource={setReportFocusNodeId}
        onReplay={handleReplay}
        sourceLabelMap={sourceLabelMap}
      />
    </main>
  );
}
