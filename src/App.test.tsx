import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { initialState } from "./mindstreamReducer";
import type { MindstreamState } from "./types";

let mockedState: MindstreamState;
let graphProps: Record<string, unknown> = {};
let submitTaskMock = vi.fn();
let resetMock = vi.fn();

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
    retryTool: vi.fn(),
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
          status: "verified",
          supportCount: 1,
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

describe("App shell", () => {
  beforeEach(() => {
    installLocalStorageStub();
    window.localStorage.clear();
    graphProps = {};
    submitTaskMock = vi.fn();
    resetMock = vi.fn();
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

    fireEvent.click(within(screen.getByLabelText("Report table of contents")).getByRole("button", { name: "Section one" }));

    expect(graphProps.reportFocusNodeId).toBe("source-1");
  });

  it("renders collapsed structured previews with readable source labels and focuses preview sources", () => {
    mockedState = completedState();
    render(<App />);

    const preview = screen.getByLabelText("Collapsed report preview");
    expect(within(preview).getByText("Structured blocks")).toBeInTheDocument();
    expect(within(preview).getByText("Sections")).toBeInTheDocument();
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

    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.getByText("成本与额度约束会影响高频工程使用")).toBeInTheDocument();
    expect(screen.getByText("Readable evidence source")).toBeInTheDocument();
    expect(screen.queryByText(/evidence-1\s*->\s*claim-1/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /成本与额度约束/ }));
    expect(graphProps.reportFocusNodeId).toBe("evidence-1");
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

  it("does not auto-submit another calibration run after completion", () => {
    const { rerender } = render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Full calibration/i }));
    expect(submitTaskMock).toHaveBeenCalledTimes(1);

    mockedState = completedState();
    rerender(<App />);

    expect(submitTaskMock).toHaveBeenCalledTimes(1);
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

    expect(screen.getByText("DEMO AGENT RUN")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByLabelText("Final report drawer")).not.toBeInTheDocument();
    });
    expect(graphProps.reportFocusNodeId).toBeNull();
  });

  it("restores and persists local runtime keys", () => {
    window.localStorage.setItem("loading-mind.runtime-settings", JSON.stringify({
      tavilyApiKey: "tvly-local",
      braveApiKey: "brave-local",
      firecrawlApiKey: "firecrawl-local",
      exaApiKey: "exa-local",
      providerConfig: {
        apiKey: "llm-local",
        model: "mimo-local"
      }
    }));

    render(<App />);

    expect(screen.getByLabelText("Tavily Search API Key")).toHaveValue("tvly-local");
    expect(screen.getByLabelText("Brave Search API Key")).toHaveValue("brave-local");
    expect(screen.getByLabelText("Firecrawl API Key")).toHaveValue("firecrawl-local");
    expect(screen.getByLabelText("Exa API Key")).toHaveValue("exa-local");
    expect(screen.getByLabelText("LLM API Key")).toHaveValue("llm-local");
    expect(screen.getByDisplayValue("mimo-local")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Tavily Search API Key"), { target: { value: "tvly-updated" } });
    fireEvent.change(screen.getByLabelText("Brave Search API Key"), { target: { value: "brave-updated" } });
    fireEvent.change(screen.getByLabelText("Firecrawl API Key"), { target: { value: "firecrawl-updated" } });
    fireEvent.change(screen.getByLabelText("Exa API Key"), { target: { value: "exa-updated" } });
    fireEvent.change(screen.getByLabelText("LLM API Key"), { target: { value: "llm-updated" } });

    const saved = JSON.parse(window.localStorage.getItem("loading-mind.runtime-settings") ?? "{}");
    expect(saved.tavilyApiKey).toBe("tvly-updated");
    expect(saved.braveApiKey).toBe("brave-updated");
    expect(saved.firecrawlApiKey).toBe("firecrawl-updated");
    expect(saved.exaApiKey).toBe("exa-updated");
    expect(saved.providerConfig.apiKey).toBe("llm-updated");
  });
});
