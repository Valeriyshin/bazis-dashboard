import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";
import { getDb } from "@/lib/db";

export const OWNER_EMAIL = (process.env.OWNER_EMAIL || "").toLowerCase();

// Белый список хранится в Turso. Владелец всегда имеет доступ.
export async function ensureUsersTable() {
  const db = getDb();
  await db.execute(
    `CREATE TABLE IF NOT EXISTS allowed_users (
       email TEXT PRIMARY KEY, added_at TEXT, added_by TEXT, note TEXT
     )`
  );
  return db;
}

export async function isAllowed(email: string): Promise<boolean> {
  const e = email.toLowerCase();
  if (e === OWNER_EMAIL) return true;
  const db = await ensureUsersTable();
  const rs = await db.execute({ sql: "SELECT 1 FROM allowed_users WHERE lower(email)=?", args: [e] });
  return rs.rows.length > 0;
}

// Запросы на доступ от тех, кто залогинился, но не в списке.
export async function ensureRequestsTable() {
  const db = getDb();
  await db.execute(
    `CREATE TABLE IF NOT EXISTS access_requests (email TEXT PRIMARY KEY, name TEXT, requested_at TEXT)`
  );
  return db;
}

export async function recordAccessRequest(email: string, name: string) {
  const db = await ensureRequestsTable();
  await db.execute({
    sql: "INSERT OR REPLACE INTO access_requests (email, name, requested_at) VALUES (?,?,?)",
    args: [email.toLowerCase(), name || "", new Date().toISOString()],
  });
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    // Ключевая проверка: вход разрешён только тем, кого владелец добавил в список.
    async signIn({ user }) {
      const email = user?.email;
      if (!email) return false;
      try {
        if (await isAllowed(email)) return true;
        // Нет доступа — оставляем запрос владельцу в админке.
        await recordAccessRequest(email, user?.name || "");
      } catch {
        /* не роняем вход из-за ошибки БД */
      }
      return false;
    },
    async session({ session }) {
      if (session.user?.email) {
        (session.user as { isOwner?: boolean }).isOwner =
          session.user.email.toLowerCase() === OWNER_EMAIL;
      }
      return session;
    },
  },
});
