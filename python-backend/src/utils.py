"""Shared image encoding/decoding utilities."""

import base64
import io

import numpy as np
from PIL import Image


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


def decode_to_pil(data_url: str) -> Image.Image:
    """Decode a data URL to a PIL Image."""
    if data_url.startswith("data:"):
        _, b64 = data_url.split(",", 1)
    else:
        b64 = data_url
    return Image.open(io.BytesIO(base64.b64decode(b64)))
