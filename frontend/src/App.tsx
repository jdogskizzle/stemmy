import { Link, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import LoginPage from "./pages/Login";
import LibraryPage from "./pages/Library";
import SongPage from "./pages/Song";
import SettingsPage from "./pages/Settings";
import DatesPage from "./pages/Dates";

function Shell() {
  const { user, loading, logout } = useAuth();
  if (loading) return <div className="center-screen"><div className="spinner" /></div>;
  if (!user) return <LoginPage />;
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={24} height={24} />
          Stemmy
        </Link>
        <nav className="topbar-actions">
          <Link to="/dates" className="btn ghost small">Dates</Link>
          <Link to="/settings" className="btn ghost small">{user.username}</Link>
          <button className="btn ghost small" onClick={logout}>Log out</button>
        </nav>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/folders/:folderId" element={<LibraryPage />} />
          <Route path="/songs/:songId" element={<SongPage />} />
          <Route path="/dates" element={<DatesPage />} />
          <Route path="/dates/:day" element={<DatesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
