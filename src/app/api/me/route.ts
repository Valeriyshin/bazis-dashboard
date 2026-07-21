import { NextResponse } from "next/server";
import { auth, OWNER_EMAIL } from "@/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  return NextResponse.json({
    email,
    name: session?.user?.name ?? null,
    isOwner: !!email && email.toLowerCase() === OWNER_EMAIL,
  });
}
