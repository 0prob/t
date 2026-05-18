const MAX_ADDRESSES_PER_FILTER = 25_000;

export class WatcherFilter {
  private addresses = new Set<string>();

  add(addresses: string[]): void {
    for (const a of addresses) this.addresses.add(a.toLowerCase());
  }

  remove(addresses: string[]): void {
    for (const a of addresses) this.addresses.delete(a.toLowerCase());
  }

  getAll(): string[] {
    return Array.from(this.addresses);
  }

  getChunks(): string[][] {
    const all = this.getAll();
    const chunks: string[][] = [];
    for (let i = 0; i < all.length; i += MAX_ADDRESSES_PER_FILTER) {
      chunks.push(all.slice(i, i + MAX_ADDRESSES_PER_FILTER));
    }
    return chunks;
  }

  get size(): number {
    return this.addresses.size;
  }
}
