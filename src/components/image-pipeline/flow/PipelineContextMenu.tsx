
import { useState, useRef, useEffect } from "react";
import { Search } from "lucide-react";
import { usePipelineStore } from "@/lib/image-pipeline/pipeline-store";
import { getCategoryColor } from "@/lib/image-pipeline/utils";
import type { PipelineNodeDefinition } from "@/lib/image-pipeline/types";

interface PipelineContextMenuProps {
  x: number;
  y: number;
  flowPosition: { x: number; y: number };
  onClose: () => void;
}

export function PipelineContextMenu({
  x,
  y,
  flowPosition,
  onClose,
}: PipelineContextMenuProps) {
  const nodeDefinitions = usePipelineStore((s) => s.nodeDefinitions);
  const addNode = usePipelineStore((s) => s.addNode);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const allNodes = Object.entries(nodeDefinitions).flatMap(([, nodes]) => nodes);

  const filtered = search.trim()
    ? allNodes.filter(
        (n) =>
          n.display_name.toLowerCase().includes(search.toLowerCase()) ||
          n.description.toLowerCase().includes(search.toLowerCase()) ||
          n.type.toLowerCase().includes(search.toLowerCase())
      )
    : null;

  const handleAdd = (type: string) => {
    addNode(type, flowPosition);
    onClose();
  };

  // Position menu so it doesn't overflow viewport
  const style: React.CSSProperties = {
    position: "fixed",
    left: x,
    top: y,
    zIndex: 1000,
  };

  return (
    <div
      ref={menuRef}
      style={style}
      className="w-64 max-h-80 rounded-lg border border-border bg-card shadow-2xl overflow-hidden flex flex-col"
    >
      <div className="p-2 border-b border-border">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search nodes..."
            className="w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:border-orange-500 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              e.stopPropagation();
            }}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered ? (
          <div className="p-1">
            {filtered.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-3">
                No nodes found
              </p>
            )}
            {filtered.map((node) => (
              <NodeMenuItem key={node.type} node={node} onAdd={handleAdd} />
            ))}
          </div>
        ) : (
          Object.entries(nodeDefinitions).map(([category, nodes]) => {
            const color = getCategoryColor(category);
            const displayName = category
              .split("_")
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(" ");

            return (
              <div key={category}>
                <div
                  className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider sticky top-0"
                  style={{ backgroundColor: "var(--card)" }}
                >
                  <span style={{ color }}>{displayName}</span>
                </div>
                <div className="p-1 pt-0">
                  {nodes.map((node) => (
                    <NodeMenuItem
                      key={node.type}
                      node={node}
                      onAdd={handleAdd}
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function NodeMenuItem({
  node,
  onAdd,
}: {
  node: PipelineNodeDefinition;
  onAdd: (type: string) => void;
}) {
  const color = getCategoryColor(node.category);
  return (
    <button
      onClick={() => onAdd(node.type)}
      className="flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left hover:bg-accent transition-colors"
    >
      <div
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
        style={{ backgroundColor: color + "20" }}
      >
        <div
          className="h-2 w-2 rounded-sm"
          style={{ backgroundColor: color }}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium truncate">
          {node.display_name}
        </div>
      </div>
    </button>
  );
}
