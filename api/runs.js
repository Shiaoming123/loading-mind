import { createRunSnapshot } from "../server/agentServer.mjs";

export const config = {
  maxDuration: 60
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const payload = await createRunSnapshot(req.body ?? {}, {
      allowDemoFallback: true,
      forceDemoTools: process.env.LOADING_MIND_FORCE_DEMO_TOOLS === "1"
    });
    res.status(200).json({
      ...payload,
      delivery: "snapshot"
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Agent runtime error"
    });
  }
}
