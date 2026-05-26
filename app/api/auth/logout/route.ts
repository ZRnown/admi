import { NextRequest, NextResponse } from "next/server";
import { clearAuthCookie, clearAuthToken } from "@/app/api/_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest) {
  try {
    await clearAuthToken();
    const response = NextResponse.json({ ok: true });
    clearAuthCookie(response);
    return response;
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
