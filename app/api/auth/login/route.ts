import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getMultiConfig } from "@/src/config";
import { applyAuthCookie, setAuthToken } from "@/app/api/_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    const config = await getMultiConfig();
    const expectedUser = config.loginUser || "admin";
    const expectedPassword = config.loginPassword || "admin123";

    if (!username || !password) {
      return NextResponse.json({ error: "Missing credentials" }, { status: 400 });
    }

    if (username !== expectedUser || password !== expectedPassword) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const token = randomUUID();
    await setAuthToken(token);
    const response = NextResponse.json({ ok: true });
    applyAuthCookie(response, token);
    return response;
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
