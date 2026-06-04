// Single source of the `permission-request` WebSocket message shape. Two
// producers emit it — the bash-hook endpoint (POST /permission-request) and the
// SDK in-process bridge (requestPermission/canUseTool) — and they MUST stay in
// lockstep, or one class of agent gets a degraded modal (the ExitPlanMode plan
// not rendering for bash-hook sessions was exactly that drift).
//
// Optional fields are dropped when undefined/empty so the client's `plan ? …`
// branch and its title/description fallbacks behave as intended.

export interface PermissionRequestMessage {
  agentId: string;
  requestId: string;
  kind: 'question' | 'permission';
  toolName?: string;
  toolInput?: string;
  title?: string;        // SDK-rendered prompt sentence (SDK path only)
  description?: string;  // SDK-rendered subtitle (SDK path only)
  plan?: string;         // full plan markdown for ExitPlanMode
}

export function buildPermissionRequestMessage(fields: PermissionRequestMessage): PermissionRequestMessage {
  const { agentId, requestId, kind, toolName, toolInput, title, description, plan } = fields;
  return {
    agentId, requestId, kind,
    ...(toolName ? { toolName } : {}),
    ...(toolInput ? { toolInput } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(plan ? { plan } : {}),
  };
}
