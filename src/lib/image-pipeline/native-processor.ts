// Unified native processor — delegates all image/CV/ML processing to Python backend
// Replaces: image-processor.ts, opencv-processor.ts, yolo-processor.ts (all Web Workers)

const api = () => window.electronAPI?.python;

// ── Operation Routing ──

// Operations handled by Python OpenCV
const OPENCV_OPERATIONS = new Set([
  "face_detect_cv", "contour_detect", "canny_edge", "histogram_eq",
  "morphology", "color_space", "adaptive_threshold", "color_detect",
  "gaussian_blur_cv", "bilateral_filter", "people_detect", "cascade_detect",
]);

// Operations handled by Python Pillow (basic image transforms)
const IMAGE_OPERATIONS = new Set([
  "flip", "rotate", "resize", "crop", "pad",
  "brightness_contrast", "hue_saturation", "color_balance", "levels",
  "invert", "grayscale", "opacity",
  "blur", "sharpen", "denoise", "edge_detect", "threshold",
]);

// Passthrough nodes (no processing)
const PASSTHROUGH_NODES = new Set([
  "load_image", "load_image_url", "preview_image", "save_image", "image_info",
  "text_input", "number_input", "color_input", "load_model", "load_model_url",
  "api_process", "note", "compare", "math", "text_append", "switch",
  "batch_load", "batch_save", "iterator", "collector",
  "video_load", "video_save", "webcam_capture",
  "interpolate_models", "tile_split", "tile_merge", "blend",
  "number_display", "image_gallery",
]);

export function isPassthroughNode(nodeType: string): boolean {
  return PASSTHROUGH_NODES.has(nodeType);
}

export function getOperationForNodeType(nodeType: string): string | null {
  if (nodeType === "yolo_detect") return "yolo_detect";
  if (OPENCV_OPERATIONS.has(nodeType)) return nodeType;
  if (IMAGE_OPERATIONS.has(nodeType)) return nodeType;
  return null;
}

/**
 * Process an image through the Python backend.
 * Routes to the appropriate Python endpoint based on operation type.
 */
export async function processImage(
  operation: string,
  imageDataUrl: string,
  params: Record<string, unknown>
): Promise<{ dataUrl: string; metadata?: Record<string, unknown> }> {
  const python = api();
  if (!python) {
    throw new Error("Python backend not available. Start it from the setup screen.");
  }

  if (operation === "yolo_detect") {
    const model = normalizeModelName((params.model_url as string) ?? (params.model as string) ?? "yolov8n.pt");
    const result = await python.yoloDetect(imageDataUrl, {
      model,
      confidence: Number(params.confidence ?? params.conf_threshold ?? 0.25),
      iou: Number(params.iou ?? params.iou_threshold ?? 0.45),
    });

    return {
      dataUrl: result.annotated_image,
      metadata: {
        count: result.count,
        detections: result.detections,
        faceImages: result.crops,
        images: result.crops,
      },
    };
  }

  if (OPENCV_OPERATIONS.has(operation)) {
    const result = await python.cvProcess(imageDataUrl, operation, params);
    return {
      dataUrl: result.image,
      metadata: result.metadata,
    };
  }

  // Basic image operations via Pillow
  const result = await python.imageProcess(imageDataUrl, operation, params);
  return {
    dataUrl: result.image,
    metadata: { width: result.width, height: result.height },
  };
}

/**
 * Normalize YOLO model name: strip paths, convert .onnx → .pt
 */
function normalizeModelName(raw: string): string {
  let model = raw;
  if (model.includes("/")) model = model.split("/").pop() ?? "yolov8n.pt";
  if (model.endsWith(".onnx")) model = model.replace(/\.onnx$/, ".pt");
  return model || "yolov8n.pt";
}

/**
 * Build a pipeline step from a node's operation and field values.
 */
export function buildPipelineStep(
  operation: string,
  fieldValues: Record<string, unknown>
): { operation: string; params: Record<string, unknown> } {
  const params = { ...fieldValues };
  if (operation === "yolo_detect") {
    params.model = normalizeModelName(
      (params.model_url as string) ?? (params.model as string) ?? "yolov8n.pt"
    );
    params.confidence = Number(params.confidence ?? params.conf_threshold ?? 0.25);
    params.iou = Number(params.iou ?? params.iou_threshold ?? 0.45);
    delete params.model_url;
    delete params.conf_threshold;
    delete params.iou_threshold;
  }
  return { operation, params };
}

/**
 * Process a frame through multiple operations in a SINGLE HTTP call (fused pipeline).
 * Eliminates N-1 round-trips for an N-node chain.
 */
export async function processPipeline(
  imageDataUrl: string,
  steps: Array<{ operation: string; params: Record<string, unknown> }>
): Promise<{ dataUrl: string; metadata?: Record<string, unknown> }> {
  const python = api();
  if (!python) throw new Error("Python backend not available.");

  const result = await python.request<{
    type: string; image: string; metadata: Record<string, unknown>;
  }>("POST", "/pipeline/process", { image: imageDataUrl, steps });

  if (result.type === "error") throw new Error((result as any).message || "Pipeline processing failed");

  return { dataUrl: result.image, metadata: result.metadata };
}

/**
 * Submit a frame to the server-side queue (fire-and-forget, non-blocking).
 */
export async function submitFrameToQueue(
  sessionId: string,
  frameId: number,
  imageDataUrl: string,
  steps: Array<{ operation: string; params: Record<string, unknown> }>
): Promise<{ queueSize: number }> {
  const python = api();
  if (!python) throw new Error("Python backend not available.");

  const result = await python.request<{ type: string; queue_size: number }>(
    "POST", "/queue/submit",
    { session_id: sessionId, frame_id: frameId, image: imageDataUrl, steps }
  );

  return { queueSize: result.queue_size };
}

/**
 * Connect to the server-side result queue via SSE.
 * Returns a cleanup function.
 */
export function connectResultStream(
  sessionId: string,
  backendUrl: string,
  onResult: (data: { frame_id: number; image: string; metadata: Record<string, unknown> }) => void
): () => void {
  const es = new EventSource(`${backendUrl}/queue/results/${sessionId}`);
  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onResult(data);
    } catch { /* skip */ }
  };
  return () => es.close();
}

/**
 * Extract video frames using ffmpeg on the Python backend (much faster than browser canvas).
 */
export async function extractVideoFramesNative(
  videoPath: string,
  fps: number,
  maxFrames?: number,
  resize?: string
): Promise<{ frameCount: number; outputDir: string; frames: string[] }> {
  const python = api();
  if (!python) throw new Error("Python backend not available.");

  const appData = await window.electronAPI.app.getPath("userData");
  const framesBase = `${appData}/pipeline_frames`;
  await window.electronAPI.fs.mkdir(framesBase);
  const outputDir = `${framesBase}/vframes_${Date.now()}`;

  const result = await python.request<{
    type: string; frame_count: number; output_dir: string; frames: string[];
  }>("POST", "/video/extract-frames", {
    video_path: videoPath,
    output_dir: outputDir,
    fps,
    max_frames: maxFrames ?? 0,
    resize,
  });

  if (result.type === "error") throw new Error((result as any).message || "Frame extraction failed");

  return { frameCount: result.frame_count, outputDir: result.output_dir, frames: result.frames };
}

/**
 * Read a single frame from disk via Python backend (returns data URL).
 */
export async function readFrameFromDisk(framePath: string): Promise<string> {
  const python = api();
  if (!python) throw new Error("Python backend not available.");

  const result = await python.request<{ type: string; image: string }>(
    "POST", "/video/read-frame", { path: framePath }
  );
  return result.image;
}

/**
 * Save frames to a directory using native file system.
 */
export async function saveFramesToDisk(
  frames: string[],
  prefix: string,
  ext: string,
  onProgress?: (current: number, total: number) => void
): Promise<string | null> {
  const dirPath = await window.electronAPI?.dialog.openDirectory();
  if (!dirPath) return null;

  for (let i = 0; i < frames.length; i++) {
    const filename = `${prefix}${String(i).padStart(4, "0")}.${ext}`;
    const filePath = `${dirPath}/${filename}`;
    await window.electronAPI.fs.writeDataUrl(filePath, frames[i]);
    onProgress?.(i + 1, frames.length);
  }

  return dirPath;
}

/**
 * Save a blob (video, zip) to disk via native save dialog.
 */
export async function saveBlobToDisk(
  blob: Blob,
  defaultName: string,
  filters?: Array<{ name: string; extensions: string[] }>
): Promise<string | null> {
  const result = await window.electronAPI?.dialog.saveFile({
    defaultPath: defaultName,
    filters,
  });
  if (result?.canceled || !result?.filePath) return null;

  const buffer = new Uint8Array(await blob.arrayBuffer());
  await window.electronAPI.fs.writeBuffer(result.filePath, buffer);
  return result.filePath;
}
