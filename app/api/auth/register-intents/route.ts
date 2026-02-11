import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/app/api/_lib/auth";
import { listRegisterIntents } from "@/app/api/_lib/registerIntents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unauthorized = await requireAuth(req);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const items = await listRegisterIntents();
    return NextResponse.json({ ok: true, items });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
