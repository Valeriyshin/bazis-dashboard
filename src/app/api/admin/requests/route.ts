import { NextRequest, NextResponse } from "next/server";
import { auth, ensureRequestsTable, ensureUsersTable, OWNER_EMAIL } from "@/auth";
import { rowsToObjects } from "@/lib/db";

export const dynamic = "force-dynamic";

async function requireOwner() {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  return !email || email !== OWNER_EMAIL ? null : email;
}

export async function GET() {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
  const db = await ensureRequestsTable();
  const rs = await db.execute("SELECT email, name, requested_at FROM access_requests ORDER BY requested_at DESC");
  return NextResponse.json({ requests: rowsToObjects(rs) });
}

// action: "approve" — выдать доступ и убрать запрос; "dismiss" — просто убрать запрос.
export async function POST(req: NextRequest) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
  const { email, action, note } = await req.json().catch(() => ({}));
  const e = String(email || "").trim().toLowerCase();
  if (!e) return NextResponse.json({ error: "Нет email" }, { status: 400 });

  const reqDb = await ensureRequestsTable();
  if (action === "approve") {
    const usersDb = await ensureUsersTable();
    await usersDb.execute({
      sql: "INSERT OR REPLACE INTO allowed_users (email, added_at, added_by, note) VALUES (?,?,?,?)",
      args: [e, new Date().toISOString(), owner, String(note || "")],
    });
  }
  await reqDb.execute({ sql: "DELETE FROM access_requests WHERE lower(email)=?", args: [e] });
  return NextResponse.json({ ok: true });
}
