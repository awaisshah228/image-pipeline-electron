import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import type {
  PipelineNode,
  PipelineEdge,
  PipelineNodeData,
  PipelineNodeDefinition,
} from "./types";
import {
  loadPipelineNodeDefinitions,
  findPipelineNodeDefinition,
} from "./node-registry";
import { isValidPipelineConnection } from "./connection-validator";
import { generateNodeId } from "./utils";
import {
  processImage,
  getOperationForNodeType,
  isPassthroughNode,
  saveFramesToDisk,
  saveBlobToDisk,
  buildPipelineStep,
  processPipeline,
} from "./native-processor";
import {
  startWebcamCapture,
  stopWebcamCapture,
  isCapturing,
  getTotalFramesCaptured,
  getTotalFramesProcessed,
  setTotalFramesProcessed,
} from "./webcam-processor";
import {
  extractVideoFrames,
  extractVideoFrame,
  encodeFramesToVideo,
} from "./video-processor";

type HistorySnapshot = { nodes: PipelineNode[]; edges: PipelineEdge[] };

interface PipelineState {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  nodeDefinitions: Record<string, PipelineNodeDefinition[]>;
  definitionsLoaded: boolean;
  pipelineName: string;
  selectedNodeId: string | null;
  selectedNodeIds: Set<string>;
  reactFlowInstance: ReactFlowInstance | null;

  _history: HistorySnapshot[];
  _historyIndex: number;
  _pushHistory: () => void;
  undo: () => void;
  redo: () => void;

  _clipboard: { nodes: PipelineNode[]; edges: PipelineEdge[] } | null;
  copySelected: () => void;
  pasteClipboard: (position?: { x: number; y: number }) => void;
  selectAll: () => void;

  setSelectedNodeId: (id: string | null) => void;
  setSelectedNodeIds: (ids: Set<string>) => void;
  setReactFlowInstance: (instance: ReactFlowInstance) => void;
  onNodesChange: (changes: NodeChange<PipelineNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<PipelineEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (definitionType: string, position: { x: number; y: number }) => void;
  updateNodeField: (nodeId: string, fieldName: string, value: unknown) => void;
  updateNodePreview: (nodeId: string, previewUrl: string | undefined) => void;
  setNodeProcessing: (nodeId: string, processing: boolean) => void;
  setNodeError: (nodeId: string, error: string | undefined) => void;
  deleteNode: (nodeId: string) => void;
  deleteEdge: (edgeId: string) => void;
  reprocessNode: (nodeId: string) => Promise<void> | void;
  cropFaces: (nodeId: string) => void;
  loadDefinitions: () => Promise<void>;
  setPipelineName: (name: string) => void;
  clearPipeline: () => void;
  importPipeline: (nodes: PipelineNode[], edges: PipelineEdge[], name?: string) => void;
  getViewport: () => Viewport;
}

// ── Helper: update a single node's data ──
function updateNode(
  nodes: PipelineNode[],
  nodeId: string,
  updater: (data: PipelineNodeData) => Partial<PipelineNodeData>
): PipelineNode[] {
  return nodes.map((n) =>
    n.id === nodeId ? { ...n, data: { ...n.data, ...updater(n.data) } } : n
  );
}

// ── Process a node and propagate results downstream ──
async function processNodeChain(
  nodeId: string,
  imageDataUrl: string,
  get: () => PipelineState,
  set: (partial: Partial<PipelineState>) => void
) {
  const node = get().nodes.find((n) => n.id === nodeId);
  if (!node) return;

  const nodeType = node.data.definition.type;
  const operation = getOperationForNodeType(nodeType);

  let resultUrl = imageDataUrl;

  if (operation && !isPassthroughNode(nodeType)) {
    set({ nodes: updateNode(get().nodes, nodeId, () => ({ processing: true, error: undefined })) });

    try {
      const result = await processImage(operation, imageDataUrl, node.data.fieldValues);
      resultUrl = result.dataUrl;
      set({
        nodes: updateNode(get().nodes, nodeId, () => ({
          previewUrl: resultUrl,
          processing: false,
          outputData: result.metadata,
        })),
      });
    } catch (err) {
      set({
        nodes: updateNode(get().nodes, nodeId, () => ({
          processing: false,
          error: err instanceof Error ? err.message : "Processing failed",
        })),
      });
      return;
    }
  } else {
    set({ nodes: updateNode(get().nodes, nodeId, () => ({ previewUrl: resultUrl })) });
  }

  // Propagate downstream
  const currentNode = get().nodes.find((n) => n.id === nodeId);
  for (const edge of get().edges) {
    if (edge.source !== nodeId) continue;
    try {
      const sData = JSON.parse(atob(edge.sourceHandle ?? ""));
      const tData = JSON.parse(atob(edge.targetHandle ?? ""));
      const outputTypes = sData.outputTypes?.map((t: string) => t.toLowerCase()) ?? [];

      if (outputTypes.includes("image")) {
        await processNodeChain(edge.target, resultUrl, get, set);
      } else if (outputTypes.includes("number") && currentNode?.data.outputData) {
        const numValue = currentNode.data.outputData[sData.outputName] ?? currentNode.data.outputData.count;
        if (numValue !== undefined) {
          set({
            nodes: updateNode(get().nodes, edge.target, () => ({
              fieldValues: { ...get().nodes.find((n) => n.id === edge.target)!.data.fieldValues, [tData.inputName]: numValue },
              outputData: { value: numValue },
            })),
          });
        }
      } else if (outputTypes.includes("imagelist")) {
        const od = currentNode?.data.outputData;
        const imageList = (od?.faceImages ?? od?.images) as string[] | undefined;
        if (imageList && imageList.length > 0) {
          await processBatchNodeChain(edge.target, imageList, get, set);
        }
      }
    } catch { /* skip */ }
  }
}

// ── Batch process frames through a node ──
async function processBatchNodeChain(
  nodeId: string,
  frames: string[],
  get: () => PipelineState,
  set: (partial: Partial<PipelineState>) => void
) {
  const node = get().nodes.find((n) => n.id === nodeId);
  if (!node) return;

  const nodeType = node.data.definition.type;
  const operation = getOperationForNodeType(nodeType);

  // Terminal: batch_save — save directly to disk
  if (nodeType === "batch_save") {
    set({ nodes: updateNode(get().nodes, nodeId, () => ({ processing: true, error: undefined })) });
    try {
      const prefix = (node.data.fieldValues.prefix as string) ?? "frame_";
      const format = ((node.data.fieldValues.format as string) ?? "PNG").toLowerCase();
      const ext = format === "jpeg" ? "jpg" : format;
      const savedPath = await saveFramesToDisk(frames, prefix, ext, (cur, tot) => {
        set({
          nodes: updateNode(get().nodes, nodeId, () => ({
            outputData: { progress: `Saving ${cur}/${tot}` },
          })),
        });
      });
      set({
        nodes: updateNode(get().nodes, nodeId, () => ({
          processing: false,
          previewUrl: frames[0],
          outputData: { count: frames.length, saved: !!savedPath, progress: savedPath ? `Saved to ${savedPath}` : "Cancelled" },
        })),
      });
    } catch (err) {
      set({
        nodes: updateNode(get().nodes, nodeId, () => ({
          processing: false,
          error: err instanceof Error ? err.message : "Save failed",
        })),
      });
    }
    return;
  }

  // Processing node — batch process each frame via Python
  if (operation && !isPassthroughNode(nodeType)) {
    set({ nodes: updateNode(get().nodes, nodeId, () => ({ processing: true, error: undefined })) });

    try {
      const results: string[] = [];
      for (let i = 0; i < frames.length; i++) {
        const result = await processImage(operation, frames[i], node.data.fieldValues);
        results.push(result.dataUrl);
        set({
          nodes: updateNode(get().nodes, nodeId, () => ({
            previewUrl: result.dataUrl,
            outputData: { images: results, progress: `Frame ${i + 1}/${frames.length}` },
          })),
        });
      }

      set({
        nodes: updateNode(get().nodes, nodeId, () => ({
          processing: false,
          previewUrl: results[0],
          outputData: { images: results, faceImages: results, count: results.length },
        })),
      });

      // Propagate downstream
      for (const edge of get().edges) {
        if (edge.source !== nodeId) continue;
        try {
          const sData = JSON.parse(atob(edge.sourceHandle ?? ""));
          const outputTypes = sData.outputTypes?.map((t: string) => t.toLowerCase()) ?? [];
          if (outputTypes.includes("imagelist") || outputTypes.includes("image")) {
            await processBatchNodeChain(edge.target, results, get, set);
          }
        } catch { /* skip */ }
      }
    } catch (err) {
      set({
        nodes: updateNode(get().nodes, nodeId, () => ({
          processing: false,
          error: err instanceof Error ? err.message : "Batch processing failed",
        })),
      });
    }
    return;
  }

  // Passthrough / collector — store and propagate
  set({
    nodes: updateNode(get().nodes, nodeId, () => ({
      previewUrl: frames[0],
      outputData: { images: frames, count: frames.length },
    })),
  });

  for (const edge of get().edges) {
    if (edge.source !== nodeId) continue;
    try {
      const sData = JSON.parse(atob(edge.sourceHandle ?? ""));
      const outputTypes = sData.outputTypes?.map((t: string) => t.toLowerCase()) ?? [];
      if (outputTypes.includes("imagelist")) {
        await processBatchNodeChain(edge.target, frames, get, set);
      } else if (outputTypes.includes("image")) {
        await processNodeChain(edge.target, frames[0], get, set);
      }
    } catch { /* skip */ }
  }
}

// ── Streaming frame saver: writes frames to disk as they arrive ──
// Each video_save node gets a temp directory; frames are saved as frame_0001.jpg etc.
// On finalize, ffmpeg encodes the frames to a video file.
const streamingFrameDirs = new Map<string, { dir: string; count: number; startTime: number; captureFps: number }>();

// ── Fused pipeline processing for live frames ──
// Collects all processing steps in the downstream chain, sends as ONE HTTP call.
// Eliminates N-1 round-trips for N-node chains (e.g., YOLO → blur → save = 1 call).

/**
 * Walk the downstream graph from a source node, collecting:
 * - processing steps (operations with params)
 * - terminal video_save nodes
 * Result: { steps, processingNodeIds, saveNodeIds }
 */
function collectDownstreamPipeline(
  sourceNodeId: string,
  get: () => PipelineState
): {
  steps: Array<{ operation: string; params: Record<string, unknown>; nodeId: string }>;
  processingNodeIds: string[];
  saveNodeIds: string[];
  passthroughNodeIds: string[];
} {
  const steps: Array<{ operation: string; params: Record<string, unknown>; nodeId: string }> = [];
  const processingNodeIds: string[] = [];
  const saveNodeIds: string[] = [];
  const passthroughNodeIds: string[] = [];
  const visited = new Set<string>();

  // BFS walk downstream
  const bfsQueue = [sourceNodeId];
  while (bfsQueue.length > 0) {
    const currentId = bfsQueue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    for (const edge of get().edges) {
      if (edge.source !== currentId) continue;
      const targetNode = get().nodes.find((n) => n.id === edge.target);
      if (!targetNode) continue;

      const targetType = targetNode.data.definition.type;

      if (targetType === "video_save") {
        saveNodeIds.push(targetNode.id);
        // Don't continue past video_save
        continue;
      }

      const operation = getOperationForNodeType(targetType);
      if (operation && !isPassthroughNode(targetType)) {
        // Processing node — add to fused pipeline
        const step = buildPipelineStep(operation, targetNode.data.fieldValues);
        steps.push({ ...step, nodeId: targetNode.id });
        processingNodeIds.push(targetNode.id);
      } else if (isPassthroughNode(targetType)) {
        // Passthrough node (preview_image, save_image, etc.) — just show result
        passthroughNodeIds.push(targetNode.id);
      }

      // Always continue walking downstream
      bfsQueue.push(targetNode.id);
    }
  }

  return { steps, processingNodeIds, saveNodeIds, passthroughNodeIds };
}

/**
 * Process a single live frame through the fused pipeline.
 * - Collects all downstream operations into a single /pipeline/process call
 * - Saves result to video_save temp dirs
 * - Updates previews on processing and terminal nodes
 */
// Track live processing stats per source node
let _liveProcessedCount = 0;
let _liveQueueCount = 0;

export function getLiveProcessedCount(): number { return _liveProcessedCount; }
export function getLiveQueueCount(): number { return _liveQueueCount; }

async function processNodeChainLive(
  sourceNodeId: string,
  frameDataUrl: string,
  get: () => PipelineState,
  set: (partial: Partial<PipelineState>) => void,
) {
  _liveQueueCount++;

  // Update webcam node with queue/processed stats
  const captured = getTotalFramesCaptured();
  set({
    nodes: updateNode(get().nodes, sourceNodeId, () => ({
      outputData: {
        count: captured,
        processed: _liveProcessedCount,
        queue: _liveQueueCount,
        progress: `Capturing: ${captured} | Processed: ${_liveProcessedCount} | Queue: ${_liveQueueCount}`,
      },
    })),
  });

  const { steps, processingNodeIds, saveNodeIds, passthroughNodeIds } =
    collectDownstreamPipeline(sourceNodeId, get);

  let resultUrl = frameDataUrl;
  let metadata: Record<string, unknown> | undefined;

  // If we have processing steps, run them all in one fused call
  if (steps.length > 0) {
    try {
      const pipelineSteps = steps.map(({ operation, params }) => ({ operation, params }));
      const result = await processPipeline(frameDataUrl, pipelineSteps);
      resultUrl = result.dataUrl;
      metadata = result.metadata;
    } catch {
      _liveQueueCount--;
      return;
    }

    // Update all processing nodes with result
    for (const nid of processingNodeIds) {
      set({
        nodes: updateNode(get().nodes, nid, () => ({
          processing: false,
          previewUrl: resultUrl,
          ...(metadata ? { outputData: metadata } : {}),
        })),
      });
    }
  }

  _liveProcessedCount++;
  _liveQueueCount--;

  // Update webcam node stats after processing
  const capturedNow = getTotalFramesCaptured();
  set({
    nodes: updateNode(get().nodes, sourceNodeId, () => ({
      outputData: {
        count: capturedNow,
        processed: _liveProcessedCount,
        queue: _liveQueueCount,
        progress: `Capturing: ${capturedNow} | Processed: ${_liveProcessedCount} | Queue: ${_liveQueueCount}`,
      },
    })),
  });

  // Update passthrough nodes with the result
  for (const nid of passthroughNodeIds) {
    set({
      nodes: updateNode(get().nodes, nid, () => ({
        previewUrl: resultUrl,
      })),
    });
  }

  // Update save node with recording status
  for (const saveId of saveNodeIds) {
    if (capturedNow % 10 === 0 || capturedNow === 1) {
      set({
        nodes: updateNode(get().nodes, saveId, () => ({
          outputData: { frames: capturedNow, progress: `Recording: ${capturedNow} frames captured` },
        })),
      });
    }
  }
}

// Finalize all downstream video_save nodes: encode saved frames to video via ffmpeg
async function finalizeDownstreamEncoders(
  sourceNodeId: string,
  get: () => PipelineState,
  set: (partial: Partial<PipelineState>) => void
) {
  // Find all video_save nodes reachable from source
  const visited = new Set<string>();
  const bfsQueue = [sourceNodeId];
  const saveNodes: string[] = [];

  while (bfsQueue.length > 0) {
    const current = bfsQueue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const edge of get().edges) {
      if (edge.source !== current) continue;
      const targetNode = get().nodes.find((n) => n.id === edge.target);
      if (targetNode?.data.definition.type === "video_save") {
        saveNodes.push(edge.target);
      }
      bfsQueue.push(edge.target);
    }
  }

  // Encode frames from each node's temp directory
  for (const saveNodeId of saveNodes) {
    const entry = streamingFrameDirs.get(saveNodeId);
    if (!entry || entry.count === 0) continue;

    const node = get().nodes.find((n) => n.id === saveNodeId);
    const filename = (node?.data.fieldValues.filename as string) ?? "webcam_recording";
    const outputDirField = (node?.data.fieldValues.output_dir as string) ?? "";
    const codecField = (node?.data.fieldValues.codec as string) ?? "H264";
    const fps = entry.captureFps;

    set({
      nodes: updateNode(get().nodes, saveNodeId, () => ({
        processing: true,
        outputData: { progress: `Encoding ${entry.count} frames...` },
      })),
    });

    try {
      let outputPath: string;

      // Auto-save if output_dir is set, otherwise show dialog
      if (outputDirField.trim()) {
        const ext = codecField === "H264" ? "mp4" : "webm";
        outputPath = `${outputDirField.replace(/\/$/, "")}/${filename}.${ext}`;
      } else {
        const ext = codecField === "H264" ? "mp4" : "webm";
        const saveResult = await window.electronAPI.dialog.saveFile({
          defaultPath: `${filename}.${ext}`,
          filters: [
            { name: "MP4 Video", extensions: ["mp4"] },
            { name: "WebM Video", extensions: ["webm"] },
          ],
        });

        if (saveResult.canceled || !saveResult.filePath) {
          set({
            nodes: updateNode(get().nodes, saveNodeId, () => ({
              processing: false,
              outputData: { progress: "Cancelled", frames: entry.count },
            })),
          });
          continue;
        }
        outputPath = saveResult.filePath;
      }

      const codec = outputPath.endsWith(".webm") ? "libvpx-vp9" : "libx264";
      let encoded = false;

      // Strategy 1: Node.js ffmpeg (fastest)
      if (window.electronAPI?.ffmpeg) {
        try {
          const hasFfmpeg = await window.electronAPI.ffmpeg.available();
          if (hasFfmpeg) {
            const result = await window.electronAPI.ffmpeg.encode({
              framesDir: entry.dir,
              outputPath,
              fps,
              codec,
              pattern: "frame_%05d.jpg",
            });
            if (result.success) {
              encoded = true;
              const sizeMB = result.size ? (result.size / (1024 * 1024)).toFixed(1) : "?";
              set({
                nodes: updateNode(get().nodes, saveNodeId, () => ({
                  processing: false,
                  outputData: { path: outputPath, progress: `Saved: ${outputPath} (${sizeMB} MB)`, frames: entry.count, saved: true },
                })),
              });
            }
          }
        } catch { /* fall through */ }
      }

      // Strategy 2: ffmpeg via Python backend
      if (!encoded) {
        const python = window.electronAPI?.python;
        if (python) {
          try {
            const result = await python.request<{ type: string; path: string; size: number }>(
              "POST", "/video/encode", {
                frames_dir: entry.dir,
                output_path: outputPath,
                fps,
                codec,
                pattern: "frame_%05d.jpg",
              }
            );
            if (result.type === "success") {
              encoded = true;
              const sizeMB = (result.size / (1024 * 1024)).toFixed(1);
              set({
                nodes: updateNode(get().nodes, saveNodeId, () => ({
                  processing: false,
                  outputData: { path: outputPath, progress: `Saved: ${outputPath} (${sizeMB} MB)`, frames: entry.count, saved: true },
                })),
              });
            }
          } catch { /* fall through */ }
        }
      }

      // Strategy 3: Browser MediaRecorder fallback
      if (!encoded) {
        set({
          nodes: updateNode(get().nodes, saveNodeId, () => ({
            outputData: { progress: `Encoding ${entry.count} frames (browser fallback)...` },
          })),
        });

        const frames: string[] = [];
        for (let i = 1; i <= entry.count; i++) {
          const fname = `frame_${String(i).padStart(5, "0")}.jpg`;
          const dataUrl = await window.electronAPI.fs.readFileAsDataUrl(`${entry.dir}/${fname}`);
          frames.push(dataUrl);
        }

        const blob = await encodeFramesToVideo(frames, fps, (cur, tot) => {
          set({
            nodes: updateNode(get().nodes, saveNodeId, () => ({
              outputData: { progress: `Encoding ${cur}/${tot}` },
            })),
          });
        });

        const buffer = new Uint8Array(await blob.arrayBuffer());
        await window.electronAPI.fs.writeBuffer(outputPath, buffer);

        const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
        set({
          nodes: updateNode(get().nodes, saveNodeId, () => ({
            processing: false,
            outputData: { path: outputPath, progress: `Saved: ${outputPath} (${sizeMB} MB)`, frames: entry.count, saved: true },
          })),
        });
      }
    } catch (err) {
      set({
        nodes: updateNode(get().nodes, saveNodeId, () => ({
          processing: false,
          error: err instanceof Error ? err.message : "Encoding failed",
        })),
      });
    }

    // Clean up temp frames directory
    try {
      for (let i = 1; i <= entry.count; i++) {
        const fname = `frame_${String(i).padStart(5, "0")}.jpg`;
        await window.electronAPI.fs.deleteFile(`${entry.dir}/${fname}`);
      }
    } catch { /* ignore cleanup errors */ }

    streamingFrameDirs.delete(saveNodeId);
  }
}

const MAX_HISTORY = 50;

export const usePipelineStore = create<PipelineState>()(persist((set, get) => ({
  nodes: [],
  edges: [],
  nodeDefinitions: {},
  definitionsLoaded: false,
  pipelineName: "Untitled Pipeline",
  selectedNodeId: null,
  selectedNodeIds: new Set<string>(),
  reactFlowInstance: null,

  // ── History ──
  _history: [],
  _historyIndex: -1,
  _clipboard: null,

  _pushHistory: () => {
    const { nodes, edges, _history, _historyIndex } = get();
    const snapped = _history.slice(0, _historyIndex + 1);
    snapped.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
    if (snapped.length > MAX_HISTORY) snapped.shift();
    set({ _history: snapped, _historyIndex: snapped.length - 1 });
  },

  undo: () => {
    const { _history, _historyIndex, nodes, edges } = get();
    if (_historyIndex < 0) return;
    if (_historyIndex === _history.length - 1) {
      const snapped = [..._history];
      snapped.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
      set({ _history: snapped });
    }
    const snapshot = _history[_historyIndex];
    set({ nodes: structuredClone(snapshot.nodes), edges: structuredClone(snapshot.edges), _historyIndex: _historyIndex - 1 });
  },

  redo: () => {
    const { _history, _historyIndex } = get();
    const nextIdx = _historyIndex + 2;
    if (nextIdx >= _history.length) return;
    const snapshot = _history[nextIdx];
    set({ nodes: structuredClone(snapshot.nodes), edges: structuredClone(snapshot.edges), _historyIndex: _historyIndex + 1 });
  },

  // ── Clipboard ──
  copySelected: () => {
    const { nodes, edges, selectedNodeIds, selectedNodeId } = get();
    const ids = selectedNodeIds.size > 0 ? selectedNodeIds : selectedNodeId ? new Set([selectedNodeId]) : new Set<string>();
    if (ids.size === 0) return;
    set({
      _clipboard: {
        nodes: structuredClone(nodes.filter((n) => ids.has(n.id))),
        edges: structuredClone(edges.filter((e) => ids.has(e.source) && ids.has(e.target))),
      },
    });
  },

  pasteClipboard: (position) => {
    const { _clipboard } = get();
    if (!_clipboard || _clipboard.nodes.length === 0) return;
    get()._pushHistory();

    const minX = Math.min(..._clipboard.nodes.map((n) => n.position.x));
    const minY = Math.min(..._clipboard.nodes.map((n) => n.position.y));
    const offset = position ? { x: position.x - minX, y: position.y - minY } : { x: 50, y: 50 };

    const idMap = new Map<string, string>();
    const newNodes: PipelineNode[] = _clipboard.nodes.map((n) => {
      const newId = generateNodeId();
      idMap.set(n.id, newId);
      return {
        ...structuredClone(n),
        id: newId,
        position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
        selected: true,
      };
    });

    const newEdges: PipelineEdge[] = _clipboard.edges
      .filter((e) => idMap.has(e.source) && idMap.has(e.target))
      .map((e) => {
        const newSource = idMap.get(e.source)!;
        const newTarget = idMap.get(e.target)!;
        let newSourceHandle = e.sourceHandle;
        let newTargetHandle = e.targetHandle;
        try {
          if (e.sourceHandle) { const d = JSON.parse(atob(e.sourceHandle)); d.nodeId = newSource; newSourceHandle = btoa(JSON.stringify(d)); }
          if (e.targetHandle) { const d = JSON.parse(atob(e.targetHandle)); d.nodeId = newTarget; newTargetHandle = btoa(JSON.stringify(d)); }
        } catch { /* skip */ }
        return {
          ...structuredClone(e),
          id: `e_${newSource}_${newTarget}_${Date.now()}`,
          source: newSource, target: newTarget,
          sourceHandle: newSourceHandle, targetHandle: newTargetHandle,
        };
      });

    const deselected = get().nodes.map((n) => ({ ...n, selected: false }));
    set({
      nodes: [...deselected, ...newNodes],
      edges: [...get().edges, ...newEdges],
      selectedNodeIds: new Set(newNodes.map((n) => n.id)),
      selectedNodeId: newNodes.length === 1 ? newNodes[0].id : null,
    });
  },

  selectAll: () => {
    const { nodes } = get();
    set({ nodes: nodes.map((n) => ({ ...n, selected: true })), selectedNodeIds: new Set(nodes.map((n) => n.id)) });
  },

  setSelectedNodeId: (id) => set({ selectedNodeId: id }),
  setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),
  setReactFlowInstance: (instance) => set({ reactFlowInstance: instance }),

  onNodesChange: (changes) => {
    if (changes.some((c) => c.type === "remove")) get()._pushHistory();
    set({ nodes: applyNodeChanges(changes, get().nodes) });
    const selectionChanges = changes.filter((c) => c.type === "select");
    if (selectionChanges.length > 0) {
      const ids = new Set(get().nodes.filter((n) => n.selected).map((n) => n.id));
      set({ selectedNodeIds: ids });
    }
  },

  onEdgesChange: (changes) => {
    if (changes.some((c) => c.type === "remove")) get()._pushHistory();
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },

  onConnect: (connection) => {
    get()._pushHistory();
    const { nodes, edges } = get();
    const { source, target, sourceHandle, targetHandle } = connection;
    if (!source || !target) return;

    if (!isValidPipelineConnection(source, target, sourceHandle ?? null, targetHandle ?? null, nodes, edges)) return;

    let sourceOutputTypes: string[] = [];
    let targetInputTypes: string[] = [];
    let sourceOutputName = "";
    let targetInputName = "";

    try {
      const sData = JSON.parse(atob(sourceHandle ?? ""));
      const tData = JSON.parse(atob(targetHandle ?? ""));
      sourceOutputTypes = sData.outputTypes ?? [];
      targetInputTypes = tData.inputTypes ?? [];
      sourceOutputName = sData.outputName ?? "";
      targetInputName = tData.inputName ?? "";
    } catch { /* empty */ }

    const newEdge: PipelineEdge = {
      id: `e_${source}_${target}_${Date.now()}`,
      source, target,
      sourceHandle: sourceHandle ?? undefined,
      targetHandle: targetHandle ?? undefined,
      type: "pipeline", animated: true,
      data: { sourceOutputName, sourceOutputTypes, targetInputName, targetInputTypes },
    };

    set({ edges: [...edges, newEdge] });

    // Trigger processing on connection
    if (sourceOutputTypes.some((t) => t.toLowerCase() === "image")) {
      const sourceNode = nodes.find((n) => n.id === source);
      if (sourceNode?.data.previewUrl) processNodeChain(target, sourceNode.data.previewUrl, get, set);
    } else if (sourceOutputTypes.some((t) => t.toLowerCase() === "imagelist")) {
      const sourceNode = nodes.find((n) => n.id === source);
      const imageList = (sourceNode?.data.outputData?.images ?? sourceNode?.data.outputData?.faceImages) as string[] | undefined;
      if (imageList?.length) {
        // For video_save, store frames in outputData
        const targetNode = nodes.find((n) => n.id === target);
        if (targetNode?.data.definition.type === "video_save") {
          set({
            nodes: updateNode(get().nodes, target, () => ({
              outputData: { images: imageList, frames: imageList.length },
            })),
          });
        } else {
          processBatchNodeChain(target, imageList, get, set);
        }
      }
    } else if (sourceOutputTypes.some((t) => t.toLowerCase() === "number")) {
      const sourceNode = nodes.find((n) => n.id === source);
      const numVal = sourceNode?.data.outputData?.count ?? sourceNode?.data.outputData?.value;
      if (numVal !== undefined) {
        set({
          nodes: updateNode(get().nodes, target, () => ({
            outputData: { value: numVal },
          })),
        });
      }
    }
  },

  addNode: (definitionType, position) => {
    get()._pushHistory();
    const definition = findPipelineNodeDefinition(definitionType);
    if (!definition) return;

    const fieldValues: Record<string, unknown> = {};
    for (const input of definition.inputs) {
      if (input.value !== undefined) fieldValues[input.name] = input.value;
    }

    set({
      nodes: [...get().nodes, {
        id: generateNodeId(),
        type: "pipeline",
        position,
        data: { definition: structuredClone(definition), fieldValues, showNode: true },
      }],
    });
  },

  updateNodeField: (nodeId, fieldName, value) => {
    const valStr = typeof value === "string" ? value : "";
    const isImageData = valStr.includes("::") && valStr.includes("data:image");
    const imageDataUrl = isImageData ? valStr.split("::").slice(1).join("::") : undefined;

    set({
      nodes: updateNode(get().nodes, nodeId, (data) => ({
        fieldValues: { ...data.fieldValues, [fieldName]: value },
        ...(imageDataUrl ? { previewUrl: imageDataUrl } : {}),
      })),
    });

    // Auto-trigger video_load/video_frame when file field changes
    const node = get().nodes.find((n) => n.id === nodeId);
    if (node && fieldName === "file" && (node.data.definition.type === "video_load" || node.data.definition.type === "video_frame")) {
      get().reprocessNode(nodeId);
      return;
    }

    // Trigger processing downstream
    if (imageDataUrl) {
      for (const edge of get().edges) {
        if (edge.source !== nodeId) continue;
        try {
          const sData = JSON.parse(atob(edge.sourceHandle ?? ""));
          if (sData.outputTypes?.some((t: string) => t.toLowerCase() === "image")) {
            processNodeChain(edge.target, imageDataUrl, get, set);
          }
        } catch { /* skip */ }
      }
    } else {
      // Non-image field changed — re-process if node has upstream input
      const node = get().nodes.find((n) => n.id === nodeId);
      if (node && !isPassthroughNode(node.data.definition.type)) {
        for (const edge of get().edges) {
          if (edge.target !== nodeId) continue;
          try {
            const tData = JSON.parse(atob(edge.targetHandle ?? ""));
            if (tData.inputTypes?.some((t: string) => t.toLowerCase() === "image")) {
              const sourceNode = get().nodes.find((n) => n.id === edge.source);
              if (sourceNode?.data.previewUrl) {
                processNodeChain(nodeId, sourceNode.data.previewUrl, get, set);
                break;
              }
            }
          } catch { /* skip */ }
        }
      }
    }
  },

  updateNodePreview: (nodeId, previewUrl) => {
    set({ nodes: updateNode(get().nodes, nodeId, () => ({ previewUrl })) });
  },

  setNodeProcessing: (nodeId, processing) => {
    set({ nodes: updateNode(get().nodes, nodeId, () => ({ processing })) });
  },

  setNodeError: (nodeId, error) => {
    set({ nodes: updateNode(get().nodes, nodeId, () => ({ error })) });
  },

  deleteNode: (nodeId) => {
    get()._pushHistory();
    set({
      nodes: get().nodes.filter((n) => n.id !== nodeId),
      edges: get().edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      selectedNodeId: get().selectedNodeId === nodeId ? null : get().selectedNodeId,
    });
  },

  deleteEdge: (edgeId) => {
    set({ edges: get().edges.filter((e) => e.id !== edgeId) });
  },

  reprocessNode: async (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const nodeType = node.data.definition.type;

    // ── Webcam Capture: 3-phase pipeline ──
    // Phase 1: CAPTURE — save raw frames to disk at full FPS (no processing, no lag)
    // Phase 2: PROCESS — Python batch-processes all frames from disk → disk
    // Phase 3: ENCODE — ffmpeg combines processed frames into smooth video
    if (nodeType === "webcam_capture") {
      if (isCapturing()) {
        // Stop capture — processing will continue after
        stopWebcamCapture();
        return;
      }

      const source = (node.data.fieldValues.source as string) ?? "Webcam";
      const streamUrl = node.data.fieldValues.stream_url as string | undefined;
      const captureFps = Number(node.data.fieldValues.capture_fps ?? 30);
      const maxFrames = Number(node.data.fieldValues.max_frames ?? 0);

      // Create temp directory for raw frames inside app's userData dir
      const appData = await window.electronAPI.app.getPath("userData");
      const framesBase = `${appData}/pipeline_frames`;
      await window.electronAPI.fs.mkdir(framesBase);

      // Clean up previous frame directories for this node
      try {
        const existingDirs = await window.electronAPI.fs.readDir(framesBase);
        for (const entry of existingDirs) {
          if (entry.isDirectory && entry.name.startsWith(`raw_${nodeId}`)) {
            // Delete all files inside, then the directory
            try {
              const files = await window.electronAPI.fs.readDir(entry.path);
              for (const f of files) {
                if (f.isFile) await window.electronAPI.fs.deleteFile(f.path);
              }
              // Also clean up _processed sibling if it exists
              const processedPath = `${entry.path}_processed`;
              if (await window.electronAPI.fs.exists(processedPath)) {
                const pFiles = await window.electronAPI.fs.readDir(processedPath);
                for (const f of pFiles) {
                  if (f.isFile) await window.electronAPI.fs.deleteFile(f.path);
                }
              }
            } catch { /* ignore cleanup errors */ }
          }
        }
      } catch { /* framesBase didn't exist yet */ }

      const rawDir = `${framesBase}/raw_${nodeId}_${Date.now()}`;
      await window.electronAPI.fs.mkdir(rawDir);

      // Reset live processing counters
      _liveProcessedCount = 0;
      _liveQueueCount = 0;

      set({ nodes: updateNode(get().nodes, nodeId, () => ({ processing: true, error: undefined })) });

      startWebcamCapture({
        source: source as "Webcam" | "Stream URL",
        streamUrl,
        captureFps,
        maxFrames: maxFrames > 0 ? maxFrames : undefined,
        framesDir: rawDir,
        onFrame: (index, dataUrl) => {
          // Real-time processing: process every 3rd frame through downstream pipeline
          // processNodeChainLive updates webcam node stats (count, processed, queue)
          // Fire-and-forget — don't await
          if (index % 3 === 0 || index === 1) {
            processNodeChainLive(nodeId, dataUrl, get, set);
          } else if (index % 5 === 0) {
            // For non-processed frames, still update capture count
            set({
              nodes: updateNode(get().nodes, nodeId, () => ({
                outputData: {
                  count: index,
                  processed: _liveProcessedCount,
                  queue: _liveQueueCount,
                  progress: `Capturing: ${index} | Processed: ${_liveProcessedCount} | Queue: ${_liveQueueCount}`,
                },
              })),
            });
          }
        },
        onStopped: async (totalFrames, framesDir, actualFps) => {
          console.log(`[Pipeline] onStopped: ${totalFrames} frames, actual FPS: ${actualFps}`);
          // Keep loader spinning on webcam node until everything finishes
          set({
            nodes: updateNode(get().nodes, nodeId, () => ({
              processing: true,
              outputData: { count: totalFrames, progress: `Stopped. Processing ${totalFrames} frames...` },
            })),
          });

          const { steps, processingNodeIds, saveNodeIds, passthroughNodeIds } =
            collectDownstreamPipeline(nodeId, get);

          console.log("[Pipeline] Phase 2 starting:", {
            totalFrames, framesDir, stepsCount: steps.length,
            processingNodes: processingNodeIds.length,
            saveNodes: saveNodeIds.length,
          });

          let processedDir = framesDir;

          if (steps.length > 0) {
            processedDir = `${framesDir}_processed`;
            await window.electronAPI.fs.mkdir(processedDir);

            for (const nid of processingNodeIds) {
              set({
                nodes: updateNode(get().nodes, nid, () => ({
                  processing: true,
                  outputData: { progress: `Batch processing ${totalFrames} frames...` },
                })),
              });
            }

            const pipelineSteps = steps.map(({ operation, params }) => ({ operation, params }));
            const python = window.electronAPI?.python;

            if (!python) {
              console.error("[Pipeline] Python backend not available");
              processedDir = framesDir;
            } else {
              try {
                const batchResult = await python.request("POST", "/pipeline/batch", {
                  input_dir: framesDir,
                  output_dir: processedDir,
                  steps: pipelineSteps,
                  pattern: "frame_*.jpg",
                });
                console.log("[Pipeline] Batch result:", batchResult);
              } catch (err) {
                console.error("[Pipeline] Batch processing failed:", err);
                processedDir = framesDir;
              }
            }

            // Show last processed frame on processing nodes
            for (const nid of processingNodeIds) {
              try {
                const lastFrame = `frame_${String(totalFrames).padStart(5, "0")}.jpg`;
                const previewUrl = await window.electronAPI.fs.readFileAsDataUrl(
                  `${processedDir}/${lastFrame}`
                );
                set({
                  nodes: updateNode(get().nodes, nid, () => ({
                    processing: false,
                    previewUrl,
                    outputData: { progress: `Processed ${totalFrames} frames` },
                  })),
                });
              } catch {
                set({ nodes: updateNode(get().nodes, nid, () => ({ processing: false })) });
              }
            }

            for (const nid of passthroughNodeIds) {
              try {
                const lastFrame = `frame_${String(totalFrames).padStart(5, "0")}.jpg`;
                const previewUrl = await window.electronAPI.fs.readFileAsDataUrl(
                  `${processedDir}/${lastFrame}`
                );
                set({ nodes: updateNode(get().nodes, nid, () => ({ previewUrl })) });
              } catch { /* skip */ }
            }

            setTotalFramesProcessed(totalFrames);
          }

          // ── Phase 3: ENCODE — auto-save video ──
          if (saveNodeIds.length > 0) {
            set({
              nodes: updateNode(get().nodes, nodeId, () => ({
                outputData: { count: totalFrames, progress: `Encoding video...` },
              })),
            });

            for (const saveId of saveNodeIds) {
              streamingFrameDirs.set(saveId, {
                dir: processedDir,
                count: totalFrames,
                startTime: 0,
                captureFps: actualFps, // Use actual measured FPS, not requested
              });
            }

            await finalizeDownstreamEncoders(nodeId, get, set);
          }

          // All done — clear loader
          set({
            nodes: updateNode(get().nodes, nodeId, () => ({
              processing: false,
              outputData: {
                count: totalFrames,
                processed: totalFrames,
                progress: `Done: ${totalFrames} frames`,
              },
            })),
          });
        },
        onError: (err) => {
          set({
            nodes: updateNode(get().nodes, nodeId, () => ({
              processing: false,
              error: err.message,
            })),
          });
        },
      });
      return;
    }

    // ── Video Load: extract frames ──
    if (nodeType === "video_load") {
      const fileField = node.data.fieldValues.file as string;
      if (!fileField) return;

      const videoSrc = fileField.includes("data:") ? fileField.split("::").slice(1).join("::") : fileField;
      const fps = Number(node.data.fieldValues.fps ?? 1) || 1;
      const maxFrames = Number(node.data.fieldValues.max_frames ?? 30) || 30;
      const maxRes = Number(node.data.fieldValues.max_resolution ?? 0) || 0;

      set({ nodes: updateNode(get().nodes, nodeId, () => ({ processing: true, error: undefined })) });

      extractVideoFrames(videoSrc, fps, maxFrames, "image/jpeg", 0.85, maxRes, (blobUrl, idx, total) => {
        set({
          nodes: updateNode(get().nodes, nodeId, () => ({
            previewUrl: blobUrl,
            outputData: { progress: `Frame ${idx + 1}/${total}` },
          })),
        });
      })
        .then((frames) => {
          set({
            nodes: updateNode(get().nodes, nodeId, () => ({
              processing: false,
              previewUrl: frames[0],
              outputData: { images: frames, count: frames.length, fps },
            })),
          });
          // Propagate frames downstream
          for (const edge of get().edges) {
            if (edge.source !== nodeId) continue;
            try {
              const sData = JSON.parse(atob(edge.sourceHandle ?? ""));
              const outputTypes = sData.outputTypes?.map((t: string) => t.toLowerCase()) ?? [];
              if (outputTypes.includes("imagelist")) {
                processBatchNodeChain(edge.target, frames, get, set);
              } else if (outputTypes.includes("image") && frames[0]) {
                processNodeChain(edge.target, frames[0], get, set);
              }
            } catch { /* skip */ }
          }
        })
        .catch((err) => {
          set({
            nodes: updateNode(get().nodes, nodeId, () => ({
              processing: false,
              error: err instanceof Error ? err.message : "Frame extraction failed",
            })),
          });
        });
      return;
    }

    // ── Video Frame Extract ──
    if (nodeType === "video_frame") {
      const fileField = node.data.fieldValues.file as string;
      if (!fileField) return;

      const videoSrc = fileField.includes("data:") ? fileField.split("::").slice(1).join("::") : fileField;
      const time = Number(node.data.fieldValues.time ?? 0);

      set({ nodes: updateNode(get().nodes, nodeId, () => ({ processing: true, error: undefined })) });

      extractVideoFrame(videoSrc, time)
        .then((result) => {
          set({
            nodes: updateNode(get().nodes, nodeId, () => ({
              processing: false,
              previewUrl: result.frameDataUrl,
              outputData: { width: result.width, height: result.height, duration: result.duration },
            })),
          });
          // Propagate
          for (const edge of get().edges) {
            if (edge.source !== nodeId) continue;
            try {
              const sData = JSON.parse(atob(edge.sourceHandle ?? ""));
              if (sData.outputTypes?.some((t: string) => t.toLowerCase() === "image")) {
                processNodeChain(edge.target, result.frameDataUrl, get, set);
              }
            } catch { /* skip */ }
          }
        })
        .catch((err) => {
          set({
            nodes: updateNode(get().nodes, nodeId, () => ({
              processing: false,
              error: err instanceof Error ? err.message : "Frame extraction failed",
            })),
          });
        });
      return;
    }

    // ── Video Save: encode frames to video ──
    if (nodeType === "video_save") {
      const frames = (node.data.outputData?.images ?? node.data.outputData?.frames) as string[] | undefined;
      if (!frames?.length) return;

      const fps = Number(node.data.fieldValues.fps ?? 30);
      const filename = (node.data.fieldValues.filename as string) ?? "output";

      set({ nodes: updateNode(get().nodes, nodeId, () => ({ processing: true, error: undefined })) });

      encodeFramesToVideo(frames, fps, (cur, tot) => {
        set({
          nodes: updateNode(get().nodes, nodeId, () => ({
            outputData: { ...node.data.outputData, progress: `Encoding ${cur}/${tot}` },
          })),
        });
      })
        .then(async (blob) => {
          const saved = await saveBlobToDisk(blob, `${filename}.webm`, [
            { name: "WebM Video", extensions: ["webm"] },
          ]);
          set({
            nodes: updateNode(get().nodes, nodeId, () => ({
              processing: false,
              outputData: { ...node.data.outputData, progress: saved ? `Saved: ${saved}` : "Cancelled" },
            })),
          });
        })
        .catch((err) => {
          set({
            nodes: updateNode(get().nodes, nodeId, () => ({
              processing: false,
              error: err instanceof Error ? err.message : "Video encoding failed",
            })),
          });
        });
      return;
    }

    // ── Default: re-run processing chain ──
    const incomingEdge = get().edges.find((e) => {
      if (e.target !== nodeId) return false;
      try {
        const d = JSON.parse(atob(e.targetHandle ?? ""));
        return d.inputTypes?.some((t: string) => t.toLowerCase() === "image");
      } catch { return false; }
    });

    if (incomingEdge) {
      const sourceNode = get().nodes.find((n) => n.id === incomingEdge.source);
      if (sourceNode?.data.previewUrl) processNodeChain(nodeId, sourceNode.data.previewUrl, get, set);
    } else if (node.data.previewUrl) {
      for (const edge of get().edges) {
        if (edge.source !== nodeId) continue;
        try {
          const sData = JSON.parse(atob(edge.sourceHandle ?? ""));
          const outputTypes = sData.outputTypes?.map((t: string) => t.toLowerCase()) ?? [];
          if (outputTypes.includes("image")) {
            processNodeChain(edge.target, node.data.previewUrl!, get, set);
          } else if (outputTypes.includes("imagelist")) {
            const imageList = (node.data.outputData?.images ?? node.data.outputData?.faceImages) as string[] | undefined;
            if (imageList?.length) processBatchNodeChain(edge.target, imageList, get, set);
          }
        } catch { /* skip */ }
      }
    }
  },

  cropFaces: async (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const faces = node.data.outputData?.faces as Array<{ x: number; y: number; w: number; h: number }> | undefined;
    if (!faces?.length) return;

    let sourceImageUrl: string | undefined;
    for (const edge of get().edges) {
      if (edge.target !== nodeId) continue;
      try {
        const tData = JSON.parse(atob(edge.targetHandle ?? ""));
        if (tData.inputTypes?.some((t: string) => t.toLowerCase() === "image")) {
          const sourceNode = get().nodes.find((n) => n.id === edge.source);
          if (sourceNode?.data.previewUrl) { sourceImageUrl = sourceNode.data.previewUrl; break; }
        }
      } catch { /* skip */ }
    }
    if (!sourceImageUrl) return;

    set({ nodes: updateNode(get().nodes, nodeId, () => ({ processing: true })) });

    try {
      const img = new window.Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to load source image"));
        img.src = sourceImageUrl!;
      });

      const faceImages: string[] = [];
      for (const face of faces) {
        const canvas = document.createElement("canvas");
        const pad = Math.round(Math.max(face.w, face.h) * 0.2);
        const sx = Math.max(0, face.x - pad);
        const sy = Math.max(0, face.y - pad);
        const sw = Math.min(img.width - sx, face.w + pad * 2);
        const sh = Math.min(img.height - sy, face.h + pad * 2);
        canvas.width = sw;
        canvas.height = sh;
        canvas.getContext("2d")!.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        faceImages.push(canvas.toDataURL("image/png"));
      }

      set({
        nodes: updateNode(get().nodes, nodeId, (data) => ({
          processing: false,
          outputData: { ...data.outputData, faceImages },
        })),
      });

      // Propagate face images downstream
      for (const edge of get().edges) {
        if (edge.source !== nodeId) continue;
        try {
          const sData = JSON.parse(atob(edge.sourceHandle ?? ""));
          if (sData.outputTypes?.some((t: string) => t.toLowerCase() === "imagelist")) {
            set({
              nodes: updateNode(get().nodes, edge.target, () => ({
                outputData: { images: faceImages },
              })),
            });
          }
        } catch { /* skip */ }
      }
    } catch (err) {
      set({
        nodes: updateNode(get().nodes, nodeId, () => ({
          processing: false,
          error: err instanceof Error ? err.message : "Face cropping failed",
        })),
      });
    }
  },

  loadDefinitions: async () => {
    const defs = await loadPipelineNodeDefinitions();
    set({ nodeDefinitions: defs, definitionsLoaded: true });
  },

  setPipelineName: (name) => set({ pipelineName: name }),
  clearPipeline: () => set({ nodes: [], edges: [], selectedNodeId: null }),

  importPipeline: (nodes, edges, name) => {
    set({ nodes, edges, pipelineName: name ?? get().pipelineName, selectedNodeId: null });
  },

  getViewport: () => {
    return get().reactFlowInstance?.getViewport() ?? { x: 0, y: 0, zoom: 1 };
  },
}), {
  name: "pipeline-store",
  partialize: (state) => ({
    nodes: state.nodes.map((n) => {
      const cleanFields: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(n.data.fieldValues)) {
        if (typeof val === "string" && (val.includes("data:image") || val.includes("data:video") || val.startsWith("blob:"))) continue;
        cleanFields[key] = val;
      }
      return {
        ...n,
        data: { ...n.data, fieldValues: cleanFields, previewUrl: undefined, processing: false, error: undefined, outputData: undefined },
      };
    }),
    edges: state.edges,
    pipelineName: state.pipelineName,
  }),
}));
