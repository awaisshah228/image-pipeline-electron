
import { useState, useCallback } from "react";
import { X, Download, Copy, Check } from "lucide-react";
import { usePipelineStore } from "@/lib/image-pipeline/pipeline-store";

interface PipelineExportDialogProps {
  open: boolean;
  onClose: () => void;
}

export function PipelineExportDialog({
  open,
  onClose,
}: PipelineExportDialogProps) {
  const nodes = usePipelineStore((s) => s.nodes);
  const edges = usePipelineStore((s) => s.edges);
  const pipelineName = usePipelineStore((s) => s.pipelineName);
  const getViewport = usePipelineStore((s) => s.getViewport);
  const [copied, setCopied] = useState(false);

  const exportData = useCallback(() => {
    return JSON.stringify(
      {
        name: pipelineName,
        version: "1.0",
        nodes: nodes.map((n) => ({
          id: n.id,
          type: n.data.definition.type,
          position: n.position,
          fieldValues: n.data.fieldValues,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
        })),
        viewport: getViewport(),
      },
      null,
      2
    );
  }, [nodes, edges, pipelineName, getViewport]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(exportData());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [exportData]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([exportData()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${pipelineName.replace(/\s+/g, "-").toLowerCase()}.pipeline.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportData, pipelineName]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">Export Pipeline</h2>
          <button
            onClick={onClose}
            className="rounded p-1 hover:bg-accent transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <pre className="text-xs font-mono overflow-auto max-h-64 text-foreground/80">
              {exportData()}
            </pre>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-xs font-medium hover:bg-accent transition-colors"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied ? "Copied!" : "Copy JSON"}
            </button>
            <button
              onClick={handleDownload}
              className="flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2.5 text-xs font-medium text-white hover:bg-orange-600 transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              Download .json
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="border-t border-border px-5 py-3 flex gap-4">
          <span className="text-xs text-muted-foreground">
            {nodes.length} nodes
          </span>
          <span className="text-xs text-muted-foreground">
            {edges.length} connections
          </span>
        </div>
      </div>
    </div>
  );
}
