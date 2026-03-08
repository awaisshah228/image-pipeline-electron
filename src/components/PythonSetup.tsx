import { useState, useEffect, useCallback } from "react";
import {
  Terminal,
  Check,
  X,
  Loader2,
  Download,
  Play,
  Cpu,
  AlertTriangle,
} from "lucide-react";

type SetupStep = "detecting" | "detected" | "not-found" | "checking-deps" | "installing" | "ready" | "starting" | "running" | "error";

interface Props {
  onReady: () => void;
}

export function PythonSetup({ onReady }: Props) {
  const [step, setStep] = useState<SetupStep>("detecting");
  const [pythonInfo, setPythonInfo] = useState<PythonInfo | null>(null);
  const [missingDeps, setMissingDeps] = useState<string[]>([]);
  const [installLogs, setInstallLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [backendStatus, setBackendStatus] = useState<{ url?: string; gpu?: boolean } | null>(null);

  const api = window.electronAPI?.python;

  // Step 1: Detect Python
  useEffect(() => {
    if (!api) {
      setStep("not-found");
      setError("Electron API not available");
      return;
    }

    api.detect().then((info) => {
      if (info) {
        setPythonInfo(info);
        setStep("checking-deps");
      } else {
        setStep("not-found");
      }
    }).catch((err) => {
      setStep("error");
      setError(String(err));
    });
  }, []);

  // Step 2: Check dependencies
  useEffect(() => {
    if (step !== "checking-deps" || !api) return;

    api.checkDeps().then(({ missing }) => {
      if (missing.length === 0) {
        setStep("detected");
      } else {
        setMissingDeps(missing);
        setStep("detected");
      }
    });
  }, [step]);

  // Listen for install progress
  useEffect(() => {
    if (!api) return;
    const cleanup = api.onInstallProgress((output) => {
      setInstallLogs((prev) => [...prev.slice(-100), output]);
    });
    return cleanup;
  }, []);

  const handleInstallDeps = useCallback(async () => {
    if (!api) return;
    setStep("installing");
    setInstallLogs([]);
    const success = await api.installDeps();
    if (success) {
      setMissingDeps([]);
      setStep("detected");
    } else {
      setStep("error");
      setError("Failed to install dependencies. Check the logs above.");
    }
  }, [api]);

  const handleStart = useCallback(async () => {
    if (!api) return;
    setStep("starting");
    try {
      const result = await api.start();
      // Check health
      const status = await api.status();
      setBackendStatus({ url: result.url, gpu: status.python?.hasCuda });
      setStep("running");

      // Auto-proceed after 1 second
      setTimeout(onReady, 1000);
    } catch (err) {
      setStep("error");
      setError(String(err));
    }
  }, [api, onReady]);

  const handleSkip = useCallback(() => {
    onReady();
  }, [onReady]);

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
            <p className="text-xs text-neutral-400">GPU-accelerated inference with PyTorch & Ultralytics</p>
          </div>
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-4">
          {/* Step indicator */}
          <div className="space-y-2">
            <StepRow
              label="Detect Python"
              status={step === "detecting" ? "loading" : pythonInfo ? "done" : step === "not-found" ? "error" : "pending"}
              detail={pythonInfo ? `Python ${pythonInfo.version} — ${pythonInfo.hasTorch ? (pythonInfo.hasCuda ? "CUDA GPU" : "CPU") : "no PyTorch"}` : undefined}
            />
            <StepRow
              label="Check dependencies"
              status={step === "checking-deps" ? "loading" : missingDeps.length === 0 && pythonInfo ? "done" : missingDeps.length > 0 ? "warning" : "pending"}
              detail={missingDeps.length > 0 ? `Missing: ${missingDeps.join(", ")}` : undefined}
            />
            <StepRow
              label="Start backend server"
              status={step === "starting" ? "loading" : step === "running" ? "done" : "pending"}
              detail={backendStatus?.url ? `Running at ${backendStatus.url}` : undefined}
            />
          </div>

          {/* Install logs */}
          {step === "installing" && installLogs.length > 0 && (
            <div className="max-h-32 overflow-auto rounded-lg bg-black p-3 font-mono text-[11px] text-neutral-400">
              {installLogs.map((log, i) => (
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

          {/* Not found message */}
          {step === "not-found" && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3">
              <p className="text-xs text-amber-300">
                Python 3.8+ not found. Install Python from{" "}
                <span className="font-medium">python.org</span> or via conda/homebrew,
                then restart the app.
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

          <div className="flex items-center gap-2">
            {missingDeps.length > 0 && step === "detected" && (
              <button
                onClick={handleInstallDeps}
                className="flex items-center gap-1.5 rounded-md bg-orange-500/10 border border-orange-500/30 px-3 py-1.5 text-xs font-medium text-orange-400 hover:bg-orange-500/20 transition-colors"
              >
                <Download className="h-3.5 w-3.5" />
                Install Dependencies
              </button>
            )}

            {pythonInfo && missingDeps.length === 0 && step !== "running" && step !== "starting" && (
              <button
                onClick={handleStart}
                className="flex items-center gap-1.5 rounded-md bg-green-500/10 border border-green-500/30 px-3 py-1.5 text-xs font-medium text-green-400 hover:bg-green-500/20 transition-colors"
              >
                <Play className="h-3.5 w-3.5" />
                Start Backend
              </button>
            )}

            {step === "running" && (
              <div className="flex items-center gap-1.5 text-xs text-green-400">
                <Cpu className="h-3.5 w-3.5" />
                Ready
              </div>
            )}
          </div>
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
  status: "pending" | "loading" | "done" | "error" | "warning";
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-5 w-5 items-center justify-center">
        {status === "loading" && <Loader2 className="h-4 w-4 text-orange-400 animate-spin" />}
        {status === "done" && <Check className="h-4 w-4 text-green-400" />}
        {status === "error" && <X className="h-4 w-4 text-red-400" />}
        {status === "warning" && <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />}
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
