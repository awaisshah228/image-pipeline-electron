import { type IpcMain } from "electron";
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function registerFileSystemHandlers(ipcMain: IpcMain) {
  // Read file as buffer (returns base64)
  ipcMain.handle("fs:readFile", async (_e, filePath: string) => {
    const buffer = await fs.readFile(filePath);
    return buffer.toString("base64");
  });

  // Read file as data URL
  ipcMain.handle("fs:readFileAsDataUrl", async (_e, filePath: string) => {
    const buffer = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".avi": "video/x-msvideo",
      ".mov": "video/quicktime",
      ".onnx": "application/octet-stream",
    };
    const mime = mimeMap[ext] ?? "application/octet-stream";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  });

  // Write file from base64
  ipcMain.handle("fs:writeFile", async (_e, filePath: string, base64Data: string) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from(base64Data, "base64"));
  });

  // Write file from data URL
  ipcMain.handle("fs:writeDataUrl", async (_e, filePath: string, dataUrl: string) => {
    const base64 = dataUrl.split(",")[1];
    if (!base64) throw new Error("Invalid data URL");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from(base64, "base64"));
  });

  // Write raw buffer
  ipcMain.handle("fs:writeBuffer", async (_e, filePath: string, data: Uint8Array) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
  });

  // List directory
  ipcMain.handle("fs:readDir", async (_e, dirPath: string) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
      path: path.join(dirPath, e.name),
    }));
  });

  // Check if path exists
  ipcMain.handle("fs:exists", async (_e, filePath: string) => {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  });

  // Create directory
  ipcMain.handle("fs:mkdir", async (_e, dirPath: string) => {
    await fs.mkdir(dirPath, { recursive: true });
  });

  // Delete file
  ipcMain.handle("fs:deleteFile", async (_e, filePath: string) => {
    await fs.unlink(filePath);
  });

  // Get file stats
  ipcMain.handle("fs:stat", async (_e, filePath: string) => {
    const stat = await fs.stat(filePath);
    return {
      size: stat.size,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      modified: stat.mtimeMs,
      created: stat.birthtimeMs,
    };
  });

  // Copy file
  ipcMain.handle("fs:copyFile", async (_e, src: string, dest: string) => {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  });

  // Create read stream for large files (returns path for renderer to stream)
  ipcMain.handle("fs:getFileSize", async (_e, filePath: string) => {
    const stat = await fs.stat(filePath);
    return stat.size;
  });

  // Save frames batch (from data URLs to directory)
  ipcMain.handle(
    "fs:saveFramesBatch",
    async (_e, dirPath: string, frames: string[], prefix: string, ext: string) => {
      await fs.mkdir(dirPath, { recursive: true });
      const filenames: string[] = [];
      for (let i = 0; i < frames.length; i++) {
        const filename = `${prefix}${String(i).padStart(4, "0")}.${ext}`;
        const filePath = path.join(dirPath, filename);
        const base64 = frames[i].split(",")[1];
        if (base64) {
          await fs.writeFile(filePath, Buffer.from(base64, "base64"));
        }
        filenames.push(filename);
      }
      return filenames;
    }
  );

  // Load frame from disk as data URL
  ipcMain.handle("fs:loadFrame", async (_e, dirPath: string, filename: string) => {
    const filePath = path.join(dirPath, filename);
    const buffer = await fs.readFile(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mime = ext === ".png" ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  });

  // Watch directory for changes
  ipcMain.handle("fs:watchDir", (_e, dirPath: string) => {
    // Returns a watcher ID — cleanup handled via separate IPC
    const watcher = fss.watch(dirPath, { recursive: true });
    const id = Date.now().toString();
    watchers.set(id, watcher);

    watcher.on("change", (eventType, filename) => {
      try {
        _e.sender.send("fs:watchEvent", { id, eventType, filename: String(filename) });
      } catch {
        // Window may have closed
      }
    });

    return id;
  });

  ipcMain.handle("fs:unwatchDir", (_e, watchId: string) => {
    const watcher = watchers.get(watchId);
    if (watcher) {
      watcher.close();
      watchers.delete(watchId);
    }
  });
}

const watchers = new Map<string, fss.FSWatcher>();

// ── FFmpeg encoding directly from Node.js (no Python roundtrip) ──
export function registerFfmpegHandlers(ipcMain: IpcMain) {
  // Check if ffmpeg is available
  ipcMain.handle("ffmpeg:available", async () => {
    return new Promise<boolean>((resolve) => {
      const proc = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    });
  });

  // Encode frames directory to video
  ipcMain.handle(
    "ffmpeg:encode",
    async (
      _e,
      opts: {
        framesDir: string;
        outputPath: string;
        fps: number;
        pattern?: string;
        codec?: string;
        crf?: number;
      }
    ) => {
      const {
        framesDir,
        outputPath,
        fps,
        pattern = "frame_%05d.jpg",
        codec = "libx264",
        crf = 23,
      } = opts;

      await fs.mkdir(path.dirname(outputPath), { recursive: true });

      return new Promise<{ success: boolean; size?: number; error?: string }>((resolve) => {
        const args = [
          "-y",
          "-framerate", String(fps),
          "-i", path.join(framesDir, pattern),
          "-c:v", codec,
          "-crf", String(crf),
          "-pix_fmt", "yuv420p",
          outputPath,
        ];

        const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";

        proc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        proc.on("error", (err) => {
          resolve({ success: false, error: err.message });
        });

        proc.on("close", async (code) => {
          if (code !== 0) {
            resolve({ success: false, error: stderr.slice(-500) });
            return;
          }
          try {
            const stat = await fs.stat(outputPath);
            resolve({ success: true, size: stat.size });
          } catch {
            resolve({ success: true });
          }
        });
      });
    }
  );

  // Extract frames from video using ffmpeg
  ipcMain.handle(
    "ffmpeg:extractFrames",
    async (
      _e,
      opts: {
        videoPath: string;
        outputDir: string;
        fps: number;
        maxFrames?: number;
        resize?: string;
      }
    ) => {
      const { videoPath, outputDir, fps, maxFrames, resize } = opts;

      await fs.mkdir(outputDir, { recursive: true });

      return new Promise<{ success: boolean; frameCount?: number; error?: string }>(
        (resolve) => {
          const vfParts = [`fps=${fps}`];
          if (resize) vfParts.push(`scale=${resize}`);

          const args = [
            "-y",
            "-i", videoPath,
            "-vf", vfParts.join(","),
          ];

          if (maxFrames && maxFrames > 0) {
            args.push("-frames:v", String(maxFrames));
          }

          args.push("-q:v", "2", path.join(outputDir, "frame_%05d.jpg"));

          const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
          let stderr = "";

          proc.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });

          proc.on("error", (err) => {
            resolve({ success: false, error: err.message });
          });

          proc.on("close", async (code) => {
            if (code !== 0) {
              resolve({ success: false, error: stderr.slice(-500) });
              return;
            }
            try {
              const files = await fs.readdir(outputDir);
              const frameFiles = files.filter(
                (f) => f.startsWith("frame_") && f.endsWith(".jpg")
              );
              resolve({ success: true, frameCount: frameFiles.length });
            } catch {
              resolve({ success: true, frameCount: 0 });
            }
          });
        }
      );
    }
  );
}
