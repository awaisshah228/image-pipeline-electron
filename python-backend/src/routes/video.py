"""Video frame extraction and encoding routes."""

import os
import base64
import traceback

from sanic import Blueprint, response
from sanic.request import Request

bp = Blueprint("video", url_prefix="/video")


@bp.post("/extract-frames")
async def extract_frames(request: Request):
    """Extract frames from a video file using ffmpeg."""
    data = request.json
    video_path = data["video_path"]
    output_dir = data["output_dir"]
    fps = data.get("fps", 10)
    max_frames = data.get("max_frames", 0)
    resize = data.get("resize")

    try:
        import subprocess

        try:
            subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            return response.json({"type": "error", "message": "ffmpeg not found"}, status=400)

        os.makedirs(output_dir, exist_ok=True)

        cmd = ["ffmpeg", "-y", "-i", video_path]
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

        frame_files = sorted([f for f in os.listdir(output_dir) if f.startswith("frame_") and f.endswith(".jpg")])
        frame_count = len(frame_files)

        return response.json({
            "type": "success",
            "frame_count": frame_count,
            "output_dir": output_dir,
            "frames": frame_files[:10],
        })

    except Exception as e:
        return response.json({"type": "error", "message": str(e)}, status=500)


@bp.post("/read-frame")
async def read_frame(request: Request):
    """Read a single extracted frame from disk as data URL."""
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


@bp.post("/encode")
async def encode_video(request: Request):
    """Encode frames directory to video using ffmpeg."""
    data = request.json
    frames_dir = data["frames_dir"]
    output_path = data["output_path"]
    fps = data.get("fps", 30)
    codec = data.get("codec", "libx264")
    crf = data.get("crf", 23)
    pattern = data.get("pattern", "frame_%04d.jpg")

    try:
        import subprocess

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
