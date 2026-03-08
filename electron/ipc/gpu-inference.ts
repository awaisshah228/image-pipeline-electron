import { type IpcMain } from "electron";
import path from "node:path";
import fs from "node:fs/promises";

// ONNX Runtime Node.js — supports CUDA, DirectML, CoreML
// Import dynamically to handle environments where native bindings aren't available
let ort: typeof import("onnxruntime-node") | null = null;

async function getOrt() {
  if (!ort) {
    ort = await import("onnxruntime-node");
  }
  return ort;
}

// Session cache by model path
const sessionCache = new Map<string, InstanceType<typeof import("onnxruntime-node").InferenceSession>>();

async function getSession(modelPath: string, executionProvider: string) {
  const cacheKey = `${modelPath}:${executionProvider}`;
  if (sessionCache.has(cacheKey)) {
    return sessionCache.get(cacheKey)!;
  }

  const ortModule = await getOrt();

  // Try requested provider, fall back to CPU
  const providers: string[] = [];
  if (executionProvider === "cuda") {
    providers.push("cuda", "cpu");
  } else if (executionProvider === "directml") {
    providers.push("dml", "cpu");
  } else if (executionProvider === "coreml") {
    providers.push("coreml", "cpu");
  } else {
    providers.push("cpu");
  }

  const session = await ortModule.InferenceSession.create(modelPath, {
    executionProviders: providers as ort.InferenceSession.ExecutionProviderConfig[],
    graphOptimizationLevel: "all",
  });

  sessionCache.set(cacheKey, session);
  return session;
}

export function registerGpuInferenceHandlers(ipcMain: IpcMain) {
  // Get available execution providers
  ipcMain.handle("gpu:getProviders", async () => {
    try {
      const ortModule = await getOrt();
      // Check which providers are available
      const available: string[] = ["cpu"];

      // Try CUDA
      try {
        const testSession = await ortModule.InferenceSession.create(
          new Uint8Array(0),
          { executionProviders: ["cuda"] }
        );
        testSession.release();
        available.push("cuda");
      } catch {
        // CUDA not available
      }

      // CoreML (macOS only)
      if (process.platform === "darwin") {
        available.push("coreml");
      }

      // DirectML (Windows only)
      if (process.platform === "win32") {
        try {
          const testSession = await ortModule.InferenceSession.create(
            new Uint8Array(0),
            { executionProviders: ["dml"] }
          );
          testSession.release();
          available.push("directml");
        } catch {
          // DirectML not available
        }
      }

      return available;
    } catch {
      return ["cpu"];
    }
  });

  // Run YOLO inference on the main process (GPU accelerated)
  ipcMain.handle(
    "gpu:runYoloInference",
    async (
      _e,
      modelPath: string,
      imageData: Float32Array,
      imageWidth: number,
      imageHeight: number,
      options: {
        confidenceThreshold?: number;
        iouThreshold?: number;
        executionProvider?: string;
      }
    ) => {
      const ortModule = await getOrt();
      const provider = options.executionProvider ?? "cpu";
      const session = await getSession(modelPath, provider);

      const confThreshold = options.confidenceThreshold ?? 0.25;
      const iouThreshold = options.iouThreshold ?? 0.45;

      // Create input tensor (NCHW format: [1, 3, 640, 640])
      const inputTensor = new ortModule.Tensor("float32", imageData, [1, 3, 640, 640]);

      const inputName = session.inputNames[0];
      const feeds: Record<string, InstanceType<typeof ortModule.Tensor>> = {};
      feeds[inputName] = inputTensor;

      const results = await session.run(feeds);
      const output = results[session.outputNames[0]];
      const outputData = output.data as Float32Array;

      // Parse YOLO output: [1, 84, 8400] for YOLOv8
      // 84 = 4 (bbox) + 80 (classes)
      const numDetections = 8400;
      const numClasses = 80;
      const detections: Array<{
        class: number;
        confidence: number;
        bbox: [number, number, number, number]; // x, y, w, h (normalized)
      }> = [];

      for (let i = 0; i < numDetections; i++) {
        const cx = outputData[i];
        const cy = outputData[numDetections + i];
        const w = outputData[2 * numDetections + i];
        const h = outputData[3 * numDetections + i];

        let maxConf = 0;
        let maxClass = 0;
        for (let c = 0; c < numClasses; c++) {
          const conf = outputData[(4 + c) * numDetections + i];
          if (conf > maxConf) {
            maxConf = conf;
            maxClass = c;
          }
        }

        if (maxConf >= confThreshold) {
          detections.push({
            class: maxClass,
            confidence: maxConf,
            bbox: [
              (cx - w / 2) / 640,
              (cy - h / 2) / 640,
              w / 640,
              h / 640,
            ],
          });
        }
      }

      // NMS (simple greedy)
      const nmsDetections = nms(detections, iouThreshold);
      return nmsDetections;
    }
  );

  // Release cached sessions
  ipcMain.handle("gpu:releaseSessions", async () => {
    for (const [key, session] of sessionCache) {
      await session.release();
      sessionCache.delete(key);
    }
  });

  // Load and create session (preload for faster first inference)
  ipcMain.handle("gpu:preloadModel", async (_e, modelPath: string, executionProvider?: string) => {
    await getSession(modelPath, executionProvider ?? "cpu");
    return true;
  });
}

// Simple greedy NMS
function nms(
  detections: Array<{ class: number; confidence: number; bbox: [number, number, number, number] }>,
  iouThreshold: number
) {
  // Sort by confidence descending
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  const keep: typeof sorted = [];

  for (const det of sorted) {
    let suppress = false;
    for (const kept of keep) {
      if (det.class === kept.class && iou(det.bbox, kept.bbox) > iouThreshold) {
        suppress = true;
        break;
      }
    }
    if (!suppress) keep.push(det);
  }

  return keep;
}

function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ax1 = a[0], ay1 = a[1], ax2 = a[0] + a[2], ay2 = a[1] + a[3];
  const bx1 = b[0], by1 = b[1], bx2 = b[0] + b[2], by2 = b[1] + b[3];

  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);

  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const intersection = iw * ih;

  const aArea = a[2] * a[3];
  const bArea = b[2] * b[3];
  const union = aArea + bArea - intersection;

  return union > 0 ? intersection / union : 0;
}
