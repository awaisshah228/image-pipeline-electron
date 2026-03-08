"""Fused pipeline and batch processing routes."""

import os
import traceback

import numpy as np
import cv2
from PIL import Image
from sanic import Blueprint, response
from sanic.request import Request

from src import state
from src.utils import decode_image, encode_image
from src.routes.cv import apply_cv_operation, CV_OPERATIONS
from src.routes.image import apply_pil_operation, PIL_OPERATIONS

bp = Blueprint("pipeline", url_prefix="/pipeline")


def apply_pipeline_steps(img, steps, image_data=None):
    """Apply a list of pipeline steps to a BGR numpy image.
    Returns (result_img, all_metadata).
    """
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
            if model_name not in state.models:
                state.models[model_name] = YOLO(model_name)
                if state.device != "cpu": state.models[model_name].to(state.device)

            fc = params.get("filter_classes", [])
            class_indices = None
            if fc:
                n2i = {v.lower(): k for k, v in state.models[model_name].names.items()}
                class_indices = [n2i[c.lower()] for c in fc if c.lower() in n2i]
                if not class_indices: class_indices = None

            # Keep original for crops
            original_img = img.copy()

            results = state.models[model_name].predict(
                img, conf=params.get("confidence", 0.25),
                iou=params.get("iou", 0.45), classes=class_indices,
                device=state.device, verbose=False,
            )
            result = results[0]
            img = result.plot()

            detections = []
            crops = []
            if result.boxes is not None:
                for box in result.boxes:
                    x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                    detections.append({
                        "class": int(box.cls[0]),
                        "class_name": state.models[model_name].names[int(box.cls[0])],
                        "confidence": float(box.conf[0]),
                        "bbox": [float(x1), float(y1), float(x2 - x1), float(y2 - y1)],
                    })
                    cx1, cy1, cx2, cy2 = map(int, box.xyxy[0].cpu().numpy())
                    crop = original_img[max(0, cy1):cy2, max(0, cx1):cx2]
                    if crop.size > 0: crops.append(encode_image(crop))

            all_metadata[f"step_{i}"] = {"operation": operation, "count": len(detections), "detections": detections}
            all_metadata["count"] = len(detections)
            all_metadata["detections"] = detections
            all_metadata["crops"] = crops
            all_metadata["faceImages"] = crops
            all_metadata["images"] = crops

        elif operation in CV_OPERATIONS:
            img, meta = apply_cv_operation(img, operation, params)
            all_metadata[f"step_{i}"] = {"operation": operation, **meta}
            all_metadata.update(meta)

        elif operation in PIL_OPERATIONS:
            pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
            pil_img = apply_pil_operation(pil_img, operation, params)
            img = cv2.cvtColor(np.array(pil_img.convert("RGB")), cv2.COLOR_RGB2BGR)
            all_metadata[f"step_{i}"] = {"operation": operation}

        else:
            all_metadata[f"step_{i}"] = {"operation": operation, "skipped": True}

    return img, all_metadata


@bp.post("/process")
async def pipeline_process(request: Request):
    """Process a frame through multiple operations in a SINGLE HTTP call."""
    data = request.json
    image_data = data["image"]
    steps = data.get("steps", [])

    if not steps:
        return response.json({"type": "error", "message": "No processing steps provided"}, status=400)

    try:
        img = decode_image(image_data)
        img, all_metadata = apply_pipeline_steps(img, steps, image_data)

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


@bp.post("/batch")
async def pipeline_batch(request: Request):
    """Process all frames in a directory through a pipeline (disk -> disk)."""
    data = request.json
    input_dir = data["input_dir"]
    output_dir = data["output_dir"]
    steps = data.get("steps", [])
    pattern = data.get("pattern", "frame_*.jpg")

    import glob as glob_mod

    print(f"[Batch] input_dir={input_dir}, output_dir={output_dir}, pattern={pattern}, steps={len(steps)}")

    os.makedirs(output_dir, exist_ok=True)

    frame_files = sorted(glob_mod.glob(os.path.join(input_dir, pattern)))
    total = len(frame_files)

    print(f"[Batch] Found {total} frames matching '{pattern}' in {input_dir}")

    if total == 0:
        try:
            dir_contents = os.listdir(input_dir) if os.path.isdir(input_dir) else ["DIR NOT FOUND"]
            print(f"[Batch] No frames found. Dir contents: {dir_contents[:10]}")
        except Exception as e:
            print(f"[Batch] Cannot list dir: {e}")
        return response.json({"type": "error", "message": f"No frames found in {input_dir} matching {pattern}"}, status=400)

    try:
        # Pre-load YOLO models
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
                if model_name not in state.models:
                    state.models[model_name] = YOLO(model_name)
                    if state.device != "cpu": state.models[model_name].to(state.device)

        processed = 0
        errors = 0

        for frame_path in frame_files:
            try:
                img = cv2.imread(frame_path)
                if img is None:
                    errors += 1
                    continue

                for step in steps:
                    operation = step["operation"]
                    params = step.get("params", {})

                    if operation == "yolo_detect":
                        model_name = params.get("model", "yolov8n.pt")
                        model = state.models[model_name]
                        fc = params.get("filter_classes", [])
                        ci = None
                        if fc:
                            n2i = {v.lower(): k for k, v in model.names.items()}
                            ci = [n2i[c.lower()] for c in fc if c.lower() in n2i] or None
                        results = model.predict(
                            img, conf=params.get("confidence", 0.25),
                            iou=params.get("iou", 0.45), classes=ci,
                            device=state.device, verbose=False,
                        )
                        img = results[0].plot()

                    elif operation in CV_OPERATIONS:
                        img, _ = apply_cv_operation(img, operation, params)

                    elif operation in PIL_OPERATIONS:
                        pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
                        pil_img = apply_pil_operation(pil_img, operation, params)
                        img = cv2.cvtColor(np.array(pil_img.convert("RGB")), cv2.COLOR_RGB2BGR)

                out_path = os.path.join(output_dir, os.path.basename(frame_path))
                cv2.imwrite(out_path, img, [cv2.IMWRITE_JPEG_QUALITY, 92])
                processed += 1

            except Exception:
                errors += 1
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
