import AdminAuthGuard from "@/app/admin/AdminAuthGuard";
import AppShell from "@/components/AppShell";
import GlassCard from "@/components/ui/GlassCard";

export default function SettingsPage() {
  return (
    <AdminAuthGuard>
    <AppShell title="Configuración" description="Parámetros del agente y referencia de costos por proveedor">
      <div className="max-w-2xl space-y-6">
        <GlassCard className="p-6 space-y-6">
          <Setting
            label="Modelo LLM"
            envKey="LLM_MODEL"
            defaultVal="gpt-4o"
            options={["gpt-4o", "gpt-4o-mini"]}
          />
          <Setting
            label="Modelo STT"
            envKey="STT_MODEL"
            defaultVal="nova-3"
            options={["nova-3", "nova-2"]}
          />
          <Setting
            label="Modelo TTS"
            envKey="TTS_MODEL"
            defaultVal="eleven_turbo_v2_5"
            options={["eleven_turbo_v2_5", "eleven_flash_v2_5", "eleven_multilingual_v2"]}
          />
        </GlassCard>

        <p className="text-gray-500 text-sm">
          Los cambios a la configuración del modelo requieren reiniciar el servicio del agente.
          Actualiza los valores en tu archivo <code className="text-gray-400 bg-white/5 px-1.5 py-0.5 rounded">.env</code>.
        </p>

        <GlassCard className="p-6">
          <h2 className="text-sm font-semibold text-gray-200 mb-1">Referencia de precios de API</h2>
          <p className="text-xs text-gray-500 mb-4">Tarifas vigentes usadas para calcular el costo por sesión</p>
          <table className="w-full text-sm text-gray-400">
            <thead>
              <tr className="text-gray-300 text-left text-xs uppercase tracking-wide">
                <th className="pb-2 font-medium">Proveedor</th>
                <th className="pb-2 font-medium">Modelo</th>
                <th className="pb-2 font-medium">Tarifa</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              <PriceRow p="OpenAI" m="gpt-4o" r="$2.50/1M input · $10/1M output" />
              <PriceRow p="OpenAI" m="gpt-4o-mini" r="$0.15/1M input · $0.60/1M output" />
              <PriceRow p="Deepgram" m="nova-3" r="$0.0043/min" />
              <PriceRow p="ElevenLabs" m="eleven_turbo_v2_5" r="$0.18/1K chars" />
              <PriceRow p="ElevenLabs" m="eleven_flash_v2_5" r="$0.11/1K chars" />
            </tbody>
          </table>
          <p className="text-xs text-gray-600 mt-3">
            Actualiza los precios en <code className="bg-white/5 px-1.5 py-0.5 rounded">services/agent/src/cost_logger.py</code> → constante PRICING.
          </p>
        </GlassCard>
      </div>
    </AppShell>
    </AdminAuthGuard>
  );
}

function Setting({
  label,
  envKey,
  defaultVal,
  options,
}: {
  label: string;
  envKey: string;
  defaultVal: string;
  options: string[];
}) {
  return (
    <div>
      <label className="block text-sm text-gray-400 mb-1.5">{label}</label>
      <div className="flex gap-2 items-center">
        <select
          disabled
          defaultValue={defaultVal}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm flex-1 text-gray-300 opacity-60 cursor-not-allowed"
        >
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <code className="text-xs text-gray-600 bg-white/5 px-2 py-1 rounded">{envKey}</code>
      </div>
    </div>
  );
}

function PriceRow({ p, m, r }: { p: string; m: string; r: string }) {
  return (
    <tr>
      <td className="py-2 text-gray-300">{p}</td>
      <td className="py-2 font-mono text-xs">{m}</td>
      <td className="py-2">{r}</td>
    </tr>
  );
}
