import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type DateSummary, type RecordingDate } from "../api";
import { formatDate, formatLongDate, formatTime } from "../util";

/** Browse recordings by day: every date with recordings, or everything recorded on one date. */
export default function DatesPage() {
  const { day } = useParams();
  return day ? <DayView day={day} /> : <DateList />;
}

function DateJump({ value }: { value?: string }) {
  const navigate = useNavigate();
  return (
    <input type="date" className="date-jump" aria-label="Go to date" value={value ?? ""}
      onChange={(e) => e.target.value && navigate(`/dates/${e.target.value}`)} />
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function DateList() {
  const [dates, setDates] = useState<DateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.dates().then(setDates).catch((e) => setError(e.message)); }, []);

  // Group by month so a long history stays scannable.
  const months: { label: string; dates: DateSummary[] }[] = [];
  for (const d of dates ?? []) {
    const label = new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    if (months[months.length - 1]?.label !== label) months.push({ label, dates: [] });
    months[months.length - 1].dates.push(d);
  }

  return (
    <div className="page">
      <nav className="crumbs"><Link to="/">Library</Link></nav>
      <div className="page-head">
        <h1>Dates</h1>
        <DateJump />
      </div>
      {error && <p className="error">{error}</p>}
      {!dates && !error && <div className="spinner" />}
      {dates?.length === 0 && (
        <div className="empty"><p>No recordings yet.</p></div>
      )}
      {months.map((m) => (
        <section key={m.label}>
          <h3 className="section-label">{m.label}</h3>
          <div className="list">
            {m.dates.map((d) => (
              <Link key={d.date} to={`/dates/${d.date}`} className="list-row">
                <DateChip iso={d.date} />
                <span className="card-main">
                  <span className="card-title">{formatLongDate(d.date)}</span>
                  <span className="muted small">
                    {plural(d.song_count, "song")}
                    {d.version_count !== d.song_count && ` · ${plural(d.version_count, "version")}`}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function DateChip({ iso }: { iso: string }) {
  const d = new Date(`${iso}T12:00:00`);
  return (
    <span className="date-chip" aria-hidden>
      <span>{d.toLocaleDateString(undefined, { month: "short" })}</span>
      <b>{d.getDate()}</b>
    </span>
  );
}

function DayView({ day }: { day: string }) {
  const [data, setData] = useState<RecordingDate | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    setError(null);
    api.recordingDate(day).then(setData).catch((e) => setError(e.message));
  }, [day]);

  return (
    <div className="page">
      <nav className="crumbs">
        <Link to="/">Library</Link><span className="sep">/</span><Link to="/dates">Dates</Link>
      </nav>
      <div className="page-head">
        <h1>{/^\d{4}-\d{2}-\d{2}$/.test(day) ? formatLongDate(day) : day}</h1>
        <div className="row gap">
          {data?.previous
            ? <Link className="btn small" to={`/dates/${data.previous}`} title="Previous date with recordings">← {formatDate(data.previous)}</Link>
            : <button className="btn small" disabled>← Earlier</button>}
          {data?.next
            ? <Link className="btn small" to={`/dates/${data.next}`} title="Next date with recordings">{formatDate(data.next)} →</Link>
            : <button className="btn small" disabled>Later →</button>}
          <DateJump value={day} />
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <div className="spinner" />}
      {data?.entries.length === 0 && (
        <div className="empty"><p>Nothing was recorded on this day.</p></div>
      )}
      {data && data.entries.length > 0 && (
        <div className="list">
          {data.entries.map(({ song_id, song_title, breadcrumbs, version }) => (
            <Link key={version.id} to={`/songs/${song_id}?v=${version.id}`} className="list-row">
              <span className="song-icon">♪</span>
              <span className="card-main">
                <span className="card-title">{song_title}</span>
                <span className="muted small">
                  {[
                    version.label,
                    version.tracks.map((t) => t.instrument).join(", ") || "No tracks yet",
                    version.duration ? formatTime(version.duration) : null,
                    breadcrumbs.length ? `in ${breadcrumbs.map((b) => b.name).join(" / ")}` : null,
                  ].filter(Boolean).join(" · ")}
                </span>
              </span>
              {!version.ready && version.track_count > 0 && <span className="badge">processing</span>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
