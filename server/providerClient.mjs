const defaultOpenAIBaseUrl = "https://token-plan-cn.xiaomimimo.com/v1";
const defaultAnthropicBaseUrl = "https://token-plan-cn.xiaomimimo.com/anthropic";
const defaultModel = "mimo-v2.5-pro";

export const providerDefaults = {
  protocol: "openai",
  baseUrl: defaultOpenAIBaseUrl,
  anthropicBaseUrl: defaultAnthropicBaseUrl,
  model: defaultModel,
  temperature: 0.35,
  maxTokens: 1408
};

export function maskApiKey(apiKey = "") {
  const trimmed = String(apiKey).trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= 10) {
    return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-3)}`;
}

export function sanitizeProviderConfig(input = {}) {
  const protocol = input.protocol === "anthropic" ? "anthropic" : "openai";
  const temperature = Number(input.temperature);
  const maxTokens = Number(input.maxTokens);
  return {
    protocol,
    baseUrl: String(input.baseUrl || providerDefaults.baseUrl).trim() || providerDefaults.baseUrl,
    anthropicBaseUrl: String(input.anthropicBaseUrl || providerDefaults.anthropicBaseUrl).trim() || providerDefaults.anthropicBaseUrl,
    apiKey: String(input.apiKey || "").trim(),
    model: String(input.model || providerDefaults.model).trim() || providerDefaults.model,
    temperature: Number.isFinite(temperature) ? Math.min(1, Math.max(0, temperature)) : providerDefaults.temperature,
    maxTokens: Number.isFinite(maxTokens) ? Math.min(4000, Math.max(256, Math.floor(maxTokens))) : providerDefaults.maxTokens
  };
}

export function providerPublicSummary(config) {
  const clean = sanitizeProviderConfig(config);
  return {
    protocol: clean.protocol,
    baseUrl: clean.baseUrl,
    anthropicBaseUrl: clean.anthropicBaseUrl,
    model: clean.model,
    temperature: clean.temperature,
    maxTokens: clean.maxTokens,
    apiKeyMasked: maskApiKey(clean.apiKey)
  };
}

function joinEndpoint(baseUrl, endpoint) {
  const cleanBase = String(baseUrl || "").replace(/\/+$/, "");
  if (cleanBase.endsWith(endpoint)) {
    return cleanBase;
  }
  return `${cleanBase}${endpoint}`;
}

function anthropicMessagesEndpoint(baseUrl) {
  const cleanBase = String(baseUrl || "").replace(/\/+$/, "");
  if (cleanBase.endsWith("/messages")) {
    return cleanBase;
  }
  if (cleanBase.endsWith("/v1")) {
    return `${cleanBase}/messages`;
  }
  return `${cleanBase}/v1/messages`;
}

export function buildProviderRequest(config, messages) {
  const clean = sanitizeProviderConfig(config);
  if (!clean.apiKey) {
    throw new Error("Provider API Key is required");
  }
  if (clean.protocol === "anthropic") {
    const system = messages.find((message) => message.role === "system")?.content ?? "";
    const userMessages = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content
      }));
    return {
      url: anthropicMessagesEndpoint(clean.anthropicBaseUrl),
      body: {
        model: clean.model,
        max_tokens: clean.maxTokens,
        temperature: clean.temperature,
        system,
        messages: userMessages.length > 0 ? userMessages : [{ role: "user", content: "" }]
      },
      headers: {
        "Content-Type": "application/json",
        "x-api-key": clean.apiKey,
        "anthropic-version": "2023-06-01"
      }
    };
  }

  return {
    url: joinEndpoint(clean.baseUrl, "/chat/completions"),
    body: {
      model: clean.model,
      messages,
      temperature: clean.temperature,
      max_tokens: clean.maxTokens
    },
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${clean.apiKey}`
    }
  };
}

export function buildModelDiscoveryRequest(config) {
  const clean = sanitizeProviderConfig(config);
  if (!clean.apiKey) {
    throw new Error("Provider API Key is required");
  }
  return {
    url: joinEndpoint(clean.baseUrl, "/models"),
    headers: {
      "Authorization": `Bearer ${clean.apiKey}`
    }
  };
}

export function pickMimoModel(models) {
  const candidates = Array.isArray(models?.data) ? models.data : Array.isArray(models) ? models : [];
  const ids = candidates
    .map((model) => String(model?.id || model?.name || ""))
    .filter(Boolean);
  return ids.find((id) => /mimo/i.test(id) && /2\.?5/i.test(id) && /pro/i.test(id))
    ?? ids.find((id) => /mimo/i.test(id) && /pro/i.test(id))
    ?? ids.find((id) => /mimo/i.test(id))
    ?? null;
}

export function extractProviderText(protocol, data) {
  if (protocol === "anthropic") {
    const parts = Array.isArray(data?.content) ? data.content : [];
    return parts
      .map((part) => typeof part?.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return String(data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "").trim();
}

export function parseProviderJson(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    throw new Error("Provider returned empty content");
  }
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) {
      return JSON.parse(fenced);
    }
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first !== -1 && last > first) {
      return JSON.parse(raw.slice(first, last + 1));
    }
    throw new Error("Provider response was not valid JSON");
  }
}

export function normalizeProviderResult(protocol, data, latencyMs) {
  const text = extractProviderText(protocol, data);
  if (!text) {
    throw new Error("Provider returned empty content");
  }
  let parsed;
  let parseError = null;
  try {
    parsed = parseProviderJson(text);
  } catch (error) {
    parseError = error instanceof Error ? error.message : "Provider response was not valid JSON";
  }
  if (parseError) {
    return {
      summary: text.slice(0, 240),
      sections: [{
        id: "section-provider-raw",
        title: "Provider draft",
        body: text,
        sourceNodeIds: []
      }],
      rawUsage: data?.usage ?? null,
      latencyMs,
      format: "raw_markdown_recovered",
      parseError
    };
  }
  const sections = Array.isArray(parsed.sections)
    ? parsed.sections.map((section, index) => ({
        id: String(section.id || `section-${index + 1}`),
        title: String(section.title || `Section ${index + 1}`),
        body: String(section.body || ""),
        sourceNodeIds: Array.isArray(section.sourceNodeIds) ? section.sourceNodeIds.map(String) : []
      })).filter((section) => section.body.trim())
    : [];
  return {
    summary: String(parsed.summary || text.slice(0, 240)),
    sections,
    rawUsage: data?.usage ?? null,
    latencyMs,
    format: "json"
  };
}

async function postJson(fetchImpl, request, signal) {
  const response = await fetchImpl(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { rawText: text };
    }
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || text || `Provider HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function discoverMimoModel(config, fetchImpl = fetch) {
  const request = buildModelDiscoveryRequest(config);
  const response = await fetchImpl(request.url, { headers: request.headers });
  const data = await response.json();
  return pickMimoModel(data);
}

export function shouldDiscoverModel(error) {
  const message = String(error?.message || "");
  if (/api[_ -]?key|unauthorized|forbidden|401|403/i.test(message)) {
    return false;
  }
  return /model|not found|invalid model/i.test(message);
}

export async function callProvider(config, messages, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 45000);
  let activeConfig = sanitizeProviderConfig(config);

  try {
    try {
      const request = buildProviderRequest(activeConfig, messages);
      const data = await postJson(fetchImpl, request, controller.signal);
      return normalizeProviderResult(activeConfig.protocol, data, Date.now() - startedAt);
    } catch (error) {
      if (activeConfig.protocol !== "openai" || !shouldDiscoverModel(error)) {
        throw error;
      }
      const discoveredModel = await discoverMimoModel(activeConfig, fetchImpl);
      if (!discoveredModel || discoveredModel === activeConfig.model) {
        throw error;
      }
      activeConfig = { ...activeConfig, model: discoveredModel };
      const request = buildProviderRequest(activeConfig, messages);
      const data = await postJson(fetchImpl, request, controller.signal);
      return {
        ...normalizeProviderResult(activeConfig.protocol, data, Date.now() - startedAt),
        discoveredModel
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
