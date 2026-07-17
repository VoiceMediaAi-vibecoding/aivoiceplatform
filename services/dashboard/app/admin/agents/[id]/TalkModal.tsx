"use client";

import { useCallback, useState } from "react";
import {
  LiveKitRoom,
  VoiceAssistantControlBar,
  RoomAudioRenderer,
  useVoiceAssistant,
  BarVisualizer,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { Loader2, Mic, X, AlertTriangle, AlertOctagon } from "lucide-react";
import { adminFetch } from "@/lib/admin-auth";

interface TokenData {
  token: string;
  room_name: string;
  identity: string;
  livekit_url: string;
}

interface Props {
  agentId: string;
  agentName: string;
  isActive: boolean;
  onClose: () => void;
}

/**
 * Modal that opens a live audio session with a single agent.
 *
 * - Fetches a LiveKit join token + pre-dispatched room from
 *   `/admin/agents/{id}/talk-token` (server creates the room with the agent's
 *   RoomAgentDispatch metadata so the worker loads THIS agent's config).
 * - Uses @livekit/components-react primitives (BarVisualizer +
 *   VoiceAssistantControlBar) — same pattern as the standalone /agent page.
 * - Closes cleanly: the LiveKitRoom unmount triggers a disconnect; the room
 *   auto-cleans up via its `empty_timeout` of 5 min.
 *
 * Mixed content caveat: the browser blocks ws:// connections from HTTPS pages,
 * so the server's `LIVEKIT_PUBLIC_URL` MUST be wss:// in production. We detect
 * this on the fly and surface a clear, actionable error instead of a silent
 * "nothing happens" experience.
 */
export default function TalkModal({ agentId, agentName, isActive, onClose }: Props) {
  const [tokenData, setTokenData] = useState<TokenData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lkError, setLkError] = useState<string | null>(null);

  const isHttpsPage = typeof window !== "undefined" && window.location.protocol === "https:";
  const isInsecureLk = tokenData ? tokenData.livekit_url.startsWith("ws://") : false;
  const mixedContentBlocked = isHttpsPage && isInsecureLk;

  const connect = useCallback(async () => {
    setLoading(true);
    setError(null);
    setLkError(null);
    try {
      const data = await adminFetch<TokenData>(
        `/admin/agents/${agentId}/talk-token`,
        { method: "POST" },
      );
      setTokenData(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "No se pudo iniciar la conversación");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  const handleClose = useCallback(() => {
    setTokenData(null);
    setLkError(null);
    onClose();
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="bg-gray-900 border border-white/10 rounded-2xl w-full max-w-md p-6 relative shadow-2xl">
        <button
          onClick={handleClose}
          className="absolute top-3 right-3 w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          aria-label="Cerrar"
        >
          <X className="w-4 h-4" />
        </button>

        <h2 className="text-lg font-semibold text-gray-100 mb-1">
          Hablar con {agentName}
        </h2>
        <p className="text-xs text-gray-500 mb-5">
          El agente usará su config actual (prompt, voz, tools, knowledge).
        </p>

        {!isActive && (
          <div className="mb-4 p-2.5 rounded-lg bg-amber-500/10 border border-amber-400/20 text-amber-200 text-xs flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>Este agente está pausado. Puedes probarlo igualmente, pero no recibirá llamadas de campañas.</span>
          </div>
        )}

        {error && (
          <p className="text-rose-300 text-sm mb-4 p-2.5 rounded bg-rose-500/10 border border-rose-400/20 flex items-start gap-2">
            <AlertOctagon className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        {lkError && (
          <p className="text-rose-300 text-sm mb-4 p-2.5 rounded bg-rose-500/10 border border-rose-400/20 flex items-start gap-2">
            <AlertOctagon className="w-4 h-4 mt-0.5 shrink-0" />
            <span><strong>Conexión LiveKit falló:</strong> {lkError}</span>
          </p>
        )}

        {!tokenData ? (
          <div className="flex flex-col items-center gap-5 py-4">
            <div className="w-20 h-20 rounded-full bg-brand-pink/20 flex items-center justify-center">
              <Mic className="w-9 h-9 text-brand-pink" />
            </div>
            <button
              onClick={connect}
              disabled={loading}
              className="px-6 py-2.5 bg-brand-pink hover:bg-brand-purple disabled:opacity-50 rounded-full text-sm font-medium transition-colors flex items-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {loading ? "Conectando…" : "🎙 Iniciar conversación"}
            </button>
            <p className="text-[10px] text-gray-600 text-center max-w-xs">
              Necesitarás permitir el acceso al micrófono cuando tu navegador lo solicite.
            </p>
          </div>
        ) : mixedContentBlocked ? (
          <div className="p-4 rounded-lg bg-rose-500/10 border border-rose-400/30 space-y-3">
            <div className="flex items-start gap-2 text-rose-200">
              <AlertOctagon className="w-5 h-5 mt-0.5 shrink-0" />
              <div className="text-sm">
                <p className="font-semibold mb-1">Configuración insegura (mixed content)</p>
                <p className="text-rose-300/90 text-xs leading-relaxed">
                  El dashboard se sirve por HTTPS pero el servidor LiveKit está configurado como
                  <code className="mx-1 px-1 py-0.5 rounded bg-black/40 text-rose-200">{tokenData.livekit_url}</code>
                  (inseguro). El navegador bloquea esta conexión.
                </p>
              </div>
            </div>
            <div className="text-[11px] text-rose-200/80 bg-black/30 rounded p-2.5 leading-relaxed">
              <strong className="text-rose-100">Fix (servidor):</strong>{" "}
              configura un proxy WSS (Caddy / nginx) frente al puerto 7880 y define
              <code className="mx-1 px-1 py-0.5 rounded bg-black/40">LIVEKIT_PUBLIC_URL=wss://tu-host</code>
              en <code className="mx-1 px-1 py-0.5 rounded bg-black/40">.env</code>.
            </div>
            <button
              onClick={handleClose}
              className="w-full text-xs text-gray-300 hover:text-white underline"
            >
              Cerrar
            </button>
          </div>
        ) : (
          <LiveKitRoom
            serverUrl={tokenData.livekit_url}
            token={tokenData.token}
            connect
            audio
            onError={(err) => {
              console.error("[TalkModal] LiveKit error:", err);
              setLkError(err?.message || String(err));
            }}
            onDisconnected={() => {
              setTokenData(null);
              setLkError(null);
            }}
            className="flex flex-col items-center gap-4"
          >
            <BarVisualizerTrack />
            <VoiceAssistantControlBar controls={{ leave: false }} />
            <RoomAudioRenderer />
            <p className="text-[10px] text-gray-600 font-mono mt-1">
              Sala: {tokenData.room_name}
            </p>
            <p className="text-[9px] text-gray-700 font-mono -mt-2">
              {tokenData.livekit_url}
            </p>
            <button
              onClick={handleClose}
              className="text-xs text-gray-400 hover:text-gray-200 underline mt-1"
            >
              Terminar y cerrar
            </button>
          </LiveKitRoom>
        )}
      </div>
    </div>
  );
}

function BarVisualizerTrack() {
  const { state, audioTrack } = useVoiceAssistant();
  return (
    <div className="flex flex-col items-center gap-2 py-2">
      <BarVisualizer
        state={state}
        trackRef={audioTrack}
        style={{ width: 280, height: 64 }}
        barCount={28}
      />
      <p className="text-xs text-gray-500 capitalize">{state}</p>
    </div>
  );
}
