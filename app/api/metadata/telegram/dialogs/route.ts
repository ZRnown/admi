/**
 * 获取 Telegram 对话列表 API
 * POST /api/metadata/telegram/dialogs
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { getMultiConfig } from "@/src/config";
import { resolveDataPath } from "@/src/paths";

function normalizeTelegramDialogId(id: unknown): string {
  const raw = String(id || "").trim();
  if (raw.startsWith("-100") && /^-100\d+$/.test(raw)) {
    return raw.slice(4);
  }
  return raw;
}

function getDialogName(dialog: any): string {
  return String(dialog?.name || dialog?.title || dialog?.username || "").trim();
}

async function getRuleFallbackDialogs(accountId: string): Promise<any[]> {
  const config = await getMultiConfig();
  const candidates: any[] = [];
  for (const account of config.accounts || []) {
    const selectedListenerId = String((account as any).telegramListenerAccountId || "").trim();
    const nestedAccountIds = Array.isArray((account as any).telegramConfig?.accounts)
      ? (account as any).telegramConfig.accounts.map((item: any) => String(item?.id || "").trim()).filter(Boolean)
      : [];
    const accountMatches =
      selectedListenerId === accountId ||
      nestedAccountIds.includes(accountId) ||
      String((account as any).id || "").trim() === accountId;
    if (!accountMatches) continue;

    const mappings = Array.isArray((account as any).telegramConfig?.mappings)
      ? (account as any).telegramConfig.mappings
      : [];
    for (const mapping of mappings) {
      if (!mapping || mapping.type !== "telegram-to-mobile-client") continue;
      const id = String(mapping.sourceChannelId || "").trim();
      if (!id) continue;
      const title =
        String(mapping.sourceChannelName || "").trim() ||
        String(mapping.mobileClientChannelName || "").trim() ||
        String(mapping.mobileClientCategoryName || "").trim();
      candidates.push({
        id,
        title: title || id,
        name: title || id,
        type: id.startsWith("-100") ? "supergroup" : "chat",
        fromRule: true,
      });
    }
  }
  return candidates;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accountId } = body;

    if (!accountId) {
      return NextResponse.json({ error: "缺少 accountId 参数" }, { status: 400 });
    }

    // 读取缓存的对话列表（由 Telegram Bridge 写入）
    const cacheFile = resolveDataPath("telegram_dialogs_cache.json");
    const statusFile = resolveDataPath("telegram_status.json");

    let dialogs: any[] = [];
    let user: any = null;
    let updatedAt: string | undefined = undefined;

    // 读取对话列表
    try {
      const data = await fs.readFile(cacheFile, "utf-8");
      const cache = JSON.parse(data);
      dialogs = cache[accountId] || [];
    } catch {
      // 文件不存在
    }

    try {
      const fallbackDialogs = await getRuleFallbackDialogs(accountId);
      const byId = new Map<string, any>();
      for (const dialog of dialogs) {
        const id = normalizeTelegramDialogId(dialog?.id);
        if (id) byId.set(id, dialog);
      }
      for (const fallback of fallbackDialogs) {
        const id = normalizeTelegramDialogId(fallback?.id);
        if (!id) continue;
        const existing = byId.get(id);
        if (!existing) {
          dialogs.push(fallback);
          byId.set(id, fallback);
          continue;
        }
        if (!getDialogName(existing) && getDialogName(fallback)) {
          existing.title = fallback.title;
          existing.name = fallback.name;
        }
      }
    } catch {
      // ignore fallback failures
    }

    // 读取用户信息（从状态文件）
    try {
      const statusData = await fs.readFile(statusFile, "utf-8");
      const status = JSON.parse(statusData);
      const accountStatus = status[accountId];
      if (accountStatus && accountStatus.userInfo) {
        user = accountStatus.userInfo;
      }
    } catch {
      // 文件不存在
    }

    try {
      const stat = await fs.stat(cacheFile);
      updatedAt = stat.mtime.toISOString();
    } catch {
      // ignore
    }
    try {
      const stat = await fs.stat(statusFile);
      if (!updatedAt || stat.mtime.getTime() > new Date(updatedAt).getTime()) {
        updatedAt = stat.mtime.toISOString();
      }
    } catch {
      // ignore
    }

    if (dialogs.length === 0 && !user) {
      return NextResponse.json({
        user: null,
        dialogs: [],
        updatedAt,
        message: "请先启动实例并连接 Telegram 账号以获取对话列表"
      });
    }

    return NextResponse.json({ user, dialogs, updatedAt });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
