"""
Python backend server for Image Pipeline Desktop.
Thin entry point — routes live in routes/ modules.
"""

import sys
import os

from sanic import Sanic, response
from sanic.request import Request

# Add parent dir so 'src' package can be imported when run directly
if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import state
from src.routes import yolo, cv, image, pipeline, queue, video, models, frames

app = Sanic("ImagePipelineBackend")

# Register blueprints
app.blueprint(yolo.bp)
app.blueprint(cv.bp)
app.blueprint(image.bp)
app.blueprint(pipeline.bp)
app.blueprint(queue.bp)
app.blueprint(video.bp)
app.blueprint(models.bp)
app.blueprint(frames.bp)


# ── Startup ──
@app.before_server_start
async def setup(app, loop):
    # Detect GPU
    try:
        import torch
        state.gpu_available = torch.cuda.is_available()
        if state.gpu_available:
            state.device = "cuda"
            print(f"[Backend] GPU available: {torch.cuda.get_device_name(0)}")
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            state.gpu_available = True
            state.device = "mps"
            print("[Backend] Apple Metal GPU available")
        else:
            print("[Backend] No GPU detected, using CPU")
    except ImportError:
        print("[Backend] PyTorch not installed, using CPU-only mode")

    print(f"[Backend] Server starting on port {app.config.get('PORT', 8765)}")

    # Pre-load models in background thread so server starts immediately
    import threading

    def _preload_models():
        # YOLO (small, ~6MB)
        try:
            from ultralytics import YOLO
            if "yolov8n.pt" not in state.models:
                print("[Backend] Pre-loading YOLOv8n model...")
                state.models["yolov8n.pt"] = YOLO("yolov8n.pt")
                if state.device != "cpu":
                    state.models["yolov8n.pt"].to(state.device)
                print("[Backend] YOLOv8n model ready")
        except Exception as e:
            print(f"[Backend] YOLO pre-load skipped: {e}")

    threading.Thread(target=_preload_models, daemon=True).start()


# Initialize async queue
app.register_listener(queue.init, "before_server_start")


# ── Health Check ──
@app.get("/health")
async def health(request: Request):
    return response.json({
        "status": "ok",
        "gpu": state.gpu_available,
        "device": state.device,
        "python": sys.version,
    })


# ── System Info ──
@app.get("/system-info")
async def system_info(request: Request):
    import psutil

    info = {
        "cpu_percent": psutil.cpu_percent(interval=0.1),
        "memory": {
            "total": psutil.virtual_memory().total,
            "available": psutil.virtual_memory().available,
            "percent": psutil.virtual_memory().percent,
        },
        "gpu": None,
    }

    if state.gpu_available and state.device == "cuda":
        try:
            import torch
            info["gpu"] = {
                "name": torch.cuda.get_device_name(0),
                "memory_total": torch.cuda.get_device_properties(0).total_mem,
                "memory_allocated": torch.cuda.memory_allocated(0),
                "memory_reserved": torch.cuda.memory_reserved(0),
            }
        except Exception:
            pass

    return response.json(info)


# ── Shutdown ──
@app.post("/shutdown")
async def shutdown(request: Request):
    state.models.clear()
    if state.device == "cuda":
        try:
            import torch
            torch.cuda.empty_cache()
        except Exception:
            pass
    app.stop()
    return response.json({"type": "success"})


# ── Entry Point ──
if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    dev_mode = "--dev" in sys.argv
    app.config.PORT = port

    print(f"[Backend] Starting Python backend on port {port}")
    print(f"[Backend] Python {sys.version}")
    print(f"[Backend] PID: {os.getpid()}")
    if dev_mode:
        print("[Backend] DEV MODE: auto-reload enabled")

    app.run(
        host="127.0.0.1",
        port=port,
        single_process=not dev_mode,
        access_log=dev_mode,
        auto_reload=dev_mode,
        debug=dev_mode,
    )
