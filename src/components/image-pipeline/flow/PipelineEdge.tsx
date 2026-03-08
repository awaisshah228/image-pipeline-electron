
import {
  BaseEdge,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import { getTypeColor } from "@/lib/image-pipeline/utils";

export function PipelineEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const edgeData = data as { sourceOutputTypes?: string[] } | undefined;
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const color = getTypeColor(edgeData?.sourceOutputTypes ?? ["default"]);

  return (
    <BaseEdge
      path={edgePath}
      style={{
        stroke: color,
        strokeWidth: selected ? 3 : 2,
        opacity: selected ? 1 : 0.7,
      }}
    />
  );
}
