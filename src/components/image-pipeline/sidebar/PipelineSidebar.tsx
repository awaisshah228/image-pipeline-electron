
import { useState, useCallback, useMemo } from "react";
import {
  Search,
  ChevronRight,
  ChevronDown,
  Image,
  FileUp,
  SlidersHorizontal,
  Sparkles,
  Move,
  Zap,
  Brain,
  Wrench,
  Layers,
  FolderOpen,
  Star,
  ScanFace,
  type LucideIcon,
} from "lucide-react";
import { usePipelineStore } from "@/lib/image-pipeline/pipeline-store";
import { getCategoryColor } from "@/lib/image-pipeline/utils";
import type { PipelineNodeDefinition } from "@/lib/image-pipeline/types";

const FAVORITES_KEY = "pipeline-node-favorites";

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveFavorites(favs: Set<string>) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favs]));
}

const categoryIcons: Record<string, LucideIcon> = {
  input: Image,
  output: FileUp,
  image_adjust: SlidersHorizontal,
  image_filter: Sparkles,
  image_transform: Move,
  ai_upscale: Zap,
  ai_enhance: Brain,
  computer_vision: ScanFace,
  utility: Wrench,
  image_channel: Layers,
  batch: FolderOpen,
};

export function PipelineSidebar() {
  const nodeDefinitions = usePipelineStore((s) => s.nodeDefinitions);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(Object.keys(nodeDefinitions))
  );
  const [favorites, setFavorites] = useState<Set<string>>(loadFavorites);

  const toggleFavorite = useCallback((nodeType: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(nodeType)) {
        next.delete(nodeType);
      } else {
        next.add(nodeType);
      }
      saveFavorites(next);
      return next;
    });
  }, []);

  const toggleCategory = useCallback((cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  }, []);

  const allNodes = Object.entries(nodeDefinitions).flatMap(([cat, nodes]) =>
    nodes.map((n) => ({ ...n, _category: cat }))
  );

  const favoriteNodes = useMemo(
    () => allNodes.filter((n) => favorites.has(n.type)),
    [allNodes, favorites]
  );

  const filteredNodes = searchQuery.trim()
    ? allNodes.filter(
        (n) =>
          n.display_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          n.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
          n.type.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : null;

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card overflow-hidden">
      {/* Search */}
      <div className="border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search nodes..."
            className="w-full rounded-md border border-border bg-background py-2 pl-8 pr-3 text-xs transition-colors placeholder:text-muted-foreground focus:border-orange-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Node list */}
      <div className="flex-1 overflow-y-auto">
        {filteredNodes ? (
          <div className="p-2 space-y-1">
            {filteredNodes.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">
                No nodes found
              </p>
            )}
            {filteredNodes.map((node) => (
              <DraggableNodeItem
                key={node.type}
                node={node}
                isFavorite={favorites.has(node.type)}
                onToggleFavorite={toggleFavorite}
              />
            ))}
          </div>
        ) : (
          <>
            {/* Favorites section */}
            {favoriteNodes.length > 0 && (
              <div>
                <button
                  onClick={() => toggleCategory("__favorites__")}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-semibold hover:bg-accent transition-colors"
                >
                  {expandedCategories.has("__favorites__") ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <div
                    className="flex h-5 w-5 items-center justify-center rounded"
                    style={{ backgroundColor: "#eab30820" }}
                  >
                    <Star className="h-3 w-3" style={{ color: "#eab308" }} />
                  </div>
                  <span>Favorites</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {favoriteNodes.length}
                  </span>
                </button>
                {expandedCategories.has("__favorites__") && (
                  <div className="pb-1 space-y-0.5 px-2">
                    {favoriteNodes.map((node) => (
                      <DraggableNodeItem
                        key={`fav-${node.type}`}
                        node={node}
                        isFavorite
                        onToggleFavorite={toggleFavorite}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Regular categories */}
            {Object.entries(nodeDefinitions).map(([category, nodes]) => {
              const CategoryIcon = categoryIcons[category] ?? Wrench;
              const color = getCategoryColor(category);
              const isExpanded = expandedCategories.has(category);
              const displayName = category
                .split("_")
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(" ");

              return (
                <div key={category}>
                  <button
                    onClick={() => toggleCategory(category)}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-semibold hover:bg-accent transition-colors"
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-3 w-3 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3 w-3 text-muted-foreground" />
                    )}
                    <div
                      className="flex h-5 w-5 items-center justify-center rounded"
                      style={{ backgroundColor: color + "20" }}
                    >
                      <CategoryIcon
                        className="h-3 w-3"
                        style={{ color }}
                      />
                    </div>
                    <span>{displayName}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {nodes.length}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="pb-1 space-y-0.5 px-2">
                      {nodes.map((node) => (
                        <DraggableNodeItem
                          key={node.type}
                          node={node}
                          isFavorite={favorites.has(node.type)}
                          onToggleFavorite={toggleFavorite}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Type legend */}
      <div className="border-t border-border p-3">
        <p className="text-[10px] font-semibold text-muted-foreground mb-2">
          DATA TYPES
        </p>
        <div className="flex flex-wrap gap-1.5">
          {[
            { name: "Image", color: "#f97316" },
            { name: "Model", color: "#8b5cf6" },
            { name: "Number", color: "#3b82f6" },
            { name: "Text", color: "#22c55e" },
          ].map((t) => (
            <div
              key={t.name}
              className="flex items-center gap-1 rounded-full px-2 py-0.5"
              style={{ backgroundColor: t.color + "18" }}
            >
              <div
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: t.color }}
              />
              <span
                className="text-[10px] font-medium"
                style={{ color: t.color }}
              >
                {t.name}
              </span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function DraggableNodeItem({
  node,
  isFavorite,
  onToggleFavorite,
}: {
  node: PipelineNodeDefinition;
  isFavorite: boolean;
  onToggleFavorite: (type: string) => void;
}) {
  const color = getCategoryColor(node.category);

  const onDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(
        "application/pipeline-node",
        JSON.stringify({ type: node.type })
      );
      e.dataTransfer.effectAllowed = "move";
    },
    [node.type]
  );

  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="group/item flex items-center gap-2.5 rounded-lg px-3 py-2 cursor-grab active:cursor-grabbing hover:bg-accent transition-colors border border-transparent hover:border-border/50"
    >
      <div
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
        style={{ backgroundColor: color + "15" }}
      >
        <div
          className="h-2.5 w-2.5 rounded-sm"
          style={{ backgroundColor: color }}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium truncate">
          {node.display_name}
        </div>
        <div className="text-[10px] text-muted-foreground truncate">
          {node.description}
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onToggleFavorite(node.type);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className={`shrink-0 p-0.5 rounded transition-all ${
          isFavorite
            ? "text-yellow-500 opacity-100"
            : "text-muted-foreground opacity-0 group-hover/item:opacity-60 hover:!opacity-100"
        }`}
        title={isFavorite ? "Remove from favorites" : "Add to favorites"}
      >
        <Star className={`h-3 w-3 ${isFavorite ? "fill-current" : ""}`} />
      </button>
    </div>
  );
}
