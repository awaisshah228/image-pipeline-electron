import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import { getIntegratedPythonExecutable } from "./integrated-python";

const execFileAsync = promisify(execFile);

export interface PythonInfo {
  path: string;
  version: string;
  hasTorch: boolean;
  hasCuda: boolean;
  /** Whether this is the integrated (bundled) Python, not the user's system Python */
  isIntegrated: boolean;
}

/**
 * Try to detect a working Python 3.8+ installation.
 * Checks common paths in order of preference.
 */
export async function detectPython(): Promise<PythonInfo | null> {
  const candidates: string[] = [];

  // Prefer project venv Python — avoids reinstalling deps that are already in the venv
  // __dirname is dist-electron/ at runtime, so go up one level to reach electron-app/
  const electronAppRoot = path.resolve(__dirname, "..");
  const venvRoots = [
    path.join(electronAppRoot, "python-backend", "venv"),
    path.join(electronAppRoot, "python-backend", ".venv"),
    path.join(process.cwd(), "python-backend", "venv"),
    path.join(process.cwd(), "python-backend", ".venv"),
  ];
  try {
    const { app } = require("electron");
    venvRoots.push(
      path.join(app.getAppPath(), "python-backend", "venv"),
      path.join(app.getAppPath(), "python-backend", ".venv"),
    );
  } catch {}

  for (const venvRoot of venvRoots) {
    // Check both python3 and python — venvs may have either or both
    const names = process.platform === "win32"
      ? [path.join(venvRoot, "Scripts", "python.exe")]
      : [path.join(venvRoot, "bin", "python3"), path.join(venvRoot, "bin", "python")];
    for (const venvPython of names) {
      if (existsSync(venvPython)) {
        candidates.push(venvPython);
        break; // only add one per venv root
      }
    }
  }

  if (process.platform === "win32") {
    candidates.push("python", "python3", "py -3");
  } else {
    candidates.push("python3", "python");
    // Common conda/brew paths on macOS
    if (process.platform === "darwin") {
      candidates.push(
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
      );
    }
  }

  // Fall back to integrated Python (downloaded via python-build-standalone)
  const integratedPath = getIntegratedPythonExecutable();
  if (existsSync(integratedPath)) {
    candidates.push(integratedPath);
  }

  for (const candidate of candidates) {
    const info = await tryPython(candidate);
    if (info) return info;
  }

  return null;
}

async function tryPython(pythonPath: string): Promise<PythonInfo | null> {
  try {
    // Check version
    const { stdout } = await execFileAsync(pythonPath, [
      "-c",
      `
import sys
import json

info = {
    "version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
    "path": sys.executable,
    "has_torch": False,
    "has_cuda": False,
}

try:
    import torch
    info["has_torch"] = True
    info["has_cuda"] = torch.cuda.is_available()
except ImportError:
    pass

print(json.dumps(info))
`,
    ], { timeout: 10000 });

    const info = JSON.parse(stdout.trim());
    const [major, minor] = info.version.split(".").map(Number);

    // Require Python 3.8+
    if (major < 3 || (major === 3 && minor < 8)) {
      return null;
    }

    const integratedBin = getIntegratedPythonExecutable();
    return {
      path: info.path,
      version: info.version,
      hasTorch: info.has_torch,
      hasCuda: info.has_cuda,
      isIntegrated: path.resolve(info.path) === path.resolve(integratedBin),
    };
  } catch {
    return null;
  }
}

/**
 * Check if required packages are installed
 */
export async function checkDependencies(
  pythonPath: string
): Promise<{ installed: string[]; missing: string[] }> {
  try {
    const { stdout } = await execFileAsync(pythonPath, [
      "-c",
      `
import json
from importlib.util import find_spec

required = ["sanic", "numpy", "cv2", "PIL", "ultralytics", "psutil"]
optional = ["rembg"]
installed = []
missing = []

for pkg in required:
    if find_spec(pkg) is not None:
        installed.append(pkg)
    else:
        missing.append(pkg)

for pkg in optional:
    if find_spec(pkg) is not None:
        installed.append(pkg)

print(json.dumps({"installed": installed, "missing": missing}))
`,
    ], { timeout: 15000 });

    // Extract JSON from stdout — skip any non-JSON lines libraries may print
    const lines = stdout.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]);
      } catch {}
    }
    return { installed: [], missing: ["sanic", "numpy", "cv2", "PIL", "ultralytics", "psutil"] };
  } catch (err) {
    console.error("[python-detector] checkDependencies error:", err);
    return { installed: [], missing: ["sanic", "numpy", "cv2", "PIL", "ultralytics", "psutil"] };
  }
}

/**
 * Install Python dependencies using pip, with per-package progress.
 */
export async function installDependencies(
  pythonPath: string,
  requirementsPath: string,
  onOutput?: (data: string) => void,
  onProgress?: (data: { installed: number; total: number; current: string; percentage: number }) => void
): Promise<boolean> {
  // Count total packages from requirements.txt
  let totalPackages = 0;
  try {
    const reqContent = require("node:fs").readFileSync(requirementsPath, "utf-8") as string;
    totalPackages = reqContent.split("\n").filter((l: string) => l.trim() && !l.trim().startsWith("#")).length;
  } catch {}
  // Add 1 for the AI model download step
  totalPackages = Math.max(totalPackages, 1) + 1;

  let installedCount = 0;
  let currentPkg = "";

  const pipOk = await runProcess(
    pythonPath,
    ["-m", "pip", "install", "--no-cache-dir", "-r", requirementsPath],
    (text) => {
      onOutput?.(text);
      // Parse pip output for per-package tracking
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        // "Collecting sanic>=23.12.0" or "Collecting numpy>=1.24.0 (from -r ...)"
        const collectMatch = trimmed.match(/^Collecting\s+([^\s(>=<!\[]+)/i);
        if (collectMatch) {
          currentPkg = collectMatch[1];
        }
        // "Successfully installed sanic-23.12.1 numpy-1.26.4 ..."
        if (trimmed.startsWith("Successfully installed")) {
          const pkgCount = trimmed.split(/\s+/).length - 2; // minus "Successfully installed"
          installedCount = Math.max(installedCount, pkgCount > 0 ? totalPackages - 1 : installedCount);
        }
        // "Installing collected packages: ..." means download done, installing now
        if (trimmed.startsWith("Installing collected packages")) {
          installedCount = Math.max(installedCount, Math.floor((totalPackages - 1) * 0.7));
        }
        // "Downloading ..." lines — bump progress
        if (trimmed.startsWith("Downloading ")) {
          installedCount = Math.min(installedCount + 1, totalPackages - 1);
        }
      }
      const pct = Math.min(Math.round((installedCount / totalPackages) * 100), 95);
      onProgress?.({ installed: installedCount, total: totalPackages, current: currentPkg, percentage: pct });
    }
  );
  if (!pipOk) return false;

  // Pre-download small AI models
  installedCount = totalPackages - 1;
  currentPkg = "YOLOv8n model";
  onProgress?.({ installed: installedCount, total: totalPackages, current: currentPkg, percentage: 95 });
  onOutput?.("\n--- Downloading AI models ---\n");

  await runProcess(pythonPath, ["-c", `
import sys

print("Downloading YOLOv8n model (~6MB)...")
sys.stdout.flush()
try:
    from ultralytics import YOLO
    YOLO("yolov8n.pt")
    print("YOLOv8n ready")
except Exception as e:
    print(f"YOLOv8n skip: {e}")
sys.stdout.flush()

print("All models ready!")
`], onOutput);

  onProgress?.({ installed: totalPackages, total: totalPackages, current: "", percentage: 100 });
  return true;
}

function runProcess(
  pythonPath: string,
  args: string[],
  onOutput?: (data: string) => void
): Promise<boolean> {
  return new Promise((resolve) => {
    const { spawn } = require("node:child_process");
    const proc = spawn(pythonPath, args, {
      env: {
        ...process.env,
        PYTHONNOUSERSITE: "1",
        PYTHONUNBUFFERED: "1",
      },
    });

    proc.stdout.on("data", (data: Buffer) => {
      onOutput?.(data.toString());
    });

    proc.stderr.on("data", (data: Buffer) => {
      onOutput?.(data.toString());
    });

    proc.on("close", (code: number) => {
      resolve(code === 0);
    });

    proc.on("error", () => {
      resolve(false);
    });
  });
}
