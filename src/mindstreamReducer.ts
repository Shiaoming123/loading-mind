import { agentEventToLoadingEvent } from "./agentProtocol";
import type { CreateRunRequest } from "./agentProtocol";
import type { AgentEvent, AgentRun, GraphEdge, GraphEvent, GraphNode, LoadingEvent, MindstreamState, ThinkingCheckpoint } from "./types";

export const initialState: MindstreamState = {
  status: "idle",
  run: null,
  phase: "initializing",
  elapsed: 0,
  events: [],
  agentEvents: [],
  checkpoints: [],
  graphNodes: [],
  graphEdges: [],
  formedClusters: [],
  emphasizedNodeId: null,
  finalReport: null,
  errorLogs: [],
  excludedEvidenceIds: [],
  error: null
};

export type MindstreamAction =
  | { type: "BEGIN_SUBMIT"; request?: CreateRunRequest }
  | { type: "START"; run: AgentRun }
  | { type: "RESET" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "REPLAY" }
  | { type: "CANCEL" }
  | { type: "FAIL"; error: string }
  | { type: "TICK"; elapsed: number }
  | { type: "APPLY_EVENT"; event: LoadingEvent }
  | { type: "APPLY_AGENT_EVENT"; event: AgentEvent }
  | { type: "EXCLUDE_EVIDENCE"; evidenceId: string };

function upsertNode(nodes: GraphNode[], nextNode: GraphNode) {
  const index = nodes.findIndex((node) => node.id === nextNode.id);
  if (index === -1) {
    return [...nodes, nextNode];
  }

  return nodes.map((node, nodeIndex) => (nodeIndex === index ? { ...node, ...nextNode } : node));
}

function optimisticSubmitGraph(request?: CreateRunRequest): Pick<MindstreamState, "graphNodes" | "graphEdges" | "formedClusters"> {
  const question = request?.question?.trim() || "正在建立研究任务";
  const scope = request?.scope?.trim() || "等待 runtime 返回真实执行事件";
  const graphNodes: GraphNode[] = [
    {
      id: "task-intent",
      kind: "task_intent",
      label: "深度研究任务",
      shortBody: scope,
      summary: question,
      status: "running",
      cluster: "intent",
      salience: 1,
      confidence: 0.72,
      attributes: {
        question,
        scope,
        depth: request?.depth ?? "standard",
        runMode: request?.runMode ?? "live"
      },
      episodes: [{
        id: "optimistic-task-intent",
        time: "00:00",
        title: "任务已提交",
        detail: "前端已建立可视化 seed，正在等待 runtime 创建 run 并返回真实事件。"
      }],
      executionStep: {
        stepId: "plan",
        stepIndex: 1,
        stepLabel: "Plan",
        stepStatus: "queued"
      }
    },
    {
      id: "ontology-runtime",
      kind: "ontology",
      label: "深研过程本体",
      shortBody: "预建立任务、计划、工具、证据和报告章节的语义骨架。",
      summary: "该节点说明本次运行会把 Agent 的计划、检索、读取、证据抽取、验证和报告写作映射为可检查的图谱节点。",
      status: "queued",
      cluster: "ontology",
      parentId: "task-intent",
      salience: 0.78,
      confidence: 0.68,
      attributes: {
        nodeTypes: "research_plan, search_query, source, evidence, claim, section",
        state: "optimistic"
      }
    },
    {
      id: "research-plan",
      kind: "research_plan",
      label: "研究计划",
      shortBody: "等待 ResearchPlanner 生成问题树、检索分支和验证维度。",
      summary: `即将把“${question}”拆成检索分支、来源读取、证据抽取、质量检查和报告写作步骤。`,
      status: "queued",
      cluster: "plan",
      parentId: "ontology-runtime",
      salience: 0.86,
      confidence: 0.66,
      attributes: {
        state: "queued",
        next: "等待服务端计划事件"
      },
      executionStep: {
        stepId: "plan",
        stepIndex: 1,
        stepLabel: "Plan",
        stepStatus: "queued"
      }
    }
  ];
  const graphEdges: GraphEdge[] = [
    {
      id: "edge-task-ontology",
      from: "task-intent",
      to: "ontology-runtime",
      kind: "extracts",
      label: "extracts ontology",
      confidence: 0.7,
      distance: 104,
      strength: 0.72
    },
    {
      id: "edge-ontology-plan",
      from: "ontology-runtime",
      to: "research-plan",
      kind: "extracts",
      label: "extracts plan",
      confidence: 0.68,
      distance: 116,
      strength: 0.72
    }
  ];

  return {
    graphNodes,
    graphEdges,
    formedClusters: ["intent", "ontology", "plan"]
  };
}

function applyGraphEvent(state: MindstreamState, graphEvent: GraphEvent | undefined) {
  if (!graphEvent) {
    return {
      graphNodes: state.graphNodes,
      graphEdges: state.graphEdges,
      formedClusters: state.formedClusters,
      emphasizedNodeId: state.emphasizedNodeId
    };
  }

  if (graphEvent.type === "node_added" || graphEvent.type === "node_updated") {
    return {
      graphNodes: upsertNode(state.graphNodes, graphEvent.node),
      graphEdges: state.graphEdges,
      formedClusters: state.formedClusters,
      emphasizedNodeId: state.emphasizedNodeId
    };
  }

  if (graphEvent.type === "edge_added") {
    return {
      graphNodes: state.graphNodes,
      graphEdges: state.graphEdges.some((edge) => edge.id === graphEvent.edge.id)
        ? state.graphEdges
        : [...state.graphEdges, graphEvent.edge],
      formedClusters: state.formedClusters,
      emphasizedNodeId: state.emphasizedNodeId
    };
  }

  if (graphEvent.type === "cluster_formed") {
    return {
      graphNodes: state.graphNodes,
      graphEdges: state.graphEdges,
      formedClusters: state.formedClusters.includes(graphEvent.cluster)
        ? state.formedClusters
        : [...state.formedClusters, graphEvent.cluster],
      emphasizedNodeId: state.emphasizedNodeId
    };
  }

  return {
    graphNodes: state.graphNodes,
    graphEdges: state.graphEdges,
    formedClusters: state.formedClusters,
    emphasizedNodeId: graphEvent.nodeId
  };
}

function appendCheckpoint(checkpoints: ThinkingCheckpoint[], checkpoint: ThinkingCheckpoint | undefined) {
  if (!checkpoint || checkpoints.some((item) => item.id === checkpoint.id)) {
    return checkpoints;
  }
  return [...checkpoints, checkpoint];
}

function statusFromAgentEvent(state: MindstreamState, event: AgentEvent): MindstreamState["status"] {
  if (event.type === "run_completed") {
    return "completed";
  }
  if (event.type === "run_failed") {
    return "failed";
  }
  if (event.type === "run_cancelled") {
    return "cancelled";
  }
  if (event.type === "run_paused") {
    return "paused";
  }
  if (event.type === "run_resumed") {
    return "running";
  }
  return state.status === "queued" ? "running" : state.status;
}

export function mindstreamReducer(
  state: MindstreamState,
  action: MindstreamAction
): MindstreamState {
  switch (action.type) {
    case "RESET":
      return initialState;
    case "BEGIN_SUBMIT": {
      const optimisticGraph = optimisticSubmitGraph(action.request);
      return {
        ...initialState,
        status: "queued",
        phase: "initializing",
        ...optimisticGraph
      };
    }
    case "START":
      return {
        ...initialState,
        status: action.run.status,
        run: action.run,
        graphNodes: state.status === "queued" ? state.graphNodes : [],
        graphEdges: state.status === "queued" ? state.graphEdges : [],
        formedClusters: state.status === "queued" ? state.formedClusters : []
      };
    case "REPLAY":
      return {
        ...initialState,
        status: "running"
      };
    case "PAUSE":
      if (state.status !== "running") {
        return state;
      }
      return {
        ...state,
        status: "paused"
      };
    case "RESUME":
      if (state.status !== "paused") {
        return state;
      }
      return {
        ...state,
        status: "running"
      };
    case "CANCEL":
      return {
        ...state,
        status: "cancelled"
      };
    case "FAIL":
      return {
        ...state,
        status: "failed",
        error: action.error
      };
    case "TICK":
      return {
        ...state,
        elapsed: action.elapsed
      };
    case "APPLY_EVENT": {
      if (state.events.some((event) => event.id === action.event.id)) {
        return state;
      }

      const graphState = applyGraphEvent(state, action.event.graphEvent);
      const isCompleted = action.event.phase === "completed";

      return {
        ...state,
        status: isCompleted ? "completed" : state.status,
        phase: action.event.phase,
        elapsed: Math.max(state.elapsed, action.event.timestamp),
        events: [...state.events, action.event],
        checkpoints: appendCheckpoint(state.checkpoints, action.event.checkpoint),
        graphNodes: graphState.graphNodes,
        graphEdges: graphState.graphEdges,
        formedClusters: graphState.formedClusters,
        emphasizedNodeId: graphState.emphasizedNodeId,
        finalReport: action.event.finalReport ?? state.finalReport
      };
    }
    case "APPLY_AGENT_EVENT": {
      if (state.agentEvents.some((event) => event.id === action.event.id)) {
        return state;
      }

      const loadingEvent = agentEventToLoadingEvent(action.event);
      const graphState = applyGraphEvent(state, action.event.graphEvent);

      return {
        ...state,
        status: statusFromAgentEvent(state, action.event),
        phase: action.event.phase,
        elapsed: Math.max(state.elapsed, action.event.elapsedMs),
        events: state.events.some((event) => event.id === loadingEvent.id)
          ? state.events
          : [...state.events, loadingEvent],
        agentEvents: [...state.agentEvents, action.event],
        checkpoints: appendCheckpoint(state.checkpoints, action.event.checkpoint),
        graphNodes: graphState.graphNodes,
        graphEdges: graphState.graphEdges,
        formedClusters: graphState.formedClusters,
        emphasizedNodeId: graphState.emphasizedNodeId,
        finalReport: action.event.finalReport ?? state.finalReport,
        errorLogs: action.event.errorLog && !state.errorLogs.some((log) => log.createdAt === action.event.errorLog?.createdAt)
          ? [...state.errorLogs, action.event.errorLog]
          : state.errorLogs,
        error: action.event.type === "run_failed" ? action.event.error ?? action.event.message : state.error
      };
    }
    case "EXCLUDE_EVIDENCE":
      if (state.excludedEvidenceIds.includes(action.evidenceId)) {
        return state;
      }
      return {
        ...state,
        excludedEvidenceIds: [...state.excludedEvidenceIds, action.evidenceId],
        graphNodes: state.graphNodes.map((node) =>
          node.id === action.evidenceId || node.evidence?.id === action.evidenceId
            ? { ...node, status: "excluded", evidence: node.evidence ? { ...node.evidence, excluded: true } : node.evidence }
            : node
        )
      };
    default:
      return state;
  }
}
