import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

import { getMultiConfig, saveMultiConfig } from "@/src/config";
import { writeDiscordLibraryStatus, writeStatus, triggerFile } from "../../_lib/common";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const accountId = typeof body?.accountId === "string" ? body.accountId : "";
    const discordAccountId = typeof body?.discordAccountId === "string" ? body.discordAccountId : "";
    const useLibrary = body?.useLibrary === true || (!accountId && !!discordAccountId);

    if (body?.mode === "password") {
      return NextResponse.json({ error: "Discord 账号仅支持 Token 登录" }, { status: 400 });
    }

    if (!accountId && !useLibrary) {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }

    const multi = await getMultiConfig();

    if (useLibrary) {
      if (!discordAccountId) {
        return NextResponse.json({ error: "缺少 discordAccountId" }, { status: 400 });
      }
      if (!multi.discordAccounts) multi.discordAccounts = [];
      const account = multi.discordAccounts.find((acc) => acc.id === discordAccountId);
      if (!account) {
        return NextResponse.json({ error: "账号不存在" }, { status: 404 });
      }

      const token = typeof body?.token === "string" ? body.token.trim() : "";
      if (!token) {
        await writeDiscordLibraryStatus(discordAccountId, "error", "缺少 token");
        return NextResponse.json({ error: "缺少 token" }, { status: 400 });
      }

      account.token = token;
      account.type = body?.accountType === "bot" ? "bot" : "selfbot";
      await saveMultiConfig(multi);
      try {
        await fs.mkdir(path.dirname(triggerFile), { recursive: true });
        await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
      } catch {}
      return NextResponse.json({ ok: true, tokenStored: true });
    }

    const account = multi.accounts.find((acc) => acc.id === accountId);
    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token) {
      return NextResponse.json({ error: "缺少 token" }, { status: 400 });
    }

    const autoLogin = body?.autoLogin !== false;
    account.token = token;
    account.type = body?.accountType === "bot" ? "bot" : "selfbot";
    if (autoLogin) {
      account.loginRequested = true;
      account.loginNonce = Date.now();
      await writeStatus(account.id, "pending", "正在登录...");
    }
    await saveMultiConfig(multi);
    try {
      await fs.mkdir(path.dirname(triggerFile), { recursive: true });
      await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
    } catch {}
    return NextResponse.json({ ok: true, loginState: autoLogin ? "pending" : "idle" });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
