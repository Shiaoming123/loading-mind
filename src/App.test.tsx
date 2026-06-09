import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { initialState } from "./mindstreamReducer";
import type { MindstreamState } from "./types";

let mockedState: MindstreamState;
let graphProps: Record<string, unknown> = {};
let submitTaskMock = vi.fn();

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
        "source-2": "Mapped block source"
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
    }]
  };
}

describe("App shell", () => {
  beforeEach(() => {
    window.localStorage.clear();
    graphProps = {};
    submitTaskMock = vi.fn();
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

  it("does not auto-submit another calibration run after completion", () => {
    const { rerender } = render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Full calibration/i }));
    expect(submitTaskMock).toHaveBeenCalledTimes(1);

    mockedState = completedState();
    rerender(<App />);

    expect(submitTaskMock).toHaveBeenCalledTimes(1);
  });

  it("restores and persists local runtime keys", () => {
    window.localStorage.setItem("loading-mind.runtime-settings", JSON.stringify({
      tavilyApiKey: "tvly-local",
      providerConfig: {
        apiKey: "llm-local",
        model: "mimo-local"
      }
    }));

    render(<App />);

    expect(screen.getByLabelText("Tavily Search API Key")).toHaveValue("tvly-local");
    expect(screen.getByLabelText("LLM API Key")).toHaveValue("llm-local");
    expect(screen.getByDisplayValue("mimo-local")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Tavily Search API Key"), { target: { value: "tvly-updated" } });
    fireEvent.change(screen.getByLabelText("LLM API Key"), { target: { value: "llm-updated" } });

    const saved = JSON.parse(window.localStorage.getItem("loading-mind.runtime-settings") ?? "{}");
    expect(saved.tavilyApiKey).toBe("tvly-updated");
    expect(saved.providerConfig.apiKey).toBe("llm-updated");
  });
});
