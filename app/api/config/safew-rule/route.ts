import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { requireAuth } from "@/app/api/_lib/auth";
import { getMultiConfig, saveMultiConfig } from "@/src/config";
import { triggerFile } from "../../_lib/common";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth) return auth;

    const body = await req.json();
    const accountId = cleanString(body?.accountId);
    const mappingId = cleanString(body?.mappingId);
    const mappingIndex = Number.isInteger(body?.mappingIndex) ? body.mappingIndex : -1;
    const safewAccountId = cleanString(body?.safewAccountId);

    if (!accountId || (!mappingId && mappingIndex < 0)) {
      return NextResponse.json({ error: "Missing accountId or mapping reference" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    const account = multi.accounts.find((item) => item.id === accountId);
    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    const mappings = account.mappings || [];
    const mapping =
      mappingId
        ? mappings.find((item: any) => item?.id === mappingId)
        : mappings[mappingIndex];
    if (!mapping) {
      return NextResponse.json({ error: "Mapping not found" }, { status: 404 });
    }

    if (safewAccountId) {
      const safewAccounts = Array.isArray((account as any).safewAccounts) ? (account as any).safewAccounts : [];
      const exists = safewAccounts.some((item: any) => item?.id === safewAccountId);
      if (!exists) {
        return NextResponse.json({ error: "SafeW bot not found" }, { status: 400 });
      }
      (mapping as any).safewAccountId = safewAccountId;
    } else {
      delete (mapping as any).safewAccountId;
    }

    await saveMultiConfig(multi);
    try {
      await fs.mkdir(path.dirname(triggerFile), { recursive: true });
      await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
    } catch {}

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
