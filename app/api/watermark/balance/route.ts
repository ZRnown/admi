import { NextRequest, NextResponse } from "next/server";

import { getMultiConfig } from "@/src/config";
import { extractWaveSpeedBalanceSummary } from "@/src/wavespeedAccount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAVESPEED_BALANCE_ENDPOINT = "https://api.wavespeed.ai/api/v3/balance";

function getErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export async function GET(req: NextRequest) {
  try {
    const accountId = req.nextUrl.searchParams.get("accountId")?.trim();
    if (!accountId) {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    const account = multi.accounts.find((item) => item.id === accountId);
    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    if (account.watermarkRemoval?.provider === "iopaint") {
      return NextResponse.json({ error: "IOPaint 本地模型没有余额查询" }, { status: 400 });
    }

    const apiKey = String(account.watermarkRemoval?.apiKey || "").trim();
    if (!apiKey) {
      return NextResponse.json({ error: "未配置 WaveSpeed API Key" }, { status: 400 });
    }

    const upstream = await fetch(WAVESPEED_BALANCE_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const raw = await upstream.text();
    let payload: unknown = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { raw };
    }

    if (!upstream.ok) {
      return NextResponse.json(
        {
          error: getErrorMessage(payload) || `WaveSpeed 请求失败 (${upstream.status})`,
          status: upstream.status,
        },
        { status: upstream.status },
      );
    }

    const summary = extractWaveSpeedBalanceSummary(payload);
    return NextResponse.json({
      success: true,
      remainingCredits: summary.remainingCredits,
      planName: summary.planName,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: String(error?.message || error || "获取余额失败") },
      { status: 500 },
    );
  }
}
