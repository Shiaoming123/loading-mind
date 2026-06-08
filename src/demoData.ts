import type {
  GraphCluster,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  LoadingEvent,
  LoadingPhase,
  VisualIntensity
} from "./types";

export const phases: Array<{
  id: LoadingPhase;
  label: string;
  caption: string;
  intensity: VisualIntensity;
}> = [
  {
    id: "initializing",
    label: "Seed",
    caption: "建立任务目标",
    intensity: "quiet"
  },
  {
    id: "ontology",
    label: "Ontology",
    caption: "生成概念体系",
    intensity: "focused"
  },
  {
    id: "graph_build",
    label: "Graph Build",
    caption: "抽取实体关系",
    intensity: "dense"
  },
  {
    id: "evidence",
    label: "Evidence",
    caption: "聚合证据片段",
    intensity: "dense"
  },
  {
    id: "reasoning",
    label: "Reasoning",
    caption: "形成判断链路",
    intensity: "focused"
  },
  {
    id: "drafting",
    label: "Draft",
    caption: "写入报告章节",
    intensity: "focused"
  },
  {
    id: "final_reveal",
    label: "Resolve",
    caption: "收束为交付物",
    intensity: "resolved"
  },
  {
    id: "completed",
    label: "Report",
    caption: "报告已完成",
    intensity: "resolved"
  }
];

const kindRadius: Record<GraphNodeKind, number> = {
  task_intent: 17,
  ontology: 14,
  entity: 11,
  evidence: 11,
  tool_call: 13,
  observation: 11,
  claim: 14,
  section: 15
};

const node = (nodeValue: GraphNode): LoadingEvent["graphEvent"] => ({
  type: "node_added",
  node: {
    confidence: nodeValue.confidence ?? 0.88,
    salience: nodeValue.salience ?? (nodeValue.kind === "task_intent" ? 1 : nodeValue.kind === "section" ? 0.9 : 0.72),
    evidenceIds: nodeValue.evidenceIds ?? [],
    sourceRefs: nodeValue.sourceRefs ?? [],
    attributes: nodeValue.attributes ?? {},
    episodes: nodeValue.episodes ?? [],
    status: nodeValue.status ?? "running",
    layout: {
      radius: nodeValue.layout?.radius ?? kindRadius[nodeValue.kind],
      mass: nodeValue.layout?.mass ?? (nodeValue.kind === "task_intent" ? 1.8 : nodeValue.kind === "section" ? 1.35 : 1)
    },
    visual: {
      status: "emerging",
      glow: nodeValue.kind === "task_intent" || nodeValue.kind === "section" ? 0.95 : 0.6,
      labelLevel: nodeValue.kind === "task_intent" || nodeValue.kind === "section" || nodeValue.kind === "claim" ? "short" : "hidden"
    },
    ...nodeValue
  }
});

const edge = (edgeValue: GraphEdge): LoadingEvent["graphEvent"] => ({
  type: "edge_added",
  edge: {
    source: edgeValue.from,
    target: edgeValue.to,
    confidence: edgeValue.confidence ?? 0.86,
    distance:
      edgeValue.kind === "becomes_section"
        ? 122
        : edgeValue.kind === "uses_tool"
          ? 128
          : edgeValue.kind === "observes"
            ? 98
            : 110,
    strength:
      edgeValue.kind === "becomes_section"
        ? 0.46
        : edgeValue.kind === "uses_tool"
          ? 0.4
          : 0.52,
    status: edgeValue.status ?? "emerging",
    evidenceIds: edgeValue.evidenceIds ?? [],
    ...edgeValue
  }
});

const cluster = (clusterValue: GraphCluster): LoadingEvent["graphEvent"] => ({
  type: "cluster_formed",
  cluster: clusterValue
});

const timeline: LoadingEvent[] = [
  {
    id: "g-001",
    phase: "initializing",
    timestamp: 700,
    message: "接收长链路任务：分析 AI Agent 等待过程如何被可视化呈现。",
    graphEvent: node({
      id: "task-brief",
      kind: "task_intent",
      label: "Agent 等待可视化",
      shortBody: "把长任务等待转化为可检查的过程证据和最终报告。",
      summary: "用户不是要一个装饰性 loading，而是要在 Agent 长链路执行时看到过程：目标如何拆解、证据如何形成、工具如何被调用、结论如何被写入最终产物。",
      attributes: {
        goal: "长链路等待过程态",
        audience: "AI Product Builder 面试官",
        output: "完整体验设计报告"
      },
      episodes: [
        {
          id: "ep-brief",
          time: "00:00",
          title: "任务进入队列",
          detail: "系统建立任务 seed，并准备抽取 ontology。"
        }
      ],
      x: 46,
      y: 42,
      cluster: "intent",
      status: "observed"
    })
  },
  {
    id: "g-002",
    phase: "ontology",
    timestamp: 2200,
    message: "正在生成 ontology：用户心理、Agent 行为、证据片段、报告章节。",
    graphEvent: node({
      id: "ontology-schema",
      kind: "ontology",
      label: "过程本体",
      shortBody: "定义节点和关系的语义边界。",
      summary: "本体层定义了本 demo 中可被检查的对象：任务意图、实体、证据、工具调用、观察结果、判断和报告章节。",
      attributes: {
        nodeTypes: "8",
        relationTypes: "6",
        policy: "每个节点必须能解释其在长链路中的作用"
      },
      episodes: [
        {
          id: "ep-ontology",
          time: "00:02",
          title: "Ontology generated",
          detail: "生成 task_intent/entity/evidence/tool_call/observation/claim/section 类型。"
        }
      ],
      sourceRefs: ["MiroFish Graph Building", "GraphRAG schema"],
      x: 55,
      y: 31,
      cluster: "ontology",
      parentId: "task-brief",
      status: "observed"
    })
  },
  {
    id: "g-003",
    phase: "ontology",
    timestamp: 3000,
    message: "Ontology 与任务 seed 建立 extracts 关系。",
    graphEvent: edge({
      id: "e-brief-ontology",
      from: "task-brief",
      to: "ontology-schema",
      kind: "extracts",
      label: "extracts ontology"
    })
  },
  {
    id: "g-004",
    phase: "graph_build",
    timestamp: 4300,
    message: "正在抽取实体：等待心理、过程透明度、阶段产物。",
    graphEvent: node({
      id: "entity-waiting-psychology",
      kind: "entity",
      label: "等待心理",
      shortBody: "用户能接受慢，但不能接受失控。",
      summary: "长链路等待的核心风险不是时间本身，而是不知道系统是否卡住、跑偏或正在产生有效内容。",
      attributes: {
        type: "user_state",
        risk: "loss_of_control",
        confidence: "0.86"
      },
      episodes: [
        {
          id: "ep-waiting",
          time: "00:04",
          title: "Entity extracted",
          detail: "从任务描述中抽取用户等待心理。"
        }
      ],
      x: 34,
      y: 48,
      cluster: "ontology",
      parentId: "ontology-schema",
      status: "observed"
    })
  },
  {
    id: "g-005",
    phase: "graph_build",
    timestamp: 5200,
    message: "实体连接到 ontology，图谱开始形成可解释结构。",
    graphEvent: edge({
      id: "e-ontology-waiting",
      from: "ontology-schema",
      to: "entity-waiting-psychology",
      kind: "extracts",
      label: "extracts entity"
    })
  },
  {
    id: "g-006",
    phase: "graph_build",
    timestamp: 6100,
    message: "正在抽取实体：Agent 状态机与可观察事件流。",
    graphEvent: node({
      id: "entity-agent-state",
      kind: "entity",
      label: "Agent 状态机",
      shortBody: "阶段、工具、观察、判断必须被事件化。",
      summary: "Agent 过程态需要由事件驱动，而不是靠一段固定动画伪装进度；每个状态变化都应能落到节点、边和报告映射。",
      attributes: {
        type: "process_entity",
        lifecycle: "event_driven",
        display: "graph + inspector"
      },
      episodes: [
        {
          id: "ep-state",
          time: "00:06",
          title: "Entity extracted",
          detail: "识别出状态机是过程可视化的底层承载。"
        }
      ],
      x: 63,
      y: 45,
      cluster: "ontology",
      parentId: "ontology-schema",
      status: "observed"
    })
  },
  {
    id: "g-007",
    phase: "graph_build",
    timestamp: 7000,
    message: "Agent 状态机连接到任务 seed。",
    graphEvent: edge({
      id: "e-ontology-state",
      from: "ontology-schema",
      to: "entity-agent-state",
      kind: "extracts",
      label: "extracts entity"
    })
  },
  {
    id: "g-008",
    phase: "graph_build",
    timestamp: 7800,
    message: "形成 ontology cluster：任务、实体和过程对象已定义。",
    graphEvent: cluster("ontology")
  },
  {
    id: "g-009",
    phase: "evidence",
    timestamp: 8900,
    message: "正在聚合 evidence episode：等待体验需要可见进度和下一步。",
    graphEvent: node({
      id: "evidence-visible-progress",
      kind: "evidence",
      label: "可见进度",
      shortBody: "状态、下一步、证据链能降低等待焦虑。",
      summary: "证据片段指出，用户在等待时需要知道当前正在做什么、下一步是什么、已有中间产物是什么。",
      attributes: {
        evidenceType: "experience_signal",
        quality: "high",
        role: "reduces_anxiety"
      },
      episodes: [
        {
          id: "ep-progress-a",
          time: "00:08",
          title: "Observation",
          detail: "普通 loading 只传达等待，不传达任务进展。"
        },
        {
          id: "ep-progress-b",
          time: "00:09",
          title: "Evidence",
          detail: "阶段产物和下一步提示能让用户判断系统仍在推进。"
        }
      ],
      sourceRefs: ["UX waiting psychology", "Agent process transparency"],
      x: 73,
      y: 57,
      cluster: "evidence",
      parentId: "entity-waiting-psychology",
      status: "observed"
    })
  },
  {
    id: "g-010",
    phase: "evidence",
    timestamp: 9800,
    message: "可见进度证据支持等待心理节点。",
    graphEvent: edge({
      id: "e-waiting-progress",
      from: "entity-waiting-psychology",
      to: "evidence-visible-progress",
      kind: "supports",
      label: "supports"
    })
  },
  {
    id: "g-011",
    phase: "evidence",
    timestamp: 10800,
    message: "正在调用工具：InsightForge mock 检索过程态设计模式。",
    graphEvent: node({
      id: "tool-insightforge",
      kind: "tool_call",
      label: "InsightForge 检索",
      shortBody: "模拟 Agent 调用外部检索/分析工具。",
      summary: "工具调用节点让用户看到 Agent 正在把任务推进到可验证的操作，而不是停留在抽象思考。",
      attributes: {
        tool: "InsightForge.search",
        input: "agent waiting state visualization",
        latency: "1.8s"
      },
      episodes: [
        {
          id: "ep-tool-a",
          time: "00:10",
          title: "Action",
          detail: "调用 search_process_patterns(query)。"
        }
      ],
      x: 50,
      y: 66,
      cluster: "evidence",
      parentId: "entity-agent-state",
      status: "running"
    })
  },
  {
    id: "g-012",
    phase: "evidence",
    timestamp: 11600,
    message: "工具调用与 Agent 状态机建立 uses_tool 关系。",
    graphEvent: edge({
      id: "e-state-tool",
      from: "entity-agent-state",
      to: "tool-insightforge",
      kind: "uses_tool",
      label: "uses tool"
    })
  },
  {
    id: "g-013",
    phase: "evidence",
    timestamp: 12600,
    message: "工具返回 observation：图谱过程态比 spinner 更可信。",
    graphEvent: node({
      id: "observation-graph-process",
      kind: "observation",
      label: "图谱过程态",
      shortBody: "过程节点和证据链比纯动画更可信。",
      summary: "观察结果显示，用户需要看见结构化过程：信息节点被创建、关系被验证、章节逐步形成。",
      attributes: {
        source: "tool_result",
        observation: "graph_state_as_progress",
        confidence: "0.91"
      },
      episodes: [
        {
          id: "ep-observation",
          time: "00:12",
          title: "Observation",
          detail: "返回模式：graph nodes + relation updates + inspectable evidence。"
        }
      ],
      sourceRefs: ["tool-insightforge"],
      x: 59,
      y: 72,
      cluster: "evidence",
      parentId: "tool-insightforge",
      status: "observed"
    })
  },
  {
    id: "g-014",
    phase: "evidence",
    timestamp: 13400,
    message: "Observation 回写到工具调用，证据 cluster 形成。",
    graphEvent: edge({
      id: "e-tool-observation",
      from: "tool-insightforge",
      to: "observation-graph-process",
      kind: "observes",
      label: "observes"
    })
  },
  {
    id: "g-015",
    phase: "evidence",
    timestamp: 14000,
    message: "形成 evidence cluster：证据片段和工具观察已接入图谱。",
    graphEvent: cluster("evidence")
  },
  {
    id: "g-016",
    phase: "reasoning",
    timestamp: 15200,
    message: "正在执行 ReACT 推理：Thought → Action → Observation → Claim。",
    graphEvent: node({
      id: "claim-process-not-loading",
      kind: "claim",
      label: "等待即过程",
      shortBody: "等待过程本身应成为可检查产物。",
      summary: "核心判断：长链路 Agent 体验不应把等待藏在 loading 后面，而应该把中间结构、证据和工具行为作为过程资产呈现。",
      attributes: {
        thought: "用户要判断系统是否有效推进",
        action: "map evidence to visual graph",
        observation: "graph process is inspectable",
        confidence: "0.9"
      },
      episodes: [
        {
          id: "ep-claim-a",
          time: "00:15",
          title: "Thought",
          detail: "如果用户能看见结构形成，等待会从被动状态变成可理解过程。"
        },
        {
          id: "ep-claim-b",
          time: "00:16",
          title: "Final Answer draft",
          detail: "过程态应该以节点、边、证据和章节映射承载。"
        }
      ],
      sourceRefs: ["evidence-visible-progress", "observation-graph-process"],
      x: 40,
      y: 66,
      cluster: "reasoning",
      parentId: "observation-graph-process",
      status: "synthesized"
    })
  },
  {
    id: "g-017",
    phase: "reasoning",
    timestamp: 16000,
    message: "Claim 综合 evidence 和 observation。",
    graphEvent: edge({
      id: "e-observation-claim",
      from: "observation-graph-process",
      to: "claim-process-not-loading",
      kind: "synthesizes",
      label: "synthesizes"
    })
  },
  {
    id: "g-018",
    phase: "reasoning",
    timestamp: 17000,
    message: "Claim 与可见进度证据建立支持关系。",
    graphEvent: edge({
      id: "e-progress-claim",
      from: "evidence-visible-progress",
      to: "claim-process-not-loading",
      kind: "supports",
      label: "supports"
    })
  },
  {
    id: "g-019",
    phase: "reasoning",
    timestamp: 17800,
    message: "形成 reasoning cluster：判断链路稳定。",
    graphEvent: cluster("reasoning")
  },
  {
    id: "g-020",
    phase: "drafting",
    timestamp: 19000,
    message: "正在写入报告章节：问题定义与目标用户。",
    graphEvent: node({
      id: "section-problem",
      kind: "section",
      label: "问题定义",
      shortBody: "长链路等待不是空白，而是可被表达的执行链路。",
      summary: "报告章节将任务意图、等待心理和 Agent 状态机整理为问题定义。",
      attributes: {
        section: "1",
        wordTarget: "220",
        status: "writing"
      },
      episodes: [
        {
          id: "ep-section-problem",
          time: "00:19",
          title: "Write section",
          detail: "写入报告的问题定义部分。"
        }
      ],
      sourceRefs: ["task-brief", "entity-waiting-psychology", "entity-agent-state"],
      x: 34,
      y: 76,
      cluster: "report",
      parentId: "claim-process-not-loading",
      reportAnchorId: "report-problem",
      status: "written"
    })
  },
  {
    id: "g-021",
    phase: "drafting",
    timestamp: 19800,
    message: "问题定义章节接入 reasoning claim。",
    graphEvent: edge({
      id: "e-claim-section-problem",
      from: "claim-process-not-loading",
      to: "section-problem",
      kind: "becomes_section",
      label: "becomes section"
    })
  },
  {
    id: "g-022",
    phase: "drafting",
    timestamp: 21000,
    message: "正在写入报告章节：过程可视化原则。",
    graphEvent: node({
      id: "section-principles",
      kind: "section",
      label: "体验原则",
      shortBody: "可见、可检查、可追溯，而不是只给百分比。",
      summary: "该章节把证据片段和工具观察转化为体验设计原则。",
      attributes: {
        section: "2",
        wordTarget: "360",
        status: "writing"
      },
      episodes: [
        {
          id: "ep-section-principles",
          time: "00:21",
          title: "Write section",
          detail: "把 evidence 和 observation 写入体验原则。"
        }
      ],
      sourceRefs: ["evidence-visible-progress", "observation-graph-process", "claim-process-not-loading"],
      x: 53,
      y: 79,
      cluster: "report",
      parentId: "claim-process-not-loading",
      reportAnchorId: "report-principles",
      status: "written"
    })
  },
  {
    id: "g-023",
    phase: "drafting",
    timestamp: 21800,
    message: "体验原则章节接入 claim。",
    graphEvent: edge({
      id: "e-claim-section-principles",
      from: "claim-process-not-loading",
      to: "section-principles",
      kind: "becomes_section",
      label: "becomes section"
    })
  },
  {
    id: "g-024",
    phase: "drafting",
    timestamp: 23000,
    message: "正在写入报告章节：实现建议和风险。",
    graphEvent: node({
      id: "section-implementation",
      kind: "section",
      label: "实现建议",
      shortBody: "事件流、Inspector、报告映射构成完整闭环。",
      summary: "该章节将 Agent 状态机、工具调用、证据节点和报告结构落到可实现的界面组件。",
      attributes: {
        section: "3",
        wordTarget: "420",
        status: "writing"
      },
      episodes: [
        {
          id: "ep-section-impl",
          time: "00:23",
          title: "Write section",
          detail: "写入实现建议、风险和验收标准。"
        }
      ],
      sourceRefs: ["entity-agent-state", "tool-insightforge", "section-principles"],
      x: 70,
      y: 73,
      cluster: "report",
      parentId: "section-principles",
      reportAnchorId: "report-implementation",
      status: "written"
    })
  },
  {
    id: "g-025",
    phase: "drafting",
    timestamp: 23800,
    message: "实现建议章节接入工具调用和状态机节点。",
    graphEvent: edge({
      id: "e-state-section-implementation",
      from: "entity-agent-state",
      to: "section-implementation",
      kind: "becomes_section",
      label: "becomes section"
    })
  },
  {
    id: "g-026",
    phase: "drafting",
    timestamp: 24600,
    message: "形成 report cluster：章节已经映射回来源图谱。",
    graphEvent: cluster("report")
  },
  {
    id: "g-027",
    phase: "final_reveal",
    timestamp: 26500,
    message: "报告正文完成，正在建立章节到图谱节点的来源映射。",
    finalReport: {
      id: "agent-process-final-report",
      kind: "final",
      title: "AI Agent 长链路等待过程可视化体验设计报告",
      body:
        "本报告说明如何把 Agent 长链路等待过程从不可见的 loading 改造成可检查、可理解、可追溯的过程体验。结论是：等待不应该被隐藏，而应被结构化表达为任务意图、概念本体、证据片段、工具调用、观察结果、推理判断和最终章节之间持续生长的知识图谱。",
      sections: [
        {
          id: "report-problem",
          title: "一、问题定义：等待不是空白，而是缺少可见结构",
          body:
            "AI Agent 执行复杂任务时，真实耗时往往来自检索、抽取、工具调用、推理和写作，而不是单一接口延迟。传统 loading 只告诉用户“还没结束”，无法解释系统正在做什么、是否跑偏、是否产生了可用中间结果。对于面试 Demo 或产品评审场景，这种黑盒等待会削弱可信度。更合理的设计是把等待拆成可观察事件：任务 seed 进入系统，ontology 被生成，实体和证据被抽取，工具调用产生 observation，claim 被综合，最后写入报告章节。用户不需要读完整日志，但应该能从图谱看到结构正在形成，并在点击节点时看到 summary、attributes、episodes 和来源引用。",
          sourceNodeIds: ["task-brief", "entity-waiting-psychology", "entity-agent-state"]
        },
        {
          id: "report-principles",
          title: "二、体验原则：可见、可检查、可追溯",
          body:
            "过程态的核心不是装饰性动效，而是信息可检查性。第一，系统要显示当前阶段：正在生成 ontology、正在抽取实体、正在聚合证据、正在调用工具、正在综合判断、正在写入章节。第二，节点要能解释自己：每个节点至少包含摘要、关键属性、episode 和来源引用，使用户知道它为什么出现。第三，边要表达主关系，而不是把所有语义都画成多条线；同一对节点只显示一条可见边，多重语义进入 Inspector。第四，最终产物要和过程图谱互相映射，报告每个章节都能回亮来源节点。这样等待不再只是时间流逝，而是产物逐步生成的可视证明。",
          sourceNodeIds: ["evidence-visible-progress", "observation-graph-process", "claim-process-not-loading"]
        },
        {
          id: "report-implementation",
          title: "三、实现建议：用事件流驱动图谱，而不是用动画伪装进度",
          body:
            "MVP 不需要接真实 LLM，但必须模拟真实 Agent 的执行链路。推荐用 deterministic GraphEvent 驱动：node_added 表示新概念、证据、工具或章节进入图谱；edge_added 表示主语义关系形成；cluster_formed 表示某类信息已经稳定；node_emphasized 表示当前推理焦点。前景 Canvas 只负责绘制节点和单层主边，背景 Canvas 只消费节点和 cluster 位置绘制光雾，避免白线和橙线重复叠加。Inspector 承担深度信息展示，Final Report 承担完整交付物展示。为了保持拖拽流畅，本阶段关闭公转式物理，只保留 d3-force 的碰撞、斥力、cluster anchor 和拖拽回热。",
          sourceNodeIds: ["entity-agent-state", "tool-insightforge", "section-implementation"]
        },
        {
          id: "report-risks",
          title: "四、风险与验收：信息密度必须服务理解",
          body:
            "图谱过程态最大的风险是把信息全部铺在画面上，导致比普通 loading 更难读。验收时应检查四点：桌面和移动端不能横向溢出；放大截图时文字和线条不能糊成一团；节点点击必须能看到真实过程信息；最终报告必须像完整产物，而不是一句总结。视觉上应默认少文字、少边、少粒子，把细节放进 hover、click 和报告映射中。只有当用户能在三十秒内看懂“系统正在把长任务转成结构化产物”，这个 Demo 才真正契合 Agent 长链路等待过程可视化的目标。",
          sourceNodeIds: ["section-principles", "section-implementation", "claim-process-not-loading"]
        }
      ]
    }
  },
  {
    id: "g-028",
    phase: "completed",
    timestamp: 30000,
    message: "任务完成。过程图谱已收束为完整报告。"
  }
];

export function getTimeline(): LoadingEvent[] {
  return timeline;
}

export function getPhaseIndex(phase: LoadingPhase) {
  return phases.findIndex((item) => item.id === phase);
}
