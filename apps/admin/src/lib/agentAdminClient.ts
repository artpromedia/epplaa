/**
 * Thin fetch client for the agent-service admin API.
 *
 * The agent-service's /admin/prompts endpoints are gated by a static
 * Bearer token (AGENT_ADMIN_TOKEN) — they are NOT part of the monolith
 * OpenAPI spec, so we cannot use the generated @workspace/api-client-react
 * hooks. To keep the operator UX in one place we let an admin paste the
 * token into the Prompts page; the value is held in sessionStorage so it
 * survives within-tab navigation but never leaks to disk.
 *
 * Threat model:
 * - Token is a high-trust break-glass credential. Storing it in
 *   sessionStorage (not localStorage) means a closed tab clears it.
 * - The token MUST never be logged or sent to anywhere other than the
 *   configured base URL — every helper here goes through `agentAdminFetch`.
 * - Base URL is read from VITE_AGENT_ADMIN_BASE_URL (build-time). Falling
 *   back to "/agent-admin" lets a Vite proxy (or an api-gateway route)
 *   forward to the agent-service in dev/prod.
 */

const TOKEN_STORAGE_KEY = "agent-admin-token";
const BASE_URL =
  (import.meta.env.VITE_AGENT_ADMIN_BASE_URL as string | undefined)?.replace(
    /\/$/,
    "",
  ) ?? "/agent-admin";

export interface PromptAdminRow {
  ref: string;
  family: string;
  version: string;
  systemPrompt: string;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  activatedAt: string | null;
}

export interface CreatePromptInput {
  ref: string;
  family: string;
  version: string;
  systemPrompt: string;
  createdBy?: string;
}

export function getAgentAdminToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    // SSR / privacy-mode fallback — feature simply degrades to "no token".
    return null;
  }
}

export function setAgentAdminToken(token: string | null): void {
  try {
    if (token === null || token === "") {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    }
  } catch {
    // Privacy-mode browsers will throw — surface to the caller via the
    // missing-token path instead of crashing the page.
  }
}

export class AgentAdminError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function agentAdminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAgentAdminToken();
  if (!token) {
    throw new AgentAdminError(401, "agent admin token not set", null);
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const message =
      typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new AgentAdminError(res.status, message, body);
  }
  return body as T;
}

export async function listPrompts(): Promise<PromptAdminRow[]> {
  const data = await agentAdminFetch<{ prompts: PromptAdminRow[] }>("/admin/prompts");
  return data.prompts;
}

export async function getPrompt(ref: string): Promise<PromptAdminRow> {
  return agentAdminFetch<PromptAdminRow>(`/admin/prompts/${encodeURIComponent(ref)}`);
}

export async function createPrompt(input: CreatePromptInput): Promise<PromptAdminRow> {
  return agentAdminFetch<PromptAdminRow>("/admin/prompts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function activatePrompt(ref: string): Promise<PromptAdminRow> {
  return agentAdminFetch<PromptAdminRow>(
    `/admin/prompts/${encodeURIComponent(ref)}/activate`,
    { method: "POST" },
  );
}
