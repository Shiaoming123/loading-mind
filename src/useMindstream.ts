import { useCallback, useEffect, useReducer, useRef } from "react";
import { defaultRunRequest, type CreateRunRequest, type CreateRunResponse } from "./agentProtocol";
import { getTimeline } from "./demoData";
import { initialState, mindstreamReducer } from "./mindstreamReducer";
import type { AgentEvent, AgentRun } from "./types";

function recordedEvent(run: AgentRun, index: number): AgentEvent {
  const event = getTimeline()[index];
  return {
    id: `recorded-${event.id}`,
    runId: run.id,
    type: event.phase === "completed" ? "run_completed" : event.graphEvent?.type === "node_added" ? "node_added" : "observation_added",
    phase: event.phase,
    elapsedMs: event.timestamp,
    message: event.message,
    graphEvent: event.graphEvent,
    finalReport: event.finalReport
  };
}

function fallbackRun(request: CreateRunRequest): AgentRun {
  const now = Date.now();
  const key = request.providerConfig.apiKey.trim();
  return {
    id: `recorded-${now}`,
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
      apiKeyMasked: key ? `${key.slice(0, 6)}...${key.slice(-3)}` : ""
    },
    status: "running",
    createdAt: now,
    updatedAt: now
  };
}

async function readServerEventStream(
  response: Response,
  handlers: {
    onRun: (run: AgentRun) => void;
    onEvent: (event: AgentEvent) => void;
  }
) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Run stream response did not include a readable body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const processBlock = (block: string) => {
    const lines = block.split(/\r?\n/);
    const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) {
      return;
    }
    const payload = JSON.parse(data) as { run?: AgentRun } | AgentEvent;
    if (eventName === "run-created" && "run" in payload && payload.run) {
      handlers.onRun(payload.run);
    } else if (eventName === "agent-event") {
      handlers.onEvent(payload as AgentEvent);
    } else if (eventName === "run-error" && "error" in payload) {
      throw new Error(String(payload.error || "Run stream failed."));
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      let separatorIndex = buffer.search(/\r?\n\r?\n/);
      while (separatorIndex !== -1) {
        const block = buffer.slice(0, separatorIndex);
        const match = buffer.slice(separatorIndex).match(/^\r?\n\r?\n/);
        buffer = buffer.slice(separatorIndex + (match?.[0].length ?? 2));
        processBlock(block);
        separatorIndex = buffer.search(/\r?\n\r?\n/);
      }
    }
    if (done) {
      break;
    }
  }
  const trailing = buffer.trim();
  if (trailing) {
    processBlock(trailing);
  }
}

export function useMindstream() {
  const [state, dispatch] = useReducer(mindstreamReducer, initialState);
  const eventSourceRef = useRef<EventSource | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  const replayTimerRefs = useRef<number[]>([]);
  const fallbackRunRef = useRef<AgentRun | null>(null);

  const closeEventSource = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const clearFallback = useCallback(() => {
    if (fallbackTimerRef.current) {
      window.clearInterval(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    for (const timer of replayTimerRefs.current) {
      window.clearTimeout(timer);
    }
    replayTimerRefs.current = [];
    fallbackRunRef.current = null;
  }, []);

  const startRecordedFallback = useCallback(
    (request: CreateRunRequest) => {
      closeEventSource();
      clearFallback();
      const run = fallbackRun(request);
      fallbackRunRef.current = run;
      dispatch({ type: "START", run });

      const origin = performance.now();
      const applied = new Set<string>();
      fallbackTimerRef.current = window.setInterval(() => {
        const elapsed = performance.now() - origin;
        dispatch({ type: "TICK", elapsed });

        getTimeline().forEach((event, index) => {
          if (event.timestamp <= elapsed && !applied.has(event.id)) {
            applied.add(event.id);
            dispatch({ type: "APPLY_AGENT_EVENT", event: recordedEvent(run, index) });
          }
        });

        if (applied.size === getTimeline().length) {
          clearFallback();
        }
      }, 80);
    },
    [clearFallback, closeEventSource]
  );

  const replayServerEvents = useCallback(
    (run: AgentRun, events: AgentEvent[]) => {
      closeEventSource();
      clearFallback();
      dispatch({ type: "START", run: { ...run, status: "running" } });

      const sortedEvents = [...events].sort((left, right) => left.elapsedMs - right.elapsedMs);
      const maxElapsed = Math.max(...sortedEvents.map((event) => event.elapsedMs), 1);
      const scale = maxElapsed > 18000 ? 18000 / maxElapsed : 1;
      replayTimerRefs.current = sortedEvents.map((event) =>
        window.setTimeout(() => {
          dispatch({ type: "TICK", elapsed: event.elapsedMs });
          dispatch({ type: "APPLY_AGENT_EVENT", event });
        }, Math.max(0, event.elapsedMs * scale))
      );
    },
    [clearFallback, closeEventSource]
  );

  const subscribeToRun = useCallback(
    (run: AgentRun, request: CreateRunRequest) => {
      closeEventSource();
      clearFallback();

      const source = new EventSource(`/api/runs/${run.id}/events`);
      eventSourceRef.current = source;

      source.addEventListener("agent-event", (event) => {
        dispatch({ type: "APPLY_AGENT_EVENT", event: JSON.parse((event as MessageEvent).data) as AgentEvent });
      });
      source.addEventListener("run-closed", () => {
        source.close();
        eventSourceRef.current = null;
      });
      source.onerror = () => {
        source.close();
        eventSourceRef.current = null;
        if (state.agentEvents.length === 0 && request.runMode === "demo") {
          startRecordedFallback(request);
        } else if (state.agentEvents.length === 0) {
          dispatch({ type: "FAIL", error: "Live event stream failed before receiving runtime events." });
        }
      };
    },
    [clearFallback, closeEventSource, startRecordedFallback, state.agentEvents.length]
  );

  const submitTask = useCallback(
    async (request: CreateRunRequest = defaultRunRequest()) => {
      closeEventSource();
      clearFallback();
      dispatch({ type: "BEGIN_SUBMIT", request });

      try {
        const response = await fetch("/api/runs", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "X-Loading-Mind-Delivery": "stream"
          },
          body: JSON.stringify(request)
        });

        if (!response.ok) {
          const text = await response.text();
          let message = `Run service returned ${response.status}`;
          if (text) {
            try {
              const payload = JSON.parse(text) as { error?: string; message?: string };
              message = payload.error || payload.message || message;
            } catch {
              message = text;
            }
          }
          throw new Error(message);
        }

        const contentType = response.headers.get("Content-Type") || "";
        if (contentType.includes("text/event-stream")) {
          await readServerEventStream(response, {
            onRun: (run) => dispatch({ type: "START", run }),
            onEvent: (event) => dispatch({ type: "APPLY_AGENT_EVENT", event })
          });
          return;
        }

        const payload = (await response.json()) as CreateRunResponse;
        if (payload.events?.length) {
          replayServerEvents(payload.run, payload.events);
        } else {
          dispatch({ type: "START", run: payload.run });
          subscribeToRun(payload.run, request);
        }
      } catch (error) {
        if (request.runMode === "demo") {
          startRecordedFallback(request);
        } else {
          dispatch({
            type: "FAIL",
            error: error instanceof Error ? error.message : "Live run service failed before creating a run."
          });
        }
      }
    },
    [clearFallback, closeEventSource, replayServerEvents, startRecordedFallback, subscribeToRun]
  );

  const commandRun = useCallback(
    async (command: "pause" | "resume" | "cancel") => {
      if (!state.run) {
        return;
      }

      await fetch(`/api/runs/${state.run.id}/${command}`, { method: "POST" }).catch(() => undefined);
      if (command === "pause") {
        dispatch({ type: "PAUSE" });
      } else if (command === "resume") {
        dispatch({ type: "RESUME" });
      } else {
        dispatch({ type: "CANCEL" });
        closeEventSource();
      }
    },
    [closeEventSource, state.run]
  );

  const replay = useCallback(() => {
    submitTask(state.run ? {
      question: state.run.question,
      scope: state.run.scope,
      depth: state.run.depth,
      sources: state.run.sources,
      runMode: state.run.runMode ?? "demo",
      providerConfig: defaultRunRequest().providerConfig
    } : defaultRunRequest());
  }, [state.run, submitTask]);

  const retryTool = useCallback(
    async (toolNodeId: string) => {
      if (!state.run) {
        return;
      }
      const response = await fetch(`/api/runs/${state.run.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolNodeId })
      });
      const text = await response.text();
      let payload: { message?: string; error?: string } = {};
      if (text) {
        try {
          payload = JSON.parse(text) as { message?: string; error?: string };
        } catch {
          payload = { message: text };
        }
      }
      if (!response.ok) {
        throw new Error(payload.error || payload.message || `Retry returned ${response.status}`);
      }
      return payload;
    },
    [state.run]
  );

  const excludeEvidence = useCallback(
    async (evidenceId: string) => {
      dispatch({ type: "EXCLUDE_EVIDENCE", evidenceId });
      if (!state.run) {
        return;
      }
      await fetch(`/api/runs/${state.run.id}/exclude`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evidenceId })
      }).catch(() => undefined);
    },
    [state.run]
  );

  const reset = useCallback(() => {
    const runId = state.run?.id;
    closeEventSource();
    clearFallback();
    if (runId && (state.status === "running" || state.status === "queued" || state.status === "paused")) {
      fetch(`/api/runs/${runId}/cancel`, { method: "POST" }).catch(() => undefined);
    }
    dispatch({ type: "RESET" });
  }, [clearFallback, closeEventSource, state.run?.id, state.status]);

  useEffect(() => () => {
    closeEventSource();
    clearFallback();
  }, [clearFallback, closeEventSource]);

  return {
    state,
    submitTask,
    pause: () => commandRun("pause"),
    resume: () => commandRun("resume"),
    cancel: () => commandRun("cancel"),
    replay,
    reset,
    retryTool,
    excludeEvidence
  };
}
