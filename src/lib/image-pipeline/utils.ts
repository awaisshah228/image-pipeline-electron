export function encodeHandleId(data: Record<string, unknown>): string {
  return btoa(JSON.stringify(data));
}

export function decodeHandleId<T>(id: string): T {
  return JSON.parse(atob(id)) as T;
}

export function getTypeColor(types: string[]): string {
  const type = types[0]?.toLowerCase() ?? "default";
  const colors: Record<string, string> = {
    image: "#f97316",
    imagelist: "#ea580c",
    model: "#8b5cf6",
    number: "#3b82f6",
    text: "#22c55e",
    textlist: "#16a34a",
    color: "#ec4899",
    default: "#94a3b8",
  };
  return colors[type] ?? "#94a3b8";
}

export function getCategoryColor(category: string): string {
  const colors: Record<string, string> = {
    input: "#3b82f6",
    output: "#22c55e",
    image_adjust: "#f59e0b",
    image_filter: "#a855f7",
    image_transform: "#06b6d4",
    ai_upscale: "#ef4444",
    ai_enhance: "#ec4899",
    computer_vision: "#0ea5e9",
    image_channel: "#8b5cf6",
    utility: "#6b7280",
    batch: "#14b8a6",
  };
  return colors[category] ?? "#94a3b8";
}

let idCounter = 0;
export function generateNodeId(): string {
  return `pip_${Date.now()}_${idCounter++}`;
}
