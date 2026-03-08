import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  X,
  MousePointer,
  Eraser,
  Play,
  Loader2,
  Undo2,
  Square,
  Crosshair,
  RotateCcw,
  History,
} from "lucide-react";

interface Point {
  x: number; // normalized 0-1
  y: number;
  label: 1 | 0; // 1=keep, 0=remove
}

interface Box {
  x1: number; // normalized 0-1
  y1: number;
  x2: number;
  y2: number;
}

type Tool = "point" | "box";

interface SegmentSelectModalProps {
  imageUrl: string;
  onApply: (
    points: number[][],
    pointLabels: number[],
    box?: number[],
    currentImage?: string
  ) => Promise<string | undefined>;
  onUpdatePreview: (imageUrl: string) => void;
  onClose: () => void;
}

export function SegmentSelectModal({
  imageUrl,
  onApply,
  onUpdatePreview,
  onClose,
}: SegmentSelectModalProps) {
  const [points, setPoints] = useState<Point[]>([]);
  const [box, setBox] = useState<Box | null>(null);
  const [mode, setMode] = useState<"keep" | "remove">("keep");
  const [tool, setTool] = useState<Tool>("point");
  const [processing, setProcessing] = useState(false);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  // History: stack of image URLs for undo. First entry is always the original.
  const [imageHistory, setImageHistory] = useState<string[]>([imageUrl]);
  const currentImage = imageHistory[imageHistory.length - 1];
  const [hoveredPoint, setHoveredPoint] = useState<number | null>(null);
  const [draggingPoint, setDraggingPoint] = useState<number | null>(null);
  const [boxDraw, setBoxDraw] = useState<{
    startX: number;
    startY: number;
    curX: number;
    curY: number;
  } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "z" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (tool === "point") {
          setPoints((prev) => prev.slice(0, -1));
        } else {
          setBox(null);
        }
      }
      // Tool shortcuts
      if (e.key === "p" || e.key === "1") setTool("point");
      if (e.key === "b" || e.key === "2") setTool("box");
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, tool]);

  const handleImageLoad = useCallback(() => {
    if (imgRef.current) {
      setImgSize({
        w: imgRef.current.naturalWidth,
        h: imgRef.current.naturalHeight,
      });
    }
  }, []);

  // Get normalized coords from mouse event
  const getNormCoords = useCallback(
    (e: React.MouseEvent<HTMLDivElement> | MouseEvent) => {
      const container = containerRef.current;
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(
        0,
        Math.min(1, (e.clientY - rect.top) / rect.height)
      );
      return { x, y };
    },
    []
  );

  // Point tool: click to place
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (processing || draggingPoint !== null) return;
      if (tool !== "point") return;
      const coords = getNormCoords(e);
      if (!coords) return;
      setPoints((prev) => [
        ...prev,
        { x: coords.x, y: coords.y, label: mode === "keep" ? 1 : 0 },
      ]);
    },
    [mode, processing, tool, draggingPoint, getNormCoords]
  );

  // Point dragging
  const handlePointMouseDown = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.stopPropagation();
      e.preventDefault();
      setDraggingPoint(index);

      const handleMouseMove = (moveE: MouseEvent) => {
        const coords = getNormCoords(moveE);
        if (!coords) return;
        setPoints((prev) =>
          prev.map((p, i) =>
            i === index ? { ...p, x: coords.x, y: coords.y } : p
          )
        );
      };

      const handleMouseUp = () => {
        setDraggingPoint(null);
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [getNormCoords]
  );

  // Right-click to delete point
  const handlePointContextMenu = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.preventDefault();
      e.stopPropagation();
      setPoints((prev) => prev.filter((_, i) => i !== index));
    },
    []
  );

  // Box tool: drag to draw
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (processing || tool !== "box") return;
      const coords = getNormCoords(e);
      if (!coords) return;
      setBoxDraw({
        startX: coords.x,
        startY: coords.y,
        curX: coords.x,
        curY: coords.y,
      });
    },
    [processing, tool, getNormCoords]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!boxDraw || tool !== "box") return;
      const coords = getNormCoords(e);
      if (!coords) return;
      setBoxDraw((prev) =>
        prev ? { ...prev, curX: coords.x, curY: coords.y } : null
      );
    },
    [boxDraw, tool, getNormCoords]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!boxDraw || tool !== "box") return;
      const coords = getNormCoords(e);
      if (!coords) return;

      const x1 = Math.min(boxDraw.startX, coords.x);
      const y1 = Math.min(boxDraw.startY, coords.y);
      const x2 = Math.max(boxDraw.startX, coords.x);
      const y2 = Math.max(boxDraw.startY, coords.y);

      // Only set box if it's a meaningful size (not just a click)
      if (Math.abs(x2 - x1) > 0.01 && Math.abs(y2 - y1) > 0.01) {
        setBox({ x1, y1, x2, y2 });
      }
      setBoxDraw(null);
    },
    [boxDraw, tool, getNormCoords]
  );

  const handleApply = useCallback(async () => {
    if (points.length === 0 && !box) return;
    if (!imgSize.w) return;
    setProcessing(true);
    try {
      const pixelPoints = points.map((p) => [
        Math.round(p.x * imgSize.w),
        Math.round(p.y * imgSize.h),
      ]);
      const labels = points.map((p) => p.label);

      let pixelBox: number[] | undefined;
      if (box) {
        pixelBox = [
          Math.round(box.x1 * imgSize.w),
          Math.round(box.y1 * imgSize.h),
          Math.round(box.x2 * imgSize.w),
          Math.round(box.y2 * imgSize.h),
        ];
      }

      const resultUrl = await onApply(pixelPoints, labels, pixelBox, currentImage);
      if (resultUrl) {
        setImageHistory((prev) => [...prev, resultUrl]);
        // Clear points/box for next iteration
        setPoints([]);
        setBox(null);
      }
    } finally {
      setProcessing(false);
    }
  }, [points, box, imgSize, onApply, currentImage]);

  const handleUndoApply = useCallback(() => {
    if (imageHistory.length <= 1) return;
    const newHistory = imageHistory.slice(0, -1);
    setImageHistory(newHistory);
    setPoints([]);
    setBox(null);
    onUpdatePreview(newHistory[newHistory.length - 1]);
  }, [imageHistory, onUpdatePreview]);

  const handleResetToOriginal = useCallback(() => {
    setImageHistory([imageUrl]);
    setPoints([]);
    setBox(null);
    onUpdatePreview(imageUrl);
  }, [imageUrl, onUpdatePreview]);

  const hasInput = points.length > 0 || box !== null;

  // Active box for rendering (either committed or in-progress)
  const renderBox = boxDraw
    ? {
        x1: Math.min(boxDraw.startX, boxDraw.curX),
        y1: Math.min(boxDraw.startY, boxDraw.curY),
        x2: Math.max(boxDraw.startX, boxDraw.curX),
        y2: Math.max(boxDraw.startY, boxDraw.curY),
      }
    : box;

  const cursorClass =
    tool === "point"
      ? "cursor-crosshair"
      : tool === "box"
        ? "cursor-crosshair"
        : "cursor-crosshair";

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-black/85 backdrop-blur-sm">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-3 w-full max-w-4xl">
        <MousePointer className="h-4 w-4 text-orange-400" />
        <span className="text-sm font-semibold text-white">
          Smart Select — Click to select objects
        </span>
        <span className="text-xs text-neutral-400 ml-2">
          {tool === "point"
            ? "Click to place points · Drag to move · Right-click to delete"
            : "Drag to draw selection box"}
        </span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Image + points overlay */}
      <div className="flex-1 flex items-center justify-center px-4 pb-2 w-full max-w-4xl min-h-0">
        <div
          ref={containerRef}
          className={`relative ${cursorClass} select-none`}
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          style={{ maxHeight: "70vh", maxWidth: "100%" }}
        >
          <img
            ref={imgRef}
            src={currentImage}
            alt="Select objects"
            onLoad={handleImageLoad}
            className="rounded-lg object-contain"
            style={{
              maxHeight: "70vh",
              maxWidth: "100%",
              pointerEvents: "none",
            }}
            draggable={false}
          />

          {/* Box overlay */}
          {renderBox && (
            <div
              className="absolute border-2 border-orange-400 bg-orange-400/10 rounded-sm"
              style={{
                left: `${renderBox.x1 * 100}%`,
                top: `${renderBox.y1 * 100}%`,
                width: `${(renderBox.x2 - renderBox.x1) * 100}%`,
                height: `${(renderBox.y2 - renderBox.y1) * 100}%`,
                pointerEvents: "none",
              }}
            >
              {/* Corner handles */}
              {!boxDraw && box && (
                <>
                  <div className="absolute -top-1 -left-1 w-2.5 h-2.5 bg-orange-400 rounded-sm border border-white" />
                  <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-orange-400 rounded-sm border border-white" />
                  <div className="absolute -bottom-1 -left-1 w-2.5 h-2.5 bg-orange-400 rounded-sm border border-white" />
                  <div className="absolute -bottom-1 -right-1 w-2.5 h-2.5 bg-orange-400 rounded-sm border border-white" />
                </>
              )}
            </div>
          )}

          {/* Point markers */}
          {points.map((p, i) => {
            const isKeep = p.label === 1;
            const isHovered = hoveredPoint === i;
            const isDragging = draggingPoint === i;
            return (
              <div
                key={i}
                className="absolute"
                style={{
                  left: `${p.x * 100}%`,
                  top: `${p.y * 100}%`,
                  transform: "translate(-50%, -50%)",
                  zIndex: isDragging ? 50 : isHovered ? 40 : 10,
                  cursor: isDragging ? "grabbing" : "grab",
                }}
                onMouseDown={(e) => handlePointMouseDown(e, i)}
                onMouseEnter={() => setHoveredPoint(i)}
                onMouseLeave={() => setHoveredPoint(null)}
                onContextMenu={(e) => handlePointContextMenu(e, i)}
              >
                {/* Outer ring on hover */}
                <div
                  className="absolute inset-0 rounded-full transition-all duration-150"
                  style={{
                    width: isHovered || isDragging ? 28 : 20,
                    height: isHovered || isDragging ? 28 : 20,
                    left: "50%",
                    top: "50%",
                    transform: "translate(-50%, -50%)",
                    backgroundColor: isKeep
                      ? "rgba(34,197,94,0.15)"
                      : "rgba(239,68,68,0.15)",
                    border: `2px solid ${isKeep ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)"}`,
                    opacity: isHovered || isDragging ? 1 : 0,
                  }}
                />
                {/* Main dot */}
                <div
                  className="rounded-full border-2 border-white shadow-lg transition-all duration-150"
                  style={{
                    width: isHovered || isDragging ? 18 : 14,
                    height: isHovered || isDragging ? 18 : 14,
                    backgroundColor: isKeep ? "#22c55e" : "#ef4444",
                    boxShadow: isDragging
                      ? `0 0 12px ${isKeep ? "rgba(34,197,94,0.6)" : "rgba(239,68,68,0.6)"}`
                      : "0 2px 6px rgba(0,0,0,0.4)",
                  }}
                />
                {/* Crosshair inside dot */}
                <div
                  className="absolute pointer-events-none"
                  style={{
                    left: "50%",
                    top: "50%",
                    transform: "translate(-50%, -50%)",
                  }}
                >
                  <div
                    className="bg-white/80"
                    style={{ width: 1, height: 6, position: "absolute", left: 0, top: -3 }}
                  />
                  <div
                    className="bg-white/80"
                    style={{ width: 6, height: 1, position: "absolute", left: -3, top: 0 }}
                  />
                </div>
                {/* Label */}
                <span
                  className="absolute -top-6 left-1/2 -translate-x-1/2 text-[10px] font-bold text-white bg-black/70 px-1.5 py-0.5 rounded whitespace-nowrap pointer-events-none"
                  style={{
                    opacity: isHovered || isDragging ? 1 : 0.8,
                  }}
                >
                  {i + 1} · {isKeep ? "keep" : "remove"}
                </span>
              </div>
            );
          })}

          {/* Processing overlay */}
          {processing && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-lg">
              <div className="flex items-center gap-2 text-white text-sm">
                <Loader2 className="h-5 w-5 animate-spin" />
                Segmenting...
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom toolbar */}
      <div className="flex items-center gap-2 px-4 py-3 w-full max-w-4xl">
        {/* Tool switcher */}
        <div className="flex rounded-lg border border-neutral-700 overflow-hidden mr-1">
          <button
            onClick={() => setTool("point")}
            title="Point tool (P)"
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-r border-neutral-700 ${
              tool === "point"
                ? "bg-orange-500/20 text-orange-400"
                : "text-neutral-400 hover:text-white"
            }`}
          >
            <Crosshair className="h-3 w-3" />
            Point
          </button>
          <button
            onClick={() => setTool("box")}
            title="Box select tool (B)"
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
              tool === "box"
                ? "bg-orange-500/20 text-orange-400"
                : "text-neutral-400 hover:text-white"
            }`}
          >
            <Square className="h-3 w-3" />
            Box
          </button>
        </div>

        {/* Separator */}
        <div className="w-px h-5 bg-neutral-700" />

        {/* Mode toggle (only for point tool) */}
        {tool === "point" && (
          <div className="flex rounded-lg border border-neutral-700 overflow-hidden">
            <button
              onClick={() => setMode("keep")}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-r border-neutral-700 ${
                mode === "keep"
                  ? "bg-green-500/20 text-green-400"
                  : "text-neutral-400 hover:text-white"
              }`}
            >
              <div className="h-2.5 w-2.5 rounded-full bg-green-500" />
              Keep
            </button>
            <button
              onClick={() => setMode("remove")}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === "remove"
                  ? "bg-red-500/20 text-red-400"
                  : "text-neutral-400 hover:text-white"
              }`}
            >
              <div className="h-2.5 w-2.5 rounded-full bg-red-500" />
              Remove
            </button>
          </div>
        )}

        <button
          onClick={() => {
            if (tool === "point") {
              setPoints((prev) => prev.slice(0, -1));
            } else {
              setBox(null);
            }
          }}
          disabled={
            (tool === "point" ? points.length === 0 : !box) || processing
          }
          className="flex items-center gap-1.5 rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 hover:text-white disabled:opacity-30 transition-colors"
        >
          <Undo2 className="h-3 w-3" />
          Undo
        </button>

        <button
          onClick={() => {
            setPoints([]);
            setBox(null);
          }}
          disabled={!hasInput || processing}
          className="flex items-center gap-1.5 rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 hover:text-white disabled:opacity-30 transition-colors"
        >
          <Eraser className="h-3 w-3" />
          Clear
        </button>

        {/* Separator */}
        {imageHistory.length > 1 && (
          <div className="w-px h-5 bg-neutral-700" />
        )}

        {/* Undo last apply */}
        <button
          onClick={handleUndoApply}
          disabled={imageHistory.length <= 1 || processing}
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
            imageHistory.length > 1
              ? "border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
              : "border-neutral-700 text-neutral-400 disabled:opacity-30"
          }`}
        >
          <History className="h-3 w-3" />
          Undo Apply
          {imageHistory.length > 1 && (
            <span className="text-[10px] opacity-60">
              ({imageHistory.length - 1})
            </span>
          )}
        </button>

        {/* Reset to original */}
        <button
          onClick={handleResetToOriginal}
          disabled={imageHistory.length <= 1 || processing}
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
            imageHistory.length > 1
              ? "border-red-500/30 text-red-400 hover:bg-red-500/10"
              : "border-neutral-700 text-neutral-400 disabled:opacity-30"
          }`}
        >
          <RotateCcw className="h-3 w-3" />
          Reset
        </button>

        <div className="flex-1" />

        <span className="text-xs text-neutral-500">
          {points.length > 0 && (
            <>
              {points.length} point{points.length !== 1 ? "s" : ""}
            </>
          )}
          {points.length > 0 && box && " + "}
          {box && "box"}
          {!hasInput && "No selection"}
        </span>

        <button
          onClick={handleApply}
          disabled={!hasInput || processing}
          className="flex items-center gap-1.5 rounded-lg bg-orange-500/15 border border-orange-500/30 px-4 py-1.5 text-xs font-semibold text-orange-400 hover:bg-orange-500/25 disabled:opacity-30 transition-colors"
        >
          {processing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Apply
        </button>
      </div>
    </div>,
    document.body
  );
}
