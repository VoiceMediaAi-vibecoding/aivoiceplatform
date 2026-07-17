"use client";

import { useState } from "react";
import { Phone, Loader2, X, Check } from "lucide-react";
import { api } from "@/lib/api";

interface Props {
  agentId: string;
  agentName: string;
  onClose: () => void;
  onAdded: () => void;
}

/**
 * Modal for adding a phone number to a voice agent. Calls
 * POST /admin/agents/{id}/phone-numbers, which is idempotent — re-running
 * with the same number is a safe no-op. The dashboard's existing list of
 * numbers updates via the `onAdded` callback so the operator sees the new
 * number immediately.
 */
export default function PhoneNumberModal({ agentId, agentName, onClose, onAdded }: Props) {
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!number.startsWith("+")) {
      setError("El número debe estar en formato E.164 (ej. +16089461249)");
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.addAgentPhoneNumber(agentId, number, name || undefined);
      if (result?.trunk_id) {
        onAdded();
        onClose();
        return;
      }
      setError("La API no devolvió un resultado válido");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error desconocido al agregar el número");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#0f172a] border border-white/10 rounded-2xl shadow-2xl max-w-md w-full">
        <div className="flex justify-between items-center px-5 py-4 border-b border-white/10">
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <Phone className="w-4 h-4 text-emerald-400" />
            Agregar número a {agentName}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={submit} className="px-5 py-4 space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Número (formato E.164, ej. +16089461249)</label>
            <input
              type="tel"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="+16089461249"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-emerald-400"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Nombre (opcional)</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Camila - oficina NJ"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-400"
            />
          </div>

          {error && (
            <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-400/20 rounded-lg px-3 py-2">
              ❌ {error}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-3 py-2 rounded-lg text-sm bg-white/5 hover:bg-white/10 text-gray-300 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting || !number}
              className="flex-1 px-3 py-2 rounded-lg text-sm bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white font-medium transition-colors flex items-center justify-center gap-1.5"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              {submitting ? "Agregando..." : "Agregar"}
            </button>
          </div>

          <p className="text-[11px] text-gray-500 pt-1">
            Se crea el inbound trunk + dispatch rule automáticamente. Si el número
            ya está, no se duplica — es idempotente.
          </p>
        </form>
      </div>
    </div>
  );
}
