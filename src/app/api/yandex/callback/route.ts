import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// Публичная страница-приёмник OAuth-токена Яндекса.
// Яндекс отдаёт токен во фрагменте URL (#access_token=...), поэтому достаём его на клиенте.
export async function GET(req: NextRequest) {
  const err = req.nextUrl.searchParams.get("error_description") || req.nextUrl.searchParams.get("error");

  return new Response(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8">
     <title>Яндекс — авторизация</title>
     <style>
       body{background:#0b0e14;color:#e6e9ef;font-family:-apple-system,Segoe UI,Roboto,sans-serif;
            display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
       .card{background:#141925;border:1px solid #263042;border-radius:14px;padding:28px;max-width:720px}
       h1{font-size:20px;margin:0 0 12px}
       .code{background:#1b2231;border:1px solid #263042;border-radius:10px;padding:14px;
             font-family:monospace;font-size:14px;word-break:break-all;margin:14px 0;user-select:all}
       .muted{color:#8b95a7;font-size:13px}
       .err{color:#f87171}
     </style></head>
     <body><div class="card" id="card">
       ${err ? `<h1 class="err">Ошибка авторизации</h1><p class="muted">${err.replace(/[<>&]/g, "")}</p>` : `<h1>Читаю токен…</h1>`}
     </div>
     <script>
       (function () {
         var h = new URLSearchParams(location.hash.replace(/^#/, ""));
         var t = h.get("access_token");
         var exp = h.get("expires_in");
         if (!t) return;
         var days = exp ? Math.round(Number(exp) / 86400) : null;
         document.getElementById("card").innerHTML =
           '<h1>OAuth-токен Яндекса получен</h1>' +
           '<p>Скопируйте его целиком:</p>' +
           '<div class="code">' + t + '</div>' +
           '<p class="muted">' + (days ? 'Действует примерно ' + days + ' дн. ' : '') +
           'Это секрет — не публикуйте его.</p>';
       })();
     </script>
     </body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
