import { describe, expect, it } from "vitest";
import {
  aggregateVisibleEdges,
  buildGraphSceneSnapshot,
  connectedIds,
  clusterAnchor,
  collisionRadius,
  computeSceneInsets,
  deriveNodeTier,
  graphLinkDistance,
  graphLinkStrength,
  initialNodePosition,
  isEdgeFocused,
  labelVisible,
  nodeLayoutAnchor,
  normalizeEdge,
  nodeRenderToken,
  nodeRadius
} from "./graphPhysics";
import type { ForceGraphNode } from "./graphPhysics";
import type { GraphEdge, GraphNode } from "./types";
import { getTimeline } from "./demoData";

function forceNode(node: Omit<ForceGraphNode, "tier" | "importance">): ForceGraphNode {
  return {
    tier: deriveNodeTier(node),
    importance: 0.8,
    ...node
  };
}

describe("graphPhysics", () => {
  it("places new nodes near their semantic parent", () => {
    const parent = forceNode({
      id: "task-brief",
      kind: "task_intent",
      label: "Intent",
      radius: 18,
      mass: 1,
      bornAt: 0,
      pinned: false,
      x: 420,
      y: 260
    });
    const node: GraphNode = {
      id: "child",
      kind: "entity",
      label: "Child",
      parentId: "task-brief",
      cluster: "ontology"
    };

    const position = initialNodePosition(node, { width: 900, height: 600 }, new Map([[parent.id, parent]]));

    expect(Math.hypot(position.x - 420, position.y - 260)).toBeGreaterThan(40);
    expect(Math.hypot(position.x - 420, position.y - 260)).toBeLessThan(100);
  });

  it("computes one-hop focus neighborhoods", () => {
    const edges: GraphEdge[] = [
      { id: "a", from: "task-brief", to: "ontology-schema", kind: "extracts" },
      { id: "b", from: "ontology-schema", to: "entity-agent-state", kind: "extracts" },
      { id: "c", from: "other", to: "external", kind: "supports" }
    ];

    expect([...connectedIds("ontology-schema", edges)].sort()).toEqual([
      "entity-agent-state",
      "ontology-schema",
      "task-brief"
    ]);
  });

  it("normalizes edge source and target aliases", () => {
    const edge = normalizeEdge({ id: "edge", from: "a", to: "b", kind: "supports" });

    expect(edge.sourceId).toBe("a");
    expect(edge.targetId).toBe("b");
    expect(edge.source).toBe("a");
    expect(edge.target).toBe("b");
  });

  it("derives focus and node radius from process graph state", () => {
    expect(isEdgeFocused({ id: "e", from: "task-brief", to: "ontology-schema", kind: "extracts" }, "task-brief")).toBe(true);
    expect(isEdgeFocused({ id: "e", from: "task-brief", to: "ontology-schema", kind: "extracts" }, null)).toBe(false);
    expect(nodeRadius({ id: "n", kind: "task_intent", label: "Seed", salience: 1 })).toBeGreaterThan(
      nodeRadius({ id: "m", kind: "entity", label: "Entity", salience: 0.2 })
    );
  });

  it("keeps scene anchors inside desktop and mobile safe areas", () => {
    const desktop = { width: 1440, height: 900 };
    const mobile = { width: 390, height: 844 };
    const desktopInsets = computeSceneInsets(desktop);
    const mobileInsets = computeSceneInsets(mobile);
    const desktopAnchor = clusterAnchor("report", { ...desktop, insets: desktopInsets });
    const mobileAnchor = clusterAnchor("intent", { ...mobile, insets: mobileInsets });

    expect(desktopAnchor.x).toBeGreaterThan(desktopInsets.left);
    expect(desktopAnchor.x).toBeLessThan(desktop.width - desktopInsets.right);
    expect(desktopAnchor.y).toBeLessThan(desktop.height - desktopInsets.bottom);
    expect(mobileAnchor.x).toBeGreaterThan(mobileInsets.left);
    expect(mobileAnchor.x).toBeLessThan(mobile.width - mobileInsets.right);
    expect(mobileAnchor.y).toBeGreaterThan(mobileInsets.top);
  });

  it("places execution-step anchors in a stable left-to-right lane", () => {
    const viewport = { width: 1200, height: 760, insets: computeSceneInsets({ width: 1200, height: 760 }) };
    const planAnchor = nodeLayoutAnchor({
      id: "research-plan",
      kind: "research_plan",
      label: "Plan",
      executionStep: { stepId: "plan", stepIndex: 1, stepLabel: "Plan", stepStatus: "queued" }
    }, viewport);
    const writeAnchor = nodeLayoutAnchor({
      id: "report-write",
      kind: "tool_call",
      label: "Write",
      executionStep: { stepId: "write", stepIndex: 8, stepLabel: "Write", stepStatus: "queued" }
    }, viewport);

    expect(writeAnchor.x).toBeGreaterThan(planAnchor.x);
    expect(Math.abs(writeAnchor.y - planAnchor.y)).toBeLessThan(viewport.height * 0.18);
  });

  it("uses stronger defaults for execution flow than background semantic edges", () => {
    const flow = normalizeEdge({ id: "flow", from: "a", to: "b", kind: "execution_flow" });
    const semantic = normalizeEdge({ id: "semantic", from: "a", to: "c", kind: "extracts" });

    expect(graphLinkStrength(flow)).toBeGreaterThan(graphLinkStrength(semantic));
    expect(graphLinkDistance(flow)).toBeLessThan(graphLinkDistance(semantic));
  });

  it("adds more collision padding for important labeled nodes", () => {
    const output = {
      ...forceNode({
        id: "section",
        kind: "section",
        label: "Section",
        radius: 20,
        mass: 1,
        bornAt: 0,
        pinned: false,
        x: 0,
        y: 0
      }),
      importance: 0.9
    };
    const record = {
      ...forceNode({
        id: "source",
        kind: "source",
        label: "Source",
        radius: 20,
        mass: 1,
        bornAt: 0,
        pinned: false,
        x: 0,
        y: 0
      }),
      importance: 0.4
    };

    expect(collisionRadius(output)).toBeGreaterThan(collisionRadius(record));
  });

  it("builds a scene snapshot from runtime graph positions", () => {
    const intent = forceNode({
      id: "task-brief",
      kind: "task_intent",
      label: "Intent",
      cluster: "intent",
      radius: 20,
      mass: 1,
      bornAt: 0,
      pinned: false,
      x: 300,
      y: 220
    });
    const ontology = forceNode({
      id: "ontology-schema",
      kind: "ontology",
      label: "Ontology",
      cluster: "ontology",
      radius: 17,
      mass: 1,
      bornAt: 0,
      pinned: false,
      x: 420,
      y: 360
    });
    const edge = normalizeEdge({ id: "edge", from: "task-brief", to: "ontology-schema", kind: "extracts" });
    edge.source = intent;
    edge.target = ontology;

    const snapshot = buildGraphSceneSnapshot({
      nodes: [intent, ontology],
      edges: [edge],
      formedClusters: ["intent", "ontology"],
      focusNodeId: "task-brief",
      selectedNodeId: "task-brief",
      emphasizedNodeId: null,
      viewport: { width: 900, height: 600, offsetX: 10, offsetY: 20 }
    });

    expect(snapshot.viewport.offsetX).toBe(10);
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.edges[0].active).toBe(true);
    expect(snapshot.activePathIds).toEqual(["edge"]);
    expect(snapshot.clusters.map((cluster) => cluster.id).sort()).toEqual(["intent", "ontology"]);
  });

  it("derives process tiers from node kind", () => {
    expect(deriveNodeTier({ id: "task", kind: "task_intent", label: "Task" })).toBe("core");
    expect(deriveNodeTier({ id: "schema", kind: "ontology", label: "Schema" })).toBe("schema");
    expect(deriveNodeTier({ id: "tool", kind: "tool_call", label: "Tool" })).toBe("operation");
    expect(deriveNodeTier({ id: "section", kind: "section", label: "Section" })).toBe("output");
  });

  it("maps node status to distinct render tokens and keeps failed tool labels visible", () => {
    const running = nodeRenderToken({ id: "running", kind: "tool_call", label: "Running", status: "running" });
    const observed = nodeRenderToken({ id: "observed", kind: "tool_call", label: "Observed", status: "observed" });
    const failedNode = forceNode({
      id: "failed",
      kind: "tool_call",
      label: "Failed",
      status: "failed",
      radius: 18,
      mass: 1,
      bornAt: 0,
      pinned: false,
      x: 0,
      y: 0
    });
    const failed = nodeRenderToken(failedNode);
    const written = nodeRenderToken({ id: "written", kind: "section", label: "Written", status: "written" });

    expect(running.status).toBe("running");
    expect(running.pulseStrength).toBeGreaterThan(observed.pulseStrength);
    expect(failed.warningRing).toBe(true);
    expect(failed.forceLabel).toBe(true);
    expect(labelVisible(failedNode, new Set())).toBe(true);
    expect(written.stroke).not.toBe(observed.stroke);
  });

  it("dims low-importance failed tool labels until focused", () => {
    const failed = nodeRenderToken({
      id: "fetch-failed",
      kind: "tool_call",
      label: "Fetch failed",
      status: "failed",
      importance: 0.34
    });
    const focused = nodeRenderToken({
      id: "fetch-failed",
      kind: "tool_call",
      label: "Fetch failed",
      status: "failed",
      importance: 0.34
    }, true);

    expect(failed.warningRing).toBe(true);
    expect(failed.forceLabel).toBe(false);
    expect(focused.forceLabel).toBe(true);
  });

  it("keeps idle node glow much quieter than active or failed nodes", () => {
    const idle = nodeRenderToken({ id: "source", kind: "source", label: "Source", status: "observed" });
    const active = nodeRenderToken({ id: "source", kind: "source", label: "Source", status: "observed" }, true);
    const failed = nodeRenderToken({ id: "failed", kind: "tool_call", label: "Failed", status: "failed" });

    expect(idle.haloAlpha).toBeLessThan(active.haloAlpha);
    expect(idle.haloScale).toBeLessThan(active.haloScale);
    expect(idle.haloAlpha).toBeLessThan(failed.haloAlpha);
  });

  it("aggregates duplicate semantic edges into one visible edge", () => {
    const edges = [
      normalizeEdge({ id: "extract", from: "task-brief", to: "ontology-schema", kind: "extracts" }),
      normalizeEdge({ id: "support", from: "ontology-schema", to: "task-brief", kind: "supports" })
    ];

    const visibleEdges = aggregateVisibleEdges(edges);

    expect(visibleEdges).toHaveLength(1);
    expect(visibleEdges[0].relationCount).toBe(2);
    expect(visibleEdges[0].relationKinds.sort()).toEqual(["extracts", "supports"]);
    expect(visibleEdges[0].kind).toBe("supports");
  });

  it("keeps execution flow edges above semantic edges when aggregating", () => {
    const edges = [
      normalizeEdge({ id: "semantic", from: "research-plan", to: "search-summary", kind: "queries" }),
      normalizeEdge({ id: "flow", from: "research-plan", to: "search-summary", kind: "execution_flow" })
    ];

    const visibleEdges = aggregateVisibleEdges(edges);

    expect(visibleEdges).toHaveLength(1);
    expect(visibleEdges[0].kind).toBe("execution_flow");
  });

  it("maps final report sections back to existing graph nodes", () => {
    const timeline = getTimeline();
    const nodeIds = new Set(
      timeline.flatMap((event) => event.graphEvent?.type === "node_added" ? [event.graphEvent.node.id] : [])
    );
    const finalReport = timeline.find((event) => event.finalReport)?.finalReport;

    expect(finalReport?.sections?.length).toBeGreaterThan(3);
    for (const section of finalReport?.sections ?? []) {
      expect(section.body.length).toBeGreaterThan(90);
      expect(section.sourceNodeIds.every((nodeId) => nodeIds.has(nodeId))).toBe(true);
    }
  });
});
