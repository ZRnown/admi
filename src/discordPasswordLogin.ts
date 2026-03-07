export interface DiscordPasswordLoginParams {
  email: string;
  password: string;
  totpSecret?: string;
  proxyUrl?: string;
}

export interface DiscordPasswordLoginErrorContext {
  loginPageVisible: boolean;
  mfaRequired: boolean;
  pageText: string;
}

export function normalizeDiscordStorageToken(raw?: string | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function buildDiscordPasswordLoginError(context: DiscordPasswordLoginErrorContext): string {
  const pageText = String(context.pageText || "").toLowerCase();
  if (context.mfaRequired) {
    return "MFA_REQUIRED: 需要双重验证，请检查验证码/密钥是否正确";
  }
  if (pageText.includes("captcha") || pageText.includes("human") || pageText.includes("verify")) {
    return "CAPTCHA_REQUIRED: Discord 要求验证码，当前自动登录无法继续";
  }
  if (pageText.includes("invalid") || pageText.includes("incorrect") || pageText.includes("wrong password")) {
    return "INVALID_CREDENTIALS: 邮箱或密码错误";
  }
  if (context.loginPageVisible) {
    return "LOGIN_FAILED: 登录后仍停留在登录页，请检查账号状态或验证码挑战";
  }
  return "LOGIN_FAILED: 未获取到 Discord Token";
}

function decodeBase32(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "")) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(secret: string, step = 30, digits = 6): string {
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const counter = Math.floor(Date.now() / 1000 / step);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter % 0x100000000, 4);
  const hmac = crypto.createHmac("sha1", decodeBase32(secret)).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(code % (10 ** digits)).padStart(digits, "0");
}

export async function loginDiscordWithPassword(params: DiscordPasswordLoginParams): Promise<{ token: string }> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    proxy: params.proxyUrl ? { server: params.proxyUrl } : undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  try {
    await page.goto("https://discord.com/login", { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.locator('input[name="email"]').fill(params.email, { timeout: 30000 });
    await page.locator('input[name="password"]').fill(params.password, { timeout: 30000 });
    await page.locator('button[type="submit"]').click({ timeout: 30000 });

    if (params.totpSecret) {
      try {
        const otpInput = page.locator('input[inputmode="numeric"], input[autocomplete="one-time-code"], input[name="code"]');
        await otpInput.waitFor({ timeout: 15000, state: "visible" });
        const code = generateTotp(params.totpSecret);
        await otpInput.fill(code);
        const mfaSubmit = page.locator('button[type="submit"]');
        await mfaSubmit.click({ timeout: 10000 }).catch(() => {});
      } catch {
      }
    }

    await page.waitForTimeout(5000);
    await page.waitForFunction(
      () => {
        const browserWindow = globalThis as any;
        return browserWindow.location?.pathname?.startsWith("/channels") || !!browserWindow.localStorage?.getItem("token");
      },
      { timeout: 90000 },
    ).catch(() => {});

    const rawToken = await page.evaluate(() => {
      const browserWindow = globalThis as any;
      return browserWindow.localStorage?.getItem("token") || null;
    });
    const token = normalizeDiscordStorageToken(rawToken);
    if (token) {
      return { token };
    }

    const pageText = (await page.locator("body").innerText().catch(() => "")).slice(0, 4000);
    const loginPageVisible = await page.locator('input[name="email"]').isVisible().catch(() => false);
    const mfaRequired = await page.locator('input[inputmode="numeric"], input[autocomplete="one-time-code"], input[name="code"]').isVisible().catch(() => false);
    throw new Error(buildDiscordPasswordLoginError({ loginPageVisible, mfaRequired, pageText }));
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
