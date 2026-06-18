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
});
