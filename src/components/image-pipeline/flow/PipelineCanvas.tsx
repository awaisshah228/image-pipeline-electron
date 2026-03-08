
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type NodeTypes,
  type EdgeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { usePipelineStore } from "@/lib/image-pipeline/pipeline-store";
import { isValidPipelineConnection } from "@/lib/image-pipeline/connection-validator";
import { PipelineNodeComponent } from "./PipelineNode";
import { PipelineEdge } from "./PipelineEdge";
import { PipelineConnectionLine } from "./PipelineConnectionLine";
import { PipelineContextMenu } from "./PipelineContextMenu";
import { getTypeColor } from "@/lib/image-pipeline/utils";

const nodeTypes: NodeTypes = {
  pipeline: PipelineNodeComponent,
} as unknown as NodeTypes;

const edgeTypes: EdgeTypes = {
  pipeline: PipelineEdge,
} as unknown as EdgeTypes;

export function PipelineCanvas() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  const nodes = usePipelineStore((s) => s.nodes);
  const edges = usePipelineStore((s) => s.edges);
  const onNodesChange = usePipelineStore((s) => s.onNodesChange);
  const onEdgesChange = usePipelineStore((s) => s.onEdgesChange);
  const onConnect = usePipelineStore((s) => s.onConnect);
  const addNode = usePipelineStore((s) => s.addNode);
  const setSelectedNodeId = usePipelineStore((s) => s.setSelectedNodeId);
  const setReactFlowInstance = usePipelineStore(
    (s) => s.setReactFlowInstance
  );

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    flowPosition: { x: number; y: number };
  } | null>(null);

  const onInit = useCallback(
    (instance: ReactFlowInstance) => {
      setReactFlowInstance(instance);
    },
    [setReactFlowInstance]
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const data = e.dataTransfer.getData("application/pipeline-node");
      if (!data) return;

      const { type } = JSON.parse(data);

      const bounds = reactFlowWrapper.current?.getBoundingClientRect();
      if (!bounds) return;

      const rfInstance = usePipelineStore.getState().reactFlowInstance;
      if (!rfInstance) return;

      const position = rfInstance.screenToFlowPosition({
        x: e.clientX - bounds.left,
        y: e.clientY - bounds.top,
      });

      addNode(type, position);
    },
    [addNode]
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: { id: string }) => {
      setSelectedNodeId(node.id);
    },
    [setSelectedNodeId]
  );

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
    setContextMenu(null);
  }, [setSelectedNodeId]);

  // Right-click or double-click on empty canvas opens context menu
  const onPaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      e.preventDefault();
      const rfInstance = usePipelineStore.getState().reactFlowInstance;
      if (!rfInstance) return;
      const bounds = reactFlowWrapper.current?.getBoundingClientRect();
      if (!bounds) return;

      const flowPosition = rfInstance.screenToFlowPosition({
        x: (e as MouseEvent).clientX - bounds.left,
        y: (e as MouseEvent).clientY - bounds.top,
      });

      setContextMenu({
        x: (e as MouseEvent).clientX,
        y: (e as MouseEvent).clientY,
        flowPosition,
      });
    },
    []
  );

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement;
      // Don't intercept when typing in inputs
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      const store = usePipelineStore.getState();

      // Ctrl+Z — Undo
      if (mod && !e.shiftKey && e.key === "z") {
        e.preventDefault();
        store.undo();
        return;
      }

      // Ctrl+Shift+Z or Ctrl+Y — Redo
      if ((mod && e.shiftKey && e.key === "z") || (mod && e.key === "y")) {
        e.preventDefault();
        store.redo();
        return;
      }

      // Ctrl+A — Select all
      if (mod && e.key === "a") {
        e.preventDefault();
        store.selectAll();
        return;
      }

      // Ctrl+C — Copy
      if (mod && e.key === "c") {
        e.preventDefault();
        store.copySelected();
        return;
      }

      // Ctrl+V — Paste
      if (mod && e.key === "v") {
        e.preventDefault();
        // Paste at center of viewport
        const rfInstance = store.reactFlowInstance;
        if (rfInstance) {
          const vp = rfInstance.getViewport();
          const wrapper = reactFlowWrapper.current;
          if (wrapper) {
            const bounds = wrapper.getBoundingClientRect();
            const center = rfInstance.screenToFlowPosition({
              x: bounds.width / 2,
              y: bounds.height / 2,
            });
            store.pasteClipboard(center);
          } else {
            store.pasteClipboard({ x: -vp.x / vp.zoom + 200, y: -vp.y / vp.zoom + 200 });
          }
        } else {
          store.pasteClipboard();
        }
        return;
      }

      // Ctrl+D — Duplicate (copy + paste in place)
      if (mod && e.key === "d") {
        e.preventDefault();
        store.copySelected();
        store.pasteClipboard();
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const isValidConnectionFn = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (connection: any) => {
      if (!connection.source || !connection.target) return false;
      const currentNodes = usePipelineStore.getState().nodes;
      const currentEdges = usePipelineStore.getState().edges;
      return isValidPipelineConnection(
        connection.source,
        connection.target,
        connection.sourceHandle ?? null,
        connection.targetHandle ?? null,
        currentNodes,
        currentEdges
      );
    },
    []
  );

  return (
    <div ref={reactFlowWrapper} className="flex-1 h-full relative">
      <ReactFlow
        nodes={nodes as never[]}
        edges={edges as never[]}
        onNodesChange={onNodesChange as never}
        onEdgesChange={onEdgesChange as never}
        onConnect={onConnect as never}
        onInit={onInit as never}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onNodeClick={onNodeClick as never}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu as never}
        isValidConnection={isValidConnectionFn}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionLineComponent={PipelineConnectionLine}
        defaultEdgeOptions={{
          type: "pipeline",
          animated: true,
        }}
        fitView
        snapToGrid
        snapGrid={[16, 16]}
        minZoom={0.1}
        maxZoom={2}
        selectionOnDrag
        multiSelectionKeyCode="Shift"
        deleteKeyCode={["Backspace", "Delete"]}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="color-mix(in srgb, var(--muted-foreground) 15%, transparent)"
        />
        <Controls
          position="bottom-right"
          className="!bg-card !border-border !shadow-lg !rounded-lg"
        />
        <MiniMap
          position="bottom-left"
          nodeColor={(node) => {
            const def = (node.data as { definition?: { category?: string } })
              ?.definition;
            if (def?.category) {
              return getTypeColor([def.category]);
            }
            return "#94a3b8";
          }}
          className="!bg-card !border-border !rounded-lg"
          maskColor="color-mix(in srgb, var(--background) 80%, transparent)"
        />
      </ReactFlow>

      {/* Context menu for adding nodes */}
      {contextMenu && (
        <PipelineContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          flowPosition={contextMenu.flowPosition}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
