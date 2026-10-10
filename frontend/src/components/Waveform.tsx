import { useEffect, useRef } from "react";

/**
 * Canvas waveform from precomputed peaks (0..1 at `peaksPerSecond`).
 * The waveform is drawn against `timelineDuration` so shorter stems line up with longer ones.
 */
export function Waveform({ peaks, peaksPerSecond, timelineDuration, color, dimmed, normalize = true }: {
  peaks: ArrayLike<number> | null;
  peaksPerSecond: number;
  timelineDuration: number;
  color: string;
  dimmed?: boolean;
  normalize?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (!width || !height) return;
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      const g = el.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, width, height);
      const mid = height / 2;
      g.fillStyle = color;
      g.globalAlpha = dimmed ? 0.22 : 0.9;
      if (!peaks || !peaks.length || !timelineDuration) {
        g.fillRect(0, mid - 0.5, width, 1);
        return;
      }
      let max = 0;
      if (normalize) for (let i = 0; i < peaks.length; i++) max = Math.max(max, peaks[i]);
      const scale = normalize && max > 0 ? 1 / max : 1;
      const perPx = (timelineDuration * peaksPerSecond) / width;
      const bar = 2;
      for (let x = 0; x < width; x += bar) {
        const from = Math.floor(x * perPx);
        if (from >= peaks.length) break;
        const to = Math.min(peaks.length, Math.max(from + 1, Math.floor((x + bar) * perPx)));
        let v = 0;
        for (let i = from; i < to; i++) if (peaks[i] > v) v = peaks[i];
        const h = Math.max(1, v * scale * (height - 2));
        g.fillRect(x, mid - h / 2, bar - 0.6, h);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [peaks, peaksPerSecond, timelineDuration, color, dimmed, normalize]);

  return <canvas ref={canvas} className="waveform" />;
}
