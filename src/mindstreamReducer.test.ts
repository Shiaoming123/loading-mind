import { describe, expect, it } from "vitest";
import { defaultRunRequest } from "./agentProtocol";
import { getTimeline } from "./demoData";
import { initialState, mindstreamReducer } from "./mindstreamReducer";
import type { AgentRun } from "./types";

const run: AgentRun = {
  id: "run-test",
  question: "Question",
  scope: "Scope",
  depth: "standard",
  sources: ["web_search"],
  status: "running",
  createdAt: 1,
  updatedAt: 1
};

describe("mindstreamReducer", () => {
  it("enters queued state with an immediate explainable seed graph", () => {
    const queued = mindstreamReducer(initialState, {
      type: "BEGIN_SUBMIT",
      request: {
        ...defaultRunRequest(),
        question: "社区咖啡机器人怎么落地？",
        scope: "商业选址和运营验证"
      }
    });

    expect(queued.status).toBe("queued");
    expect(queued.phase).toBe("initializing");
    expect(queued.run).toBeNull();
    expect(queued.graphNodes.map((node) => node.id)).toEqual(["task-intent", "ontology-runtime", "research-plan"]);
    expect(queued.graphEdges.map((edge) => edge.id)).toEqual(["edge-task-ontology", "edge-ontology-plan"]);
    expect(queued.formedClusters).toEqual(["intent", "ontology", "plan"]);
    expect(queued.graphNodes[0].summary).toBe("社区咖啡机器人怎么落地？");
    expect(queued.graphNodes[2].summary).toContain("社区咖啡机器人怎么落地？");
  });

  it("preserves the seed graph when the created run starts before events stream in", () => {
    const queued = mindstreamReducer(initialState, { type: "BEGIN_SUBMIT", request: defaultRunRequest() });
    const started = mindstreamReducer(queued, { type: "START", run });

    expect(started.status).toBe("running");
    expect(started.run).toBe(run);
    expect(started.graphNodes.map((node) => node.id)).toEqual(["task-intent", "ontology-runtime", "research-plan"]);
  });

  it("starts from idle and applies a graph event once", () => {
    const running = mindstreamReducer(initialState, { type: "START", run });
    const withOntology = mindstreamReducer(running, {
      type: "APPLY_EVENT",
      event: {
        id: "ontology",
        phase: "ontology",
        timestamp: 2000,
        message: "ontology",
        graphEvent: {
          type: "node_added",
          node: {
            id: "ontology-schema",
            kind: "ontology",
            label: "Ontology"
          }
        }
      }
    });

    expect(withOntology.status).toBe("running");
    expect(withOntology.phase).toBe("ontology");
    expect(withOntology.events).toHaveLength(1);
    expect(withOntology.graphNodes).toHaveLength(1);

    const duplicate = mindstreamReducer(withOntology, {
      type: "APPLY_EVENT",
      event: {
        id: "ontology",
        phase: "ontology",
        timestamp: 2000,
        message: "ontology"
      }
    });

    expect(duplicate.events).toHaveLength(1);
  });

  it("collects thinking checkpoints from agent events without duplicates", () => {
    const running = mindstreamReducer(initialState, { type: "START", run });
    const checkpoint = {
      id: "checkpoint-search",
      phase: "graph_build" as const,
      title: "Live Brief：搜索方向已收束",
      summary: "已保留候选来源。",
      knownFacts: ["Source A"],
      openQuestions: ["Need benchmark?"],
      nextAction: "读取来源正文。",
      sourceNodeIds: ["source-1"],
      createdAt: 1
    };
    const withCheckpoint = mindstreamReducer(running, {
      type: "APPLY_AGENT_EVENT",
      event: {
        id: "checkpoint-event",
        runId: run.id,
        type: "checkpoint_created",
        phase: "graph_build",
        elapsedMs: 1000,
        message: "checkpoint",
        checkpoint
      }
    });
    const duplicate = mindstreamReducer(withCheckpoint, {
      type: "APPLY_AGENT_EVENT",
      event: {
        id: "checkpoint-event",
        runId: run.id,
        type: "checkpoint_created",
        phase: "graph_build",
        elapsedMs: 1000,
        message: "checkpoint",
        checkpoint
      }
    });

    expect(withCheckpoint.checkpoints).toEqual([checkpoint]);
    expect(duplicate.checkpoints).toHaveLength(1);
  });

  it("pauses and resumes only while running", () => {
    const running = mindstreamReducer(initialState, { type: "START", run });
    const paused = mindstreamReducer(running, { type: "PAUSE" });
    const resumed = mindstreamReducer(paused, { type: "RESUME" });

    expect(paused.status).toBe("paused");
    expect(resumed.status).toBe("running");
    expect(mindstreamReducer(initialState, { type: "PAUSE" }).status).toBe("idle");
  });

  it("replay clears graph state", () => {
    const replayed = mindstreamReducer(
      {
        ...initialState,
        status: "completed",
        graphNodes: [{ id: "task-brief", kind: "task_intent", label: "Intent" }],
        graphEdges: [{ id: "edge", from: "task-brief", to: "task-brief", kind: "supports" }],
        formedClusters: ["intent"],
        emphasizedNodeId: "task-brief"
      },
      { type: "REPLAY" }
    );

    expect(replayed.status).toBe("running");
    expect(replayed.graphNodes).toHaveLength(0);
    expect(replayed.graphEdges).toHaveLength(0);
    expect(replayed.formedClusters).toHaveLength(0);
    expect(replayed.emphasizedNodeId).toBeNull();
  });

  it("reset returns to the initial idle state", () => {
    const reset = mindstreamReducer(
      {
        ...initialState,
        status: "failed",
        run,
        phase: "drafting",
        elapsed: 12000,
        events: [{
          id: "event",
          phase: "drafting",
          timestamp: 12000,
          message: "event"
        }],
        graphNodes: [{ id: "task-brief", kind: "task_intent", label: "Intent" }],
        graphEdges: [{ id: "edge", from: "task-brief", to: "task-brief", kind: "supports" }],
        formedClusters: ["intent"],
        finalReport: {
          id: "report",
          kind: "final",
          title: "Report",
          body: "Report body"
        },
        error: "failed"
      },
      { type: "RESET" }
    );

    expect(reset).toEqual(initialState);
  });

  it("collects graph nodes, edges, clusters, and final report", () => {
    const running = mindstreamReducer(initialState, { type: "START", run });
    const withNode = mindstreamReducer(running, {
      type: "APPLY_EVENT",
      event: {
        id: "node",
        phase: "drafting",
        timestamp: 20000,
        message: "node",
        graphEvent: {
          type: "node_added",
          node: {
            id: "section-problem",
            kind: "section",
            label: "Section",
            x: 50,
            y: 50
          }
        }
      }
    });
    const withEdge = mindstreamReducer(withNode, {
      type: "APPLY_EVENT",
      event: {
        id: "edge",
        phase: "drafting",
        timestamp: 21000,
        message: "edge",
        graphEvent: {
          type: "edge_added",
          edge: {
            id: "edge",
            from: "section-problem",
            to: "section-problem",
            kind: "becomes_section"
          }
        }
      }
    });
    const withCluster = mindstreamReducer(withEdge, {
      type: "APPLY_EVENT",
      event: {
        id: "cluster",
        phase: "drafting",
        timestamp: 22000,
        message: "cluster",
        graphEvent: {
          type: "cluster_formed",
          cluster: "report"
        }
      }
    });
    const completed = mindstreamReducer(withCluster, {
      type: "APPLY_EVENT",
      event: {
        id: "done",
        phase: "completed",
        timestamp: 30000,
        message: "done",
        finalReport: {
          id: "final",
          kind: "final",
          title: "Final",
          body: "Body"
        }
      }
    });

    expect(withNode.graphNodes).toHaveLength(1);
    expect(withEdge.graphEdges).toHaveLength(1);
    expect(withCluster.formedClusters).toEqual(["report"]);
    expect(completed.status).toBe("completed");
    expect(completed.phase).toBe("completed");
    expect(completed.finalReport?.title).toBe("Final");
  });

  it("timeline has no checkpoint and completes automatically", () => {
    const timeline = getTimeline();
    expect(timeline.some((event) => event.phase === "completed")).toBe(true);
    expect(timeline.some((event) => event.graphEvent?.type === "node_emphasized")).toBe(false);
    expect(timeline.map((event) => event.phase)).not.toContain("checkpoint");
    expect(timeline.find((event) => event.finalReport)?.finalReport?.sections?.length).toBeGreaterThan(3);
  });

  it("applies agent events, updates nodes, and excludes evidence", () => {
    const running = mindstreamReducer(initialState, { type: "START", run });
    const withEvidence = mindstreamReducer(running, {
      type: "APPLY_AGENT_EVENT",
      event: {
        id: "agent-evidence",
        runId: run.id,
        type: "node_added",
        phase: "evidence",
        elapsedMs: 1000,
        message: "evidence",
        graphEvent: {
          type: "node_added",
          node: {
            id: "evidence-1",
            kind: "evidence",
            label: "Evidence",
            status: "observed",
            evidence: {
              id: "evidence-1",
              title: "Evidence",
              quote: "Quote",
              source: "Source",
              confidence: 0.8,
              capturedAt: 1
            }
          }
        }
      }
    });
    const updated = mindstreamReducer(withEvidence, {
      type: "APPLY_AGENT_EVENT",
      event: {
        id: "agent-update",
        runId: run.id,
        type: "node_updated",
        phase: "evidence",
        elapsedMs: 1200,
        message: "updated",
        graphEvent: {
          type: "node_updated",
          node: {
            id: "evidence-1",
            kind: "evidence",
            label: "Evidence",
            status: "failed"
          }
        }
      }
    });
    const excluded = mindstreamReducer(updated, { type: "EXCLUDE_EVIDENCE", evidenceId: "evidence-1" });

    expect(withEvidence.agentEvents).toHaveLength(1);
    expect(updated.graphNodes).toHaveLength(1);
    expect(updated.graphNodes[0].status).toBe("failed");
    expect(excluded.excludedEvidenceIds).toEqual(["evidence-1"]);
    expect(excluded.graphNodes[0].status).toBe("excluded");
  });

  it("records provider tool nodes and final report sections from agent events", () => {
    const running = mindstreamReducer(initialState, { type: "START", run });
    const withProviderTool = mindstreamReducer(running, {
      type: "APPLY_AGENT_EVENT",
      event: {
        id: "llm-tool",
        runId: run.id,
        type: "node_added",
        phase: "reasoning",
        elapsedMs: 1800,
        message: "llm",
        graphEvent: {
          type: "node_added",
          node: {
            id: "llm_analyze-1",
            kind: "tool_call",
            label: "LLM Analyze",
            status: "observed",
            toolCall: {
              id: "llm_analyze-1",
              toolName: "llm_analyze",
              input: { model: "mimo-v2.5-pro" },
              outputSummary: "Provider analysis ok",
              startedAt: 1,
              endedAt: 2,
              status: "succeeded",
              costMs: 1
            }
          }
        }
      }
    });
    const completed = mindstreamReducer(withProviderTool, {
      type: "APPLY_AGENT_EVENT",
      event: {
        id: "provider-report",
        runId: run.id,
        type: "run_completed",
        phase: "completed",
        elapsedMs: 3000,
        message: "done",
        finalReport: {
          id: "report",
          kind: "final",
          title: "Provider report",
          body: "Report body",
          sections: [{
            id: "section-context",
            title: "Context",
            body: "Section body",
            sourceNodeIds: ["llm_analyze-1"]
          }]
        }
      }
    });

    expect(withProviderTool.graphNodes[0].toolCall?.toolName).toBe("llm_analyze");
    expect(completed.status).toBe("completed");
    expect(completed.finalReport?.sections?.[0].sourceNodeIds).toEqual(["llm_analyze-1"]);
  });

  it("marks run_failed as failed, stores the error, and keeps failed tool nodes", () => {
    const running = mindstreamReducer(initialState, { type: "START", run });
    const withFailedTool = mindstreamReducer(running, {
      type: "APPLY_AGENT_EVENT",
      event: {
        id: "web-search-failed",
        runId: run.id,
        type: "node_updated",
        phase: "evidence",
        elapsedMs: 1200,
        message: "Web Search failed",
        graphEvent: {
          type: "node_updated",
          node: {
            id: "web_search-1",
            kind: "tool_call",
            label: "Web Search",
            status: "failed",
            toolCall: {
              id: "web_search-1",
              toolName: "web_search",
              input: { query: "Question" },
              startedAt: 1,
              endedAt: 2,
              status: "failed",
              error: "Search HTTP 500",
              outputSummary: "工具调用失败，已把失败状态写入图谱，可重试。"
            }
          }
        }
      }
    });
    const failed = mindstreamReducer(withFailedTool, {
      type: "APPLY_AGENT_EVENT",
      event: {
        id: "run-failed",
        runId: run.id,
        type: "run_failed",
        phase: "evidence",
        elapsedMs: 1300,
        message: "Run 执行失败：Web Search failed: Search HTTP 500",
        error: "Web Search failed: Search HTTP 500"
      }
    });

    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Web Search failed: Search HTTP 500");
    expect(failed.graphNodes).toHaveLength(1);
    expect(failed.graphNodes[0].toolCall?.status).toBe("failed");
  });
});
