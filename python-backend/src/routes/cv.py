"""OpenCV processing routes."""

import traceback

import numpy as np
from sanic import Blueprint, response
from sanic.request import Request

from src import state
from src.utils import decode_image, encode_image

bp = Blueprint("cv", url_prefix="/cv")


def apply_cv_operation(img, operation, params):
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

    # ── New operations ──

    if operation == "pixelate":
        factor = max(1, int(params.get("factor", 10)))
        h, w = img.shape[:2]
        small = cv2.resize(img, (max(1, w // factor), max(1, h // factor)), interpolation=cv2.INTER_NEAREST)
        return cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST), metadata

    if operation == "high_pass":
        ksize = int(params.get("kernel_size", 21))
        if ksize % 2 == 0: ksize += 1
        blur = cv2.GaussianBlur(img, (ksize, ksize), 0)
        # high_pass = original - blur + 128
        hp = cv2.addWeighted(img, 1.0, blur, -1.0, 128)
        return hp, metadata

    if operation == "add_noise":
        noise_type = params.get("noise_type", "gaussian")
        amount = float(params.get("amount", 25))
        if noise_type == "gaussian":
            noise = np.random.normal(0, amount, img.shape).astype(np.int16)
            result = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)
        elif noise_type == "salt_pepper":
            result = img.copy()
            prob = amount / 255.0
            salt = np.random.random(img.shape[:2]) < prob / 2
            pepper = np.random.random(img.shape[:2]) < prob / 2
            result[salt] = 255
            result[pepper] = 0
        else:
            result = img
        return result, metadata

    if operation == "surface_blur":
        sigma_s = float(params.get("sigma_s", 60))
        sigma_r = float(params.get("sigma_r", 0.4))
        return cv2.edgePreservingFilter(img, flags=1, sigma_s=sigma_s, sigma_r=sigma_r), metadata

    if operation == "split_channels":
        channel = params.get("channel", "red")
        b, g, r = cv2.split(img)
        ch_map = {"red": r, "green": g, "blue": b}
        ch = ch_map.get(channel, r)
        result = cv2.cvtColor(ch, cv2.COLOR_GRAY2BGR)
        return result, metadata

    if operation == "merge_channels":
        # This operates on a single image — splits to show all channels merged custom
        r_boost = float(params.get("red", 1.0))
        g_boost = float(params.get("green", 1.0))
        b_boost = float(params.get("blue", 1.0))
        b, g, r = cv2.split(img)
        r = np.clip(r.astype(np.float32) * r_boost, 0, 255).astype(np.uint8)
        g = np.clip(g.astype(np.float32) * g_boost, 0, 255).astype(np.uint8)
        b = np.clip(b.astype(np.float32) * b_boost, 0, 255).astype(np.uint8)
        return cv2.merge([b, g, r]), metadata

    if operation == "chroma_key":
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        # Default: green screen removal
        hue_center = int(params.get("hue_center", 60))  # green
        hue_range = int(params.get("hue_range", 30))
        lower = np.array([max(0, hue_center - hue_range), 40, 40])
        upper = np.array([min(180, hue_center + hue_range), 255, 255])
        mask = cv2.inRange(hsv, lower, upper)
        mask_inv = cv2.bitwise_not(mask)
        # Replace keyed pixels with transparency (output as white background)
        bg_color = params.get("bg_color", [255, 255, 255])
        bg = np.full_like(img, bg_color, dtype=np.uint8)
        fg = cv2.bitwise_and(img, img, mask=mask_inv)
        bg_part = cv2.bitwise_and(bg, bg, mask=mask)
        result = cv2.add(fg, bg_part)
        metadata["masked_pixels"] = int(cv2.countNonZero(mask))
        return result, metadata

    if operation == "composite":
        # Blend two images (second passed as base64 in params)
        blend_mode = params.get("mode", "normal")
        opacity = float(params.get("opacity", 0.5))
        overlay_data = params.get("overlay_image")
        if overlay_data:
            overlay = decode_image(overlay_data)
            overlay = cv2.resize(overlay, (img.shape[1], img.shape[0]))
        else:
            overlay = np.full_like(img, 128)

        if blend_mode == "normal":
            result = cv2.addWeighted(img, 1 - opacity, overlay, opacity, 0)
        elif blend_mode == "multiply":
            blended = (img.astype(np.float32) / 255 * overlay.astype(np.float32) / 255 * 255).astype(np.uint8)
            result = cv2.addWeighted(img, 1 - opacity, blended, opacity, 0)
        elif blend_mode == "screen":
            blended = (255 - ((255 - img).astype(np.float32) / 255 * (255 - overlay).astype(np.float32) / 255 * 255)).astype(np.uint8)
            result = cv2.addWeighted(img, 1 - opacity, blended, opacity, 0)
        elif blend_mode == "overlay":
            low = (2 * img.astype(np.float32) * overlay.astype(np.float32) / 255 / 255 * 255).astype(np.uint8)
            high = (255 - 2 * (255 - img).astype(np.float32) * (255 - overlay).astype(np.float32) / 255 / 255 * 255).astype(np.uint8)
            mask_arr = img < 128
            blended = np.where(mask_arr, low, high)
            result = cv2.addWeighted(img, 1 - opacity, blended, opacity, 0)
        else:
            result = cv2.addWeighted(img, 1 - opacity, overlay, opacity, 0)
        return result, metadata

    if operation == "stack_images":
        direction = params.get("direction", "horizontal")
        second_data = params.get("second_image")
        if second_data:
            img2 = decode_image(second_data)
            if direction == "horizontal":
                h = max(img.shape[0], img2.shape[0])
                img_r = cv2.resize(img, (int(img.shape[1] * h / img.shape[0]), h))
                img2_r = cv2.resize(img2, (int(img2.shape[1] * h / img2.shape[0]), h))
                result = np.hstack([img_r, img2_r])
            else:
                w = max(img.shape[1], img2.shape[1])
                img_r = cv2.resize(img, (w, int(img.shape[0] * w / img.shape[1])))
                img2_r = cv2.resize(img2, (w, int(img2.shape[0] * w / img2.shape[1])))
                result = np.vstack([img_r, img2_r])
            return result, metadata
        return img, metadata

    if operation == "add_caption":
        text = params.get("text", "Caption")
        position = params.get("position", "bottom")
        font_scale = float(params.get("font_scale", 1.0))
        color = params.get("text_color", [255, 255, 255])
        bg_color_val = params.get("bg_color", [0, 0, 0])
        thickness = int(params.get("thickness", 2))

        h, w = img.shape[:2]
        # Create caption bar
        bar_h = int(40 * font_scale)
        bar = np.full((bar_h, w, 3), bg_color_val, dtype=np.uint8)

        font = cv2.FONT_HERSHEY_SIMPLEX
        text_size = cv2.getTextSize(text, font, font_scale * 0.6, thickness)[0]
        tx = (w - text_size[0]) // 2
        ty = (bar_h + text_size[1]) // 2
        cv2.putText(bar, text, (tx, ty), font, font_scale * 0.6, color, thickness)

        if position == "top":
            result = np.vstack([bar, img])
        else:
            result = np.vstack([img, bar])
        return result, metadata

    if operation == "bg_remove":
        try:
            from rembg import remove as rembg_remove, new_session as rembg_new_session
        except ImportError:
            raise RuntimeError("rembg not installed. Run: pip install rembg")

        from PIL import Image as PILImage

        model_str = params.get("model", "BiRefNet (best)")
        alpha_matting = bool(params.get("alpha_matting", False))

        # Map display name to rembg session name
        model_map = {
            "BiRefNet (best)": "birefnet-general",
            "BiRefNet Lite": "birefnet-general-lite",
            "BiRefNet Portrait": "birefnet-portrait",
            "u2net": "u2net",
            "isnet": "isnet-general-use",
            "silueta (fast)": "silueta",
            "bria-rmbg": "bria-rmbg",
            # Legacy names
            "rembg (u2net)": "u2net",
            "rembg (isnet)": "isnet-general-use",
            "SAM": "sam",
        }
        rembg_model = model_map.get(model_str, "birefnet-general")

        # Cache sessions to avoid re-downloading models
        if rembg_model not in _sam_cache:
            _sam_cache[rembg_model] = rembg_new_session(rembg_model)
        session = _sam_cache[rembg_model]

        # Convert BGR numpy → PIL RGBA
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        pil_in = PILImage.fromarray(rgb)
        pil_out = rembg_remove(
            pil_in,
            session=session,
            alpha_matting=alpha_matting,
            alpha_matting_foreground_threshold=240,
            alpha_matting_background_threshold=10,
        )

        # Convert back: RGBA result → BGR for annotated output
        out_arr = np.array(pil_out.convert("RGBA"))
        # Create white-background composite for preview
        alpha = out_arr[:, :, 3:4].astype(np.float32) / 255
        rgb_out = out_arr[:, :, :3].astype(np.float32)
        white_bg = np.full_like(rgb_out, 255, dtype=np.float32)
        composited = (rgb_out * alpha + white_bg * (1 - alpha)).astype(np.uint8)
        result = cv2.cvtColor(composited, cv2.COLOR_RGB2BGR)

        # Also produce the mask as metadata
        mask = out_arr[:, :, 3]
        mask_bgr = cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)
        metadata["mask"] = encode_image(mask_bgr)

        return result, metadata

    if operation in ("upscale_image", "upscale_2x", "upscale_4x"):
        # AI upscaling using Real-ESRGAN via PyTorch
        scale = 2
        if operation == "upscale_4x":
            scale = 4
        elif operation == "upscale_image":
            scale = int(params.get("scale", 2))

        try:
            # Try Real-ESRGAN first
            from basicsr.archs.rrdbnet_arch import RRDBNet
            from realesrgan import RealESRGANer

            model_name = f"RealESRGAN_x{scale}plus"
            if model_name not in _upscale_models:
                if scale == 4:
                    model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
                    model_path = f"https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"
                else:
                    model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=2)
                    model_path = f"https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth"

                _upscale_models[model_name] = RealESRGANer(
                    scale=scale, model_path=model_path, model=model,
                    tile=0, tile_pad=10, pre_pad=0, half=False,
                )

            upsampler = _upscale_models[model_name]
            output, _ = upsampler.enhance(img, outscale=scale)
            metadata["scale"] = scale
            metadata["width"] = output.shape[1]
            metadata["height"] = output.shape[0]
            return output, metadata

        except ImportError:
            # Fallback: simple OpenCV resize with LANCZOS
            h, w = img.shape[:2]
            output = cv2.resize(img, (w * scale, h * scale), interpolation=cv2.INTER_LANCZOS4)
            metadata["scale"] = scale
            metadata["fallback"] = "opencv_lanczos"
            metadata["width"] = output.shape[1]
            metadata["height"] = output.shape[0]
            return output, metadata

    if operation == "face_upscale":
        try:
            from gfpgan import GFPGANer

            if "gfpgan" not in _upscale_models:
                _upscale_models["gfpgan"] = GFPGANer(
                    model_path="https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.3.pth",
                    upscale=2, arch="clean", channel_multiplier=2,
                )
            restorer = _upscale_models["gfpgan"]
            _, _, output = restorer.enhance(img, has_aligned=False, only_center_face=False, paste_back=True)
            return output, metadata

        except ImportError:
            # Fallback: simple 2x upscale
            h, w = img.shape[:2]
            output = cv2.resize(img, (w * 2, h * 2), interpolation=cv2.INTER_LANCZOS4)
            metadata["fallback"] = "opencv_lanczos"
            return output, metadata

    if operation == "style_transfer":
        style = params.get("style", "starry_night")
        try:
            # Use OpenCV DNN style transfer models
            model_map = {
                "starry_night": "starry_night.t7",
                "the_scream": "the_scream.t7",
                "mosaic": "mosaic.t7",
                "candy": "candy.t7",
                "udnie": "udnie.t7",
                "feathers": "feathers.t7",
            }
            model_file = model_map.get(style, "starry_night.t7")

            # Check if model exists locally
            import os
            model_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models")
            model_path = os.path.join(model_dir, model_file)

            if os.path.isfile(model_path):
                net = cv2.dnn.readNetFromTorch(model_path)
                h, w = img.shape[:2]
                blob = cv2.dnn.blobFromImage(img, 1.0, (w, h), (103.939, 116.779, 123.680), swapRB=False, crop=False)
                net.setInput(blob)
                output = net.forward()
                output = output.reshape(3, output.shape[2], output.shape[3])
                output[0] += 103.939
                output[1] += 116.779
                output[2] += 123.680
                output = output.transpose(1, 2, 0)
                output = np.clip(output, 0, 255).astype(np.uint8)
                return output, metadata
            else:
                # Fallback: apply artistic color effect
                strength = float(params.get("strength", 1.0))
                stylized = cv2.stylization(img, sigma_s=60, sigma_r=0.5 * strength)
                metadata["fallback"] = "opencv_stylization"
                return stylized, metadata

        except Exception:
            stylized = cv2.stylization(img, sigma_s=60, sigma_r=0.5)
            metadata["fallback"] = "opencv_stylization"
            return stylized, metadata

    if operation == "colorize":
        # Convert to grayscale then use OpenCV DNN colorization
        try:
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            # Simple technique: convert grayscale to pseudo-color
            method = params.get("method", "auto")
            if method == "auto":
                # Use CLAHE + colormap for quick colorization effect
                clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
                enhanced = clahe.apply(gray)
                colored = cv2.applyColorMap(enhanced, cv2.COLORMAP_INFERNO)
                # Blend with original for more natural look
                blend = float(params.get("blend", 0.7))
                result = cv2.addWeighted(img, 1 - blend, colored, blend, 0)
            else:
                result = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
            return result, metadata
        except Exception:
            return img, metadata

    if operation == "depth_map":
        # Depth estimation using MiDaS or fallback to Laplacian-based depth
        try:
            import torch
            model_type = params.get("model", "MiDaS_small")
            midas = torch.hub.load("intel-isl/MiDaS", model_type)
            midas.eval()
            if state.device != "cpu":
                midas.to(state.device)

            midas_transforms = torch.hub.load("intel-isl/MiDaS", "transforms")
            transform = midas_transforms.small_transform if "small" in model_type.lower() else midas_transforms.dpt_transform

            input_batch = transform(img)
            if state.device != "cpu":
                input_batch = input_batch.to(state.device)

            with torch.no_grad():
                prediction = midas(input_batch)
                prediction = torch.nn.functional.interpolate(
                    prediction.unsqueeze(1), size=img.shape[:2],
                    mode="bicubic", align_corners=False,
                ).squeeze()

            depth = prediction.cpu().numpy()
            depth = (depth - depth.min()) / (depth.max() - depth.min() + 1e-8) * 255
            depth = depth.astype(np.uint8)
            depth_colored = cv2.applyColorMap(depth, cv2.COLORMAP_INFERNO)
            return depth_colored, metadata

        except Exception:
            # Fallback: Laplacian-based pseudo depth
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            blur = cv2.GaussianBlur(gray, (0, 0), sigmaX=3)
            laplacian = cv2.Laplacian(blur, cv2.CV_64F)
            depth = np.abs(laplacian)
            depth = (depth / (depth.max() + 1e-8) * 255).astype(np.uint8)
            depth_colored = cv2.applyColorMap(255 - depth, cv2.COLORMAP_INFERNO)
            metadata["fallback"] = "laplacian_pseudo_depth"
            return depth_colored, metadata

    if operation == "inpaint":
        # OpenCV inpainting (Navier-Stokes or Telea)
        method = params.get("method", "telea")
        radius = int(params.get("radius", 3))
        mask_data = params.get("mask")

        if mask_data:
            mask_img = decode_image(mask_data)
            mask_gray = cv2.cvtColor(mask_img, cv2.COLOR_BGR2GRAY)
        else:
            # Auto-mask: detect and fill black/white regions
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            _, mask_gray = cv2.threshold(gray, 10, 255, cv2.THRESH_BINARY_INV)

        inpaint_method = cv2.INPAINT_TELEA if method == "telea" else cv2.INPAINT_NS
        result = cv2.inpaint(img, mask_gray, radius, inpaint_method)
        return result, metadata

    if operation == "video_frame":
        # Extract a specific frame from a video file
        video_path = params.get("file", params.get("video_path", ""))
        frame_num = int(params.get("frame", 0))

        if not video_path:
            return img, metadata

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise ValueError(f"Cannot open video: {video_path}")

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_num = min(frame_num, total_frames - 1)
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_num)
        ret, frame = cap.read()
        cap.release()

        if not ret or frame is None:
            return img, metadata

        metadata["total_frames"] = total_frames
        metadata["fps"] = fps
        metadata["frame"] = frame_num
        return frame, metadata

    if operation == "segment_select":
        import os
        import urllib.request
        from pathlib import Path

        points = params.get("points", [])
        point_labels = params.get("point_labels", [])
        box = params.get("box", None)  # [x1, y1, x2, y2] bounding box
        multimask = bool(params.get("multimask", False))

        if (not points or not point_labels) and not box:
            # No prompts yet — pass through the image
            return img, metadata
        if points and point_labels and len(points) != len(point_labels):
            raise ValueError("points and point_labels must have the same length")

        # Ensure MobileSAM predictor is cached
        if "mobile_sam" not in _sam_cache:
            from mobile_sam import sam_model_registry, SamPredictor

            ckpt_dir = Path.home() / ".mobile_sam"
            ckpt_dir.mkdir(parents=True, exist_ok=True)
            ckpt_path = ckpt_dir / "mobile_sam.pt"

            if not ckpt_path.exists():
                url = "https://github.com/ChaoningZhang/MobileSAM/raw/master/weights/mobile_sam.pt"
                urllib.request.urlretrieve(url, str(ckpt_path))

            sam = sam_model_registry["vit_t"](checkpoint=str(ckpt_path))
            sam.eval()
            _sam_cache["mobile_sam"] = SamPredictor(sam)

        predictor = _sam_cache["mobile_sam"]

        # Convert BGR → RGB for SAM
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        predictor.set_image(rgb)

        input_point = np.array(points, dtype=np.float32) if points else None
        input_label = np.array(point_labels, dtype=np.int32) if point_labels else None
        input_box = np.array(box, dtype=np.float32) if box else None

        masks, scores, _ = predictor.predict(
            point_coords=input_point,
            point_labels=input_label,
            box=input_box,
            multimask_output=multimask,
        )

        # Pick best mask
        best_idx = int(np.argmax(scores))
        mask = masks[best_idx]  # bool H×W

        # Build BGRA result: foreground kept, background transparent
        h, w = img.shape[:2]
        alpha = (mask.astype(np.uint8) * 255)
        bgra = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
        bgra[:, :, 3] = alpha

        # For the returned image, composite on white background (BGR)
        alpha_f = alpha.astype(np.float32) / 255.0
        alpha_3 = np.stack([alpha_f] * 3, axis=-1)
        white_bg = np.full_like(img, 255, dtype=np.float32)
        composited = (img.astype(np.float32) * alpha_3 + white_bg * (1 - alpha_3)).astype(np.uint8)

        # Encode mask as metadata
        mask_bgr = cv2.cvtColor(alpha, cv2.COLOR_GRAY2BGR)
        metadata["mask"] = encode_image(mask_bgr)
        metadata["score"] = float(scores[best_idx])
        metadata["num_points"] = len(points)

        return composited, metadata

    return img, metadata


# Cached upscale models
_upscale_models = {}

# Cached SAM predictors
_sam_cache = {}

# Operation set for routing
CV_OPERATIONS = {
    "face_detect", "face_detect_cv", "contour_detect", "canny_edge", "histogram_eq",
    "morphology", "color_space", "adaptive_threshold", "color_detect",
    "gaussian_blur", "gaussian_blur_cv", "bilateral_filter", "people_detect", "cascade_detect", "resize",
    # New operations
    "pixelate", "high_pass", "add_noise", "surface_blur",
    "split_channels", "merge_channels", "chroma_key",
    "composite", "stack_images", "add_caption",
    "bg_remove",
    # AI operations (with fallbacks)
    "upscale_image", "upscale_2x", "upscale_4x", "face_upscale",
    "style_transfer", "colorize", "depth_map", "inpaint",
    "video_frame",
    "segment_select",
}


@bp.post("/process")
async def cv_process(request: Request):
    """Run OpenCV operations on an image."""
    data = request.json
    image_data = data["image"]
    operation = data["operation"]
    params = data.get("params", {})

    try:
        img = decode_image(image_data)
        result_img, metadata = apply_cv_operation(img, operation, params)

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
