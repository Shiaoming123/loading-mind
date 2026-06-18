import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRunRequest } from "./agentProtocol";
import { useMindstream } from "./useMindstream";

describe("useMindstream run modes", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("plays the recorded fallback only for Demo requests", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useMindstream());

    await act(async () => {
      await result.current.submitTask({ ...defaultRunRequest(), runMode: "demo" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    expect(result.current.state.run?.id).toMatch(/^recorded-/);
    expect(result.current.state.events.length).toBeGreaterThan(0);
  });

  it("fails Live requests instead of silently replaying the recorded fallback", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useMindstream());

    await act(async () => {
      await result.current.submitTask({ ...defaultRunRequest(), runMode: "live" });
    });
    act(() => {
      vi.advanceTimersByTime(1200);
    });

    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.run?.id ?? "").not.toMatch(/^recorded-/);
    expect(result.current.state.events).toHaveLength(0);
    expect(result.current.state.graphNodes.map((node) => node.id)).toEqual(["task-intent", "ontology-runtime", "research-plan"]);
    expect(result.current.state.error).toBe("offline");
  });

  it("applies streamed run events as they arrive", async () => {
    const request = { ...defaultRunRequest(), runMode: "live" as const };
    const run = {
      id: "run-stream",
      question: request.question,
      scope: request.scope,
      depth: request.depth,
      sources: request.sources,
      runMode: request.runMode,
      provider: {
        protocol: request.providerConfig.protocol,
        baseUrl: request.providerConfig.baseUrl,
        anthropicBaseUrl: request.providerConfig.anthropicBaseUrl,
        model: request.providerConfig.model,
        temperature: request.providerConfig.temperature,
        maxTokens: request.providerConfig.maxTokens,
        apiKeyMasked: ""
      },
      status: "running" as const,
      createdAt: 1,
      updatedAt: 1
    };
    const event = {
      id: "event-1",
      runId: run.id,
      type: "node_added" as const,
      phase: "graph_build" as const,
      elapsedMs: 10,
      message: "LLM search decision streamed.",
      graphEvent: {
        type: "node_added" as const,
        node: {
          id: "agent-search-decision-1",
          kind: "observation" as const,
          label: "LLM 搜索判断 1",
          summary: "模型决定下一次 Tavily query。",
          status: "observed" as const,
          cluster: "search" as const
        }
      }
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`event: run-created\ndata: ${JSON.stringify({ run, delivery: "stream" })}\n\n`));
        controller.enqueue(encoder.encode(`event: agent-event\ndata: ${JSON.stringify(event)}\n\n`));
        controller.enqueue(encoder.encode(`event: run-closed\ndata: ${JSON.stringify({ run, delivery: "stream" })}\n\n`));
        controller.close();
      }
    });
    globalThis.fetch = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" }
    })) as unknown as typeof fetch;

    const { result } = renderHook(() => useMindstream());

    await act(async () => {
      await result.current.submitTask(request);
    });

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/runs", expect.objectContaining({
      headers: expect.objectContaining({
        Accept: "text/event-stream",
        "X-Loading-Mind-Delivery": "stream"
      })
    }));
    expect(result.current.state.run?.id).toBe("run-stream");
    expect(result.current.state.events).toHaveLength(1);
    expect(result.current.state.graphNodes.map((node) => node.id)).toContain("agent-search-decision-1");
  });
});
