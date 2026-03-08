// Node registry adapted for Electron — loads definitions from bundled resources
import type { PipelineNodeDefinition, PipelineCategoryIndex } from "./types";

let cachedDefinitions: Record<string, PipelineNodeDefinition[]> | null = null;
let cachedCategories: PipelineCategoryIndex["categories"] | null = null;

export async function loadPipelineNodeDefinitions(): Promise<
  Record<string, PipelineNodeDefinition[]>
> {
  if (cachedDefinitions) return cachedDefinitions;

  // In Electron, load from the bundled public directory
  // During dev, Vite serves from /public; in production, from app resources
  const indexRes = await fetch("/image-pipeline-nodes/index.json");
  const index: PipelineCategoryIndex = await indexRes.json();
  cachedCategories = index.categories;

  const result: Record<string, PipelineNodeDefinition[]> = {};

  await Promise.all(
    index.categories.map(async (cat) => {
      const res = await fetch(`/image-pipeline-nodes/${cat.file}`);
      const nodes: PipelineNodeDefinition[] = await res.json();
      result[cat.name] = nodes;
    })
  );

  cachedDefinitions = result;
  return result;
}

export function getPipelineCategories(): PipelineCategoryIndex["categories"] {
  return cachedCategories ?? [];
}

export function findPipelineNodeDefinition(
  type: string
): PipelineNodeDefinition | undefined {
  if (!cachedDefinitions) return undefined;
  for (const nodes of Object.values(cachedDefinitions)) {
    const found = nodes.find((n) => n.type === type);
    if (found) return found;
  }
  return undefined;
}
