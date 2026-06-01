import { NextRequest, NextResponse } from "next/server";
import { clearAuthCookie, clearAuthToken, getAuthToken } from "@/app/api/_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await clearAuthToken(getAuthToken(req));
    const response = NextResponse.json({ ok: true });
    clearAuthCookie(response);
    return response;
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
