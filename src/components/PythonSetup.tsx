import { useState, useEffect, useCallback, useRef } from "react";
import {
  Terminal,
  Check,
  X,
  Loader2,
  Cpu,
  AlertTriangle,
  Package,
} from "lucide-react";

type SetupStage = "detect" | "download" | "check-deps" | "install-deps" | "starting" | "ready" | "error";

interface PackageProgress {
  installed: number;
  total: number;
  current: string;
  percentage: number;
}

interface Props {
  onReady: () => void;
}

// Module-level flag to prevent double setup in React StrictMode.
// Also check sessionStorage so HMR module reloads don't re-trigger setup.
let setupStarted = !!sessionStorage.getItem("pythonSetupDone");

export function PythonSetup({ onReady }: Props) {
  console.log("[PythonSetup] RENDER — setupStarted:", setupStarted, "sessionStorage:", sessionStorage.getItem("pythonSetupDone"));
  const [stage, setStage] = useState<SetupStage>("detect");
  const [percentage, setPercentage] = useState(0);
  const [message, setMessage] = useState("Looking for Python...");
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [backendUrl, setBackendUrl] = useState<string | null>(null);
  const [hasGpu, setHasGpu] = useState(false);
  const [pkgProgress, setPkgProgress] = useState<PackageProgress | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const closedRef = useRef(false);

  const api = window.electronAPI?.python;

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Register IPC listeners — always active while component is mounted.
  // Separate from the setup effect so StrictMode cleanup doesn't kill them
  // while the setup IPC is still running.
  useEffect(() => {
    if (!api) return;

    const cleanupProgress = api.onSetupProgress((data: { stage: string; percentage: number; message: string }) => {
      // Ignore "ready" from the setup IPC — the component handles the full
      // flow (setup → start backend → GPU check → ready) in its own effect.
      // Without this guard the dialog flashes "ready" then jumps back to "starting".
      if (data.stage === "ready") return;
      setStage(data.stage as SetupStage);
      setPercentage(data.percentage);
      setMessage(data.message);
      setLogs((prev) => [...prev.slice(-200), data.message]);
    });

    const cleanupInstall = api.onInstallProgress((output: string) => {
      setLogs((prev) => [...prev.slice(-200), output]);
    });

    const cleanupPkg = api.onInstallPackageProgress((data: PackageProgress) => {
      setPkgProgress(data);
      if (data.percentage > 0) {
        setPercentage(data.percentage);
      }
    });

    return () => {
      cleanupProgress();
      cleanupInstall();
      cleanupPkg();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!api]);

  // Run the setup flow — guarded by module-level flag so it only runs once.
  // No cleanup/cancelled flag: the IPC call survives StrictMode unmount/remount
  // and state updates are fine because the component remounts immediately.
  useEffect(() => {
    console.log("[PythonSetup] useEffect — api:", !!api, "setupStarted:", setupStarted);
    if (!api || setupStarted) return;
    setupStarted = true;

    (async () => {
      try {
        console.log("[PythonSetup] calling api.setup()...");
        await api.setup();
        console.log("[PythonSetup] api.setup() done, closedRef:", closedRef.current);
        if (closedRef.current) return;

        // Step 4: Start backend server
        setStage("starting");
        setMessage("Starting backend server...");
        setPercentage(0);
        setPkgProgress(null);

        console.log("[PythonSetup] calling api.start()...");
        const startResult = await api.start();
        console.log("[PythonSetup] api.start() done, url:", startResult.url, "closedRef:", closedRef.current);
        if (closedRef.current) return;
        setBackendUrl(startResult.url);

        // Check GPU status
        try {
          const status = await api.status();
          console.log("[PythonSetup] gpu status:", status.python?.hasCuda);
          if (!closedRef.current) setHasGpu(status.python?.hasCuda ?? false);
        } catch {}

        if (closedRef.current) return;
        console.log("[PythonSetup] ALL DONE — setting ready");
        setStage("ready");
        setMessage("Backend ready");
        setPercentage(100);

        // Mark done immediately so HMR or re-renders won't reopen the dialog
        sessionStorage.setItem("pythonSetupDone", "1");

        // Auto-proceed after a brief moment
        setTimeout(() => {
          console.log("[PythonSetup] setTimeout firing onReady, closedRef:", closedRef.current);
          if (!closedRef.current) onReady();
        }, 1200);
      } catch (err) {
        console.error("[PythonSetup] ERROR:", err);
        if (closedRef.current) return;
        setStage("error");
        setError(err instanceof Error ? err.message : String(err));
        setMessage("Setup failed");
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSkip = useCallback(() => {
    closedRef.current = true;
    sessionStorage.setItem("pythonSetupDone", "1");
    onReady();
  }, [onReady]);

  const handleRetry = useCallback(() => {
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

  // Derive deps step status (combines check-deps and install-deps into one row)
  const depsStatus = (() => {
    if (getStepStatus("install-deps") === "done" || (getStepStatus("check-deps") === "done" && getStepStatus("install-deps") === "done")) return "done";
    if (stage === "check-deps" || stage === "install-deps") return "loading";
    if (getStepStatus("check-deps") === "error" || getStepStatus("install-deps") === "error") return "error";
    return "pending";
  })();

  const depsDetail = (() => {
    if (stage === "check-deps") return "Checking installed packages...";
    if (stage === "install-deps" && pkgProgress) {
      return `Installing ${pkgProgress.current || "packages"}... (${pkgProgress.installed}/${pkgProgress.total})`;
    }
    if (stage === "install-deps") return `Installing... ${percentage}%`;
    if (depsStatus === "done") return "All packages installed";
    return undefined;
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="w-[540px] rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl overflow-hidden">
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
          <div className="space-y-2.5">
            <StepRow
              label="Detect Python"
              status={getStepStatus("detect")}
              detail={getStepStatus("detect") === "done" ? "Found" : undefined}
            />
            {(stage === "download" || currentIdx > stageOrder.indexOf("download")) && (
              <StepRow
                label="Download Python runtime"
                status={getStepStatus("download")}
                detail={getStepStatus("download") === "loading" ? `${Math.round(percentage)}%` : undefined}
                progress={stage === "download" ? percentage : undefined}
              />
            )}
            <StepRow
              label="Install dependencies"
              status={depsStatus}
              detail={depsDetail}
              progress={stage === "install-deps" ? percentage : undefined}
              icon={<Package className="h-3.5 w-3.5" />}
            />
            <StepRow
              label="Start backend server"
              status={getStepStatus("starting")}
              detail={backendUrl ? `Running at ${backendUrl}` : undefined}
            />
          </div>

          {/* Per-package progress during install */}
          {stage === "install-deps" && pkgProgress && pkgProgress.total > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-neutral-400 truncate max-w-[300px]">
                  {pkgProgress.current ? `Installing ${pkgProgress.current}` : "Installing packages..."}
                </span>
                <span className="text-[11px] text-neutral-500 tabular-nums">
                  {pkgProgress.installed}/{pkgProgress.total} packages
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-neutral-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-orange-500 transition-all duration-500 ease-out"
                  style={{ width: `${pkgProgress.percentage}%` }}
                />
              </div>
            </div>
          )}

          {/* Download progress bar */}
          {stage === "download" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-neutral-400">Downloading Python runtime...</span>
                <span className="text-[11px] text-neutral-500 tabular-nums">{Math.round(percentage)}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-neutral-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-orange-500 transition-all duration-300"
                  style={{ width: `${percentage}%` }}
                />
              </div>
            </div>
          )}

          {/* Current status message */}
          {stage !== "install-deps" && stage !== "download" && stage !== "ready" && stage !== "error" && (
            <p className="text-[11px] text-neutral-500 truncate">{message}</p>
          )}

          {/* Install logs (scrollable, collapsed by default during install) */}
          {(stage === "install-deps" || stage === "download") && logs.length > 0 && (
            <details className="group">
              <summary className="text-[11px] text-neutral-500 cursor-pointer hover:text-neutral-400 select-none">
                Show logs ({logs.length} lines)
              </summary>
              <div className="mt-1.5 max-h-28 overflow-auto rounded-lg bg-black p-3 font-mono text-[10px] text-neutral-500 leading-relaxed">
                {logs.slice(-80).map((log, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all">{log.trim()}</div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </details>
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
  progress,
  icon,
}: {
  label: string;
  status: "pending" | "loading" | "done" | "error";
  detail?: string;
  progress?: number;
  icon?: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <div className="flex h-5 w-5 items-center justify-center">
          {status === "loading" && <Loader2 className="h-4 w-4 text-orange-400 animate-spin" />}
          {status === "done" && <Check className="h-4 w-4 text-green-400" />}
          {status === "error" && <X className="h-4 w-4 text-red-400" />}
          {status === "pending" && <div className="h-2 w-2 rounded-full bg-neutral-600" />}
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          {icon && status === "loading" && <span className="text-orange-400">{icon}</span>}
          <span className={`text-xs font-medium ${status === "done" ? "text-green-400" : status === "error" ? "text-red-400" : "text-neutral-300"}`}>
            {label}
          </span>
          {detail && (
            <span className="ml-1 text-[11px] text-neutral-500 truncate">{detail}</span>
          )}
        </div>
      </div>
      {/* Inline mini progress bar for active steps */}
      {status === "loading" && progress !== undefined && progress > 0 && (
        <div className="ml-8 h-0.5 rounded-full bg-neutral-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-orange-500/60 transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}
