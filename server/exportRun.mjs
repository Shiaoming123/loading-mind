import { maskApiKey } from "./providerClient.mjs";

function collectToolNodes(events) {
  return events
    .map((event) => event.graphEvent?.type === "node_added" || event.graphEvent?.type === "node_updated" ? event.graphEvent.node : null)
    .filter((node) => node?.kind === "tool_call");
}

function collectEvidenceNodes(events) {
  const byId = new Map();
  for (const event of events) {
    const node = event.graphEvent?.type === "node_added" || event.graphEvent?.type === "node_updated" ? event.graphEvent.node : null;
    if (node?.evidence?.id) {
      byId.set(node.evidence.id, node.evidence);
    }
  }
  return [...byId.values()];
}

export function publicRunPayload(run) {
  return {
    meta: {
      ...run.meta,
      provider: run.meta.provider
        ? { ...run.meta.provider, apiKeyMasked: run.meta.provider.apiKeyMasked || maskApiKey("") }
        : undefined
    },
    events: run.events,
    errorLogs: run.errorLogs ?? [],
    auditLogs: run.auditLogs ?? [],
    excludedEvidenceIds: [...run.excludedEvidenceIds]
  };
}

export function finalReportFromEvents(events) {
  return [...events].reverse().find((event) => event.finalReport)?.finalReport ?? null;
}

export function runToMarkdown(run) {
  const report = finalReportFromEvents(run.events);
  const tools = collectToolNodes(run.events);
  const evidence = collectEvidenceNodes(run.events);
  const provider = run.meta.provider;
  const lines = [
    `# ${report?.title || "Loading Mind Agent Report"}`,
    "",
    "## Run",
    "",
    `- Run ID: ${run.meta.id}`,
    `- Question: ${run.meta.question}`,
    `- Scope: ${run.meta.scope}`,
    `- Depth: ${run.meta.depth}`,
    `- Status: ${run.meta.status}`,
    provider ? `- Provider: ${provider.protocol} / ${provider.model} / ${provider.apiKeyMasked || "no-key"}` : "- Provider: not configured",
    "",
    "## Tool Calls",
    ""
  ];

  if (tools.length === 0) {
    lines.push("- No tool calls recorded.");
  } else {
    for (const node of tools) {
      const call = node.toolCall;
      lines.push(`- ${node.label}: ${call?.status || node.status || "unknown"} (${call?.costMs ?? "--"}ms)`);
      if (call?.outputSummary) {
        lines.push(`  - Observation: ${call.outputSummary}`);
      }
      if (call?.error) {
        lines.push(`  - Error: ${call.error}`);
      }
    }
  }

  lines.push("", "## Error Logs", "");
  const errorLogs = run.errorLogs ?? [];
  if (errorLogs.length === 0) {
    lines.push("- No run errors recorded.");
  } else {
    for (const errorLog of errorLogs) {
      lines.push(`- ${errorLog.phase} / ${errorLog.toolName || "runtime"}: ${errorLog.errorType}`);
      lines.push(`  - Message: ${errorLog.message}`);
      lines.push(`  - Next action: ${errorLog.nextAction}`);
    }
  }

  lines.push("", "## Audit Logs", "");
  const auditLogs = run.auditLogs ?? [];
  if (auditLogs.length === 0) {
    lines.push("- No audit logs recorded.");
  } else {
    for (const auditLog of auditLogs) {
      lines.push(`- ${auditLog.toolName} / ${auditLog.mcpTool}: ${auditLog.status}`);
      if (auditLog.outputSummary) {
        lines.push(`  - Output: ${auditLog.outputSummary}`);
      }
      if (auditLog.error) {
        lines.push(`  - Error: ${auditLog.error}`);
      }
    }
  }

  lines.push("", "## Evidence", "");
  if (evidence.length === 0) {
    lines.push("- No evidence recorded.");
  } else {
    for (const item of evidence) {
      lines.push(`- ${item.title} (${item.source}, confidence ${Number(item.confidence).toFixed(2)})`);
      lines.push(`  - ${item.quote}`);
    }
  }

  lines.push("", "## Report", "");
  if (!report) {
    lines.push("No final report was recorded.");
  } else {
    lines.push(report.body, "");
    for (const block of report.blocks ?? []) {
      lines.push(`### ${block.title || block.id}`, "");
      if (block.type === "markdown") {
        lines.push(block.body, "");
      } else if (block.type === "mermaid") {
        lines.push("```mermaid", block.code, "```", "");
      } else if (block.type === "table" || block.type === "source_matrix") {
        lines.push(`| ${block.columns.join(" | ")} |`);
        lines.push(`| ${block.columns.map(() => "---").join(" | ")} |`);
        for (const row of block.rows) {
          lines.push(`| ${block.columns.map((column) => String(row[column] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`);
        }
        lines.push("");
      } else if (block.type === "claim_graph") {
        lines.push(`Claim graph: ${block.claims?.length ?? block.nodes.length} claims, ${block.edges.length} evidence links.`, "");
        for (const claim of block.claims ?? []) {
          lines.push(`- ${claim.label} (${claim.status || "review"}, ${claim.supportCount ?? claim.evidenceIds?.length ?? 0} supporting sources)`);
          const sourceTitles = claim.sourceTitles ?? [];
          if (sourceTitles.length > 0) {
            lines.push(`  - Sources: ${sourceTitles.join(" / ")}`);
          }
        }
        lines.push("");
      }
    }
    for (const section of report.sections ?? []) {
      lines.push(`### ${section.title}`, "");
      lines.push(section.body, "");
      lines.push(`Source nodes: ${section.sourceNodeIds.join(", ") || "none"}`, "");
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

export function runToExportJson(run) {
  return {
    ...publicRunPayload(run),
    finalReport: finalReportFromEvents(run.events),
    toolCalls: collectToolNodes(run.events).map((node) => node.toolCall ?? {
      id: node.id,
      toolName: node.attributes?.tool,
      status: node.status
    }),
    evidence: collectEvidenceNodes(run.events)
  };
}
