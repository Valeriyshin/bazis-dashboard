import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

// Edge-совместимая часть конфига (без обращений к БД) — используется в middleware.
export const authConfig: NextAuthConfig = {
  providers: [Google],
  trustHost: true,
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    // Пускаем в дашборд только с активной сессией.
    authorized({ auth }) {
      return !!auth?.user;
    },
  },
};
