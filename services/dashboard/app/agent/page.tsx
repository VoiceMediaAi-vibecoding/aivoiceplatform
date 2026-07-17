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
import { api } from "@/lib/api";

interface TokenData {
  token: string;
  room_name: string;
  identity: string;
  livekit_url: string;
}

export default function AgentPage() {
  const [tokenData, setTokenData] = useState<TokenData | null>(null);
  const [connecting, setConnecting] = useState(false);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const data = await api.token();
      setTokenData(data as TokenData);
    } finally {
      setConnecting(false);
    }
  }, []);

  if (!tokenData) {
    return (
      <main className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center gap-6">
        <h1 className="text-2xl font-bold">Talk to the Voice Agent</h1>
        <p className="text-gray-400 text-sm">
          Powered by Deepgram · GPT-4o · ElevenLabs
        </p>
        <button
          onClick={connect}
          disabled={connecting}
          className="px-8 py-3 bg-brand-pink hover:bg-brand-purple disabled:opacity-50 rounded-full text-white font-medium transition-colors"
        >
          {connecting ? "Connecting…" : "Start Conversation"}
        </button>
      </main>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={tokenData.livekit_url}
      token={tokenData.token}
      connect
      audio
      className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center gap-6"
    >
      <h1 className="text-2xl font-bold">Voice Agent</h1>
      <p className="text-gray-400 text-sm">Room: {tokenData.room_name}</p>
      <AgentVisualizer />
      <VoiceAssistantControlBar />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

function AgentVisualizer() {
  const { state, audioTrack } = useVoiceAssistant();
  return (
    <div className="flex flex-col items-center gap-3">
      <BarVisualizer
        state={state}
        trackRef={audioTrack}
        style={{ width: 320, height: 80 }}
        barCount={32}
      />
      <p className="text-sm text-gray-500 capitalize">{state}</p>
    </div>
  );
}
