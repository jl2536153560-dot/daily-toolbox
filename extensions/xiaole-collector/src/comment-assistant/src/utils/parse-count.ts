export interface ParseCountResult {
  value: number;
  raw: string;
  parsed: boolean;
}

const MULTIPLIERS: Record<string, number> = {
  万: 10_000,
  w: 10_000,
  W: 10_000,
  亿: 100_000_000
};

export function parseCountDetailed(input: unknown): ParseCountResult {
  const raw = typeof input === "string" ? input : input == null ? "" : String(input);
  const normalized = raw
    .trim()
    .replaceAll(/\s+/g, "")
    .replaceAll(",", "")
    .replace(/^(点赞|获赞|赞同|回复|评论|共|查看|展开|还有)/, "")
    .replace(/(条)?(回复|评论)$/, "")
    .replace(/\+$/, "");

  if (!normalized || normalized === "赞" || normalized === "收起回复") {
    return { value: 0, raw, parsed: normalized === "" || normalized === "赞" };
  }

  const match = normalized.match(/^(-?\d+(?:\.\d+)?)(万|亿|w|W)?$/);
  if (!match) return { value: 0, raw, parsed: false };

  const numeric = Number(match[1]);
  const unit = match[2] ?? "";
  if (!Number.isFinite(numeric) || numeric < 0) {
    return { value: 0, raw, parsed: false };
  }

  const multiplier = unit ? MULTIPLIERS[unit] ?? 1 : 1;
  const value = Math.round(numeric * multiplier);
  return {
    value: Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER,
    raw,
    parsed: true
  };
}

export function parseCount(input: unknown): number {
  return parseCountDetailed(input).value;
}
