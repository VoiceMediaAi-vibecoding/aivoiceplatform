"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Eye, Code2, AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ParamType = "string" | "number" | "integer" | "boolean" | "object" | "array";
export type ParamFormat = "" | "email" | "url" | "date" | "date-time" | "uuid";
export type ArrayItemType = "string" | "number" | "integer" | "boolean";

export interface ParamDef {
  key: string;
  type: ParamType;
  description?: string;
  required: boolean;
  // Avanzados (solo tipos simples)
  enum?: string[];
  format?: ParamFormat;
  default?: string | number | boolean;
  // Para type="array"
  items?: { type: ArrayItemType };
  // Para type="object" (1 nivel de anidamiento)
  properties?: ParamDef[];
}

const SIMPLE_TYPES: ParamType[] = ["string", "number", "integer", "boolean"];
const FORMATS: ParamFormat[] = ["", "email", "url", "date", "date-time", "uuid"];
const ARRAY_ITEM_TYPES: ArrayItemType[] = ["string", "number", "integer", "boolean"];

const inputCls = "w-full bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-xs text-white placeholder:text-gray-600 focus:outline-none focus:border-brand-pink/60";
const labelCls = "block text-[10px] text-gray-400 mb-1";
const selectCls = inputCls + " appearance-none cursor-pointer";

function schemaToParams(schema: any): ParamDef[] {
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  return Object.entries(props).map(([key, prop]: [string, any]) => ({
    key,
    type: prop.type || "string",
    description: prop.description,
    required: required.has(key),
    enum: Array.isArray(prop.enum) ? prop.enum : undefined,
    format: prop.format || "",
    default: prop.default,
    items: prop.items ? { type: prop.items.type || "string" } : undefined,
    properties: prop.properties
      ? schemaToParams(prop).map((p) => ({ ...p, required: required.has(p.key) }))
      : undefined,
  }));
}

function paramsToSchema(params: ParamDef[]): any {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  for (const p of params) {
    if (!p.key) continue;
    const prop: any = { type: p.type };
    if (p.description) prop.description = p.description;
    if (p.type === "string") {
      if (p.enum && p.enum.length > 0) prop.enum = p.enum;
      if (p.format) prop.format = p.format;
      if (p.default !== undefined && p.default !== "") prop.default = p.default;
    } else if (p.type === "number" || p.type === "integer") {
      if (p.default !== undefined && p.default !== "") prop.default = p.default;
    } else if (p.type === "boolean") {
      if (p.default !== undefined && p.default !== "") prop.default = p.default;
    } else if (p.type === "array") {
      prop.items = { type: p.items?.type || "string" };
    } else if (p.type === "object") {
      const nested = paramsToSchema(p.properties || []);
      prop.properties = nested.properties;
      if (nested.required.length) prop.required = nested.required;
    }
    properties[p.key] = prop;
    if (p.required) required.push(p.key);
  }
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
  };
}

function sampleValue(p: ParamDef, idx: number): unknown {
  if (p.default !== undefined && p.default !== "") return p.default;
  if (p.enum && p.enum.length > 0) return p.enum[0];
  switch (p.type) {
    case "string":
      if (p.format === "email") return `user${idx + 1}@example.com`;
      if (p.format === "url") return "https://example.com";
      return `sample_${p.key}`;
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return sampleBody(p.properties || []);
    default:
      return null;
  }
}

export function sampleBody(params: ParamDef[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  params.forEach((p, i) => {
    if (p.key) body[p.key] = sampleValue(p, i);
  });
  return body;
}

function ParamCard({
  param,
  onChange,
  onRemove,
  level = 0,
}: {
  param: ParamDef;
  onChange: (next: ParamDef) => void;
  onRemove: () => void;
  level?: number;
}) {
  return (
    <div className={`rounded-lg border border-white/10 bg-black/20 ${level > 0 ? "ml-6 mt-2" : ""}`}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-gray-500 font-mono">
            {param.type}
          </span>
          <span className="text-xs font-mono text-gray-100">{param.key || "(sin key)"}</span>
          {param.required && (
            <span className="text-[10px] text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded">required</span>
          )}
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="text-gray-500 hover:text-rose-400 transition-colors p-1"
          title="Eliminar propiedad"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="p-3 grid grid-cols-2 gap-3">
        <div>
          <Label className={labelCls}>Key</Label>
          <Input
            value={param.key}
            onChange={(e) => onChange({ ...param, key: e.target.value })}
            placeholder="param_name"
            className={`${inputCls} font-mono`}
          />
        </div>
        <div>
          <Label className={labelCls}>Tipo</Label>
          <select
            value={param.type}
            onChange={(e) => {
              const next = { ...param, type: e.target.value as ParamType };
              if (e.target.value !== "object") delete next.properties;
              if (e.target.value !== "array") delete next.items;
              if (e.target.value === "boolean" || e.target.value === "array" || e.target.value === "object") {
                delete next.enum;
                delete next.format;
              }
              if (e.target.value === "number" || e.target.value === "integer" || e.target.value === "boolean") {
                delete next.format;
              }
              onChange(next);
            }}
            className={selectCls}
          >
            {(["string", "number", "integer", "boolean", "array", "object"] as ParamType[]).map(
              (t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              )
            )}
          </select>
        </div>
        <div className="col-span-2">
          <Label className={labelCls}>Descripción</Label>
          <Input
            value={param.description ?? ""}
            onChange={(e) => onChange({ ...param, description: e.target.value || undefined })}
            placeholder="Descripción para el modelo"
            className={inputCls}
          />
        </div>
        <div className="col-span-2 flex items-center gap-2">
          <input
            id={`req-${param.key}-${level}`}
            type="checkbox"
            checked={param.required}
            onChange={(e) => onChange({ ...param, required: e.target.checked })}
            className="rounded"
          />
          <label htmlFor={`req-${param.key}-${level}`} className="text-xs text-gray-300">
            Required (el LLM debe pedirlo antes de llamar el tool)
          </label>
        </div>

        {/* Advanced (simple types only) */}
        {param.type === "string" && (
          <>
            <div>
              <Label className={labelCls}>Format</Label>
              <select
                value={param.format || ""}
                onChange={(e) => onChange({ ...param, format: e.target.value as ParamFormat })}
                className={selectCls}
              >
                {FORMATS.map((f) => (
                  <option key={f || "none"} value={f}>
                    {f || "(ninguno)"}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-1">
              <Label className={labelCls}>Default</Label>
              <Input
                value={(param.default as string) ?? ""}
                onChange={(e) => onChange({ ...param, default: e.target.value || undefined })}
                placeholder="(opcional)"
                className={inputCls}
              />
            </div>
            <div className="col-span-2">
              <Label className={labelCls}>Enum (opcional, separados por coma)</Label>
              <Input
                value={(param.enum ?? []).join(", ")}
                onChange={(e) => {
                  const vals = e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  onChange({ ...param, enum: vals.length ? vals : undefined });
                }}
                placeholder="opcion1, opcion2, opcion3"
                className={inputCls}
              />
              <p className="text-[10px] text-gray-500 mt-1">
                Si se define, el LLM solo puede enviar uno de estos valores.
              </p>
            </div>
          </>
        )}

        {(param.type === "number" || param.type === "integer") && (
          <div>
            <Label className={labelCls}>Default</Label>
            <Input
              type="number"
              value={(param.default as number) ?? ""}
              onChange={(e) =>
                onChange({
                  ...param,
                  default: e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              placeholder="(opcional)"
              className={inputCls}
            />
          </div>
        )}

        {param.type === "boolean" && (
          <div>
            <Label className={labelCls}>Default</Label>
            <select
              value={param.default === undefined ? "" : String(param.default)}
              onChange={(e) =>
                onChange({
                  ...param,
                  default: e.target.value === "" ? undefined : e.target.value === "true",
                })
              }
              className={selectCls}
            >
              <option value="">(ninguno)</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
        )}

        {/* Array items */}
        {param.type === "array" && (
          <div>
            <Label className={labelCls}>Items type</Label>
            <select
              value={param.items?.type || "string"}
              onChange={(e) =>
                onChange({ ...param, items: { type: e.target.value as ArrayItemType } })
              }
              className={selectCls}
            >
              {ARRAY_ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Nested object properties (1 level deep) */}
      {param.type === "object" && (
        <div className="px-3 pb-3">
          <div className="flex items-center justify-between mb-2">
            <Label className={labelCls}>Sub-properties</Label>
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...param,
                  properties: [
                    ...(param.properties || []),
                    { key: "", type: "string" as ParamType, required: false },
                  ],
                })
              }
              className="text-[10px] px-2 py-1 bg-white/5 hover:bg-white/10 rounded text-gray-300 flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Agregar sub-propiedad
            </button>
          </div>
          {(param.properties || []).length === 0 && (
            <p className="text-[10px] text-gray-500 italic">
              Sin sub-propiedades. El tool recibirá un objeto vacío.
            </p>
          )}
          {(param.properties || []).map((sub, i) => (
            <ParamCard
              key={i}
              param={sub}
              level={1}
              onChange={(next) => {
                const arr = [...(param.properties || [])];
                arr[i] = next;
                onChange({ ...param, properties: arr });
              }}
              onRemove={() => {
                const arr = [...(param.properties || [])];
                arr.splice(i, 1);
                onChange({ ...param, properties: arr });
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ParameterEditor({
  initialParams,
  onChange,
  initialJson,
}: {
  initialParams: ParamDef[];
  onChange: (params: ParamDef[]) => void;
  initialJson?: string;
}) {
  const [mode, setMode] = useState<"visual" | "json">("visual");
  const [params, setParams] = useState<ParamDef[]>(initialParams);
  const [jsonText, setJsonText] = useState<string>(
    initialJson ?? JSON.stringify(paramsToSchema(initialParams), null, 2)
  );
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    onChange(params);
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleModeSwitch = (next: "visual" | "json") => {
    if (next === mode) return;
    if (next === "json") {
      // Visual → JSON: just serialize current state
      const generated = JSON.stringify(paramsToSchema(params), null, 2);
      setJsonText(generated);
      setJsonError(null);
      setMode("json");
    } else {
      // JSON → Visual: try to parse; if fails, stay in JSON mode
      try {
        const parsed = JSON.parse(jsonText);
        const newParams = schemaToParams(parsed);
        setParams(newParams);
        setJsonError(null);
        setMode("visual");
      } catch (e: unknown) {
        setJsonError(e instanceof Error ? e.message : "JSON inválido");
      }
    }
  };

  const handleJsonEdit = (v: string) => {
    setJsonText(v);
    try {
      const parsed = JSON.parse(v);
      const newParams = schemaToParams(parsed);
      setParams(newParams);
      setJsonError(null);
    } catch {
      // Don't update params yet — user is still typing
      setJsonError("JSON inválido (no se aplica al modo visual hasta arreglarlo)");
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <Label className="text-xs text-gray-400">Parámetros (JSON Schema que verá el LLM)</Label>
        <div className="flex bg-white/5 rounded-lg p-0.5 text-[10px]">
          <button
            type="button"
            onClick={() => handleModeSwitch("visual")}
            className={`px-2 py-1 rounded transition-colors flex items-center gap-1 ${
              mode === "visual" ? "bg-brand-pink text-white" : "text-gray-400 hover:text-white"
            }`}
          >
            <Eye className="w-3 h-3" /> Visual
          </button>
          <button
            type="button"
            onClick={() => handleModeSwitch("json")}
            className={`px-2 py-1 rounded transition-colors flex items-center gap-1 ${
              mode === "json" ? "bg-brand-pink text-white" : "text-gray-400 hover:text-white"
            }`}
          >
            <Code2 className="w-3 h-3" /> JSON
          </button>
        </div>
      </div>

      {mode === "visual" ? (
        <div className="space-y-2">
          {params.length === 0 && (
            <div className="text-center py-6 text-xs text-gray-500 border border-dashed border-white/10 rounded-lg">
              Aún no hay parámetros. Agrega la primera para que el LLM sepa qué capturar.
            </div>
          )}
          {params.map((p, i) => (
            <ParamCard
              key={i}
              param={p}
              onChange={(next) => {
                const arr = [...params];
                arr[i] = next;
                setParams(arr);
              }}
              onRemove={() => {
                const arr = [...params];
                arr.splice(i, 1);
                setParams(arr);
              }}
            />
          ))}
          <button
            type="button"
            onClick={() =>
              setParams([...params, { key: "", type: "string" as ParamType, required: false }])
            }
            className="w-full py-2 bg-white/5 hover:bg-white/10 rounded-lg text-xs text-gray-300 flex items-center justify-center gap-1.5 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Agregar propiedad
          </button>
          <details className="mt-3">
            <summary className="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300">
              Ver JSON Schema generado
            </summary>
            <pre className="mt-2 p-2 bg-black/40 rounded text-[10px] font-mono text-gray-400 overflow-x-auto max-h-48">
              {JSON.stringify(paramsToSchema(params), null, 2)}
            </pre>
          </details>
        </div>
      ) : (
        <div>
          <textarea
            value={jsonText}
            onChange={(e) => handleJsonEdit(e.target.value)}
            rows={10}
            spellCheck={false}
            className={`${inputCls} font-mono resize-y`}
          />
          {jsonError && (
            <div className="mt-1 flex items-center gap-1 text-[10px] text-rose-300">
              <AlertTriangle className="w-3 h-3" />
              {jsonError}
            </div>
          )}
          <p className="text-[10px] text-gray-500 mt-1">
            Edita el schema manualmente. Soporta todas las features (enum, format, default, etc.).
          </p>
        </div>
      )}
    </div>
  );
}

export { paramsToSchema, schemaToParams };