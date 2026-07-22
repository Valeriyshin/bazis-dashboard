import { signIn, auth } from "@/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");
  const { error } = await searchParams;

  return (
    <div className="wrap" style={{ maxWidth: 460, paddingTop: 90 }}>
      <div className="panel" style={{ textAlign: "center" }}>
        <div className="title" style={{ marginBottom: 6 }}>📊 Bazis Dashboard</div>
        <div className="muted" style={{ marginBottom: 22, fontSize: 13 }}>
          Аналитика рекламы Meta · Google Ads
        </div>

        {error && (
          <div className="err" style={{ marginBottom: 18, fontSize: 13 }}>
            {error === "AccessDenied"
              ? "Доступ ещё не выдан. Запрос отправлен администратору — как только его одобрят, вы сможете войти."
              : "Не удалось войти. Попробуйте ещё раз."}
          </div>
        )}

        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button className="btn" type="submit" style={{ width: "100%", padding: "12px 16px", fontSize: 14 }}>
            Войти через Google
          </button>
        </form>
      </div>
    </div>
  );
}
