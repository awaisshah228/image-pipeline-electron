"""Async frame queue + SSE result streaming routes."""

import asyncio
import json
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

bp = Blueprint("queue", url_prefix="/queue")

# Module-level queue state
frame_queue = None
result_queues = {}
queue_worker_task = None


async def init(app, loop):
    """Initialize queue on server start."""
    global frame_queue, queue_worker_task
    frame_queue = asyncio.Queue(maxsize=100)
    queue_worker_task = asyncio.ensure_future(_queue_worker())


async def _queue_worker():
    """Background worker that processes frames from the queue."""
    while True:
        try:
            item = await frame_queue.get()
            session_id = item["session_id"]
            frame_id = item["frame_id"]
            image_data = item["image"]
            steps = item["steps"]

            img = decode_image(image_data)
            all_metadata = {}

            for i, step in enumerate(steps):
                operation = step["operation"]
                params = step.get("params", {})

                if operation == "yolo_detect":
                    import os
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

                    results = state.models[model_name].predict(
                        img, conf=params.get("confidence", 0.25),
                        iou=params.get("iou", 0.45), device=state.device, verbose=False,
                    )
                    result = results[0]
                    img = result.plot()
                    detections = []
                    if result.boxes is not None:
                        for box in result.boxes:
                            detections.append({
                                "class_name": state.models[model_name].names[int(box.cls[0])],
                                "confidence": float(box.conf[0]),
                            })
                    all_metadata["count"] = len(detections)
                    all_metadata["detections"] = detections

                elif operation in CV_OPERATIONS:
                    img, meta = apply_cv_operation(img, operation, params)
                    all_metadata.update(meta)

                elif operation in PIL_OPERATIONS:
                    pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
                    pil_img = apply_pil_operation(pil_img, operation, params)
                    img = cv2.cvtColor(np.array(pil_img.convert("RGB")), cv2.COLOR_RGB2BGR)

            result_data = {
                "frame_id": frame_id,
                "image": encode_image(img),
                "metadata": all_metadata,
            }

            if session_id in result_queues:
                try:
                    result_queues[session_id].put_nowait(result_data)
                except asyncio.QueueFull:
                    pass

            frame_queue.task_done()

        except Exception as e:
            print(f"[Queue Worker] Error: {e}")
            traceback.print_exc()


@bp.post("/submit")
async def queue_submit(request: Request):
    """Submit a frame to the processing queue (fire-and-forget)."""
    data = request.json
    session_id = data["session_id"]

    if session_id not in result_queues:
        result_queues[session_id] = asyncio.Queue(maxsize=200)

    try:
        frame_queue.put_nowait(data)
        return response.json({
            "type": "success",
            "queue_size": frame_queue.qsize(),
        })
    except asyncio.QueueFull:
        return response.json({
            "type": "error",
            "message": "Queue full, try again later",
            "queue_size": frame_queue.qsize(),
        }, status=429)


@bp.get("/results/<session_id>")
async def queue_results_sse(request: Request, session_id: str):
    """SSE endpoint: streams processed frame results."""
    if session_id not in result_queues:
        result_queues[session_id] = asyncio.Queue(maxsize=200)

    rq = result_queues[session_id]

    async def stream(resp):
        try:
            while True:
                try:
                    result = await asyncio.wait_for(rq.get(), timeout=30.0)
                    await resp.write(f"data: {json.dumps(result)}\n\n")
                except asyncio.TimeoutError:
                    await resp.write("event: ping\ndata: {}\n\n")
        except asyncio.CancelledError:
            pass
        finally:
            result_queues.pop(session_id, None)

    return response.stream(
        stream,
        content_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@bp.post("/clear/<session_id>")
async def queue_clear(request: Request, session_id: str):
    """Clear a session's result queue."""
    if session_id in result_queues:
        while not result_queues[session_id].empty():
            try: result_queues[session_id].get_nowait()
            except asyncio.QueueEmpty: break
    return response.json({"type": "success"})
