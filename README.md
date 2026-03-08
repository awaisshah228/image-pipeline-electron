# Image Pipeline Desktop

A node-based visual image/video processing editor built with Electron, React, and a Python ML backend. Drag-and-drop pipeline nodes to build real-time computer vision workflows — YOLO object detection, OpenCV filters, image transforms, webcam capture, and video encoding.

![Pipeline Editor](https://img.shields.io/badge/Electron-React-blue) ![Python Backend](https://img.shields.io/badge/Backend-Python%20Sanic-green) ![ML](https://img.shields.io/badge/ML-YOLOv8%20%7C%20OpenCV-orange)

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Electron App                       │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  React UI   │  │  Main Process│  │  Preload   │ │
│  │  (Renderer) │◄─┤  (Node.js)   │◄─┤  (IPC)     │ │
│  │             │  │              │  │            │ │
│  │ React Flow  │  │ File System  │  │ Bridge API │ │
│  │ Zustand     │  │ ffmpeg       │  │            │ │
│  │ Pipeline    │  │ ONNX Runtime │  │            │ │
│  │ Store       │  │              │  │            │ │
│  └──────┬──────┘  └──────────────┘  └────────────┘ │
│         │                                           │
│         │ HTTP (localhost)                           │
│         ▼                                           │
│  ┌─────────────────────────────────────────┐        │
│  │         Python Backend (Sanic)          │        │
│  │                                         │        │
│  │  YOLO Detection    OpenCV Operations    │        │
│  │  Pillow Transforms Batch Processing     │        │
│  │  Video Encoding    GPU Acceleration     │        │
│  └─────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────┘
```

### How It Works

1. **Pipeline Editor** — Visual node graph (React Flow + Zustand). Users connect nodes to build processing chains. Node definitions are JSON files in `public/image-pipeline-nodes/`.

2. **Processing Flow** — When a node runs, the frontend collects the entire downstream chain and sends it as a single fused HTTP call to the Python backend (`/pipeline/process`). This eliminates N-1 round-trips for N-node chains.

3. **Webcam Pipeline** — 3-phase architecture:
   - **Phase 1 (CAPTURE)**: Raw frames saved to disk at requested FPS with drift-compensated timing. Live `<video>` element uses `srcObject` for zero-copy GPU-composited preview.
   - **Real-time processing**: Every 3rd frame is sent through the downstream pipeline for live YOLO/filter results on connected nodes.
   - **Phase 2 (PROCESS)**: After capture stops, Python batch-processes ALL frames from disk → disk.
   - **Phase 3 (ENCODE)**: ffmpeg combines processed frames into video (Node.js ffmpeg → Python ffmpeg → browser MediaRecorder fallback).

4. **Python Backend** — Sanic async HTTP server, auto-started by Electron. Handles YOLO (Ultralytics), OpenCV operations, Pillow transforms, and video encoding. GPU-accelerated when CUDA is available.

### Key Files

```
electron/
  main.ts                 — Electron main process, window creation, cleanup
  preload.ts              — IPC bridge (renderer ↔ main process)
  ipc/
    file-system.ts        — File I/O + ffmpeg encoding handlers
    python-backend.ts     — Python process management + API forwarding
    gpu-inference.ts      — ONNX Runtime GPU inference
    model-loader.ts       — ML model management

src/
  lib/image-pipeline/
    pipeline-store.ts     — Zustand store: node graph, processing, webcam pipeline
    native-processor.ts   — Routes operations to Python backend endpoints
    webcam-processor.ts   — Webcam capture with disk-saving + live preview
    video-processor.ts    — Browser-side video frame extraction/encoding
    types.ts              — Pipeline node/edge type definitions
    node-registry.ts      — Loads node definitions from JSON
    connection-validator.ts — Type-safe connection validation
    pipeline-templates.ts — Preset pipeline templates

  components/image-pipeline/
    flow/
      PipelineNode.tsx    — Node component (fields, preview, webcam video)
      PipelineCanvas.tsx  — React Flow canvas with drag-drop
      PipelineEdge.tsx    — Custom animated edges
    sidebar/
      PipelineSidebar.tsx — Node palette + search

python-backend/
  src/server.py           — Sanic server: YOLO, OpenCV, Pillow, batch, video

public/image-pipeline-nodes/
  *.json                  — Node definitions (inputs, outputs, types, defaults)
```

## Setup

### Prerequisites

- **Node.js** 18+
- **Python** 3.9+ (3.10+ recommended)
- **ffmpeg** (optional, for video encoding — falls back to browser encoder)

### 1. Install Node Dependencies

```bash
npm install
```

### 2. Setup Python Backend

```bash
cd python-backend

# Create virtual environment
python -m venv venv
source venv/bin/activate   # macOS/Linux
# venv\Scripts\activate    # Windows

# Install dependencies
pip install -r requirements.txt
```

> **GPU Support**: On Linux/Windows with NVIDIA GPU, `onnxruntime-gpu` is installed automatically. On macOS, it uses CPU-only `onnxruntime`. For YOLO GPU acceleration, ensure PyTorch with CUDA is installed (`pip install torch torchvision --index-url https://download.pytorch.org/whl/cu118`).

### 3. Run in Development

```bash
# Start Electron + Vite dev server
npm run electron:dev
```

This starts:
- Vite dev server on `http://localhost:5173`
- Electron window pointing to the dev server
- Python backend auto-starts when you open the pipeline editor

### 4. Build for Production

```bash
# macOS
npm run electron:build:mac

# Windows
npm run electron:build:win

# Linux
npm run electron:build:linux
```

Output goes to `release/` directory.

## Node Types

| Category | Nodes |
|----------|-------|
| **Input** | Load Image, Load URL, Text Input, Number Input, Color Input |
| **Computer Vision** | YOLO Detection, Face Detection (OpenCV), Contour Detection, Canny Edge, Color Detection, People Detection, Webcam Capture |
| **Image Transform** | Flip, Rotate, Resize, Crop, Pad |
| **Image Adjust** | Brightness/Contrast, Hue/Saturation, Color Balance, Levels, Invert, Grayscale |
| **Image Filter** | Blur, Sharpen, Denoise, Edge Detect, Threshold, Bilateral Filter |
| **Batch/Video** | Load Video Frames, Save Video, Batch Load, Batch Save, Iterator, Collector |
| **Output** | Preview Image, Save Image, Number Display, Image Gallery |

## Features

- **Fused pipeline** — Multi-node chains execute in a single HTTP call
- **YOLO class filtering** — Filter detections by class name (e.g. only "person")
- **Real-time webcam** — Live YOLO detection on webcam feed with stats overlay
- **Auto-save video** — Set output directory on Save Video node for automatic encoding
- **Undo/Redo** — Full history with Ctrl+Z / Ctrl+Shift+Z
- **Pipeline templates** — One-click preset pipelines (Webcam + YOLO, etc.)
- **GPU acceleration** — CUDA for YOLO/ONNX, Metal for macOS (when available)

## License

Private — All rights reserved.
