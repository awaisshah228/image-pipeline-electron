
import { useCallback } from "react";
import { X } from "lucide-react";
import { usePipelineStore } from "@/lib/image-pipeline/pipeline-store";
import { getCategoryColor } from "@/lib/image-pipeline/utils";

export function PipelineNodeSettingsPanel() {
  const selectedNodeId = usePipelineStore((s) => s.selectedNodeId);
  const setSelectedNodeId = usePipelineStore((s) => s.setSelectedNodeId);
  const nodes = usePipelineStore((s) => s.nodes);
  const updateNodeField = usePipelineStore((s) => s.updateNodeField);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  const handleChange = useCallback(
    (fieldName: string, value: unknown) => {
      if (selectedNodeId) {
        updateNodeField(selectedNodeId, fieldName, value);
      }
    },
    [selectedNodeId, updateNodeField]
  );

  if (!selectedNode) return null;

  const { definition, fieldValues } = selectedNode.data;
  const color = getCategoryColor(definition.category);

  return (
    <aside className="w-72 shrink-0 border-l border-border bg-card overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <div
            className="h-3 w-3 rounded-sm"
            style={{ backgroundColor: color }}
          />
          <span className="text-sm font-semibold truncate">
            {definition.display_name}
          </span>
        </div>
        <button
          onClick={() => setSelectedNodeId(null)}
          className="rounded p-1 hover:bg-accent transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Description */}
      <div className="px-4 py-3 border-b border-border">
        <p className="text-xs text-muted-foreground">
          {definition.description}
        </p>
      </div>

      {/* All fields including advanced */}
      <div className="divide-y divide-border/40">
        {definition.inputs.map((field) => (
          <div key={field.name} className="px-4 py-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium">
                {field.display_name}
                {field.required && (
                  <span className="text-destructive ml-0.5">*</span>
                )}
              </label>
              {field.info && (
                <span className="text-[10px] text-muted-foreground">
                  {field.info}
                </span>
              )}
            </div>

            {field.type === "dropdown" ? (
              <select
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs focus:outline-none focus:border-orange-500"
                value={(fieldValues[field.name] as string) ?? ""}
                onChange={(e) => handleChange(field.name, e.target.value)}
              >
                {field.options?.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : field.type === "bool" ? (
              <button
                type="button"
                role="switch"
                onClick={() =>
                  handleChange(
                    field.name,
                    !(fieldValues[field.name] as boolean)
                  )
                }
                className={`relative inline-flex h-5 w-9 rounded-full border-2 border-transparent transition-colors ${
                  fieldValues[field.name] ? "bg-orange-500" : "bg-border"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${
                    fieldValues[field.name]
                      ? "translate-x-4"
                      : "translate-x-0"
                  }`}
                />
              </button>
            ) : field.type === "int" || field.type === "float" ? (
              <input
                type="number"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:border-orange-500"
                value={(fieldValues[field.name] as number) ?? ""}
                step={field.type === "float" ? 0.01 : 1}
                onChange={(e) =>
                  handleChange(
                    field.name,
                    field.type === "float"
                      ? parseFloat(e.target.value) || 0
                      : parseInt(e.target.value) || 0
                  )
                }
              />
            ) : field.multiline ? (
              <textarea
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs focus:outline-none focus:border-orange-500 resize-y min-h-[60px]"
                value={(fieldValues[field.name] as string) ?? ""}
                placeholder={field.placeholder}
                onChange={(e) => handleChange(field.name, e.target.value)}
                rows={3}
              />
            ) : (
              <input
                type="text"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs focus:outline-none focus:border-orange-500"
                value={(fieldValues[field.name] as string) ?? ""}
                placeholder={field.placeholder}
                onChange={(e) => handleChange(field.name, e.target.value)}
              />
            )}
          </div>
        ))}
      </div>

      {/* Node info */}
      <div className="border-t border-border px-4 py-3">
        <p className="text-[10px] text-muted-foreground">
          ID: {selectedNode.id}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {definition.outputs.map((out) => (
            <span
              key={out.name}
              className="rounded-full bg-muted px-2 py-0.5 text-[10px]"
            >
              {out.display_name}: {out.types.join(" | ")}
            </span>
          ))}
        </div>
      </div>
    </aside>
  );
}
