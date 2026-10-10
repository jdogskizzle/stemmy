/**
 * Multitrack player built on the Web Audio API.
 *
 * Every stem is fully decoded into an AudioBuffer and started with the same
 * AudioContext timestamp, so stems stay sample-locked. Each stem feeds its own
 * GainNode. Mute, solo and volume only ramp that gain, so changes are instant
 * and click-free. Seeking and A–B looping reschedule every source at one exact
 * future time.
 */
import { loadAudioBuffer } from "./cache";

export interface LaneInput { id: string; instrument: string; url: string }

export interface LaneMix { muted: boolean; solo: boolean; volume: number }

export interface LaneState extends LaneMix {
  id: string;
  instrument: string;
  loaded: boolean;
  progress: number;
  error: string | null;
}

export interface EngineState {
  lanes: LaneState[];
  playing: boolean;
  ready: boolean;
  /** A new version is loading while the previous one keeps playing. */
  switching: boolean;
  duration: number;
  loop: { start: number; end: number } | null;
  loopEnabled: boolean;
  masterVolume: number;
}

interface Lane extends LaneState {
  url: string;
  buffer: AudioBuffer | null;
  gain: GainNode;
}

const START_DELAY = 0.04; // seconds of headroom so every source starts on the same render quantum
const LOOP_LOOKAHEAD = 0.25;
const RAMP = 0.012;

const mixKey = (instrument: string) => instrument.trim().toLowerCase();

export class Engine {
  readonly ctx: AudioContext;
  private master: GainNode;
  private lanes: Lane[] = []; // the stems currently driving playback
  private incoming: Lane[] | null = null; // stems of a version that is still loading
  private sources: AudioBufferSourceNode[] = [];
  private retiring: AudioBufferSourceNode[] = []; // sources with a scheduled future stop (loop wrap)
  private playing = false;
  private anchorCtxTime = 0; // ctx time at which `anchorOffset` plays
  private anchorOffset = 0;
  private prevAnchor: { ctxTime: number; offset: number } | null = null; // used until a queued loop wrap begins
  private pausedAt = 0;
  private loop: { start: number; end: number } | null = null;
  private loopEnabled = false;
  private nextLoopScheduled = false;
  private masterVolume = 1;
  private loadToken = 0;
  private timer: number | null = null;
  // Mix settings remembered by instrument name, so they carry across versions.
  private mixMemory = new Map<string, LaneMix>();
  private listeners = new Set<() => void>();
  private snapshot: EngineState;

  constructor() {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // 44.1 kHz matches the server's stream format, so decoding needs no resampling.
    let ctx: AudioContext;
    try { ctx = new Ctx({ sampleRate: 44100, latencyHint: "playback" }); } catch { ctx = new Ctx(); }
    this.ctx = ctx;
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.snapshot = this.buildSnapshot();
  }

  // ---------- subscription (useSyncExternalStore-compatible) ----------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = () => this.snapshot;

  private emit() {
    this.snapshot = this.buildSnapshot();
    this.listeners.forEach((fn) => fn());
  }

  private buildSnapshot(): EngineState {
    const shown = this.incoming ?? this.lanes;
    return {
      lanes: shown.map(({ id, instrument, loaded, progress, error, muted, solo, volume }) =>
        ({ id, instrument, loaded, progress, error, muted, solo, volume })),
      playing: this.playing,
      ready: shown.length > 0 && shown.every((l) => l.loaded || l.error),
      switching: !!this.incoming && this.lanes.length > 0,
      duration: this.duration,
      loop: this.loop,
      loopEnabled: this.loopEnabled,
      masterVolume: this.masterVolume,
    };
  }

  // ---------- loading ----------

  get duration() {
    return this.lanes.reduce((max, l) => Math.max(max, l.buffer?.duration ?? 0), 0);
  }

  /**
   * Swap in a new set of stems (e.g. another version). The current stems keep
   * playing while the new ones load, then playback hands over at the same
   * position. Per-instrument mute/solo/volume carry over.
   */
  async load(inputs: LaneInput[]): Promise<void> {
    const token = ++this.loadToken;
    this.disconnectLanes(this.incoming);
    const incoming: Lane[] = inputs.map((input) => {
      const mix = this.mixMemory.get(mixKey(input.instrument)) ?? { muted: false, solo: false, volume: 1 };
      const gain = this.ctx.createGain();
      gain.connect(this.master);
      return { ...input, ...mix, loaded: false, progress: 0, error: null, buffer: null, gain };
    });
    this.incoming = incoming;
    this.applyGains(true);
    this.emit();

    await Promise.all(incoming.map(async (lane) => {
      try {
        lane.buffer = await loadAudioBuffer(this.ctx, lane.url, (loaded, total) => {
          lane.progress = total ? loaded / total : 0;
          if (token === this.loadToken) this.emit();
        });
        lane.loaded = true;
        lane.progress = 1;
      } catch (err) {
        lane.error = err instanceof Error ? err.message : String(err);
      }
      if (token === this.loadToken) this.emit();
    }));
    if (token !== this.loadToken) return; // superseded by a newer load, which owns cleanup

    let position = this.currentTime;
    const wasPlaying = this.playing;
    this.stopSources();
    this.disconnectLanes(this.lanes);
    this.lanes = incoming;
    this.incoming = null;
    const duration = this.duration;
    if (this.loop && this.loop.end > duration) { this.loop = null; this.loopEnabled = false; }
    if (position >= duration) position = 0;
    this.pausedAt = position;
    if (wasPlaying) this.scheduleSources(this.ctx.currentTime + START_DELAY, position);
    this.emit();
  }

  /** Release everything (leaving the song page). */
  unload() {
    this.loadToken++;
    this.stopSources();
    this.stopTimer();
    this.playing = false;
    this.disconnectLanes(this.lanes);
    this.disconnectLanes(this.incoming);
    this.lanes = [];
    this.incoming = null;
    this.pausedAt = 0;
    this.loop = null;
    this.loopEnabled = false;
    this.emit();
  }

  private disconnectLanes(lanes: Lane[] | null) {
    for (const lane of lanes ?? []) lane.gain.disconnect();
  }

  // ---------- transport ----------

  get currentTime(): number {
    if (!this.playing) return this.pausedAt;
    const now = this.ctx.currentTime;
    const anchor = this.prevAnchor && now < this.anchorCtxTime
      ? this.prevAnchor
      : { ctxTime: this.anchorCtxTime, offset: this.anchorOffset };
    const t = anchor.offset + (now - anchor.ctxTime);
    return Math.max(anchor.offset, Math.min(t, this.duration));
  }

  get isPlaying() { return this.playing; }

  play() {
    if (this.playing || !this.lanes.some((l) => l.buffer)) return;
    if (this.ctx.state !== "running") void this.ctx.resume();
    let offset = this.pausedAt;
    if (offset >= this.duration - 0.01) offset = 0;
    if (this.loopEnabled && this.loop && (offset < this.loop.start || offset >= this.loop.end)) offset = this.loop.start;
    this.playing = true;
    this.scheduleSources(this.ctx.currentTime + START_DELAY, offset);
    this.startTimer();
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = this.currentTime;
    this.playing = false;
    this.stopSources();
    this.stopTimer();
    this.emit();
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  seek(time: number) {
    const t = Math.max(0, Math.min(time, this.duration));
    if (this.playing) {
      this.stopSources();
      this.scheduleSources(this.ctx.currentTime + START_DELAY, t);
    } else {
      this.pausedAt = t;
    }
    this.emit();
  }

  skip(delta: number) { this.seek(this.currentTime + delta); }

  private scheduleSources(when: number, offset: number) {
    const fresh: AudioBufferSourceNode[] = [];
    for (const lane of this.lanes) {
      if (!lane.buffer || offset >= lane.buffer.duration) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = lane.buffer;
      src.connect(lane.gain);
      src.start(when, offset);
      fresh.push(src);
    }
    this.sources = fresh;
    this.prevAnchor = null;
    this.anchorCtxTime = when;
    this.anchorOffset = offset;
    this.nextLoopScheduled = false;
  }

  /** Stop all sources now, or (with `at`) retire the current ones at a future context time. */
  private stopSources(at?: number) {
    if (at !== undefined) {
      for (const src of this.sources) {
        try { src.stop(at); } catch { /* already stopped */ }
        src.onended = () => { src.disconnect(); this.retiring = this.retiring.filter((s) => s !== src); };
      }
      this.retiring.push(...this.sources);
      this.sources = [];
      return;
    }
    for (const src of [...this.sources, ...this.retiring]) {
      src.onended = null;
      try { src.stop(); } catch { /* already stopped */ }
      src.disconnect();
    }
    this.sources = [];
    this.retiring = [];
    this.prevAnchor = null;
    this.nextLoopScheduled = false;
  }

  // Polls for end-of-song and pre-schedules seamless loop wraparounds.
  private startTimer() {
    this.stopTimer();
    this.timer = window.setInterval(() => this.tick(), 50);
  }

  private stopTimer() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    if (!this.playing) return;
    if (this.nextLoopScheduled && this.ctx.currentTime >= this.anchorCtxTime) {
      this.nextLoopScheduled = false; // the queued wrap has started
      this.prevAnchor = null;
    }
    const t = this.currentTime;
    if (this.nextLoopScheduled) return;
    if (this.loopEnabled && this.loop) {
      const { start, end } = this.loop;
      if (t >= end) {
        this.stopSources();
        this.scheduleSources(this.ctx.currentTime + START_DELAY, start);
      } else if (end - t < LOOP_LOOKAHEAD) {
        // Stop the current sources and start the next pass on the exact sample of the loop end.
        const wrapAt = this.anchorCtxTime + (end - this.anchorOffset);
        const prev = { ctxTime: this.anchorCtxTime, offset: this.anchorOffset };
        this.stopSources(wrapAt);
        this.scheduleSources(wrapAt, start);
        this.prevAnchor = prev;
        this.nextLoopScheduled = true;
      }
      return;
    }
    if (t >= this.duration - 0.005) {
      this.playing = false;
      this.pausedAt = 0;
      this.stopSources();
      this.stopTimer();
      this.emit();
    }
  }

  // ---------- loop ----------

  setLoop(loop: { start: number; end: number } | null) {
    if (loop && loop.end - loop.start < 0.05) loop = null;
    this.loop = loop;
    this.loopEnabled = !!loop;
    if (this.playing && this.nextLoopScheduled) {
      // Drop the wrap queued for the old loop bounds.
      const t = this.currentTime;
      this.stopSources();
      this.scheduleSources(this.ctx.currentTime + START_DELAY, t);
    }
    if (loop && this.playing) {
      const t = this.currentTime;
      if (t < loop.start || t >= loop.end) this.seek(loop.start);
    }
    this.emit();
  }

  setLoopEnabled(enabled: boolean) {
    this.loopEnabled = enabled && !!this.loop;
    if (this.loopEnabled && this.playing && this.loop) {
      const t = this.currentTime;
      if (t < this.loop.start || t >= this.loop.end) this.seek(this.loop.start);
    } else if (!this.loopEnabled && this.nextLoopScheduled) {
      // A wrap was already queued; replace it with continuous playback.
      const t = this.currentTime;
      this.stopSources();
      this.scheduleSources(this.ctx.currentTime + START_DELAY, t);
    }
    this.emit();
  }

  // ---------- mixing ----------

  private get allLanes() { return [...this.lanes, ...(this.incoming ?? [])]; }

  private lane(id: string) { return this.allLanes.find((l) => l.id === id); }

  private remember(lane: Lane) {
    this.mixMemory.set(mixKey(lane.instrument), { muted: lane.muted, solo: lane.solo, volume: lane.volume });
  }

  setMute(id: string, muted: boolean) { this.updateLane(id, { muted }); }
  setSolo(id: string, solo: boolean) { this.updateLane(id, { solo }); }
  setVolume(id: string, volume: number) { this.updateLane(id, { volume }); }

  /** Solo exactly one lane (clears other solos), or clear solo if it's already the only one. */
  soloExclusive(id: string) {
    const shown = this.incoming ?? this.lanes;
    const only = shown.filter((l) => l.solo).length === 1 && this.lane(id)?.solo;
    for (const lane of shown) { lane.solo = !only && lane.id === id; this.remember(lane); }
    this.applyGains();
    this.emit();
  }

  resetMix() {
    for (const lane of this.allLanes) { lane.muted = false; lane.solo = false; lane.volume = 1; this.remember(lane); }
    this.applyGains();
    this.emit();
  }

  setMasterVolume(v: number) {
    this.masterVolume = v;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, RAMP);
    this.emit();
  }

  private updateLane(id: string, patch: Partial<LaneMix>) {
    const lane = this.lane(id);
    if (!lane) return;
    Object.assign(lane, patch);
    this.remember(lane);
    this.applyGains();
    this.emit();
  }

  /** Whether a lane is currently audible given mute/solo state. */
  static audible(lane: LaneMix, anySolo: boolean) {
    return anySolo ? lane.solo : !lane.muted;
  }

  private applyGains(immediate = false) {
    for (const group of [this.lanes, this.incoming ?? []]) {
      const anySolo = group.some((l) => l.solo);
      for (const lane of group) {
        const target = Engine.audible(lane, anySolo) ? lane.volume : 0;
        if (immediate) lane.gain.gain.value = target;
        else lane.gain.gain.setTargetAtTime(target, this.ctx.currentTime, RAMP);
      }
    }
  }
}

let engine: Engine | null = null;
export function getEngine(): Engine {
  engine ??= new Engine();
  return engine;
}
