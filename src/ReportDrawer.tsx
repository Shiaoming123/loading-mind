import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Download, FileText, RotateCcw } from "lucide-react";
import mermaid from "mermaid";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact, ArtifactBlock } from "./types";

type SourceLabelMap = Record<string, string>;

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  themeVariables: {
    background: "#fffaf0",
    primaryColor: "#f4efe5",
    primaryTextColor: "#2f2b25",
    primaryBorderColor: "#d9822b",
    lineColor: "#3e8581",
    secondaryColor: "#e8f3ef",
    tertiaryColor: "#fffaf0"
  }
});

function sourceLabel(sourceNodeIds: string[] = [], sourceLabelMap: SourceLabelMap = {}) {
  return sourceNodeIds
    .slice(0, 5)
    .map((nodeId) => sourceLabelMap[nodeId] ?? nodeId)
    .join(" / ");
}

function firstSource(sourceNodeIds: string[] | undefined) {
  return sourceNodeIds?.[0] ?? null;
}

function textPreview(value: string, length = 110) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > length ? `${normalized.slice(0, length).trim()}...` : normalized;
}

function blockTypeLabel(block: ArtifactBlock) {
  if (block.type === "source_matrix") {
    return "Source matrix";
  }
  if (block.type === "claim_graph") {
    return "Claim graph";
  }
  return block.type.charAt(0).toUpperCase() + block.type.slice(1);
}

function blockPreview(block: ArtifactBlock) {
  switch (block.type) {
    case "markdown":
      return textPreview(block.body);
    case "table":
    case "source_matrix":
      return `${block.rows.length} rows across ${block.columns.length} fields`;
    case "mermaid":
      return textPreview(block.code, 90);
    case "claim_graph":
      return `${block.claims?.length ?? block.nodes.filter((node) => node.kind === "claim").length} claims / ${block.edges.length} evidence links`;
  }
}

function MarkdownBody({ body }: { body: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  );
}

function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const renderId = useMemo(() => `mermaid-${Math.random().toString(36).slice(2)}`, [code]);

  useEffect(() => {
    let cancelled = false;
    setSvg("");
    setError("");
    mermaid.render(renderId, code)
      .then((result) => {
        if (!cancelled) {
          setSvg(result.svg);
        }
      })
      .catch((renderError: unknown) => {
        if (!cancelled) {
          setError(renderError instanceof Error ? renderError.message : "Mermaid render failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, renderId]);

  if (error) {
    return (
      <div className="mermaid-fallback">
        <strong>Mermaid render failed</strong>
        <span>{error}</span>
        <pre>{code}</pre>
      </div>
    );
  }

  return svg ? (
    <div className="mermaid-render" dangerouslySetInnerHTML={{ __html: svg }} />
  ) : (
    <pre className="mermaid-block">{code}</pre>
  );
}

function claimStatusLabel(status?: string) {
  if (status === "verified") {
    return "Verified";
  }
  if (status === "conflicted") {
    return "Conflicted";
  }
  if (status === "weak") {
    return "Weak";
  }
  return "Review";
}

function readableClaimGraphClaims(block: Extract<ArtifactBlock, { type: "claim_graph" }>, sourceLabelMap: SourceLabelMap) {
  if (block.claims && block.claims.length > 0) {
    return block.claims;
  }
  return block.nodes
    .filter((node) => node.kind === "claim")
    .map((node) => {
      const evidenceIds = block.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from);
      return {
        id: node.id,
        label: node.label,
        status: "unknown",
        supportCount: evidenceIds.length,
        confidence: 0,
        evidenceIds,
        sourceTitles: evidenceIds.slice(0, 3).map((id) => sourceLabelMap[id] ?? id)
      };
    });
}

function ClaimGraphBlock({
  block,
  expanded,
  sourceLabelMap,
  onFocusSource
}: {
  block: Extract<ArtifactBlock, { type: "claim_graph" }>;
  expanded: boolean;
  sourceLabelMap: SourceLabelMap;
  onFocusSource: (nodeId: string | null) => void;
}) {
  const claims = readableClaimGraphClaims(block, sourceLabelMap);
  const visibleClaims = expanded ? claims : claims.slice(0, 3);

  return (
    <div className="claim-graph-block">
      <div className="claim-graph-metrics" aria-label="Claim graph summary">
        <div>
          <strong>{claims.length}</strong>
          <span>claims</span>
        </div>
        <div>
          <strong>{block.edges.length}</strong>
          <span>links</span>
        </div>
      </div>
      <div className="claim-graph-claims">
        {visibleClaims.map((claim) => {
          const evidenceIds = claim.evidenceIds ?? [];
          const sourceTitles = (claim.sourceTitles ?? [])
            .map((title) => sourceLabelMap[title] ?? title)
            .filter(Boolean)
            .slice(0, 3);
          const focusId = evidenceIds[0] ?? claim.id;
          return (
            <button
              className="claim-graph-card"
              key={claim.id}
              onClick={() => onFocusSource(focusId)}
              type="button"
            >
              <span className={`claim-status status-${claim.status ?? "unknown"}`}>{claimStatusLabel(claim.status)}</span>
              <strong>{claim.label}</strong>
              <small>
                {(claim.supportCount ?? evidenceIds.length) || evidenceIds.length} supporting sources
                {claim.confidence ? ` / confidence ${Number(claim.confidence).toFixed(2)}` : ""}
              </small>
              {sourceTitles.length > 0 && (
                <div className="claim-source-chips">
                  {sourceTitles.map((title) => <em key={`${claim.id}-${title}`}>{title}</em>)}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ReportBlock({
  block,
  expanded,
  sourceLabelMap,
  onFocusSource
}: {
  block: ArtifactBlock;
  expanded: boolean;
  sourceLabelMap: SourceLabelMap;
  onFocusSource: (nodeId: string | null) => void;
}) {
  const sourceNodeId = firstSource(block.sourceNodeIds);
  return (
    <section className={`report-block block-${block.type}`}>
      <button
        className="report-block-focus"
        type="button"
        onClick={() => onFocusSource(sourceNodeId)}
        disabled={!sourceNodeId}
      >
        {block.title ?? "Report block"}
      </button>
      {block.type === "markdown" && <MarkdownBody body={block.body} />}
      {(block.type === "table" || block.type === "source_matrix") && (
        <div className="report-table-wrap">
          <table>
            <thead>
              <tr>
                {block.columns.map((column) => <th key={column}>{column}</th>)}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={`${block.id}-${index}`}>
                  {block.columns.map((column) => <td key={column}>{String(row[column] ?? "")}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {block.type === "mermaid" && <MermaidBlock code={block.code} />}
      {block.type === "claim_graph" && <ClaimGraphBlock block={block} expanded={expanded} sourceLabelMap={sourceLabelMap} onFocusSource={onFocusSource} />}
      {block.sourceNodeIds && block.sourceNodeIds.length > 0 && <em>{sourceLabel(block.sourceNodeIds, sourceLabelMap)}</em>}
    </section>
  );
}

function ReportPreview({
  artifact,
  sourceLabelMap,
  onFocusSource
}: {
  artifact: Artifact;
  sourceLabelMap: SourceLabelMap;
  onFocusSource: (nodeId: string | null) => void;
}) {
  const blocks = artifact.blocks ?? [];
  const sections = artifact.sections ?? [];

  if (blocks.length === 0 && sections.length === 0) {
    return null;
  }

  return (
    <article className="report-preview" aria-label="Collapsed report preview">
      {blocks.length > 0 && (
        <div className="report-preview-group">
          <span>Structured blocks</span>
          {blocks.slice(0, 6).map((block) => {
            const sourceNodeId = firstSource(block.sourceNodeIds);
            return (
              <button
                className="report-preview-item"
                disabled={!sourceNodeId}
                key={`preview-block-${block.id}`}
                onClick={() => onFocusSource(sourceNodeId)}
                type="button"
              >
                <small>{blockTypeLabel(block)}</small>
                <strong>{block.title ?? "Report block"}</strong>
                <span>{blockPreview(block)}</span>
                {block.sourceNodeIds && block.sourceNodeIds.length > 0 && <em>{sourceLabel(block.sourceNodeIds, sourceLabelMap)}</em>}
              </button>
            );
          })}
        </div>
      )}
      {sections.length > 0 && (
        <div className="report-preview-group">
          <span>Sections</span>
          {sections.slice(0, 5).map((section) => {
            const sourceNodeId = firstSource(section.sourceNodeIds);
            return (
              <button
                className="report-preview-item"
                disabled={!sourceNodeId}
                key={`preview-section-${section.id}`}
                onClick={() => onFocusSource(sourceNodeId)}
                type="button"
              >
                <small>Section</small>
                <strong>{section.title}</strong>
                <span>{textPreview(section.body)}</span>
                {section.sourceNodeIds.length > 0 && <em>{sourceLabel(section.sourceNodeIds, sourceLabelMap)}</em>}
              </button>
            );
          })}
        </div>
      )}
    </article>
  );
}

export function ReportDrawer({
  artifact,
  focusNodeId,
  sourceLabelMap = {},
  onFocusSource,
  onReplay,
  onExport
}: {
  artifact: Artifact | null;
  focusNodeId: string | null;
  sourceLabelMap?: SourceLabelMap;
  onFocusSource: (nodeId: string | null) => void;
  onReplay: () => void;
  onExport: (format: "markdown" | "json") => void;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [artifact?.id]);

  return (
    <AnimatePresence>
      {artifact && (
        <motion.section
          className={`report-drawer ${expanded ? "expanded" : "collapsed"}`}
          initial={{ opacity: 0, x: 36 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 36 }}
          transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
          aria-label="Final report drawer"
        >
          <header className="report-drawer-header">
            <span>{artifact.kind === "failure" ? "FAILURE REPORT" : "FINAL REPORT"}</span>
            <div className="report-drawer-actions">
              <button type="button" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? "Collapse report" : "Expand report"} title={expanded ? "Collapse report" : "Expand report"}>
                {expanded ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
              </button>
              <button type="button" onClick={onReplay} aria-label="Run again" title="Run again">
                <RotateCcw size={15} />
              </button>
              <button type="button" onClick={() => onExport("markdown")} aria-label="Export markdown" title="Export markdown">
                <Download size={15} />
              </button>
              <button type="button" onClick={() => onExport("json")} aria-label="Export json" title="Export json">
                <FileText size={15} />
              </button>
            </div>
          </header>
          <h2>{artifact.title}</h2>
          <MarkdownBody body={artifact.body} />
          {!expanded && <ReportPreview artifact={artifact} sourceLabelMap={sourceLabelMap} onFocusSource={onFocusSource} />}
          {artifact.sections && (
            <nav className="report-toc" aria-label="Report table of contents">
              {artifact.sections.map((section) => (
                <button
                  key={`toc-${section.id}`}
                  type="button"
                  onClick={() => onFocusSource(section.sourceNodeIds[0] ?? null)}
                >
                  {section.title}
                </button>
              ))}
            </nav>
          )}
          {expanded && artifact.blocks && (
            <article className="report-blocks" aria-label="Structured report blocks">
              {artifact.blocks.map((block) => (
                <ReportBlock block={block} expanded={expanded} key={block.id} sourceLabelMap={sourceLabelMap} onFocusSource={onFocusSource} />
              ))}
            </article>
          )}
          {expanded && artifact.sections && (
            <article className="report-article" aria-label="Generated report article">
              {artifact.sections.map((section) => {
                const nodeId = section.sourceNodeIds[0] ?? null;
                return (
                  <button
                    className={focusNodeId === nodeId ? "active" : ""}
                    key={section.id}
                    type="button"
                    onClick={() => onFocusSource(nodeId)}
                  >
                    <strong>{section.title}</strong>
                    <span>{section.body}</span>
                    <em>{sourceLabel(section.sourceNodeIds, sourceLabelMap)}</em>
                  </button>
                );
              })}
            </article>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}
