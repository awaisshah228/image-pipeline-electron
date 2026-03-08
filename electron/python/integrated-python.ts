/**
 * Integrated Python — downloads a standalone Python build on first launch.
 *
 * Uses python-build-standalone (https://github.com/indygreg/python-build-standalone)
 * so the user does NOT need Python installed on their system.
 *
 * Flow:
 *  1. Check if integrated Python already exists in app data folder
 *  2. If not, download the tar.gz for the current platform/arch
 *  3. Extract it
 *  4. Return the path to the python executable
 */

import { app } from "electron";
import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PYTHON_VERSION = "3.11.5";
const RELEASE_TAG = "20230826";

export type SetupStage = "download" | "extract" | "install-deps";

export type ProgressCallback = (
  percentage: number,
  stage: SetupStage,
  message: string
) => void;

interface PlatformDownload {
  url: string;
  /** Relative path to python binary inside the extracted folder */
  bin: string;
}

function getDownloadInfo(): PlatformDownload {
  const platform = process.platform;
  const arch = process.arch;
  const base = `https://github.com/indygreg/python-build-standalone/releases/download/${RELEASE_TAG}`;

  if (platform === "darwin") {
    const cpuArch = arch === "arm64" ? "aarch64" : "x86_64";
    return {
      url: `${base}/cpython-${PYTHON_VERSION}+${RELEASE_TAG}-${cpuArch}-apple-darwin-install_only.tar.gz`,
      bin: "python/bin/python3",
    };
  }

  if (platform === "win32") {
    return {
      url: `${base}/cpython-${PYTHON_VERSION}+${RELEASE_TAG}-x86_64-pc-windows-msvc-shared-install_only.tar.gz`,
      bin: "python/python.exe",
    };
  }

  // Linux
  return {
    url: `${base}/cpython-${PYTHON_VERSION}+${RELEASE_TAG}-x86_64-unknown-linux-gnu-install_only.tar.gz`,
    bin: "python/bin/python3",
  };
}

/** Where integrated Python lives on disk */
export function getIntegratedPythonDir(): string {
  return path.join(app.getPath("userData"), "integrated-python");
}

/** Full path to the integrated python executable */
export function getIntegratedPythonExecutable(): string {
  const dir = getIntegratedPythonDir();
  const { bin } = getDownloadInfo();
  return path.join(dir, bin);
}

/** Check if integrated Python is already installed and valid */
export async function isIntegratedPythonInstalled(): Promise<boolean> {
  const pythonPath = getIntegratedPythonExecutable();
  if (!existsSync(pythonPath)) return false;

  try {
    const { stdout } = await execFileAsync(pythonPath, [
      "-c",
      "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')",
    ], { timeout: 10000 });

    const version = stdout.trim();
    return version === PYTHON_VERSION;
  } catch {
    return false;
  }
}

/**
 * Download a file with progress tracking.
 * Follows redirects (GitHub releases use 302).
 */
function downloadFile(
  url: string,
  destPath: string,
  onProgress: (percentage: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doRequest = (requestUrl: string, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error("Too many redirects"));
        return;
      }

      const client = requestUrl.startsWith("https") ? https : http;
      client
        .get(requestUrl, (res) => {
          // Follow redirects
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            doRequest(res.headers.location, redirectCount + 1);
            return;
          }

          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }

          const totalBytes = parseInt(res.headers["content-length"] ?? "0", 10);
          let downloadedBytes = 0;

          const fileStream = createWriteStream(destPath);

          res.on("data", (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            if (totalBytes > 0) {
              onProgress((downloadedBytes / totalBytes) * 100);
            }
          });

          res.pipe(fileStream);

          fileStream.on("finish", () => {
            fileStream.close();
            resolve();
          });

          fileStream.on("error", (err) => {
            fs.unlink(destPath).catch(() => {});
            reject(err);
          });
        })
        .on("error", (err) => {
          reject(err);
        });
    };

    doRequest(url);
  });
}

/**
 * Extract a .tar.gz file into a directory.
 * Uses the system `tar` command (available on macOS, Linux, and modern Windows).
 */
async function extractTarGz(tarPath: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  await execFileAsync("tar", ["xzf", tarPath, "-C", destDir], {
    timeout: 120000,
  });
}

/**
 * Download and install integrated Python if not already present.
 * Returns the path to the python executable.
 */
export async function setupIntegratedPython(
  onProgress?: ProgressCallback
): Promise<string> {
  const pythonPath = getIntegratedPythonExecutable();

  // Already installed?
  if (await isIntegratedPythonInstalled()) {
    console.log("[IntegratedPython] Already installed at", pythonPath);
    return pythonPath;
  }

  const dir = getIntegratedPythonDir();
  const { url } = getDownloadInfo();

  // Clean up any partial previous install
  if (existsSync(dir)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  await fs.mkdir(dir, { recursive: true });

  const tarPath = path.join(dir, "python.tar.gz");

  // 1. Download
  console.log("[IntegratedPython] Downloading from", url);
  onProgress?.(0, "download", "Downloading Python runtime...");

  await downloadFile(tarPath, tarPath, (pct) => {
    onProgress?.(pct, "download", `Downloading Python runtime... ${Math.round(pct)}%`);
  });

  onProgress?.(100, "download", "Download complete");

  // 2. Extract
  console.log("[IntegratedPython] Extracting...");
  onProgress?.(0, "extract", "Extracting Python...");

  await extractTarGz(tarPath, dir);

  onProgress?.(100, "extract", "Extraction complete");

  // 3. Clean up tar
  await fs.rm(tarPath, { force: true });

  // 4. Set executable permissions on Unix
  if (process.platform !== "win32") {
    try {
      await fs.chmod(pythonPath, 0o755);
    } catch (err) {
      console.warn("[IntegratedPython] chmod warning:", err);
    }
  }

  // Verify installation
  const installed = await isIntegratedPythonInstalled();
  if (!installed) {
    throw new Error("Integrated Python installation verification failed");
  }

  console.log("[IntegratedPython] Ready at", pythonPath);
  return pythonPath;
}

/**
 * Install pip dependencies into the integrated Python environment.
 */
export async function installPipDependencies(
  pythonPath: string,
  requirementsPath: string,
  onProgress?: ProgressCallback
): Promise<void> {
  onProgress?.(0, "install-deps", "Installing Python packages...");

  // First ensure pip is available and up to date
  await execFileAsync(pythonPath, ["-m", "ensurepip", "--upgrade"], {
    timeout: 60000,
    env: { ...process.env, PYTHONNOUSERSITE: "1" },
  }).catch(() => {
    // ensurepip may already be done
  });

  // Count packages in requirements.txt for progress tracking
  let totalPackages = 1;
  try {
    const reqContent = await fs.readFile(requirementsPath, "utf-8");
    totalPackages = Math.max(
      reqContent.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length,
      1
    );
  } catch {}

  let downloadedCount = 0;
  let currentPkg = "";

  // Install from requirements.txt
  return new Promise((resolve, reject) => {
    const { spawn } = require("node:child_process");
    const proc = spawn(
      pythonPath,
      ["-m", "pip", "install", "--no-cache-dir", "-r", requirementsPath],
      {
        env: {
          ...process.env,
          PYTHONNOUSERSITE: "1",
          PYTHONUNBUFFERED: "1",
        },
      }
    );

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      console.log("[pip]", text.trim());

      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        const collectMatch = trimmed.match(/^Collecting\s+([^\s(>=<!\[]+)/i);
        if (collectMatch) {
          currentPkg = collectMatch[1];
        }
        if (trimmed.startsWith("Downloading ")) {
          downloadedCount = Math.min(downloadedCount + 1, totalPackages);
        }
        if (trimmed.startsWith("Successfully installed")) {
          downloadedCount = totalPackages;
        }
      }

      const pct = Math.min(Math.round((downloadedCount / totalPackages) * 100), 95);
      const msg = currentPkg
        ? `Installing ${currentPkg}... (${downloadedCount}/${totalPackages})`
        : text.trim();
      onProgress?.(pct, "install-deps", msg);
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      console.warn("[pip]", text.trim());
      const pct = Math.min(Math.round((downloadedCount / totalPackages) * 100), 95);
      onProgress?.(pct, "install-deps", text.trim());
    });

    proc.on("close", (code: number) => {
      if (code === 0) {
        onProgress?.(100, "install-deps", `All ${totalPackages} packages installed`);
        resolve();
      } else {
        reject(new Error(`pip install failed with exit code ${code}`));
      }
    });

    proc.on("error", (err: Error) => {
      reject(err);
    });
  });
}
