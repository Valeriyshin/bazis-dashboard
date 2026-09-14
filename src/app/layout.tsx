import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Bazis — Аналитика рекламы",
  description: "Дашборд рекламных кабинетов Meta, Google Ads, Яндекс Директ и TikTok со сверкой продаж",
};

// Тема проставляется до первой отрисовки, иначе страница успевает мигнуть тёмной
// (или светлой) до того, как React смонтируется и прочитает localStorage.
// Строка inline-скрипта — статическая, без пользовательских данных.
const THEME_INIT = `(function(){try{var t=localStorage.getItem("theme");document.documentElement.setAttribute("data-theme",t==="light"?"light":"dark");}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: атрибут data-theme проставляет скрипт выше, до React,
    // поэтому разметка на сервере и клиенте тут заведомо расходится — это ожидаемо.
    <html lang="ru" data-theme="dark" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_INIT }} /></head>
      <body>{children}</body>
    </html>
  );
}
