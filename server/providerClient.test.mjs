import { describe, expect, it } from "vitest";
import {
  buildProviderRequest,
  extractProviderText,
  maskApiKey,
  normalizeProviderResult,
  parseProviderJson,
  pickMimoModel,
  providerDefaults
} from "./providerClient.mjs";

const messages = [
  { role: "system", content: "system" },
  { role: "user", content: "user" }
];

describe("providerClient", () => {
  it("builds OpenAI-compatible chat completion requests", () => {
    const request = buildProviderRequest({
      ...providerDefaults,
      apiKey: "tp-secret"
    }, messages);

    expect(request.url).toBe("https://token-plan-cn.xiaomimimo.com/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer tp-secret");
    expect(request.body.model).toBe("mimo-v2.5-pro");
    expect(request.body.messages).toEqual(messages);
  });

  it("builds Anthropic-compatible message requests", () => {
    const request = buildProviderRequest({
      ...providerDefaults,
      protocol: "anthropic",
      apiKey: "tp-secret"
    }, messages);

    expect(request.url).toBe("https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages");
    expect(request.headers["x-api-key"]).toBe("tp-secret");
    expect(request.body.system).toBe("system");
    expect(request.body.messages).toEqual([{ role: "user", content: "user" }]);
  });

  it("normalizes provider JSON responses", () => {
    const result = normalizeProviderResult("openai", {
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "ok",
            sections: [{ title: "A", body: "Body", sourceNodeIds: ["task-intent"] }]
          })
        }
      }],
      usage: { total_tokens: 123 }
    }, 42);

    expect(result.summary).toBe("ok");
    expect(result.sections).toHaveLength(1);
    expect(result.rawUsage.total_tokens).toBe(123);
    expect(result.latencyMs).toBe(42);
  });

  it("handles fenced JSON, empty content, and model discovery", () => {
    expect(parseProviderJson("```json\n{\"summary\":\"ok\"}\n```").summary).toBe("ok");
    expect(() => parseProviderJson("")).toThrow(/empty/i);
    expect(extractProviderText("anthropic", { content: [{ type: "text", text: "hello" }] })).toBe("hello");
    expect(pickMimoModel({ data: [{ id: "other" }, { id: "mimo-v2.5-pro-2026" }] })).toBe("mimo-v2.5-pro-2026");
  });

  it("masks API keys for public surfaces", () => {
    expect(maskApiKey("tp-c21wxh0dkb0bc24n2i9fs5ng5wc2xwhw0mrxesbmnqdw0vc6")).toBe("tp-c21...vc6");
  });
});
