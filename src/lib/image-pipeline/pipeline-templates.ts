import { findPipelineNodeDefinition } from "./node-registry";
import { encodeHandleId } from "./utils";
import type { PipelineNode, PipelineEdge } from "./types";

export interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  icon: string; // lucide icon name
  build: () => { nodes: PipelineNode[]; edges: PipelineEdge[] } | null;
}

function mkNode(
  id: string,
  type: string,
  pos: { x: number; y: number },
  extraFields?: Record<string, unknown>
): PipelineNode | null {
  const def = findPipelineNodeDefinition(type);
  if (!def) return null;
  const fieldValues: Record<string, unknown> = {};
  for (const inp of def.inputs) {
    if (inp.value !== undefined) fieldValues[inp.name] = inp.value;
  }
  if (extraFields) Object.assign(fieldValues, extraFields);
  return {
    id,
    type: "pipeline",
    position: pos,
    data: { definition: structuredClone(def), fieldValues, showNode: true },
  };
}

function mkEdge(
  id: string,
  srcNodeId: string,
  tgtNodeId: string,
  srcOutput: { name: string; types: string[] },
  tgtInput: { name: string; types: string[]; fieldType?: string }
): PipelineEdge {
  return {
    id,
    source: srcNodeId,
    target: tgtNodeId,
    sourceHandle: encodeHandleId({
      nodeId: srcNodeId,
      outputName: srcOutput.name,
      outputTypes: srcOutput.types,
    }),
    targetHandle: encodeHandleId({
      nodeId: tgtNodeId,
      inputName: tgtInput.name,
      inputTypes: tgtInput.types,
      fieldType: tgtInput.fieldType ?? "str",
    }),
    type: "pipeline",
    animated: true,
    data: {
      sourceOutputName: srcOutput.name,
      sourceOutputTypes: srcOutput.types,
      targetInputName: tgtInput.name,
      targetInputTypes: tgtInput.types,
    },
  };
}

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    id: "image_yolo",
    name: "Image YOLO Detection",
    description: "Load image → YOLO object detection → preview annotated result with object gallery",
    icon: "Brain",
    build() {
      const n1 = mkNode("tpl_load", "load_image", { x: 0, y: 0 });
      const n2 = mkNode("tpl_yolo", "yolo_detect", { x: 450, y: 0 });
      const n3 = mkNode("tpl_count", "number_display", { x: 900, y: -80 });
      const n4 = mkNode("tpl_gallery", "image_gallery", { x: 900, y: 120 });
      if (!n1 || !n2 || !n3 || !n4) return null;

      return {
        nodes: [n1, n2, n3, n4],
        edges: [
          mkEdge("tpl_e1", "tpl_load", "tpl_yolo",
            { name: "image", types: ["Image"] },
            { name: "image", types: ["Image"] }),
          mkEdge("tpl_e2", "tpl_yolo", "tpl_count",
            { name: "count", types: ["Number"] },
            { name: "value", types: ["Number"], fieldType: "float" }),
          mkEdge("tpl_e3", "tpl_yolo", "tpl_gallery",
            { name: "objects", types: ["ImageList"] },
            { name: "images", types: ["ImageList"] }),
        ],
      };
    },
  },
  {
    id: "video_yolo",
    name: "Video YOLO Detection",
    description: "Load video → extract frames → YOLO on each frame → save annotated video + frames zip",
    icon: "Video",
    build() {
      const n1 = mkNode("tpl_vload", "video_load", { x: 0, y: 0 });
      const n2 = mkNode("tpl_yolo", "yolo_detect", { x: 500, y: 0 });
      const n3 = mkNode("tpl_vsave", "video_save", { x: 1000, y: -80 }, { fps: 5 });
      const n4 = mkNode("tpl_bsave", "batch_save", { x: 1000, y: 120 });
      if (!n1 || !n2 || !n3 || !n4) return null;

      return {
        nodes: [n1, n2, n3, n4],
        edges: [
          mkEdge("tpl_e1", "tpl_vload", "tpl_yolo",
            { name: "frames", types: ["ImageList"] },
            { name: "image", types: ["Image"] }),
          mkEdge("tpl_e2", "tpl_yolo", "tpl_vsave",
            { name: "image", types: ["Image"] },
            { name: "frames", types: ["ImageList", "Image"] }),
          mkEdge("tpl_e3", "tpl_yolo", "tpl_bsave",
            { name: "objects", types: ["ImageList"] },
            { name: "images", types: ["ImageList"] }),
        ],
      };
    },
  },
  {
    id: "webcam_yolo",
    name: "Webcam Live Detection",
    description: "Webcam capture → live YOLO detection → streaming video encode → download when stopped",
    icon: "Camera",
    build() {
      const n1 = mkNode("tpl_cam", "webcam_capture", { x: 0, y: 0 }, { capture_fps: 2, max_frames: 0 });
      const n2 = mkNode("tpl_yolo", "yolo_detect", { x: 500, y: 0 });
      const n3 = mkNode("tpl_preview", "preview_image", { x: 1000, y: -120 });
      const n4 = mkNode("tpl_vsave", "video_save", { x: 1000, y: 100 }, { fps: 2 });
      if (!n1 || !n2 || !n3 || !n4) return null;

      return {
        nodes: [n1, n2, n3, n4],
        edges: [
          // Webcam → YOLO (each frame streamed to YOLO for detection)
          mkEdge("tpl_e1", "tpl_cam", "tpl_yolo",
            { name: "image", types: ["Image"] },
            { name: "image", types: ["Image"] }),
          // YOLO annotated → Preview (live view of detections)
          mkEdge("tpl_e2", "tpl_yolo", "tpl_preview",
            { name: "image", types: ["Image"] },
            { name: "image", types: ["Image"] }),
          // YOLO annotated → Save Video (streaming encode, download on stop)
          mkEdge("tpl_e3", "tpl_yolo", "tpl_vsave",
            { name: "image", types: ["Image"] },
            { name: "frames", types: ["ImageList", "Image"] }),
        ],
      };
    },
  },
  {
    id: "face_detection",
    name: "Face Detection",
    description: "Load image → OpenCV face detection → face count + cropped faces gallery",
    icon: "ScanFace",
    build() {
      const n1 = mkNode("tpl_load", "load_image", { x: 0, y: 0 });
      const n2 = mkNode("tpl_face", "face_detect_cv", { x: 450, y: 0 });
      const n3 = mkNode("tpl_count", "number_display", { x: 900, y: -80 });
      const n4 = mkNode("tpl_gallery", "image_gallery", { x: 900, y: 120 });
      if (!n1 || !n2 || !n3 || !n4) return null;

      return {
        nodes: [n1, n2, n3, n4],
        edges: [
          mkEdge("tpl_e1", "tpl_load", "tpl_face",
            { name: "image", types: ["Image"] },
            { name: "image", types: ["Image"] }),
          mkEdge("tpl_e2", "tpl_face", "tpl_count",
            { name: "count", types: ["Number"] },
            { name: "value", types: ["Number"], fieldType: "float" }),
          mkEdge("tpl_e3", "tpl_face", "tpl_gallery",
            { name: "faces", types: ["ImageList"] },
            { name: "images", types: ["ImageList"] }),
        ],
      };
    },
  },
  {
    id: "image_enhance",
    name: "Image Enhancement",
    description: "Load image → denoise → sharpen → histogram equalization → save",
    icon: "Sun",
    build() {
      const n1 = mkNode("tpl_load", "load_image", { x: 0, y: 0 });
      const n2 = mkNode("tpl_denoise", "bilateral_filter", { x: 400, y: 0 });
      const n3 = mkNode("tpl_sharpen", "sharpen", { x: 800, y: 0 });
      const n4 = mkNode("tpl_hist", "histogram_eq", { x: 1200, y: 0 });
      const n5 = mkNode("tpl_save", "save_image", { x: 1600, y: 0 });
      if (!n1 || !n2 || !n3 || !n4 || !n5) return null;

      return {
        nodes: [n1, n2, n3, n4, n5],
        edges: [
          mkEdge("tpl_e1", "tpl_load", "tpl_denoise",
            { name: "image", types: ["Image"] },
            { name: "image", types: ["Image"] }),
          mkEdge("tpl_e2", "tpl_denoise", "tpl_sharpen",
            { name: "image", types: ["Image"] },
            { name: "image", types: ["Image"] }),
          mkEdge("tpl_e3", "tpl_sharpen", "tpl_hist",
            { name: "image", types: ["Image"] },
            { name: "image", types: ["Image"] }),
          mkEdge("tpl_e4", "tpl_hist", "tpl_save",
            { name: "image", types: ["Image"] },
            { name: "image", types: ["Image"] }),
        ],
      };
    },
  },
  {
    id: "edge_detect",
    name: "Edge Detection Pipeline",
    description: "Load image → grayscale → Canny edge detection → compare side by side",
    icon: "Zap",
    build() {
      const n1 = mkNode("tpl_load", "load_image", { x: 0, y: 0 });
      const n2 = mkNode("tpl_gray", "color_space", { x: 400, y: 0 }, { color_space: "Grayscale" });
      const n3 = mkNode("tpl_canny", "canny_edge", { x: 800, y: 0 });
      if (!n1 || !n2 || !n3) return null;

      return {
        nodes: [n1, n2, n3],
        edges: [
          mkEdge("tpl_e1", "tpl_load", "tpl_gray",
            { name: "image", types: ["Image"] },
            { name: "image", types: ["Image"] }),
          mkEdge("tpl_e2", "tpl_gray", "tpl_canny",
            { name: "image", types: ["Image"] },
            { name: "image", types: ["Image"] }),
        ],
      };
    },
  },
];
