import { type IpcMain, type BrowserWindow } from "electron";
import { PythonBackendProcess, findFreePort } from "../python/python-process";
import { detectPython, checkDependencies, installDependencies, type PythonInfo } from "../python/python-detector";
import {
  setupIntegratedPython,
  installPipDependencies,
  getIntegratedPythonDir,
} from "../python/integrated-python";
import path from "node:path";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { app } from "electron";

let backend: PythonBackendProcess | null = null;
let pythonInfo: PythonInfo | null = null;

/** File that records which pip packages we installed, for clean uninstall */
function getInstalledDepsManifestPath(): string {
  return path.join(app.getPath("userData"), "installed-pip-packages.json");
}

/** Save the list of packages we installed */
async function saveInstalledPackages(pythonPath: string): Promise<void> {
  try {
    const { execFile } = require("node:child_process");
    const { promisify } = require("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(pythonPath, [
      "-m", "pip", "list", "--format=json",
    ], { timeout: 15000, env: { ...process.env, PYTHONNOUSERSITE: "1" } });
    const packages = JSON.parse(stdout.trim());
    await fsPromises.writeFile(
      getInstalledDepsManifestPath(),
      JSON.stringify({ pythonPath, packages, installedAt: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    console.warn("[python-backend] Failed to save package manifest:", err);
  }
}

function getRequirementsPath(): string {
  const candidates = [
    path.join(process.resourcesPath, "python-backend", "requirements.txt"),
    path.join(app.getAppPath(), "python-backend", "requirements.txt"),
    path.join(process.cwd(), "python-backend", "requirements.txt"),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c);
      return c;
    } catch {}
  }
  return candidates[0];
}

export function registerPythonBackendHandlers(ipcMain: IpcMain, getMainWindow: () => BrowserWindow | null) {
  // ── Full setup flow (like chaiNNer): detect/download Python → install deps → start ──
  ipcMain.handle("python:setup", async () => {
    const win = getMainWindow();
    const sendProgress = (data: { stage: string; percentage: number; message: string }) => {
      win?.webContents.send("python:setupProgress", data);
    };

    // Step 1: Try to find system Python first
    sendProgress({ stage: "detect", percentage: 0, message: "Looking for Python..." });
    pythonInfo = await detectPython();

    if (pythonInfo) {
      sendProgress({ stage: "detect", percentage: 100, message: `Found Python ${pythonInfo.version}` });
    } else {
      // Step 2: No system Python — download integrated Python
      sendProgress({ stage: "download", percentage: 0, message: "Downloading Python runtime..." });

      const integratedPath = await setupIntegratedPython((pct, stage, msg) => {
        sendProgress({ stage, percentage: pct, message: msg });
      });

      // Re-detect to fill in PythonInfo
      pythonInfo = await detectPython();
      if (!pythonInfo) {
        pythonInfo = {
          path: integratedPath,
          version: "3.11.5",
          hasTorch: false,
          hasCuda: false,
          isIntegrated: true,
        };
      }
    }

    // Step 3: Check & install dependencies
    sendProgress({ stage: "check-deps", percentage: 0, message: "Checking dependencies..." });
    const deps = await checkDependencies(pythonInfo.path);

    if (deps.missing.length > 0) {
      sendProgress({ stage: "install-deps", percentage: 0, message: `Installing ${deps.missing.length} missing packages...` });
      const reqPath = getRequirementsPath();

      await installPipDependencies(pythonInfo.path, reqPath, (pct, _stage, msg) => {
        sendProgress({ stage: "install-deps", percentage: pct, message: msg });
      });

      // Save manifest for cleanup on uninstall
      await saveInstalledPackages(pythonInfo.path);
    }

    sendProgress({ stage: "ready", percentage: 100, message: "Python environment ready" });

    return {
      python: pythonInfo,
      depsInstalled: deps.missing.length > 0,
    };
  });

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

    if (success) {
      await saveInstalledPackages(pythonInfo.path);
    }

    return success;
  });

  // Start backend
  ipcMain.handle("python:start", async () => {
    if (backend?.running) return { url: backend.url, port: backend.port };

    if (!pythonInfo) {
      pythonInfo = await detectPython();
      if (!pythonInfo) throw new Error("Python not found. Run python:setup first.");
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

  // ── Cleanup / Uninstall ──

  // Full cleanup: remove integrated Python, pip packages, and manifest
  ipcMain.handle("python:cleanup", async () => {
    // Stop backend first
    if (backend) {
      await backend.kill();
      backend = null;
    }

    const removed: string[] = [];

    // Remove integrated Python directory
    const integratedDir = getIntegratedPythonDir();
    try {
      await fsPromises.rm(integratedDir, { recursive: true, force: true });
      removed.push("integrated-python");
    } catch {}

    // Remove pip package manifest
    const manifestPath = getInstalledDepsManifestPath();
    try {
      await fsPromises.rm(manifestPath, { force: true });
      removed.push("package-manifest");
    } catch {}

    // Remove downloaded AI models from userData
    const modelsDir = path.join(app.getPath("userData"), "models");
    try {
      await fsPromises.rm(modelsDir, { recursive: true, force: true });
      removed.push("ai-models");
    } catch {}

    // Remove pipeline temp frames
    const framesDir = path.join(app.getPath("userData"), "pipeline_frames");
    try {
      await fsPromises.rm(framesDir, { recursive: true, force: true });
      removed.push("temp-frames");
    } catch {}

    pythonInfo = null;

    return { removed };
  });

  // Get info about what's installed (for settings/about UI)
  ipcMain.handle("python:installInfo", async () => {
    const manifestPath = getInstalledDepsManifestPath();
    const integratedDir = getIntegratedPythonDir();

    let manifest = null;
    try {
      const raw = await fsPromises.readFile(manifestPath, "utf-8");
      manifest = JSON.parse(raw);
    } catch {}

    let integratedSize = 0;
    try {
      // Get rough directory size
      const { execFile } = require("node:child_process");
      const { promisify } = require("node:util");
      const execFileAsync = promisify(execFile);
      if (process.platform !== "win32") {
        const { stdout } = await execFileAsync("du", ["-sk", integratedDir], { timeout: 10000 });
        integratedSize = parseInt(stdout.split("\t")[0], 10) * 1024; // bytes
      }
    } catch {}

    return {
      python: pythonInfo,
      manifest,
      integratedPythonPath: integratedDir,
      integratedPythonSizeBytes: integratedSize,
    };
  });
}

// Cleanup on app quit
export async function cleanupPythonBackend() {
  if (backend) {
    await backend.kill();
    backend = null;
  }
}
