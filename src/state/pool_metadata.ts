import { parsePoolMetadataValue } from "../utils/pool_record.ts";

type PoolMetadataSource = {
  metadata?: unknown;
};

type TokenDecimalsRegistry = {
  getTokenDecimals?: (tokens: string[]) => Map<string, number> | null | undefined;
};

export function metadataWithTokenDecimals(
  pool: PoolMetadataSource | null | undefined,
  tokens: string[],
  tokenDecimals?: Map<string, number> | null,
): Record<string, unknown> {
  const metadata = parsePoolMetadataValue(pool?.metadata);
  if (!Array.isArray(tokens) || tokens.length === 0 || !tokenDecimals || tokenDecimals.size === 0) {
    return metadata;
  }

  const tokenDecimalsByAddress: Record<string, number> = {};
  const orderedDecimals: number[] = [];
  for (const token of tokens) {
    const key = String(token).toLowerCase();
    const decimals = tokenDecimals.get(key);
    if (decimals == null) continue;
    tokenDecimalsByAddress[key] = decimals;
    orderedDecimals.push(decimals);
  }

  if (Object.keys(tokenDecimalsByAddress).length === 0) return metadata;
  if (orderedDecimals.length === tokens.length) {
    return {
      ...metadata,
      tokenDecimals: orderedDecimals,
      tokenDecimalsByAddress,
    };
  }
  return { ...metadata, tokenDecimalsByAddress };
}

export function metadataWithRegistryTokenDecimals(
  registry: TokenDecimalsRegistry | null | undefined,
  pool: PoolMetadataSource | null | undefined,
  tokens: string[],
): Record<string, unknown> {
  const tokenDecimals = registry?.getTokenDecimals?.(tokens) ?? null;
  return metadataWithTokenDecimals(pool, tokens, tokenDecimals);
}
