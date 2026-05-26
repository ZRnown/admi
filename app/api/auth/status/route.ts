import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/app/api/_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const authenticated = await isAuthenticated(req);
    return NextResponse.json({ authenticated });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
