import { NextRequest, NextResponse } from "next/server";

import { appendRegisterIntent } from "@/app/api/_lib/registerIntents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const company = typeof body?.company === "string" ? body.company.trim() : "";
    const useCase = typeof body?.useCase === "string" ? body.useCase.trim() : "";

    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }

    await appendRegisterIntent({
      email,
      company: company || undefined,
      useCase: useCase || undefined,
    });

    return NextResponse.json({
      ok: true,
      message: "已提交，我们会尽快与你联系",
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
