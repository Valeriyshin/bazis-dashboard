import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Meta Ads — TDS Media | Аналитика",
  description: "Дашборд показателей рекламного кабинета Meta с динамикой и сравнением периодов",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
