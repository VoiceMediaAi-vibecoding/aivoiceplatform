"use client";

import { useState } from "react";
import { Loader2, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { adminFetch } from "@/lib/admin-auth";
import ParameterEditor, {
  paramsToSchema,
  schemaToParams,
  type ParamDef,
} from "./ParameterEditor";
import ToolTester from "./ToolTester";

export interface GlobalTool {
  id: string;
  name: string;
  key: string;
  description: string | null;
  tool_type: string;
  config: { url?: string; method?: string; parameters?: Record<string, unknown> };
  created_at: string;
  usage_count?: number;
}

const inputCls = "bg-white/5 border-white/10 text-white placeholder:text-gray-600 focus-visible:border-brand-pink/60 focus-visible:ring-0";

export default function ToolForm({
  initial,
  onCancel,
  onSaved,
  onError,
}: {
  initial?: GlobalTool;
  onCancel: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [key, setKey] = useState(initial?.key ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [url, setUrl] = useState(initial?.config?.url ?? "");
  const [method, setMethod] = useState((initial?.config?.method ?? "POST").toUpperCase());
  const [params, setParams] = useState<ParamDef[]>(
    initial?.config?.parameters
      ? schemaToParams(initial.config.parameters)
      : [
          { key: "example_field", type: "string", required: true, description: "Sample field" },
        ]
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const submit = async () => {
    if (!name.trim() || !key.trim() || !url.trim()) {
      onError("❌ Nombre, key y URL son requeridos");
      return;
    }
    const trimmedUrl = url.trim();
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(trimmedUrl);
    if (!trimmedUrl.startsWith("https://") && !isLocalhost) {
      onError("❌ La URL debe empezar con https:// (o http://localhost para dev)");
      return;
    }
    setSaving(true);
    const payload = {
      name: name.trim(),
      key: key.trim(),
      description: description.trim() || null,
      config: {
        url: trimmedUrl,
        method,
        parameters: paramsToSchema(params),
      },
    };
    try {
      if (initial) {
        await adminFetch(`/admin/tools/${initial.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        await adminFetch("/admin/tools", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      onSaved();
    } catch (e: unknown) {
      onError(`❌ ${e instanceof Error ? e.message : "Error al guardar"}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="glass-card rounded-2xl p-5 mb-4 border border-brand-pink/30 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs text-gray-400 mb-1.5 block">Nombre</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Consultar inventario"
            className={inputCls}
          />
        </div>
        <div>
          <Label className="text-xs text-gray-400 mb-1.5 block">
            Key <span className="text-gray-600">(snake_case, sin espacios)</span>
          </Label>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="consultar_inventario"
            className={`${inputCls} font-mono text-xs`}
            disabled={!!initial}
          />
        </div>
      </div>

      <div>
        <Label className="text-xs text-gray-400 mb-1.5 block">Descripción (para el modelo)</Label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Consulta si un producto está disponible por SKU"
          className={inputCls}
        />
      </div>

      <div className="grid grid-cols-[1fr_120px] gap-3">
        <div>
          <Label className="text-xs text-gray-400 mb-1.5 block">URL del webhook</Label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.tuempresa.com/inventario"
            className={`${inputCls} font-mono text-xs`}
          />
        </div>
        <div>
          <Label className="text-xs text-gray-400 mb-1.5 block">Método</Label>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className={`${inputCls} w-full px-3 py-2 rounded-md text-sm`}
          >
            <option value="POST">POST</option>
            <option value="GET">GET</option>
            <option value="PUT">PUT</option>
            <option value="DELETE">DELETE</option>
            <option value="PATCH">PATCH</option>
          </select>
        </div>
      </div>

      <ParameterEditor
        initialParams={params}
        onChange={setParams}
        initialJson={
          initial?.config?.parameters
            ? JSON.stringify(initial.config.parameters, null, 2)
            : undefined
        }
      />

      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          onClick={submit}
          disabled={saving}
          className="bg-brand-pink hover:bg-brand-purple text-white"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
          {initial ? "Guardar cambios" : "Crear herramienta"}
        </Button>
        {initial && (
          <Button
            type="button"
            onClick={() => setTesting(true)}
            variant="ghost"
            className="text-cyan-300 hover:text-cyan-200 hover:bg-cyan-500/10"
          >
            <FlaskConical className="w-3.5 h-3.5 mr-1.5" />
            Probar webhook
          </Button>
        )}
        <Button
          onClick={onCancel}
          variant="ghost"
          className="text-gray-300 hover:text-white hover:bg-white/10"
        >
          Cancelar
        </Button>
      </div>

      {testing && initial && (
        <ToolTester
          toolId={initial.id}
          toolName={initial.name}
          defaultUrl={url}
          defaultMethod={method}
          params={params}
          onClose={() => setTesting(false)}
        />
      )}
    </div>
  );
}