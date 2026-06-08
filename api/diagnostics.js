import { createDefaultToolRegistry } from "../server/agentServer.mjs";

export const config = {
  maxDuration: 10
};

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText
    };
  } catch (error) {
    clearTimeout(timer);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown network error"
    };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const registry = createDefaultToolRegistry();
  const [searchProbe, providerProbe] = await Promise.all([
    probe("https://api.duckduckgo.com/?q=loading%20mind&format=json&no_redirect=1&no_html=1"),
    probe("https://token-plan-cn.xiaomimimo.com/v1/models")
  ]);

  res.status(200).json({
    runtime: "loading-mind-vercel",
    delivery: "snapshot",
    demoFallback: true,
    tools: registry.list(),
    network: {
      webSearch: searchProbe,
      provider: providerProbe
    }
  });
}
