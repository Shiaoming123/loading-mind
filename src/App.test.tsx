import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { initialState } from "./mindstreamReducer";
import type { MindstreamState } from "./types";

let mockedState: MindstreamState;
let graphProps: Record<string, unknown> = {};
let submitTaskMock = vi.fn();
let resetMock = vi.fn();
let retryToolMock = vi.fn();

function installLocalStorageStub() {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value)
    }
  });
}

vi.mock("./MindstreamCanvas", () => ({
  MindstreamCanvas: () => <div data-testid="mindstream-canvas" />
}));

vi.mock("./ForceNebulaGraph", () => ({
  ForceNebulaGraph: (props: Record<string, unknown>) => {
    graphProps = props;
    return <div data-testid="force-graph" />;
  }
}));

vi.mock("./useMindstream", () => ({
  useMindstream: () => ({
    state: mockedState,
    submitTask: submitTaskMock,
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    reset: resetMock,
    retryTool: retryToolMock,
    excludeEvidence: vi.fn()
  })
}));

function completedState(): MindstreamState {
  return {
    ...initialState,
    status: "completed",
    run: {
      id: "run-test",
      question: "Question",
      scope: "Scope",
      depth: "standard",
      sources: ["web_search"],
      runMode: "demo",
      status: "completed",
      createdAt: 1,
      updatedAt: 2
    },
    finalReport: {
      id: "report-test",
      kind: "final",
      title: "Report title",
      body: "## Summary\n\nReport body",
      quality: {
        score: 100,
        passed: true,
        issues: [],
        repairSuggestions: [],
        dimensions: [
          { id: "answers-topic", label: "直接回答主题", passed: true },
          { id: "action-advice", label: "包含行动建议", passed: true }
        ]
      },
      sourceLabelMap: {
        "source-2": "Mapped block source",
        "evidence-1": "Readable evidence source"
      },
      sections: [{
        id: "section-one",
        title: "Section one",
        body: "Section body",
        sourceNodeIds: ["source-1"]
      }],
      blocks: [{
        id: "block-one",
        type: "markdown",
        title: "Markdown block",
        body: "- item",
        sourceNodeIds: ["source-2"]
      }, {
        id: "visual-claim-graph",
        type: "claim_graph",
        title: "Claim graph",
        nodes: [{ id: "claim-1", label: "成本与额度约束会影响高频工程使用", kind: "claim" }],
        edges: [{ from: "evidence-1", to: "claim-1", kind: "supports" }],
        claims: [{
          id: "claim-1",
          label: "成本与额度约束会影响高频工程使用",
          reviewState: "source-linked",
          sourceCount: 1,
          confidence: 0.86,
          evidenceIds: ["evidence-1"],
          sourceTitles: ["Readable evidence source"]
        }],
        evidence: [{
          id: "evidence-1",
          title: "Evidence",
          sourceTitle: "Readable evidence source",
          quote: "成本和额度会影响高频使用。"
        }],
        sourceNodeIds: ["claim-1", "evidence-1"]
      }]
    },
    graphNodes: [{
      id: "source-1",
      kind: "source",
      label: "Readable section source"
    }, {
      id: "source-2",
      kind: "source",
      label: "Raw block source"
    }, {
      id: "evidence-1",
      kind: "evidence",
      label: "Raw evidence source"
    }],
    checkpoints: [{
      id: "checkpoint-search",
      phase: "graph_build",
      title: "Live Brief：搜索方向已收束",
      summary: "已保留候选来源。",
      knownFacts: ["Readable section source：候选材料"],
      openQuestions: ["还缺行动建议？"],
      nextAction: "读取来源正文。",
      sourceNodeIds: ["source-1"],
      createdAt: 1
    }]
  };
}

function failedState(): MindstreamState {
  return {
    ...initialState,
    status: "failed",
    phase: "drafting",
    error: "Report Write failed: Invalid API Key",
    run: {
      id: "run-failed",
      question: "Question",
      scope: "Scope",
      depth: "standard",
      sources: ["web_search"],
      runMode: "live",
      status: "failed",
      createdAt: 1,
      updatedAt: 2
    },
    errorLogs: [{
      runId: "run-failed",
      mode: "live",
      phase: "drafting",
      toolName: "report_write",
      toolCallId: "report_write-1",
      provider: "openai",
      errorType: "auth",
      message: "Invalid API Key",
      redactedInputSummary: "{}",
      retryable: false,
      nextAction: "Check the configured key, base URL, model, and provider permissions.",
      createdAt: 3
    }],
    finalReport: {
      id: "failure-report-run-failed",
      kind: "failure",
      title: "Run failed: auth",
      body: "Run failed because the provider key is invalid.",
      sections: [{
        id: "failure-summary",
        title: "Failure summary",
        body: "Check the configured key, base URL, model, and provider permissions.",
        sourceNodeIds: ["report_write-1"]
      }],
      blocks: [{
        id: "failure-log",
        type: "table",
        title: "Run error log",
        columns: ["field", "value"],
        rows: [{ field: "errorType", value: "auth" }],
        sourceNodeIds: ["report_write-1"]
      }]
    }
  };
}

function retryableFailedState(): MindstreamState {
  return {
    ...failedState(),
    errorLogs: [{
      ...failedState().errorLogs[0],
      errorType: "tool_failed",
      retryable: true,
      toolCallId: "search-1",
      nextAction: "Retry the failed search branch."
    }]
  };
}

describe("App shell", () => {
  beforeEach(() => {
    installLocalStorageStub();
    window.localStorage.clear();
    graphProps = {};
    submitTaskMock = vi.fn();
    resetMock = vi.fn();
    retryToolMock = vi.fn();
    mockedState = { ...initialState };
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render removed System mode or particle controls", () => {
    render(<App />);

    expect(screen.queryByRole("button", { name: /System/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Enable particles|Disable particles/i })).not.toBeInTheDocument();
    expect(graphProps).not.toHaveProperty("particlesEnabled");
    expect(graphProps).not.toHaveProperty("visualMode");
  });

  it("renders the completed report drawer and focuses source nodes from the toc", () => {
    mockedState = completedState();
    render(<App />);

    expect(screen.getByLabelText("Final report drawer")).toBeInTheDocument();
    expect(screen.getByText("Report title")).toBeInTheDocument();
    expect(screen.getByLabelText("Report table of contents")).toBeInTheDocument();
    expect(screen.getByLabelText("Report Quality")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();

    fireEvent.click(within(screen.getByLabelText("Report table of contents")).getByRole("button", { name: "Section one" }));

    expect(graphProps.reportFocusNodeId).toBe("source-1");
  });

  it("does not render markdown images inside final report text", () => {
    mockedState = completedState();
    mockedState.finalReport = {
      ...mockedState.finalReport!,
      body: "## Summary\n\n结论正文\n\n![Huge source image](https://example.com/image.png)"
    };
    render(<App />);

    expect(screen.getByText("结论正文")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Huge source image/i })).not.toBeInTheDocument();
  });

  it("renders collapsed structured previews with readable source labels and focuses preview sources", () => {
    mockedState = completedState();
    render(<App />);

    const preview = screen.getByLabelText("Collapsed report preview");
    expect(within(preview).getByText("Report sections")).toBeInTheDocument();
    expect(within(preview).getByText("Traceability appendices")).toBeInTheDocument();
    expect(within(preview).getByText("Report sections").compareDocumentPosition(within(preview).getByText("Traceability appendices")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(preview).getByText("Mapped block source")).toBeInTheDocument();
    expect(within(preview).getByText("Readable section source")).toBeInTheDocument();
    expect(within(preview).queryByText(/source-1|source-2/)).not.toBeInTheDocument();

    fireEvent.click(within(preview).getByRole("button", { name: /Markdown block/i }));
    expect(graphProps.reportFocusNodeId).toBe("source-2");

    fireEvent.click(within(preview).getByRole("button", { name: /Section one/i }));
    expect(graphProps.reportFocusNodeId).toBe("source-1");
  });

  it("renders readable claim graph cards instead of raw edge ids", () => {
    mockedState = completedState();
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Expand report" }));

    expect(screen.getByText("Source-linked")).toBeInTheDocument();
    expect(screen.getByText("成本与额度约束会影响高频工程使用")).toBeInTheDocument();
    expect(screen.getByText("Readable evidence source")).toBeInTheDocument();
    expect(screen.queryByText(/evidence-1\s*->\s*claim-1/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /成本与额度约束/ }));
    expect(graphProps.reportFocusNodeId).toBe("evidence-1");
  });

  it("exports reports from browser state instead of the missing deployed export route", () => {
    mockedState = completedState();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const createObjectUrl = vi.fn(() => "blob:loading-mind-report");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    const printDocument = { open: vi.fn(), write: vi.fn(), close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockReturnValue({ document: printDocument } as unknown as Window);

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Export markdown" }));
    fireEvent.click(screen.getByRole("button", { name: "Export Word" }));
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));

    expect(createObjectUrl).toHaveBeenCalledTimes(2);
    expect(clickSpy).toHaveBeenCalledTimes(2);
    expect(openSpy).toHaveBeenCalledWith("", "_blank");
    expect(printDocument.write).toHaveBeenCalledWith(expect.stringContaining("Report title"));
    expect(screen.queryByRole("button", { name: "Export json" })).not.toBeInTheDocument();
  });

  it("renders Live Brief while running and Replay Process after completion", () => {
    mockedState = {
      ...initialState,
      status: "running",
      phase: "evidence",
      checkpoints: [{
        id: "checkpoint-evidence",
        phase: "evidence",
        title: "Live Brief：初步判断材料已形成",
        summary: "已抽取 8 条可用摘录。",
        knownFacts: ["Source A：benchmark 数据"],
        openQuestions: ["是否有风险边界？"],
        nextAction: "归组主题判断。",
        sourceNodeIds: ["source-1"],
        createdAt: 1
      }],
      graphNodes: [{ id: "source-1", kind: "source", label: "Source A" }]
    };
    const { rerender } = render(<App />);

    expect(screen.getByLabelText("Live Brief")).toBeInTheDocument();
    expect(screen.getByText("Live Brief：初步判断材料已形成")).toBeInTheDocument();
    expect(screen.getByText("Source A：benchmark 数据")).toBeInTheDocument();

    mockedState = completedState();
    rerender(<App />);

    expect(screen.getByLabelText("Replay Process")).toBeInTheDocument();
    expect(screen.getByText("Live Brief：搜索方向已收束")).toBeInTheDocument();
  });

  it("renders failed run diagnostics and the failure report drawer", () => {
    mockedState = failedState();
    render(<App />);

    expect(screen.getByLabelText("Run diagnostics")).toBeInTheDocument();
    expect(screen.getByText("auth")).toBeInTheDocument();
    expect(screen.getAllByText(/Check the configured key/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Final report drawer")).toBeInTheDocument();
    expect(screen.getByText("FAILURE REPORT")).toBeInTheDocument();
    expect(screen.getByText("Run failed: auth")).toBeInTheDocument();
  });

  it("exposes retry from failed run diagnostics when the error is retryable", () => {
    mockedState = retryableFailedState();
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Retry failed tool" }));

    expect(retryToolMock).toHaveBeenCalledWith("search-1");
  });

  it("renders the public live composer without runtime credential controls", () => {
    render(<App />);

    expect(screen.getByText("LIVE AGENT RUN")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start live process/i })).toBeInTheDocument();
    expect(screen.queryByText("Scope")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Provider configuration")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Tavily Search API Key")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("LLM API Key")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Full calibration/i })).not.toBeInTheDocument();
  });

  it("submits live runs without client API keys and prevents double submit", () => {
    render(<App />);

    const startButton = screen.getByRole("button", { name: /Start live process/i });
    fireEvent.click(startButton);
    fireEvent.click(startButton);

    expect(submitTaskMock).toHaveBeenCalledTimes(1);
    expect(submitTaskMock.mock.calls[0][0]).toMatchObject({
      runMode: "live",
      scope: expect.any(String),
      providerConfig: {
        apiKey: ""
      }
    });
    expect(submitTaskMock.mock.calls[0][0]).not.toHaveProperty("tavilyApiKey");
    expect(submitTaskMock.mock.calls[0][0]).not.toHaveProperty("braveApiKey");
    expect(submitTaskMock.mock.calls[0][0]).not.toHaveProperty("firecrawlApiKey");
    expect(submitTaskMock.mock.calls[0][0]).not.toHaveProperty("exaApiKey");
  });

  it("shows a queued loading state before the first runtime event", () => {
    mockedState = { ...initialState, status: "queued" };
    render(<App />);

    expect(screen.getByRole("button", { name: /Starting live process/i })).toBeDisabled();
    expect(screen.getByText(/正在连接运行时/)).toBeInTheDocument();
  });

  it("resets a completed run back to the initial composer", async () => {
    const { rerender } = render(<App />);
    mockedState = completedState();
    rerender(<App />);

    expect(screen.getByLabelText("Final report drawer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to start" }));
    expect(resetMock).toHaveBeenCalledTimes(1);

    mockedState = { ...initialState };
    rerender(<App />);

    expect(screen.getByText("LIVE AGENT RUN")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByLabelText("Final report drawer")).not.toBeInTheDocument();
    });
    expect(graphProps.reportFocusNodeId).toBeNull();
  });

});
