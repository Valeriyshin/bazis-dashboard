import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// Публичная страница-приёмник кода авторизации TikTok.
// TikTok редиректит сюда с ?auth_code=... — показываем код, чтобы его можно было скопировать.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("auth_code") || req.nextUrl.searchParams.get("code");
  const err = req.nextUrl.searchParams.get("message");

  const body = code
    ? `<h1>Код авторизации TikTok получен</h1>
       <p>Скопируйте его и передайте для обмена на access token:</p>
       <div class="code">${code.replace(/[<>&]/g, "")}</div>
       <p class="muted">Код одноразовый и действует недолго — используйте сразу.</p>`
    : `<h1>Код не получен</h1>
       <p class="muted">${err ? err.replace(/[<>&]/g, "") : "TikTok не передал auth_code. Попробуйте авторизацию ещё раз."}</p>`;

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
