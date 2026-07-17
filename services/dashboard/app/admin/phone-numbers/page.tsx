"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
  PhoneCall, Plus, Search, Loader2, Trash2, AlertCircle, X,
  CheckCircle2, XCircle, ExternalLink, Sparkles, MapPin, Download, Wifi, WifiOff,
} from "lucide-react";
import { adminFetch } from "@/lib/admin-auth";
import AdminAuthGuard from "@/app/admin/AdminAuthGuard";
import AppShell from "@/components/AppShell";
import StatusPill from "@/components/ui/StatusPill";

interface PhoneNumber {
  id: string;
  number: string;
  label: string | null;
  provider: string;
  provider_sid: string | null;
  capabilities: Record<string, unknown>;
  agent_id: string | null;
  client_id: string | null;
  is_active: boolean;
  created_at: string;
  lk_inbound_trunk_id?: string | null;
  lk_dispatch_rule_id?: string | null;
  twilio_trunk_sid?: string | null;
  agents?: { name: string; is_active: boolean } | null;
  clients?: { name: string } | null;
}

interface AgentOption {
  id: string;
  name: string;
  is_active: boolean;
}

interface ClientOption {
  id: string;
  name: string;
}

interface TwilioCandidate {
  phone_number: string;
  friendly_name: string;
  locality: string;
  region: string;
  capabilities: { voice?: boolean; sms?: boolean; mms?: boolean };
  iso_country: string;
}

interface OwnedTwilioNumber {
  incoming_phone_number_sid: string;
  phone_number: string;
  friendly_name: string | null;
  capabilities: { voice?: boolean; sms?: boolean; mms?: boolean };
  voice_url?: string | null;
  already_imported: boolean;
}

const PROVIDER_LABELS: Record<string, string> = {
  twilio_pa: "Twilio Panamá",
  twilio_us: "Twilio US",
  manual: "Manual",
};

const PROVIDER_STYLES: Record<string, string> = {
  twilio_pa: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  twilio_us: "bg-cyan-500/10 text-cyan-300 border-cyan-500/20",
  manual: "bg-gray-500/10 text-gray-300 border-gray-500/20",
};

function PhoneNumbersContent() {
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newNumber, setNewNumber] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newProvider, setNewProvider] = useState("manual");
  const [newSid, setNewSid] = useState("");
  const [creating, setCreating] = useState(false);

  // Twilio search
  const [showSearch, setShowSearch] = useState(false);
  const [searchCountry, setSearchCountry] = useState("US");
  const [searchType, setSearchType] = useState("local");
  const [searchContains, setSearchContains] = useState("");
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<TwilioCandidate[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Twilio import (Phase 3.5)
  const [showImport, setShowImport] = useState(false);
  const [importProvider, setImportProvider] = useState("twilio_pa");
  const [ownedNumbers, setOwnedNumbers] = useState<OwnedTwilioNumber[]>([]);
  const [loadingOwned, setLoadingOwned] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [hideAlreadyImported, setHideAlreadyImported] = useState(true);
  const [importAgentIds, setImportAgentIds] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState<string | null>(null);

  const notify = (type: "ok" | "err", text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 5000);
  };

  const fetchNumbers = useCallback(async () => {
    setLoading(true);
    try {
      setNumbers(await adminFetch<PhoneNumber[]>("/admin/phone-numbers"));
    } catch {
      notify("err", "Error cargando números telefónicos");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSources = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([
        adminFetch<AgentOption[]>("/admin/agents"),
        adminFetch<ClientOption[]>("/admin/clients"),
      ]);
      setAgents(Array.isArray(a) ? a : []);
      setClients(Array.isArray(c) ? c : []);
    } catch {
      // adminFetch already redirects to login on 401
    }
  }, []);

  useEffect(() => {
    fetchNumbers();
    fetchSources();
  }, [fetchNumbers, fetchSources]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNumber.trim()) {
      notify("err", "El número es requerido");
      return;
    }
    setCreating(true);
    try {
      await adminFetch("/admin/phone-numbers", {
        method: "POST",
        body: JSON.stringify({
          number: newNumber.trim(),
          label: newLabel.trim() || null,
          provider: newProvider,
          provider_sid: newSid.trim() || null,
        }),
      });
      notify("ok", "✅ Número agregado al catálogo");
      setNewNumber(""); setNewLabel(""); setNewProvider("manual"); setNewSid("");
      setShowCreate(false);
      await fetchNumbers();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al crear"}`);
    } finally {
      setCreating(false);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearching(true);
    setSearchError(null);
    setCandidates([]);
    try {
      const result = await adminFetch<TwilioCandidate[]>("/admin/phone-numbers/search", {
        method: "POST",
        body: JSON.stringify({
          country: searchCountry,
          type: searchType,
          contains: searchContains.trim() || undefined,
          page_size: 10,
        }),
      });
      setCandidates(Array.isArray(result) ? result : []);
      if (Array.isArray(result) && result.length === 0) {
        setSearchError("Sin resultados. Prueba otro país, tipo o patrón.");
      }
    } catch (err: unknown) {
      setSearchError(err instanceof Error ? err.message : "Error en la búsqueda");
    } finally {
      setSearching(false);
    }
  };

  const handleQuickAddFromCandidate = (c: TwilioCandidate) => {
    // Pre-fill the create form with the candidate number. Admin still has to
    // confirm — buying a Twilio number is a paid action and we don't want to
    // do it from the search result without an explicit "buy" call. For now,
    // the candidate just becomes a number you register manually after
    // purchasing through Twilio console.
    setNewNumber(c.phone_number);
    setNewProvider(searchCountry === "PA" ? "twilio_pa" : "twilio_us");
    setShowCreate(true);
    setShowSearch(false);
    notify("ok", `Número ${c.phone_number} listo para registrar (cómpralo primero en Twilio)`);
  };

  const handleLoadOwned = useCallback(async (provider: string) => {
    setLoadingOwned(true);
    setImportError(null);
    setOwnedNumbers([]);
    try {
      const result = await adminFetch<OwnedTwilioNumber[]>(
        `/admin/phone-numbers/owned?provider=${provider}&exclude_existing=true`
      );
      setOwnedNumbers(Array.isArray(result) ? result : []);
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : "Error al listar números de Twilio");
    } finally {
      setLoadingOwned(false);
    }
  }, []);

  useEffect(() => {
    if (showImport) {
      handleLoadOwned(importProvider);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
  }, [showImport, importProvider, handleLoadOwned]);

  const handleImport = async (n: OwnedTwilioNumber) => {
    const agentId = importAgentIds[n.incoming_phone_number_sid];
    setImporting(n.incoming_phone_number_sid);
    try {
      await adminFetch<{ status: string; phone_number: PhoneNumber }>(
        "/admin/phone-numbers/import",
        {
          method: "POST",
          body: JSON.stringify({
            incoming_phone_number_sid: n.incoming_phone_number_sid,
            provider: importProvider,
            agent_id: agentId && agentId !== "" ? agentId : null,
            label: n.friendly_name || n.phone_number,
          }),
        }
      );
      notify("ok", `✅ ${n.phone_number} importado y provisionado en LiveKit`);
      await fetchNumbers();
      await handleLoadOwned(importProvider);
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al importar"}`);
    } finally {
      setImporting(null);
    }
  };

  const handleProvision = async (n: PhoneNumber) => {
    if (!n.provider_sid) {
      notify("err", "Este número no tiene provider_sid — necesitas registrar el SID de Twilio primero");
      return;
    }
    setProvisioning(n.id);
    try {
      await adminFetch(`/admin/phone-numbers/${n.id}/provision`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      notify("ok", `✅ ${n.number} provisionado en LiveKit`);
      await fetchNumbers();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al provisionar"}`);
    } finally {
      setProvisioning(null);
    }
  };

  const handleAssignAgent = async (n: PhoneNumber, agentId: string) => {
    try {
      await adminFetch(`/admin/phone-numbers/${n.id}`, {
        method: "PATCH",
        body: JSON.stringify({ agent_id: agentId === "" ? null : agentId }),
      });
      await fetchNumbers();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al asignar agente"}`);
    }
  };

  const handleAssignClient = async (n: PhoneNumber, clientId: string) => {
    try {
      await adminFetch(`/admin/phone-numbers/${n.id}`, {
        method: "PATCH",
        body: JSON.stringify({ client_id: clientId === "" ? null : clientId }),
      });
      await fetchNumbers();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al asignar cliente"}`);
    }
  };

  const handleToggleActive = async (n: PhoneNumber) => {
    try {
      await adminFetch(`/admin/phone-numbers/${n.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !n.is_active }),
      });
      await fetchNumbers();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al actualizar"}`);
    }
  };

  const handleDelete = async (n: PhoneNumber) => {
    if (!confirm(`¿Eliminar ${n.number} del catálogo? Si hay un SIP trunk vinculado, perderá la referencia.`)) return;
    try {
      await adminFetch(`/admin/phone-numbers/${n.id}`, { method: "DELETE" });
      notify("ok", "✅ Número eliminado del catálogo");
      await fetchNumbers();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al eliminar"}`);
    }
  };

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-gray-400">
          Catálogo unificado de números telefónicos. Asigna cada número a un agente
          y/o cliente para enrutar llamadas entrantes y salientes.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setShowImport(!showImport); setShowSearch(false); setShowCreate(false); }}
            className="text-xs px-3 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 rounded-lg text-emerald-200 flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            Importar desde Twilio
          </button>
          <button
            onClick={() => { setShowSearch(!showSearch); setShowCreate(false); setShowImport(false); }}
            className="text-xs px-3 py-1.5 bg-white/[0.05] hover:bg-white/[0.08] border border-white/10 rounded-lg text-gray-200 flex items-center gap-1.5"
          >
            <Search className="w-3.5 h-3.5" />
            Buscar en Twilio
          </button>
          <button
            onClick={() => { setShowCreate(!showCreate); setShowSearch(false); setShowImport(false); }}
            className="text-xs px-3 py-1.5 bg-brand-pink hover:bg-brand-purple text-white rounded-lg flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            Registrar número
          </button>
        </div>
      </div>

      {msg && (
        <div className={`glass-panel border rounded-lg p-3 text-sm ${
          msg.type === "ok" ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300"
                             : "border-rose-400/30 bg-rose-500/10 text-rose-300"
        }`}>
          {msg.text}
        </div>
      )}

      {/* ── Create form ────────────────────────────────────────────── */}
      {showCreate && (
        <form onSubmit={handleCreate} className="glass-panel border border-white/10 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <PhoneCall className="w-4 h-4 text-brand-pink" />
            <h2 className="text-sm font-semibold text-white">Registrar número nuevo</h2>
          </div>
          <p className="text-[11px] text-gray-500">
            Compra el número en Twilio Console primero, luego regístralo aquí para
            que la plataforma lo pueda enrutar. El catálogo es global para todos
            los agentes/clientes.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-gray-400 mb-1">Número (E.164) *</label>
              <input
                value={newNumber}
                onChange={(e) => setNewNumber(e.target.value)}
                placeholder="+5072023503"
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/60 font-mono"
                required
              />
            </div>
            <div>
              <label className="block text-[11px] text-gray-400 mb-1">Etiqueta</label>
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Línea principal Panama"
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/60"
              />
            </div>
            <div>
              <label className="block text-[11px] text-gray-400 mb-1">Proveedor *</label>
              <select
                value={newProvider}
                onChange={(e) => setNewProvider(e.target.value)}
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-brand-pink/60"
              >
                <option value="manual">Manual (registro sin integración)</option>
                <option value="twilio_us">Twilio US</option>
                <option value="twilio_pa">Twilio Panamá</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-gray-400 mb-1">Twilio SID (opcional)</label>
              <input
                value={newSid}
                onChange={(e) => setNewSid(e.target.value)}
                placeholder="PNxxxx..."
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/60 font-mono"
              />
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 bg-brand-pink hover:bg-brand-purple disabled:opacity-50 rounded-lg text-sm font-medium flex items-center gap-1.5"
            >
              {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {creating ? "Registrando…" : "Registrar"}
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-lg text-sm"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {/* ── Twilio import (Phase 3.5) ──────────────────────────────── */}
      {showImport && (
        <div className="glass-panel border border-emerald-400/20 rounded-xl p-5 space-y-3 bg-emerald-500/[0.02]">
          <div className="flex items-center gap-2 mb-1">
            <Download className="w-4 h-4 text-emerald-300" />
            <h2 className="text-sm font-semibold text-white">Importar números ya comprados en Twilio</h2>
          </div>
          <p className="text-[11px] text-gray-500">
            Lista los números que ya tienes comprados en Twilio y los aprovisiona
            en LiveKit (trunk entrante + dispatch rule) en un solo paso. Cada
            número se adjunta al trunk SIP compartido de Twilio que apunta a
            nuestro servidor.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-gray-400">Cuenta</label>
              <select
                value={importProvider}
                onChange={(e) => setImportProvider(e.target.value)}
                className="bg-white/[0.05] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-400/60"
              >
                <option value="twilio_pa">Twilio Panamá</option>
                <option value="twilio_us">Twilio US</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-[11px] text-gray-300">
              <input
                type="checkbox"
                checked={hideAlreadyImported}
                onChange={(e) => setHideAlreadyImported(e.target.checked)}
                className="rounded"
              />
              Ocultar ya importados
            </label>
            <button
              onClick={() => handleLoadOwned(importProvider)}
              disabled={loadingOwned}
              className="text-xs px-3 py-1.5 bg-white/5 hover:bg-white/10 disabled:opacity-50 rounded-lg flex items-center gap-1.5"
            >
              {loadingOwned && <Loader2 className="w-3 h-3 animate-spin" />}
              Refrescar
            </button>
            <button
              onClick={() => { setShowImport(false); setOwnedNumbers([]); setImportError(null); }}
              className="ml-auto text-xs px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded-lg text-gray-400"
            >
              Cerrar
            </button>
          </div>

          {importError && (
            <p className="text-xs text-rose-300">❌ {importError}</p>
          )}

          {loadingOwned ? (
            <div className="text-center py-6 text-gray-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
              Cargando números de Twilio…
            </div>
          ) : ownedNumbers.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-4">
              {importError ? "" : "No hay números en esta cuenta (o no se pudieron listar)."}
            </p>
          ) : (
            <div className="space-y-2 max-h-[420px] overflow-y-auto">
              {ownedNumbers
                .filter((n) => (hideAlreadyImported ? !n.already_imported : true))
                .map((n) => {
                  const selectedAgent = importAgentIds[n.incoming_phone_number_sid] ?? "";
                  const isImporting = importing === n.incoming_phone_number_sid;
                  return (
                    <div
                      key={n.incoming_phone_number_sid}
                      className="flex items-center justify-between gap-3 bg-white/[0.02] border border-white/5 rounded-lg p-3 flex-wrap"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-mono text-gray-100">{n.phone_number}</p>
                          {n.friendly_name && (
                            <span className="text-[10px] text-gray-500">{n.friendly_name}</span>
                          )}
                          {n.already_imported && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/20">
                              ✓ Ya importado
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-gray-600 mt-0.5 font-mono">
                          SID: {n.incoming_phone_number_sid}
                        </p>
                        {n.capabilities && (
                          <p className="text-[10px] text-gray-500 mt-0.5">
                            {n.capabilities.voice && "📞 voz "}
                            {n.capabilities.sms && "📱 sms "}
                            {n.capabilities.mms && "📨 mms"}
                          </p>
                        )}
                      </div>
                      {!n.already_imported && (
                        <div className="flex items-center gap-2">
                          <select
                            value={selectedAgent}
                            onChange={(e) =>
                              setImportAgentIds((prev) => ({
                                ...prev,
                                [n.incoming_phone_number_sid]: e.target.value,
                              }))
                            }
                            className="bg-white/[0.05] border border-white/10 rounded-lg px-2 py-1 text-xs text-white w-44 focus:outline-none focus:border-emerald-400/60"
                          >
                            <option value="">— Sin agente —</option>
                            {agents.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}{a.is_active ? "" : " (inactivo)"}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => handleImport(n)}
                            disabled={isImporting}
                            className="text-xs px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 disabled:opacity-50 text-emerald-100 rounded-lg flex items-center gap-1.5 shrink-0"
                          >
                            {isImporting && <Loader2 className="w-3 h-3 animate-spin" />}
                            {isImporting ? "Importando…" : "Importar"}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}

      {/* ── Twilio search ──────────────────────────────────────────── */}
      {showSearch && (
        <form onSubmit={handleSearch} className="glass-panel border border-white/10 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-4 h-4 text-fuchsia-300" />
            <h2 className="text-sm font-semibold text-white">Buscar números disponibles en Twilio</h2>
          </div>
          <p className="text-[11px] text-gray-500">
            Vista previa de números disponibles. Esta búsqueda no compra nada —
            solo te muestra candidatos. Para adquirir uno, cómpralo en Twilio
            Console y luego regístralo aquí.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-[11px] text-gray-400 mb-1">País (ISO)</label>
              <input
                value={searchCountry}
                onChange={(e) => setSearchCountry(e.target.value.toUpperCase())}
                placeholder="US"
                maxLength={2}
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/60 font-mono uppercase"
              />
            </div>
            <div>
              <label className="block text-[11px] text-gray-400 mb-1">Tipo</label>
              <select
                value={searchType}
                onChange={(e) => setSearchType(e.target.value)}
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-brand-pink/60"
              >
                <option value="local">Local</option>
                <option value="tollfree">Toll-free</option>
                <option value="mobile">Mobile</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-[11px] text-gray-400 mb-1">Contiene (dígitos)</label>
              <input
                value={searchContains}
                onChange={(e) => setSearchContains(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="2023"
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/60 font-mono"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={searching}
              className="px-4 py-2 bg-fuchsia-500/20 hover:bg-fuchsia-500/30 disabled:opacity-50 text-fuchsia-100 rounded-lg text-sm flex items-center gap-1.5"
            >
              {searching && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {searching ? "Buscando…" : "Buscar"}
            </button>
            <button
              type="button"
              onClick={() => { setShowSearch(false); setCandidates([]); setSearchError(null); }}
              className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-lg text-sm"
            >
              Cerrar
            </button>
          </div>

          {searchError && (
            <p className="text-xs text-rose-300">{searchError}</p>
          )}

          {candidates.length > 0 && (
            <div className="space-y-2 mt-2">
              {candidates.map((c) => (
                <div
                  key={c.phone_number}
                  className="flex items-center justify-between bg-white/[0.02] border border-white/5 rounded-lg p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-mono text-gray-100">{c.phone_number}</p>
                      <span className="text-[10px] text-gray-500">{c.friendly_name}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      {[c.locality, c.region, c.iso_country].filter(Boolean).join(", ") || "—"}
                      {c.capabilities && (
                        <span className="ml-2 text-[10px] text-gray-600">
                          {c.capabilities.voice && "📞 voz "}
                          {c.capabilities.sms && "📱 sms "}
                          {c.capabilities.mms && "📨 mms"}
                        </span>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={() => handleQuickAddFromCandidate(c)}
                    className="text-xs px-3 py-1.5 bg-white/[0.05] hover:bg-white/[0.08] border border-white/10 rounded-lg text-gray-200 flex items-center gap-1.5 shrink-0"
                  >
                    <Plus className="w-3 h-3" />
                    Registrar
                  </button>
                </div>
              ))}
            </div>
          )}
        </form>
      )}

      {/* ── Numbers list ───────────────────────────────────────────── */}
      {loading ? (
        <div className="text-center py-12 text-gray-500 text-sm">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
          Cargando…
        </div>
      ) : numbers.length === 0 ? (
        <div className="glass-panel border border-white/10 rounded-xl p-12 text-center">
          <PhoneCall className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 text-sm mb-2">No hay números registrados aún.</p>
          <p className="text-xs text-gray-600">
            Cómpralos en Twilio Console y luego regístralos aquí con{" "}
            <span className="text-fuchsia-300">"Registrar número"</span>, o busca
            candidatos con{" "}
            <span className="text-fuchsia-300">"Buscar en Twilio"</span>.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {numbers.map((n) => (
            <div
              key={n.id}
              className="glass-panel border border-white/10 rounded-xl p-4 flex items-center gap-4 flex-wrap"
            >
              {/* Number + provider + label */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-mono font-semibold text-gray-100">{n.number}</p>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${PROVIDER_STYLES[n.provider] ?? "bg-white/5 text-gray-400 border-white/10"}`}>
                    {PROVIDER_LABELS[n.provider] ?? n.provider}
                  </span>
                  {/* Phase 3.5 LiveKit provisioning status */}
                  {n.lk_dispatch_rule_id ? (
                    <span
                      title={`Inbound: ${n.lk_inbound_trunk_id ?? "?"}\nDispatch: ${n.lk_dispatch_rule_id}\nTwilio trunk: ${n.twilio_trunk_sid ?? "?"}`}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/20 flex items-center gap-1 cursor-help"
                    >
                      <Wifi className="w-3 h-3" />
                      LiveKit
                    </span>
                  ) : n.provider_sid && n.provider !== "manual" ? (
                    <span
                      title="Este número tiene SID de Twilio pero no está provisionado en LiveKit. Pulsa 'Provisionar' para crear el inbound trunk + dispatch rule."
                      className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/20 flex items-center gap-1 cursor-help"
                    >
                      <WifiOff className="w-3 h-3" />
                      Sin provisionar
                    </span>
                  ) : null}
                  {!n.is_active && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700/40 text-gray-400 border border-gray-600/30">
                      inactivo
                    </span>
                  )}
                </div>
                {n.label && <p className="text-xs text-gray-400 mt-1">{n.label}</p>}
                {n.provider_sid && (
                  <p className="text-[10px] text-gray-600 font-mono mt-0.5">SID: {n.provider_sid}</p>
                )}
              </div>

              {/* Agent assignment */}
              <div className="w-44">
                <label className="block text-[10px] text-gray-500 mb-1">Agente</label>
                <select
                  value={n.agent_id ?? ""}
                  onChange={(e) => handleAssignAgent(n, e.target.value)}
                  className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-brand-pink/60"
                >
                  <option value="">— Sin asignar —</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}{a.is_active ? "" : " (inactivo)"}
                    </option>
                  ))}
                </select>
                {n.agents && (
                  <p className="text-[10px] text-emerald-400 mt-1">✓ {n.agents.name}</p>
                )}
              </div>

              {/* Client assignment */}
              <div className="w-44">
                <label className="block text-[10px] text-gray-500 mb-1">Cliente</label>
                <select
                  value={n.client_id ?? ""}
                  onChange={(e) => handleAssignClient(n, e.target.value)}
                  className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-brand-pink/60"
                >
                  <option value="">— Sin asignar —</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                {n.clients && (
                  <p className="text-[10px] text-emerald-400 mt-1">✓ {n.clients.name}</p>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1.5 shrink-0">
                {!n.lk_dispatch_rule_id && n.provider_sid && n.provider !== "manual" && (
                  <button
                    onClick={() => handleProvision(n)}
                    disabled={provisioning === n.id}
                    title="Crear inbound trunk + dispatch rule en LiveKit"
                    className="text-[10px] px-2 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 border border-emerald-500/20 flex items-center gap-1 disabled:opacity-50"
                  >
                    {provisioning === n.id ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Wifi className="w-3 h-3" />
                    )}
                    Provisionar
                  </button>
                )}
                <button
                  onClick={() => handleToggleActive(n)}
                  title={n.is_active ? "Desactivar" : "Activar"}
                  className="p-1.5 rounded-lg text-gray-400 hover:bg-white/5 hover:text-white transition-colors"
                >
                  {n.is_active ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <XCircle className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => handleDelete(n)}
                  title="Eliminar del catálogo"
                  className="p-1.5 rounded-lg text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-[10px] text-gray-600 text-center pt-2">
        Tip: usa <span className="text-emerald-300">Importar desde Twilio</span> para
        tomar un número que ya compraste y provisionarlo en LiveKit (inbound trunk +
        dispatch rule) en un solo paso. Los números marcados como{" "}
        <span className="text-amber-300">Sin provisionar</span> ya están en Twilio
        pero les falta la conexión a LiveKit — pulsa{" "}
        <span className="text-emerald-300">Provisionar</span> para completarla.
      </p>
    </div>
  );
}

export default function PhoneNumbersPage() {
  return (
    <AdminAuthGuard>
      <AppShell
        title="Números Telefónicos"
        description="Catálogo unificado de números (Twilio u otros)"
      >
        <PhoneNumbersContent />
      </AppShell>
    </AdminAuthGuard>
  );
}