import { describe, expect, it } from "vitest";
import {
  buildProviderRequest,
  extractProviderText,
  maskApiKey,
  normalizeProviderResult,
  parseProviderJson,
  pickMimoModel,
  providerDefaults,
  shouldDiscoverModel
} from "./providerClient.mjs";

const messages = [
  { role: "system", content: "system" },
  { role: "user", content: "user" }
];

describe("providerClient", () => {
  it("builds default OpenAI-compatible chat completion requests", () => {
    const request = buildProviderRequest({
      ...providerDefaults,
      apiKey: "sk-secret"
    }, messages);

    expect(request.url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer sk-secret");
    expect(request.headers["api-key"]).toBeUndefined();
    expect(request.body.model).toBe("deepseek-v4-flash");
    expect(request.body.messages).toEqual(messages);
    expect(request.body.max_tokens).toBe(providerDefaults.maxTokens);
  });

  it("builds MiMo Token Plan requests with api-key auth", () => {
    const request = buildProviderRequest({
      ...providerDefaults,
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      anthropicBaseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
      model: "mimo-v2.5-pro",
      apiKey: "tp-secret"
    }, messages);

    expect(request.url).toBe("https://token-plan-cn.xiaomimimo.com/v1/chat/completions");
    expect(request.headers["api-key"]).toBe("tp-secret");
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.body.max_completion_tokens).toBe(providerDefaults.maxTokens);
    expect(request.body.max_tokens).toBeUndefined();
  });

  it("keeps bearer auth for generic OpenAI-compatible providers", () => {
    const request = buildProviderRequest({
      ...providerDefaults,
      baseUrl: "https://api.openai.com/v1",
      anthropicBaseUrl: "https://api.anthropic.com",
      apiKey: "sk-secret"
    }, messages);

    expect(request.headers.Authorization).toBe("Bearer sk-secret");
    expect(request.headers["api-key"]).toBeUndefined();
    expect(request.body.max_tokens).toBe(providerDefaults.maxTokens);
  });

  it("builds Anthropic-compatible message requests", () => {
    const request = buildProviderRequest({
      ...providerDefaults,
      protocol: "anthropic",
      anthropicBaseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
      apiKey: "tp-secret"
    }, messages);

    expect(request.url).toBe("https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages");
    expect(request.headers["api-key"]).toBe("tp-secret");
    expect(request.headers["x-api-key"]).toBeUndefined();
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
    expect(result.format).toBe("json");
  });

  it("recovers non-empty non-JSON provider text into markdown sections", () => {
    const result = normalizeProviderResult("openai", {
      choices: [{
        message: {
          content: "# Draft report\n\n- Non-strict provider output"
        }
      }],
      usage: { total_tokens: 88 }
    }, 37);

    expect(result.format).toBe("raw_markdown_recovered");
    expect(result.parseError).toMatch(/not valid JSON/i);
    expect(result.sections).toEqual([{
      id: "section-provider-raw",
      title: "Provider draft",
      body: "# Draft report\n\n- Non-strict provider output",
      sourceNodeIds: []
    }]);
    expect(result.rawUsage.total_tokens).toBe(88);
    expect(result.latencyMs).toBe(37);
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

  it("does not treat provider auth failures as model discovery errors", () => {
    expect(shouldDiscoverModel(new Error("Invalid API Key"))).toBe(false);
    expect(shouldDiscoverModel(new Error("Provider HTTP 401"))).toBe(false);
    expect(shouldDiscoverModel(new Error("model not found"))).toBe(true);
    expect(shouldDiscoverModel(new Error("invalid model name"))).toBe(true);
  });
});
