function objectLabel(value: object) {
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  if (tag && tag !== "Object") return tag;
  const ctor = value.constructor?.name;
  if (ctor && ctor !== "Object") return ctor;
  return null;
}

function displayScalar(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return null;
}

function safeUrlSummary(value: unknown) {
  const url = displayScalar(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.pathname && parsed.pathname !== "/") {
      if (/^\/v2\/[^/]+$/.test(parsed.pathname)) return `${parsed.origin}/v2/[REDACTED]`;
      return `${parsed.origin}/[REDACTED_PATH]`;
    }
    return parsed.origin;
  } catch {
    return "[redacted-url]";
  }
}

function targetSummary(target: unknown) {
  if (!target || typeof target !== "object") return null;
  const record = target as Record<string, unknown>;
  const ctor = target.constructor?.name;
  const label = ctor && ctor !== "Object" ? ctor : "target";
  const parts = [label];
  const readyState = displayScalar(record.readyState);
  const url = safeUrlSummary(record.url);
  if (readyState != null) parts.push(`readyState=${readyState}`);
  if (url) parts.push(`url=${url}`);
  return parts.join(" ");
}

function objectErrorMessage(err: object) {
  const record = err as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["type", "code", "status", "statusCode", "name"] as const) {
    const value = displayScalar(record[key]);
    if (value) parts.push(`${key}=${value}`);
  }
  const target = targetSummary(record.target);
  if (target) parts.push(`target=${target}`);

  if (parts.length === 0) return null;

  const label = objectLabel(err) ?? (typeof record.type === "string" && record.type ? "ErrorEvent" : "Object");
  return `${label}(${parts.join(" ")})`;
}

export function errorMessage(err: unknown, options: { includeStack?: boolean } = {}) {
  if (err instanceof Error) {
    return options.includeStack ? err.stack || err.message : err.message;
  }
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message;
    if (typeof record.reason === "string" && record.reason.trim()) return record.reason;
    const summarized = objectErrorMessage(err);
    if (summarized) return summarized;
  }
  return String(err);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
