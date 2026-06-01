import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const authFile = path.resolve(process.cwd(), ".data", "auth.json");
const cookieName = "auth_token";

type AuthState = {
  token?: string;
  tokens?: Record<string, number>;
  issuedAt?: number;
};

const maxTokenAgeMs = 60 * 60 * 24 * 7 * 1000;

function normalizeAuthState(state: AuthState): AuthState {
  const now = Date.now();
  const tokens: Record<string, number> = {};

  if (state.token) {
    tokens[state.token] = typeof state.issuedAt === "number" ? state.issuedAt : now;
  }

  if (state.tokens && typeof state.tokens === "object") {
    for (const [token, issuedAt] of Object.entries(state.tokens)) {
      if (!token) continue;
      const timestamp = typeof issuedAt === "number" && Number.isFinite(issuedAt) ? issuedAt : now;
      if (now - timestamp <= maxTokenAgeMs) {
        tokens[token] = timestamp;
      }
    }
  }

  return { tokens };
}

async function readAuthState(): Promise<AuthState> {
  try {
    const buf = await fs.readFile(authFile, "utf-8");
    return JSON.parse(buf);
  } catch {
    return {};
  }
}

async function writeAuthState(state: AuthState | null) {
  const hasTokens = state?.tokens && Object.keys(state.tokens).length > 0;
  try {
    if (!state || (!state.token && !hasTokens)) {
      await fs.unlink(authFile);
      return;
    }
  } catch {}
  try {
    await fs.mkdir(path.dirname(authFile), { recursive: true });
    await fs.writeFile(authFile, JSON.stringify(state, null, 2), "utf-8");
  } catch {}
}

export function getAuthToken(req: NextRequest): string | undefined {
  return req.cookies.get(cookieName)?.value;
}

export async function isAuthenticated(req: NextRequest): Promise<boolean> {
  const token = getAuthToken(req);
  if (!token) return false;
  const state = normalizeAuthState(await readAuthState());
  return Boolean(state.tokens?.[token]);
}

export async function requireAuth(req: NextRequest): Promise<NextResponse | null> {
  const ok = await isAuthenticated(req);
  if (!ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function setAuthToken(token: string) {
  const state = normalizeAuthState(await readAuthState());
  const tokens = state.tokens || {};
  tokens[token] = Date.now();
  await writeAuthState({ tokens });
}

export async function clearAuthToken(token?: string) {
  if (!token) {
    await writeAuthState(null);
    return;
  }
  const state = normalizeAuthState(await readAuthState());
  const tokens = state.tokens || {};
  delete tokens[token];
  await writeAuthState(Object.keys(tokens).length > 0 ? { tokens } : null);
}

export function applyAuthCookie(response: NextResponse, token: string) {
  response.cookies.set(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export function clearAuthCookie(response: NextResponse) {
  response.cookies.set(cookieName, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
