// Webcam / stream capture for Electron
// 3-phase pipeline:
//   Phase 1 — CAPTURE: Save raw frames to disk at full FPS (no processing, no lag)
//   Phase 2 — PROCESS: Python batch-processes frames from disk → disk (YOLO, filters)
//   Phase 3 — ENCODE: ffmpeg combines processed frames into smooth video
//
// Camera preview uses live <video> srcObject (zero-copy, GPU-composited, always smooth).

type CaptureSession = {
  stop: () => void;
  video: HTMLVideoElement;
  stream: MediaStream | null;
  framesDir: string | null;
  requestedFps: number;
  onStopped: ((totalFrames: number, framesDir: string, actualFps: number) => void) | null;
};

let activeSession: CaptureSession | null = null;
let _totalFramesCaptured = 0;
let _totalFramesProcessed = 0;

export function isCapturing(): boolean {
  return activeSession !== null;
}

export function stopWebcamCapture(): void {
  if (activeSession) {
    const session = activeSession;
    const totalFrames = _totalFramesCaptured;
    const framesDir = session.framesDir;
    const onStopped = session.onStopped;

    // Clear onStopped before cleanup to prevent double-fire
    session.onStopped = null;
    session.stop();
    activeSession = null;

    // Fire onStopped AFTER cleanup so Phase 2 can start
    if (onStopped && framesDir && totalFrames > 0) {
      const fps = session.requestedFps;
      console.log(`[Webcam] Stopped. ${totalFrames} frames, encoding at ${fps} fps`);
      onStopped(totalFrames, framesDir, fps);
    }
  }
}

export function getTotalFramesCaptured(): number {
  return _totalFramesCaptured;
}

export function getTotalFramesProcessed(): number {
  return _totalFramesProcessed;
}

export function getActiveStream(): MediaStream | null {
  return activeSession?.stream ?? null;
}

export function getFramesDir(): string | null {
  return activeSession?.framesDir ?? null;
}

/**
 * Phase 1: CAPTURE — Save raw frames to disk at full FPS.
 * No processing happens here. Frames are written as JPEG files to a temp directory.
 * Camera preview uses live <video> srcObject — zero overhead.
 *
 * Returns the temp directory path where frames are saved.
 */
export async function startWebcamCapture(opts: {
  source: "Webcam" | "Stream URL";
  streamUrl?: string;
  captureFps: number;
  maxFrames?: number;
  framesDir: string; // temp dir to save raw frames
  onFrame: (index: number, dataUrl: string) => void;
  onStopped: (totalFrames: number, framesDir: string, actualFps: number) => void;
  onError: (error: Error) => void;
}): Promise<void> {
  stopWebcamCapture();
  _totalFramesCaptured = 0;
  _totalFramesProcessed = 0;

  const { source, streamUrl, captureFps, maxFrames = 0, framesDir, onFrame, onStopped, onError } = opts;
  const fps = Math.min(Math.max(captureFps, 1), 30);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;

  let stream: MediaStream | null = null;
  let stopped = false;

  const cleanup = () => {
    stopped = true;
    video.pause();
    video.srcObject = null;
    video.src = "";
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.remove();
    if (activeSession?.video === video) activeSession = null;
  };

  activeSession = { stop: cleanup, video, stream: null, framesDir, requestedFps: fps, onStopped };

  try {
    if (source === "Webcam") {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      video.srcObject = stream;
      activeSession.stream = stream;
    } else {
      if (!streamUrl) throw new Error("No stream URL provided");
      video.crossOrigin = "anonymous";
      video.src = streamUrl;
    }

    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("Failed to load video source"));
      setTimeout(() => reject(new Error("Video source timeout (10s)")), 10000);
    });

    await video.play();

    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;

    let frameIndex = 0;
    const captureInterval = 1000 / fps;

    // Capture loop: save frames to disk at requested FPS
    const captureLoop = async () => {
      if (stopped) return;

      const loopStart = Date.now();

      if (maxFrames > 0 && frameIndex >= maxFrames) {
        const total = frameIndex;
        if (activeSession) activeSession.onStopped = null;
        cleanup();
        // Encode at the requested FPS — frames are spaced at captureInterval
        onStopped(total, framesDir, fps);
        return;
      }

      ctx.drawImage(video, 0, 0, w, h);

      // Convert canvas to blob (non-blocking, much faster than toDataURL)
      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.90);
      });

      // Write blob to disk
      const filename = `frame_${String(frameIndex + 1).padStart(5, "0")}.jpg`;
      const buffer = new Uint8Array(await blob.arrayBuffer());
      await window.electronAPI.fs.writeBuffer(`${framesDir}/${filename}`, buffer);

      frameIndex++;
      _totalFramesCaptured = frameIndex;

      // Generate data URL for live processing (reuse canvas already drawn)
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      onFrame(frameIndex, dataUrl);

      // Drift-compensated timing: subtract processing time from interval
      const elapsed = Date.now() - loopStart;
      const delay = Math.max(0, captureInterval - elapsed);
      setTimeout(captureLoop, delay);
    };

    captureLoop();
  } catch (err) {
    cleanup();
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Set processed frame count (called by pipeline store during batch processing)
 */
export function setTotalFramesProcessed(count: number): void {
  _totalFramesProcessed = count;
}
