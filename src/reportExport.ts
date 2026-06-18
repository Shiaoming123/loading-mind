import type { Artifact, ArtifactBlock, MindstreamState, ReportSection } from "./types";

export type ReportExportFormat = "markdown" | "word" | "pdf";

type SourceLabelMap = Record<string, string>;

function escapeHtml(value: string | number | boolean | undefined) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeFilename(value: string) {
  const normalized = value
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "loading-mind-report";
}

function sourceLabel(sourceNodeIds: string[] = [], sourceLabelMap: SourceLabelMap = {}) {
  return sourceNodeIds
    .slice(0, 5)
    .map((nodeId) => sourceLabelMap[nodeId] ?? nodeId)
    .join(" / ");
}

function markdownTable(columns: string[], rows: Array<Record<string, string | number | boolean>>) {
  const clean = (value: unknown) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${columns.map(clean).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${columns.map((column) => clean(row[column])).join(" | ")} |`)
  ].join("\n");
}

function blockToMarkdown(block: ArtifactBlock, sourceLabelMap: SourceLabelMap) {
  const lines = [`## ${block.title || block.id}`, ""];
  if (block.type === "markdown") {
    lines.push(block.body);
  } else if (block.type === "mermaid") {
    lines.push("```mermaid", block.code, "```");
  } else if (block.type === "table" || block.type === "source_matrix") {
    lines.push(markdownTable(block.columns, block.rows));
  } else if (block.type === "claim_graph") {
    lines.push(`Claim graph: ${block.claims?.length ?? block.nodes.length} claims, ${block.edges.length} evidence links.`);
    for (const claim of block.claims ?? []) {
      lines.push(`- ${claim.label} (${claim.sourceCount ?? claim.evidenceIds?.length ?? 0} linked excerpts)`);
      if (claim.sourceTitles?.length) {
        lines.push(`  - Sources: ${claim.sourceTitles.join(" / ")}`);
      }
    }
  }
  if (block.sourceNodeIds?.length) {
    lines.push("", `Source nodes: ${sourceLabel(block.sourceNodeIds, sourceLabelMap)}`);
  }
  return lines.join("\n");
}

function sectionToMarkdown(section: ReportSection, sourceLabelMap: SourceLabelMap) {
  return [
    `## ${section.title}`,
    "",
    section.body,
    "",
    `Source nodes: ${sourceLabel(section.sourceNodeIds, sourceLabelMap)}`
  ].join("\n");
}

export function reportToMarkdown(state: MindstreamState, sourceLabelMap: SourceLabelMap = {}) {
  const report = state.finalReport;
  const run = state.run;
  if (!report) {
    return "# Loading Mind Report\n\nNo final report was recorded.\n";
  }
  const lines = [
    `# ${report.title}`,
    "",
    report.body,
    "",
    "## Report Metadata",
    "",
    `- Run ID: ${run?.id ?? report.id}`,
    `- Question: ${run?.question ?? "Unknown"}`,
    `- Scope: ${run?.scope ?? "Unknown"}`,
    `- Status: ${run?.status ?? state.status}`,
    ""
  ];
  for (const section of report.sections ?? []) {
    lines.push(sectionToMarkdown(section, sourceLabelMap), "");
  }
  if (report.blocks?.length) {
    lines.push("# Traceability Appendices", "");
    for (const block of report.blocks) {
      lines.push(blockToMarkdown(block, sourceLabelMap), "");
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

function markdownToHtml(markdown: string) {
  const lines = markdown.split(/\n/);
  const html: string[] = [];
  let inList = false;
  let inCode = false;
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        html.push("</pre>");
        inCode = false;
      } else {
        html.push("<pre>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html.push(`${escapeHtml(line)}\n`);
      continue;
    }
    if (/^\|.+\|$/.test(line.trim())) {
      if (!inTable) {
        html.push("<table>");
        inTable = true;
      }
      if (/^\|\s*-+/.test(line.trim())) {
        continue;
      }
      const cells = line.trim().slice(1, -1).split("|").map((cell) => `<td>${escapeHtml(cell.trim())}</td>`).join("");
      html.push(`<tr>${cells}</tr>`);
      continue;
    }
    if (inTable) {
      html.push("</table>");
      inTable = false;
    }
    if (line.startsWith("# ")) {
      html.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
      continue;
    }
    if (line.startsWith("## ")) {
      html.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith("### ")) {
      html.push(`<h3>${escapeHtml(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith("- ")) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${escapeHtml(line.slice(2))}</li>`);
      continue;
    }
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
    if (line.trim()) {
      html.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  if (inList) {
    html.push("</ul>");
  }
  if (inTable) {
    html.push("</table>");
  }
  if (inCode) {
    html.push("</pre>");
  }
  return html.join("\n");
}

function reportHtmlDocument(markdown: string, title: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { color: #1f2933; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; line-height: 1.62; margin: 40px auto; max-width: 920px; padding: 0 32px; }
    h1 { font-size: 28px; margin: 0 0 24px; }
    h2 { border-top: 1px solid #d8dee4; font-size: 20px; margin-top: 30px; padding-top: 18px; }
    h3 { font-size: 16px; margin-top: 20px; }
    p, li { font-size: 13px; }
    table { border-collapse: collapse; font-size: 12px; margin: 14px 0; width: 100%; }
    td, th { border: 1px solid #cbd5df; padding: 7px 8px; vertical-align: top; }
    pre { background: #f6f8fa; border: 1px solid #d8dee4; overflow-wrap: anywhere; padding: 12px; white-space: pre-wrap; }
    @media print { body { margin: 0; max-width: none; } h2 { break-after: avoid; } table, pre { break-inside: avoid; } }
  </style>
</head>
<body>
${markdownToHtml(markdown)}
</body>
</html>`;
}

function downloadFile(filename: string, mimeType: string, content: string) {
  const blob = new Blob([content], { type: mimeType });
  const href = typeof URL !== "undefined" && URL.createObjectURL
    ? URL.createObjectURL(blob)
    : `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  if (href.startsWith("blob:")) {
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
}

function openPrintExport(html: string, filename: string) {
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    downloadFile(filename.replace(/\.pdf$/i, ".html"), "text/html;charset=utf-8", html);
    return;
  }
  printWindow.document.open();
  printWindow.document.write(`${html}<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},120);});</script>`);
  printWindow.document.close();
}

export function exportReport(state: MindstreamState, sourceLabelMap: SourceLabelMap, format: ReportExportFormat) {
  const report = state.finalReport;
  const baseName = safeFilename(report?.title || state.run?.question || "loading-mind-report");
  const markdown = reportToMarkdown(state, sourceLabelMap);
  if (format === "markdown") {
    downloadFile(`${baseName}.md`, "text/markdown;charset=utf-8", markdown);
    return;
  }
  const html = reportHtmlDocument(markdown, report?.title || "Loading Mind Report");
  if (format === "word") {
    downloadFile(`${baseName}.doc`, "application/msword;charset=utf-8", html);
    return;
  }
  openPrintExport(html, `${baseName}.pdf`);
}
