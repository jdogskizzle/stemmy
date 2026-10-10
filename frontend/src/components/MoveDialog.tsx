import { useEffect, useState } from "react";
import { api, type FolderNode } from "../api";
import { Modal } from "./Modal";

/** Pick a destination folder. `excludeId` hides a folder and its subtree (can't move into yourself). */
export function MoveDialog({ title, currentParentId, excludeId, onClose, onConfirm }: {
  title: string; currentParentId: string | null; excludeId?: string;
  onClose: () => void; onConfirm: (folderId: string | null) => Promise<void>;
}) {
  const [tree, setTree] = useState<FolderNode[] | null>(null);
  const [selected, setSelected] = useState<string | null>(currentParentId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.folderTree().then(setTree).catch((e) => setError(e.message)); }, []);

  const render = (nodes: FolderNode[], depth: number): JSX.Element[] =>
    nodes.filter((n) => n.id !== excludeId).flatMap((n) => [
      <button type="button" key={n.id} className={`tree-row ${selected === n.id ? "selected" : ""}`}
        style={{ paddingLeft: 12 + depth * 18 }} onClick={() => setSelected(n.id)}>
        📁 {n.name}
      </button>,
      ...render(n.children, depth + 1),
    ]);

  const submit = async () => {
    setBusy(true);
    try { await onConfirm(selected); onClose(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <Modal title={title} onClose={onClose} onSubmit={submit} footer={<>
      <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn primary" disabled={busy || selected === currentParentId}>Move here</button>
    </>}>
      <div className="tree">
        <button type="button" className={`tree-row ${selected === null ? "selected" : ""}`} onClick={() => setSelected(null)}>
          🏠 Library root
        </button>
        {tree ? render(tree, 1) : <div className="muted pad">Loading…</div>}
      </div>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
