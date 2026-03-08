import { contextBridge, ipcRenderer } from "electron";

// Expose protected APIs to renderer via contextBridge
contextBridge.exposeInMainWorld("electronAPI", {
  // ── File System ──
  fs: {
    readFile: (filePath: string) => ipcRenderer.invoke("fs:readFile", filePath),
    readFileAsDataUrl: (filePath: string) => ipcRenderer.invoke("fs:readFileAsDataUrl", filePath),
    writeFile: (filePath: string, base64Data: string) => ipcRenderer.invoke("fs:writeFile", filePath, base64Data),
    writeDataUrl: (filePath: string, dataUrl: string) => ipcRenderer.invoke("fs:writeDataUrl", filePath, dataUrl),
    writeBuffer: (filePath: string, data: Uint8Array) => ipcRenderer.invoke("fs:writeBuffer", filePath, data),
    readDir: (dirPath: string) => ipcRenderer.invoke("fs:readDir", dirPath),
    exists: (filePath: string) => ipcRenderer.invoke("fs:exists", filePath),
    mkdir: (dirPath: string) => ipcRenderer.invoke("fs:mkdir", dirPath),
    deleteFile: (filePath: string) => ipcRenderer.invoke("fs:deleteFile", filePath),
    stat: (filePath: string) => ipcRenderer.invoke("fs:stat", filePath),
    copyFile: (src: string, dest: string) => ipcRenderer.invoke("fs:copyFile", src, dest),
    getFileSize: (filePath: string) => ipcRenderer.invoke("fs:getFileSize", filePath),
    saveFramesBatch: (dirPath: string, frames: string[], prefix: string, ext: string) =>
      ipcRenderer.invoke("fs:saveFramesBatch", dirPath, frames, prefix, ext),
    loadFrame: (dirPath: string, filename: string) =>
      ipcRenderer.invoke("fs:loadFrame", dirPath, filename),
    watchDir: (dirPath: string) => ipcRenderer.invoke("fs:watchDir", dirPath),
    unwatchDir: (watchId: string) => ipcRenderer.invoke("fs:unwatchDir", watchId),
    onWatchEvent: (callback: (event: { id: string; eventType: string; filename: string }) => void) => {
      const handler = (_e: unknown, data: { id: string; eventType: string; filename: string }) => callback(data);
      ipcRenderer.on("fs:watchEvent", handler);
      return () => ipcRenderer.removeListener("fs:watchEvent", handler);
    },
  },

  // ── Dialogs ──
  dialog: {
    openFile: (options?: {
      filters?: Array<{ name: string; extensions: string[] }>;
      properties?: string[];
      title?: string;
    }) => ipcRenderer.invoke("dialog:openFile", options),
    saveFile: (options?: {
      filters?: Array<{ name: string; extensions: string[] }>;
      defaultPath?: string;
      title?: string;
    }) => ipcRenderer.invoke("dialog:saveFile", options),
    openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
  },

  // ── Models ──
  models: {
    getDir: () => ipcRenderer.invoke("models:getDir"),
    list: () => ipcRenderer.invoke("models:list"),
    import: (sourcePath: string) => ipcRenderer.invoke("models:import", sourcePath),
    delete: (modelPath: string) => ipcRenderer.invoke("models:delete", modelPath),
    readBuffer: (modelPath: string) => ipcRenderer.invoke("models:readBuffer", modelPath),
    getBundledPath: (modelName: string) => ipcRenderer.invoke("models:getBundledPath", modelName),
    hasBundled: (modelName: string) => ipcRenderer.invoke("models:hasBundled", modelName),
  },

  // ── GPU Inference ──
  gpu: {
    getProviders: () => ipcRenderer.invoke("gpu:getProviders"),
    runYoloInference: (
      modelPath: string,
      imageData: Float32Array,
      imageWidth: number,
      imageHeight: number,
      options?: {
        confidenceThreshold?: number;
        iouThreshold?: number;
        executionProvider?: string;
      }
    ) => ipcRenderer.invoke("gpu:runYoloInference", modelPath, imageData, imageWidth, imageHeight, options ?? {}),
    preloadModel: (modelPath: string, executionProvider?: string) =>
      ipcRenderer.invoke("gpu:preloadModel", modelPath, executionProvider),
    releaseSessions: () => ipcRenderer.invoke("gpu:releaseSessions"),
  },

  // ── Python Backend ──
  python: {
    detect: () => ipcRenderer.invoke("python:detect"),
    checkDeps: () => ipcRenderer.invoke("python:checkDeps"),
    installDeps: () => ipcRenderer.invoke("python:installDeps"),
    start: () => ipcRenderer.invoke("python:start"),
    stop: () => ipcRenderer.invoke("python:stop"),
    restart: () => ipcRenderer.invoke("python:restart"),
    status: () => ipcRenderer.invoke("python:status"),
    request: (method: string, endpoint: string, body?: unknown) =>
      ipcRenderer.invoke("python:request", method, endpoint, body),
    // High-level task APIs
    yoloDetect: (imageDataUrl: string, options?: { model?: string; confidence?: number; iou?: number; filter_classes?: string[] }) =>
      ipcRenderer.invoke("python:yoloDetect", imageDataUrl, options),
    cvProcess: (imageDataUrl: string, operation: string, params?: Record<string, unknown>) =>
      ipcRenderer.invoke("python:cvProcess", imageDataUrl, operation, params),
    imageProcess: (imageDataUrl: string, operation: string, params?: Record<string, unknown>) =>
      ipcRenderer.invoke("python:imageProcess", imageDataUrl, operation, params),
    loadModel: (modelName: string) => ipcRenderer.invoke("python:loadModel", modelName),
    unloadModel: (modelName: string) => ipcRenderer.invoke("python:unloadModel", modelName),
    listModels: () => ipcRenderer.invoke("python:listModels"),
    aiModelStatus: () => ipcRenderer.invoke("python:aiModelStatus"),
    downloadAiModel: (type: string, name: string) => ipcRenderer.invoke("python:downloadAiModel", type, name),
    systemInfo: () => ipcRenderer.invoke("python:systemInfo"),
    // Events
    onInstallProgress: (callback: (output: string) => void) => {
      const handler = (_e: unknown, data: string) => callback(data);
      ipcRenderer.on("python:installProgress", handler);
      return () => ipcRenderer.removeListener("python:installProgress", handler);
    },
  },

  // ── FFmpeg (direct Node.js, no Python roundtrip) ──
  ffmpeg: {
    available: () => ipcRenderer.invoke("ffmpeg:available") as Promise<boolean>,
    encode: (opts: {
      framesDir: string;
      outputPath: string;
      fps: number;
      pattern?: string;
      codec?: string;
      crf?: number;
    }) => ipcRenderer.invoke("ffmpeg:encode", opts) as Promise<{ success: boolean; size?: number; error?: string }>,
    extractFrames: (opts: {
      videoPath: string;
      outputDir: string;
      fps: number;
      maxFrames?: number;
      resize?: string;
    }) => ipcRenderer.invoke("ffmpeg:extractFrames", opts) as Promise<{ success: boolean; frameCount?: number; error?: string }>,
  },

  // ── App ──
  app: {
    getPath: (name: string) => ipcRenderer.invoke("app:getPath", name),
    getResourcesPath: () => ipcRenderer.invoke("app:getResourcesPath"),
  },
});
