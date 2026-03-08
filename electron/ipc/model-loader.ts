import { type IpcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

// Manages local model storage and discovery

function getModelsDir(): string {
  return path.join(app.getPath("userData"), "models");
}

export function registerModelHandlers(ipcMain: IpcMain) {
  // Get the models directory path
  ipcMain.handle("models:getDir", () => {
    return getModelsDir();
  });

  // List all available models
  ipcMain.handle("models:list", async () => {
    const modelsDir = getModelsDir();
    try {
      await fs.mkdir(modelsDir, { recursive: true });
      const entries = await fs.readdir(modelsDir, { withFileTypes: true });
      const models: Array<{
        name: string;
        path: string;
        size: number;
        modified: number;
      }> = [];

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".onnx")) {
          const filePath = path.join(modelsDir, entry.name);
          const stat = await fs.stat(filePath);
          models.push({
            name: entry.name,
            path: filePath,
            size: stat.size,
            modified: stat.mtimeMs,
          });
        }
      }

      return models;
    } catch {
      return [];
    }
  });

  // Import a model file (copy to models directory)
  ipcMain.handle("models:import", async (_e, sourcePath: string) => {
    const modelsDir = getModelsDir();
    await fs.mkdir(modelsDir, { recursive: true });
    const filename = path.basename(sourcePath);
    const destPath = path.join(modelsDir, filename);
    await fs.copyFile(sourcePath, destPath);
    return destPath;
  });

  // Delete a model
  ipcMain.handle("models:delete", async (_e, modelPath: string) => {
    await fs.unlink(modelPath);
  });

  // Read model as ArrayBuffer (for ONNX Runtime)
  ipcMain.handle("models:readBuffer", async (_e, modelPath: string) => {
    const buffer = await fs.readFile(modelPath);
    return buffer.buffer;
  });

  // Get bundled model path (e.g., yolov8n.onnx shipped with app)
  ipcMain.handle("models:getBundledPath", (_e, modelName: string) => {
    const resourcesPath = app.isPackaged
      ? path.join(process.resourcesPath, "models")
      : path.join(__dirname, "../../public/models");
    return path.join(resourcesPath, modelName);
  });

  // Check if bundled model exists
  ipcMain.handle("models:hasBundled", async (_e, modelName: string) => {
    const resourcesPath = app.isPackaged
      ? path.join(process.resourcesPath, "models")
      : path.join(__dirname, "../../public/models");
    const modelPath = path.join(resourcesPath, modelName);
    try {
      await fs.access(modelPath);
      return true;
    } catch {
      return false;
    }
  });
}
