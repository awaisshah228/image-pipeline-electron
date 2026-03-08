import type { Node, Edge } from "@xyflow/react";

export interface PipelineNodeDefinition {
  type: string;
  display_name: string;
  description: string;
  icon: string;
  category: string;
  inputs: PipelineInputField[];
  outputs: PipelineOutputPort[];
}

export type PipelineFieldType =
  | "str"
  | "int"
  | "float"
  | "bool"
  | "dropdown"
  | "file"
  | "password"
  | "tags"
  | "model_file";

export interface PipelineInputField {
  name: string;
  display_name: string;
  type: PipelineFieldType;
  value?: unknown;
  required: boolean;
  show: boolean;
  placeholder?: string;
  info?: string;
  options?: string[];
  multiline?: boolean;
  input_types?: string[];
  file_types?: string[];
}

export interface PipelineOutputPort {
  name: string;
  display_name: string;
  types: string[];
}

export interface PipelineNodeData {
  definition: PipelineNodeDefinition;
  fieldValues: Record<string, unknown>;
  showNode: boolean;
  previewUrl?: string;
  processing?: boolean;
  error?: string;
  /** Extra output data from CV operations (face count, face images, etc.) */
  outputData?: Record<string, unknown>;
  [key: string]: unknown;
}

export type PipelineNode = Node<PipelineNodeData, "pipeline">;
export type PipelineEdge = Edge<PipelineEdgeData>;

export interface PipelineEdgeData {
  sourceOutputName: string;
  sourceOutputTypes: string[];
  targetInputName: string;
  targetInputTypes: string[];
  [key: string]: unknown;
}

export interface PipelineCategoryIndex {
  categories: {
    name: string;
    display_name: string;
    icon: string;
    file: string;
  }[];
}

export interface SourceHandleId {
  nodeId: string;
  outputName: string;
  outputTypes: string[];
}

export interface TargetHandleId {
  nodeId: string;
  inputName: string;
  inputTypes: string[];
  fieldType: PipelineFieldType;
}
