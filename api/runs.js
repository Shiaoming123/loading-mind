import { createRunSnapshot } from "../server/agentServer.mjs";

export const config = {
  maxDuration: 60
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function encodeSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function wantsStream(request) {
  return request.headers.get("accept")?.includes("text/event-stream")
    || request.headers.get("x-loading-mind-delivery") === "stream";
}

async function runSnapshot(body) {
  return createRunSnapshot(body ?? {}, {
    allowDemoFallback: body?.runMode === "live" ? false : true,
    forceDemoTools: process.env.LOADING_MIND_FORCE_DEMO_TOOLS === "1"
  });
}

function streamRun(body) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event, data) => {
        controller.enqueue(encoder.encode(encodeSse(event, data)));
      };

      void createRunSnapshot(body ?? {}, {
        allowDemoFallback: body?.runMode === "live" ? false : true,
        forceDemoTools: process.env.LOADING_MIND_FORCE_DEMO_TOOLS === "1",
        onRun: (run) => send("run-created", { run, delivery: "stream" }),
        onEvent: (event) => send("agent-event", event)
      }).then((payload) => {
        send("run-closed", {
          run: payload.run,
          delivery: "stream",
          errorLogs: payload.errorLogs ?? [],
          auditLogs: payload.auditLogs ?? []
        });
      }).catch((error) => {
        send("run-error", {
          error: error instanceof Error ? error.message : "Agent runtime error"
        });
      }).finally(() => {
        controller.close();
      });
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

async function handleRequest(request) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const body = await readBody(request);
  if (wantsStream(request)) {
    return streamRun(body);
  }

  try {
    const payload = await runSnapshot(body);
    return jsonResponse({
      ...payload,
      delivery: "snapshot"
    });
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : "Agent runtime error"
    }, 500);
  }
}

export default {
  fetch: handleRequest
};
