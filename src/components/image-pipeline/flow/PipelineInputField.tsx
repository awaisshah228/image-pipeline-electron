
import { memo, useCallback, useState, useRef, useEffect } from "react";
import { Position } from "@xyflow/react";
import { Info, X } from "lucide-react";
import type { PipelineInputField as InputFieldType } from "@/lib/image-pipeline/types";
import { PipelineHandle } from "./PipelineHandle";
import { encodeHandleId } from "@/lib/image-pipeline/utils";

const INPUT_CLASS =
  "nodrag w-full rounded-md border border-border bg-background px-3 py-2 text-xs transition-colors placeholder:text-muted-foreground hover:border-muted-foreground focus:border-foreground focus:outline-none focus:ring-0";

const TEXTAREA_CLASS =
  "nodrag w-full rounded-md border border-border bg-background px-3 py-2 text-xs transition-colors placeholder:text-muted-foreground hover:border-muted-foreground focus:border-foreground focus:outline-none focus:ring-0 resize-y";

interface PipelineInputFieldProps {
  nodeId: string;
  field: InputFieldType;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
  isLast: boolean;
  connected: boolean;
}

export const PipelineInputFieldComponent = memo(function PipelineInputFieldComponent({
  nodeId,
  field,
  value,
  onChange,
  isLast,
  connected,
}: PipelineInputFieldProps) {
  const hasHandle = field.input_types && field.input_types.length > 0;
  const handleId = hasHandle
    ? encodeHandleId({
        nodeId,
        inputName: field.name,
        inputTypes: field.input_types,
        fieldType: field.type,
      })
    : null;

  const handleChange = useCallback(
    (newValue: unknown) => {
      onChange(field.name, newValue);
    },
    [field.name, onChange]
  );

  return (
    <div
      className={`relative flex w-full flex-col gap-1.5 px-4 py-2.5 ${
        isLast ? "pb-3" : ""
      }`}
    >
      {hasHandle && (
        <PipelineHandle
          type="target"
          id={handleId!}
          dataTypes={field.input_types!}
          position={Position.Left}
        />
      )}

      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-medium text-foreground/80 select-none">
          {field.display_name}
          {field.required && (
            <span className="text-destructive ml-0.5">*</span>
          )}
        </label>
        {field.info && (
          <div className="group relative">
            <Info className="h-3 w-3 text-muted-foreground cursor-help" />
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:block z-50 w-52 rounded-md bg-popover px-2.5 py-1.5 text-[11px] text-popover-foreground shadow-lg border border-border">
              {field.info}
            </div>
          </div>
        )}
      </div>

      {!connected && (
        <FieldWidget field={field} value={value} onChange={handleChange} />
      )}
      {connected && (
        <div className="flex items-center gap-1.5 py-1">
          <div className="h-1.5 w-1.5 rounded-full bg-green-500" />
          <span className="text-[11px] text-muted-foreground">Connected</span>
        </div>
      )}
    </div>
  );
});

function FieldWidget({
  field,
  value,
  onChange,
}: {
  field: InputFieldType;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  switch (field.type) {
    case "str":
      if (field.multiline) {
        return (
          <textarea
            className={`${TEXTAREA_CLASS} min-h-[60px]`}
            value={(value as string) ?? ""}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
            rows={3}
          />
        );
      }
      return (
        <input
          type="text"
          className={INPUT_CLASS}
          value={(value as string) ?? ""}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case "int":
      return (
        <input
          type="number"
          className={`${INPUT_CLASS} font-mono`}
          value={(value as number) ?? ""}
          step={1}
          onChange={(e) => onChange(parseInt(e.target.value) || 0)}
        />
      );

    case "float":
      return (
        <input
          type="number"
          className={`${INPUT_CLASS} font-mono`}
          value={(value as number) ?? ""}
          step={0.01}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        />
      );

    case "bool":
      return (
        <label className="nodrag flex items-center gap-2.5 cursor-pointer py-0.5">
          <button
            type="button"
            role="switch"
            aria-checked={(value as boolean) ?? false}
            onClick={() => onChange(!(value as boolean))}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
              value ? "bg-orange-500" : "bg-border"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${
                value ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
          <span className="text-xs text-muted-foreground">
            {value ? "Yes" : "No"}
          </span>
        </label>
      );

    case "dropdown":
      return (
        <select
          className={`${INPUT_CLASS} cursor-pointer`}
          value={(value as string) ?? field.options?.[0] ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );

    case "password":
      return (
        <input
          type="password"
          autoComplete="off"
          className={INPUT_CLASS}
          value={(value as string) ?? ""}
          placeholder={field.placeholder ?? "Enter secret..."}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case "file": {
      const acceptAttr = field.file_types?.join(",");
      const isImageFile = field.file_types?.some((t) =>
        [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".gif"].includes(t)
      );
      const isVideoFile = field.file_types?.some((t) =>
        [".mp4", ".webm", ".ogg", ".mov", ".avi"].includes(t)
      );
      // value can be "filename::dataurl" or just "filename"
      const valStr = (value as string) ?? "";
      const displayName = valStr.includes("::")
        ? valStr.split("::")[0]
        : valStr;

      return (
        <div className="flex flex-col gap-1.5">
          <label className="nodrag flex items-center gap-2 rounded-md border border-dashed px-3 py-2.5 text-xs cursor-pointer transition-colors"
            style={{
              borderColor: "var(--border)",
              backgroundColor: "color-mix(in srgb, var(--muted) 30%, transparent)",
            }}
          >
            <svg
              className="h-3.5 w-3.5 shrink-0"
              style={{ color: "var(--muted-foreground)" }}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            <span className="text-muted-foreground truncate">
              {displayName || `Choose file...`}
            </span>
            <input
              type="file"
              className="hidden"
              accept={acceptAttr}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file && (isImageFile || isVideoFile)) {
                  const reader = new FileReader();
                  reader.onload = () => {
                    onChange(`${file.name}::${reader.result as string}`);
                  };
                  reader.readAsDataURL(file);
                } else if (file) {
                  onChange(file.name);
                }
                e.target.value = "";
              }}
            />
          </label>
        </div>
      );
    }

    case "model_file": {
      const modelVal = (value as string) ?? "";
      // If value starts with "blob:" it's an uploaded file — show the filename stored after "::"
      const isUploaded = modelVal.startsWith("blob:");
      const modelDisplay = isUploaded
        ? modelVal.split("::")[1] ?? "Uploaded model"
        : modelVal;
      const acceptModel = field.file_types?.join(",") ?? ".onnx";

      return (
        <div className="flex flex-col gap-1.5">
          <input
            type="text"
            className={INPUT_CLASS}
            value={isUploaded ? "" : modelVal}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
          <label
            className="nodrag flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs cursor-pointer transition-colors"
            style={{
              borderColor: isUploaded ? "hsl(24 95% 53% / 0.5)" : "var(--border)",
              backgroundColor: isUploaded
                ? "hsl(24 95% 53% / 0.08)"
                : "color-mix(in srgb, var(--muted) 30%, transparent)",
            }}
          >
            <svg
              className="h-3.5 w-3.5 shrink-0"
              style={{ color: isUploaded ? "hsl(24 95% 53%)" : "var(--muted-foreground)" }}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            <span className="text-muted-foreground truncate text-[11px]">
              {isUploaded ? modelDisplay : "Upload .onnx model file"}
            </span>
            <input
              type="file"
              className="hidden"
              accept={acceptModel}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  const blobUrl = URL.createObjectURL(file);
                  onChange(`${blobUrl}::${file.name}`);
                }
                e.target.value = "";
              }}
            />
          </label>
          {isUploaded && (
            <button
              type="button"
              className="text-[10px] text-muted-foreground hover:text-foreground self-end"
              onClick={() => {
                const blobUrl = modelVal.split("::")[0];
                if (blobUrl.startsWith("blob:")) URL.revokeObjectURL(blobUrl);
                onChange(field.value ?? "");
              }}
            >
              Reset to default
            </button>
          )}
        </div>
      );
    }

    case "tags":
      return (
        <TagsWidget
          options={field.options ?? []}
          value={(value as string) ?? ""}
          placeholder={field.placeholder}
          onChange={onChange}
        />
      );

    default:
      return (
        <input
          type="text"
          className={INPUT_CLASS}
          value={(value as string) ?? ""}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function TagsWidget({
  options,
  value,
  placeholder,
  onChange,
}: {
  options: string[];
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const tags = value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));

  const filtered = options.filter(
    (opt) =>
      !tagSet.has(opt.toLowerCase()) &&
      opt.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const addTag = (tag: string) => {
    const newTags = [...tags, tag];
    onChange(newTags.join(","));
    setQuery("");
    inputRef.current?.focus();
  };

  const removeTag = (tag: string) => {
    const newTags = tags.filter((t) => t.toLowerCase() !== tag.toLowerCase());
    onChange(newTags.join(","));
  };

  return (
    <div ref={containerRef} className="nodrag relative">
      <div
        className="flex flex-wrap gap-1 rounded-md border border-border bg-background px-2 py-1.5 min-h-[32px] cursor-text"
        onClick={() => { inputRef.current?.focus(); setOpen(true); }}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
            style={{ backgroundColor: "hsl(24 95% 53% / 0.15)", color: "hsl(24 95% 53%)" }}
          >
            {tag}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeTag(tag); }}
              className="ml-0.5 rounded hover:bg-orange-500/20"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          className="flex-1 min-w-[60px] bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          value={query}
          placeholder={tags.length === 0 ? (placeholder ?? "Type to search...") : ""}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !query && tags.length > 0) {
              removeTag(tags[tags.length - 1]);
            }
            if (e.key === "Enter" && filtered.length > 0) {
              e.preventDefault();
              addTag(filtered[0]);
            }
            if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
      </div>
      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 max-h-40 w-full overflow-auto rounded-md border border-border bg-popover shadow-lg">
          {filtered.slice(0, 20).map((opt) => (
            <button
              key={opt}
              type="button"
              className="w-full px-3 py-1.5 text-left text-xs hover:bg-accent transition-colors"
              onMouseDown={(e) => { e.preventDefault(); addTag(opt); }}
            >
              {opt}
            </button>
          ))}
          {filtered.length > 20 && (
            <div className="px-3 py-1.5 text-[10px] text-muted-foreground">
              +{filtered.length - 20} more...
            </div>
          )}
        </div>
      )}
      {tags.length > 0 && (
        <div className="mt-1 text-[10px] text-muted-foreground">
          {tags.length} class{tags.length !== 1 ? "es" : ""} selected
        </div>
      )}
    </div>
  );
}
