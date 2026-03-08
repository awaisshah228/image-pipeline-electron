import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface PythonInfo {
  path: string;
  version: string;
  hasTorch: boolean;
  hasCuda: boolean;
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

    return {
      path: info.path,
      version: info.version,
      hasTorch: info.has_torch,
      hasCuda: info.has_cuda,
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
import sys, os, json

# Suppress noisy library output (ultralytics prints warnings on import)
_real_stderr = sys.stderr
sys.stderr = open(os.devnull, "w")
_real_stdout = sys.stdout

required = ["sanic", "numpy", "cv2", "PIL", "ultralytics", "psutil"]
optional = ["rembg"]
installed = []
missing = []

for pkg in required:
    try:
        __import__(pkg)
        installed.append(pkg)
    except ImportError:
        missing.append(pkg)

# Optional packages — don't block setup if missing
for pkg in optional:
    try:
        __import__(pkg)
        installed.append(pkg)
    except ImportError:
        pass

# Restore stdout before printing result
sys.stderr = _real_stderr
sys.stdout = _real_stdout
print(json.dumps({"installed": installed, "missing": missing}))
`,
    ], { timeout: 60000 });

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
 * Install Python dependencies using pip
 */
export async function installDependencies(
  pythonPath: string,
  requirementsPath: string,
  onOutput?: (data: string) => void
): Promise<boolean> {
  const pipOk = await runProcess(pythonPath, ["-m", "pip", "install", "-r", requirementsPath], onOutput);
  if (!pipOk) return false;

  // Pre-download small AI models (~16MB total). Larger models (BiRefNet etc) download on first use.
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

print("All models ready! (MobileSAM & BiRefNet download on first use from AI Models manager)")
`], onOutput);

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
