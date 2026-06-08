export type LoadingPhase =
  | "initializing"
  | "ontology"
  | "graph_build"
  | "evidence"
  | "reasoning"
  | "drafting"
  | "final_reveal"
  | "completed";

export type VisualIntensity = "quiet" | "focused" | "dense" | "resolved";

export type ArtifactKind = "plan" | "signal" | "insight" | "draft" | "final";

export type VisualMode = "cinematic" | "system";

export type GraphCluster = "intent" | "ontology" | "evidence" | "reasoning" | "report";

export type GraphNodeKind =
  | "task_intent"
  | "ontology"
  | "entity"
  | "evidence"
  | "tool_call"
  | "observation"
  | "claim"
  | "section";

export type GraphEdgeKind =
  | "extracts"
  | "supports"
  | "observes"
  | "uses_tool"
  | "synthesizes"
  | "becomes_section";

export type GraphNodeTier = "core" | "schema" | "record" | "operation" | "output";

export type GraphNodeEpisode = {
  id: string;
  time: string;
  title: string;
  detail: string;
};

export type ToolStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";
export type RunStatus = "idle" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type ProviderProtocol = "openai" | "anthropic";

export type ProviderConfig = {
  protocol: ProviderProtocol;
  baseUrl: string;
  anthropicBaseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
};

export type ProviderPublicSummary = Omit<ProviderConfig, "apiKey"> & {
  apiKeyMasked: string;
};

export type ToolCallRecord = {
  id: string;
  toolName: "web_search" | "web_fetch" | "document_read" | "evidence_extract" | "llm_analyze" | "report_write";
  input: Record<string, string | number | boolean>;
  outputSummary?: string;
  startedAt: number;
  endedAt?: number;
  status: ToolStatus;
  costMs?: number;
  error?: string;
};

export type EvidenceRecord = {
  id: string;
  title: string;
  url?: string;
  quote: string;
  source: string;
  confidence: number;
  capturedAt: number;
  excluded?: boolean;
};

export type GraphNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  shortBody?: string;
  summary?: string;
  attributes?: Record<string, string>;
  episodes?: GraphNodeEpisode[];
  sourceRefs?: string[];
  status?: "queued" | "running" | "observed" | "synthesized" | "written" | "failed" | "excluded";
  toolCall?: ToolCallRecord;
  evidence?: EvidenceRecord;
  x?: number;
  y?: number;
  cluster?: GraphCluster;
  parentId?: string;
  salience?: number;
  confidence?: number;
  evidenceIds?: string[];
  tier?: GraphNodeTier;
  importance?: number;
  reportAnchorId?: string;
  layout?: {
    x?: number;
    y?: number;
    vx?: number;
    vy?: number;
    fx?: number | null;
    fy?: number | null;
    radius?: number;
    mass?: number;
    pinned?: boolean;
  };
  visual?: {
    status?: "emerging" | "active" | "settled" | "dimmed" | "selected";
    glow?: number;
    labelLevel?: "hidden" | "short" | "full";
  };
};

export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  source?: string;
  target?: string;
  kind: GraphEdgeKind;
  label?: string;
  strength?: number;
  distance?: number;
  confidence?: number;
  evidenceIds?: string[];
  semanticPriority?: number;
  displayMode?: "visible" | "hidden" | "active";
  status?: "emerging" | "active" | "dimmed" | "selected";
};

export type SceneInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type GraphSceneNode = {
  id: string;
  kind: GraphNodeKind;
  tier: GraphNodeTier;
  cluster?: GraphCluster;
  x: number;
  y: number;
  radius: number;
  active: boolean;
  reportMapped: boolean;
};

export type GraphSceneEdge = {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  active: boolean;
  relationCount: number;
  relationKinds: GraphEdgeKind[];
};

export type GraphSceneCluster = {
  id: GraphCluster;
  x: number;
  y: number;
  radius: number;
  active: boolean;
};

export type GraphSceneSnapshot = {
  viewport: {
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
  };
  nodes: GraphSceneNode[];
  edges: GraphSceneEdge[];
  clusters: GraphSceneCluster[];
  focusNodeId: string | null;
  selectedNodeId: string | null;
  activePathIds: string[];
};

export type GraphEvent =
  | { type: "node_added"; node: GraphNode }
  | { type: "node_updated"; node: GraphNode }
  | { type: "edge_added"; edge: GraphEdge }
  | { type: "cluster_formed"; cluster: GraphCluster }
  | { type: "node_emphasized"; nodeId: string };

export type ReportSection = {
  id: string;
  title: string;
  body: string;
  sourceNodeIds: string[];
};

export type Artifact = {
  id: string;
  kind: ArtifactKind;
  title: string;
  body: string;
  sections?: ReportSection[];
};

export type LoadingEvent = {
  id: string;
  phase: LoadingPhase;
  timestamp: number;
  message: string;
  graphEvent?: GraphEvent;
  finalReport?: Artifact;
};

export type AgentEventType =
  | "run_started"
  | "ontology_created"
  | "node_added"
  | "node_updated"
  | "edge_added"
  | "cluster_formed"
  | "tool_call_started"
  | "tool_call_finished"
  | "observation_added"
  | "claim_created"
  | "section_written"
  | "run_paused"
  | "run_resumed"
  | "run_cancelled"
  | "run_completed"
  | "run_failed";

export type AgentRun = {
  id: string;
  question: string;
  scope: string;
  depth: "fast" | "standard" | "deep";
  sources: string[];
  provider?: ProviderPublicSummary;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
};

export type AgentEvent = {
  id: string;
  runId: string;
  type: AgentEventType;
  phase: LoadingPhase;
  elapsedMs: number;
  message: string;
  graphEvent?: GraphEvent;
  toolCall?: ToolCallRecord;
  evidence?: EvidenceRecord;
  finalReport?: Artifact;
  error?: string;
};

export type TaskStatus = RunStatus;

export type MindstreamState = {
  status: TaskStatus;
  run: AgentRun | null;
  phase: LoadingPhase;
  elapsed: number;
  events: LoadingEvent[];
  agentEvents: AgentEvent[];
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  formedClusters: GraphCluster[];
  emphasizedNodeId: string | null;
  finalReport: Artifact | null;
  excludedEvidenceIds: string[];
  error: string | null;
};
