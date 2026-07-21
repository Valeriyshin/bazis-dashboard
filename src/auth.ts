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

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    // Ключевая проверка: вход разрешён только тем, кого владелец добавил в список.
    async signIn({ user }) {
      const email = user?.email;
      if (!email) return false;
      try {
        return await isAllowed(email);
      } catch {
        return false;
      }
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
