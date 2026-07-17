"use client";

import { useState, useRef, useEffect } from "react";
import { CheckCircle2, XCircle, FlaskConical, ChevronDown, ChevronRight, Clock } from "lucide-react";
import { adminFetch } from "@/lib/admin-auth";
import { type TabProps, inputClass } from "./types";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  tool_calls?: ToolCallResult[];
}

interface ToolCallResult {
  name: string;
  arguments: Record<string, unknown>;
  status: number;
  ok: boolean;
  latency_ms?: number;
  body_preview?: string;
  error?: string | null;
}

/**
 * "Playground" tab — VAPI-style "talk to assistant" sandbox. Runs the agent's
 * *current saved* prompt + knowledge base + tools through its configured LLM
 * as a text chat. When the LLM invokes a webhook tool, the request actually
 * fires (so admins can verify end-to-end connectivity) and the call is
 * displayed inline below the assistant message.
 */
export default function PlaygroundTab({ agent, agentId, notify }: TabProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const reset = () => setMessages([]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setInput("");
    setSending(true);
    try {
      const res = await adminFetch<{
        reply: string;
        usage: Record<string, number>;
        tool_calls: ToolCallResult[];
      }>(`/admin/agents/${agentId}/playground`, {
        method: "POST",
        body: JSON.stringify({ messages: next }),
      });
      setMessages([
        ...next,
        {
          role: "assistant",
          content: res.reply || "(sin respuesta)",
          tool_calls: res.tool_calls ?? [],
        },
      ]);
      // Toast when tools fire
      if (res.tool_calls && res.tool_calls.length > 0) {
        const successCount = res.tool_calls.filter((t) => t.ok).length;
        if (successCount === res.tool_calls.length) {
          notify("ok", `✅ ${successCount} tool(s) ejecutado(s)`);
        } else {
          notify(
            "err",
            `❌ ${res.tool_calls.length - successCount} tool(s) fallaron`
          );
        }
      }
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error en el playground"}`);
      setMessages(next); // keep the user's message even if the reply failed
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const totalToolCalls = messages.reduce(
    (acc, m) => acc + (m.tool_calls?.length ?? 0),
    0
  );
  const successToolCalls = messages.reduce(
    (acc, m) => acc + (m.tool_calls?.filter((t) => t.ok).length ?? 0),
    0
  );

  return (
    <div className="max-w-3xl flex flex-col h-[600px]">
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-200">Probar al agente</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Chat de texto contra el prompt + modelo <span className="font-mono">{agent.llm_model}</span> + tools.
            Las herramientas se ejecutan de verdad (webhook POST incluido) — confirma que llega a n8n.
          </p>
        </div>
        {totalToolCalls > 0 && (
          <div
            className={`shrink-0 text-[10px] px-2 py-1 rounded border ${
              successToolCalls === totalToolCalls
                ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                : "bg-amber-500/10 text-amber-300 border-amber-500/30"
            }`}
          >
            🧪 {successToolCalls}/{totalToolCalls} tools OK
          </div>
        )}
        {messages.length > 0 && (
          <button
            onClick={reset}
            className="text-xs px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded-lg transition-colors shrink-0"
          >
            🔄 Reiniciar
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto bg-black/20 border border-white/10 rounded-xl p-4 space-y-3">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-center">
            <div>
              <p className="text-sm text-gray-400">👋 Empieza la conversación como lo haría un cliente</p>
              <p className="text-xs text-gray-600 mt-1">
                El agente responderá usando su prompt, modelo, KB y tools guardados.
              </p>
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <MessageBubble
              key={i}
              message={m}
              agentName={agent.name}
              toolCount={m.tool_calls?.length ?? 0}
              successCount={m.tool_calls?.filter((t) => t.ok).length ?? 0}
            />
          ))
        )}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-white/10 text-gray-400 rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm">
              <span className="inline-flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" />
              </span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex gap-2 mt-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Escribe como si fueras el cliente… (Enter para enviar, Shift+Enter para nueva línea)"
          className={`${inputClass} resize-none`}
        />
        <button
          onClick={send}
          disabled={!input.trim() || sending}
          className="px-5 bg-brand-pink hover:bg-brand-purple disabled:opacity-40 rounded-lg text-sm font-medium transition-colors shrink-0"
        >
          Enviar
        </button>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  agentName,
  toolCount,
  successCount,
}: {
  message: ChatMessage;
  agentName: string;
  toolCount: number;
  successCount: number;
}) {
  const isUser = message.role === "user";
  const hasTools = toolCount > 0;
  const allToolsOk = successCount === toolCount;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} flex-col gap-1.5`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
          isUser
            ? "bg-brand-pink text-white rounded-br-sm"
            : "bg-white/10 text-gray-100 rounded-bl-sm"
        }`}
      >
        {!isUser && (
          <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-0.5">{agentName}</p>
        )}
        {message.content}
      </div>

      {/* Inline tool-call log — only on assistant messages that triggered tools */}
      {!isUser && hasTools && (
        <div
          className={`max-w-[80%] rounded-2xl rounded-tl-sm border px-3 py-2 text-xs space-y-1.5 ${
            allToolsOk
              ? "bg-emerald-950/30 border-emerald-500/30"
              : "bg-rose-950/30 border-rose-500/30"
          }`}
        >
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider font-semibold">
            {allToolsOk ? (
              <>
                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                <span className="text-emerald-300">
                  {toolCount} tool{toolCount === 1 ? "" : "s"} ejecutado{toolCount === 1 ? "" : "s"}
                </span>
              </>
            ) : (
              <>
                <XCircle className="w-3 h-3 text-rose-400" />
                <span className="text-rose-300">
                  {successCount}/{toolCount} OK
                </span>
              </>
            )}
          </div>
          {message.tool_calls!.map((tc, i) => (
            <ToolCallCard key={i} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallCard({ toolCall: tc }: { toolCall: ToolCallResult }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-md bg-black/30 border border-white/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {tc.ok ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          ) : (
            <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
          )}
          <FlaskConical className="w-3 h-3 text-cyan-300 shrink-0" />
          <span className="font-mono text-cyan-200 truncate">{tc.name}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {tc.latency_ms != null && (
            <span className="text-[10px] text-gray-500 flex items-center gap-0.5">
              <Clock className="w-2.5 h-2.5" />
              {tc.latency_ms}ms
            </span>
          )}
          {tc.status > 0 && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                tc.ok
                  ? "bg-emerald-500/20 text-emerald-200"
                  : "bg-rose-500/20 text-rose-200"
              }`}
            >
              {tc.status}
            </span>
          )}
          {expanded ? (
            <ChevronDown className="w-3 h-3 text-gray-500" />
          ) : (
            <ChevronRight className="w-3 h-3 text-gray-500" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-white/5 px-2.5 py-2 space-y-2 bg-black/20">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
              Argumentos
            </p>
            <pre className="text-[10px] font-mono text-gray-200 bg-black/40 rounded px-2 py-1.5 overflow-x-auto">
              {Object.keys(tc.arguments).length > 0
                ? JSON.stringify(tc.arguments, null, 2)
                : "(vacío)"}
            </pre>
          </div>
          {tc.body_preview && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
                Respuesta del webhook
              </p>
              <pre className="text-[10px] font-mono text-gray-200 bg-black/40 rounded px-2 py-1.5 overflow-x-auto max-h-32">
                {tc.body_preview}
              </pre>
            </div>
          )}
          {tc.error && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-rose-400 mb-1">Error</p>
              <pre className="text-[10px] font-mono text-rose-200 bg-rose-950/40 rounded px-2 py-1.5 overflow-x-auto">
                {tc.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}