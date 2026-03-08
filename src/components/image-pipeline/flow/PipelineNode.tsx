
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Position } from "@xyflow/react";
import {
  Image,
  Globe,
  Brain,
  Type,
  Hash,
  Palette,
  Download,
  Eye,
  Info,
  Sun,
  SlidersHorizontal,
  BarChart3,
  RefreshCw,
  Moon,
  Wind,
  Zap,
  Eraser,
  Scan,
  Binary,
  Layers,
  Maximize2,
  Minimize2,
  Crop,
  RotateCw,
  FlipHorizontal2,
  Square,
  Grid3X3,
  Combine,
  ArrowUpFromLine,
  UserCheck,
  Scissors,
  Paintbrush,
  ScanFace,
  Mountain,
  PaintBucket,
  Calculator,
  GitBranch,
  StickyNote,
  Columns2,
  FolderOpen,
  Repeat,
  ListPlus,
  Video,
  Film,
  Trash2,
  Loader2,
  AlertCircle,
  Cog,
  FolderDown,
  Cloud,
  X,
  Star,
  Power,
  SkipForward,
  Timer,
  MousePointer,
  type LucideIcon,
} from "lucide-react";
import type { PipelineNodeData, NodeDisableState } from "@/lib/image-pipeline/types";
import { PipelineHandle } from "./PipelineHandle";
import { PipelineInputFieldComponent } from "./PipelineInputField";
import { SegmentSelectModal } from "./SegmentSelectModal";
import { usePipelineStore } from "@/lib/image-pipeline/pipeline-store";
import { processImage } from "@/lib/image-pipeline/native-processor";
import { getActiveStream } from "@/lib/image-pipeline/webcam-processor";
import {
  encodeHandleId,
  getTypeColor,
  getCategoryColor,
} from "@/lib/image-pipeline/utils";

const iconMap: Record<string, LucideIcon> = {
  Image, Globe, Brain, Type, Hash, Palette, Download, Eye, Info, Sun,
  SlidersHorizontal, BarChart3, RefreshCw, Moon, Wind, Zap, Eraser, Scan,
  Binary, Layers, Maximize2, Minimize2, Crop, RotateCw, FlipHorizontal2,
  Square, Grid3x3: Grid3X3, Grid3X3, Combine, ArrowUpFromLine, UserCheck,
  Scissors, Paintbrush, Blend: Layers, ScanFace, Mountain, PaintBucket,
  Calculator, GitBranch, StickyNote, Columns2, FolderOpen, FolderDown,
  Repeat, ListPlus, Video, Film, Cog, Cloud, MousePointer,
};

interface PipelineNodeProps {
  id: string;
  data: PipelineNodeData;
  selected?: boolean;
}

export const PipelineNodeComponent = memo(function PipelineNodeComponent({
  id,
  data,
  selected,
}: PipelineNodeProps) {
  const { definition, fieldValues, showNode, previewUrl, processing, error, disableState = "enabled", executionTime } =
    data;
  const outputData = data.outputData as Record<string, unknown> | undefined;
  const [collapsed, setCollapsed] = useState(!showNode);
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);
  const [segmentSelectOpen, setSegmentSelectOpen] = useState(false);
  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const isSegmentSelect = definition.type === "segment_select";
  const isWebcamNode = definition.type === "webcam_capture";
  const isDisabled = disableState === "disabled";
  const isPassthrough = disableState === "passthrough";

  // Attach live MediaStream to <video> for zero-copy GPU-composited preview
  useEffect(() => {
    if (!isWebcamNode || !processing) return;
    let cancelled = false;
    const tryAttach = () => {
      const stream = getActiveStream();
      if (stream && webcamVideoRef.current) {
        if (webcamVideoRef.current.srcObject !== stream) {
          webcamVideoRef.current.srcObject = stream;
          webcamVideoRef.current.play().catch(() => {});
        }
        return true;
      }
      return false;
    };
    // Poll until stream is available (camera permission can take time)
    if (!tryAttach()) {
      const interval = setInterval(() => {
        if (cancelled || tryAttach()) clearInterval(interval);
      }, 200);
      return () => {
        cancelled = true;
        clearInterval(interval);
        if (webcamVideoRef.current) webcamVideoRef.current.srcObject = null;
      };
    }
    return () => {
      cancelled = true;
      if (webcamVideoRef.current) webcamVideoRef.current.srcObject = null;
    };
  }, [isWebcamNode, processing]);

  const updateNodeField = usePipelineStore((s) => s.updateNodeField);
  const updateNodePreview = usePipelineStore((s) => s.updateNodePreview);
  const deleteNode = usePipelineStore((s) => s.deleteNode);
  const reprocessNode = usePipelineStore((s) => s.reprocessNode);
  const toggleNodeDisable = usePipelineStore((s) => s.toggleNodeDisable);
  const edges = usePipelineStore((s) => s.edges);

  // Get the source image for segment_select (from connected input node)
  const segmentSourceImage = isSegmentSelect
    ? (data.fieldValues?.image as string) ?? previewUrl
    : null;

  const handleSegmentApply = useCallback(
    async (
      points: number[][],
      pointLabels: number[],
      box?: number[],
      currentImage?: string
    ): Promise<string | undefined> => {
      const sourceImg = currentImage || segmentSourceImage;
      if (!sourceImg) return undefined;
      const params: Record<string, unknown> = {};
      if (points.length > 0) {
        params.points = points;
        params.point_labels = pointLabels;
      }
      if (box) {
        params.box = box;
      }
      const result = await processImage("segment_select", sourceImg, params);
      if (result?.dataUrl) {
        updateNodePreview(id, result.dataUrl);
        return result.dataUrl;
      }
      return undefined;
    },
    [id, segmentSourceImage, updateNodePreview]
  );

  const handleSegmentUpdatePreview = useCallback(
    (url: string) => {
      updateNodePreview(id, url);
    },
    [id, updateNodePreview]
  );

  const Icon = iconMap[definition.icon] ?? Cog;
  const categoryColor = getCategoryColor(definition.category);

  const handleFieldChange = useCallback(
    (name: string, value: unknown) => {
      updateNodeField(id, name, value);
    },
    [id, updateNodeField]
  );

  const webcamSource = (fieldValues.source as string) ?? "Webcam";

  const visibleInputs = definition.inputs
    .filter((f: { show: boolean }) => f.show)
    .filter((f) => {
      // Hide stream_url field when webcam source is "Webcam"
      if (isWebcamNode && f.name === "stream_url" && webcamSource === "Webcam") return false;
      return true;
    })
    .map((f) => {
      // Dynamically update class_names tag options when custom_labels is provided
      if (f.name === "class_names" && f.type === "tags") {
        const customLabels = ((fieldValues.custom_labels as string) ?? "").trim();
        if (customLabels) {
          const labels = customLabels.split(",").map((s) => s.trim()).filter(Boolean);
          return { ...f, options: labels };
        }
      }
      return f;
    });

  const connectedInputs = new Set(
    edges
      .filter((e) => e.target === id)
      .map((e) => {
        try {
          const d = JSON.parse(atob(e.targetHandle ?? ""));
          return d.inputName as string;
        } catch {
          return "";
        }
      })
  );

  return (
    <div
      className={`group/node relative rounded-xl border shadow-lg transition-all hover:shadow-xl ${
        selected
          ? "ring-2"
          : ""
      } ${collapsed ? "w-52" : "w-80"} ${processing ? "pipeline-processing" : ""}`}
      style={{
        backgroundColor: "var(--node-body)",
        borderColor: selected ? "var(--node-selected)" : isDisabled ? "var(--destructive)" : isPassthrough ? "#f59e0b" : "var(--node-border)",
        opacity: isDisabled ? 0.5 : 1,
        ...(selected ? { boxShadow: "0 0 0 2px color-mix(in srgb, var(--node-selected) 20%, transparent)" } : {}),
      }}
    >
      {/* Disable/Passthrough badge */}
      {disableState !== "enabled" && (
        <div
          className="absolute -top-2.5 left-3 z-10 flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
          style={{
            backgroundColor: isDisabled ? "var(--destructive)" : "#f59e0b",
            color: "white",
          }}
        >
          {isDisabled ? <Power className="h-2.5 w-2.5" /> : <SkipForward className="h-2.5 w-2.5" />}
          {isDisabled ? "Disabled" : "Passthrough"}
        </div>
      )}

      {/* Toolbar on hover */}
      <div
        className={`absolute -top-10 right-0 flex gap-1 transition-opacity duration-200 ${
          selected ? "opacity-100" : "opacity-0 group-hover/node:opacity-100"
        }`}
      >
        <button
          onClick={() => toggleNodeDisable(id)}
          className={`rounded-md border p-1.5 shadow-sm transition-colors ${
            isDisabled ? "bg-destructive/20 border-destructive/50 text-destructive" :
            isPassthrough ? "bg-amber-500/20 border-amber-500/50 text-amber-500" :
            "bg-card border-border hover:bg-accent"
          }`}
          title={`State: ${disableState} (click to cycle)`}
        >
          {isDisabled ? <Power className="h-3 w-3" /> : isPassthrough ? <SkipForward className="h-3 w-3" /> : <Power className="h-3 w-3" />}
        </button>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="rounded-md bg-card border border-border p-1.5 shadow-sm hover:bg-accent transition-colors"
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? (
            <Maximize2 className="h-3 w-3" />
          ) : (
            <Minimize2 className="h-3 w-3" />
          )}
        </button>
        <button
          onClick={() => reprocessNode(id)}
          className="rounded-md bg-card border border-border p-1.5 shadow-sm hover:bg-accent transition-colors"
          title={isWebcamNode && processing ? "Stop capture" : "Re-process"}
          disabled={!isWebcamNode && processing}
        >
          <RefreshCw className={`h-3 w-3 ${processing ? "animate-spin" : ""}`} />
        </button>
        <button
          onClick={() => deleteNode(id)}
          className="rounded-md bg-card border border-border p-1.5 shadow-sm hover:bg-destructive hover:text-destructive-foreground hover:border-destructive transition-colors"
          title="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {/* Header */}
      <div
        className="flex items-center gap-2.5 rounded-t-xl px-4 py-3"
        style={{
          background: `linear-gradient(135deg, ${categoryColor}15, ${categoryColor}08)`,
          borderBottom: "1px solid var(--node-border)",
        }}
      >
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{
            backgroundColor: categoryColor + "20",
          }}
        >
          {processing ? (
            <Loader2
              className="h-4 w-4 animate-spin"
              style={{ color: categoryColor }}
            />
          ) : (
            <Icon className="h-4 w-4" style={{ color: categoryColor }} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold truncate leading-tight">
            {definition.display_name}
          </div>
          {!collapsed && (
            <div className="text-[10px] text-muted-foreground truncate mt-0.5 leading-tight">
              {definition.description}
            </div>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-1.5 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive border-b border-destructive/20">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}

      {/* Input fields */}
      {!collapsed && visibleInputs.length > 0 && (
        <div className="divide-y divide-border/40">
          {visibleInputs.map((field, idx) => (
            <PipelineInputFieldComponent
              key={field.name}
              nodeId={id}
              field={field}
              value={fieldValues[field.name]}
              onChange={handleFieldChange}
              isLast={
                idx === visibleInputs.length - 1 &&
                definition.outputs.length === 0
              }
              connected={connectedInputs.has(field.name)}
            />
          ))}
        </div>
      )}

      {/* Webcam Start/Stop button */}
      {!collapsed && isWebcamNode && (
        <div className="px-4 py-3" style={{ borderTop: "1px solid color-mix(in srgb, var(--node-border) 40%, transparent)" }}>
          <button
            onClick={() => reprocessNode(id)}
            className={`w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-all ${
              processing
                ? "bg-red-500/15 text-red-500 border border-red-500/30 hover:bg-red-500/25"
                : "bg-green-500/15 text-green-500 border border-green-500/30 hover:bg-green-500/25"
            }`}
          >
            {processing ? (
              <>
                <X className="h-4 w-4" />
                Stop Capture
              </>
            ) : (
              <>
                <Video className="h-4 w-4" />
                {webcamSource === "Webcam" ? "Start Camera" : "Start Stream"}
              </>
            )}
          </button>
        </div>
      )}

      {/* Hidden input handles (for inputs that aren't shown but have input_types) */}
      {definition.inputs
        .filter(
          (f) => !f.show && f.input_types && f.input_types.length > 0
        )
        .map((field) => {
          const handleId = encodeHandleId({
            nodeId: id,
            inputName: field.name,
            inputTypes: field.input_types,
            fieldType: field.type,
          });
          return (
            <div
              key={`hidden-input-${field.name}`}
              className={`relative flex items-center gap-2 px-4 py-2 ${
                !collapsed ? "border-t border-border/30" : ""
              }`}
            >
              <PipelineHandle
                type="target"
                id={handleId}
                dataTypes={field.input_types!}
                position={Position.Left}
              />
              <span className="text-xs text-muted-foreground">
                {field.display_name}
              </span>
              {connectedInputs.has(field.name) && (
                <div className="ml-auto flex items-center gap-1">
                  <div className="h-1.5 w-1.5 rounded-full bg-green-500" />
                </div>
              )}
            </div>
          );
        })}

      {/* Live webcam preview (zero-copy, GPU-composited) */}
      {!collapsed && isWebcamNode && processing && (
        <div className="p-2" style={{ borderTop: "1px solid color-mix(in srgb, var(--node-border) 40%, transparent)" }}>
          <video
            ref={webcamVideoRef}
            muted
            playsInline
            autoPlay
            className="w-full rounded-md object-contain"
            style={{ maxHeight: 160, backgroundColor: "color-mix(in srgb, var(--muted) 30%, transparent)" }}
          />
          {/* Webcam stats */}
          {outputData?.count != null && (
            <div className="mt-1 text-center text-[10px] font-medium text-muted-foreground">
              Frames: {String(outputData.count)} | Queue: {String(outputData.queue ?? 0)} | Processed: {String(outputData.processed ?? 0)}
            </div>
          )}
        </div>
      )}

      {/* Preview image (for non-webcam nodes, or webcam stopped with last frame) */}
      {!collapsed && previewUrl && !(isWebcamNode && processing) && (
        <div className="p-2" style={{ borderTop: "1px solid color-mix(in srgb, var(--node-border) 40%, transparent)" }}>
          <img
            src={previewUrl}
            alt="Preview"
            className="w-full rounded-md object-contain cursor-pointer hover:opacity-90 transition-opacity"
            style={{ maxHeight: 160, backgroundColor: "color-mix(in srgb, var(--muted) 30%, transparent)" }}
            onClick={() =>
              isSegmentSelect && segmentSourceImage
                ? setSegmentSelectOpen(true)
                : setFullscreenImage(previewUrl)
            }
          />
          {/* SAM segment select hint */}
          {isSegmentSelect && !processing && (
            <div className="mt-1 text-center text-[10px] font-medium text-orange-400 cursor-pointer" onClick={() => setSegmentSelectOpen(true)}>
              <MousePointer className="inline h-3 w-3 mr-1" />
              Click image to select objects
            </div>
          )}
          {/* Progress indicator for batch/video processing */}
          {processing && typeof outputData?.progress === "string" && (
            <div className="mt-1.5 flex items-center gap-2">
              <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                {(() => {
                  const match = (outputData.progress as string).match(/(\d+)\/(\d+)/);
                  const pct = match ? (Number(match[1]) / Number(match[2])) * 100 : 0;
                  return <div className="h-full rounded-full bg-orange-500 transition-all duration-200" style={{ width: `${pct}%` }} />;
                })()}
              </div>
              <span className="text-[10px] font-medium text-muted-foreground whitespace-nowrap">
                {outputData.progress as string}
              </span>
            </div>
          )}
          {/* Detection count (when not processing) */}
          {(() => {
            if (processing || (definition.type !== "face_detect_cv" && definition.type !== "yolo_detect") || outputData?.count == null) return null;
            const cnt = Number(outputData.count);
            const label = definition.type === "yolo_detect" ? "object" : "face";
            return (
              <div className="mt-1 text-center text-[11px] font-medium text-muted-foreground">
                {cnt} {label}{cnt !== 1 ? "s" : ""} detected
              </div>
            );
          })()}
          {/* Saved status */}
          {!processing && !!outputData?.saved && typeof outputData?.progress === "string" && (
            <div className="mt-1 text-center text-[10px] font-medium text-green-600">
              {outputData.progress as string}
            </div>
          )}
        </div>
      )}

      {/* Number Display */}
      {!collapsed && definition.type === "number_display" && (
        <div
          className="flex items-center justify-center px-4 py-6"
          style={{ borderTop: "1px solid color-mix(in srgb, var(--node-border) 40%, transparent)" }}
        >
          <span
            className="text-4xl font-bold tabular-nums"
            style={{ color: getCategoryColor(definition.category) }}
          >
            {outputData?.value !== undefined
              ? String(outputData.value)
              : fieldValues.value !== undefined
              ? String(fieldValues.value)
              : "—"}
          </span>
        </div>
      )}

      {/* Image Gallery */}
      {!collapsed && definition.type === "image_gallery" && !!outputData?.images && (
        <div
          className="p-2"
          style={{ borderTop: "1px solid color-mix(in srgb, var(--node-border) 40%, transparent)" }}
        >
          <div className="grid grid-cols-3 gap-1.5">
            {(outputData.images as string[]).map((imgUrl, i) => (
              <img
                key={i}
                src={imgUrl}
                alt={`Object ${i + 1}`}
                className="w-full aspect-square rounded object-cover cursor-pointer hover:opacity-80 transition-opacity"
                style={{ backgroundColor: "color-mix(in srgb, var(--muted) 30%, transparent)" }}
                onClick={() => setFullscreenImage(imgUrl)}
              />
            ))}
          </div>
          <div className="text-center text-[10px] text-muted-foreground mt-1.5">
            {(outputData.images as string[]).length} image{(outputData.images as string[]).length !== 1 ? "s" : ""}
          </div>
        </div>
      )}

      {/* Outputs */}
      {definition.outputs.length > 0 && (
        <div
          style={{
            borderTop: "1px solid var(--node-border)",
            background: `linear-gradient(135deg, ${categoryColor}08, ${categoryColor}04)`,
          }}
          className="rounded-b-xl"
        >
          {definition.outputs.map((output, idx) => {
            const handleId = encodeHandleId({
              nodeId: id,
              outputName: output.name,
              outputTypes: output.types,
            });
            const color = getTypeColor(output.types);

            return (
              <div
                key={output.name}
                className={`relative flex items-center justify-end gap-2 px-4 py-2.5 ${
                  idx === definition.outputs.length - 1 ? "rounded-b-xl" : ""
                }`}
              >
                <span className="text-xs text-muted-foreground font-medium">
                  {output.display_name}
                </span>
                <div
                  className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                  style={{
                    backgroundColor: color + "18",
                    color: color,
                  }}
                >
                  {output.types[0]}
                </div>
                <PipelineHandle
                  type="source"
                  id={handleId}
                  dataTypes={output.types}
                  position={Position.Right}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Collapsed handles */}
      {collapsed && (
        <>
          {definition.inputs
            .filter((f) => f.input_types && f.input_types.length > 0)
            .map((field) => {
              const handleId = encodeHandleId({
                nodeId: id,
                inputName: field.name,
                inputTypes: field.input_types,
                fieldType: field.type,
              });
              return (
                <PipelineHandle
                  key={`collapsed-input-${field.name}`}
                  type="target"
                  id={handleId}
                  dataTypes={field.input_types!}
                  position={Position.Left}
                  style={{ top: "50%" }}
                />
              );
            })}
        </>
      )}

      {/* Execution timer footer */}
      {executionTime != null && !processing && (
        <div
          className="flex items-center justify-end gap-1.5 px-3 py-1.5"
          style={{ borderTop: "1px solid color-mix(in srgb, var(--node-border) 40%, transparent)" }}
        >
          <Timer className="h-3 w-3 text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground font-medium tabular-nums">
            {executionTime < 1000 ? `${executionTime}ms` : `${(executionTime / 1000).toFixed(2)}s`}
          </span>
        </div>
      )}

      {/* SAM Segment Select modal */}
      {segmentSelectOpen && segmentSourceImage && (
        <SegmentSelectModal
          imageUrl={segmentSourceImage}
          onApply={handleSegmentApply}
          onUpdatePreview={handleSegmentUpdatePreview}
          onClose={() => setSegmentSelectOpen(false)}
        />
      )}

      {/* Fullscreen image preview */}
      {fullscreenImage && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setFullscreenImage(null)}
        >
          <button
            className="absolute top-4 right-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 transition-colors"
            onClick={() => setFullscreenImage(null)}
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={fullscreenImage}
            alt="Full preview"
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>,
        document.body
      )}
    </div>
  );
});
