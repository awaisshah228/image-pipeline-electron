import { app, BrowserWindow, ipcMain, dialog, shell, session } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { registerFileSystemHandlers, registerFfmpegHandlers } from "./ipc/file-system";
import { registerModelHandlers } from "./ipc/model-loader";
import { registerGpuInferenceHandlers } from "./ipc/gpu-inference";
import { registerPythonBackendHandlers, cleanupPythonBackend } from "./ipc/python-backend";

// The built directory structure
//
// ├─┬─ dist-electron
// │ ├── main.js
// │ └── preload.js
// ├─┬─ dist
// │ └── index.html

process.env.DIST = path.join(__dirname, "../dist");
process.env.VITE_PUBLIC = app.isPackaged
  ? path.join(process.resourcesPath)
  : path.join(__dirname, "../public");

let mainWindow: BrowserWindow | null = null;

const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Image Pipeline",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Allow workers to use module syntax
      nodeIntegrationInWorker: false,
    },
    backgroundColor: "#0f1012",
    show: false,
  });

  // Show window when ready to avoid white flash
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(process.env.DIST!, "index.html"));
  }
}

// Register all IPC handlers
function registerIpcHandlers() {
  registerFileSystemHandlers(ipcMain);
  registerFfmpegHandlers(ipcMain);
  registerModelHandlers(ipcMain);
  registerGpuInferenceHandlers(ipcMain);
  registerPythonBackendHandlers(ipcMain, () => mainWindow);

  // App info
  ipcMain.handle("app:getPath", (_e, name: string) => {
    return app.getPath(name as "userData" | "downloads" | "documents" | "temp");
  });

  ipcMain.handle("app:getResourcesPath", () => {
    return app.isPackaged ? process.resourcesPath : path.join(__dirname, "../public");
  });

  // Dialog helpers
  ipcMain.handle("dialog:openFile", async (_e, options: Electron.OpenDialogOptions) => {
    const result = await dialog.showOpenDialog(mainWindow!, options);
    return result;
  });

  ipcMain.handle("dialog:saveFile", async (_e, options: Electron.SaveDialogOptions) => {
    const result = await dialog.showSaveDialog(mainWindow!, options);
    return result;
  });

  ipcMain.handle("dialog:openDirectory", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

app.whenReady().then(() => {
  // Grant camera/microphone permissions automatically
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ["media", "mediaKeySystem", "display-capture"];
    callback(allowed.includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowed = ["media", "mediaKeySystem", "display-capture"];
    return allowed.includes(permission);
  });

  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Clean up Python backend and temp frame directories on quit
app.on("will-quit", async (e) => {
  e.preventDefault();
  await cleanupPythonBackend();
  // Remove all pipeline temp frame directories
  try {
    const framesDir = path.join(app.getPath("userData"), "pipeline_frames");
    await fs.rm(framesDir, { recursive: true, force: true });
  } catch { /* ignore if doesn't exist */ }
  app.exit(0);
});
