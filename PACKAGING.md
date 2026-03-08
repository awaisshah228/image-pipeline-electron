# Packaging & Distribution

## Architecture

Image Pipeline Desktop is an Electron app with a Python backend. The packaging follows the same approach as [chaiNNer](https://github.com/chaiNNer-org/chaiNNer):

```
┌──────────────────────────────────────────────┐
│  .dmg / .exe / .AppImage                     │
│                                              │
│  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Electron     │  │ resources/           │  │
│  │ (frontend +  │  │  python-backend/     │  │
│  │  main proc)  │  │    src/*.py          │  │
│  │              │  │    requirements.txt  │  │
│  └──────────────┘  │  models/             │  │
│                    │  image-pipeline-nodes/│  │
│                    └──────────────────────┘  │
└──────────────────────────────────────────────┘
         │
         │ On first launch
         ▼
┌──────────────────────────────────────────────┐
│  ~/Library/Application Support/              │
│  (or %APPDATA% on Windows)                   │
│                                              │
│  integrated-python/                          │
│    python/bin/python3   ← downloaded once    │
│                                              │
│  installed-pip-packages.json  ← manifest     │
└──────────────────────────────────────────────┘
```

## What Gets Bundled in the Installer

| Component | Bundled? | Details |
|---|---|---|
| Electron frontend (React) | Yes | Compiled into `dist/` |
| Electron main process | Yes | Compiled into `dist-electron/` |
| Python source code | Yes | `python-backend/src/*.py` copied to `resources/` |
| `requirements.txt` | Yes | Copied to `resources/python-backend/` |
| ONNX Runtime (Node.js) | Yes | `node_modules/onnxruntime-node/` |
| ONNX models | Yes | `public/models/` |
| Node definitions JSON | Yes | `public/image-pipeline-nodes/` |
| Python runtime | No | Downloaded on first launch (~40MB) |
| Python pip packages | No | Installed on first launch via pip |
| AI models (YOLO, etc.) | No | Downloaded on first use |

## First Launch Flow

1. App starts and calls `python:setup` via IPC
2. Tries to find system Python (venv → system PATH → brew/conda)
3. If no Python found → downloads [python-build-standalone](https://github.com/indygreg/python-build-standalone) (Python 3.11.5, ~40MB)
4. Extracts to `~/Library/Application Support/Image Pipeline/integrated-python/`
5. Checks for required pip packages (sanic, numpy, opencv, ultralytics, etc.)
6. If missing → runs `pip install -r requirements.txt`
7. Saves a manifest of installed packages to `installed-pip-packages.json`
8. Progress is streamed to the renderer via `python:setupProgress` events

## Dependency Tracking & Cleanup

Every time pip packages are installed, the app saves a manifest at:
```
~/Library/Application Support/Image Pipeline/installed-pip-packages.json
```

This records:
- Which Python executable was used
- Full list of installed pip packages (name + version)
- Installation timestamp

On uninstall/cleanup (`python:cleanup` IPC call), the app removes:
- The integrated Python directory (~200MB+)
- The pip package manifest
- Downloaded AI models
- Temporary pipeline frame directories

## Building

### macOS (DMG)
```bash
npm run electron:build:mac
```
Outputs: `release/Image Pipeline-{version}-arm64.dmg` and `x64.dmg`

### Windows (NSIS installer)
```bash
npm run electron:build:win
```
Outputs: `release/Image Pipeline-{version}-Setup.exe`

### Linux (AppImage)
```bash
npm run electron:build:linux
```
Outputs: `release/Image Pipeline-{version}.AppImage`

## Frontend API

### Setup (call on app start)
```typescript
// Full automated setup — detects/downloads Python, installs deps
const result = await window.electronAPI.python.setup();
// result: { python: PythonInfo, depsInstalled: boolean }

// Listen for progress
const unsub = window.electronAPI.python.onSetupProgress((data) => {
  console.log(data.stage, data.percentage, data.message);
  // stage: "detect" | "download" | "extract" | "install-deps" | "check-deps" | "ready"
});
```

### Cleanup (for settings/uninstall UI)
```typescript
// Get info about what's installed
const info = await window.electronAPI.python.installInfo();
// info: { python, manifest, integratedPythonPath, integratedPythonSizeBytes }

// Full cleanup — removes Python, packages, models
const result = await window.electronAPI.python.cleanup();
// result: { removed: ["integrated-python", "package-manifest", "ai-models", "temp-frames"] }
```

## Comparison with chaiNNer

| Aspect | chaiNNer | Image Pipeline |
|---|---|---|
| Build tool | Electron Forge | electron-builder |
| Python bundling | Source in `extraResource` | Source in `extraResources` |
| Python runtime | python-build-standalone | python-build-standalone |
| Pip packages | Installed at runtime | Installed at runtime |
| Package tracking | No manifest | Manifest + cleanup |
| Internet needed | First launch | First launch |
