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

export function useMindstream() {
  const [state, dispatch] = useReducer(mindstreamReducer, initialState);
  const eventSourceRef = useRef<EventSource | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
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
        if (state.agentEvents.length === 0) {
          startRecordedFallback(request);
        }
      };
    },
    [clearFallback, closeEventSource, startRecordedFallback, state.agentEvents.length]
  );

  const submitTask = useCallback(
    async (request: CreateRunRequest = defaultRunRequest()) => {
      closeEventSource();
      clearFallback();

      try {
        const response = await fetch("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request)
        });

        if (!response.ok) {
          throw new Error(`Run service returned ${response.status}`);
        }

        const payload = (await response.json()) as CreateRunResponse;
        dispatch({ type: "START", run: payload.run });
        subscribeToRun(payload.run, request);
      } catch {
        startRecordedFallback(request);
      }
    },
    [clearFallback, closeEventSource, startRecordedFallback, subscribeToRun]
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
      providerConfig: defaultRunRequest().providerConfig
    } : defaultRunRequest());
  }, [state.run, submitTask]);

  const retryTool = useCallback(
    async (toolNodeId: string) => {
      if (!state.run) {
        return;
      }
      await fetch(`/api/runs/${state.run.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolNodeId })
      }).catch(() => undefined);
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
    retryTool,
    excludeEvidence
  };
}
