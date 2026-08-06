import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/[<>&]/g, "");

// Публичная страница-приёмник кода авторизации TikTok.
// TikTok редиректит сюда с ?auth_code=... — сразу меняем код на access_token
// (TikTok Marketing API: POST /open_api/v1.3/oauth2/access_token/).
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("auth_code") || req.nextUrl.searchParams.get("code");
  const err = req.nextUrl.searchParams.get("message");

  let body: string;
  if (!code) {
    body = `<h1>Код не получен</h1>
       <p class="muted">${err ? esc(err) : "TikTok не передал auth_code. Попробуйте авторизацию ещё раз."}</p>`;
  } else {
    try {
      const res = await fetch("https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: process.env.TIKTOK_APP_ID,
          secret: process.env.TIKTOK_APP_SECRET,
          auth_code: code,
        }),
      });
      const j = await res.json();
      if (j.code !== 0 || !j.data?.access_token) {
        body = `<h1>Не удалось обменять код на токен</h1>
           <p class="muted">${esc(JSON.stringify(j).slice(0, 500))}</p>`;
      } else {
        const advIds = (j.data.advertiser_ids || []).join(", ");
        body = `<h1>Доступ к TikTok получен</h1>
           <p>Access token (долгоживущий, ~24 месяца):</p>
           <div class="code">${esc(j.data.access_token)}</div>
           <p>Advertiser ID(ы):</p>
           <div class="code">${esc(advIds || "—")}</div>
           <p class="muted">Скопируйте оба значения и передайте для сохранения в конфиг.</p>`;
      }
    } catch (e) {
      body = `<h1>Ошибка обмена кода</h1><p class="muted">${esc((e as Error).message)}</p>`;
    }
  }

  return new Response(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8">
     <title>TikTok — авторизация</title>
     <style>
       body{background:#0b0e14;color:#e6e9ef;font-family:-apple-system,Segoe UI,Roboto,sans-serif;
            display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
       .card{background:#141925;border:1px solid #263042;border-radius:14px;padding:28px;max-width:680px}
       h1{font-size:20px;margin:0 0 12px}
       .code{background:#1b2231;border:1px solid #263042;border-radius:10px;padding:14px;
             font-family:monospace;font-size:14px;word-break:break-all;margin:14px 0;user-select:all}
       .muted{color:#8b95a7;font-size:13px}
     </style></head>
     <body><div class="card">${body}</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
