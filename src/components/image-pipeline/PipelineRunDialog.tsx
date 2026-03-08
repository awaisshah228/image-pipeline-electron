
import { useState, useCallback } from "react";
import {
  X,
  Play,
  Square,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Clock,
} from "lucide-react";
import { usePipelineStore } from "@/lib/image-pipeline/pipeline-store";

interface PipelineRunDialogProps {
  open: boolean;
  onClose: () => void;
}

interface StepStatus {
  nodeId: string;
  nodeName: string;
  status: "pending" | "running" | "completed" | "error";
  message?: string;
}

export function PipelineRunDialog({ open, onClose }: PipelineRunDialogProps) {
  const nodes = usePipelineStore((s) => s.nodes);
  const edges = usePipelineStore((s) => s.edges);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepStatus[]>([]);
  const [completed, setCompleted] = useState(false);

  const getExecutionOrder = useCallback(() => {
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const node of nodes) {
      inDegree.set(node.id, 0);
      adj.set(node.id, []);
    }

    for (const edge of edges) {
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
      adj.get(edge.source)?.push(edge.target);
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);
      for (const next of adj.get(current) ?? []) {
        const newDeg = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, newDeg);
        if (newDeg === 0) queue.push(next);
      }
    }

    return order;
  }, [nodes, edges]);

  const simulateRun = useCallback(async () => {
    const order = getExecutionOrder();
    const stepList: StepStatus[] = order.map((id) => {
      const node = nodes.find((n) => n.id === id);
      return {
        nodeId: id,
        nodeName: node?.data.definition.display_name ?? "Unknown",
        status: "pending" as const,
      };
    });

    setSteps(stepList);
    setRunning(true);
    setCompleted(false);

    for (let i = 0; i < stepList.length; i++) {
      setSteps((prev) =>
        prev.map((s, idx) =>
          idx === i ? { ...s, status: "running" } : s
        )
      );

      // Simulate processing time
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));

      const hasError = Math.random() < 0.05; // 5% chance of error for demo

      setSteps((prev) =>
        prev.map((s, idx) =>
          idx === i
            ? {
                ...s,
                status: hasError ? "error" : "completed",
                message: hasError
                  ? "Simulated error: processing failed"
                  : `Processed in ${(500 + Math.random() * 1000).toFixed(0)}ms`,
              }
            : s
        )
      );

      if (hasError) {
        setRunning(false);
        return;
      }
    }

    setRunning(false);
    setCompleted(true);
  }, [getExecutionOrder, nodes]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">Run Pipeline</h2>
          <button
            onClick={onClose}
            className="rounded p-1 hover:bg-accent transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {nodes.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No nodes in pipeline. Add some nodes first.
            </p>
          ) : (
            <>
              {/* Info */}
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-amber-600 dark:text-amber-400">
                    Simulation mode.
                  </span>{" "}
                  This runs a simulated execution to validate your pipeline
                  structure. Actual image processing requires a backend.
                </p>
              </div>

              {/* Steps */}
              {steps.length > 0 && (
                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                  {steps.map((step) => (
                    <div
                      key={step.nodeId}
                      className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2"
                    >
                      {step.status === "pending" && (
                        <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      )}
                      {step.status === "running" && (
                        <Loader2 className="h-3.5 w-3.5 text-orange-500 animate-spin shrink-0" />
                      )}
                      {step.status === "completed" && (
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                      )}
                      {step.status === "error" && (
                        <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">
                          {step.nodeName}
                        </p>
                        {step.message && (
                          <p className="text-[10px] text-muted-foreground truncate">
                            {step.message}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {completed && (
                <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-3 text-center">
                  <p className="text-xs font-medium text-green-600 dark:text-green-400">
                    Pipeline completed successfully!
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Actions */}
        <div className="border-t border-border px-5 py-3 flex justify-end gap-2">
          {running ? (
            <button
              onClick={() => setRunning(false)}
              className="flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-xs font-medium text-destructive hover:bg-destructive/20 transition-colors"
            >
              <Square className="h-3 w-3" />
              Stop
            </button>
          ) : (
            <button
              onClick={simulateRun}
              disabled={nodes.length === 0}
              className="flex items-center gap-1.5 rounded-lg bg-orange-500 px-4 py-2 text-xs font-medium text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Play className="h-3 w-3" />
              {completed ? "Run Again" : "Run Pipeline"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
