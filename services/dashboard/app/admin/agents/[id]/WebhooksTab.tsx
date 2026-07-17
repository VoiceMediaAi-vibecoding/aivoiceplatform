"use client";

import { useEffect, useState, useCallback } from "react";
import { CheckCircle2, XCircle, RefreshCw, Loader2, Clock, ExternalLink, FlaskConical, KeyRound, Save } from "lucide-react";
import { adminFetch } from "@/lib/admin-auth";
import { type TabProps, inputClass, labelClass } from "./types";

interface WebhookDelivery {
  id: string;
  session_id: string;
  agent_id: string;
  webhook_url: string;
  status: "delivered" | "failed" | "retrying";
  http_status: number | null;
  latency_ms: number | null;
  attempts: number;
  response_body: string | null;
  last_error: string | null;
  created_at: string;
}

/**
 * "Webhooks" tab — configures the post-call webhook URL + HMAC secret, and
 * shows the delivery audit log. VAPI-style end-of-call reports.
 */
export default function WebhooksTab({ agent, agentId, onRefresh, notify }: TabProps) {
  const [webhookUrl, setWebhookUrl] = useState(agent.webhook_url ?? "");
  const [webhookSecret, setWebhookSecret] = useState(agent.webhook_secret ?? "");
  const [saving, setSaving] = useState(false);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [showPayload, setShowPayload] = useState(false);

  const dirty =
    webhookUrl !== (agent.webhook_url ?? "") ||
    webhookSecret !== (agent.webhook_secret ?? "");

  const loadDeliveries = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminFetch<WebhookDelivery[]>(
        `/admin/agents/${agentId}/webhook-deliveries?limit=50`
      );
      setDeliveries(Array.isArray(data) ? data : []);
    } catch {
      // adminFetch handles auth errors
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    loadDeliveries();
  }, [loadDeliveries]);

  const save = async () => {
    setSaving(true);
    try {
      await adminFetch(`/admin/agents/${agentId}`, {
        method: "PATCH",
        body: JSON.stringify({
          webhook_url: webhookUrl || null,
          webhook_secret: webhookSecret || null,
        }),
      });
      notify("ok", "✅ Webhook guardado");
      onRefresh();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al guardar"}`);
    } finally {
      setSaving(false);
    }
  };

  const retry = async (deliveryId: string) => {
    setRetrying(deliveryId);
    try {
      const result = await adminFetch<{ status: string; http_status: number }>(
        `/admin/agents/${agentId}/webhook-deliveries/${deliveryId}/retry`,
        { method: "POST" }
      );
      notify(
        result.status === "delivered" ? "ok" : "err",
        result.status === "delivered"
          ? `✅ Retry exitoso (${result.http_status})`
          : `❌ Retry falló (${result.http_status})`
      );
      loadDeliveries();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al reenviar"}`);
    } finally {
      setRetrying(null);
    }
  };

  return (
    <div className="space-y-5 max-w-2xl">
      <section>
        <h3 className="text-sm font-semibold text-gray-200 mb-2 flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-cyan-300" />
          Webhook post-llamada
        </h3>
        <p className="text-xs text-gray-500 mb-3">
          Recibe un JSON con transcript, summary, tools invocados, costos y metadata
          cuando la llamada termina. Similar al "Server URL" de VAPI.
          Se ejecuta para TODAS las llamadas del agente.
        </p>

        <div className="space-y-3">
          <div>
            <label className={labelClass}>Webhook URL</label>
            <input
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://your-server.com/webhook"
              className={`${inputClass} font-mono text-xs`}
            />
          </div>
          <div>
            <label className={labelClass}>
              <KeyRound className="w-3 h-3 inline mr-1" />
              HMAC Secret (opcional)
            </label>
            <input
              type="password"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder="Para validar firma X-Webhook-Signature"
              className={`${inputClass} font-mono text-xs`}
            />
            <p className="text-[10px] text-gray-500 mt-1">
              Cuando está configurado, el body se firma con HMAC-SHA256.
              El receptor debe recomputar la firma con el mismo secret y compararla.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-3">
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="px-4 py-2 bg-brand-pink hover:bg-brand-purple disabled:opacity-40 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <Save className="w-3.5 h-3.5" />
            {saving ? "Guardando…" : "Guardar webhook"}
          </button>
          {dirty && (
            <span className="text-xs text-amber-300/80">Tienes cambios sin guardar</span>
          )}
        </div>
      </section>

      <section>
        <button
          type="button"
          onClick={() => setShowPayload(!showPayload)}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200"
        >
          {showPayload ? "▼" : "▶"} Schema del payload
        </button>
        {showPayload && (
          <pre className="mt-2 p-3 bg-black/40 rounded text-[10px] font-mono text-gray-300 overflow-x-auto max-h-72">{`{
  "event": "end-of-call",
  "version": "1.0",
  "agent_id": "uuid",
  "agent_name": "...",
  "session_id": "uuid",
  "call": {
    "room_name": "call-abc",
    "twilio_call_sid": "CAxxxx",
    "end_reason": "completed"
  },
  "costs": { "total_usd": 0.05, "by_provider": { ... } },
  "summary": "Customer called about...",
  "transcript": "Customer: ...\\nAgent: ...",
  "tools": [
    {
      "name": "gomez_vendor",
      "tool_key": "gomez_vendor",
      "called_at": "2026-07-08T20:00:00Z",
      "arguments": { ... },
      "status": 200,
      "ok": true,
      "latency_ms": 86,
      "response_preview": "..."
    }
  ]
}`}</pre>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-200">Historial de entregas</h3>
          <button
            onClick={loadDeliveries}
            disabled={loading}
            className="text-xs px-2 py-1 bg-white/5 hover:bg-white/10 rounded transition-colors"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin inline mr-1" /> : null}
            Refrescar
          </button>
        </div>

        {loading && deliveries.length === 0 ? (
          <div className="text-center py-6 text-gray-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Cargando…
          </div>
        ) : deliveries.length === 0 ? (
          <div className="text-center py-6 text-gray-500 text-sm border border-dashed border-white/10 rounded-lg">
            Aún no hay entregas. El webhook se ejecutará al terminar la primera llamada.
          </div>
        ) : (
          <div className="space-y-2">
            {deliveries.map((d) => (
              <DeliveryRow
                key={d.id}
                delivery={d}
                retrying={retrying === d.id}
                onRetry={() => retry(d.id)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function DeliveryRow({
  delivery,
  retrying,
  onRetry,
}: {
  delivery: WebhookDelivery;
  retrying: boolean;
  onRetry: () => void;
}) {
  const isOk = delivery.status === "delivered";
  const created = new Date(delivery.created_at);
  return (
    <div
      className={`rounded-lg border p-3 text-xs ${
        isOk
          ? "bg-emerald-950/20 border-emerald-500/20"
          : "bg-rose-950/20 border-rose-500/20"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          {isOk ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`font-mono px-1.5 py-0.5 rounded ${
                  isOk
                    ? "bg-emerald-500/20 text-emerald-200"
                    : "bg-rose-500/20 text-rose-200"
                }`}
              >
                {delivery.http_status ?? "—"}
              </span>
              {delivery.latency_ms != null && (
                <span className="text-gray-500 flex items-center gap-0.5">
                  <Clock className="w-2.5 h-2.5" />
                  {delivery.latency_ms}ms
                </span>
              )}
              <span className="text-gray-500">attempts: {delivery.attempts}</span>
              <span className="text-gray-500">
                {created.toLocaleString("es-MX", { hour12: false })}
              </span>
            </div>
            <p className="text-[10px] text-gray-500 font-mono mt-1 truncate flex items-center gap-1">
              <ExternalLink className="w-2.5 h-2.5" />
              {delivery.webhook_url}
            </p>
            {delivery.last_error && (
              <p className="text-[10px] text-rose-300/80 mt-1 font-mono break-all">
                {delivery.last_error}
              </p>
            )}
          </div>
        </div>
        <button
          onClick={onRetry}
          disabled={retrying}
          className="text-[10px] px-2 py-1 bg-white/5 hover:bg-white/10 disabled:opacity-40 rounded transition-colors shrink-0 flex items-center gap-1"
        >
          {retrying ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          Retry
        </button>
      </div>
    </div>
  );
}
