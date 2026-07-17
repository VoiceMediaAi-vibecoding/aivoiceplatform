import { getApiBaseUrl } from "./api-config";

const API_URL = getApiBaseUrl();

export interface CostSummary {
  total_usd: number;
  by_provider: Record<string, number>;
}

export interface DailyPoint {
  date: string;
  cost_usd: number;
}

export interface AgentCostStats {
  agent_id: string;
  total_cost_usd: number;
  session_count: number;
  avg_cost_per_min: number;
  total_minutes: number;
  by_provider: Record<string, number>;
  daily: DailyPoint[];
}

export interface Session {
  id: string;
  started_at: string;
  ended_at: string | null;
  total_cost_usd: number;
  cost_by_provider: Record<string, number>;
  room_name: string | null;
  identity: string | null;
}

export interface UsageRecord {
  id: number;
  session_id: string;
  provider: string;
  model: string;
  metric_type: string;
  metric_value: number;
  cost_usd: number;
  timestamp: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { next: { revalidate: 30 } });
  if (!res.ok) throw new Error(`API ${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

export interface PhoneNumberRow {
  trunk_id: string;
  name: string;
  numbers: string[];
  rule_id: string | null;
}

export interface AddPhoneNumberResult {
  agent_id: string;
  trunk_id: string;
  dispatch_rule_id: string;
  created_trunk: boolean;
  created_rule: boolean;
  number: string;
}

export const api = {
  costSummary: () => get<CostSummary>("/costs/summary"),
  dailyCosts: () => get<DailyPoint[]>("/costs/daily"),
  agentCostStats: (agentId: string) =>
    get<AgentCostStats>(`/admin/agents/${agentId}/cost-stats`),
  agentPhoneNumbers: (agentId: string) =>
    get<PhoneNumberRow[]>(`/admin/agents/${agentId}/phone-numbers`),
  addAgentPhoneNumber: (agentId: string, number: string, name?: string) =>
    fetch(`${API_URL}/admin/agents/${agentId}/phone-numbers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number, name: name ?? null }),
    }).then((r) => r.json() as Promise<AddPhoneNumberResult>),
  sessions: (limit = 50) => get<Session[]>(`/sessions?limit=${limit}`),
  token: (identity?: string, roomName?: string) =>
    fetch(`${API_URL}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity, room_name: roomName }),
    }).then((r) => r.json()),
};
