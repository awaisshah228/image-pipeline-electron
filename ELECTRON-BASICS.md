# Electron.js — Basic Concepts

## What is Electron?

Electron is a framework that lets you build desktop applications using web technologies (HTML, CSS, JavaScript). It combines **Chromium** (for rendering UI) and **Node.js** (for system access) into a single runtime.

Apps like VS Code, Discord, and Slack are built with Electron.

---

## Architecture Overview

Electron has a **multi-process architecture** with three key parts:

```
┌─────────────────────────────────────────┐
│            Main Process                 │
│   (Node.js — full system access)        │
│   Creates windows, handles native APIs  │
└──────────────┬──────────────────────────┘
               │  IPC (inter-process communication)
┌──────────────▼──────────────────────────┐
│          Preload Script                 │
│   (Bridge between Main & Renderer)      │
│   Exposes safe APIs via contextBridge   │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│         Renderer Process                │
│   (Chromium — your web UI)              │
│   Runs HTML/CSS/JS, React, Vue, etc.   │
└─────────────────────────────────────────┘
```

---

## 1. Main Process

The main process is the **entry point** of your Electron app. There is only **one** main process per application.

### What it does:
- Creates and manages browser windows (`BrowserWindow`)
- Accesses native OS APIs (file system, menus, dialogs, tray, notifications)
- Manages the application lifecycle (startup, quit, etc.)
- Handles IPC messages from renderer processes

### Key characteristics:
- Runs in **Node.js** — full access to Node modules and system APIs
- Has **no UI** — it controls windows but doesn't render anything
- If the main process exits, the entire app closes

### Example:

```js
const { app, BrowserWindow } = require('electron')

// App lifecycle — runs when Electron is ready
app.whenReady().then(() => {
  // Create a browser window (this spawns a renderer process)
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  })

  // Load your web UI into the window
  win.loadFile('index.html')
})

// Quit when all windows are closed
app.on('window-all-closed', () => {
  app.quit()
})
```

---

## 2. Renderer Process

Each browser window runs in its own **renderer process**. It's essentially a Chromium web page.

### What it does:
- Renders your UI (HTML, CSS, JavaScript)
- Runs your frontend framework (React, Vue, Angular, etc.)
- Each `BrowserWindow` creates a **separate** renderer process

### Key characteristics:
- Runs in a **browser environment** (has `window`, `document`, DOM APIs)
- Does **NOT** have direct access to Node.js or system APIs (for security)
- Communicates with the main process through **IPC** (via the preload script)
- If one renderer crashes, other windows stay open

### Example:

```html
<!-- index.html — loaded by the renderer process -->
<!DOCTYPE html>
<html>
  <body>
    <h1>Hello from Electron!</h1>
    <button id="btn">Click me</button>

    <script>
      // This runs in the renderer (browser context)
      document.getElementById('btn').addEventListener('click', () => {
        // Call a function exposed by the preload script
        window.electronAPI.doSomething()
      })
    </script>
  </body>
</html>
```

---

## 3. Preload Script

The preload script is the **secure bridge** between the main process and the renderer process.

### What it does:
- Runs **before** the web page loads in the renderer
- Uses `contextBridge` to safely expose specific APIs to the renderer
- Keeps Node.js and system APIs hidden from the web page

### Why it exists:
Without a preload script, you'd have two bad options:
1. Give the renderer full Node.js access (`nodeIntegration: true`) — **dangerous**, especially if loading external content
2. No communication between main and renderer — **useless** for desktop features

The preload script solves this by exposing **only what you choose**.

### Example:

```js
// preload.js
const { contextBridge, ipcRenderer } = require('electron')

// Expose a safe API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Renderer can call window.electronAPI.openFile()
  openFile: () => ipcRenderer.invoke('dialog:openFile'),

  // Renderer can call window.electronAPI.saveData(data)
  saveData: (data) => ipcRenderer.send('save-data', data),

  // Renderer can listen for events from main
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', callback)
})
```

---

## 4. IPC (Inter-Process Communication)

Since the main and renderer processes are isolated, they communicate using **IPC channels**.

### Patterns:

#### Renderer to Main (one-way)
```js
// Preload
contextBridge.exposeInMainWorld('electronAPI', {
  sendMessage: (msg) => ipcRenderer.send('message', msg)
})

// Main
ipcMain.on('message', (event, msg) => {
  console.log(msg)
})
```

#### Renderer to Main to Renderer (two-way)
```js
// Preload
contextBridge.exposeInMainWorld('electronAPI', {
  getData: () => ipcRenderer.invoke('get-data')
})

// Main
ipcMain.handle('get-data', async () => {
  return { name: 'Electron', version: '28.0' }
})

// Renderer
const data = await window.electronAPI.getData()
```

#### Main to Renderer
```js
// Main — send to a specific window
win.webContents.send('update-available', { version: '2.0' })

// Preload — expose listener
contextBridge.exposeInMainWorld('electronAPI', {
  onUpdate: (callback) => ipcRenderer.on('update-available', (_event, data) => callback(data))
})
```

---

## 5. Typical Project Structure

```
my-electron-app/
├── electron/
│   ├── main.ts          # Main process entry point
│   └── preload.ts       # Preload script (bridge)
├── src/
│   ├── App.tsx           # Renderer (React UI)
│   ├── main.tsx          # Renderer entry point
│   └── components/       # UI components
├── index.html            # HTML loaded by BrowserWindow
├── package.json
└── electron-builder.json # Build/packaging config
```

---

## Quick Reference

| Concept          | Runs In   | Access To                    | Count              |
|------------------|-----------|------------------------------|--------------------|
| Main Process     | Node.js   | Full OS + Node APIs          | One per app        |
| Renderer Process | Chromium  | DOM + Web APIs only          | One per window     |
| Preload Script   | Both      | Limited Node + DOM           | One per window     |

---

## Common Pitfalls

1. **Don't enable `nodeIntegration: true`** — it gives the renderer full Node.js access, which is a security risk
2. **Don't skip the preload script** — always use `contextBridge` to expose APIs safely
3. **Don't do heavy computation in the renderer** — it blocks the UI; use the main process or worker threads
4. **Don't forget IPC is async** — use `invoke/handle` for request-response patterns

---

## Useful Links

- [Electron Docs](https://www.electronjs.org/docs)
- [Electron Fiddle](https://www.electronjs.org/fiddle) — quick prototyping tool
- [Electron Forge](https://www.electronforge.io/) — tooling for building and packaging
