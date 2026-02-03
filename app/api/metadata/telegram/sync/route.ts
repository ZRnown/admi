/**
 * Telegram 账号数据同步 API
 * POST /api/metadata/telegram/sync
 *
 * 通过 Bot 进程请求 Telegram Bridge 同步对话列表
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";

const telegramSyncRequestDir = path.resolve(process.cwd(), ".data", "telegram_sync_requests");
const telegramSyncResponseDir = path.resolve(process.cwd(), ".data", "telegram_sync_responses");
const dialogsCacheFile = path.resolve(process.cwd(), ".data", "telegram_dialogs_cache.json");
const statusFile = path.resolve(process.cwd(), ".data", "telegram_status.json");

async function waitForSyncResponse(requestId: string, maxWaitMs = 20000): Promise<any | null> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const raw = await fs.readFile(path.join(telegramSyncResponseDir, `${requestId}.json`), "utf-8");
      const response = JSON.parse(raw);
      if (response?.id === requestId) {
        await fs.unlink(path.join(telegramSyncResponseDir, `${requestId}.json`)).catch(() => {});
        return response;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function readUserInfo(accountId: string): Promise<any | null> {
  try {
    const raw = await fs.readFile(statusFile, "utf-8");
    const status = JSON.parse(raw);
    const entry = status?.[accountId];
    if (entry?.userInfo) return entry.userInfo;
  } catch {}
  return null;
}

async function readCachedDialogs(accountId: string): Promise<any[]> {
  try {
    const cacheRaw = await fs.readFile(dialogsCacheFile, "utf-8");
    const cache = JSON.parse(cacheRaw);
    if (Array.isArray(cache?.[accountId])) {
      return cache[accountId];
    }
  } catch {}
  return [];
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const accountId = typeof body?.accountId === "string" ? body.accountId : "";

    if (!accountId) {
      return NextResponse.json({ error: "缺少 accountId 参数" }, { status: 400 });
    }

    const requestId = randomUUID();
    await fs.mkdir(telegramSyncRequestDir, { recursive: true });
    await fs.writeFile(
      path.join(telegramSyncRequestDir, `${requestId}.json`),
      JSON.stringify(
        {
          id: requestId,
          accountId,
          createdAt: Date.now(),
        },
        null,
        2,
      ),
    );

    const response = await waitForSyncResponse(requestId, 60000);
    if (!response) {
      const cachedDialogs = await readCachedDialogs(accountId);
      const userInfo = await readUserInfo(accountId);
      if (cachedDialogs.length > 0 || userInfo) {
        return NextResponse.json({
          success: true,
          stale: true,
          message: "同步请求超时(60s)，返回缓存数据",
          user: userInfo || null,
          dialogs: cachedDialogs,
          dialogsCount: cachedDialogs.length,
          updatedAt: new Date().toISOString(),
        });
      }
      return NextResponse.json({ error: "同步请求超时(60s)，请确认后端已启动" }, { status: 504 });
    }

    if (!response.success) {
      const cachedDialogs = await readCachedDialogs(accountId);
      const userInfo = await readUserInfo(accountId);
      if (cachedDialogs.length > 0 || userInfo) {
        return NextResponse.json({
          success: true,
          stale: true,
          message: response.error || "同步失败，返回缓存数据",
          user: userInfo || null,
          dialogs: cachedDialogs,
          dialogsCount: cachedDialogs.length,
          updatedAt: new Date().toISOString(),
        });
      }
      return NextResponse.json({ error: response.error || "同步失败" }, { status: 400 });
    }

    const result = response.result || {};
    const dialogs = Array.isArray(result.dialogs) ? result.dialogs : [];
    const updatedAt = new Date().toISOString();

    // 尝试读取最新的缓存和状态作为兜底
    let cachedDialogs = dialogs;
    const cached = await readCachedDialogs(accountId);
    if (cached.length > 0) {
      cachedDialogs = cached;
    }

    const userInfo = result.userInfo || (await readUserInfo(accountId));

    return NextResponse.json({
      success: true,
      user: userInfo || null,
      dialogs: cachedDialogs,
      dialogsCount: cachedDialogs.length,
      updatedAt,
    });
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: 500 });
  }
}
