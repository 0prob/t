const PROTOCOL_BIGINT_SCALAR_FIELDS: Record<string, string[]> = {
  V2: ["fee", "feeDenominator", "reserve0", "reserve1"],
  V3: ["fee", "sqrtPriceX96", "liquidity"],
  CURVE: ["fee", "A", "swapFee", "virtualPrice"],
  BALANCER: ["fee", "swapFee", "amp", "ampPrecision"],
  DODO: ["fee", "baseReserve", "quoteReserve", "baseTarget", "quoteTarget", "i", "k", "lpFeeRate", "mtFeeRate"],
  WOOFI: ["fee", "feeDenominator", "quoteReserve", "quoteFeeRate", "quoteDec"],
};

const PROTOCOL_BIGINT_ARRAY_FIELDS: Record<string, string[]> = {
  CURVE: ["balances", "rates"],
  BALANCER: ["balances", "weights", "scalingFactors"],
  WOOFI: ["balances"],
};

function protocolClass(protocol: string): string {
  const upper = protocol.toUpperCase();
  if (upper.includes("V2")) return "V2";
  if (upper.includes("V3")) return "V3";
  if (upper.includes("CURVE")) return "CURVE";
  if (upper.includes("BALANCER")) return "BALANCER";
  if (upper.includes("DODO")) return "DODO";
  if (upper.includes("WOOFI")) return "WOOFI";
  return "";
}

export function stringifyWithBigInt(obj: unknown): string {
  return JSON.stringify(obj, (_key: string, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Map) return Object.fromEntries(value);
    return value;
  });
}

export function parseJson<T>(value: unknown, fallback: T): unknown {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function rehydrateStateData(protocol: string, data: unknown): unknown {
  if (data == null || typeof data !== "object") return data;
  const dataRecord = data as Record<string, unknown>;
  const cls = protocolClass(protocol);
  const scalarFields = PROTOCOL_BIGINT_SCALAR_FIELDS[cls] || [];
  for (const field of scalarFields) {
    if (typeof dataRecord[field] === "string") {
      dataRecord[field] = BigInt(dataRecord[field] as string);
    }
  }
  const arrayFields = PROTOCOL_BIGINT_ARRAY_FIELDS[cls] || [];
  for (const field of arrayFields) {
    if (Array.isArray(dataRecord[field])) {
      dataRecord[field] = (dataRecord[field] as unknown[]).map((v) => (typeof v === "string" ? BigInt(v) : v));
    }
  }
  return dataRecord;
}

export function rehydrateV3Ticks(
  ticks: unknown,
): Map<number, { liquidityGross: bigint; liquidityNet: bigint }> {
  const result = new Map<number, { liquidityGross: bigint; liquidityNet: bigint }>();
  if (ticks == null) return result;
  let entries: Array<[unknown, unknown]> = [];
  if (ticks instanceof Map) {
    entries = [...ticks.entries()];
  } else if (Array.isArray(ticks)) {
    entries = ticks
      .map((entry) => {
        if (Array.isArray(entry) && entry.length >= 2) return [entry[0], entry[1]] as [unknown, unknown];
        return null;
      })
      .filter((e): e is [unknown, unknown] => e != null);
  } else if (typeof ticks === "object") {
    entries = Object.entries(ticks as Record<string, unknown>);
  }
  for (const [tickKey, liq] of entries) {
    const tickNum = Number(tickKey);
    if (!Number.isInteger(tickNum)) continue;
    const liqRecord = liq as Record<string, unknown> | null | undefined;
    if (!liqRecord) continue;
    result.set(tickNum, {
      liquidityGross: typeof liqRecord.liquidityGross === "string" ? BigInt(liqRecord.liquidityGross) : BigInt(liqRecord.liquidityGross as number),
      liquidityNet: typeof liqRecord.liquidityNet === "string" ? BigInt(liqRecord.liquidityNet) : BigInt(liqRecord.liquidityNet as number),
    });
  }
  return result;
}

export function normalizeAddressForDb(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "");
  return value.trim().toLowerCase();
}

export function poolRowToObject(row: Record<string, unknown>) {
  return {
    pool_address: normalizeAddressForDb(row.address),
    protocol: String(row.protocol ?? ""),
    tokens: (parseJson(row.tokens, []) as string[]).map(normalizeAddressForDb),
    block: row.created_block as number,
    tx: String(row.created_tx ?? ""),
    metadata: parseJson(row.metadata, {}),
    status: String(row.status ?? "active"),
    removed_block: (row.removed_block as number | null) ?? null,
  };
}

export function poolMetaRowToObject(row: Record<string, unknown>) {
  return poolRowToObject(row);
}
