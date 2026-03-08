import { useEffect, useState, useCallback } from "react";
import {
  Download,
  Trash2,
  Pencil,
  Check,
  Sun,
  Moon,
  Play,
  AlertTriangle,
  X,
  Upload,
  ImageIcon,
  LayoutTemplate,
  Brain,
  Video,
  Camera,
  ScanFace,
  Zap,
  HardDrive,
  Cpu,
} from "lucide-react";
import { ReactFlowProvider } from "@xyflow/react";
import { usePipelineStore } from "@/lib/image-pipeline/pipeline-store";
import { findPipelineNodeDefinition } from "@/lib/image-pipeline/node-registry";
import { encodeHandleId } from "@/lib/image-pipeline/utils";
import { PIPELINE_TEMPLATES } from "@/lib/image-pipeline/pipeline-templates";
import { PipelineSidebar } from "@/components/image-pipeline/sidebar/PipelineSidebar";
import { PipelineCanvas } from "@/components/image-pipeline/flow/PipelineCanvas";
import { PipelineNodeSettingsPanel } from "@/components/image-pipeline/sidebar/PipelineNodeSettingsPanel";
import { PipelineExportDialog } from "@/components/image-pipeline/PipelineExportDialog";
import { PipelineRunDialog } from "@/components/image-pipeline/PipelineRunDialog";
import { AiModelManagerDialog } from "@/components/image-pipeline/AiModelManagerDialog";
import type { PipelineNode, PipelineEdge } from "@/lib/image-pipeline/types";
import { PythonSetup } from "@/components/PythonSetup";
import "./image-pipeline.css";

function App() {
  const loadDefinitions = usePipelineStore((s) => s.loadDefinitions);
  const definitionsLoaded = usePipelineStore((s) => s.definitionsLoaded);
  const pipelineName = usePipelineStore((s) => s.pipelineName);
  const setPipelineName = usePipelineStore((s) => s.setPipelineName);
  const clearPipeline = usePipelineStore((s) => s.clearPipeline);
  const importPipeline = usePipelineStore((s) => s.importPipeline);
  const nodes = usePipelineStore((s) => s.nodes);
  const edges = usePipelineStore((s) => s.edges);

  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [exportOpen, setExportOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(pipelineName);
  const [showPythonSetup, setShowPythonSetup] = useState(
    () => !!window.electronAPI?.python && !sessionStorage.getItem("pythonSetupDone")
  );
  const [warningDismissed, setWarningDismissed] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [aiModelsOpen, setAiModelsOpen] = useState(false);
  const [gpuProviders, setGpuProviders] = useState<string[]>([]);

  useEffect(() => {
    loadDefinitions();
  }, [loadDefinitions]);

  // Always start dark; detect GPU providers; clean up workers on unmount
  useEffect(() => {
    document.documentElement.classList.add("dark");

    // Detect available GPU providers
    if (window.electronAPI?.gpu) {
      window.electronAPI.gpu.getProviders().then(setGpuProviders).catch(() => {});
    }

    return () => {
      document.documentElement.classList.remove("dark");
      // Python backend cleanup is handled by Electron main process on quit
    };
  }, []);

  // Load default demo pipeline on first visit
  useEffect(() => {
    if (!definitionsLoaded) return;
    const { nodes: existing } = usePipelineStore.getState();
    if (existing.length > 0) return;

    const loadImg = findPipelineNodeDefinition("load_image");
    const faceDetect = findPipelineNodeDefinition("face_detect_cv");
    const numDisplay = findPipelineNodeDefinition("number_display");
    const gallery = findPipelineNodeDefinition("image_gallery");
    if (!loadImg || !faceDetect || !numDisplay || !gallery) return;

    const n1 = "demo_load";
    const n2 = "demo_face";
    const n3 = "demo_count";
    const n4 = "demo_gallery";

    const mkNode = (
      id: string,
      def: NonNullable<ReturnType<typeof findPipelineNodeDefinition>>,
      pos: { x: number; y: number }
    ): PipelineNode => ({
      id,
      type: "pipeline",
      position: pos,
      data: {
        definition: structuredClone(def),
        fieldValues: Object.fromEntries(
          def.inputs.filter((i) => i.value !== undefined).map((i) => [i.name, i.value])
        ),
        showNode: true,
      },
    });

    const demoNodes: PipelineNode[] = [
      mkNode(n1, loadImg, { x: 0, y: 0 }),
      mkNode(n2, faceDetect, { x: 450, y: 0 }),
      mkNode(n3, numDisplay, { x: 900, y: -80 }),
      mkNode(n4, gallery, { x: 900, y: 120 }),
    ];

    const e1src = encodeHandleId({ nodeId: n1, outputName: "image", outputTypes: ["Image"] });
    const e1tgt = encodeHandleId({ nodeId: n2, inputName: "image", inputTypes: ["Image"], fieldType: "str" });
    const e2src = encodeHandleId({ nodeId: n2, outputName: "count", outputTypes: ["Number"] });
    const e2tgt = encodeHandleId({ nodeId: n3, inputName: "value", inputTypes: ["Number"], fieldType: "float" });
    const e3src = encodeHandleId({ nodeId: n2, outputName: "faces", outputTypes: ["ImageList"] });
    const e3tgt = encodeHandleId({ nodeId: n4, inputName: "images", inputTypes: ["ImageList"], fieldType: "str" });

    const demoEdges: PipelineEdge[] = [
      {
        id: "demo_e1", source: n1, target: n2,
        sourceHandle: e1src, targetHandle: e1tgt,
        type: "pipeline", animated: true,
        data: { sourceOutputName: "image", sourceOutputTypes: ["Image"], targetInputName: "image", targetInputTypes: ["Image"] },
      },
      {
        id: "demo_e2", source: n2, target: n3,
        sourceHandle: e2src, targetHandle: e2tgt,
        type: "pipeline", animated: true,
        data: { sourceOutputName: "count", sourceOutputTypes: ["Number"], targetInputName: "value", targetInputTypes: ["Number"] },
      },
      {
        id: "demo_e3", source: n2, target: n4,
        sourceHandle: e3src, targetHandle: e3tgt,
        type: "pipeline", animated: true,
        data: { sourceOutputName: "faces", sourceOutputTypes: ["ImageList"], targetInputName: "images", targetInputTypes: ["ImageList"] },
      },
    ];

    usePipelineStore.getState().importPipeline(demoNodes, demoEdges, "Face Detection Demo");
  }, [definitionsLoaded]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      document.documentElement.classList.add("transitioning");
      document.documentElement.classList.toggle("dark", next === "dark");
      setTimeout(() => {
        document.documentElement.classList.remove("transitioning");
      }, 300);
      return next;
    });
  }, []);

  const handleNameSubmit = useCallback(() => {
    if (nameInput.trim()) {
      setPipelineName(nameInput.trim());
    }
    setEditingName(false);
  }, [nameInput, setPipelineName]);

  const handleImport = useCallback(async () => {
    // Use native file dialog instead of browser input
    if (window.electronAPI) {
      const result = await window.electronAPI.dialog.openFile({
        title: "Import Pipeline",
        filters: [{ name: "Pipeline JSON", extensions: ["json"] }],
      });
      if (result.canceled || result.filePaths.length === 0) return;

      try {
        const base64 = await window.electronAPI.fs.readFile(result.filePaths[0]);
        const text = atob(base64);
        const data = JSON.parse(text);

        if (data.nodes && Array.isArray(data.nodes)) {
          const reconstructedNodes = data.nodes.map(
            (n: { id: string; type: string; position: { x: number; y: number }; fieldValues: Record<string, unknown> }) => {
              const definition = findPipelineNodeDefinition(n.type);
              return {
                id: n.id,
                type: "pipeline",
                position: n.position,
                data: {
                  definition: definition ?? {
                    type: n.type,
                    display_name: n.type,
                    description: "",
                    icon: "Cog",
                    category: "utility",
                    inputs: [],
                    outputs: [],
                  },
                  fieldValues: n.fieldValues ?? {},
                  showNode: true,
                },
              };
            }
          );

          const reconstructedEdges = (data.edges ?? []).map(
            (e: { id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string }) => ({
              ...e,
              type: "pipeline",
              animated: true,
              data: {},
            })
          );

          importPipeline(reconstructedNodes, reconstructedEdges, data.name);
        }
      } catch {
        alert("Failed to import pipeline file.");
      }
    }
  }, [importPipeline]);

  const templateIconMap: Record<string, React.ElementType> = {
    Brain, Video, Camera, ScanFace, Sun, Zap,
  };

  const handleLoadTemplate = useCallback((templateId: string) => {
    const tpl = PIPELINE_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return;
    const result = tpl.build();
    if (!result) return;
    if (nodes.length > 0 && !window.confirm("Replace current pipeline with template?")) return;
    importPipeline(result.nodes, result.edges, tpl.name);
    setTemplateOpen(false);
  }, [nodes.length, importPipeline]);

  return (
    <>
    {/* Loading screen — shown until pipeline definitions are fetched */}
    {!definitionsLoaded && (
      <div
        className="image-pipeline-root flex h-screen items-center justify-center"
        style={{ backgroundColor: "var(--background)" }}
      >
        <div className="flex flex-col items-center gap-3">
          <ImageIcon className="h-8 w-8 animate-pulse" style={{ color: "hsl(24, 95%, 53%)" }} />
          <p className="text-sm text-muted-foreground">
            Loading pipeline components...
          </p>
        </div>
      </div>
    )}

    {/* Main UI — rendered once definitions are loaded */}
    {definitionsLoaded && (
    <ReactFlowProvider>
      <div className="image-pipeline-root flex h-screen flex-col bg-background">
        {/* macOS titlebar drag region */}
        <div className="titlebar-drag h-8 shrink-0 flex items-center justify-center" style={{ backgroundColor: "var(--card)" }}>
          <span className="text-[10px] text-muted-foreground font-medium">Image Pipeline Desktop</span>
        </div>

        {/* Top toolbar */}
        <header className="titlebar-no-drag flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <ImageIcon className="h-5 w-5 text-orange-500" />
              <span className="text-xs font-bold text-orange-500 tracking-wide">
                PIPELINE
              </span>
            </div>

            <div className="h-4 w-px" style={{ backgroundColor: "var(--border)" }} />

            {editingName ? (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleNameSubmit();
                    if (e.key === "Escape") setEditingName(false);
                  }}
                  onBlur={handleNameSubmit}
                  autoFocus
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm font-semibold focus:border-orange-500 focus:outline-none"
                />
                <button onClick={handleNameSubmit} className="rounded p-0.5 hover:bg-accent">
                  <Check className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => { setNameInput(pipelineName); setEditingName(true); }}
                className="flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-accent group transition-colors"
              >
                <span className="text-sm font-semibold">{pipelineName}</span>
                <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            )}

            <div className="h-4 w-px" style={{ backgroundColor: "var(--border)" }} />

            <span className="text-xs text-muted-foreground">
              {nodes.length} node{nodes.length !== 1 ? "s" : ""} &middot;{" "}
              {edges.length} connection{edges.length !== 1 ? "s" : ""}
            </span>

            {/* GPU status indicator */}
            {gpuProviders.length > 1 && (
              <>
                <div className="h-4 w-px" style={{ backgroundColor: "var(--border)" }} />
                <div className="flex items-center gap-1">
                  <Cpu className="h-3 w-3 text-green-500" />
                  <span className="text-[10px] text-green-500 font-medium">
                    GPU: {gpuProviders.filter(p => p !== "cpu").join(", ").toUpperCase()}
                  </span>
                </div>
              </>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={toggleTheme}
              className="flex items-center justify-center rounded-md border border-border p-1.5 hover:bg-accent transition-colors"
              title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            >
              {theme === "light" ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
            </button>

            <div className="h-4 w-px mx-0.5" style={{ backgroundColor: "var(--border)" }} />

            <div className="relative">
              <button
                onClick={() => setTemplateOpen(!templateOpen)}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
                style={{
                  border: "1px solid rgba(249,115,22,0.3)",
                  backgroundColor: "rgba(249,115,22,0.08)",
                  color: "hsl(24, 95%, 53%)",
                }}
              >
                <LayoutTemplate className="h-3.5 w-3.5" />
                Templates
              </button>
              {templateOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setTemplateOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 z-50 w-80 rounded-lg border border-border bg-card shadow-xl overflow-hidden">
                    <div className="px-3 py-2 border-b border-border">
                      <span className="text-xs font-semibold text-muted-foreground">Quick Start Templates</span>
                    </div>
                    <div className="max-h-80 overflow-auto">
                      {PIPELINE_TEMPLATES.map((tpl) => {
                        const Icon = templateIconMap[tpl.icon] ?? ImageIcon;
                        return (
                          <button
                            key={tpl.id}
                            onClick={() => handleLoadTemplate(tpl.id)}
                            className="flex items-start gap-3 w-full px-3 py-2.5 text-left hover:bg-accent transition-colors"
                          >
                            <div
                              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                              style={{ backgroundColor: "rgba(249,115,22,0.1)" }}
                            >
                              <Icon className="h-3.5 w-3.5" style={{ color: "hsl(24, 95%, 53%)" }} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-medium">{tpl.name}</div>
                              <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{tpl.description}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>

            <button
              onClick={() => setAiModelsOpen(true)}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
            >
              <Brain className="h-3.5 w-3.5" />
              AI Models
            </button>

            <button
              onClick={handleImport}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
            >
              <Upload className="h-3.5 w-3.5" />
              Import
            </button>

            <button
              onClick={() => setRunOpen(true)}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
              style={{
                border: "1px solid rgba(249,115,22,0.3)",
                backgroundColor: "rgba(249,115,22,0.1)",
                color: "hsl(24, 95%, 53%)",
              }}
            >
              <Play className="h-3.5 w-3.5" />
              Run
            </button>

            <button
              onClick={() => setExportOpen(true)}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </button>

            <button
              onClick={() => {
                if (nodes.length === 0 || window.confirm("Clear all nodes and connections?")) {
                  clearPipeline();
                }
              }}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-destructive hover:text-destructive-foreground hover:border-destructive transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </button>
          </div>
        </header>

        {/* Info banner */}
        {!warningDismissed && (
          <div className="flex items-center gap-2 border-b border-orange-500/20 bg-orange-500/5 px-4 py-2 shrink-0">
            <HardDrive className="h-3.5 w-3.5 text-orange-500 shrink-0" />
            <p className="flex-1 text-xs text-muted-foreground">
              <span className="font-medium" style={{ color: "hsl(24, 95%, 53%)" }}>
                Desktop Pipeline Editor.
              </span>{" "}
              Native file system access, GPU-accelerated inference ({gpuProviders.join(", ")}), and local model management.
              Drag nodes from the sidebar to build processing chains.
            </p>
            <button onClick={() => setWarningDismissed(true)} className="rounded p-0.5 hover:bg-accent shrink-0">
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
        )}

        {/* Main content */}
        <div className="flex flex-1 overflow-hidden">
          <PipelineSidebar />
          <PipelineCanvas />
          <PipelineNodeSettingsPanel />
        </div>

        {/* Dialogs */}
        <PipelineExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
        <PipelineRunDialog open={runOpen} onClose={() => setRunOpen(false)} />
        <AiModelManagerDialog open={aiModelsOpen} onClose={() => setAiModelsOpen(false)} />

      </div>
    </ReactFlowProvider>
    )}

    {/* Python setup — always at same tree position so it never remounts */}
    {showPythonSetup && (
      <PythonSetup onReady={() => {
        sessionStorage.setItem("pythonSetupDone", "1");
        setShowPythonSetup(false);
      }} />
    )}
    </>
  );
}

export default App;
