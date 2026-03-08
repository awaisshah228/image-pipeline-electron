"""
Python backend server for Image Pipeline Desktop.
Communicates with Electron via HTTP (localhost).
Handles CPU/GPU-intensive tasks: YOLO, OpenCV, image processing, ML inference.
"""

import sys
import os
import asyncio
import json
import base64
import io
import time
import traceback
from pathlib import Path

import numpy as np
from sanic import Sanic, response
from sanic.request import Request
from PIL import Image

app = Sanic("ImagePipelineBackend")

# ── Global State ──
_models = {}  # cached model instances
_gpu_available = False
_device = "cpu"


# ── Startup ──
@app.before_server_start
async def setup(app, loop):
    global _gpu_available, _device

    # Detect GPU
    try:
        import torch
        _gpu_available = torch.cuda.is_available()
        if _gpu_available:
            _device = "cuda"
            print(f"[Backend] GPU available: {torch.cuda.get_device_name(0)}")
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            _gpu_available = True
            _device = "mps"
            print("[Backend] Apple Metal GPU available")
        else:
            print("[Backend] No GPU detected, using CPU")
    except ImportError:
        print("[Backend] PyTorch not installed, using CPU-only mode")

    print(f"[Backend] Server starting on port {app.config.get('PORT', 8765)}")


# ── Health Check ──
@app.get("/health")
async def health(request: Request):
    return response.json({
        "status": "ok",
        "gpu": _gpu_available,
        "device": _device,
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

    # GPU info
    if _gpu_available and _device == "cuda":
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


# ── Image Helpers ──
def decode_image(data_url: str) -> np.ndarray:
    """Decode a data URL or base64 string to a numpy array (BGR)."""
    import cv2

    if data_url.startswith("data:"):
        header, b64 = data_url.split(",", 1)
    else:
        b64 = data_url

    img_bytes = base64.b64decode(b64)
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Failed to decode image")
    return img


def encode_image(img: np.ndarray, format: str = "jpeg", quality: int = 85) -> str:
    """Encode a numpy array (BGR) to a data URL."""
    import cv2

    if format == "jpeg":
        _, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
        mime = "image/jpeg"
    else:
        _, buf = cv2.imencode(".png", img)
        mime = "image/png"

    b64 = base64.b64encode(buf.tobytes()).decode("utf-8")
    return f"data:{mime};base64,{b64}"


def pil_to_dataurl(img: Image.Image, format: str = "JPEG", quality: int = 85) -> str:
    """Convert PIL Image to data URL."""
    buf = io.BytesIO()
    img.save(buf, format=format, quality=quality)
    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
    mime = "image/jpeg" if format == "JPEG" else "image/png"
    return f"data:{mime};base64,{b64}"


# ── YOLO Detection ──
@app.post("/yolo/detect")
async def yolo_detect(request: Request):
    """Run YOLO object detection on an image."""
    data = request.json
    image_data = data["image"]
    model_name = data.get("model", "yolov8n.pt")
    confidence = data.get("confidence", 0.25)
    iou = data.get("iou", 0.45)
    filter_classes = data.get("filter_classes", [])  # list of class names to filter

    # Normalize model name: if path doesn't exist, extract basename and use .pt
    if model_name and not os.path.isfile(model_name):
        basename = os.path.basename(model_name)
        if basename.endswith(".onnx"):
            basename = basename.replace(".onnx", ".pt")
        model_name = basename
    if not model_name:
        model_name = "yolov8n.pt"

    try:
        from ultralytics import YOLO

        # Cache model
        if model_name not in _models:
            _models[model_name] = YOLO(model_name)
            if _device != "cpu":
                _models[model_name].to(_device)

        model = _models[model_name]

        # Resolve filter class names to class indices
        class_indices = None
        if filter_classes:
            name_to_idx = {v.lower(): k for k, v in model.names.items()}
            class_indices = [name_to_idx[c.lower()] for c in filter_classes if c.lower() in name_to_idx]
            if not class_indices:
                class_indices = None  # no valid classes found, show all

        # Decode image
        img = decode_image(image_data)

        # Run inference (classes param filters at detection level)
        results = model.predict(
            img,
            conf=confidence,
            iou=iou,
            classes=class_indices,
            device=_device,
            verbose=False,
        )

        result = results[0]

        # Draw detections on image
        annotated = result.plot()
        annotated_url = encode_image(annotated)

        # Extract detection data
        detections = []
        if result.boxes is not None:
            for box in result.boxes:
                x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                detections.append({
                    "class": int(box.cls[0]),
                    "class_name": model.names[int(box.cls[0])],
                    "confidence": float(box.conf[0]),
                    "bbox": [float(x1), float(y1), float(x2 - x1), float(y2 - y1)],
                })

        # Crop detected objects
        crops = []
        if result.boxes is not None:
            for box in result.boxes:
                x1, y1, x2, y2 = map(int, box.xyxy[0].cpu().numpy())
                crop = img[max(0, y1):y2, max(0, x1):x2]
                if crop.size > 0:
                    crops.append(encode_image(crop))

        return response.json({
            "type": "success",
            "annotated_image": annotated_url,
            "detections": detections,
            "count": len(detections),
            "crops": crops,
        })

    except Exception as e:
        return response.json({
            "type": "error",
            "message": str(e),
            "traceback": traceback.format_exc(),
        }, status=500)


# ── OpenCV Operations ──
@app.post("/cv/process")
async def cv_process(request: Request):
    """Run OpenCV operations on an image."""
    data = request.json
    image_data = data["image"]
    operation = data["operation"]
    params = data.get("params", {})

    try:
        import cv2

        img = decode_image(image_data)
        result_img = img
        metadata = {}

        if operation in ("face_detect", "face_detect_cv"):
            cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
            cascade = cv2.CascadeClassifier(cascade_path)
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            scale = params.get("scale_factor", 1.1)
            neighbors = params.get("min_neighbors", 5)
            faces = cascade.detectMultiScale(gray, scaleFactor=scale, minNeighbors=neighbors)

            result_img = img.copy()
            face_crops = []
            for (x, y, w, h) in faces:
                cv2.rectangle(result_img, (x, y), (x + w, y + h), (0, 255, 0), 2)
                crop = img[y:y+h, x:x+w]
                face_crops.append(encode_image(crop))

            metadata["count"] = len(faces)
            metadata["faces"] = [{"x": int(x), "y": int(y), "w": int(w), "h": int(h)} for (x, y, w, h) in faces]
            metadata["faceImages"] = face_crops
            metadata["images"] = face_crops

        elif operation == "canny_edge":
            low = params.get("low_threshold", 50)
            high = params.get("high_threshold", 150)
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            edges = cv2.Canny(gray, low, high)
            result_img = cv2.cvtColor(edges, cv2.COLOR_GRAY2BGR)

        elif operation == "contour_detect":
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            _, thresh = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)
            contours, _ = cv2.findContours(thresh, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
            result_img = img.copy()
            cv2.drawContours(result_img, contours, -1, (0, 255, 0), 2)
            metadata["count"] = len(contours)

        elif operation == "histogram_eq":
            if len(img.shape) == 2:
                result_img = cv2.equalizeHist(img)
            else:
                ycrcb = cv2.cvtColor(img, cv2.COLOR_BGR2YCrCb)
                ycrcb[:, :, 0] = cv2.equalizeHist(ycrcb[:, :, 0])
                result_img = cv2.cvtColor(ycrcb, cv2.COLOR_YCrCb2BGR)

        elif operation in ("gaussian_blur", "gaussian_blur_cv"):
            ksize = int(params.get("kernel_size", 5))
            if ksize % 2 == 0:
                ksize += 1
            result_img = cv2.GaussianBlur(img, (ksize, ksize), 0)

        elif operation == "bilateral_filter":
            d = int(params.get("d", 9))
            sigma_color = params.get("sigma_color", 75)
            sigma_space = params.get("sigma_space", 75)
            result_img = cv2.bilateralFilter(img, d, sigma_color, sigma_space)

        elif operation == "morphology":
            op_type = params.get("type", "dilate")
            ksize = int(params.get("kernel_size", 5))
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (ksize, ksize))
            ops = {
                "dilate": cv2.MORPH_DILATE,
                "erode": cv2.MORPH_ERODE,
                "open": cv2.MORPH_OPEN,
                "close": cv2.MORPH_CLOSE,
                "gradient": cv2.MORPH_GRADIENT,
            }
            morph_op = ops.get(op_type, cv2.MORPH_DILATE)
            result_img = cv2.morphologyEx(img, morph_op, kernel)

        elif operation == "color_space":
            target = params.get("color_space", "Grayscale")
            conversions = {
                "Grayscale": cv2.COLOR_BGR2GRAY,
                "HSV": cv2.COLOR_BGR2HSV,
                "LAB": cv2.COLOR_BGR2LAB,
                "RGB": cv2.COLOR_BGR2RGB,
            }
            conv = conversions.get(target)
            if conv is not None:
                result_img = cv2.cvtColor(img, conv)
                if len(result_img.shape) == 2:
                    result_img = cv2.cvtColor(result_img, cv2.COLOR_GRAY2BGR)

        elif operation == "adaptive_threshold":
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            block_size = int(params.get("block_size", 11))
            if block_size % 2 == 0:
                block_size += 1
            c = params.get("c", 2)
            result_img = cv2.adaptiveThreshold(
                gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                cv2.THRESH_BINARY, block_size, c
            )
            result_img = cv2.cvtColor(result_img, cv2.COLOR_GRAY2BGR)

        elif operation == "color_detect":
            # Detect a specific color range in HSV space
            hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
            lower_h = int(params.get("lower_hue", 0))
            upper_h = int(params.get("upper_hue", 180))
            lower_s = int(params.get("lower_saturation", 50))
            upper_s = int(params.get("upper_saturation", 255))
            lower_v = int(params.get("lower_value", 50))
            upper_v = int(params.get("upper_value", 255))
            lower = np.array([lower_h, lower_s, lower_v])
            upper = np.array([upper_h, upper_s, upper_v])
            mask = cv2.inRange(hsv, lower, upper)
            result_img = cv2.bitwise_and(img, img, mask=mask)
            metadata["pixel_count"] = int(cv2.countNonZero(mask))

        elif operation in ("people_detect", "cascade_detect"):
            # Full-body or custom cascade detection
            cascade_type = params.get("cascade", "fullbody")
            cascade_map = {
                "fullbody": "haarcascade_fullbody.xml",
                "upperbody": "haarcascade_upperbody.xml",
                "lowerbody": "haarcascade_lowerbody.xml",
                "profileface": "haarcascade_profileface.xml",
                "frontalface": "haarcascade_frontalface_default.xml",
                "eye": "haarcascade_eye.xml",
                "smile": "haarcascade_smile.xml",
            }
            cascade_file = cascade_map.get(cascade_type, cascade_type)
            cascade_path = cv2.data.haarcascades + cascade_file
            cascade = cv2.CascadeClassifier(cascade_path)
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            scale = params.get("scale_factor", 1.1)
            neighbors = params.get("min_neighbors", 5)
            detections = cascade.detectMultiScale(gray, scaleFactor=scale, minNeighbors=neighbors)
            result_img = img.copy()
            for (x, y, w, h) in detections:
                cv2.rectangle(result_img, (x, y), (x + w, y + h), (0, 255, 0), 2)
            metadata["count"] = len(detections)

        elif operation == "resize":
            width = int(params.get("width", img.shape[1]))
            height = int(params.get("height", img.shape[0]))
            interp = params.get("interpolation", "LANCZOS4")
            interp_map = {
                "NEAREST": cv2.INTER_NEAREST,
                "LINEAR": cv2.INTER_LINEAR,
                "CUBIC": cv2.INTER_CUBIC,
                "LANCZOS4": cv2.INTER_LANCZOS4,
            }
            result_img = cv2.resize(img, (width, height), interpolation=interp_map.get(interp, cv2.INTER_LANCZOS4))

        else:
            return response.json({
                "type": "error",
                "message": f"Unknown operation: {operation}",
            }, status=400)

        return response.json({
            "type": "success",
            "image": encode_image(result_img),
            "metadata": metadata,
        })

    except Exception as e:
        return response.json({
            "type": "error",
            "message": str(e),
            "traceback": traceback.format_exc(),
        }, status=500)


# ── Image Processing (PIL-based) ──
@app.post("/image/process")
async def image_process(request: Request):
    """Basic image processing operations using Pillow."""
    data = request.json
    image_data = data["image"]
    operation = data["operation"]
    params = data.get("params", {})

    try:
        from PIL import ImageFilter, ImageEnhance, ImageOps

        # Decode to PIL
        if image_data.startswith("data:"):
            _, b64 = image_data.split(",", 1)
        else:
            b64 = image_data
        img = Image.open(io.BytesIO(base64.b64decode(b64)))

        if operation == "blur":
            radius = params.get("radius", 2)
            img = img.filter(ImageFilter.GaussianBlur(radius=radius))

        elif operation == "sharpen":
            amount = params.get("amount", 1.5)
            enhancer = ImageEnhance.Sharpness(img)
            img = enhancer.enhance(amount)

        elif operation == "brightness_contrast":
            brightness = params.get("brightness", 1.0)
            contrast = params.get("contrast", 1.0)
            img = ImageEnhance.Brightness(img).enhance(brightness)
            img = ImageEnhance.Contrast(img).enhance(contrast)

        elif operation == "flip":
            direction = params.get("direction", "horizontal")
            if direction == "horizontal":
                img = ImageOps.mirror(img)
            else:
                img = ImageOps.flip(img)

        elif operation == "rotate":
            angle = params.get("angle", 90)
            img = img.rotate(angle, expand=True)

        elif operation == "grayscale":
            img = ImageOps.grayscale(img).convert("RGB")

        elif operation == "invert":
            img = ImageOps.invert(img.convert("RGB"))

        elif operation == "crop":
            left = int(params.get("left", 0))
            top = int(params.get("top", 0))
            right = int(params.get("right", img.width))
            bottom = int(params.get("bottom", img.height))
            img = img.crop((left, top, right, bottom))

        elif operation == "resize":
            width = int(params.get("width", img.width))
            height = int(params.get("height", img.height))
            img = img.resize((width, height), Image.LANCZOS)

        elif operation == "pad":
            pad = int(params.get("padding", 10))
            color = params.get("color", "#000000")
            from PIL import ImageOps as PadOps
            img = PadOps.expand(img, border=pad, fill=color)

        elif operation == "hue_saturation":
            from PIL import ImageEnhance as HE
            saturation = params.get("saturation", 1.0)
            img = HE.Color(img).enhance(saturation)

        elif operation == "color_balance":
            from PIL import ImageEnhance as CB
            factor = params.get("factor", 1.0)
            img = CB.Color(img).enhance(factor)

        elif operation == "levels":
            from PIL import ImageOps as LO
            img = LO.autocontrast(img, cutoff=int(params.get("cutoff", 0)))

        elif operation == "opacity":
            alpha = params.get("alpha", 1.0)
            img = img.convert("RGBA")
            r, g, b, a = img.split()
            a = a.point(lambda x: int(x * alpha))
            img = Image.merge("RGBA", (r, g, b, a)).convert("RGB")

        elif operation == "denoise":
            radius = int(params.get("radius", 2))
            img = img.filter(ImageFilter.MedianFilter(size=max(3, radius * 2 + 1)))

        elif operation == "edge_detect":
            img = img.filter(ImageFilter.FIND_EDGES)

        elif operation == "threshold":
            thresh = int(params.get("threshold", 128))
            img = img.convert("L").point(lambda x: 255 if x > thresh else 0).convert("RGB")

        else:
            return response.json({
                "type": "error",
                "message": f"Unknown operation: {operation}",
            }, status=400)

        return response.json({
            "type": "success",
            "image": pil_to_dataurl(img),
            "width": img.width,
            "height": img.height,
        })

    except Exception as e:
        return response.json({
            "type": "error",
            "message": str(e),
            "traceback": traceback.format_exc(),
        }, status=500)


# ── Model Management ──
@app.get("/models/list")
async def list_models(request: Request):
    """List loaded models."""
    return response.json({
        "models": list(_models.keys()),
        "device": _device,
    })


@app.post("/models/load")
async def load_model(request: Request):
    """Pre-load a model for faster inference."""
    data = request.json
    model_name = data.get("model", "yolov8n.pt")

    try:
        from ultralytics import YOLO

        if model_name not in _models:
            _models[model_name] = YOLO(model_name)
            if _device != "cpu":
                _models[model_name].to(_device)

        return response.json({"type": "success", "model": model_name, "device": _device})
    except Exception as e:
        return response.json({"type": "error", "message": str(e)}, status=500)


@app.post("/models/unload")
async def unload_model(request: Request):
    """Unload a model to free memory."""
    data = request.json
    model_name = data.get("model")
    if model_name in _models:
        del _models[model_name]
        if _device == "cuda":
            import torch
            torch.cuda.empty_cache()
    return response.json({"type": "success"})


# ── Fused Pipeline Processing ──
# Process a frame through multiple operations in a single HTTP call.
# Eliminates N-1 round-trips for N-node chains (YOLO → blur → resize = 1 call instead of 3).

def _apply_cv_operation(img, operation, params):
    """Apply a single CV operation on a numpy array (BGR). Returns (result_img, metadata)."""
    import cv2
    metadata = {}

    if operation in ("face_detect", "face_detect_cv"):
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(cascade_path)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        scale = params.get("scale_factor", 1.1)
        neighbors = params.get("min_neighbors", 5)
        faces = cascade.detectMultiScale(gray, scaleFactor=scale, minNeighbors=neighbors)
        result = img.copy()
        face_crops = []
        for (x, y, w, h) in faces:
            cv2.rectangle(result, (x, y), (x + w, y + h), (0, 255, 0), 2)
            crop = img[y:y+h, x:x+w]
            face_crops.append(encode_image(crop))
        metadata["count"] = len(faces)
        metadata["faceImages"] = face_crops
        metadata["images"] = face_crops
        return result, metadata

    if operation == "canny_edge":
        low = params.get("low_threshold", 50)
        high = params.get("high_threshold", 150)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, low, high)
        return cv2.cvtColor(edges, cv2.COLOR_GRAY2BGR), metadata

    if operation == "contour_detect":
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        _, thresh = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(thresh, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
        result = img.copy()
        cv2.drawContours(result, contours, -1, (0, 255, 0), 2)
        metadata["count"] = len(contours)
        return result, metadata

    if operation == "histogram_eq":
        if len(img.shape) == 2:
            return cv2.equalizeHist(img), metadata
        ycrcb = cv2.cvtColor(img, cv2.COLOR_BGR2YCrCb)
        ycrcb[:, :, 0] = cv2.equalizeHist(ycrcb[:, :, 0])
        return cv2.cvtColor(ycrcb, cv2.COLOR_YCrCb2BGR), metadata

    if operation in ("gaussian_blur", "gaussian_blur_cv"):
        ksize = int(params.get("kernel_size", 5))
        if ksize % 2 == 0: ksize += 1
        return cv2.GaussianBlur(img, (ksize, ksize), 0), metadata

    if operation == "bilateral_filter":
        d = int(params.get("d", 9))
        return cv2.bilateralFilter(img, d, params.get("sigma_color", 75), params.get("sigma_space", 75)), metadata

    if operation == "morphology":
        op_type = params.get("type", "dilate")
        ksize = int(params.get("kernel_size", 5))
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (ksize, ksize))
        ops = {"dilate": cv2.MORPH_DILATE, "erode": cv2.MORPH_ERODE, "open": cv2.MORPH_OPEN, "close": cv2.MORPH_CLOSE, "gradient": cv2.MORPH_GRADIENT}
        return cv2.morphologyEx(img, ops.get(op_type, cv2.MORPH_DILATE), kernel), metadata

    if operation == "color_space":
        target = params.get("color_space", "Grayscale")
        conv_map = {"Grayscale": cv2.COLOR_BGR2GRAY, "HSV": cv2.COLOR_BGR2HSV, "LAB": cv2.COLOR_BGR2LAB, "RGB": cv2.COLOR_BGR2RGB}
        conv = conv_map.get(target)
        if conv is not None:
            result = cv2.cvtColor(img, conv)
            if len(result.shape) == 2:
                result = cv2.cvtColor(result, cv2.COLOR_GRAY2BGR)
            return result, metadata
        return img, metadata

    if operation == "adaptive_threshold":
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        bs = int(params.get("block_size", 11))
        if bs % 2 == 0: bs += 1
        result = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, bs, params.get("c", 2))
        return cv2.cvtColor(result, cv2.COLOR_GRAY2BGR), metadata

    if operation == "color_detect":
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        lower = np.array([int(params.get("lower_hue", 0)), int(params.get("lower_saturation", 50)), int(params.get("lower_value", 50))])
        upper = np.array([int(params.get("upper_hue", 180)), int(params.get("upper_saturation", 255)), int(params.get("upper_value", 255))])
        mask = cv2.inRange(hsv, lower, upper)
        metadata["pixel_count"] = int(cv2.countNonZero(mask))
        return cv2.bitwise_and(img, img, mask=mask), metadata

    if operation in ("people_detect", "cascade_detect"):
        cascade_map = {"fullbody": "haarcascade_fullbody.xml", "upperbody": "haarcascade_upperbody.xml", "profileface": "haarcascade_profileface.xml", "frontalface": "haarcascade_frontalface_default.xml", "eye": "haarcascade_eye.xml", "smile": "haarcascade_smile.xml"}
        cascade_file = cascade_map.get(params.get("cascade", "fullbody"), params.get("cascade", "fullbody"))
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + cascade_file)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        dets = cascade.detectMultiScale(gray, scaleFactor=params.get("scale_factor", 1.1), minNeighbors=params.get("min_neighbors", 5))
        result = img.copy()
        for (x, y, w, h) in dets: cv2.rectangle(result, (x, y), (x + w, y + h), (0, 255, 0), 2)
        metadata["count"] = len(dets)
        return result, metadata

    if operation == "resize":
        width = int(params.get("width", img.shape[1]))
        height = int(params.get("height", img.shape[0]))
        interp_map = {"NEAREST": cv2.INTER_NEAREST, "LINEAR": cv2.INTER_LINEAR, "CUBIC": cv2.INTER_CUBIC, "LANCZOS4": cv2.INTER_LANCZOS4}
        return cv2.resize(img, (width, height), interpolation=interp_map.get(params.get("interpolation", "LANCZOS4"), cv2.INTER_LANCZOS4)), metadata

    return img, metadata


def _apply_pil_operation(img_pil, operation, params):
    """Apply a single PIL operation. Returns PIL Image."""
    from PIL import ImageFilter, ImageEnhance, ImageOps

    if operation == "blur":
        return img_pil.filter(ImageFilter.GaussianBlur(radius=params.get("radius", 2)))
    if operation == "sharpen":
        return ImageEnhance.Sharpness(img_pil).enhance(params.get("amount", 1.5))
    if operation == "brightness_contrast":
        img_pil = ImageEnhance.Brightness(img_pil).enhance(params.get("brightness", 1.0))
        return ImageEnhance.Contrast(img_pil).enhance(params.get("contrast", 1.0))
    if operation == "flip":
        direction = params.get("direction", "horizontal")
        return ImageOps.mirror(img_pil) if direction == "horizontal" else ImageOps.flip(img_pil)
    if operation == "rotate":
        return img_pil.rotate(-float(params.get("angle", 0)), expand=True, fillcolor=(0, 0, 0))
    if operation == "crop":
        w, h = img_pil.size
        left = int(params.get("left", 0)); top = int(params.get("top", 0))
        right = int(params.get("right", w)); bottom = int(params.get("bottom", h))
        return img_pil.crop((left, top, right, bottom))
    if operation == "grayscale":
        return ImageOps.grayscale(img_pil).convert("RGB")
    if operation == "invert":
        return ImageOps.invert(img_pil.convert("RGB"))
    if operation == "hue_saturation":
        import cv2
        arr = np.array(img_pil)
        hsv = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV).astype(np.int16)
        hsv[:, :, 0] = (hsv[:, :, 0] + int(params.get("hue", 0))) % 180
        hsv[:, :, 1] = np.clip(hsv[:, :, 1] + int(params.get("saturation", 0)), 0, 255)
        return Image.fromarray(cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2RGB))
    if operation == "denoise":
        import cv2
        arr = cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)
        h = params.get("strength", 10)
        denoised = cv2.fastNlMeansDenoisingColored(arr, None, h, h, 7, 21)
        return Image.fromarray(cv2.cvtColor(denoised, cv2.COLOR_BGR2RGB))
    if operation == "edge_detect":
        return img_pil.filter(ImageFilter.FIND_EDGES)
    if operation == "threshold":
        thresh = int(params.get("threshold", 128))
        return img_pil.convert("L").point(lambda x: 255 if x > thresh else 0).convert("RGB")
    if operation == "opacity":
        alpha = float(params.get("opacity", 1.0))
        img_pil = img_pil.convert("RGBA")
        r, g, b, a = img_pil.split()
        a = a.point(lambda x: int(x * alpha))
        return Image.merge("RGBA", (r, g, b, a)).convert("RGB")
    if operation == "pad":
        pad = int(params.get("padding", 10))
        color = tuple(params.get("color", [0, 0, 0]))
        return ImageOps.expand(img_pil, border=pad, fill=color)
    if operation == "color_balance":
        r_factor = float(params.get("red", 1.0))
        g_factor = float(params.get("green", 1.0))
        b_factor = float(params.get("blue", 1.0))
        r, g, b = img_pil.split()[:3]
        r = r.point(lambda x: min(255, int(x * r_factor)))
        g = g.point(lambda x: min(255, int(x * g_factor)))
        b = b.point(lambda x: min(255, int(x * b_factor)))
        return Image.merge("RGB", (r, g, b))
    if operation == "levels":
        in_low = int(params.get("input_low", 0))
        in_high = int(params.get("input_high", 255))
        out_low = int(params.get("output_low", 0))
        out_high = int(params.get("output_high", 255))
        scale = (out_high - out_low) / max(in_high - in_low, 1)
        return img_pil.point(lambda x: int(max(0, min(255, (x - in_low) * scale + out_low))))

    return img_pil


# CV operations set (for routing in pipeline)
_CV_OPERATIONS = {
    "face_detect", "face_detect_cv", "contour_detect", "canny_edge", "histogram_eq",
    "morphology", "color_space", "adaptive_threshold", "color_detect",
    "gaussian_blur", "gaussian_blur_cv", "bilateral_filter", "people_detect", "cascade_detect", "resize",
}

_PIL_OPERATIONS = {
    "flip", "rotate", "crop", "pad", "brightness_contrast", "hue_saturation", "color_balance",
    "levels", "invert", "grayscale", "opacity", "blur", "sharpen", "denoise", "edge_detect", "threshold",
}


@app.post("/pipeline/process")
async def pipeline_process(request: Request):
    """Process a frame through multiple operations in a SINGLE HTTP call.
    Eliminates N-1 round-trips for an N-node chain.

    Body: {
        "image": "data:image/jpeg;base64,...",
        "steps": [
            {"operation": "yolo_detect", "params": {"model": "yolov8n.pt", "confidence": 0.25}},
            {"operation": "gaussian_blur_cv", "params": {"kernel_size": 5}},
            {"operation": "brightness_contrast", "params": {"brightness": 1.2}}
        ]
    }
    Returns: { "image": "data:...", "metadata": {...per-step metadata...} }
    """
    data = request.json
    image_data = data["image"]
    steps = data.get("steps", [])

    if not steps:
        return response.json({"type": "error", "message": "No processing steps provided"}, status=400)

    try:
        import cv2

        # Start with decoded image (BGR numpy)
        img = decode_image(image_data)
        all_metadata = {}

        for i, step in enumerate(steps):
            operation = step["operation"]
            params = step.get("params", {})

            if operation == "yolo_detect":
                # YOLO detection
                model_name = params.get("model", params.get("model_url", "yolov8n.pt"))
                if model_name and not os.path.isfile(model_name):
                    bn = os.path.basename(model_name)
                    if bn.endswith(".onnx"): bn = bn.replace(".onnx", ".pt")
                    model_name = bn
                if not model_name: model_name = "yolov8n.pt"

                from ultralytics import YOLO
                if model_name not in _models:
                    _models[model_name] = YOLO(model_name)
                    if _device != "cpu": _models[model_name].to(_device)

                # Resolve filter classes to indices
                fc = params.get("filter_classes", [])
                class_indices = None
                if fc:
                    n2i = {v.lower(): k for k, v in _models[model_name].names.items()}
                    class_indices = [n2i[c.lower()] for c in fc if c.lower() in n2i]
                    if not class_indices: class_indices = None

                results = _models[model_name].predict(
                    img, conf=params.get("confidence", 0.25),
                    iou=params.get("iou", 0.45), classes=class_indices,
                    device=_device, verbose=False,
                )
                result = results[0]
                img = result.plot()  # annotated image becomes input for next step

                detections = []
                crops = []
                if result.boxes is not None:
                    for box in result.boxes:
                        x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                        detections.append({
                            "class": int(box.cls[0]),
                            "class_name": _models[model_name].names[int(box.cls[0])],
                            "confidence": float(box.conf[0]),
                            "bbox": [float(x1), float(y1), float(x2 - x1), float(y2 - y1)],
                        })
                        cx1, cy1, cx2, cy2 = map(int, box.xyxy[0].cpu().numpy())
                        crop = decode_image(image_data)[max(0, cy1):cy2, max(0, cx1):cx2]
                        if crop.size > 0: crops.append(encode_image(crop))

                all_metadata[f"step_{i}"] = {"operation": operation, "count": len(detections), "detections": detections}
                all_metadata["count"] = len(detections)
                all_metadata["detections"] = detections
                all_metadata["crops"] = crops
                all_metadata["faceImages"] = crops
                all_metadata["images"] = crops

            elif operation in _CV_OPERATIONS:
                img, meta = _apply_cv_operation(img, operation, params)
                all_metadata[f"step_{i}"] = {"operation": operation, **meta}
                all_metadata.update(meta)

            elif operation in _PIL_OPERATIONS:
                # Convert BGR numpy → PIL → apply → back to BGR numpy
                pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
                pil_img = _apply_pil_operation(pil_img, operation, params)
                img = cv2.cvtColor(np.array(pil_img.convert("RGB")), cv2.COLOR_RGB2BGR)
                all_metadata[f"step_{i}"] = {"operation": operation}

            else:
                # Unknown operation — skip
                all_metadata[f"step_{i}"] = {"operation": operation, "skipped": True}

        return response.json({
            "type": "success",
            "image": encode_image(img),
            "metadata": all_metadata,
        })

    except Exception as e:
        return response.json({
            "type": "error",
            "message": str(e),
            "traceback": traceback.format_exc(),
        }, status=500)


# ── Server-Side Frame Queue ──
# Async queue for high-throughput frame processing.
# Frontend pushes frames, backend processes independently, results via SSE.

_frame_queue = None  # asyncio.Queue (initialized on server start)
_result_queues = {}  # session_id → asyncio.Queue of results
_queue_worker_task = None


@app.before_server_start
async def init_queue(app, loop):
    global _frame_queue, _queue_worker_task
    _frame_queue = asyncio.Queue(maxsize=100)
    _queue_worker_task = asyncio.ensure_future(_queue_worker())


async def _queue_worker():
    """Background worker that processes frames from the queue."""
    while True:
        try:
            item = await _frame_queue.get()
            session_id = item["session_id"]
            frame_id = item["frame_id"]
            image_data = item["image"]
            steps = item["steps"]

            import cv2
            img = decode_image(image_data)
            all_metadata = {}

            for i, step in enumerate(steps):
                operation = step["operation"]
                params = step.get("params", {})

                if operation == "yolo_detect":
                    model_name = params.get("model", params.get("model_url", "yolov8n.pt"))
                    if model_name and not os.path.isfile(model_name):
                        bn = os.path.basename(model_name)
                        if bn.endswith(".onnx"): bn = bn.replace(".onnx", ".pt")
                        model_name = bn
                    if not model_name: model_name = "yolov8n.pt"

                    from ultralytics import YOLO
                    if model_name not in _models:
                        _models[model_name] = YOLO(model_name)
                        if _device != "cpu": _models[model_name].to(_device)

                    results = _models[model_name].predict(
                        img, conf=params.get("confidence", 0.25),
                        iou=params.get("iou", 0.45), device=_device, verbose=False,
                    )
                    result = results[0]
                    img = result.plot()
                    detections = []
                    if result.boxes is not None:
                        for box in result.boxes:
                            x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                            detections.append({
                                "class_name": _models[model_name].names[int(box.cls[0])],
                                "confidence": float(box.conf[0]),
                            })
                    all_metadata["count"] = len(detections)
                    all_metadata["detections"] = detections

                elif operation in _CV_OPERATIONS:
                    img, meta = _apply_cv_operation(img, operation, params)
                    all_metadata.update(meta)

                elif operation in _PIL_OPERATIONS:
                    pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
                    pil_img = _apply_pil_operation(pil_img, operation, params)
                    img = cv2.cvtColor(np.array(pil_img.convert("RGB")), cv2.COLOR_RGB2BGR)

            result_data = {
                "frame_id": frame_id,
                "image": encode_image(img),
                "metadata": all_metadata,
            }

            # Push result to session's result queue
            if session_id in _result_queues:
                try:
                    _result_queues[session_id].put_nowait(result_data)
                except asyncio.QueueFull:
                    pass  # Drop oldest result if consumer is too slow

            _frame_queue.task_done()

        except Exception as e:
            print(f"[Queue Worker] Error: {e}")
            traceback.print_exc()


@app.post("/queue/submit")
async def queue_submit(request: Request):
    """Submit a frame to the processing queue (fire-and-forget, fast).

    Body: {
        "session_id": "abc123",
        "frame_id": 42,
        "image": "data:image/jpeg;base64,...",
        "steps": [{"operation": "yolo_detect", "params": {...}}]
    }
    """
    data = request.json
    session_id = data["session_id"]

    # Ensure result queue exists for this session
    if session_id not in _result_queues:
        _result_queues[session_id] = asyncio.Queue(maxsize=200)

    try:
        _frame_queue.put_nowait(data)
        return response.json({
            "type": "success",
            "queue_size": _frame_queue.qsize(),
        })
    except asyncio.QueueFull:
        return response.json({
            "type": "error",
            "message": "Queue full, try again later",
            "queue_size": _frame_queue.qsize(),
        }, status=429)


@app.get("/queue/results/<session_id>")
async def queue_results_sse(request: Request, session_id: str):
    """SSE endpoint: streams processed frame results back to the client."""
    if session_id not in _result_queues:
        _result_queues[session_id] = asyncio.Queue(maxsize=200)

    result_queue = _result_queues[session_id]

    async def stream(resp):
        try:
            while True:
                try:
                    result = await asyncio.wait_for(result_queue.get(), timeout=30.0)
                    await resp.write(f"data: {json.dumps(result)}\n\n")
                except asyncio.TimeoutError:
                    # Keep-alive ping
                    await resp.write("event: ping\ndata: {}\n\n")
        except asyncio.CancelledError:
            pass
        finally:
            # Clean up session when client disconnects
            _result_queues.pop(session_id, None)

    return response.stream(
        stream,
        content_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@app.post("/queue/clear/<session_id>")
async def queue_clear(request: Request, session_id: str):
    """Clear a session's result queue."""
    if session_id in _result_queues:
        while not _result_queues[session_id].empty():
            try: _result_queues[session_id].get_nowait()
            except asyncio.QueueEmpty: break
    return response.json({"type": "success"})


# ── FFmpeg Video Frame Extraction ──
@app.post("/video/extract-frames")
async def extract_frames(request: Request):
    """Extract frames from a video file using ffmpeg (much faster than browser canvas).

    Body: {
        "video_path": "/path/to/video.mp4",
        "output_dir": "/tmp/frames_xxx",
        "fps": 10,
        "max_frames": 0,
        "resize": "640:480"  (optional)
    }
    Returns: { "type": "success", "frame_count": 150, "output_dir": "..." }
    """
    data = request.json
    video_path = data["video_path"]
    output_dir = data["output_dir"]
    fps = data.get("fps", 10)
    max_frames = data.get("max_frames", 0)
    resize = data.get("resize")

    try:
        import subprocess

        # Check ffmpeg
        try:
            subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            return response.json({"type": "error", "message": "ffmpeg not found"}, status=400)

        os.makedirs(output_dir, exist_ok=True)

        # Build ffmpeg command
        cmd = ["ffmpeg", "-y", "-i", video_path]

        # FPS filter
        vf_parts = [f"fps={fps}"]
        if resize:
            vf_parts.append(f"scale={resize}")
        cmd.extend(["-vf", ",".join(vf_parts)])

        if max_frames > 0:
            cmd.extend(["-frames:v", str(max_frames)])

        cmd.extend(["-q:v", "2", os.path.join(output_dir, "frame_%05d.jpg")])

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)

        if result.returncode != 0:
            return response.json({"type": "error", "message": f"ffmpeg failed: {result.stderr[:500]}"}, status=500)

        # Count extracted frames
        frame_files = sorted([f for f in os.listdir(output_dir) if f.startswith("frame_") and f.endswith(".jpg")])
        frame_count = len(frame_files)

        return response.json({
            "type": "success",
            "frame_count": frame_count,
            "output_dir": output_dir,
            "frames": frame_files[:10],  # First 10 filenames for preview
        })

    except Exception as e:
        return response.json({"type": "error", "message": str(e)}, status=500)


@app.post("/video/read-frame")
async def read_frame(request: Request):
    """Read a single extracted frame from disk and return as data URL."""
    data = request.json
    frame_path = data["path"]

    try:
        with open(frame_path, "rb") as f:
            img_bytes = f.read()
        b64 = base64.b64encode(img_bytes).decode("utf-8")
        return response.json({
            "type": "success",
            "image": f"data:image/jpeg;base64,{b64}",
            "size": len(img_bytes),
        })
    except Exception as e:
        return response.json({"type": "error", "message": str(e)}, status=500)


# ── Frame Save (write captured frame to disk immediately) ──
@app.post("/frames/save")
async def save_frame(request: Request):
    """Save a single frame to disk. Used for streaming capture to avoid holding frames in memory."""
    data = request.json
    image_data = data["image"]
    output_dir = data["output_dir"]
    filename = data["filename"]

    try:
        os.makedirs(output_dir, exist_ok=True)
        filepath = os.path.join(output_dir, filename)

        if image_data.startswith("data:"):
            _, b64 = image_data.split(",", 1)
        else:
            b64 = image_data

        img_bytes = base64.b64decode(b64)
        with open(filepath, "wb") as f:
            f.write(img_bytes)

        return response.json({"type": "success", "path": filepath, "size": len(img_bytes)})
    except Exception as e:
        return response.json({"type": "error", "message": str(e)}, status=500)


# ── Batch Frame Processing ──
# Process a directory of frames through a pipeline (disk → disk).
# No base64 overhead — reads/writes JPEG files directly.
# This is the fastest approach: Python reads files, processes with GPU, writes results.
@app.post("/pipeline/batch")
async def pipeline_batch(request: Request):
    """Process all frames in a directory through a pipeline.

    Body: {
        "input_dir": "/tmp/raw_frames/",
        "output_dir": "/tmp/processed_frames/",
        "steps": [{"operation": "yolo_detect", "params": {...}}],
        "pattern": "frame_*.jpg"
    }
    Returns: {"type": "success", "total_processed": 300, "total": 300}
    """
    data = request.json
    input_dir = data["input_dir"]
    output_dir = data["output_dir"]
    steps = data.get("steps", [])
    pattern = data.get("pattern", "frame_*.jpg")

    import glob as glob_mod
    import cv2

    print(f"[Batch] input_dir={input_dir}, output_dir={output_dir}, pattern={pattern}, steps={len(steps)}")

    os.makedirs(output_dir, exist_ok=True)

    # Find all input frames, sorted
    frame_files = sorted(glob_mod.glob(os.path.join(input_dir, pattern)))
    total = len(frame_files)

    print(f"[Batch] Found {total} frames matching '{pattern}' in {input_dir}")

    if total == 0:
        # List directory contents for debugging
        try:
            dir_contents = os.listdir(input_dir) if os.path.isdir(input_dir) else ["DIR NOT FOUND"]
            print(f"[Batch] No frames found. Dir contents: {dir_contents[:10]}")
        except Exception as e:
            print(f"[Batch] Cannot list dir: {e}")
        return response.json({"type": "error", "message": f"No frames found in {input_dir} matching {pattern}"}, status=400)

    try:
        # Pre-load YOLO model if needed (avoid loading per frame)
        for step in steps:
            if step["operation"] == "yolo_detect":
                model_name = step.get("params", {}).get("model", "yolov8n.pt")
                if model_name and not os.path.isfile(model_name):
                    bn = os.path.basename(model_name)
                    if bn.endswith(".onnx"): bn = bn.replace(".onnx", ".pt")
                    model_name = bn
                if not model_name: model_name = "yolov8n.pt"
                step["params"]["model"] = model_name

                from ultralytics import YOLO
                if model_name not in _models:
                    _models[model_name] = YOLO(model_name)
                    if _device != "cpu": _models[model_name].to(_device)

        processed = 0
        errors = 0

        for frame_path in frame_files:
            try:
                # Read frame from disk directly (no base64 encoding!)
                img = cv2.imread(frame_path)
                if img is None:
                    errors += 1
                    continue

                # Apply each pipeline step
                for step in steps:
                    operation = step["operation"]
                    params = step.get("params", {})

                    if operation == "yolo_detect":
                        model_name = params.get("model", "yolov8n.pt")
                        model = _models[model_name]
                        fc = params.get("filter_classes", [])
                        ci = None
                        if fc:
                            n2i = {v.lower(): k for k, v in model.names.items()}
                            ci = [n2i[c.lower()] for c in fc if c.lower() in n2i] or None
                        results = model.predict(
                            img, conf=params.get("confidence", 0.25),
                            iou=params.get("iou", 0.45), classes=ci,
                            device=_device, verbose=False,
                        )
                        img = results[0].plot()

                    elif operation in _CV_OPERATIONS:
                        img, _ = _apply_cv_operation(img, operation, params)

                    elif operation in _PIL_OPERATIONS:
                        pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
                        pil_img = _apply_pil_operation(pil_img, operation, params)
                        img = cv2.cvtColor(np.array(pil_img.convert("RGB")), cv2.COLOR_RGB2BGR)

                # Write processed frame to output dir (same filename)
                out_path = os.path.join(output_dir, os.path.basename(frame_path))
                cv2.imwrite(out_path, img, [cv2.IMWRITE_JPEG_QUALITY, 92])
                processed += 1

            except Exception:
                errors += 1
                # Copy raw frame on error so video has no gaps
                try:
                    import shutil
                    shutil.copy2(frame_path, os.path.join(output_dir, os.path.basename(frame_path)))
                except Exception:
                    pass

        return response.json({
            "type": "success",
            "total_processed": processed,
            "total": total,
            "errors": errors,
        })

    except Exception as e:
        return response.json({
            "type": "error",
            "message": str(e),
            "traceback": traceback.format_exc(),
        }, status=500)


# ── FFmpeg Video Encoding ──
@app.post("/video/encode")
async def encode_video(request: Request):
    """Encode frames directory to video using ffmpeg (much faster than browser MediaRecorder)."""
    data = request.json
    frames_dir = data["frames_dir"]
    output_path = data["output_path"]
    fps = data.get("fps", 30)
    codec = data.get("codec", "libx264")  # libx264, libx265, libvpx-vp9
    crf = data.get("crf", 23)
    pattern = data.get("pattern", "frame_%04d.jpg")

    try:
        import subprocess

        # Check ffmpeg availability
        try:
            subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            return response.json({
                "type": "error",
                "message": "ffmpeg not found. Install it: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)"
            }, status=400)

        cmd = [
            "ffmpeg", "-y",
            "-framerate", str(fps),
            "-i", os.path.join(frames_dir, pattern),
            "-c:v", codec,
            "-crf", str(crf),
            "-pix_fmt", "yuv420p",
            output_path,
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

        if result.returncode != 0:
            return response.json({
                "type": "error",
                "message": f"ffmpeg failed: {result.stderr[:500]}"
            }, status=500)

        file_size = os.path.getsize(output_path)
        return response.json({
            "type": "success",
            "path": output_path,
            "size": file_size,
            "codec": codec,
        })
    except Exception as e:
        return response.json({"type": "error", "message": str(e)}, status=500)


# ── Shutdown ──
@app.post("/shutdown")
async def shutdown(request: Request):
    """Gracefully shut down the server."""
    # Unload all models
    _models.clear()
    if _device == "cuda":
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
        single_process=not dev_mode,  # single_process incompatible with auto_reload
        access_log=dev_mode,
        auto_reload=dev_mode,
        debug=dev_mode,
    )
