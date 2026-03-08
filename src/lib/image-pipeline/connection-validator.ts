import type {
  PipelineNode,
  PipelineEdge,
  SourceHandleId,
  TargetHandleId,
} from "./types";
import { decodeHandleId } from "./utils";

export function isValidPipelineConnection(
  source: string,
  target: string,
  sourceHandle: string | null,
  targetHandle: string | null,
  nodes: PipelineNode[],
  edges: PipelineEdge[]
): boolean {
  if (source === target) return false;
  if (!sourceHandle || !targetHandle) return false;

  let sourceData: SourceHandleId;
  let targetData: TargetHandleId;

  try {
    sourceData = decodeHandleId<SourceHandleId>(sourceHandle);
    targetData = decodeHandleId<TargetHandleId>(targetHandle);
  } catch {
    return false;
  }

  const outputTypes = sourceData.outputTypes.map((t) => t.toLowerCase());
  const inputTypes = targetData.inputTypes.map((t) => t.toLowerCase());

  const hasMatch = outputTypes.some((ot) => inputTypes.includes(ot));
  if (!hasMatch) return false;

  const alreadyConnected = edges.some(
    (e) => e.target === target && e.targetHandle === targetHandle
  );
  if (alreadyConnected) return false;

  if (wouldCreateCycle(source, target, edges)) return false;

  return true;
}

function wouldCreateCycle(
  source: string,
  target: string,
  edges: PipelineEdge[]
): boolean {
  const visited = new Set<string>();
  const queue = [target];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === source) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const edge of edges) {
      if (edge.source === current && !visited.has(edge.target)) {
        queue.push(edge.target);
      }
    }
  }

  return false;
}

export function getPipelineConnectionColor(
  sourceHandle: string | null
): string {
  if (!sourceHandle) return "#94a3b8";

  try {
    const data = decodeHandleId<SourceHandleId>(sourceHandle);
    const type = data.outputTypes[0]?.toLowerCase() ?? "default";
    const colors: Record<string, string> = {
      image: "#f97316",
      imagelist: "#ea580c",
      model: "#8b5cf6",
      number: "#3b82f6",
      text: "#22c55e",
      textlist: "#16a34a",
      color: "#ec4899",
    };
    return colors[type] ?? "#94a3b8";
  } catch {
    return "#94a3b8";
  }
}
