"""Frame save/capture routes."""

import os
import base64

from sanic import Blueprint, response
from sanic.request import Request

bp = Blueprint("frames", url_prefix="/frames")


@bp.post("/save")
async def save_frame(request: Request):
    """Save a single frame to disk (streaming capture)."""
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
