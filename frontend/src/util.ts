export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "";
  // Date-only strings are calendar dates; don't let timezones shift them.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "Wednesday, October 7, 2026" for a YYYY-MM-DD calendar date. */
export function formatLongDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const INSTRUMENT_PATTERNS: [RegExp, string][] = [
  [/back(ing)?[ _-]?(vox|vocal)|bvs?\b|harmony/i, "Backing Vocals"],
  [/vox|vocal|voice|sing/i, "Vocals"],
  [/acoustic|acc?gtr/i, "Acoustic Guitar"],
  [/lead/i, "Lead Guitar"],
  [/rhythm|rhy/i, "Rhythm Guitar"],
  [/bass/i, "Bass"],
  [/kick|bd\b/i, "Kick"],
  [/snare|sn\b/i, "Snare"],
  [/overhead|\boh\b|cymbal/i, "Overheads"],
  [/drum|kit/i, "Drums"],
  [/gtr|guitar/i, "Guitar"],
  [/key|piano|organ|rhodes/i, "Keys"],
  [/synth|pad/i, "Synth"],
  [/perc|shaker|tamb|conga|bongo/i, "Percussion"],
  [/horn|sax|trumpet|trombone|brass/i, "Horns"],
  [/click|metronome/i, "Click"],
  [/mix|master|full/i, "Full Mix"],
];

export function guessInstrument(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  for (const [re, name] of INSTRUMENT_PATTERNS) if (re.test(base)) return name;
  return "";
}

/** Distinct, stable lane colors keyed by instrument name. */
const PALETTE = ["#f5a524", "#4cc38a", "#5aa9ff", "#e5677d", "#b48cf2", "#2fc6c6", "#f07a3c", "#c9d84a", "#ec6fcf", "#8a9bff"];
export function laneColor(instrument: string): string {
  let h = 0;
  for (const ch of instrument.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
