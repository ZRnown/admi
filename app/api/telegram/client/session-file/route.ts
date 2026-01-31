import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { getMultiConfig, saveMultiConfig } from "@/src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const accountId = form.get("accountId");
    const telegramAccountId = form.get("telegramAccountId");
    const role = form.get("role");
    const useLibrary = form.get("useLibrary") === "1" || form.get("useLibrary") === "true" || !accountId;
    const file = form.get("file");

    if ((!accountId || typeof accountId !== "string") && !useLibrary) {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "缺少 session 文件" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    if (useLibrary) {
      if (!telegramAccountId || typeof telegramAccountId !== "string") {
        return NextResponse.json({ error: "缺少 telegramAccountId" }, { status: 400 });
      }
      const buffer = Buffer.from(await (file as File).arrayBuffer());
      if (buffer.length === 0) {
        return NextResponse.json({ error: "Session 文件为空" }, { status: 400 });
      }

      const sessionDir = path.join(process.cwd(), ".data", "telegram_sessions");
      await fs.mkdir(sessionDir, { recursive: true });
      const sessionKey = telegramAccountId.trim();
      const sessionPath = path.join(sessionDir, `${sessionKey}.session`);
      await fs.writeFile(sessionPath, buffer);

      if (!multi.telegramAccounts) multi.telegramAccounts = [];
      let entry = multi.telegramAccounts.find((acc) => acc.id === telegramAccountId);
      if (!entry) {
        entry = {
          id: telegramAccountId,
          name: "Telegram Client",
          type: "client",
          token: "",
          enabled: false,
        };
        multi.telegramAccounts.push(entry);
      }
      entry.sessionPath = sessionPath;
      entry.sessionString = undefined;
      (entry as any).sessionType = "file";

      await saveMultiConfig(multi);
      return NextResponse.json({ success: true, sessionPath });
    }

    const account = multi.accounts.find((a) => a.id === accountId);
    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    const buffer = Buffer.from(await (file as File).arrayBuffer());
    if (buffer.length === 0) {
      return NextResponse.json({ error: "Session 文件为空" }, { status: 400 });
    }

    const sessionDir = path.join(process.cwd(), ".data", "telegram_sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionKey =
      typeof telegramAccountId === "string" && telegramAccountId.trim()
        ? telegramAccountId.trim()
        : String(accountId);
    const sessionPath = path.join(sessionDir, `${sessionKey}.session`);
    await fs.writeFile(sessionPath, buffer);

    if (typeof telegramAccountId === "string" && telegramAccountId.trim()) {
      if (!account.telegramConfig) {
        account.telegramConfig = { accounts: [], mappings: [], enableTelegramForward: false };
      }
      if (!account.telegramConfig.accounts) {
        account.telegramConfig.accounts = [];
      }
      let entry = account.telegramConfig.accounts.find((acc) => acc.id === telegramAccountId);
      if (!entry) {
        entry = {
          id: telegramAccountId,
          name: role === "listener" ? "Telegram Listener" : role === "sender" ? "Telegram Sender" : "Telegram Client",
          type: "client",
          token: "",
          enabled: false,
        };
        if (role === "listener" || role === "sender") {
          (entry as any).role = role;
        }
        account.telegramConfig.accounts.push(entry);
      }
      entry.sessionPath = sessionPath;
      entry.sessionString = undefined;
      (entry as any).sessionType = "file";
    } else {
      account.telegramSessionPath = sessionPath;
      account.telegramSessionString = undefined;
      (account as any).sessionType = "file";
    }
    await saveMultiConfig(multi);

    return NextResponse.json({ success: true, sessionPath });
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message || e) },
      { status: 500 },
    );
  }
}
