"""Model management routes."""

import traceback

from sanic import Blueprint, response
from sanic.request import Request

from src import state

bp = Blueprint("models", url_prefix="/models")


@bp.get("/list")
async def list_models(request: Request):
    """List loaded models."""
    return response.json({
        "models": list(state.models.keys()),
        "device": state.device,
    })


@bp.post("/load")
async def load_model(request: Request):
    """Pre-load a model for faster inference."""
    data = request.json
    model_name = data.get("model", "yolov8n.pt")

    try:
        from ultralytics import YOLO

        if model_name not in state.models:
            state.models[model_name] = YOLO(model_name)
            if state.device != "cpu":
                state.models[model_name].to(state.device)

        return response.json({"type": "success", "model": model_name, "device": state.device})
    except Exception as e:
        return response.json({"type": "error", "message": str(e)}, status=500)


@bp.post("/unload")
async def unload_model(request: Request):
    """Unload a model to free memory."""
    data = request.json
    model_name = data.get("model")
    if model_name in state.models:
        del state.models[model_name]
        if state.device == "cuda":
            import torch
            torch.cuda.empty_cache()
    return response.json({"type": "success"})


@bp.get("/ai-status")
async def ai_model_status(request: Request):
    """Check which AI models are downloaded/cached."""
    import os
    from pathlib import Path

    # rembg models (stored in ~/.u2net/)
    u2net_dir = Path.home() / ".u2net"
    rembg_models = {
        "birefnet-general": "BiRefNet_general_epoch_244.onnx",
        "birefnet-general-lite": "BiRefNet_general_lite.onnx",
        "birefnet-portrait": "BiRefNet_portrait_epoch_150.onnx",
        "u2net": "u2net.onnx",
        "isnet-general-use": "isnet-general-use.onnx",
        "silueta": "silueta.onnx",
        "bria-rmbg": "bria-rmbg.onnx",
    }
    rembg_status = {}
    for name, filename in rembg_models.items():
        path = u2net_dir / filename
        if path.exists():
            size_mb = path.stat().st_size / (1024 * 1024)
            rembg_status[name] = {"downloaded": True, "size_mb": round(size_mb, 1)}
        else:
            rembg_status[name] = {"downloaded": False}

    # MobileSAM
    sam_path = Path.home() / ".mobile_sam" / "mobile_sam.pt"
    sam_status = {
        "downloaded": sam_path.exists(),
        "size_mb": round(sam_path.stat().st_size / (1024 * 1024), 1) if sam_path.exists() else 0,
    }

    # YOLO
    yolo_status = {"loaded": list(state.models.keys())}

    return response.json({
        "rembg": rembg_status,
        "mobile_sam": sam_status,
        "yolo": yolo_status,
    })


@bp.post("/download-ai")
async def download_ai_model(request: Request):
    """Download a specific AI model on demand."""
    import asyncio

    data = request.json
    model_type = data.get("type", "")  # "rembg", "mobile_sam"
    model_name = data.get("name", "")

    try:
        if model_type == "rembg":
            # Run in thread to not block the event loop
            def _download():
                from rembg import new_session
                new_session(model_name)
            await asyncio.get_event_loop().run_in_executor(None, _download)
            return response.json({"type": "success", "model": model_name})

        elif model_type == "mobile_sam":
            import urllib.request
            from pathlib import Path
            def _download():
                ckpt_dir = Path.home() / ".mobile_sam"
                ckpt_dir.mkdir(parents=True, exist_ok=True)
                ckpt_path = ckpt_dir / "mobile_sam.pt"
                if not ckpt_path.exists():
                    urllib.request.urlretrieve(
                        "https://github.com/ChaoningZhang/MobileSAM/raw/master/weights/mobile_sam.pt",
                        str(ckpt_path),
                    )
            await asyncio.get_event_loop().run_in_executor(None, _download)
            return response.json({"type": "success", "model": "mobile_sam"})

        else:
            return response.json({"type": "error", "message": f"Unknown model type: {model_type}"}, status=400)

    except Exception as e:
        return response.json({"type": "error", "message": str(e)}, status=500)
