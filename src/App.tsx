import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Home, Loader2, Pause, Play, RotateCcw, Send, Square } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { defaultRunRequest } from "./agentProtocol";
import { getPhaseIndex, phases } from "./demoData";
import { ForceNebulaGraph } from "./ForceNebulaGraph";
import { computeSceneInsets } from "./graphPhysics";
import { MindstreamCanvas } from "./MindstreamCanvas";
import { ReportDrawer } from "./ReportDrawer";
import { exportReport, type ReportExportFormat } from "./reportExport";
import { useMindstream } from "./useMindstream";
import type { GraphSceneSnapshot, LoadingPhase, ThinkingCheckpoint } from "./types";

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

function LiveBriefPanel({
  checkpoints,
  status,
  sourceLabelMap,
  onFocusSource
}: {
  checkpoints: ThinkingCheckpoint[];
  status: string;
  sourceLabelMap: Record<string, string>;
  onFocusSource: (nodeId: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const latest = checkpoints[checkpoints.length - 1];
  if (!latest) {
    return null;
  }
  const visibleCheckpoints = expanded ? [...checkpoints].reverse() : [latest];
  return (
    <section className={`live-brief-panel ${status === "completed" ? "replay" : ""}`} aria-label={status === "completed" ? "Replay Process" : "Live Brief"}>
      <header>
        <span>{status === "completed" ? "REPLAY PROCESS" : "LIVE BRIEF"}</span>
        <button type="button" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? "Collapse checkpoints" : "Expand checkpoints"}>
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          {checkpoints.length}
        </button>
      </header>
      <div className="live-brief-list">
        {visibleCheckpoints.map((checkpoint) => {
          const focusId = checkpoint.sourceNodeIds[0] ?? null;
          return (
            <article className="live-brief-card" key={checkpoint.id}>
              <button type="button" onClick={() => onFocusSource(focusId)} disabled={!focusId}>
                <small>{checkpoint.phase}</small>
                <strong>{checkpoint.title}</strong>
              </button>
              <p>{checkpoint.summary}</p>
              <div className="live-brief-grid">
                <div>
                  <span>Known</span>
                  {checkpoint.knownFacts.slice(0, 3).map((fact) => <em key={`${checkpoint.id}-${fact}`}>{fact}</em>)}
                </div>
                <div>
                  <span>Open</span>
                  {checkpoint.openQuestions.slice(0, 2).map((question) => <em key={`${checkpoint.id}-${question}`}>{question}</em>)}
                </div>
              </div>
              <footer>
                <CheckCircle2 size={14} />
                <span>{checkpoint.nextAction}</span>
              </footer>
              {checkpoint.sourceNodeIds.length > 0 && (
                <div className="live-brief-sources">
                  {checkpoint.sourceNodeIds.slice(0, 4).map((nodeId) => (
                    <button key={`${checkpoint.id}-${nodeId}`} type="button" onClick={() => onFocusSource(nodeId)}>
                      {sourceLabelMap[nodeId] ?? nodeId}
                    </button>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function App() {
  const { state, submitTask, pause, resume, cancel, reset, retryTool, excludeEvidence } = useMindstream();
  const [scene, setScene] = useState<GraphSceneSnapshot>(emptyScene);
  const [viewport, setViewport] = useState({ width: 1440, height: 900 });
  const [reportFocusNodeId, setReportFocusNodeId] = useState<string | null>(null);
  const [taskDraft, setTaskDraft] = useState(defaultRunRequest().question);
  const [submitLocked, setSubmitLocked] = useState(false);
  const currentPhaseIndex = getPhaseIndex(state.phase);
  const progress = state.status === "completed" ? 100 : Math.min(98, Math.round((state.elapsed / 30000) * 100));
  const latestEvent = state.events[state.events.length - 1];
  const latestErrorLog = state.errorLogs[state.errorLogs.length - 1];
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
    : state.status === "queued"
      ? "正在连接运行时、创建 run，并加载服务端搜索与模型配置。"
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
    if (state.status === "idle" || state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
      setSubmitLocked(false);
    }
  }, [state.status]);

  const handleReplay = useCallback(() => {
    setReportFocusNodeId(null);
    submitTask({
      question: state.run?.question ?? (taskDraft.trim() || defaultRunRequest().question),
      scope: state.run?.scope ?? defaultRunRequest().scope,
      depth: state.run?.depth ?? "standard",
      sources: state.run?.sources ?? ["web_search", "web_fetch", "document_read"],
      runMode: "live",
      providerConfig: defaultRunRequest().providerConfig
    });
  }, [state.run, submitTask, taskDraft]);

  const handleReset = useCallback(() => {
    setReportFocusNodeId(null);
    setSubmitLocked(false);
    reset();
  }, [reset]);

  const buildRequest = useCallback((question: string) => ({
    question: question.trim() || defaultRunRequest().question,
    scope: defaultRunRequest().scope,
    depth: "standard" as const,
    sources: ["web_search", "web_fetch", "document_read"],
    runMode: "live" as const,
    providerConfig: defaultRunRequest().providerConfig
  }), []);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.status !== "idle" || submitLocked) {
      return;
    }
    setSubmitLocked(true);
    setReportFocusNodeId(null);
    submitTask(buildRequest(taskDraft));
  }, [buildRequest, state.status, submitLocked, submitTask, taskDraft]);

  const exportRun = useCallback((format: ReportExportFormat) => {
    if (!state.run || !state.finalReport) {
      return;
    }
    exportReport(state, sourceLabelMap, format);
  }, [sourceLabelMap, state]);

  const isRunning = state.status === "running" || state.status === "queued";
  const isStarting = state.status === "queued" || submitLocked;
  const canRetryLatestError = Boolean(latestErrorLog?.retryable && latestErrorLog.toolCallId);

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
        {state.status === "failed" && latestErrorLog && (
          <motion.div
            className="run-diagnostics"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            aria-label="Run diagnostics"
          >
            <AlertTriangle size={16} />
            <strong>{latestErrorLog.errorType}</strong>
            <span>{latestErrorLog.toolName || "runtime"} · {latestErrorLog.phase}</span>
            <p>{latestErrorLog.nextAction}</p>
            {canRetryLatestError && (
              <button type="button" onClick={() => void retryTool(latestErrorLog.toolCallId)}>
                Retry failed tool
              </button>
            )}
          </motion.div>
        )}
      </section>

      <AnimatePresence>
        {(state.status === "idle" || state.status === "queued") && (
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
              <textarea value={taskDraft} onChange={(event) => setTaskDraft(event.target.value)} rows={4} disabled={isStarting} />
            </label>
            <div className="composer-actions">
              <button type="submit" disabled={isStarting}>
                {isStarting ? <Loader2 className="spin-icon" size={16} /> : <Send size={16} />}
                {isStarting ? "Starting live process..." : "Start live process"}
              </button>
            </div>
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
          <button
            className="icon-button"
            type="button"
            onClick={handleReset}
            disabled={state.status === "idle"}
            aria-label="Back to start"
            title="Back to start"
          >
            <Home size={17} />
          </button>
        </div>
      </section>

      <LiveBriefPanel
        checkpoints={state.checkpoints}
        status={state.status}
        sourceLabelMap={sourceLabelMap}
        onFocusSource={setReportFocusNodeId}
      />

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
        artifact={(state.status === "completed" || state.status === "failed") ? finalArtifact : null}
        focusNodeId={reportFocusNodeId}
        onExport={exportRun}
        onFocusSource={setReportFocusNodeId}
        onReplay={handleReplay}
        sourceLabelMap={sourceLabelMap}
      />
    </main>
  );
}
