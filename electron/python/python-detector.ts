import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
import json

required = ["sanic", "numpy", "cv2", "PIL", "ultralytics", "psutil"]
installed = []
missing = []

for pkg in required:
    try:
        __import__(pkg)
        installed.append(pkg)
    except ImportError:
        missing.append(pkg)

print(json.dumps({"installed": installed, "missing": missing}))
`,
    ], { timeout: 10000 });

    return JSON.parse(stdout.trim());
  } catch {
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
  return new Promise((resolve) => {
    const { spawn } = require("node:child_process");
    const proc = spawn(pythonPath, ["-m", "pip", "install", "-r", requirementsPath], {
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
