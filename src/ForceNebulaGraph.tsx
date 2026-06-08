import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GraphCluster,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
  GraphNodeTier,
  GraphSceneSnapshot,
  ReportSection,
  SceneInsets,
  TaskStatus,
  VisualMode
} from "./types";
import {
  aggregateVisibleEdges,
  buildGraphSceneSnapshot,
  clampToViewport,
  clusterAnchor,
  clusterSeeds,
  connectedIds,
  deriveNodeImportance,
  deriveNodeTier,
  initialNodePosition,
  isEdgeFocused,
  labelVisible,
  nodeRenderToken,
  nodeRadius,
  normalizeEdge
} from "./graphPhysics";
import type { ForceGraphEdge, ForceGraphNode, GraphViewport } from "./graphPhysics";

type Props = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  formedClusters: GraphCluster[];
  emphasizedNodeId: string | null;
  status: TaskStatus;
  particlesEnabled: boolean;
  visualMode: VisualMode;
  sceneInsets: SceneInsets;
  reportFocusNodeId: string | null;
  reportSections: ReportSection[];
  onSceneUpdate: (scene: GraphSceneSnapshot) => void;
  onRetryTool: (toolNodeId: string) => void;
  onExcludeEvidence: (evidenceId: string) => void;
};

type PointerState = {
  nodeId: string;
  startX: number;
  startY: number;
  moved: boolean;
};

type NodeSnapshot = {
  id: string;
  x: number;
  y: number;
};

const nodeKindLabel: Record<GraphNodeKind, string> = {
  task_intent: "TASK",
  ontology: "ONTOLOGY",
  entity: "ENTITY",
  evidence: "EVIDENCE",
  tool_call: "TOOL",
  observation: "OBSERVATION",
  claim: "CLAIM",
  section: "SECTION"
};

const nodeTierLabel: Record<GraphNodeTier, string> = {
  core: "CORE",
  schema: "SCHEMA",
  record: "RECORD",
  operation: "OPERATION",
  output: "OUTPUT"
};

const edgeKindLabel: Record<GraphEdgeKind, string> = {
  extracts: "extracts",
  supports: "supports",
  observes: "observes",
  uses_tool: "uses tool",
  synthesizes: "synthesizes",
  becomes_section: "becomes section"
};

const clusterColor: Record<GraphCluster, { fill: string; stroke: string }> = {
  intent: { fill: "rgba(217, 130, 43, 0.1)", stroke: "rgba(217, 130, 43, 0.2)" },
  ontology: { fill: "rgba(47, 43, 37, 0.07)", stroke: "rgba(47, 43, 37, 0.14)" },
  evidence: { fill: "rgba(141, 199, 192, 0.12)", stroke: "rgba(62, 133, 129, 0.18)" },
  reasoning: { fill: "rgba(243, 164, 59, 0.1)", stroke: "rgba(217, 130, 43, 0.22)" },
  report: { fill: "rgba(141, 199, 192, 0.1)", stroke: "rgba(62, 133, 129, 0.18)" }
};

function getNode(nodes: ForceGraphNode[], id: string | null) {
  return id ? nodes.find((node) => node.id === id) ?? null : null;
}

function edgeEndpoint(endpoint: string | ForceGraphNode | number | undefined) {
  return typeof endpoint === "object" && endpoint !== null ? endpoint : null;
}

function edgeCurve(from: ForceGraphNode, to: ForceGraphNode) {
  const dx = (to.x ?? 0) - (from.x ?? 0);
  const dy = (to.y ?? 0) - (from.y ?? 0);
  return {
    c1x: (from.x ?? 0) + dx * 0.42 - dy * 0.055,
    c1y: (from.y ?? 0) + dy * 0.32,
    c2x: (from.x ?? 0) + dx * 0.72 + dy * 0.055,
    c2y: (from.y ?? 0) + dy * 0.78
  };
}

function drawText(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, stroke = false) {
  const characters = Array.from(text);
  let line = "";
  let lineY = y;

  for (const character of characters) {
    const next = `${line}${character}`;
    if (context.measureText(next).width > maxWidth && line) {
      if (stroke) {
        context.strokeText(line, x, lineY);
      }
      context.fillText(line, x, lineY);
      line = character;
      lineY += 16;
    } else {
      line = next;
    }
  }

  if (line) {
    if (stroke) {
      context.strokeText(line, x, lineY);
    }
    context.fillText(line, x, lineY);
  }
}

function pointerToCanvas(event: PointerEvent, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

export function ForceNebulaGraph({
  nodes,
  edges,
  formedClusters,
  emphasizedNodeId,
  status,
  particlesEnabled,
  visualMode,
  sceneInsets,
  reportFocusNodeId,
  reportSections,
  onSceneUpdate,
  onRetryTool,
  onExcludeEvidence
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const simulationRef = useRef(forceSimulation<ForceGraphNode>().stop());
  const linkForceRef = useRef(forceLink<ForceGraphNode, ForceGraphEdge>().id((node) => node.id));
  const nodesRef = useRef<ForceGraphNode[]>([]);
  const edgesRef = useRef<ForceGraphEdge[]>([]);
  const viewportRef = useRef<GraphViewport>({ width: 1, height: 1 });
  const pointerRef = useRef<PointerState | null>(null);
  const trailsRef = useRef<Map<string, NodeSnapshot[]>>(new Map());
  const lastSceneEmitRef = useRef(0);
  const propsRef = useRef({
    formedClusters,
    status,
    particlesEnabled,
    visualMode,
    emphasizedNodeId,
    reportFocusNodeId
  });
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<NodeSnapshot | null>(null);

  propsRef.current = {
    formedClusters,
    status,
    particlesEnabled,
    visualMode,
    emphasizedNodeId,
    reportFocusNodeId
  };

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);
  const selectedNodeEdges = useMemo(
    () => (selectedNodeId ? edges.filter((edge) => edge.from === selectedNodeId || edge.to === selectedNodeId) : []),
    [edges, selectedNodeId]
  );
  const selectedReportSections = useMemo(
    () => (selectedNodeId ? reportSections.filter((section) => section.sourceNodeIds.includes(selectedNodeId)) : []),
    [reportSections, selectedNodeId]
  );

  useEffect(() => {
    if (status !== "completed") {
      return;
    }

    setSelectedNodeId(null);
    setSelectedSnapshot(null);
  }, [status]);

  useEffect(() => {
    const simulation = simulationRef.current;
    const linkForce = linkForceRef.current
      .distance((edge) => edge.distance ?? 108)
      .strength((edge) => edge.strength ?? 0.46);

    simulation
      .force("link", linkForce)
      .force("charge", forceManyBody<ForceGraphNode>().strength((node) => -260 * node.mass))
      .force("collide", forceCollide<ForceGraphNode>().radius((node) => node.radius + 22).iterations(3))
      .force(
        "clusterX",
        forceX<ForceGraphNode>((node) => clusterAnchor(node.cluster, viewportRef.current).x).strength(0.055)
      )
      .force(
        "clusterY",
        forceY<ForceGraphNode>((node) => clusterAnchor(node.cluster, viewportRef.current).y).strength(0.058)
      )
      .velocityDecay(0.38)
      .alphaDecay(0.036)
      .stop();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const shell = shellRef.current;
    if (!canvas || !shell) {
      return undefined;
    }

    const resize = () => {
      const rect = shell.getBoundingClientRect();
      const deviceScale = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(320, rect.width);
      const height = Math.max(480, rect.height);
      viewportRef.current = { width, height, insets: sceneInsets };
      canvas.width = Math.floor(width * deviceScale);
      canvas.height = Math.floor(height * deviceScale);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext("2d");
      context?.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
      simulationRef.current.alpha(Math.max(simulationRef.current.alpha(), 0.52));
    };

    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [sceneInsets]);

  useEffect(() => {
    const viewport = {
      ...viewportRef.current,
      insets: sceneInsets
    };
    viewportRef.current = viewport;
    const existing = new Map(nodesRef.current.map((node) => [node.id, node]));
    const nextNodes = nodes.map((node) => {
      const previous = existing.get(node.id);
      if (previous) {
        previous.kind = node.kind;
        previous.label = node.label;
        previous.shortBody = node.shortBody;
        previous.summary = node.summary;
        previous.attributes = node.attributes;
        previous.episodes = node.episodes;
        previous.sourceRefs = node.sourceRefs;
        previous.status = node.status;
        previous.toolCall = node.toolCall;
        previous.evidence = node.evidence;
        previous.cluster = node.cluster;
        previous.parentId = node.parentId;
        previous.salience = node.salience;
        previous.confidence = node.confidence;
        previous.evidenceIds = node.evidenceIds;
        previous.tier = deriveNodeTier(node);
        previous.importance = deriveNodeImportance(node);
        previous.reportAnchorId = node.reportAnchorId;
        previous.visual = node.visual;
        previous.radius = nodeRadius(node);
        previous.mass = node.layout?.mass ?? previous.mass;
        return previous;
      }

      const position = initialNodePosition(node, viewport, existing);
      return {
        ...node,
        x: position.x,
        y: position.y,
        vx: 0,
        vy: 0,
        radius: nodeRadius(node),
        mass: node.layout?.mass ?? 1,
        tier: deriveNodeTier(node),
        importance: deriveNodeImportance(node),
        pinned: false,
        bornAt: performance.now()
      };
    });
    const ids = new Set(nextNodes.map((node) => node.id));
    const nextEdges = aggregateVisibleEdges(
      edges.map(normalizeEdge).filter((edge) => ids.has(edge.sourceId) && ids.has(edge.targetId))
    );

    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    simulationRef.current.nodes(nextNodes);
    linkForceRef.current.links(nextEdges);
    simulationRef.current.alpha(Math.max(simulationRef.current.alpha(), 0.82));

    if (selectedNodeId && !ids.has(selectedNodeId)) {
      setSelectedNodeId(null);
      setSelectedSnapshot(null);
    }
  }, [nodes, edges, sceneInsets, selectedNodeId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }

    const hitTest = (x: number, y: number) => {
      const orderedNodes = [...nodesRef.current].reverse();
      return (
        orderedNodes.find((node) => {
          const dx = x - (node.x ?? 0);
          const dy = y - (node.y ?? 0);
          return Math.hypot(dx, dy) <= node.radius + 20;
        }) ?? null
      );
    };

    const handlePointerMove = (event: PointerEvent) => {
      const point = pointerToCanvas(event, canvas);
      const drag = pointerRef.current;
      if (drag) {
        const node = getNode(nodesRef.current, drag.nodeId);
        if (node) {
          node.fx = point.x;
          node.fy = point.y;
          node.pinned = true;
          drag.moved = drag.moved || Math.hypot(point.x - drag.startX, point.y - drag.startY) > 4;
          simulationRef.current.alpha(Math.max(simulationRef.current.alpha(), 0.55));
        }
        return;
      }

      const node = hitTest(point.x, point.y);
      setHoveredNodeId((current) => (current === node?.id ? current : node?.id ?? null));
      canvas.style.cursor = node ? "grab" : "default";
    };

    const handlePointerDown = (event: PointerEvent) => {
      const point = pointerToCanvas(event, canvas);
      const node = hitTest(point.x, point.y);
      if (!node) {
        return;
      }

      event.preventDefault();
      pointerRef.current = {
        nodeId: node.id,
        startX: point.x,
        startY: point.y,
        moved: false
      };
      node.fx = node.x;
      node.fy = node.y;
      node.pinned = true;
      simulationRef.current.alpha(Math.max(simulationRef.current.alpha(), 0.65));
      canvas.style.cursor = "grabbing";
    };

    const handlePointerUp = (event: PointerEvent) => {
      const drag = pointerRef.current;
      pointerRef.current = null;
      canvas.style.cursor = hoveredNodeId ? "grab" : "default";
      if (!drag) {
        return;
      }

      const node = getNode(nodesRef.current, drag.nodeId);
      if (!node) {
        return;
      }

      setSelectedNodeId(node.id);
      setSelectedSnapshot({ id: node.id, x: node.x ?? 0, y: node.y ?? 0 });

      const point = pointerToCanvas(event, canvas);
      const nextHover = hitTest(point.x, point.y);
      setHoveredNodeId(nextHover?.id ?? null);
    };

    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [hoveredNodeId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }

    let frameId = 0;

    const render = (time: number) => {
      const viewport = viewportRef.current;
      const simulation = simulationRef.current;
      const currentProps = propsRef.current;
      const activeFocusId = currentProps.reportFocusNodeId ?? selectedNodeId ?? hoveredNodeId;
      const focusIds = connectedIds(activeFocusId, edgesRef.current);
      const tickCount = currentProps.status === "paused" ? 1 : currentProps.particlesEnabled ? 3 : 2;
      const mode = currentProps.visualMode;

      if (simulation.alpha() > 0.012) {
        for (let tick = 0; tick < tickCount; tick += 1) {
          simulation.tick();
        }
      } else if (currentProps.status !== "paused") {
        for (const node of nodesRef.current) {
          if (!node.fx && !node.fy) {
            node.x = (node.x ?? 0) + Math.sin(time * 0.00045 + node.radius) * 0.045;
            node.y = (node.y ?? 0) + Math.cos(time * 0.00038 + node.radius) * 0.04;
          }
        }
      }

      for (const node of nodesRef.current) {
        clampToViewport(node, viewport);
        const trail = trailsRef.current.get(node.id) ?? [];
        trail.push({ id: node.id, x: node.x ?? 0, y: node.y ?? 0 });
        trailsRef.current.set(node.id, trail.slice(currentProps.particlesEnabled ? -10 : -4));
      }

      const selectedRuntimeNode = getNode(nodesRef.current, selectedNodeId);
      if (selectedRuntimeNode) {
        setSelectedSnapshot({ id: selectedRuntimeNode.id, x: selectedRuntimeNode.x ?? 0, y: selectedRuntimeNode.y ?? 0 });
      }

      if (time - lastSceneEmitRef.current > 82) {
        onSceneUpdate(buildGraphSceneSnapshot({
          viewport: {
            width: viewport.width,
            height: viewport.height,
            offsetX: canvasRef.current?.getBoundingClientRect().left ?? 0,
            offsetY: canvasRef.current?.getBoundingClientRect().top ?? 0
          },
          nodes: nodesRef.current,
          edges: edgesRef.current,
          formedClusters: currentProps.formedClusters,
          focusNodeId: activeFocusId,
          emphasizedNodeId: currentProps.emphasizedNodeId,
          selectedNodeId
        }));
        lastSceneEmitRef.current = time;
      }

      context.clearRect(0, 0, viewport.width, viewport.height);

      for (const seed of clusterSeeds(nodesRef.current).filter((seed) => currentProps.formedClusters.includes(seed.cluster))) {
        const color = clusterColor[seed.cluster];
        const gradient = context.createRadialGradient(seed.x, seed.y, 0, seed.x, seed.y, seed.radius);
        gradient.addColorStop(0, mode === "system" ? color.stroke : color.fill);
        gradient.addColorStop(0.72, "rgba(255, 252, 244, 0.012)");
        gradient.addColorStop(1, "rgba(255, 252, 244, 0)");
        context.fillStyle = gradient;
        context.beginPath();
        context.ellipse(seed.x, seed.y, seed.radius * 1.14, seed.radius * 0.72, -0.18, 0, Math.PI * 2);
        context.fill();
      }

      context.save();
      context.globalCompositeOperation = "multiply";
      for (const edge of edgesRef.current) {
        const from = edgeEndpoint(edge.source);
        const to = edgeEndpoint(edge.target);
        if (!from || !to) {
          continue;
        }

        const focused = isEdgeFocused(edge, activeFocusId);
        const faded = activeFocusId && !focused;
        const curve = edgeCurve(from, to);
        const alpha = faded ? 0.028 : focused ? (mode === "system" ? 0.42 : 0.31) : mode === "system" ? 0.13 : 0.08;

        context.beginPath();
        context.moveTo(from.x ?? 0, from.y ?? 0);
        context.bezierCurveTo(curve.c1x, curve.c1y, curve.c2x, curve.c2y, to.x ?? 0, to.y ?? 0);
        context.strokeStyle =
          edge.kind === "uses_tool" || edge.kind === "synthesizes"
            ? `rgba(217, 130, 43, ${alpha})`
            : `rgba(62, 133, 129, ${alpha})`;
        context.lineWidth = focused ? (mode === "system" ? 1.2 : 1) : mode === "system" ? 0.7 : 0.52;
        context.stroke();

        if (focused) {
          const pulse = (Math.sin(time * 0.003 + from.radius) + 1) / 2;
          const px = (from.x ?? 0) + ((to.x ?? 0) - (from.x ?? 0)) * pulse;
          const py = (from.y ?? 0) + ((to.y ?? 0) - (from.y ?? 0)) * pulse;
          context.beginPath();
          context.fillStyle = "rgba(243, 164, 59, 0.42)";
          context.arc(px, py, 2, 0, Math.PI * 2);
          context.fill();
        }
      }
      context.restore();

      for (const node of nodesRef.current) {
        const recentlyAdded = time - node.bornAt < 3600;
        const running = node.status === "running" || node.toolCall?.status === "running";
        const failed = node.status === "failed" || node.toolCall?.status === "failed";
        const focused = focusIds.has(node.id) || node.id === currentProps.emphasizedNodeId || node.id === currentProps.reportFocusNodeId;
        const faded = activeFocusId && !focused;
        const selected = node.id === selectedNodeId;
        const activeSignal = selected || focused || running || failed || recentlyAdded;
        const token = nodeRenderToken(node, activeSignal);
        const alpha = faded ? 0.22 : 1;
        const glow = Math.min(0.72, (node.visual?.glow ?? 0.45) + (activeSignal ? 0.16 : 0));
        const pulse = 1 + Math.sin(time * (mode === "system" ? 0.0035 : 0.0024) + node.radius) * token.pulseStrength;
        const x = node.x ?? 0;
        const y = node.y ?? 0;

        const trail = trailsRef.current.get(node.id) ?? [];
        if (currentProps.particlesEnabled && !faded) {
          context.save();
          context.globalAlpha = 0.18 * alpha;
          context.strokeStyle = node.tier === "output" ? "rgba(217, 130, 43, 0.36)" : "rgba(141, 199, 192, 0.32)";
          context.lineWidth = 1;
          context.beginPath();
          trail.forEach((point, index) => {
            if (index === 0) {
              context.moveTo(point.x, point.y);
            } else {
              context.lineTo(point.x, point.y);
            }
          });
          context.stroke();
          context.restore();
        }

        const haloScale = node.tier === "core" ? 3.5 : node.tier === "output" ? 3 : node.tier === "operation" ? 2.75 : token.haloScale;
        const halo = context.createRadialGradient(x, y, 0, x, y, node.radius * (haloScale + glow));
        halo.addColorStop(0, `rgba(${token.halo}, ${token.haloAlpha * alpha})`);
        halo.addColorStop(0.5, `rgba(255, 252, 244, ${0.035 * alpha})`);
        halo.addColorStop(1, "rgba(255, 252, 244, 0)");
        context.fillStyle = halo;
        context.beginPath();
        context.arc(x, y, node.radius * (haloScale + glow), 0, Math.PI * 2);
        context.fill();

        context.save();
        context.globalAlpha = alpha;
        context.strokeStyle = token.stroke;
        context.lineWidth = selected ? Math.max(2.4, token.ringWidth) : token.ringWidth;
        if (token.status === "running") {
          context.setLineDash([4, 5]);
        }
        context.beginPath();
        context.arc(x, y, node.radius * (node.tier === "core" ? 1.52 : 1.24) * pulse, 0, Math.PI * 2);
        context.stroke();
        context.setLineDash([]);

        if (token.warningRing) {
          const warningPulse = 1 + Math.sin(time * 0.005 + node.radius) * 0.08;
          context.strokeStyle = "rgba(182, 56, 44, 0.5)";
          context.lineWidth = 1.2;
          context.beginPath();
          context.arc(x, y, node.radius * 1.9 * warningPulse, 0, Math.PI * 2);
          context.stroke();
        }

        if (activeSignal && !token.warningRing) {
          context.strokeStyle = token.status === "running" ? "rgba(243, 164, 59, 0.44)" : "rgba(62, 133, 129, 0.34)";
          context.lineWidth = 1;
          context.beginPath();
          context.arc(x, y, node.radius * 1.75 * pulse, 0, Math.PI * 2);
          context.stroke();
        }

        if (mode === "system" && (selected || focused)) {
          context.strokeStyle = "rgba(62, 133, 129, 0.28)";
          context.lineWidth = 1;
          context.beginPath();
          context.moveTo(x - node.radius * 2.1, y);
          context.lineTo(x + node.radius * 2.1, y);
          context.moveTo(x, y - node.radius * 2.1);
          context.lineTo(x, y + node.radius * 2.1);
          context.stroke();
        }

        context.beginPath();
        context.fillStyle = token.fill;
        context.arc(x, y, node.radius * (node.tier === "core" ? 0.62 : 0.5) * pulse, 0, Math.PI * 2);
        context.fill();

        if (token.warningRing) {
          context.font = "800 13px Avenir Next, Helvetica Neue, sans-serif";
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.strokeStyle = "rgba(105, 16, 6, 0.92)";
          context.lineWidth = 3;
          context.strokeText("!", x, y + 0.5);
          context.fillStyle = "#fffaf0";
          context.fillText("!", x, y + 0.5);
          context.textAlign = "start";
          context.textBaseline = "alphabetic";
        }

        if (node.reportAnchorId || node.id === currentProps.reportFocusNodeId) {
          context.strokeStyle = "rgba(47, 43, 37, 0.32)";
          context.lineWidth = 1;
          context.setLineDash([2, 5]);
          context.beginPath();
          context.arc(x, y, node.radius * 1.9, 0, Math.PI * 2);
          context.stroke();
          context.setLineDash([]);
        }
        context.restore();

        if (labelVisible(node, focusIds)) {
          const labelX = x + node.radius + 11;
          const labelY = y - 7;
          context.save();
          context.globalAlpha = faded ? 0.18 : alpha;
          context.font = "10px Avenir Next, Helvetica Neue, sans-serif";
          context.fillStyle = token.label;
          context.strokeStyle = "rgba(255, 252, 244, 0.88)";
          context.lineWidth = 3;
          context.strokeText(nodeKindLabel[node.kind], labelX, labelY);
          context.fillText(nodeKindLabel[node.kind], labelX, labelY);
          context.font =
            node.tier === "core" || node.tier === "output"
              ? mode === "system"
                ? "600 15px PingFang SC"
                : "600 16px PingFang SC"
              : mode === "system"
                ? "560 12px PingFang SC"
                : "560 13px PingFang SC";
          context.strokeStyle = "rgba(255, 252, 244, 0.9)";
          context.lineWidth = token.status === "failed" ? 4 : 3;
          context.fillStyle = token.status === "failed" ? "#691006" : "#2f2b25";
          drawText(context, node.label, labelX, labelY + 19, 148, true);
          context.restore();
        }
      }

      frameId = window.requestAnimationFrame(render);
    };

    frameId = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(frameId);
  }, [hoveredNodeId, onSceneUpdate, selectedNodeId]);

  const inspectorPosition = selectedSnapshot
    ? `${Math.round(selectedSnapshot.x)} / ${Math.round(selectedSnapshot.y)}`
    : "--";

  return (
    <section className="force-nebula" ref={shellRef} aria-label="Realtime force-directed knowledge graph">
      <canvas className="force-nebula-canvas" ref={canvasRef} />
      <AnimatePresence>
        {selectedNode && (
          <motion.aside
            className="node-inspector"
            initial={{ opacity: 0, x: 18, filter: "blur(12px)" }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, x: 14, filter: "blur(10px)" }}
            transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
          >
            <button className="inspector-close" type="button" onClick={() => setSelectedNodeId(null)} aria-label="Close node details">
              ×
            </button>
            <span>{nodeKindLabel[selectedNode.kind]}</span>
            <h2>{selectedNode.label}</h2>
            <p>{selectedNode.summary ?? selectedNode.shortBody}</p>
            <dl>
              <div>
                <dt>Tier</dt>
                <dd>{nodeTierLabel[deriveNodeTier(selectedNode)]}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{selectedNode.status ?? "running"}</dd>
              </div>
              <div>
                <dt>Position</dt>
                <dd>{inspectorPosition}</dd>
              </div>
            </dl>
            {selectedNode.attributes && Object.keys(selectedNode.attributes).length > 0 && (
              <div className="inspector-meta">
                <strong>Attributes</strong>
                {Object.entries(selectedNode.attributes).slice(0, 5).map(([key, value]) => (
                  <span key={key}>
                    <em>{key}</em>
                    {value}
                  </span>
                ))}
              </div>
            )}
            {selectedNode.episodes && selectedNode.episodes.length > 0 && (
              <div className="inspector-episodes">
                <strong>Episodes</strong>
                {selectedNode.episodes.slice(0, 3).map((episode) => (
                  <span key={episode.id}>
                    <em>{episode.time} · {episode.title}</em>
                    {episode.detail}
                  </span>
                ))}
              </div>
            )}
            {selectedNode.sourceRefs && selectedNode.sourceRefs.length > 0 && (
              <div className="inspector-report-link">
                <strong>Source Refs</strong>
                {selectedNode.sourceRefs.slice(0, 3).map((sourceRef) =>
                  sourceRef.startsWith("http") ? (
                    <a href={sourceRef} key={sourceRef} rel="noreferrer" target="_blank">
                      {sourceRef}
                    </a>
                  ) : (
                    <span key={sourceRef}>{sourceRef}</span>
                  )
                )}
              </div>
            )}
            {selectedNode.toolCall && (
              <div className="inspector-report-link">
                <strong>Tool I/O</strong>
                <span>{JSON.stringify(selectedNode.toolCall.input)}</span>
                {selectedNode.toolCall.outputSummary && <span>{selectedNode.toolCall.outputSummary}</span>}
                {selectedNode.toolCall.status === "failed" && (
                  <button type="button" onClick={() => onRetryTool(selectedNode.id)}>
                    Retry tool
                  </button>
                )}
              </div>
            )}
            {selectedNode.evidence && selectedNode.status !== "excluded" && (
              <div className="inspector-report-link">
                <strong>Evidence Control</strong>
                <span>{selectedNode.evidence.quote}</span>
                <button type="button" onClick={() => onExcludeEvidence(selectedNode.evidence!.id)}>
                  Exclude from report
                </button>
              </div>
            )}
            {selectedReportSections.length > 0 && (
              <div className="inspector-report-link">
                <strong>Report Mapping</strong>
                <span>{selectedReportSections.map((section) => section.title).join(" / ")}</span>
              </div>
            )}
            {selectedNodeEdges.length > 0 && (
              <ul>
                {selectedNodeEdges.slice(0, 5).map((edge) => {
                  const neighborId = edge.from === selectedNode.id ? edge.to : edge.from;
                  const neighbor = nodes.find((node) => node.id === neighborId);
                  return (
                    <li key={edge.id}>
                      <strong>{edge.label ?? edgeKindLabel[edge.kind]}</strong>
                      <span>{neighbor?.label ?? neighborId}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </motion.aside>
        )}
      </AnimatePresence>
    </section>
  );
}
