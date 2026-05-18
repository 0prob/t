export function takeTopNBy<T>(items: Iterable<T>, limit: number, compare: (a: T, b: T) => number): T[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];

  const selected: T[] = [];
  for (const item of items) {
    let lo = 0;
    let hi = selected.length;

    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (compare(item, selected[mid]) < 0) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }

    if (lo >= limit) continue;
    selected.splice(lo, 0, item);
    if (selected.length > limit) selected.pop();
  }

  return selected;
}
