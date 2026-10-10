import { useEffect, useState, type FormEvent } from "react";
import { api, type User } from "../api";
import { useAuth } from "../auth";
import { ConfirmDialog } from "../components/Modal";
import { formatDate } from "../util";

export default function SettingsPage() {
  const { user } = useAuth();
  return (
    <div className="page narrow">
      <h1>Settings</h1>
      <ChangePassword />
      {user?.is_admin && <ManageUsers me={user} />}
      <section className="panel">
        <h2>API</h2>
        <p className="muted">
          Everything in the web app goes through a documented REST API, so other clients can use it too.
          Browse it at <a href="/api/docs" target="_blank" rel="noreferrer">/api/docs</a>.
        </p>
      </section>
    </div>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.changePassword(current, next);
      setMessage({ ok: true, text: "Password changed." });
      setCurrent(""); setNext("");
    } catch (err) { setMessage({ ok: false, text: (err as Error).message }); }
  };
  return (
    <form className="panel" onSubmit={submit}>
      <h2>Change password</h2>
      <label className="field"><span>Current password</span>
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
      <label className="field"><span>New password (6+ characters)</span>
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
      {message && <p className={message.ok ? "ok" : "error"}>{message.text}</p>}
      <button className="btn primary" disabled={!current || next.length < 6}>Update password</button>
    </form>
  );
}

function ManageUsers({ me }: { me: User }) {
  const [users, setUsers] = useState<User[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<User | null>(null);
  const reload = () => api.users().then(setUsers).catch((e) => setError(e.message));
  useEffect(() => { reload(); }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.createUser(username.trim(), password, isAdmin);
      setUsername(""); setPassword(""); setIsAdmin(false);
      reload();
    } catch (err) { setError((err as Error).message); }
  };

  return (
    <section className="panel">
      <h2>Band members</h2>
      <div className="list">
        {users.map((u) => (
          <div key={u.id} className="list-row static">
            <span className="card-main">
              <span className="card-title">{u.username}{u.id === me.id && " (you)"}</span>
              <span className="muted small">{u.is_admin ? "Admin" : "Member"} · joined {formatDate(u.created_at)}</span>
            </span>
            {u.id !== me.id && <>
              <button className="btn ghost small" onClick={() => api.updateUser(u.id, { is_admin: !u.is_admin }).then(reload)}>
                {u.is_admin ? "Remove admin" : "Make admin"}
              </button>
              <button className="btn ghost small danger-text" onClick={() => setToDelete(u)}>Remove</button>
            </>}
          </div>
        ))}
      </div>
      <form className="add-user" onSubmit={create}>
        <h3>Add a member</h3>
        <div className="form-grid">
          <label className="field"><span>Username</span><input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></label>
          <label className="field"><span>Temporary password</span><input value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label>
        </div>
        <label className="checkbox"><input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> Admin (can manage members)</label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={!username.trim() || password.length < 6}>Add member</button>
      </form>
      {toDelete && (
        <ConfirmDialog title="Remove member" message={<>Remove <b>{toDelete.username}</b>? Their uploads stay in the library.</>}
          confirmLabel="Remove" onClose={() => setToDelete(null)}
          onConfirm={async () => { await api.deleteUser(toDelete.id); reload(); }} />
      )}
    </section>
  );
}
