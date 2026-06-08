import { agentEventToLoadingEvent } from "./agentProtocol";
import type { AgentEvent, AgentRun, GraphEvent, GraphNode, LoadingEvent, MindstreamState } from "./types";

export const initialState: MindstreamState = {
  status: "idle",
  run: null,
  phase: "initializing",
  elapsed: 0,
  events: [],
  agentEvents: [],
  graphNodes: [],
  graphEdges: [],
  formedClusters: [],
  emphasizedNodeId: null,
  finalReport: null,
  excludedEvidenceIds: [],
  error: null
};

export type MindstreamAction =
  | { type: "START"; run: AgentRun }
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
    case "START":
      return {
        ...initialState,
        status: action.run.status,
        run: action.run
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
        graphNodes: graphState.graphNodes,
        graphEdges: graphState.graphEdges,
        formedClusters: graphState.formedClusters,
        emphasizedNodeId: graphState.emphasizedNodeId,
        finalReport: action.event.finalReport ?? state.finalReport,
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
