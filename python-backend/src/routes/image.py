"""PIL-based image processing routes."""

import io
import base64
import traceback

import numpy as np
from PIL import Image, ImageFilter, ImageEnhance, ImageOps, ImageDraw, ImageFont
from sanic import Blueprint, response
from sanic.request import Request

from src.utils import pil_to_dataurl, decode_to_pil

bp = Blueprint("image", url_prefix="/image")


def apply_pil_operation(img_pil, operation, params):
    """Apply a single PIL operation. Returns PIL Image."""
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
    if operation == "resize":
        width = int(params.get("width", img_pil.width))
        height = int(params.get("height", img_pil.height))
        return img_pil.resize((width, height), Image.LANCZOS)

    return img_pil


PIL_OPERATIONS = {
    "flip", "rotate", "crop", "pad", "brightness_contrast", "hue_saturation", "color_balance",
    "levels", "invert", "grayscale", "opacity", "blur", "sharpen", "denoise", "edge_detect", "threshold",
    "resize",
}


@bp.post("/process")
async def image_process(request: Request):
    """Basic image processing operations using Pillow."""
    data = request.json
    image_data = data["image"]
    operation = data["operation"]
    params = data.get("params", {})

    try:
        img = decode_to_pil(image_data)
        img = apply_pil_operation(img, operation, params)

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
