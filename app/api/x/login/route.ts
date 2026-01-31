import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getMultiConfig, saveMultiConfig } from "@/src/config";
import { requireAuth } from "@/app/api/_lib/auth";
import { triggerFile } from "@/app/api/_lib/common";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_X_BASE_URL = "https://api.twitterapi.io";

async function postJson(url: string, headers: Record<string, string>, body: any) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(text || "响应不是有效 JSON");
  }
  if (!res.ok) {
    const message = json?.msg || json?.message || json?.error || text || "请求失败";
    throw new Error(message);
  }
  return json;
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth) return auth;

    const body = await req.json().catch(() => ({}));
    const accountId = typeof body?.accountId === "string" ? body.accountId : "";
    const xAccountId = typeof body?.xAccountId === "string" ? body.xAccountId : "";
    const useLibrary = body?.useLibrary === true || (!accountId && !!xAccountId);
    if (!accountId && !useLibrary) {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    if (useLibrary) {
      if (!xAccountId) {
        return NextResponse.json({ error: "缺少 xAccountId" }, { status: 400 });
      }
      const account = (multi.xAccounts || []).find((acc) => acc.id === xAccountId);
      if (!account) {
        return NextResponse.json({ error: "账号不存在" }, { status: 404 });
      }

      const mode = body?.mode === "password" ? "password" : "token";

      const apiKeyRaw = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
      const apiBaseUrlRaw =
        typeof body?.apiBaseUrl === "string" && body.apiBaseUrl.trim()
          ? body.apiBaseUrl.trim()
          : "";

      const apiKey = apiKeyRaw || account.apiKey || "";
      const apiBaseUrl = apiBaseUrlRaw || account.apiBaseUrl || DEFAULT_X_BASE_URL;

      if (apiKey) account.apiKey = apiKey;
      if (apiBaseUrl) account.apiBaseUrl = apiBaseUrl;

      if (mode === "token") {
        const loginCookie =
          typeof body?.loginCookie === "string"
            ? body.loginCookie.trim()
            : typeof body?.token === "string"
              ? body.token.trim()
              : "";
        if (!loginCookie) {
          return NextResponse.json({ error: "缺少 loginCookie/token" }, { status: 400 });
        }
        const loginUserName =
          typeof body?.loginUserName === "string" && body.loginUserName.trim()
            ? body.loginUserName.trim().replace(/^@+/, "")
            : undefined;
        const loginEmail =
          typeof body?.loginEmail === "string" && body.loginEmail.trim()
            ? body.loginEmail.trim()
            : undefined;

        account.loginCookie = loginCookie;
        if (loginUserName) account.loginUserName = loginUserName;
        if (loginEmail) account.loginEmail = loginEmail;

        await saveMultiConfig(multi);
        try {
          await fs.mkdir(path.dirname(triggerFile), { recursive: true });
          await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
        } catch {}
        return NextResponse.json({ ok: true, loginCookieStored: true });
      }

      if (!apiKey) {
        return NextResponse.json({ error: "缺少 x-api-key（apiKey）" }, { status: 400 });
      }

      const userName =
        typeof body?.userName === "string"
          ? body.userName.trim()
          : typeof body?.loginUserName === "string"
            ? body.loginUserName.trim()
            : "";
      const email = typeof body?.email === "string" ? body.email.trim() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      const proxy = typeof body?.proxy === "string" ? body.proxy.trim() : "";
      const totpSecret =
        typeof body?.totpSecret === "string" && body.totpSecret.trim() ? body.totpSecret.trim() : undefined;

      if (!userName || !email || !password) {
        return NextResponse.json({ error: "缺少 userName/email/password" }, { status: 400 });
      }
      if (!proxy) {
        return NextResponse.json({ error: "缺少 proxy（登录接口要求）" }, { status: 400 });
      }

      const url = new URL("/twitter/user_login_v2", apiBaseUrl);
      let payload: any;
      try {
        payload = await postJson(
          url.toString(),
          { "x-api-key": apiKey },
          {
            user_name: userName,
            email,
            password,
            proxy,
            ...(totpSecret ? { totp_secret: totpSecret } : {}),
          },
        );
      } catch (e: any) {
        return NextResponse.json({ error: String(e?.message || e) }, { status: 502 });
      }

      const loginCookie = payload?.login_cookie || payload?.loginCookie || payload?.data?.login_cookie;
      const status = payload?.status;
      if (!loginCookie || (status && status !== "success")) {
        const msg = payload?.msg || payload?.message || "登录失败";
        return NextResponse.json({ error: msg }, { status: 400 });
      }

      account.loginCookie = String(loginCookie);
      account.loginUserName = userName.replace(/^@+/, "");
      account.loginEmail = email;
      account.loginPassword = password;
      account.loginTotpSecret = totpSecret;
      account.loginProxy = proxy;

      await saveMultiConfig(multi);
      try {
        await fs.mkdir(path.dirname(triggerFile), { recursive: true });
        await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
      } catch {}

      return NextResponse.json({ ok: true, loginCookieStored: true });
    }

    const account = multi.accounts.find((acc) => acc.id === accountId);
    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    const mode = body?.mode === "password" ? "password" : "token";

    const apiKeyRaw = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    const apiBaseUrlRaw =
      typeof body?.apiBaseUrl === "string" && body.apiBaseUrl.trim()
        ? body.apiBaseUrl.trim()
        : "";

    const apiKey = apiKeyRaw || account.xConfig?.apiKey || "";
    const apiBaseUrl = apiBaseUrlRaw || account.xConfig?.apiBaseUrl || DEFAULT_X_BASE_URL;

    account.xConfig = account.xConfig || {};
    if (apiKey) account.xConfig.apiKey = apiKey;
    if (apiBaseUrl) account.xConfig.apiBaseUrl = apiBaseUrl;

    if (mode === "token") {
      const loginCookie =
        typeof body?.loginCookie === "string"
          ? body.loginCookie.trim()
          : typeof body?.token === "string"
            ? body.token.trim()
            : "";
      if (!loginCookie) {
        return NextResponse.json({ error: "缺少 loginCookie/token" }, { status: 400 });
      }
      const loginUserName =
        typeof body?.loginUserName === "string" && body.loginUserName.trim()
          ? body.loginUserName.trim().replace(/^@+/, "")
          : undefined;
      const loginEmail =
        typeof body?.loginEmail === "string" && body.loginEmail.trim()
          ? body.loginEmail.trim()
          : undefined;

      account.xConfig.loginCookie = loginCookie;
      if (loginUserName) account.xConfig.loginUserName = loginUserName;
      if (loginEmail) account.xConfig.loginEmail = loginEmail;

      await saveMultiConfig(multi);
      try {
        await fs.mkdir(path.dirname(triggerFile), { recursive: true });
        await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
      } catch {}
      return NextResponse.json({ ok: true, loginCookieStored: true });
    }

    if (!apiKey) {
      return NextResponse.json({ error: "缺少 x-api-key（apiKey）" }, { status: 400 });
    }

    const userName =
      typeof body?.userName === "string"
        ? body.userName.trim()
        : typeof body?.loginUserName === "string"
          ? body.loginUserName.trim()
          : "";
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const proxy = typeof body?.proxy === "string" ? body.proxy.trim() : "";
    const totpSecret =
      typeof body?.totpSecret === "string" && body.totpSecret.trim() ? body.totpSecret.trim() : undefined;

    if (!userName || !email || !password) {
      return NextResponse.json({ error: "缺少 userName/email/password" }, { status: 400 });
    }
    if (!proxy) {
      return NextResponse.json({ error: "缺少 proxy（登录接口要求）" }, { status: 400 });
    }

    const url = new URL("/twitter/user_login_v2", apiBaseUrl);
    let payload: any;
    try {
      payload = await postJson(
        url.toString(),
        { "x-api-key": apiKey },
        {
          user_name: userName,
          email,
          password,
          proxy,
          ...(totpSecret ? { totp_secret: totpSecret } : {}),
        },
      );
    } catch (e: any) {
      return NextResponse.json({ error: String(e?.message || e) }, { status: 502 });
    }

    const loginCookie = payload?.login_cookie || payload?.loginCookie || payload?.data?.login_cookie;
    const status = payload?.status;
    if (!loginCookie || (status && status !== "success")) {
      const msg = payload?.msg || payload?.message || "登录失败";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    account.xConfig.loginCookie = String(loginCookie);
    account.xConfig.loginUserName = userName.replace(/^@+/, "");
    account.xConfig.loginEmail = email;
    account.xConfig.loginPassword = password;
    account.xConfig.loginTotpSecret = totpSecret;
    account.xConfig.loginProxy = proxy;

    await saveMultiConfig(multi);
    try {
      await fs.mkdir(path.dirname(triggerFile), { recursive: true });
      await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
    } catch {}

    return NextResponse.json({ ok: true, loginCookieStored: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
