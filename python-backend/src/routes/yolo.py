"""YOLO object detection routes."""

import os
import traceback

from sanic import Blueprint, response
from sanic.request import Request

from src import state
from src.utils import decode_image, encode_image

bp = Blueprint("yolo", url_prefix="/yolo")


@bp.post("/detect")
async def yolo_detect(request: Request):
    """Run YOLO object detection on an image."""
    data = request.json
    image_data = data["image"]
    model_name = data.get("model", "yolov8n.pt")
    confidence = data.get("confidence", 0.25)
    iou = data.get("iou", 0.45)
    filter_classes = data.get("filter_classes", [])

    # Normalize model name — strip paths, only convert known Ultralytics base
    # models from .onnx → .pt (e.g. yolov8n.onnx → yolov8n.pt). Custom models
    # like helmet_detector.onnx keep their original extension.
    import re
    if model_name and not os.path.isfile(model_name):
        basename = os.path.basename(model_name)
        if basename.endswith(".onnx") and re.match(
            r"^yolo(v?\d+[nslmx]?)\.onnx$", basename, re.IGNORECASE
        ):
            basename = basename.replace(".onnx", ".pt")
        model_name = basename
    if not model_name:
        model_name = "yolov8n.pt"

    try:
        from ultralytics import YOLO

        if model_name not in state.models:
            state.models[model_name] = YOLO(model_name)
            if state.device != "cpu":
                state.models[model_name].to(state.device)

        model = state.models[model_name]

        # Resolve filter class names to class indices
        class_indices = None
        if filter_classes:
            name_to_idx = {v.lower(): k for k, v in model.names.items()}
            class_indices = [name_to_idx[c.lower()] for c in filter_classes if c.lower() in name_to_idx]
            if not class_indices:
                class_indices = None

        img = decode_image(image_data)

        results = model.predict(
            img,
            conf=confidence,
            iou=iou,
            classes=class_indices,
            device=state.device,
            verbose=False,
        )

        result = results[0]
        annotated = result.plot()
        annotated_url = encode_image(annotated)

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
