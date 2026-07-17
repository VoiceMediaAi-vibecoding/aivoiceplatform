"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, Plus, Trash2, Wrench, X, AlertTriangle, Globe2, Sparkles, Loader2, Sliders, RotateCcw } from "lucide-react";
import { adminFetch } from "@/lib/admin-auth";
import { type TabProps, type AgentTool, inputClass, labelClass } from "./types";

interface BuiltinPreset {
  key: string;
  name: string;
  description: string;
  tool_type: string;
  parameters: Record<string, unknown>;
}

interface GlobalTool {
  id: string;
  name: string;
  key: string;
  description: string | null;
  config: { url?: string; method?: string; parameters?: Record<string, unknown> };
  created_at: string;
  usage_count?: number;
}

type AssignedTool = AgentTool & { global_tool?: GlobalTool };

const PARAMETERS_DEFAULT = `{
  "type": "object",
  "properties": {
    "ejemplo": {
      "type": "string",
      "description": "Descripción del parámetro"
    }
  },
  "required": ["ejemplo"]
}`;

/**
 * Function signature for each built-in preset — mirrors the @function_tool
 * declarations in services/agent/src/agent.py. Kept here so the agent builder
 * can show admins what each tool expects without round-tripping to the worker.
 * Listed in declaration order.
 */
const BUILTIN_PARAMS: Record<string, { name: string; type: string; required: boolean; desc?: string }[]> = {
  info_tigo: [
    { name: "nombre", type: "string", required: true },
    { name: "cedula", type: "string", required: true },
    { name: "correo", type: "string", required: true },
    { name: "telefono", type: "string", required: true },
    { name: "plan", type: "string", required: true, desc: "Plan que el cliente eligió" },
    { name: "sim_tipo", type: "string", required: true, desc: "eSIM o física" },
    { name: "cedula_titular_hogar", type: "string", required: false, desc: "Opcional" },
  ],
  tigo_correo: [
    { name: "correo", type: "string", required: true },
    { name: "nombre", type: "string", required: true },
    { name: "plan", type: "string", required: true },
  ],
  calcular_tigo_fecha_cobro: [],
  transfer_call: [
    { name: "to_number", type: "string", required: false, desc: "E.164 directo (ej. +5072023503)" },
    { name: "department", type: "string", required: false, desc: "Etiqueta del departamento configurado (ej. 'Soporte técnico')" },
    { name: "reason", type: "string", required: false, desc: "Por qué se transfiere" },
  ],
  leave_voicemail: [
    { name: "to_number", type: "string", required: true, desc: "E.164 destino del voicemail" },
    { name: "message", type: "string", required: false, desc: "Si se omite, usa default_message" },
  ],
};

/**
 * "Tools" tab — VAPI-style function-calling config with three sources of tools:
 *   1. Built-in presets  (Transfer / HangUp / Send SMS / Leave Voicemail)
 *   2. Global catalog    (admin-created reusable webhooks — /admin/tools)
 *   3. Per-agent custom  (webhooks created inline for this agent only)
 */
export default function ToolsTab({ agent, agentId, onRefresh, notify }: TabProps) {
  const [presets, setPresets] = useState<BuiltinPreset[]>([]);
  const [globalTools, setGlobalTools] = useState<GlobalTool[]>([]);
  const [search, setSearch] = useState("");

  // Custom (inline) webhook creator
  const [creating, setCreating] = useState(false);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [method, setMethod] = useState("POST");
  const [parametersJson, setParametersJson] = useState(PARAMETERS_DEFAULT);
  const [saving, setSaving] = useState(false);

  // Customize panel: per-agent override of a global tool's config.
  // Stores the agent_tools row id that's being edited (null when closed).
  const [customizingId, setCustomizingId] = useState<string | null>(null);
  const [customizingSaving, setCustomizingSaving] = useState(false);
  const [customUrl, setCustomUrl] = useState("");
  const [customMethod, setCustomMethod] = useState("POST");
  const [customParametersJson, setCustomParametersJson] = useState("");
  // Per-builtin defaults: shown in the panel when the row is a builtin
  // preset (e.g. transfer_call's default_to_number, leave_voicemail's
  // default_message). These are persisted in `custom_config` and injected
  // by the agent via a wrapper function.
  const [customBuiltinDefaults, setCustomBuiltinDefaults] = useState<Record<string, string>>({});
  // Multi-number transfer list (transfer_call only). Round-trips into
  // custom_config.transfer_numbers = [{label, number, priority}, ...].
  const [transferNumbers, setTransferNumbers] = useState<
    { label: string; number: string; priority: number }[]
  >([]);

  useEffect(() => {
    adminFetch<BuiltinPreset[]>("/admin/tools/presets")
      .then(setPresets)
      .catch(() => setPresets([]));
    adminFetch<GlobalTool[]>("/admin/tools")
      .then(setGlobalTools)
      .catch(() => setGlobalTools([]));
  }, []);

  const assignedKeys = useMemo(
    () => new Set(agent.tools.map((t) => t.key)),
    [agent.tools],
  );
  const assignedGlobalIds = useMemo(
    () => new Set(agent.tools.filter((t) => t.tool_id).map((t) => t.tool_id!)),
    [agent.tools],
  );

  const filteredGlobals = useMemo(() => {
    if (!search.trim()) return globalTools;
    const q = search.toLowerCase();
    return globalTools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.key.toLowerCase().includes(q) ||
        (t.description ?? "").toLowerCase().includes(q),
    );
  }, [globalTools, search]);

  const toggle = async (tool: AgentTool) => {
    try {
      await adminFetch(`/admin/agents/${agentId}/tools/${tool.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !tool.enabled }),
      });
      notify("ok", `✅ ${tool.label} ${!tool.enabled ? "activada" : "desactivada"}`);
      onRefresh();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al actualizar"}`);
    }
  };

  const remove = async (tool: AgentTool) => {
    if (!confirm(`¿Desasignar "${tool.label}" de este agente?`)) return;
    try {
      await adminFetch(`/admin/agents/${agentId}/tools/${tool.id}`, { method: "DELETE" });
      notify("ok", `✅ ${tool.label} desasignada`);
      onRefresh();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al desasignar"}`);
    }
  };

  const assignBuiltin = async (preset: BuiltinPreset) => {
    try {
      await adminFetch(`/admin/agents/${agentId}/tools`, {
        method: "POST",
        body: JSON.stringify({
          key: preset.key,
          label: preset.name,
          description: preset.description,
          tool_type: "builtin",
          enabled: true,
          config: { parameters: preset.parameters },
        }),
      });
      notify("ok", `✅ ${preset.name} asignado`);
      onRefresh();
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : "Error al asignar";
      if (m.includes("409") || m.toLowerCase().includes("already")) {
        notify("err", `❌ ${preset.name} ya está asignado a este agente`);
      } else {
        notify("err", `❌ ${m}`);
      }
    }
  };

  const assignGlobal = async (tool: GlobalTool) => {
    try {
      await adminFetch(`/admin/agents/${agentId}/tools`, {
        method: "POST",
        body: JSON.stringify({ tool_id: tool.id }),
      });
      notify("ok", `✅ ${tool.name} asignado`);
      onRefresh();
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : "Error al asignar";
      if (m.includes("409") || m.toLowerCase().includes("already")) {
        notify("err", `❌ ${tool.name} ya está asignado`);
      } else {
        notify("err", `❌ ${m}`);
      }
    }
  };

  const resetForm = () => {
    setKey(""); setLabel(""); setDescription(""); setUrl("");
    setMethod("POST"); setParametersJson(PARAMETERS_DEFAULT); setCreating(false);
  };

  // ── Customize / override handlers ───────────────────────────────────────
  const openCustomize = (tool: AgentTool) => {
    // Show the EFFECTIVE config: the per-agent override (if any) merged over
    // the global tool's config. When the user saves, the form values become
    // the new override; when they reset, the override is cleared and the
    // global config takes over again.
    const override = (tool.custom_config as Record<string, unknown> | null) || null;
    const base = (tool.config as Record<string, unknown>) || {};
    const effective = { ...base, ...(override || {}) };
    setCustomUrl(String(effective.url || ""));
    setCustomMethod(String(effective.method || "POST").toUpperCase());
    setCustomParametersJson(
      effective.parameters ? JSON.stringify(effective.parameters, null, 2) : "",
    );
    // Builtin defaults (per-agent). Load EVERY key in custom_config so values
    // previously saved via the JSON override field round-trip into the form.
    const defaults: Record<string, string> = {};
    if (tool.tool_type === "builtin" && override) {
      for (const [k, v] of Object.entries(override)) {
        if (v === null || v === undefined) continue;
        if (k === "default_to_number" || k === "default_message") {
          // Friendly fields — load as string for the input
          defaults[k] = String(v);
        } else if (k === "transfer_numbers") {
          // Handled separately by setTransferNumbers below — skip
        } else {
          // Everything else (saved via the JSON override field) — show as JSON
          defaults.__json__ = JSON.stringify(
            Object.fromEntries(
              Object.entries(override).filter(
                ([k2]) =>
                  k2 !== "default_to_number" &&
                  k2 !== "default_message" &&
                  k2 !== "transfer_numbers",
              ),
            ),
            null,
            2,
          );
          break;
        }
      }
    }
    setCustomBuiltinDefaults(defaults);
    // Hydrate the multi-number list for transfer_call. Sort by priority
    // ascending so the UI matches the order the agent will resolve.
    if (tool.tool_type === "builtin" && tool.key === "transfer_call") {
      const raw = override?.transfer_numbers;
      const list: { label: string; number: string; priority: number }[] = [];
      if (Array.isArray(raw)) {
        for (const e of raw) {
          if (!e || typeof e !== "object") continue;
          const lbl = String((e as { label?: unknown }).label || "").trim();
          const num = String((e as { number?: unknown }).number || "").trim();
          if (!lbl || !num) continue;
          const prioRaw = (e as { priority?: unknown }).priority;
          const prio = typeof prioRaw === "number" ? prioRaw : Number(prioRaw) || 99;
          list.push({ label: lbl, number: num, priority: prio });
        }
      }
      list.sort((a, b) => a.priority - b.priority);
      setTransferNumbers(list);
    } else {
      setTransferNumbers([]);
    }
    setCustomizingId(tool.id);
  };

  const closeCustomize = () => {
    setCustomizingId(null);
    setCustomizingSaving(false);
    setTransferNumbers([]);
  };

  const saveCustomize = async (tool: AgentTool) => {
    let parameters: unknown;
    if (customParametersJson.trim()) {
      try {
        parameters = JSON.parse(customParametersJson);
      } catch {
        notify("err", "❌ El JSON Schema de parámetros no es válido");
        return;
      }
    }
    setCustomizingSaving(true);
    // Build the override dict from the form. Empty fields are omitted so
    // the merge in _build_tools uses the global's value for them.
    const override: Record<string, unknown> = {};
    if (customUrl.trim()) override.url = customUrl.trim();
    if (customMethod) override.method = customMethod;
    if (parameters !== undefined) override.parameters = parameters;
    // Builtin defaults (per-agent) — friendly fields first
    for (const [k, v] of Object.entries(customBuiltinDefaults)) {
      if (k === "__json__") continue;
      if (v && v.trim()) override[k] = v.trim();
    }
    // transfer_numbers list (multi-department transfers). Strip empty rows
    // and re-number priority sequentially. Only write the key if there's
    // at least one valid row — otherwise an empty list would shadow the
    // agent's own defaults.
    if (tool.tool_type === "builtin" && tool.key === "transfer_call") {
      const cleaned = transferNumbers
        .map((n) => ({
          label: (n.label || "").trim(),
          number: (n.number || "").trim(),
          priority: Number.isFinite(n.priority) ? n.priority : 99,
        }))
        .filter((n) => n.label && n.number)
        .sort((a, b) => a.priority - b.priority)
        .map((n, i) => ({ ...n, priority: i + 1 })); // re-sequence 1..N
      if (cleaned.length > 0) override.transfer_numbers = cleaned;
    }
    // Then the JSON override (merged in last so explicit friendly fields win)
    const jsonRaw = customBuiltinDefaults.__json__?.trim();
    if (jsonRaw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonRaw);
      } catch {
        notify("err", "❌ El JSON de override no es válido");
        setCustomizingSaving(false);
        return;
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (v === null || v === undefined || v === "") continue;
          if (!(k in override)) override[k] = v;
        }
      } else {
        notify("err", "❌ El JSON de override debe ser un objeto { ... }");
        setCustomizingSaving(false);
        return;
      }
    }
    try {
      await adminFetch(`/admin/agents/${agentId}/tools/${tool.id}`, {
        method: "PATCH",
        body: JSON.stringify({ custom_config: override }),
      });
      notify("ok", "✅ Override guardado");
      closeCustomize();
      onRefresh();
    } catch (e: unknown) {
      notify("err", `❌ ${e instanceof Error ? e.message : "Error al guardar override"}`);
    } finally {
      setCustomizingSaving(false);
    }
  };

  const resetCustomize = async (tool: AgentTool) => {
    if (!confirm(`¿Restaurar la configuración por defecto de "${tool.label}"? Se perderán los overrides de este agente.`)) return;
    setCustomizingSaving(true);
    try {
      await adminFetch(`/admin/agents/${agentId}/tools/${tool.id}`, {
        method: "PATCH",
        body: JSON.stringify({ custom_config: null }),
      });
      notify("ok", "✅ Override eliminado, ahora usa la config del catálogo");
      closeCustomize();
      onRefresh();
    } catch (e: unknown) {
      notify("err", `❌ ${e instanceof Error ? e.message : "Error al restaurar"}`);
    } finally {
      setCustomizingSaving(false);
    }
  };

  const createCustom = async () => {
    let parameters: unknown;
    try {
      parameters = JSON.parse(parametersJson);
    } catch {
      notify("err", "❌ El JSON Schema de parámetros no es válido");
      return;
    }
    setSaving(true);
    try {
      await adminFetch(`/admin/agents/${agentId}/tools`, {
        method: "POST",
        body: JSON.stringify({
          key: key.trim(),
          label: label.trim(),
          description: description.trim() || null,
          tool_type: "webhook",
          enabled: true,
          config: { url: url.trim(), method, parameters },
        }),
      });
      notify("ok", "✅ Herramienta creada");
      resetForm();
      onRefresh();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al crear"}`);
    } finally {
      setSaving(false);
    }
  };

  const builtins = agent.tools.filter((t) => t.tool_type === "builtin");
  const webhooks = agent.tools.filter((t) => t.tool_type === "webhook" && !t.tool_id);
  const globals = agent.tools.filter((t) => t.tool_id);

  return (
    <div className="space-y-6 max-w-3xl">
      {/* ── 1. Built-in presets ──────────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="w-4 h-4 text-indigo-300" />
          <h3 className="text-sm font-semibold text-gray-200">Herramientas predeterminadas (presets)</h3>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Funciones nativas de la plataforma. Click <span className="text-emerald-300">+ Asignar</span> para
          añadirlas a este agente. Requieren Twilio (SMS/Transfer) o LiveKit (HangUp).
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {presets.map((p) => {
            const assigned = assignedKeys.has(p.key);
            return (
              <div
                key={p.key}
                className={`p-3 rounded-xl border ${
                  assigned
                    ? "bg-emerald-500/5 border-emerald-400/20"
                    : "bg-white/[0.03] border-white/10 hover:border-white/20"
                } transition-colors`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-100">{p.name}</p>
                    <p className="text-[11px] text-gray-500 mt-0.5">{p.description}</p>
                    <code className="text-[10px] text-gray-600 font-mono mt-1 inline-block">{p.key}</code>
                  </div>
                  {assigned ? (
                    <span className="text-[10px] text-emerald-300 bg-emerald-500/10 px-1.5 py-0.5 rounded shrink-0">
                      ✓ Asignada
                    </span>
                  ) : (
                    <button
                      onClick={() => assignBuiltin(p)}
                      className="text-[10px] px-2 py-1 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 rounded transition-colors shrink-0"
                    >
                      + Asignar
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {builtins.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Asignadas a este agente</p>
            {builtins.map((t) => {
              const hasOverride =
                t.custom_config && Object.keys(t.custom_config as object).length > 0;
              return (
                <div key={t.id} className="space-y-1">
                  <ToolRow
                    tool={t}
                    onToggle={() => toggle(t)}
                    onDelete={() => remove(t)}
                    onCustomize={() => openCustomize(t)}
                    hasOverride={!!hasOverride}
                  />
                  {customizingId === t.id && (
                    <CustomizePanel
                      tool={t}
                      hasOverride={!!hasOverride}
                      url={customUrl}
                      method={customMethod}
                      parametersJson={customParametersJson}
                      builtinDefaults={customBuiltinDefaults}
                      transferNumbers={transferNumbers}
                      onUrlChange={setCustomUrl}
                      onMethodChange={setCustomMethod}
                      onParametersChange={setCustomParametersJson}
                      onBuiltinDefaultChange={(k, v) =>
                        setCustomBuiltinDefaults((prev) => ({ ...prev, [k]: v }))
                      }
                      onTransferNumbersChange={setTransferNumbers}
                      onSave={() => saveCustomize(t)}
                      onReset={() => resetCustomize(t)}
                      onClose={closeCustomize}
                      saving={customizingSaving}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 2. Global catalog ───────────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-1">
          <Globe2 className="w-4 h-4 text-cyan-300" />
          <h3 className="text-sm font-semibold text-gray-200">Catálogo global</h3>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Webhooks reutilizables definidos a nivel plataforma. Una vez creada, se asignan a
          cualquier agente.{" "}
          <a href="/admin/tools" className="text-cyan-300 hover:text-cyan-200 underline">
            Crear en /admin/tools ↗
          </a>
        </p>
        <div className="relative mb-3">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar en el catálogo..."
            className={`${inputClass} pl-8 text-xs`}
          />
        </div>
        {filteredGlobals.length === 0 ? (
          <p className="text-xs text-gray-600 italic">
            {globalTools.length === 0
              ? "No hay herramientas globales. Crea la primera en /admin/tools."
              : "Sin resultados para esa búsqueda."}
          </p>
        ) : (
          <div className="space-y-2">
            {filteredGlobals.map((t) => {
              const assigned = assignedGlobalIds.has(t.id);
              return (
                <div key={t.id} className="bg-white/[0.03] border border-white/10 rounded-xl p-3 flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-100">{t.name}</p>
                      <code className="text-[10px] text-gray-500 bg-black/30 px-1.5 py-0.5 rounded font-mono">{t.key}</code>
                    </div>
                    {t.description && <p className="text-xs text-gray-400 mt-1">{t.description}</p>}
                    {t.config?.url && (
                      <p className="text-[11px] font-mono text-gray-500 mt-1 truncate">
                        <span className="px-1 py-0.5 rounded bg-white/5 text-gray-400 text-[10px] mr-1">
                          {(t.config.method || "POST").toUpperCase()}
                        </span>
                        {t.config.url}
                      </p>
                    )}
                  </div>
                  {assigned ? (
                    <span className="text-[10px] text-cyan-300 bg-cyan-500/10 px-1.5 py-0.5 rounded shrink-0 self-center">
                      ✓ Asignada
                    </span>
                  ) : (
                    <button
                      onClick={() => assignGlobal(t)}
                      className="text-[10px] px-2 py-1 bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 rounded transition-colors shrink-0 self-center"
                    >
                      + Asignar
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {globals.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">
              Asignadas del catálogo ({globals.length})
            </p>
            {globals.map((t) => {
              const hasOverride =
                t.custom_config && Object.keys(t.custom_config as object).length > 0;
              return (
                <div key={t.id} className="space-y-1">
                  <ToolRow
                    tool={t as AssignedTool}
                    onToggle={() => toggle(t)}
                    onDelete={() => remove(t)}
                    onCustomize={() => openCustomize(t)}
                    hasOverride={!!hasOverride}
                    extra={t.global_tool ? `📦 del catálogo "${t.global_tool.name}"` : undefined}
                  />
                  {customizingId === t.id && (
                    <CustomizePanel
                      tool={t as AssignedTool}
                      hasOverride={!!hasOverride}
                      url={customUrl}
                      method={customMethod}
                      parametersJson={customParametersJson}
                      builtinDefaults={customBuiltinDefaults}
                      transferNumbers={transferNumbers}
                      onUrlChange={setCustomUrl}
                      onMethodChange={setCustomMethod}
                      onParametersChange={setCustomParametersJson}
                      onBuiltinDefaultChange={(k, v) =>
                        setCustomBuiltinDefaults((prev) => ({ ...prev, [k]: v }))
                      }
                      onTransferNumbersChange={setTransferNumbers}
                      onSave={() => saveCustomize(t)}
                      onReset={() => resetCustomize(t)}
                      onClose={closeCustomize}
                      saving={customizingSaving}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 3. Per-agent custom ─────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-pink-300" />
            <h3 className="text-sm font-semibold text-gray-200">Personalizadas (webhook inline)</h3>
          </div>
          {!creating && (
            <button
              onClick={() => setCreating(true)}
              className="text-xs px-3 py-1.5 bg-brand-pink hover:bg-brand-purple rounded-lg font-medium transition-colors flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Nueva
            </button>
          )}
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Webhooks definidos solo para este agente. Para reusar en otros, créala en el
          catálogo global (<a href="/admin/tools" className="text-cyan-300 hover:text-cyan-200 underline">/admin/tools</a>).
        </p>

        {creating && (
          <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Clave (snake_case)</label>
                <input
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="consultar_inventario"
                  className={`${inputClass} font-mono text-xs`}
                />
              </div>
              <div>
                <label className={labelClass}>Etiqueta</label>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Consultar inventario"
                  className={inputClass}
                />
              </div>
            </div>
            <div>
              <label className={labelClass}>Descripción para el modelo</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Consulta si un producto está disponible por SKU"
                className={inputClass}
              />
            </div>
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <div>
                <label className={labelClass}>URL del webhook</label>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://api.tuservicio.com/inventario"
                  className={`${inputClass} font-mono text-xs`}
                />
              </div>
              <div>
                <label className={labelClass}>Método</label>
                <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputClass}>
                  <option value="POST">POST</option>
                  <option value="GET">GET</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>
            </div>
            <div>
              <label className={labelClass}>Parámetros (JSON Schema)</label>
              <textarea
                value={parametersJson}
                onChange={(e) => setParametersJson(e.target.value)}
                rows={7}
                spellCheck={false}
                className={`${inputClass} font-mono text-xs resize-y`}
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={createCustom}
                disabled={!key.trim() || !label.trim() || !url.trim() || saving}
                className="px-4 py-2 bg-brand-pink hover:bg-brand-purple disabled:opacity-40 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5"
              >
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {saving ? "Creando…" : "Crear herramienta"}
              </button>
              <button
                onClick={resetForm}
                className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-lg text-sm transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {webhooks.length === 0 ? (
          <p className="text-xs text-gray-600 italic">No hay herramientas personalizadas.</p>
        ) : (
          <div className="space-y-2">
            {webhooks.map((t) => (
              <ToolRow key={t.id} tool={t} onToggle={() => toggle(t)} onDelete={() => remove(t)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Render a compact one-line summary of an agent's custom_config for the row.
 * Returns null if there's nothing interesting to show.
 */
function summarizeBuiltinOverride(tool: AgentTool): string | null {
  const cfg = tool.custom_config as Record<string, unknown> | null;
  if (!cfg) return null;
  if (tool.tool_type !== "builtin") return null;
  if (tool.key === "transfer_call") {
    const nums = Array.isArray(cfg.transfer_numbers) ? cfg.transfer_numbers : [];
    if (nums.length > 0) {
      const labels = nums
        .map((n) => (n as { label?: string })?.label)
        .filter((l): l is string => !!l);
      const head = labels.slice(0, 3).join(", ");
      const more = labels.length > 3 ? ` +${labels.length - 3}` : "";
      return `Números: ${nums.length} (${head}${more})`;
    }
    const num = (cfg.default_to_number as string) || "";
    if (num) return `Default: ${num}`;
  }
  if (tool.key === "leave_voicemail") {
    const msg = (cfg.default_message as string) || "";
    if (msg) {
      const trimmed = msg.length > 80 ? `${msg.slice(0, 80)}…` : msg;
      return `Default: "${trimmed}"`;
    }
  }
  // For any builtin: show whatever custom keys are set (excluding the
  // friendly fields already shown above).
  const friendly = new Set(["default_to_number", "default_message", "transfer_numbers"]);
  const extra = Object.entries(cfg).filter(
    ([k, v]) => !friendly.has(k) && v !== null && v !== undefined && v !== "",
  );
  if (extra.length === 0) return null;
  const parts = extra.map(([k, v]) => `${k}: ${String(v)}`);
  const joined = parts.join(" · ");
  return joined.length > 120 ? `${joined.slice(0, 120)}…` : joined;
}

function ToolRow({
  tool,
  onToggle,
  onDelete,
  onCustomize,
  hasOverride,
  extra,
}: {
  tool: AgentTool;
  onToggle: () => void;
  onDelete?: () => void;
  onCustomize?: () => void;
  hasOverride?: boolean;
  extra?: string;
}) {
  const config = tool.config as { url?: string; method?: string };
  const overrideSummary = hasOverride ? summarizeBuiltinOverride(tool) : null;
  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl p-3 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-gray-100">{tool.label}</p>
          <code className="text-[10px] text-gray-500 bg-black/30 px-1.5 py-0.5 rounded font-mono">
            {tool.key}
          </code>
          {hasOverride && (
            <span
              className="text-[10px] text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded"
              title="Este agente tiene un override sobre la config del catálogo"
            >
              ⚙ Custom
            </span>
          )}
        </div>
        {tool.description && <p className="text-xs text-gray-400 mt-1">{tool.description}</p>}
        {tool.tool_type === "webhook" && config.url && (
          <p className="text-[11px] font-mono text-gray-500 mt-1 truncate">
            {config.method ?? "POST"} {config.url}
          </p>
        )}
        {overrideSummary && (
          <p
            className="text-[11px] font-mono text-amber-300/90 mt-1 truncate"
            title={overrideSummary}
          >
            ⚙ {overrideSummary}
          </p>
        )}
        {extra && <p className="text-[10px] text-cyan-300/80 mt-1">{extra}</p>}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {onCustomize && (
          <button
            onClick={onCustomize}
            className={`text-xs px-2 py-1.5 rounded-lg transition-colors ${
              hasOverride
                ? "bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                : "bg-white/5 text-gray-300 hover:bg-white/10"
            }`}
            title={hasOverride ? "Editar override (este agente difiere del catálogo)" : "Customizar para este agente"}
          >
            <Sliders className="w-3.5 h-3.5" />
          </button>
        )}
        <label className="inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={tool.enabled}
            onChange={onToggle}
            className="sr-only peer"
          />
          <div className="w-9 h-5 bg-white/10 rounded-full peer-checked:bg-emerald-500/70 transition-colors relative">
            <div className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4" />
          </div>
        </label>
        {onDelete && (
          <button
            onClick={onDelete}
            className="text-xs px-2 py-1 text-rose-300/80 hover:text-rose-300 hover:bg-rose-500/10 rounded transition-colors"
            title="Desasignar"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function CustomizePanel({
  tool,
  hasOverride,
  url,
  method,
  parametersJson,
  builtinDefaults,
  transferNumbers,
  onUrlChange,
  onMethodChange,
  onParametersChange,
  onBuiltinDefaultChange,
  onTransferNumbersChange,
  onSave,
  onReset,
  onClose,
  saving,
}: {
  tool: AgentTool;
  hasOverride: boolean;
  url: string;
  method: string;
  parametersJson: string;
  builtinDefaults: Record<string, string>;
  transferNumbers: { label: string; number: string; priority: number }[];
  onUrlChange: (v: string) => void;
  onMethodChange: (v: string) => void;
  onParametersChange: (v: string) => void;
  onBuiltinDefaultChange: (key: string, value: string) => void;
  onTransferNumbersChange: (
    v: { label: string; number: string; priority: number }[],
  ) => void;
  onSave: () => void;
  onReset: () => void;
  onClose: () => void;
  saving: boolean;
}) {
  const globalUrl = (tool.global_tool?.config as { url?: string })?.url || "(default del catálogo)";
  return (
    <div className="bg-amber-500/[0.04] border border-amber-400/20 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-200">
            ⚙ Customizar para este agente
          </p>
          <p className="text-[11px] text-amber-200/70 mt-0.5">
            {hasOverride
              ? "Este agente ya tiene un override activo sobre la config del catálogo."
              : "Cualquier campo vacío cae al default del catálogo."}
            {tool.tool_type === "webhook" && (
              <> Default URL: <code className="font-mono">{globalUrl}</code></>
            )}
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-amber-300/60 hover:text-amber-200 shrink-0"
          aria-label="Cerrar"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Webhook-only fields (URL, method, parameters) */}
      {tool.tool_type === "webhook" && (
        <>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div>
              <label className={labelClass}>URL override</label>
              <input
                value={url}
                onChange={(e) => onUrlChange(e.target.value)}
                placeholder="https://mi-tuempresa.com/otro-endpoint"
                className={`${inputClass} font-mono text-xs`}
              />
            </div>
            <div>
              <label className={labelClass}>Método</label>
              <select
                value={method}
                onChange={(e) => onMethodChange(e.target.value)}
                className={inputClass}
              >
                <option value="POST">POST</option>
                <option value="GET">GET</option>
                <option value="PUT">PUT</option>
                <option value="DELETE">DELETE</option>
                <option value="PATCH">PATCH</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelClass}>
              Parámetros override <span className="text-gray-600">(JSON Schema, opcional)</span>
            </label>
            <textarea
              value={parametersJson}
              onChange={(e) => onParametersChange(e.target.value)}
              rows={6}
              spellCheck={false}
              placeholder="Deja vacío para usar el del catálogo"
              className={`${inputClass} font-mono text-xs resize-y`}
            />
          </div>
        </>
      )}

      {/* Builtin-only default fields */}
      {tool.key === "transfer_call" && (
        <div className="space-y-3">
          {/* Multi-department transfer numbers — primary configuration. The
              LLM picks the department by label and the agent resolves to
              the matching number at call time. */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className={labelClass + " mb-0"}>
                Números de transferencia por departamento
              </label>
              <button
                type="button"
                onClick={() =>
                  onTransferNumbersChange([
                    ...transferNumbers,
                    {
                      label: "",
                      number: "",
                      priority: transferNumbers.length + 1,
                    },
                  ])
                }
                className="text-[11px] px-2 py-1 rounded bg-white/5 text-gray-300 hover:bg-white/10 flex items-center gap-1"
              >
                <Plus className="w-3 h-3" />
                Agregar número
              </button>
            </div>
            {transferNumbers.length === 0 ? (
              <p className="text-[11px] text-gray-500 italic">
                Sin números por departamento configurados. El agente solo podrá
                transferir al número por defecto de abajo.
              </p>
            ) : (
              <div className="space-y-2">
                {transferNumbers.map((n, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-[1fr_1.4fr_60px_auto] gap-2 items-center bg-white/[0.03] rounded-lg p-2 border border-white/10"
                  >
                    <input
                      value={n.label}
                      onChange={(e) =>
                        onTransferNumbersChange(
                          transferNumbers.map((x, i) =>
                            i === idx ? { ...x, label: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder="Ej. Soporte técnico"
                      className={`${inputClass} text-xs`}
                    />
                    <input
                      value={n.number}
                      onChange={(e) =>
                        onTransferNumbersChange(
                          transferNumbers.map((x, i) =>
                            i === idx ? { ...x, number: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder="+5073907555"
                      className={`${inputClass} font-mono text-xs`}
                    />
                    <input
                      type="number"
                      min={1}
                      value={n.priority}
                      onChange={(e) =>
                        onTransferNumbersChange(
                          transferNumbers.map((x, i) =>
                            i === idx
                              ? { ...x, priority: parseInt(e.target.value, 10) || 99 }
                              : x,
                          ),
                        )
                      }
                      className={`${inputClass} text-xs text-center`}
                      title="Prioridad (1 = primero)"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        onTransferNumbersChange(
                          transferNumbers.filter((_, i) => i !== idx),
                        )
                      }
                      title="Eliminar"
                      className="p-1.5 rounded text-rose-400 hover:bg-rose-500/10"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11px] text-gray-500 mt-1.5">
              El agente conoce los departamentos configurados y puede transferir
              directamente. Si dice el nombre del departamento (ej. "Soporte"),
              se marca <code className="text-gray-400">department="Soporte técnico"</code>{" "}
              y resolvemos al número.
            </p>
          </div>

          {/* Legacy single-number fallback — kept for back-compat with
              agents created before multi-number. Used when the LLM passes
              neither a department nor a to_number. */}
          <div>
            <label className={labelClass}>
              Número por defecto (fallback legacy){" "}
              <span className="text-gray-600">(E.164, ej. +5072023503)</span>
            </label>
            <input
              value={builtinDefaults.default_to_number || ""}
              onChange={(e) => onBuiltinDefaultChange("default_to_number", e.target.value)}
              placeholder="+5072023503"
              className={`${inputClass} font-mono text-xs`}
            />
            <p className="text-[11px] text-gray-500 mt-1">
              Usado solo si el agente no especifica ni departamento ni número.
              Si ya configuraste departamentos arriba, esto es opcional.
            </p>
          </div>
        </div>
      )}

      {tool.key === "leave_voicemail" && (
        <div>
          <label className={labelClass}>
            Mensaje de voicemail por defecto
          </label>
          <textarea
            value={builtinDefaults.default_message || ""}
            onChange={(e) => onBuiltinDefaultChange("default_message", e.target.value)}
            rows={3}
            placeholder="Hola, soy [nombre del agente]. Te llamamos para..."
            className={`${inputClass} text-xs resize-y`}
          />
          <p className="text-[10px] text-gray-500 mt-1">
            Mensaje que se reproduce cuando el agente decide dejar voicemail. Si el LLM
            llama sin mensaje, se usa este.
          </p>
        </div>
      )}

      {/* Builtin params (read-only chips) — visible for every builtin so admins
          know what the LLM will send when the agent calls this tool. */}
      {tool.tool_type === "builtin" && BUILTIN_PARAMS[tool.key] && (
        <div>
          <label className={labelClass}>
            Parámetros que el LLM enviará al tool
            {BUILTIN_PARAMS[tool.key].length === 0 && (
              <span className="text-gray-600 ml-1">(este tool no recibe parámetros)</span>
            )}
          </label>
          {BUILTIN_PARAMS[tool.key].length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {BUILTIN_PARAMS[tool.key].map((p) => (
                <span
                  key={p.name}
                  title={p.desc || `${p.type}${p.required ? " · requerido" : ""}`}
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                    p.required
                      ? "text-amber-200 bg-amber-500/5 border-amber-500/20"
                      : "text-gray-400 bg-white/[0.02] border-white/10"
                  }`}
                >
                  {p.name}: {p.type}
                  {p.required && <span className="text-amber-400 ml-0.5">*</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Advanced JSON override — for builtins without a friendly field, or
          for admins who want to pre-set any param. Allows overriding the LLM
          value at call time. */}
      {tool.tool_type === "builtin" && (
        <details className="text-xs">
          <summary className="cursor-pointer text-amber-300/80 hover:text-amber-200 select-none">
            Override de valores por defecto (JSON, opcional)
          </summary>
          <div className="mt-2">
            <textarea
              value={builtinDefaults.__json__ || ""}
              onChange={(e) => onBuiltinDefaultChange("__json__", e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder={`{\n  "plan": "Plan 5GB $19.99"\n}`}
              className={`${inputClass} font-mono text-xs resize-y`}
            />
            <p className="text-[10px] text-gray-500 mt-1">
              Cualquier campo listado arriba se puede pre-setear aquí. Si el LLM pasa un
              valor, gana el del LLM. Si no, se usa este.
            </p>
          </div>
        </details>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onSave}
          disabled={saving}
          className="px-4 py-2 bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-40 rounded-lg text-sm font-medium text-amber-100 transition-colors flex items-center gap-1.5"
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {saving ? "Guardando…" : "Guardar override"}
        </button>
        {hasOverride && (
          <button
            onClick={onReset}
            disabled={saving}
            className="text-xs text-amber-300/80 hover:text-amber-200 underline flex items-center gap-1"
          >
            <RotateCcw className="w-3 h-3" />
            Restaurar default del catálogo
          </button>
        )}
        <button
          onClick={onClose}
          className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-lg text-sm transition-colors ml-auto"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}
