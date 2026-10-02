/** Where the signed-in session is kept between page loads. */
export interface SessionStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** Keeps the session in memory only: gone when the process or page ends. The default on servers. */
export class MemoryStorage implements SessionStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** `localStorage` when the browser allows it (it can be blocked), otherwise `null`. */
export function browserStorage(): SessionStorage | null {
  // Newer Node versions expose an experimental `localStorage` that warns when touched.
  if (typeof window === "undefined") return null;
  try {
    const store = (globalThis as { localStorage?: Storage }).localStorage;
    if (!store) return null;
    const probe = "__pawabase_probe__";
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}
