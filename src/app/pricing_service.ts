type TokenMetaLike = {
  decimals?: number | null;
  symbol?: string | null;
} | null | undefined;

type PriceOracleLike = {
  fromMatic: (tokenAddress: string, maticWei: bigint) => bigint;
  getFreshRate: (tokenAddress: string, maxAgeMs?: number) => bigint;
  getFreshWithStaleFallback?: (tokenAddress: string, maxAgeMs?: number, staleFallbackMs?: number) => bigint;
} | null;

type PricingServiceDeps = {
  getTokenMeta: (tokenAddress: string) => TokenMetaLike;
  getPriceOracle: () => PriceOracleLike;
  maxPriceAgeMs: number;
  minProbeAmount: bigint;
  testAmountWei: bigint;
};

const FALLBACK_DECIMALS = 18;

function normalizeDecimals(decimals: unknown) {
  const numeric = Number(decimals);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 255) {
    return FALLBACK_DECIMALS;
  }
  return numeric;
}

function normalizeNonNegativeBigInt(value: unknown) {
  return typeof value === "bigint" && value >= 0n ? value : 0n;
}

function normalizePositiveBigInt(value: unknown, fallback: bigint) {
  return typeof value === "bigint" && value > 0n ? value : fallback;
}

function uniqueSortedBigInts(values: Array<string | number | bigint>) {
  return [...new Set(values.map(String))]
    .map((value) => BigInt(value))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function formatTokenAmount(amount: bigint, decimals: number, fractionDigits = 6) {
  const safeDecimals = Math.max(0, Math.min(Number(decimals) || 0, 18));
  const scale = 10n ** BigInt(safeDecimals);
  const negative = amount < 0n;
  const absAmount = negative ? -amount : amount;
  const whole = absAmount / scale;
  const fraction = absAmount % scale;

  if (fractionDigits <= 0 || safeDecimals === 0) {
    return `${negative ? "-" : ""}${whole.toString()}`;
  }

  const paddedFraction = fraction.toString().padStart(safeDecimals, "0");
  const clippedFraction = paddedFraction
    .slice(0, Math.min(fractionDigits, safeDecimals))
    .replace(/0+$/, "");

  return clippedFraction.length > 0
    ? `${negative ? "-" : ""}${whole.toString()}.${clippedFraction}`
    : `${negative ? "-" : ""}${whole.toString()}`;
}

export function createPricingService(deps: PricingServiceDeps) {
  function getFreshTokenToMaticRate(tokenAddress: string) {
    const oracle = deps.getPriceOracle();
    // Prefer the stale-fallback method if available, otherwise fall back to getFreshRate.
    const rate = oracle?.getFreshWithStaleFallback?.(tokenAddress, deps.maxPriceAgeMs, 300_000)
      ?? oracle?.getFreshRate?.(tokenAddress, deps.maxPriceAgeMs);
    return normalizeNonNegativeBigInt(rate);
  }

  function getProbeAmountsForToken(tokenAddress: string) {
    const decimals = normalizeDecimals(deps.getTokenMeta(tokenAddress)?.decimals);
    const rawUnit = 10n ** BigInt(decimals);
    const minProbeAmount = normalizePositiveBigInt(deps.minProbeAmount, 1n);
    const testAmountWei = normalizePositiveBigInt(deps.testAmountWei, rawUnit);
    const oracle = deps.getPriceOracle();
    const oracleScaledProbes = oracle
      ? [
          normalizeNonNegativeBigInt(oracle.fromMatic(tokenAddress, 5n * 10n ** 16n)), // 0.05 MATIC
          normalizeNonNegativeBigInt(oracle.fromMatic(tokenAddress, 5n * 10n ** 17n)), // 0.5 MATIC
          normalizeNonNegativeBigInt(oracle.fromMatic(tokenAddress, 2n * 10n ** 18n)), // 2 MATIC
          normalizeNonNegativeBigInt(oracle.fromMatic(tokenAddress, 10n ** 19n)),      // 10 MATIC
        ]
      : [];
    const probes = uniqueSortedBigInts([
      minProbeAmount,
      rawUnit / 10n,
      rawUnit,
      rawUnit * 10n,
      rawUnit * 100n,
      rawUnit * 1_000n,
      testAmountWei,
      ...oracleScaledProbes,
    ]);

    return probes.filter((amount) => amount > 0n && amount >= minProbeAmount);
  }

  function fmtSym(addr: string) {
    return deps.getTokenMeta(addr)?.symbol ?? addr.slice(2, 8).toUpperCase();
  }

  function fmtProfit(netWei: bigint, tokenAddr: string) {
    const meta = deps.getTokenMeta(tokenAddr);
    const decimals = meta?.decimals ?? FALLBACK_DECIMALS;
    const symbol = meta?.symbol ?? tokenAddr.slice(2, 8).toUpperCase();
    // Sanity cap: max 1M USDC (1e12 wei for 6 decimals)
    const maxWei = 1_000_000n * 10n ** BigInt(decimals);
    const displayWei = netWei > maxWei ? maxWei : netWei;
    return `${formatTokenAmount(displayWei, decimals, 6)} ${symbol}`;
  }

  return {
    getFreshTokenToMaticRate,
    getProbeAmountsForToken,
    fmtSym,
    fmtProfit,
    formatTokenAmount,
  };
}
