// Native model management — replaces browser-based model loading
// Uses Electron IPC for file system access and GPU inference

const api = () => window.electronAPI;

export interface LocalModel {
  name: string;
  path: string;
  size: number;
  modified: number;
}

/**
 * Get the models storage directory
 */
export async function getModelsDirectory(): Promise<string> {
  return api().models.getDir();
}

/**
 * List all locally available ONNX models
 */
export async function listModels(): Promise<LocalModel[]> {
  return api().models.list();
}

/**
 * Import an ONNX model from disk into the models directory
 */
export async function importModel(): Promise<string | null> {
  const result = await api().dialog.openFile({
    title: "Import ONNX Model",
    filters: [{ name: "ONNX Models", extensions: ["onnx"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return api().models.import(result.filePaths[0]);
}

/**
 * Get available GPU execution providers
 */
export async function getAvailableProviders(): Promise<string[]> {
  return api().gpu.getProviders();
}

/**
 * Get path to the bundled YOLOv8n model
 */
export async function getBundledYoloPath(): Promise<string> {
  return api().models.getBundledPath("yolov8n.onnx");
}

/**
 * Preload a model for faster first inference
 */
export async function preloadModel(
  modelPath: string,
  executionProvider?: string
): Promise<void> {
  await api().gpu.preloadModel(modelPath, executionProvider);
}

/**
 * Run YOLO inference using GPU acceleration (main process)
 */
export async function runYoloInference(
  modelPath: string,
  imageData: Float32Array,
  imageWidth: number,
  imageHeight: number,
  options?: {
    confidenceThreshold?: number;
    iouThreshold?: number;
    executionProvider?: string;
  }
) {
  return api().gpu.runYoloInference(
    modelPath,
    imageData,
    imageWidth,
    imageHeight,
    options
  );
}

/**
 * Release all cached ONNX sessions
 */
export async function releaseModelSessions(): Promise<void> {
  await api().gpu.releaseSessions();
}

// COCO class names for YOLO detection results
export const COCO_CLASSES = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
  "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
  "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
  "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
  "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
  "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
  "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
  "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
  "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
  "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
  "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
  "toothbrush",
];
