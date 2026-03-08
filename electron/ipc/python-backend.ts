import { type IpcMain, type BrowserWindow } from "electron";
import { PythonBackendProcess, findFreePort } from "../python/python-process";
import { detectPython, checkDependencies, installDependencies, type PythonInfo } from "../python/python-detector";
import path from "node:path";
import { app } from "electron";

let backend: PythonBackendProcess | null = null;
let pythonInfo: PythonInfo | null = null;

function getRequirementsPath(): string {
  const candidates = [
    path.join(process.resourcesPath, "python-backend", "requirements.txt"),
    path.join(app.getAppPath(), "python-backend", "requirements.txt"),
    path.join(process.cwd(), "python-backend", "requirements.txt"),
  ];
  for (const c of candidates) {
    try {
      require("node:fs").accessSync(c);
      return c;
    } catch {}
  }
  return candidates[0];
}

export function registerPythonBackendHandlers(ipcMain: IpcMain, getMainWindow: () => BrowserWindow | null) {
  // Detect Python
  ipcMain.handle("python:detect", async () => {
    pythonInfo = await detectPython();
    return pythonInfo;
  });

  // Check dependencies
  ipcMain.handle("python:checkDeps", async () => {
    if (!pythonInfo) return { installed: [], missing: ["all"] };
    return checkDependencies(pythonInfo.path);
  });

  // Install dependencies
  ipcMain.handle("python:installDeps", async () => {
    if (!pythonInfo) throw new Error("Python not detected");
    const reqPath = getRequirementsPath();
    const win = getMainWindow();

    const success = await installDependencies(pythonInfo.path, reqPath, (output) => {
      win?.webContents.send("python:installProgress", output);
    });

    return success;
  });

  // Start backend
  ipcMain.handle("python:start", async () => {
    if (backend?.running) return { url: backend.url, port: backend.port };

    if (!pythonInfo) {
      pythonInfo = await detectPython();
      if (!pythonInfo) throw new Error("Python not found");
    }

    const port = await findFreePort();
    backend = new PythonBackendProcess({ pythonPath: pythonInfo.path, port });
    await backend.spawn();

    return { url: backend.url, port: backend.port };
  });

  // Stop backend
  ipcMain.handle("python:stop", async () => {
    if (backend) {
      await backend.kill();
      backend = null;
    }
  });

  // Restart backend
  ipcMain.handle("python:restart", async () => {
    if (backend) {
      await backend.restart();
      return { url: backend.url, port: backend.port };
    }
    throw new Error("Backend not started");
  });

  // Get backend status
  ipcMain.handle("python:status", async () => {
    if (!backend) return { running: false, url: null, python: pythonInfo };

    const healthy = await backend.healthCheck();
    return {
      running: healthy,
      url: backend.url,
      port: backend.port,
      python: pythonInfo,
      logs: backend.logs.slice(-50),
    };
  });

  // Forward HTTP requests to Python backend
  ipcMain.handle("python:request", async (_e, method: string, endpoint: string, body?: unknown) => {
    if (!backend?.running) throw new Error("Python backend not running");
    return backend.request(method as "GET" | "POST", endpoint, body);
  });

  // ── High-level task APIs ──

  // YOLO detect via Python (GPU accelerated)
  ipcMain.handle(
    "python:yoloDetect",
    async (_e, imageDataUrl: string, options?: { model?: string; confidence?: number; iou?: number; filter_classes?: string[] }) => {
      if (!backend?.running) throw new Error("Python backend not running");
      return backend.request("POST", "/yolo/detect", {
        image: imageDataUrl,
        model: options?.model ?? "yolov8n.pt",
        confidence: options?.confidence ?? 0.25,
        iou: options?.iou ?? 0.45,
        filter_classes: options?.filter_classes ?? [],
      });
    }
  );

  // OpenCV process via Python
  ipcMain.handle(
    "python:cvProcess",
    async (_e, imageDataUrl: string, operation: string, params?: Record<string, unknown>) => {
      if (!backend?.running) throw new Error("Python backend not running");
      return backend.request("POST", "/cv/process", {
        image: imageDataUrl,
        operation,
        params: params ?? {},
      });
    }
  );

  // Image process via Python (Pillow)
  ipcMain.handle(
    "python:imageProcess",
    async (_e, imageDataUrl: string, operation: string, params?: Record<string, unknown>) => {
      if (!backend?.running) throw new Error("Python backend not running");
      return backend.request("POST", "/image/process", {
        image: imageDataUrl,
        operation,
        params: params ?? {},
      });
    }
  );

  // Model management
  ipcMain.handle("python:loadModel", async (_e, modelName: string) => {
    if (!backend?.running) throw new Error("Python backend not running");
    return backend.request("POST", "/models/load", { model: modelName });
  });

  ipcMain.handle("python:unloadModel", async (_e, modelName: string) => {
    if (!backend?.running) throw new Error("Python backend not running");
    return backend.request("POST", "/models/unload", { model: modelName });
  });

  ipcMain.handle("python:listModels", async () => {
    if (!backend?.running) throw new Error("Python backend not running");
    return backend.request("GET", "/models/list");
  });

  // AI model status (which models are downloaded)
  ipcMain.handle("python:aiModelStatus", async () => {
    if (!backend?.running) throw new Error("Python backend not running");
    return backend.request("GET", "/models/ai-status");
  });

  // Download AI model on demand
  ipcMain.handle("python:downloadAiModel", async (_e, type: string, name: string) => {
    if (!backend?.running) throw new Error("Python backend not running");
    return backend.request("POST", "/models/download-ai", { type, name });
  });

  // System info (CPU/RAM/GPU usage)
  ipcMain.handle("python:systemInfo", async () => {
    if (!backend?.running) throw new Error("Python backend not running");
    return backend.request("GET", "/system-info");
  });
}

// Cleanup on app quit
export async function cleanupPythonBackend() {
  if (backend) {
    await backend.kill();
    backend = null;
  }
}
