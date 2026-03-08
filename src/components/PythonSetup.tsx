import { useState, useEffect, useCallback, useRef } from "react";
import {
  Terminal,
  Check,
  X,
  Loader2,
  Cpu,
  AlertTriangle,
} from "lucide-react";

type SetupStage = "detect" | "download" | "check-deps" | "install-deps" | "starting" | "ready" | "error";

interface Props {
  onReady: () => void;
}

export function PythonSetup({ onReady }: Props) {
  const [stage, setStage] = useState<SetupStage>("detect");
  const [percentage, setPercentage] = useState(0);
  const [message, setMessage] = useState("Looking for Python...");
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [backendUrl, setBackendUrl] = useState<string | null>(null);
  const [hasGpu, setHasGpu] = useState(false);
  const started = useRef(false);

  const api = window.electronAPI?.python;

  // Run the full automatic setup flow
  useEffect(() => {
    if (!api || started.current) return;
    started.current = true;

    // Listen for progress events from the main process
    const cleanupProgress = api.onSetupProgress?.((data: { stage: string; percentage: number; message: string }) => {
      setStage(data.stage as SetupStage);
      setPercentage(data.percentage);
      setMessage(data.message);
      setLogs((prev) => [...prev.slice(-200), data.message]);
    });

    // Listen for install output
    const cleanupInstall = api.onInstallProgress?.((output: string) => {
      setLogs((prev) => [...prev.slice(-200), output]);
    });

    (async () => {
      try {
        // Step 1-3: Detect/download Python + install deps (all-in-one)
        await api.setup();

        // Step 4: Start backend server
        setStage("starting");
        setMessage("Starting backend server...");
        setPercentage(0);

        const startResult = await api.start();
        setBackendUrl(startResult.url);

        // Check GPU status
        try {
          const status = await api.status();
          setHasGpu(status.python?.hasCuda ?? false);
        } catch {}

        setStage("ready");
        setMessage("Backend ready");
        setPercentage(100);

        // Auto-proceed after a brief moment
        setTimeout(onReady, 1200);
      } catch (err) {
        setStage("error");
        setError(err instanceof Error ? err.message : String(err));
        setMessage("Setup failed");
      }
    })();

    return () => {
      cleanupProgress?.();
      cleanupInstall?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSkip = useCallback(() => {
    onReady();
  }, [onReady]);

  const handleRetry = useCallback(() => {
    setError(null);
    setLogs([]);
    started.current = false;
    setStage("detect");
    setPercentage(0);
    setMessage("Looking for Python...");
    // Force re-run by toggling a state
    started.current = false;
    // Trigger the effect again
    window.location.reload();
  }, []);

  const stageOrder: SetupStage[] = ["detect", "download", "check-deps", "install-deps", "starting", "ready"];
  const currentIdx = stageOrder.indexOf(stage);

  function getStepStatus(stepStage: SetupStage): "pending" | "loading" | "done" | "error" {
    const stepIdx = stageOrder.indexOf(stepStage);
    if (stage === "error" && stepIdx === currentIdx) return "error";
    if (stepIdx < currentIdx) return "done";
    if (stepIdx === currentIdx) return "loading";
    return "pending";
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="w-[520px] rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-neutral-800 px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-500/10">
            <Terminal className="h-5 w-5 text-orange-500" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">Python Backend Setup</h2>
            <p className="text-xs text-neutral-400">Automatically configuring GPU-accelerated inference</p>
          </div>
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-4">
          {/* Step indicators */}
          <div className="space-y-2">
            <StepRow
              label="Detect Python"
              status={getStepStatus("detect")}
              detail={getStepStatus("detect") === "done" ? "Found" : undefined}
            />
            {(stage === "download" || currentIdx > stageOrder.indexOf("download")) && (
              <StepRow
                label="Download Python runtime"
                status={getStepStatus("download")}
                detail={getStepStatus("download") === "loading" ? `${percentage}%` : undefined}
              />
            )}
            <StepRow
              label="Check & install dependencies"
              status={
                getStepStatus("check-deps") === "done" && getStepStatus("install-deps") === "done"
                  ? "done"
                  : getStepStatus("check-deps") === "loading" || getStepStatus("install-deps") === "loading"
                    ? "loading"
                    : getStepStatus("check-deps") === "done" || getStepStatus("install-deps") !== "pending"
                      ? getStepStatus("install-deps")
                      : "pending"
              }
              detail={
                (stage === "install-deps") ? `Installing... ${percentage}%` :
                (stage === "check-deps") ? "Checking..." : undefined
              }
            />
            <StepRow
              label="Start backend server"
              status={getStepStatus("starting")}
              detail={backendUrl ? `Running at ${backendUrl}` : undefined}
            />
          </div>

          {/* Progress bar */}
          {stage !== "ready" && stage !== "error" && (
            <div className="h-1 rounded-full bg-neutral-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-orange-500 transition-all duration-300"
                style={{ width: `${percentage}%` }}
              />
            </div>
          )}

          {/* Current message */}
          <p className="text-[11px] text-neutral-500 truncate">{message}</p>

          {/* Install logs (scrollable) */}
          {(stage === "install-deps" || stage === "download") && logs.length > 0 && (
            <div className="max-h-32 overflow-auto rounded-lg bg-black p-3 font-mono text-[11px] text-neutral-400">
              {logs.slice(-50).map((log, i) => (
                <div key={i}>{log}</div>
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/20 p-3">
              <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300">{error}</p>
            </div>
          )}

          {/* Ready banner */}
          {stage === "ready" && (
            <div className="flex items-center gap-2 rounded-lg bg-green-500/10 border border-green-500/20 p-3">
              <Cpu className="h-4 w-4 text-green-400" />
              <p className="text-xs text-green-300">
                Backend ready {hasGpu ? "with CUDA GPU" : "(CPU mode)"}
              </p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between border-t border-neutral-800 px-5 py-3">
          <button
            onClick={handleSkip}
            className="rounded-md px-3 py-1.5 text-xs text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
          >
            Skip (CPU only)
          </button>

          {stage === "error" && (
            <button
              onClick={handleRetry}
              className="flex items-center gap-1.5 rounded-md bg-orange-500/10 border border-orange-500/30 px-3 py-1.5 text-xs font-medium text-orange-400 hover:bg-orange-500/20 transition-colors"
            >
              Retry
            </button>
          )}

          {stage === "ready" && (
            <div className="flex items-center gap-1.5 text-xs text-green-400">
              <Check className="h-3.5 w-3.5" />
              Ready
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepRow({
  label,
  status,
  detail,
}: {
  label: string;
  status: "pending" | "loading" | "done" | "error";
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-5 w-5 items-center justify-center">
        {status === "loading" && <Loader2 className="h-4 w-4 text-orange-400 animate-spin" />}
        {status === "done" && <Check className="h-4 w-4 text-green-400" />}
        {status === "error" && <X className="h-4 w-4 text-red-400" />}
        {status === "pending" && <div className="h-2 w-2 rounded-full bg-neutral-600" />}
      </div>
      <div className="flex-1 min-w-0">
        <span className={`text-xs font-medium ${status === "done" ? "text-green-400" : status === "error" ? "text-red-400" : "text-neutral-300"}`}>
          {label}
        </span>
        {detail && (
          <span className="ml-2 text-[11px] text-neutral-500">{detail}</span>
        )}
      </div>
    </div>
  );
}
