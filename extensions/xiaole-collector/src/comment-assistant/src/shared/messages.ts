export interface ActivateToolbarRequest {
  type: "DCS_ACTIVATE_TOOLBAR";
}

export function isActivateToolbarRequest(
  value: unknown
): value is ActivateToolbarRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === "DCS_ACTIVATE_TOOLBAR";
}
