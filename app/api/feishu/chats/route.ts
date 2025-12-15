import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, type AccountConfig } from "@/src/config";
import { FeishuSender } from "@/src/feishuSender";
import { getEnv } from "@/src/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const accountId = body?.accountId as string | undefined;
    if (!accountId) {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    const account: AccountConfig | undefined = multi.accounts.find((a) => a.id === accountId);
    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    const env = getEnv();
    const proxy = account.proxyUrl || env.PROXY_URL;
    const httpAgent = proxy ? new (await import("proxy-agent")).ProxyAgent(proxy as any) : undefined;

    const sender = new FeishuSender(
      "temp",
      httpAgent,
      account.feishuAppId,
      account.feishuAppSecret,
    );

    // 使用 listGroups 获取群列表
    const raw = await (sender as any).listGroups(true); // 传 true 表示返回数据而不是只打印
    if (!raw || raw.error) {
      const code = raw?.raw?.code;
      const msg = raw?.raw?.msg;
      return NextResponse.json(
        {
          error:
            (msg && code ? `飞书错误(${code}): ${msg}` : raw?.error) ||
            "获取飞书群组失败，请检查 AppID/Secret 与权限",
          raw: raw?.raw,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({ items: raw.items || [] });
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message || e) },
      { status: 500 },
    );
  }
}


