"use client";

import { useEffect, useState } from "react";

interface AUser { email: string; added_at: string; added_by: string; note: string }

export default function AdminPage() {
  const [users, setUsers] = useState<AUser[] | null>(null);
  const [owner, setOwner] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await fetch("/api/admin/users");
    const j = await r.json();
    if (!r.ok) { setErr(j.error || "Ошибка"); setUsers([]); return; }
    setOwner(j.owner); setUsers(j.users); setErr(null);
  };
  useEffect(() => { load(); }, []);

  const add = async () => {
    setBusy(true);
    const r = await fetch("/api/admin/users", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, note }),
    });
    const j = await r.json();
    if (!r.ok) setErr(j.error); else { setEmail(""); setNote(""); setErr(null); await load(); }
    setBusy(false);
  };
  const remove = async (e: string) => {
    if (!confirm(`Забрать доступ у ${e}?`)) return;
    const r = await fetch("/api/admin/users", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: e }),
    });
    const j = await r.json();
    if (!r.ok) setErr(j.error); else await load();
  };

  if (users === null) return <div className="wrap"><div className="center muted">Загрузка…</div></div>;

  if (err === "Доступ запрещён")
    return (
      <div className="wrap">
        <div className="panel err">Доступ к админке есть только у владельца дашборда.</div>
        <a href="/" className="btn ghost" style={{ display: "inline-block", marginTop: 14 }}>← К дашборду</a>
      </div>
    );

  return (
    <div className="wrap">
      <div className="topbar">
        <div>
          <div className="title">⚙️ Управление доступами</div>
          <div className="subtitle">Владелец: {owner}. Только вы можете выдавать и забирать доступ.</div>
        </div>
        <a href="/" className="btn ghost">← К дашборду</a>
      </div>

      <div className="panel">
        <div className="panel-title">Выдать доступ</div>
        <div className="controls">
          <div className="field" style={{ minWidth: 260 }}>
            <label>Email (Google-аккаунт)</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@gmail.com" />
          </div>
          <div className="field" style={{ minWidth: 200 }}>
            <label>Заметка (необязательно)</label>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="например: Ильнур, таргетолог" />
          </div>
          <button className="btn" onClick={add} disabled={busy || !email} style={{ alignSelf: "end" }}>
            {busy ? "…" : "Добавить"}
          </button>
        </div>
        {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          Человек заходит на дашборд, жмёт «Войти через Google» и попадает внутрь. Если его нет в списке — вход блокируется.
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Доступ выдан ({users.length})</div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Email</th><th>Заметка</th><th>Когда выдан</th><th>Кем</th><th></th></tr></thead>
            <tbody>
              <tr style={{ fontWeight: 700 }}>
                <td>{owner}</td><td>Владелец</td><td>—</td><td>—</td>
                <td><span className="badge active">всегда</span></td>
              </tr>
              {users.map((u) => (
                <tr key={u.email}>
                  <td>{u.email}</td>
                  <td className="muted">{u.note || "—"}</td>
                  <td>{u.added_at ? new Date(u.added_at).toLocaleDateString("ru-RU") : "—"}</td>
                  <td className="muted">{u.added_by || "—"}</td>
                  <td><button className="btn ghost" onClick={() => remove(u.email)}>Забрать</button></td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr><td colSpan={5} className="muted" style={{ fontStyle: "italic" }}>Пока никому не выдан доступ.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
