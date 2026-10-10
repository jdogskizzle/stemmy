/**
 * Three cache layers keep switching between stems and versions instant:
 *
 * 1. Persistent: encoded audio and peaks live in the browser's Cache API, keyed by URL.
 *    URLs carry the track's content hash, so they are immutable and never go stale.
 *    The Cache API needs a secure context (HTTPS or localhost); on plain-HTTP LAN
 *    access we fall back to the HTTP cache, since the server sends immutable headers.
 * 2. Decoded: an LRU of decoded AudioBuffers bounded by a memory budget. Buffers for
 *    the version on screen are pinned so they're never evicted.
 * 3. In-flight: concurrent requests for the same URL share one promise.
 *
 * Muting and soloing never touch these layers. They only ramp gain nodes, so they're instant.
 */
import { authHeaders, getToken, withBase, type Peaks } from "../api";

const CACHE_NAME = "stemmy-media-v1";
const MAX_PERSISTED_ENTRIES = 400;

const cacheApiAvailable = typeof caches !== "undefined" && typeof window !== "undefined" && window.isSecureContext;

let cachePromise: Promise<Cache | null> | null = null;
function openCache(): Promise<Cache | null> {
  if (!cacheApiAvailable) return Promise.resolve(null);
  cachePromise ??= caches.open(CACHE_NAME).catch(() => null);
  return cachePromise;
}

async function trimPersistentCache(cache: Cache) {
  const keys = await cache.keys();
  // keys() returns insertion order, so the oldest entries are dropped first.
  for (const req of keys.slice(0, Math.max(0, keys.length - MAX_PERSISTED_ENTRIES))) await cache.delete(req);
}

export type ProgressFn = (loaded: number, total: number) => void;

const inflightBytes = new Map<string, Promise<ArrayBuffer>>();

/** Fetch bytes for an immutable media URL, through the persistent cache. */
export function fetchMedia(url: string, onProgress?: ProgressFn): Promise<ArrayBuffer> {
  let p = inflightBytes.get(url);
  if (!p) {
    p = fetchMediaUncached(url, onProgress).finally(() => inflightBytes.delete(url));
    inflightBytes.set(url, p);
  }
  return p;
}

async function fetchMediaUncached(path: string, onProgress?: ProgressFn): Promise<ArrayBuffer> {
  const url = withBase(path);
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url).catch(() => undefined);
    if (hit) {
      const buf = await hit.arrayBuffer();
      onProgress?.(buf.byteLength, buf.byteLength);
      return buf;
    }
  }
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to load media (${res.status})`);
  const total = Number(res.headers.get("Content-Length")) || 0;
  let bytes: Uint8Array;
  if (res.body && onProgress) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total || loaded);
    }
    bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (cache) {
    const headers = { "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream" };
    cache.put(url, new Response(bytes.slice(), { headers }))
      .then(() => trimPersistentCache(cache))
      .catch(() => { /* quota exceeded etc.: caching is best-effort */ });
  }
  return bytes.buffer as ArrayBuffer;
}

// ---------- decoded buffers ----------

function deviceBudgetBytes(): number {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobile) return 160 * 1024 * 1024;
  if (mem && mem <= 4) return 300 * 1024 * 1024;
  return 700 * 1024 * 1024;
}

class DecodedCache {
  private entries = new Map<string, AudioBuffer>();
  private pinned = new Set<string>();
  private bytes = 0;
  readonly budget = deviceBudgetBytes();

  private static size(b: AudioBuffer) { return b.length * b.numberOfChannels * 4; }

  get(key: string): AudioBuffer | undefined {
    const buf = this.entries.get(key);
    if (buf) { this.entries.delete(key); this.entries.set(key, buf); }
    return buf;
  }

  set(key: string, buf: AudioBuffer) {
    if (this.entries.has(key)) return;
    this.entries.set(key, buf);
    this.bytes += DecodedCache.size(buf);
    this.evict();
  }

  pin(keys: Iterable<string>) {
    this.pinned = new Set(keys);
    this.evict();
  }

  has(key: string) { return this.entries.has(key); }

  private evict() {
    for (const [key, buf] of this.entries) {
      if (this.bytes <= this.budget) break;
      if (this.pinned.has(key)) continue;
      this.entries.delete(key);
      this.bytes -= DecodedCache.size(buf);
    }
  }
}

export const decodedCache = new DecodedCache();
const inflightDecode = new Map<string, Promise<AudioBuffer>>();

export function loadAudioBuffer(ctx: BaseAudioContext, url: string, onProgress?: ProgressFn): Promise<AudioBuffer> {
  const cached = decodedCache.get(url);
  if (cached) {
    onProgress?.(1, 1);
    return Promise.resolve(cached);
  }
  let p = inflightDecode.get(url);
  if (!p) {
    p = fetchMedia(url, onProgress)
      // decodeAudioData detaches its input; copy so the shared bytes stay usable.
      .then((bytes) => ctx.decodeAudioData(bytes.slice(0)))
      .then((buf) => { decodedCache.set(url, buf); return buf; })
      .finally(() => inflightDecode.delete(url));
    inflightDecode.set(url, p);
  }
  return p;
}

// ---------- peaks ----------

const peaksMemory = new Map<string, Promise<Peaks>>();

export function loadPeaks(url: string): Promise<Peaks> {
  let p = peaksMemory.get(url);
  if (!p) {
    p = fetchMedia(url).then((buf) => JSON.parse(new TextDecoder().decode(buf)) as Peaks);
    p.catch(() => peaksMemory.delete(url));
    peaksMemory.set(url, p);
  }
  return p;
}

/** Warm the persistent cache for audio we'll probably want soon (e.g. other versions). */
export async function prefetchMedia(urls: string[], concurrency = 2) {
  if (!getToken()) return;
  const queue = [...urls];
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      try { await fetchMedia(url); } catch { /* best-effort */ }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}
