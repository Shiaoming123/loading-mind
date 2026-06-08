import type { AgentEvent, AgentRun, LoadingEvent, ProviderConfig } from "./types";

export type CreateRunRequest = {
  question: string;
  scope: string;
  depth: AgentRun["depth"];
  sources: string[];
  providerConfig: ProviderConfig;
  researchMode?: "demo_deep_research";
  sourceBudget?: number;
  visualization?: "auto";
};

export type CreateRunResponse = {
  run: AgentRun;
  events?: AgentEvent[];
  delivery?: "sse" | "snapshot";
};

export function agentEventToLoadingEvent(event: AgentEvent): LoadingEvent {
  return {
    id: event.id,
    phase: event.phase,
    timestamp: event.elapsedMs,
    message: event.message,
    graphEvent: event.graphEvent,
    finalReport: event.finalReport
  };
}

export function defaultRunRequest(): CreateRunRequest {
  return {
    question: "AI Agent 长链路等待过程如何设计成可检查、可追溯、可交互的过程体验？",
    scope: "面向 AI Product Builder 面试 Demo，强调真实工具调用、过程图谱和最终报告映射。",
    depth: "standard",
    sources: ["web_search", "web_fetch", "document_read"],
    researchMode: "demo_deep_research",
    sourceBudget: 12,
    visualization: "auto",
    providerConfig: {
      protocol: "openai",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      anthropicBaseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
      apiKey: "",
      model: "mimo-v2.5-pro",
      temperature: 0.35,
      maxTokens: 1408
    }
  };
}
