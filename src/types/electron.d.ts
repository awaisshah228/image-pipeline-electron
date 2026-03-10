// Type declarations for the Electron IPC bridge exposed via preload

interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  path: string;
}

interface FileStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  modified: number;
  created: number;
}

interface ModelInfo {
  name: string;
  path: string;
  size: number;
  modified: number;
}

interface YoloDetection {
  class: number;
  confidence: number;
  bbox: [number, number, number, number];
}

interface ElectronAPI {
  fs: {
    readFile(filePath: string): Promise<string>; // base64
    readFileAsDataUrl(filePath: string): Promise<string>;
    writeFile(filePath: string, base64Data: string): Promise<void>;
    writeDataUrl(filePath: string, dataUrl: string): Promise<void>;
    writeBuffer(filePath: string, data: Uint8Array): Promise<void>;
    readDir(dirPath: string): Promise<DirEntry[]>;
    exists(filePath: string): Promise<boolean>;
    mkdir(dirPath: string): Promise<void>;
    deleteFile(filePath: string): Promise<void>;
    stat(filePath: string): Promise<FileStat>;
    copyFile(src: string, dest: string): Promise<void>;
    getFileSize(filePath: string): Promise<number>;
    saveFramesBatch(dirPath: string, frames: string[], prefix: string, ext: string): Promise<string[]>;
    loadFrame(dirPath: string, filename: string): Promise<string>;
    watchDir(dirPath: string): Promise<string>;
    unwatchDir(watchId: string): Promise<void>;
    onWatchEvent(callback: (event: { id: string; eventType: string; filename: string }) => void): () => void;
  };

  dialog: {
    openFile(options?: {
      filters?: Array<{ name: string; extensions: string[] }>;
      properties?: string[];
      title?: string;
    }): Promise<{ canceled: boolean; filePaths: string[] }>;
    saveFile(options?: {
      filters?: Array<{ name: string; extensions: string[] }>;
      defaultPath?: string;
      title?: string;
    }): Promise<{ canceled: boolean; filePath?: string }>;
    openDirectory(): Promise<string | null>;
  };

  models: {
    getDir(): Promise<string>;
    list(): Promise<ModelInfo[]>;
    import(sourcePath: string): Promise<string>;
    delete(modelPath: string): Promise<void>;
    readBuffer(modelPath: string): Promise<ArrayBuffer>;
    getBundledPath(modelName: string): Promise<string>;
    hasBundled(modelName: string): Promise<boolean>;
  };

  gpu: {
    getProviders(): Promise<string[]>;
    runYoloInference(
      modelPath: string,
      imageData: Float32Array,
      imageWidth: number,
      imageHeight: number,
      options?: {
        confidenceThreshold?: number;
        iouThreshold?: number;
        executionProvider?: string;
      }
    ): Promise<YoloDetection[]>;
    preloadModel(modelPath: string, executionProvider?: string): Promise<boolean>;
    releaseSessions(): Promise<void>;
  };

  python: {
    // Full auto-setup: detect/download Python → install deps
    setup(): Promise<{ python: PythonInfo; depsInstalled: boolean }>;
    detect(): Promise<PythonInfo | null>;
    checkDeps(): Promise<{ installed: string[]; missing: string[] }>;
    installDeps(): Promise<boolean>;
    start(): Promise<{ url: string; port: number }>;
    stop(): Promise<void>;
    restart(): Promise<{ url: string; port: number }>;
    status(): Promise<PythonBackendStatus>;
    request<T = unknown>(method: string, endpoint: string, body?: unknown): Promise<T>;
    // High-level APIs
    yoloDetect(imageDataUrl: string, options?: { model?: string; confidence?: number; iou?: number; filter_classes?: string[] }): Promise<PythonYoloResult>;
    cvProcess(imageDataUrl: string, operation: string, params?: Record<string, unknown>): Promise<PythonCvResult>;
    imageProcess(imageDataUrl: string, operation: string, params?: Record<string, unknown>): Promise<PythonImageResult>;
    loadModel(modelName: string): Promise<{ type: string; model: string; device: string }>;
    unloadModel(modelName: string): Promise<{ type: string }>;
    listModels(): Promise<{ models: string[]; device: string }>;
    aiModelStatus(): Promise<AiModelStatusResult>;
    downloadAiModel(type: string, name: string): Promise<{ type: string; model?: string; message?: string }>;
    systemInfo(): Promise<PythonSystemInfo>;
    // Cleanup / uninstall
    cleanup(): Promise<{ removed: string[] }>;
    installInfo(): Promise<{ python: PythonInfo | null; manifest: unknown; integratedPythonPath: string; integratedPythonSizeBytes: number }>;
    // Events
    onSetupProgress(callback: (data: { stage: string; percentage: number; message: string }) => void): () => void;
    onInstallProgress(callback: (output: string) => void): () => void;
    onInstallPackageProgress(callback: (data: { installed: number; total: number; current: string; percentage: number }) => void): () => void;
  };

  ffmpeg: {
    available(): Promise<boolean>;
    encode(opts: {
      framesDir: string;
      outputPath: string;
      fps: number;
      pattern?: string;
      codec?: string;
      crf?: number;
    }): Promise<{ success: boolean; size?: number; error?: string }>;
    extractFrames(opts: {
      videoPath: string;
      outputDir: string;
      fps: number;
      maxFrames?: number;
      resize?: string;
    }): Promise<{ success: boolean; frameCount?: number; error?: string }>;
  };

  app: {
    getPath(name: string): Promise<string>;
    getResourcesPath(): Promise<string>;
  };

  shell: {
    openPath(path: string): Promise<string>;
    showItemInFolder(path: string): void;
  };
}

interface PythonInfo {
  path: string;
  version: string;
  hasTorch: boolean;
  hasCuda: boolean;
}

interface PythonBackendStatus {
  running: boolean;
  url: string | null;
  port?: number;
  python: PythonInfo | null;
  logs?: string[];
}

interface PythonYoloResult {
  type: string;
  annotated_image: string;
  detections: Array<{
    class: number;
    class_name: string;
    confidence: number;
    bbox: [number, number, number, number];
  }>;
  count: number;
  crops: string[];
}

interface PythonCvResult {
  type: string;
  image: string;
  metadata: Record<string, unknown>;
}

interface PythonImageResult {
  type: string;
  image: string;
  width: number;
  height: number;
}

interface PythonSystemInfo {
  cpu_percent: number;
  memory: {
    total: number;
    available: number;
    percent: number;
  };
  gpu: {
    name: string;
    memory_total: number;
    memory_allocated: number;
    memory_reserved: number;
  } | null;
}

interface AiModelStatusResult {
  rembg: Record<string, { downloaded: boolean; size_mb?: number }>;
  mobile_sam: { installed: boolean; downloaded: boolean; size_mb: number };
  yolo: { loaded: string[] };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
