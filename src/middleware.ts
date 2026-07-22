import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

// Закрывает весь дашборд: без сессии — редирект на /login.
export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // Не трогаем сам auth, статику и логин-страницу.
  matcher: ["/((?!api/auth|api/tiktok/callback|login|_next/static|_next/image|favicon.ico).*)"],
};
