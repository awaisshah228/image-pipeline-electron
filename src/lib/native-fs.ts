// Native file system adapter — replaces browser File System Access API
// Uses Electron IPC to call Node.js fs in the main process

const api = () => window.electronAPI;

/**
 * Open a native file picker and return the selected file as a data URL
 */
export async function pickAndReadFile(options?: {
  filters?: Array<{ name: string; extensions: string[] }>;
  title?: string;
}): Promise<{ dataUrl: string; filePath: string; fileName: string } | null> {
  const result = await api().dialog.openFile({
    ...options,
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  const dataUrl = await api().fs.readFileAsDataUrl(filePath);
  const fileName = filePath.split(/[\\/]/).pop() ?? "file";
  return { dataUrl, filePath, fileName };
}

/**
 * Pick an image file
 */
export async function pickImageFile() {
  return pickAndReadFile({
    title: "Select Image",
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
    ],
  });
}

/**
 * Pick a video file
 */
export async function pickVideoFile() {
  return pickAndReadFile({
    title: "Select Video",
    filters: [
      { name: "Videos", extensions: ["mp4", "webm", "avi", "mov", "mkv"] },
    ],
  });
}

/**
 * Pick an ONNX model file
 */
export async function pickModelFile() {
  return pickAndReadFile({
    title: "Select ONNX Model",
    filters: [{ name: "ONNX Models", extensions: ["onnx"] }],
  });
}

/**
 * Save a data URL to a file via native save dialog
 */
export async function saveDataUrlToFile(
  dataUrl: string,
  defaultName?: string,
  filters?: Array<{ name: string; extensions: string[] }>
): Promise<string | null> {
  const result = await api().dialog.saveFile({
    defaultPath: defaultName,
    filters: filters ?? [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePath) return null;

  await api().fs.writeDataUrl(result.filePath, dataUrl);
  return result.filePath;
}

/**
 * Save a Blob to a file via native save dialog
 */
export async function saveBlobToFile(
  blob: Blob,
  defaultName?: string,
  filters?: Array<{ name: string; extensions: string[] }>
): Promise<string | null> {
  const result = await api().dialog.saveFile({
    defaultPath: defaultName,
    filters,
  });
  if (result.canceled || !result.filePath) return null;

  const buffer = new Uint8Array(await blob.arrayBuffer());
  await api().fs.writeBuffer(result.filePath, buffer);
  return result.filePath;
}

/**
 * Pick a directory for saving frames
 */
export async function pickDirectory(): Promise<string | null> {
  return api().dialog.openDirectory();
}

/**
 * Save frames to a directory on disk (replaces browser frame-cache.ts)
 */
export async function saveFramesToDirectory(
  dirPath: string,
  frames: string[],
  prefix: string = "frame_",
  ext: string = "jpg",
  onProgress?: (current: number, total: number) => void
): Promise<string[]> {
  const filenames: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const filename = `${prefix}${String(i).padStart(4, "0")}.${ext}`;
    await api().fs.writeDataUrl(
      `${dirPath}/${filename}`,
      frames[i]
    );
    filenames.push(filename);
    onProgress?.(i + 1, frames.length);
  }
  return filenames;
}

/**
 * Load a frame from a directory on disk
 */
export async function loadFrameFromDirectory(
  dirPath: string,
  filename: string
): Promise<string> {
  return api().fs.loadFrame(dirPath, filename);
}

/**
 * Read a JSON file from disk
 */
export async function readJsonFile<T>(filePath: string): Promise<T> {
  const base64 = await api().fs.readFile(filePath);
  const text = atob(base64);
  return JSON.parse(text) as T;
}

/**
 * Write a JSON file to disk
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const base64 = btoa(json);
  await api().fs.writeFile(filePath, base64);
}
