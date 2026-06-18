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
  TaskStatus
} from "./types";
import {
  aggregateVisibleEdges,
  buildGraphSceneSnapshot,
  clampToViewport,
  clusterSeeds,
  collisionRadius,
  connectedIds,
  deriveNodeImportance,
  deriveNodeTier,
  graphLinkDistance,
  graphLinkStrength,
  initialNodePosition,
  isEdgeFocused,
  labelVisible,
  nodeLayoutAnchor,
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
  sceneInsets: SceneInsets;
  reportFocusNodeId: string | null;
  reportSections: ReportSection[];
  onSceneUpdate: (scene: GraphSceneSnapshot) => void;
  onRetryTool: (toolNodeId: string) => Promise<unknown> | void;
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

type RetryState = {
  status: "pending" | "succeeded" | "failed";
  message: string;
};

type NodeMeaningSection = {
  title: string;
  body: string;
};

const nodeKindLabel: Record<GraphNodeKind, string> = {
  task_intent: "TASK",
  ontology: "ONTOLOGY",
  research_plan: "PLAN",
  search_query: "QUERY",
  source: "SOURCE",
  entity: "ENTITY",
  evidence: "EVIDENCE",
  tool_call: "TOOL",
  observation: "OBSERVATION",
  claim: "CLAIM",
  counterclaim: "COUNTER",
  verification: "VERIFY",
  example: "EXAMPLE",
  visualization: "VISUAL",
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
  execution_flow: "next step",
  extracts: "extracts",
  queries: "queries",
  returns_source: "returns source",
  extracts_evidence: "extracts evidence",
  supports: "supports",
  contradicts: "contradicts",
  verifies: "verifies",
  illustrates: "illustrates",
  feeds_visual: "feeds visual",
  observes: "observes",
  uses_tool: "uses tool",
  retry_of: "retry of",
  synthesizes: "synthesizes",
  becomes_section: "becomes section"
};

const clusterColor: Record<GraphCluster, { fill: string; stroke: string }> = {
  intent: { fill: "rgba(217, 130, 43, 0.1)", stroke: "rgba(217, 130, 43, 0.2)" },
  ontology: { fill: "rgba(47, 43, 37, 0.07)", stroke: "rgba(47, 43, 37, 0.14)" },
  plan: { fill: "rgba(47, 43, 37, 0.07)", stroke: "rgba(47, 43, 37, 0.16)" },
  search: { fill: "rgba(243, 164, 59, 0.08)", stroke: "rgba(217, 130, 43, 0.18)" },
  sources: { fill: "rgba(141, 199, 192, 0.1)", stroke: "rgba(62, 133, 129, 0.16)" },
  evidence: { fill: "rgba(141, 199, 192, 0.12)", stroke: "rgba(62, 133, 129, 0.18)" },
  verification: { fill: "rgba(217, 130, 43, 0.08)", stroke: "rgba(217, 130, 43, 0.2)" },
  synthesis: { fill: "rgba(47, 43, 37, 0.06)", stroke: "rgba(47, 43, 37, 0.14)" },
  reasoning: { fill: "rgba(243, 164, 59, 0.1)", stroke: "rgba(217, 130, 43, 0.22)" },
  visualization: { fill: "rgba(141, 199, 192, 0.11)", stroke: "rgba(62, 133, 129, 0.2)" },
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

export function summarizeToolInput(input: Record<string, unknown>) {
  const parts = Object.keys(input).slice(0, 4).map((key) => {
    const value = input[key];
    if (Array.isArray(value)) {
      return `${key}: ${value.length} items`;
    }
    if (value && typeof value === "object") {
      return `${key}: object`;
    }
    const text = String(value ?? "");
    return `${key}: ${text.length > 64 ? `${text.slice(0, 64)}...` : text}`;
  });
  return parts.join(" / ") || "No input";
}

export function visibleNodeAttributes(attributes: Record<string, string>) {
  return Object.entries(attributes)
    .filter(([key]) => key !== "input")
    .slice(0, 5)
    .map(([key, value]) => ({
      key,
      value: value.length > 180 ? `${value.slice(0, 180)}...` : value
    }));
}

const nodeKindMeaning: Record<GraphNodeKind, string> = {
  task_intent: "这是本次运行的目标节点，用来固定用户问题、范围和后续所有执行步骤的来源。",
  ontology: "这是过程本体节点，用来说明 runtime 会把哪些对象和关系映射成可检查图谱。",
  research_plan: "这是研究计划节点，用来承载问题拆解、检索分支、验证维度和报告大纲。",
  search_query: "这是检索分支节点，用来把研究计划转成具体搜索问题。",
  source: "这是来源节点，用来记录搜索返回或官方种子来源，后续会被读取和排序。",
  entity: "这是实体节点，用来保存从任务或材料中抽取出的关键概念。",
  evidence: "这是证据节点，用来保存可引用的来源片段、主张和置信度。",
  tool_call: "这是工具调用节点，用来记录一次真实或降级的工具输入、状态和输出摘要。",
  observation: "这是观察节点，用来汇总工具执行后的可用结果、失败降级或阶段产物。",
  claim: "这是结论节点，用来表达由证据和观察综合得到的判断。",
  counterclaim: "这是冲突结论节点，用来保留与主判断相反或需要谨慎处理的信号。",
  verification: "这是验证节点，用来表示交叉检查、质量检查或可信度判断。",
  example: "这是案例节点，用来说明某个结论如何落到具体样本或场景。",
  visualization: "这是可视化节点，用来记录报告中的图表或结构化展示方案。",
  section: "这是报告章节节点，用来把最终报告内容映射回过程图谱。"
};

const executionActionLabel: Record<NonNullable<GraphNode["executionStep"]>["stepId"], string> = {
  plan: "拆解问题和研究路径",
  search: "生成并执行检索分支",
  fetch: "读取候选来源正文",
  rank: "筛选和排序来源质量",
  extract: "抽取证据片段",
  verify: "交叉检查和验证判断",
  visualize: "规划报告中的结构化展示",
  write: "写入最终报告章节"
};

function compactText(value: string | undefined, maxLength = 240) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trim()}...` : normalized;
}

export function nodeMeaningSections(
  node: GraphNode,
  edges: GraphEdge[] = [],
  allNodes: GraphNode[] = [],
  reportSections: ReportSection[] = []
): NodeMeaningSection[] {
  const sections: NodeMeaningSection[] = [];
  const primaryMeaning = compactText(node.summary || node.shortBody || node.evidence?.claim || node.evidence?.quote || node.toolCall?.outputSummary);
  sections.push({
    title: "任务含义",
    body: primaryMeaning || nodeKindMeaning[node.kind]
  });

  if (node.executionStep) {
    sections.push({
      title: "执行动作",
      body: `${node.executionStep.stepLabel} · ${node.executionStep.stepStatus}：${executionActionLabel[node.executionStep.stepId]}。`
    });
  } else if (node.toolCall) {
    sections.push({
      title: "执行动作",
      body: `调用 ${node.toolCall.toolName}，状态 ${node.toolCall.status}，输入摘要：${summarizeToolInput(node.toolCall.input)}。`
    });
  } else if (node.episodes?.[0]) {
    sections.push({
      title: "执行动作",
      body: compactText(`${node.episodes[0].title}：${node.episodes[0].detail}`)
    });
  } else {
    sections.push({
      title: "执行动作",
      body: nodeKindMeaning[node.kind]
    });
  }

  const output = node.toolCall?.outputSummary
    || node.evidence?.quote
    || reportSections.map((section) => section.title).join(" / ")
    || node.sourceRefs?.slice(0, 2).join(" / ")
    || (node.confidence ? `当前置信度 ${Number(node.confidence).toFixed(2)}。` : "");
  if (output) {
    sections.push({
      title: "产出",
      body: compactText(output)
    });
  }

  if (edges.length > 0) {
    const relationText = edges.slice(0, 4).map((edge) => {
      const neighborId = edge.from === node.id ? edge.to : edge.from;
      const neighbor = allNodes.find((item) => item.id === neighborId);
      const direction = edge.from === node.id ? "指向" : "来自";
      return `${edge.label ?? edgeKindLabel[edge.kind]} ${direction} ${neighbor?.label ?? neighborId}`;
    }).join("；");
    sections.push({
      title: "关系",
      body: `${relationText}${edges.length > 4 ? `；另有 ${edges.length - 4} 条关系` : ""}。`
    });
  }

  return sections;
}

export function ForceNebulaGraph({
  nodes,
  edges,
  formedClusters,
  emphasizedNodeId,
  status,
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
    emphasizedNodeId,
    reportFocusNodeId
  });
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<NodeSnapshot | null>(null);
  const [retryStates, setRetryStates] = useState<Record<string, RetryState>>({});

  propsRef.current = {
    formedClusters,
    status,
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
      .distance((edge) => graphLinkDistance(edge))
      .strength((edge) => graphLinkStrength(edge));

    simulation
      .force("link", linkForce)
      .force("charge", forceManyBody<ForceGraphNode>().strength((node) => -190 * node.mass * (0.78 + node.importance * 0.38)))
      .force("collide", forceCollide<ForceGraphNode>().radius((node) => collisionRadius(node)).iterations(4))
      .force(
        "anchorX",
        forceX<ForceGraphNode>((node) => nodeLayoutAnchor(node, viewportRef.current).x).strength((node) => node.executionStep ? 0.18 : 0.11)
      )
      .force(
        "anchorY",
        forceY<ForceGraphNode>((node) => nodeLayoutAnchor(node, viewportRef.current).y).strength((node) => node.executionStep ? 0.16 : 0.115)
      )
      .velocityDecay(0.48)
      .alphaDecay(0.034)
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
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
    };
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
      const tickCount = currentProps.status === "paused" ? 1 : 2;

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
        trailsRef.current.set(node.id, trail.slice(-4));
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
        gradient.addColorStop(0, color.fill);
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
        const priorityEdge = edge.kind === "execution_flow" || edge.kind === "becomes_section" || edge.kind === "feeds_visual";
        const alpha = faded ? 0.018 : focused ? 0.34 : priorityEdge ? 0.105 : 0.045;

        context.beginPath();
        context.moveTo(from.x ?? 0, from.y ?? 0);
        context.bezierCurveTo(curve.c1x, curve.c1y, curve.c2x, curve.c2y, to.x ?? 0, to.y ?? 0);
        context.strokeStyle =
          edge.kind === "uses_tool" || edge.kind === "synthesizes"
            ? `rgba(217, 130, 43, ${alpha})`
            : `rgba(62, 133, 129, ${alpha})`;
        context.lineWidth = focused ? 1.15 : priorityEdge ? 0.62 : 0.42;
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
        const running = node.status === "running" || node.toolCall?.status === "running";
        const failed = node.status === "failed" || node.toolCall?.status === "failed";
        const focused = focusIds.has(node.id) || node.id === currentProps.emphasizedNodeId || node.id === currentProps.reportFocusNodeId;
        const faded = activeFocusId && !focused;
        const selected = node.id === selectedNodeId;
        const activeSignal = selected || focused || running || failed;
        const token = nodeRenderToken(node, activeSignal);
        const alpha = faded ? 0.22 : 1;
        const pulse = 1 + Math.sin(time * 0.0024 + node.radius) * token.pulseStrength;
        const x = node.x ?? 0;
        const y = node.y ?? 0;

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
              ? "600 16px PingFang SC"
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
  const selectedRetryState = selectedNodeId ? retryStates[selectedNodeId] : null;
  const selectedToolInput = selectedNode?.toolCall?.input ?? null;
  const selectedVisibleAttributes = selectedNode?.attributes ? visibleNodeAttributes(selectedNode.attributes) : [];
  const selectedMeaningSections = useMemo(
    () => selectedNode ? nodeMeaningSections(selectedNode, selectedNodeEdges, nodes, selectedReportSections) : [],
    [nodes, selectedNode, selectedNodeEdges, selectedReportSections]
  );

  const handleRetryTool = async (toolNodeId: string) => {
    setRetryStates((current) => ({
      ...current,
      [toolNodeId]: { status: "pending", message: "Retry request sent." }
    }));
    try {
      const result = await onRetryTool(toolNodeId);
      const message =
        result && typeof result === "object" && "message" in result
          ? String((result as { message?: unknown }).message)
          : "Retry completed. Rerun the task to regenerate downstream report output.";
      setRetryStates((current) => ({
        ...current,
        [toolNodeId]: { status: "succeeded", message }
      }));
    } catch (error) {
      setRetryStates((current) => ({
        ...current,
        [toolNodeId]: {
          status: "failed",
          message: error instanceof Error ? error.message : "Retry failed."
        }
      }));
    }
  };

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
              x
            </button>
            <span>{nodeKindLabel[selectedNode.kind]}</span>
            <h2>{selectedNode.label}</h2>
            <p>{selectedNode.summary ?? selectedNode.shortBody}</p>
            <div className="inspector-meaning">
              {selectedMeaningSections.map((section) => (
                <section key={section.title}>
                  <strong>{section.title}</strong>
                  <span>{section.body}</span>
                </section>
              ))}
            </div>
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
            {selectedVisibleAttributes.length > 0 && (
              <div className="inspector-meta">
                <strong>Attributes</strong>
                {selectedVisibleAttributes.map(({ key, value }) => (
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
                <span>{summarizeToolInput(selectedNode.toolCall.input)}</span>
                {selectedToolInput && (
                  <details className="tool-debug">
                    <summary>Full input</summary>
                    <pre>{JSON.stringify(selectedToolInput, null, 2)}</pre>
                  </details>
                )}
                {selectedNode.toolCall.outputSummary && <span>{selectedNode.toolCall.outputSummary}</span>}
                {selectedNode.toolCall.status === "failed" && (
                  <button
                    type="button"
                    onClick={() => void handleRetryTool(selectedNode.id)}
                    disabled={selectedRetryState?.status === "pending"}
                  >
                    {selectedRetryState?.status === "pending" ? "Retrying..." : "Retry failed tool"}
                  </button>
                )}
                {selectedRetryState && <span className={`retry-feedback ${selectedRetryState.status}`}>{selectedRetryState.message}</span>}
              </div>
            )}
            {selectedNode.evidence && selectedNode.status !== "excluded" && (
              <div className="inspector-report-link">
                <strong>Intervention</strong>
                <span>{selectedNode.evidence.quote}</span>
                <button type="button" onClick={() => onExcludeEvidence(selectedNode.evidence!.id)}>
                  Exclude excerpt
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
