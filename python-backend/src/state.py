"""Shared global state for the Python backend."""

# Cached model instances (YOLO, etc.)
models = {}

# GPU detection results
gpu_available = False
device = "cpu"
