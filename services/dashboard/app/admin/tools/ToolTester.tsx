"use client";

import { useEffect, useState } from "react";
import { Loader2, Play, Plus, Trash2, X, CheckCircle2, AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import { adminFetch } from "@/lib/admin-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sampleBody, type ParamDef } from "./ParameterEditor";

interface ToolTesterProps {
  toolId: string;
  toolName: string;
  defaultUrl?: string;
  defaultMethod?: string;
  /** Optional pre-existing schema so we can pre-fill the sample body */
  params?: ParamDef[];
  onClose: () => void;
}

interface TestResult {
  ok: boolean;
  status: number;
  is_success: boolean;
  latency_ms: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  error?: string;
}

const inputCls = "w-full bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-xs text-white placeholder:text-gray-600 focus:outline-none focus:border-brand-pink/60";
const labelCls = "block text-[10px] text-gray-400 mb-1";

export default function ToolTester({
  toolId,
  toolName,
  defaultUrl = "",
  defaultMethod = "POST",
  params = [],
  onClose,
}: ToolTesterProps) {
  const [url, setUrl] = useState(defaultUrl);
  const [method, setMethod] = useState(defaultMethod.toUpperCase());
  const [headers, setHeaders] = useState<{ k: string; v: string }[]>([
    { k: "Content-Type", v: "application/json" },
  ]);
  const [bodyText, setBodyText] = useState<string>(
    JSON.stringify(sampleBody(params), null, 2)
  );
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [showHeaders, setShowHeaders] = useState(false);

  useEffect(() => {
    if (!bodyText || bodyText === "{\n\n}" || bodyText === "{}") {
      setBodyText(JSON.stringify(sampleBody(params), null, 2));
    }
  }, [params]);

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      let bodyObj: Record<string, unknown> = {};
      if (bodyText.trim()) {
        try {
          bodyObj = JSON.parse(bodyText);
        } catch {
          setResult({
            ok: false,
            status: 0,
            is_success: false,
            latency_ms: 0,
            headers: {},
            body: "",
            truncated: false,
            error: "Body inválido: no es JSON válido",
          });
          setTesting(false);
          return;
        }
      }
      const headersObj = Object.fromEntries(
        headers.filter((h) => h.k.trim()).map((h) => [h.k.trim(), h.v])
      );
      const payload: Record<string, unknown> = {
        method,
        headers: headersObj,
        body: bodyObj,
      };
      if (url !== defaultUrl) payload.url = url;

      const r = await adminFetch<TestResult>(
        `/admin/tools/${toolId}/test`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        }
      );
      setResult(r);
    } catch (e: unknown) {
      setResult({
        ok: false,
        status: 0,
        is_success: false,
        latency_ms: 0,
        headers: {},
        body: "",
        truncated: false,
        error: e instanceof Error ? e.message : "Error desconocido",
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="glass-card rounded-2xl p-5 w-[700px] max-w-[94vw] max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-white flex items-center gap-2">
            <Play className="w-4 h-4 text-brand-pink" />
            Probar webhook: <code className="text-pink-300 text-xs">{toolName}</code>
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_120px] gap-2">
            <div>
              <Label className={labelCls}>URL</Label>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://api.tuempresa.com/webhook"
                className={`${inputCls} font-mono`}
              />
              {url !== defaultUrl && (
                <p className="text-[10px] text-amber-400 mt-1">
                  ⚠ URL override (no se usa la guardada en el tool)
                </p>
              )}
            </div>
            <div>
              <Label className={labelCls}>Método</Label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className={inputCls + " appearance-none cursor-pointer"}
              >
                <option>POST</option>
                <option>GET</option>
                <option>PUT</option>
                <option>PATCH</option>
                <option>DELETE</option>
              </select>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <Label className={labelCls}>Headers</Label>
              <button
                type="button"
                onClick={() => setHeaders([...headers, { k: "", v: "" }])}
                className="text-[10px] px-2 py-0.5 bg-white/5 hover:bg-white/10 rounded text-gray-300 flex items-center gap-1"
              >
                <Plus className="w-3 h-3" /> Header
              </button>
            </div>
            <div className="space-y-1">
              {headers.map((h, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    value={h.k}
                    onChange={(e) => {
                      const arr = [...headers];
                      arr[i] = { k: e.target.value, v: arr[i].v };
                      setHeaders(arr);
                    }}
                    placeholder="Header name"
                    className={`${inputCls} font-mono flex-1`}
                  />
                  <Input
                    value={h.v}
                    onChange={(e) => {
                      const arr = [...headers];
                      arr[i] = { k: arr[i].k, v: e.target.value };
                      setHeaders(arr);
                    }}
                    placeholder="Value"
                    className={`${inputCls} flex-1`}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const arr = [...headers];
                      arr.splice(i, 1);
                      setHeaders(arr);
                    }}
                    className="text-gray-500 hover:text-rose-400 p-1"
                    title="Eliminar header"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {(method === "POST" || method === "PUT" || method === "PATCH") && (
            <div>
              <Label className={labelCls}>Body (JSON)</Label>
              <textarea
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                rows={8}
                spellCheck={false}
                className={`${inputCls} font-mono resize-y`}
              />
              {params.length > 0 && (
                <p className="text-[10px] text-gray-500 mt-1">
                  Auto-generado desde el schema del tool. Edita los valores antes de enviar.
                </p>
              )}
            </div>
          )}

          <Button
            onClick={runTest}
            disabled={testing || !url.trim()}
            className="bg-brand-pink hover:bg-brand-purple text-white w-full"
          >
            {testing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Enviando...
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                Enviar prueba
              </>
            )}
          </Button>
        </div>

        {result && (
          <div
            className={`mt-4 p-3 rounded-lg border ${
              result.error
                ? "bg-rose-500/10 border-rose-400/30"
                : result.is_success
                ? "bg-emerald-500/10 border-emerald-400/30"
                : "bg-amber-500/10 border-amber-400/30"
            }`}
          >
            {result.error ? (
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-rose-300 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-rose-300">❌ Error</p>
                  <p className="text-xs text-rose-200/80 mt-1 font-mono break-words">{result.error}</p>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 text-sm">
                  {result.is_success ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-300 shrink-0" />
                  ) : (
                    <AlertCircle className="w-5 h-5 text-amber-300 shrink-0" />
                  )}
                  <span className="font-mono font-medium">
                    {result.status || "—"}
                  </span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-300">{result.latency_ms}ms</span>
                </div>
                {Object.keys(result.headers).length > 0 && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setShowHeaders(!showHeaders)}
                      className="text-[10px] text-gray-400 hover:text-gray-200 flex items-center gap-1"
                    >
                      {showHeaders ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      Headers ({Object.keys(result.headers).length})
                    </button>
                    {showHeaders && (
                      <pre className="mt-1 text-[10px] font-mono text-gray-300 bg-black/30 rounded p-2 overflow-x-auto max-h-32">
                        {Object.entries(result.headers)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join("\n")}
                      </pre>
                    )}
                  </div>
                )}
                <div className="mt-2">
                  <p className="text-[10px] text-gray-400 mb-1">Body</p>
                  <pre className="text-[10px] font-mono text-gray-200 bg-black/40 rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">
                    {result.body || "(vacío)"}
                    {result.truncated && (
                      <span className="text-amber-400">{"\n\n... (truncado a 2000 chars)"}</span>
                    )}
                  </pre>
                </div>
              </>
            )}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={onClose} className="text-gray-300">
            Cerrar
          </Button>
        </div>
      </div>
    </div>
  );
}