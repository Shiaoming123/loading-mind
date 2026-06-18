import type { AgentEvent, AgentRun, LoadingEvent, ProviderConfig, RunErrorLog, RunMode } from "./types";

export type CreateRunRequest = {
  question: string;
  scope: string;
  depth: AgentRun["depth"];
  sources: string[];
  runMode: RunMode;
  tavilyApiKey?: string;
  braveApiKey?: string;
  firecrawlApiKey?: string;
  exaApiKey?: string;
  providerConfig: ProviderConfig;
  researchMode?: "demo_deep_research";
  sourceBudget?: number;
  visualization?: "auto";
};

export type CreateRunResponse = {
  run: AgentRun;
  events?: AgentEvent[];
  errorLogs?: RunErrorLog[];
  delivery?: "sse" | "snapshot";
};

export function agentEventToLoadingEvent(event: AgentEvent): LoadingEvent {
  return {
    id: event.id,
    phase: event.phase,
    timestamp: event.elapsedMs,
    message: event.message,
    graphEvent: event.graphEvent,
    checkpoint: event.checkpoint,
    finalReport: event.finalReport
  };
}

export function defaultRunRequest(): CreateRunRequest {
  return {
    question: "我想学习 LLM 和 AI Agent 的相关知识，请生成一份深度研究报告。",
    scope: "面向 AI Product Builder 面试 Demo，强调真实工具调用、过程图谱和最终报告映射。",
    depth: "standard",
    sources: ["web_search", "web_fetch", "document_read"],
    runMode: "demo",
    tavilyApiKey: "",
    braveApiKey: "",
    firecrawlApiKey: "",
    exaApiKey: "",
    researchMode: "demo_deep_research",
    sourceBudget: 12,
    visualization: "auto",
    providerConfig: {
      protocol: "openai",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      anthropicBaseUrl: "",
      apiKey: "",
      model: "deepseek-v4-flash",
      temperature: 0.35,
      maxTokens: 16000
    }
  };
}
