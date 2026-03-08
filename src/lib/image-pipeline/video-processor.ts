// Video frame extraction and encoding for Electron
// Uses Canvas + MediaRecorder (both available in Electron renderer)

function computeCanvasSize(
  videoWidth: number,
  videoHeight: number,
  maxDimension: number
): { width: number; height: number } {
  if (maxDimension <= 0 || (videoWidth <= maxDimension && videoHeight <= maxDimension)) {
    return { width: videoWidth, height: videoHeight };
  }
  const scale = maxDimension / Math.max(videoWidth, videoHeight);
  return {
    width: Math.round(videoWidth * scale),
    height: Math.round(videoHeight * scale),
  };
}

function canvasToBlobUrl(
  canvas: HTMLCanvasElement,
  format: string,
  quality: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error("Failed to create blob from canvas"));
        resolve(URL.createObjectURL(blob));
      },
      format,
      quality
    );
  });
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load frame"));
    img.src = src;
  });
}

export async function extractVideoFrame(
  videoSrc: string,
  timeSeconds: number = 0
): Promise<{ frameDataUrl: string; width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;

    video.onloadedmetadata = () => {
      video.currentTime = Math.min(timeSeconds, video.duration);
    };

    video.onseeked = () => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")!.drawImage(video, 0, 0);
      resolve({
        frameDataUrl: canvas.toDataURL("image/png"),
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
      });
      video.remove();
    };

    video.onerror = () => {
      reject(new Error("Failed to load video"));
      video.remove();
    };

    video.src = videoSrc;
  });
}

export async function extractVideoFrames(
  videoSrc: string,
  fps: number = 1,
  maxFrames: number = 30,
  format: string = "image/jpeg",
  quality: number = 0.85,
  maxDimension: number = 0,
  onFrame?: (blobUrl: string, index: number, total: number) => void
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;

    const frames: string[] = [];
    let currentFrame = 0;
    const interval = 1 / fps;
    let canvas: HTMLCanvasElement | null = null;
    let ctx: CanvasRenderingContext2D | null = null;

    video.onloadedmetadata = () => {
      const totalFrames = Math.min(
        Math.floor(video.duration * fps),
        maxFrames
      );
      if (totalFrames <= 0) {
        resolve([]);
        return;
      }

      const size = computeCanvasSize(video.videoWidth, video.videoHeight, maxDimension);
      canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      ctx = canvas.getContext("2d")!;

      const extractNext = () => {
        if (currentFrame >= totalFrames) {
          resolve(frames);
          video.remove();
          return;
        }
        video.currentTime = currentFrame * interval;
      };

      video.onseeked = async () => {
        ctx!.drawImage(video, 0, 0, canvas!.width, canvas!.height);
        const blobUrl = await canvasToBlobUrl(canvas!, format, quality);
        frames.push(blobUrl);
        onFrame?.(blobUrl, currentFrame, totalFrames);
        currentFrame++;
        extractNext();
      };

      extractNext();
    };

    video.onerror = () => {
      reject(new Error("Failed to load video for frame extraction"));
      video.remove();
    };

    video.src = videoSrc;
  });
}

export function revokeFrames(frames: string[]): void {
  for (const url of frames) {
    if (url.startsWith("blob:")) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
  }
}

export async function encodeFramesToVideo(
  frames: string[],
  fps: number = 30,
  onProgress?: (current: number, total: number) => void
): Promise<Blob> {
  if (frames.length === 0) throw new Error("No frames to encode");

  const firstImg = await loadImg(frames[0]);
  const w = firstImg.width;
  const h = firstImg.height;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(firstImg, 0, 0, w, h);

  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];

  let mimeType = "video/webm;codecs=vp9";
  if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = "video/webm;codecs=vp8";
  if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = "video/webm";

  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start();

  const delay = 1000 / fps;
  for (let i = 0; i < frames.length; i++) {
    const img = i === 0 ? firstImg : await loadImg(frames[i]);
    ctx.drawImage(img, 0, 0, w, h);
    if ("requestFrame" in track) {
      (track as unknown as { requestFrame(): void }).requestFrame();
    }
    onProgress?.(i + 1, frames.length);
    await new Promise((r) => setTimeout(r, delay));
  }

  return new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
    recorder.stop();
  });
}

export class StreamingVideoEncoder {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private recorder: MediaRecorder | null = null;
  private track: MediaStreamTrack | null = null;
  private chunks: Blob[] = [];
  private initialized = false;
  private frameCount = 0;
  private delay: number;

  constructor(fps: number = 10) {
    this.delay = 1000 / fps;
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d")!;
  }

  get count(): number {
    return this.frameCount;
  }

  async addFrame(frameSrc: string): Promise<void> {
    const img = await loadImg(frameSrc);

    if (!this.initialized) {
      this.canvas.width = img.width;
      this.canvas.height = img.height;
      this.ctx.drawImage(img, 0, 0, img.width, img.height);

      const stream = this.canvas.captureStream(0);
      this.track = stream.getVideoTracks()[0];

      let mimeType = "video/webm;codecs=vp9";
      if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = "video/webm;codecs=vp8";
      if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = "video/webm";

      this.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
      this.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      this.recorder.start();
      this.initialized = true;
    } else {
      this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
    }

    if (this.track && "requestFrame" in this.track) {
      (this.track as unknown as { requestFrame(): void }).requestFrame();
    }
    this.frameCount++;
    await new Promise((r) => setTimeout(r, this.delay));
  }

  async finalize(): Promise<Blob> {
    if (!this.recorder || this.frameCount === 0) {
      throw new Error("No frames were added to the encoder");
    }
    return new Promise<Blob>((resolve) => {
      this.recorder!.onstop = () => resolve(new Blob(this.chunks, { type: "video/webm" }));
      this.recorder!.stop();
    });
  }
}
