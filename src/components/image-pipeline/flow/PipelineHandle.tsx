
import { Handle, Position } from "@xyflow/react";
import { getTypeColor } from "@/lib/image-pipeline/utils";

interface PipelineHandleProps {
  type: "source" | "target";
  id: string;
  dataTypes: string[];
  position?: Position;
  style?: React.CSSProperties;
}

export function PipelineHandle({
  type,
  id,
  dataTypes,
  position,
  style,
}: PipelineHandleProps) {
  const color = getTypeColor(dataTypes);
  const pos =
    position ?? (type === "source" ? Position.Right : Position.Left);

  return (
    <Handle
      type={type}
      position={pos}
      id={id}
      style={{
        width: 12,
        height: 12,
        background: color,
        border: `2px solid white`,
        boxShadow: `0 0 0 1px ${color}40, 0 0 6px ${color}30`,
        zIndex: 30,
        ...style,
      }}
    />
  );
}
