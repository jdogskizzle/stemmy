import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as RPointerEvent } from "react";
import type { Peaks, Track } from "../api";
import { Engine, getEngine } from "../audio/engine";
import { loadPeaks } from "../audio/cache";
import { formatTime, laneColor } from "../util";
import { Menu, type MenuItem } from "./Menu";
import { Waveform } from "./Waveform";

export function Player({ tracks, fallbackDuration, trackMenu }: {
  tracks: Track[]; // ready tracks of the selected version
  fallbackDuration: number;
  trackMenu: (track: Track) => MenuItem[];
}) {
  const engine = getEngine();
  const state = useSyncExternalStore(engine.subscribe, engine.getState);
  const [peaks, setPeaks] = useState<Record<string, Peaks>>({});
  const timeline = state.duration || fallbackDuration;

  // Peaks are tiny and immutable: fetch them right away so waveforms show before audio finishes loading.
  useEffect(() => {
    let cancelled = false;
    for (const t of tracks) {
      if (!t.peaks_url || peaks[t.id]) continue;
      loadPeaks(t.peaks_url).then((p) => !cancelled && setPeaks((prev) => ({ ...prev, [t.id]: p }))).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [tracks]); // eslint-disable-line react-hooks/exhaustive-deps

  const anySolo = state.lanes.some((l) => l.solo);
  const trackById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);

  // The mix waveform reflects whichever stems are currently audible.
  const mixPeaks = useMemo(() => {
    let length = 0;
    const active = state.lanes.filter((l) => Engine.audible(l, anySolo) && peaks[l.id]);
    for (const l of active) length = Math.max(length, peaks[l.id].length);
    const out = new Float32Array(length);
    for (const l of active) {
      const data = peaks[l.id].data;
      for (let i = 0; i < data.length; i++) out[i] += data[i] * l.volume;
    }
    return out;
  }, [state.lanes, peaks, anySolo]);

  const loadingProgress = state.lanes.length
    ? state.lanes.reduce((n, l) => n + (l.loaded ? 1 : l.progress), 0) / state.lanes.length : 0;

  return (
    <div className="player">
      <Transport timeline={timeline} ready={state.ready && !state.switching} loadingProgress={loadingProgress} />
      <div className="lanes">
        <div className="lane mix-lane">
          <div className="lane-head">
            <span className="lane-name">Mix</span>
            <span className="muted small">
              {anySolo ? `${state.lanes.filter((l) => l.solo).length} soloed` : `${state.lanes.filter((l) => !l.muted).length}/${state.lanes.length} on`}
            </span>
            <button className="btn ghost small" onClick={() => engine.resetMix()} title="Unmute, unsolo, reset volumes">Reset</button>
          </div>
          <div className="lane-wave">
            <Waveform peaks={mixPeaks} peaksPerSecond={50} timelineDuration={timeline} color="#e8e9ee" />
          </div>
        </div>
        {state.lanes.map((lane, i) => {
          const track = trackById.get(lane.id);
          const color = laneColor(lane.instrument);
          const audible = Engine.audible(lane, anySolo);
          const p = peaks[lane.id];
          return (
            <div key={lane.id} className={`lane ${audible ? "" : "silent"}`} style={{ "--lane-color": color } as React.CSSProperties}>
              <div className="lane-head">
                <span className="lane-name" title={lane.instrument}>
                  <span className="dot" />{lane.instrument}
                  {i < 9 && <kbd className="hint">{i + 1}</kbd>}
                </span>
                <div className="lane-controls">
                  <button className={`toggle mute ${lane.muted ? "on" : ""}`} aria-pressed={lane.muted}
                    title="Mute (number key)" onClick={() => engine.setMute(lane.id, !lane.muted)}>M</button>
                  <button className={`toggle solo ${lane.solo ? "on" : ""}`} aria-pressed={lane.solo}
                    title="Solo (Shift+number solos only this)" onClick={(e) =>
                      e.shiftKey || e.altKey ? engine.soloExclusive(lane.id) : engine.setSolo(lane.id, !lane.solo)}>S</button>
                  <input type="range" className="volume" min={0} max={1.5} step={0.01} value={lane.volume}
                    aria-label={`${lane.instrument} volume`} title={`Volume ${Math.round(lane.volume * 100)}%`}
                    onChange={(e) => engine.setVolume(lane.id, Number(e.target.value))}
                    onDoubleClick={() => engine.setVolume(lane.id, 1)} />
                  {track && <Menu items={trackMenu(track)} />}
                </div>
              </div>
              <div className="lane-wave">
                <Waveform peaks={p?.data ?? null} peaksPerSecond={p?.peaks_per_second ?? 50}
                  timelineDuration={timeline} color={color} dimmed={!audible} />
                {!lane.loaded && !lane.error && (
                  <div className="lane-loading"><div style={{ width: `${lane.progress * 100}%` }} /></div>
                )}
                {lane.error && <div className="lane-error">Couldn't load audio: {lane.error}</div>}
              </div>
            </div>
          );
        })}
        <Timeline timeline={timeline} />
      </div>
    </div>
  );
}

function Transport({ timeline, ready, loadingProgress }: { timeline: number; ready: boolean; loadingProgress: number }) {
  const engine = getEngine();
  const state = useSyncExternalStore(engine.subscribe, engine.getState);
  const timeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (timeRef.current) timeRef.current.textContent = formatTime(engine.currentTime);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  return (
    <div className="transport">
      <button className="btn ghost icon" onClick={() => engine.skip(-5)} title="Back 5s (←)" aria-label="Back 5 seconds">⏪</button>
      <button className="btn play" onClick={() => engine.toggle()} disabled={!state.lanes.length}
        aria-label={state.playing ? "Pause" : "Play"} title="Play/Pause (Space)">
        {state.playing ? "❚❚" : "▶"}
      </button>
      <button className="btn ghost icon" onClick={() => engine.skip(5)} title="Forward 5s (→)" aria-label="Forward 5 seconds">⏩</button>
      <span className="time"><span ref={timeRef}>0:00</span> / {formatTime(timeline)}</span>
      {!ready && state.lanes.length > 0 && (
        <span className="muted small loading-label">{state.switching ? "Switching" : "Loading"} stems… {Math.round(loadingProgress * 100)}%</span>
      )}
      <span className="grow" />
      <button className={`btn small ${state.loopEnabled ? "primary" : "ghost"}`} disabled={!state.loop}
        onClick={() => engine.setLoopEnabled(!state.loopEnabled)}
        title={state.loop ? "Toggle loop (L)" : "Drag across the waveforms to set a loop"}>
        ⟲ Loop{state.loop ? ` ${formatTime(state.loop.start)}–${formatTime(state.loop.end)}` : ""}
      </button>
      {state.loop && <button className="btn ghost small" onClick={() => engine.setLoop(null)}>Clear</button>}
      <label className="master" title="Master volume">
        🔊
        <input type="range" min={0} max={1} step={0.01} value={state.masterVolume}
          onChange={(e) => engine.setMasterVolume(Number(e.target.value))} aria-label="Master volume" />
      </label>
    </div>
  );
}

/** Overlay over the waveform column: playhead, loop region, click-to-seek and drag-to-loop. */
function Timeline({ timeline }: { timeline: number }) {
  const engine = getEngine();
  const state = useSyncExternalStore(engine.subscribe, engine.getState);
  const root = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const played = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x0: number; t0: number; moved: boolean; id: number } | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const width = root.current?.clientWidth ?? 0;
      const frac = timeline ? Math.min(1, engine.currentTime / timeline) : 0;
      if (head.current) head.current.style.transform = `translateX(${frac * width}px)`;
      if (played.current) played.current.style.width = `${frac * width}px`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [engine, timeline]);

  const timeAt = (clientX: number) => {
    const rect = root.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * timeline;
  };

  const onDown = (e: RPointerEvent) => {
    if (!timeline || e.button !== 0) return;
    drag.current = { x0: e.clientX, t0: timeAt(e.clientX), moved: false, id: e.pointerId };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 6) return;
    d.moved = true;
    const t = timeAt(e.clientX);
    setSelection({ start: Math.min(d.t0, t), end: Math.max(d.t0, t) });
  };
  const onUp = (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId) return;
    if (d.moved) {
      const t = timeAt(e.clientX);
      engine.setLoop({ start: Math.min(d.t0, t), end: Math.max(d.t0, t) });
      setSelection(null);
    } else {
      engine.seek(d.t0);
    }
  };
  const onCancel = () => { drag.current = null; setSelection(null); };

  const region = selection ?? state.loop;
  const pct = (t: number) => `${timeline ? (t / timeline) * 100 : 0}%`;

  return (
    <div className="timeline" ref={root} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}>
      <div className="played" ref={played} />
      {region && (
        <div className={`loop-region ${state.loopEnabled || selection ? "active" : ""}`}
          style={{ left: pct(region.start), width: `calc(${pct(region.end)} - ${pct(region.start)})` }} />
      )}
      <div className="playhead" ref={head} />
    </div>
  );
}
