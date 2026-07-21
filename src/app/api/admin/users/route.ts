import { NextRequest, NextResponse } from "next/server";
import { auth, ensureUsersTable, OWNER_EMAIL } from "@/auth";
import { rowsToObjects } from "@/lib/db";

export const dynamic = "force-dynamic";

// Управлять доступами может ТОЛЬКО владелец.
async function requireOwner() {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email || email !== OWNER_EMAIL) return null;
  return email;
}

export async function GET() {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
  const db = await ensureUsersTable();
  const rs = await db.execute("SELECT email, added_at, added_by, note FROM allowed_users ORDER BY added_at DESC");
  return NextResponse.json({ owner: OWNER_EMAIL, users: rowsToObjects(rs) });
}

export async function POST(req: NextRequest) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
  const { email, note } = await req.json().catch(() => ({}));
  const e = String(email || "").trim().toLowerCase();
  if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
    return NextResponse.json({ error: "Некорректный email" }, { status: 400 });

  const db = await ensureUsersTable();
  await db.execute({
    sql: "INSERT OR REPLACE INTO allowed_users (email, added_at, added_by, note) VALUES (?,?,?,?)",
    args: [e, new Date().toISOString(), owner, String(note || "")],
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
  const { email } = await req.json().catch(() => ({}));
  const e = String(email || "").trim().toLowerCase();
  if (e === OWNER_EMAIL) return NextResponse.json({ error: "Нельзя удалить владельца" }, { status: 400 });
  const db = await ensureUsersTable();
  await db.execute({ sql: "DELETE FROM allowed_users WHERE lower(email)=?", args: [e] });
  return NextResponse.json({ ok: true });
}
