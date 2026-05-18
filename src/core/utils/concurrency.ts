/**
 * src/util/concurrency.ts — Shared concurrency utilities
 *
 * Consolidates identical mapWithConcurrency implementations found in
 * candidate_pipeline.ts, mempool_watcher.ts, and send_tx.ts.
 * Used across the codebase for bounded parallel task execution.
 */

/**
 * Map items through an async worker with bounded concurrency.
 * Workers process items in order; results preserve input ordering.
 * Falls back to sequential when concurrency <= 1.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const safeConcurrency = normalizeConcurrency(concurrency, 1, items.length);
  if (safeConcurrency <= 1 || items.length === 1) {
    // Sequential fast path — avoids Promise.all overhead for single-worker cases
    const results = new Array<R>(items.length);
    for (let i = 0; i < items.length; i++) {
      results[i] = await mapper(items[i], i);
    }
    return results;
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;

  async function worker() {
    while (!failed && nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: safeConcurrency }, () =>
    worker().catch((err) => {
      failed = true;
      throw err;
    }),
  );
  try {
    await Promise.all(workers);
  } catch (err) {
    throw new Error(`mapWithConcurrency: one or more workers failed: ${(err as Error)?.message ?? String(err)}`);
  }
  return results;
}

function normalizeConcurrency(value: unknown, min = 1, max = Infinity): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return min;
  return Math.min(Math.max(Math.floor(n), min), max);
}

export function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}
