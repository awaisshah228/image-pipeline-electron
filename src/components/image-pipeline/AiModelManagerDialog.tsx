import { useState, useEffect, useCallback } from "react";
import {
  X,
  Download,
  Check,
  Loader2,
  AlertCircle,
  Package,
  HardDrive,
} from "lucide-react";

interface AiModelManagerDialogProps {
  open: boolean;
  onClose: () => void;
}

interface ModelStatus {
  rembg: Record<string, { downloaded: boolean; size_mb?: number }>;
  mobile_sam: { installed: boolean; downloaded: boolean; size_mb: number };
  yolo: { loaded: string[] };
}

export function AiModelManagerDialog({
  open,
  onClose,
}: AiModelManagerDialogProps) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.python.aiModelStatus();
      setStatus(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch model status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) fetchStatus();
  }, [open, fetchStatus]);

  const handleDownload = useCallback(
    async (type: string, name: string) => {
      const key = `${type}:${name}`;
      setInstalling(key);
      setError(null);
      try {
        await window.electronAPI.python.downloadAiModel(type, name);
        await fetchStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to install ${name}`);
      } finally {
        setInstalling(null);
      }
    },
    [fetchStatus]
  );

  if (!open) return null;

  const rembgModels = status?.rembg
    ? Object.entries(status.rembg).map(([name, info]) => ({
        name,
        type: "rembg" as const,
        label: name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        downloaded: info.downloaded,
        sizeMb: info.size_mb,
      }))
    : [];

  const samReady = status?.mobile_sam?.installed && status?.mobile_sam?.downloaded;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4 shrink-0">
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-orange-500" />
            <h2 className="text-sm font-semibold">AI Model Manager</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 hover:bg-accent transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-5 space-y-5">
          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading && !status ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* MobileSAM */}
              <section>
                <h3 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                  MobileSAM (Segment Anything)
                </h3>
                <div className="rounded-lg border border-border divide-y divide-border">
                  <div className="flex items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-3">
                      <HardDrive className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="text-xs font-medium">MobileSAM</div>
                        <div className="text-[11px] text-muted-foreground">
                          Package + weights (~10 MB)
                        </div>
                      </div>
                    </div>
                    {samReady ? (
                      <div className="flex items-center gap-1.5 text-xs text-green-500">
                        <Check className="h-3.5 w-3.5" />
                        Installed
                        {status?.mobile_sam?.size_mb
                          ? ` (${status.mobile_sam.size_mb} MB)`
                          : ""}
                      </div>
                    ) : (
                      <button
                        onClick={() => handleDownload("mobile_sam", "mobile_sam")}
                        disabled={installing !== null}
                        className="flex items-center gap-1.5 rounded-md bg-orange-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-600 transition-colors disabled:opacity-50"
                      >
                        {installing === "mobile_sam:mobile_sam" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        {installing === "mobile_sam:mobile_sam"
                          ? "Installing..."
                          : "Install"}
                      </button>
                    )}
                  </div>
                </div>
              </section>

              {/* Rembg Models */}
              <section>
                <h3 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                  Background Removal Models
                </h3>
                <div className="rounded-lg border border-border divide-y divide-border">
                  {rembgModels.map((m) => {
                    const key = `${m.type}:${m.name}`;
                    return (
                      <div
                        key={m.name}
                        className="flex items-center justify-between px-4 py-2.5"
                      >
                        <div className="flex items-center gap-3">
                          <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                          <div>
                            <div className="text-xs font-medium">{m.label}</div>
                            {m.downloaded && m.sizeMb !== undefined && (
                              <div className="text-[11px] text-muted-foreground">
                                {m.sizeMb} MB
                              </div>
                            )}
                          </div>
                        </div>
                        {m.downloaded ? (
                          <div className="flex items-center gap-1.5 text-xs text-green-500">
                            <Check className="h-3 w-3" />
                            Downloaded
                          </div>
                        ) : (
                          <button
                            onClick={() => handleDownload(m.type, m.name)}
                            disabled={installing !== null}
                            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-accent transition-colors disabled:opacity-50"
                          >
                            {installing === key ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Download className="h-3 w-3" />
                            )}
                            {installing === key ? "Downloading..." : "Download"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* YOLO */}
              {status?.yolo?.loaded && status.yolo.loaded.length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                    YOLO Models (Loaded)
                  </h3>
                  <div className="rounded-lg border border-border divide-y divide-border">
                    {status.yolo.loaded.map((name) => (
                      <div
                        key={name}
                        className="flex items-center gap-3 px-4 py-2.5"
                      >
                        <Check className="h-3.5 w-3.5 text-green-500" />
                        <span className="text-xs font-medium">{name}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border px-5 py-3 shrink-0">
          <button
            onClick={fetchStatus}
            disabled={loading}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {loading ? "Refreshing..." : "Refresh status"}
          </button>
        </div>
      </div>
    </div>
  );
}
