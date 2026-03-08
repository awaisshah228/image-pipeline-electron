
import type { ConnectionLineComponentProps } from "@xyflow/react";
import { getPipelineConnectionColor } from "@/lib/image-pipeline/connection-validator";

export function PipelineConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromHandle,
}: ConnectionLineComponentProps) {
  const color = getPipelineConnectionColor(fromHandle?.id ?? null);

  const dx = Math.abs(toX - fromX) * 0.5;
  const d = `M ${fromX} ${fromY} C ${fromX + dx} ${fromY}, ${toX - dx} ${toY}, ${toX} ${toY}`;

  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeDasharray="6 3"
        className="animated-dash"
      />
      <circle cx={toX} cy={toY} r={4} fill={color} />
    </g>
  );
}
