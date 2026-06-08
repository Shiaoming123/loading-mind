import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import type {
  GraphCluster,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
  GraphNodeTier,
  GraphSceneSnapshot,
  SceneInsets
} from "./types";

export type ForceGraphNode = SimulationNodeDatum &
  GraphNode & {
    radius: number;
    mass: number;
    bornAt: number;
    pinned: boolean;
    tier: GraphNodeTier;
    importance: number;
  };

export type ForceGraphEdge = SimulationLinkDatum<ForceGraphNode> &
  Omit<GraphEdge, "source" | "target"> & {
    sourceId: string;
    targetId: string;
    relationIds: string[];
    relationKinds: GraphEdgeKind[];
    relationCount: number;
  };

export type GraphViewport = {
  width: number;
  height: number;
  insets?: SceneInsets;
};

export type EffectiveNodeStatus = "queued" | "running" | "observed" | "succeeded" | "synthesized" | "written" | "failed" | "excluded";

export type NodeRenderToken = {
  status: EffectiveNodeStatus;
  fill: string;
  stroke: string;
  halo: string;
  label: string;
  ringWidth: number;
  haloAlpha: number;
  haloScale: number;
  pulseStrength: number;
  warningRing: boolean;
  forceLabel: boolean;
};

const kindRadius: Record<GraphNodeKind, number> = {
  task_intent: 19,
  ontology: 15,
  research_plan: 15,
  search_query: 12,
  source: 11,
  entity: 12,
  evidence: 12,
  tool_call: 14,
  observation: 12,
  claim: 15,
  counterclaim: 14,
  verification: 14,
  example: 12,
  visualization: 16,
  section: 16
};

const clusterIndex: Record<GraphCluster, number> = {
  intent: 0,
  ontology: 1,
  plan: 2,
  search: 3,
  sources: 4,
  evidence: 5,
  verification: 6,
  synthesis: 7,
  reasoning: 8,
  visualization: 9,
  report: 10
};

const edgePriority: Record<GraphEdgeKind, number> = {
  becomes_section: 6,
  feeds_visual: 6,
  verifies: 6,
  synthesizes: 5,
  supports: 4,
  contradicts: 4,
  illustrates: 4,
  uses_tool: 3,
  extracts_evidence: 3,
  returns_source: 3,
  queries: 2,
  observes: 2,
  extracts: 1
};

type GraphEdgeRelation = Pick<GraphEdge, "id" | "from" | "to" | "kind"> & {
  relationKinds?: GraphEdgeKind[];
};

export function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

export function deriveNodeTier(node: GraphNode): GraphNodeTier {
  if (node.tier) {
    return node.tier;
  }

  if (node.kind === "task_intent") {
    return "core";
  }
  if (node.kind === "ontology" || node.kind === "research_plan") {
    return "schema";
  }
  if (node.kind === "tool_call" || node.kind === "observation" || node.kind === "search_query" || node.kind === "source") {
    return "operation";
  }
  if (node.kind === "claim" || node.kind === "counterclaim" || node.kind === "verification" || node.kind === "visualization" || node.kind === "section") {
    return "output";
  }
  return "record";
}

export function deriveNodeImportance(node: GraphNode) {
  if (typeof node.importance === "number") {
    return node.importance;
  }

  switch (deriveNodeTier(node)) {
    case "core":
      return 1;
    case "output":
      return node.kind === "section" ? 0.9 : 0.82;
    case "schema":
      return 0.76;
    case "operation":
      return 0.7;
    case "record":
    default:
      return node.kind === "evidence" || node.kind === "example" ? 0.66 : 0.58;
  }
}

export function nodeRadius(node: GraphNode) {
  const base = node.layout?.radius ?? kindRadius[node.kind];
  return base + deriveNodeImportance(node) * 4;
}

export function effectiveNodeStatus(node: GraphNode): EffectiveNodeStatus {
  if (node.toolCall?.status === "failed") {
    return "failed";
  }
  if (node.toolCall?.status === "succeeded") {
    return "succeeded";
  }
  if (node.toolCall?.status === "running") {
    return "running";
  }
  return node.status ?? "running";
}

export function nodeRenderToken(node: GraphNode, active = false): NodeRenderToken {
  const status = effectiveNodeStatus(node);
  const tier = deriveNodeTier(node);
  const base =
    tier === "core"
      ? { fill: "#f3a43b", stroke: "rgba(116, 67, 16, 0.78)", halo: "243, 164, 59", label: "#8a4e14" }
      : tier === "output"
        ? { fill: "#d9822b", stroke: "rgba(116, 67, 16, 0.72)", halo: "217, 130, 43", label: "#8a4e14" }
        : tier === "operation"
          ? { fill: "#8dc7c0", stroke: "rgba(47, 115, 109, 0.7)", halo: "141, 199, 192", label: "#2f736d" }
          : { fill: "#b7d9d3", stroke: "rgba(47, 43, 37, 0.38)", halo: "141, 199, 192", label: "#3e8581" };

  if (status === "failed") {
    return {
      status,
      fill: "#d12f24",
      stroke: "#691006",
      halo: "209, 47, 36",
      label: "#7a1209",
      ringWidth: active ? 3.6 : 3,
      haloAlpha: active ? 0.26 : 0.18,
      haloScale: 2.6,
      pulseStrength: 0.14,
      warningRing: true,
      forceLabel: true
    };
  }

  if (status === "running") {
    return {
      status,
      fill: "#f3a43b",
      stroke: "#925411",
      halo: "243, 164, 59",
      label: "#8a4e14",
      ringWidth: active ? 2.4 : 1.8,
      haloAlpha: active ? 0.18 : 0.11,
      haloScale: 2.9,
      pulseStrength: 0.1,
      warningRing: false,
      forceLabel: active
    };
  }

  if (status === "succeeded" || status === "observed") {
    return {
      status,
      fill: tier === "operation" ? "#8dc7c0" : base.fill,
      stroke: tier === "operation" ? "#2f736d" : base.stroke,
      halo: tier === "operation" ? "141, 199, 192" : base.halo,
      label: tier === "operation" ? "#2f736d" : base.label,
      ringWidth: active ? 2 : 1.35,
      haloAlpha: active ? 0.13 : 0.07,
      haloScale: 2.45,
      pulseStrength: active ? 0.05 : 0.02,
      warningRing: false,
      forceLabel: false
    };
  }

  return {
    status,
    fill: base.fill,
    stroke: status === "excluded" ? "rgba(47, 43, 37, 0.22)" : "#6e4a1f",
    halo: base.halo,
    label: base.label,
    ringWidth: active ? 2.3 : 1.55,
    haloAlpha: active ? 0.15 : 0.08,
    haloScale: 2.55,
    pulseStrength: active ? 0.06 : 0.02,
    warningRing: false,
    forceLabel: tier === "output"
  };
}

export function computeSceneInsets(viewport: GraphViewport) {
  const compact = viewport.width < 760;
  if (compact) {
    return {
      top: 220,
      right: 24,
      bottom: 112,
      left: 24
    };
  }

  return {
    top: 104,
    right: Math.min(430, Math.max(320, viewport.width * 0.28)),
    bottom: 104,
    left: Math.min(330, Math.max(250, viewport.width * 0.2))
  };
}

function sceneBounds(viewport: GraphViewport) {
  const insets = viewport.insets ?? computeSceneInsets(viewport);
  return {
    left: insets.left,
    top: insets.top,
    right: viewport.width - insets.right,
    bottom: viewport.height - insets.bottom,
    width: Math.max(1, viewport.width - insets.left - insets.right),
    height: Math.max(1, viewport.height - insets.top - insets.bottom)
  };
}

export function clusterAnchor(cluster: GraphCluster | undefined, viewport: GraphViewport) {
  const bounds = sceneBounds(viewport);
  const compact = viewport.width < 760;
  const centerX = bounds.left + bounds.width * (compact ? 0.5 : 0.52);
  const centerY = bounds.top + bounds.height * (compact ? 0.52 : 0.54);
  const spreadX = bounds.width * (compact ? 0.22 : 0.28);
  const spreadY = bounds.height * (compact ? 0.2 : 0.26);

  switch (cluster) {
    case "ontology":
      return { x: centerX - spreadX * 0.5, y: centerY - spreadY * 0.82 };
    case "plan":
      return { x: centerX - spreadX * 0.1, y: centerY - spreadY * 0.9 };
    case "search":
      return { x: centerX + spreadX * 0.58, y: centerY - spreadY * 0.68 };
    case "sources":
      return { x: centerX + spreadX * 1.02, y: centerY - spreadY * 0.18 };
    case "evidence":
      return { x: centerX + spreadX * 0.86, y: centerY + spreadY * 0.28 };
    case "verification":
      return { x: centerX + spreadX * 0.18, y: centerY + spreadY * 0.78 };
    case "synthesis":
      return { x: centerX - spreadX * 0.54, y: centerY + spreadY * 0.62 };
    case "reasoning":
      return { x: centerX - spreadX * 0.72, y: centerY + spreadY * 0.52 };
    case "visualization":
      return { x: centerX + spreadX * 0.88, y: centerY + spreadY * 0.88 };
    case "report":
      return { x: centerX + spreadX * 0.66, y: centerY + spreadY * 0.72 };
    case "intent":
    default:
      return { x: centerX, y: centerY - spreadY * 0.2 };
  }
}

export function initialNodePosition(
  node: GraphNode,
  viewport: GraphViewport,
  existing: Map<string, ForceGraphNode>
) {
  const parent = node.parentId ? existing.get(node.parentId) : null;
  const hash = stableHash(node.id);
  const angle = hash * Math.PI * 2;
  const anchor = clusterAnchor(node.cluster, viewport);

  if (parent) {
    const distance = 54 + hash * 44;
    return {
      x: (parent.x ?? anchor.x) + Math.cos(angle) * distance,
      y: (parent.y ?? anchor.y) + Math.sin(angle) * distance
    };
  }

  if (typeof node.x === "number" && typeof node.y === "number") {
    return {
      x: (node.x / 100) * viewport.width,
      y: (node.y / 100) * viewport.height
    };
  }

  return {
    x: anchor.x + Math.cos(angle) * 24,
    y: anchor.y + Math.sin(angle) * 24
  };
}

export function clampToViewport(node: ForceGraphNode, viewport: GraphViewport) {
  const bounds = sceneBounds(viewport);
  const margin = Math.max(34, node.radius + 18);
  node.x = Math.min(bounds.right - margin, Math.max(bounds.left + margin, node.x ?? bounds.left + bounds.width / 2));
  node.y = Math.min(bounds.bottom - margin, Math.max(bounds.top + margin, node.y ?? bounds.top + bounds.height / 2));
}

export function normalizeEdge(edge: GraphEdge): ForceGraphEdge {
  const sourceId = edge.source ?? edge.from;
  const targetId = edge.target ?? edge.to;
  return {
    ...edge,
    from: edge.from,
    to: edge.to,
    sourceId,
    targetId,
    relationIds: [edge.id],
    relationKinds: [edge.kind],
    relationCount: 1,
    source: sourceId,
    target: targetId
  };
}

function edgePairKey(edge: ForceGraphEdge) {
  return [edge.sourceId, edge.targetId].sort().join("__");
}

function primaryEdge(edges: ForceGraphEdge[]) {
  return [...edges].sort((left, right) => {
    const leftPriority = left.semanticPriority ?? edgePriority[left.kind];
    const rightPriority = right.semanticPriority ?? edgePriority[right.kind];
    return rightPriority - leftPriority;
  })[0];
}

export function aggregateVisibleEdges(edges: ForceGraphEdge[]) {
  const groups = new Map<string, ForceGraphEdge[]>();
  for (const edge of edges) {
    const key = edgePairKey(edge);
    groups.set(key, [...(groups.get(key) ?? []), edge]);
  }

  return [...groups.values()].flatMap((items) => {
    const visibleItems = items.filter((edge) => edge.displayMode !== "hidden");
    const primary = primaryEdge(visibleItems.length > 0 ? visibleItems : items);
    if (!primary) {
      return [];
    }

    return [
      {
        ...primary,
        relationIds: [...new Set(items.map((edge) => edge.id))],
        relationKinds: [...new Set(items.map((edge) => edge.kind))],
        relationCount: items.length,
        source: primary.sourceId,
        target: primary.targetId
      }
    ];
  });
}

export function connectedIds(nodeId: string | null, edges: GraphEdgeRelation[]) {
  if (!nodeId) {
    return new Set<string>();
  }

  const ids = new Set([nodeId]);
  for (const edge of edges) {
    if (edge.from === nodeId) {
      ids.add(edge.to);
    }
    if (edge.to === nodeId) {
      ids.add(edge.from);
    }
  }
  return ids;
}

export function isEdgeFocused(edge: GraphEdgeRelation, focusId: string | null) {
  return Boolean(focusId && (edge.from === focusId || edge.to === focusId));
}

export function labelVisible(node: ForceGraphNode, focusIds: Set<string>) {
  if (nodeRenderToken(node).forceLabel) {
    return true;
  }
  if (node.tier === "core" || node.tier === "output" || node.kind === "ontology") {
    return true;
  }
  if (focusIds.has(node.id)) {
    return true;
  }
  return (node.salience ?? 0) > 0.86;
}

export function clusterSeeds(nodes: ForceGraphNode[]) {
  const seen = new Set<GraphCluster>();
  return nodes.reduce<Array<{ cluster: GraphCluster; x: number; y: number; radius: number }>>((items, node) => {
    if (!node.cluster || seen.has(node.cluster)) {
      return items;
    }
    const siblings = nodes.filter((candidate) => candidate.cluster === node.cluster);
    const x = siblings.reduce((sum, sibling) => sum + (sibling.x ?? 0), 0) / siblings.length;
    const y = siblings.reduce((sum, sibling) => sum + (sibling.y ?? 0), 0) / siblings.length;
    const radius = 76 + siblings.length * 9 + clusterIndex[node.cluster] * 3;
    seen.add(node.cluster);
    items.push({ cluster: node.cluster, x, y, radius });
    return items;
  }, []);
}

function runtimeEndpoint(endpoint: string | number | ForceGraphNode | undefined) {
  return typeof endpoint === "object" && endpoint !== null ? endpoint : null;
}

export function buildGraphSceneSnapshot(options: {
  nodes: ForceGraphNode[];
  edges: ForceGraphEdge[];
  formedClusters: GraphCluster[];
  focusNodeId: string | null;
  selectedNodeId: string | null;
  emphasizedNodeId: string | null;
  viewport: {
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
  };
}): GraphSceneSnapshot {
  const focusIds = connectedIds(options.focusNodeId, options.edges);
  const sceneEdges = options.edges.flatMap((edge) => {
    const from = runtimeEndpoint(edge.source);
    const to = runtimeEndpoint(edge.target);
    if (!from || !to) {
      return [];
    }

    return [
      {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        fromX: from.x ?? 0,
        fromY: from.y ?? 0,
        toX: to.x ?? 0,
        toY: to.y ?? 0,
        active: isEdgeFocused(edge, options.focusNodeId),
        relationCount: edge.relationCount,
        relationKinds: edge.relationKinds
      }
    ];
  });

  return {
    viewport: options.viewport,
    nodes: options.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      tier: node.tier,
      cluster: node.cluster,
      x: node.x ?? 0,
      y: node.y ?? 0,
      radius: node.radius,
      active: focusIds.has(node.id) || node.id === options.emphasizedNodeId,
      reportMapped: Boolean(node.reportAnchorId)
    })),
    edges: sceneEdges,
    clusters: clusterSeeds(options.nodes)
      .filter((seed) => options.formedClusters.includes(seed.cluster))
      .map((seed) => ({
        id: seed.cluster,
        x: seed.x,
        y: seed.y,
        radius: seed.radius,
        active:
          focusIds.size === 0 ||
          options.nodes.some((node) => node.cluster === seed.cluster && focusIds.has(node.id))
      })),
    focusNodeId: options.focusNodeId,
    selectedNodeId: options.selectedNodeId,
    activePathIds: sceneEdges.filter((edge) => edge.active).map((edge) => edge.id)
  };
}
