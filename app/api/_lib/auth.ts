import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const authFile = path.resolve(process.cwd(), ".data", "auth.json");
const cookieName = "auth_token";

type AuthState = {
  token?: string;
  issuedAt?: number;
};

async function readAuthState(): Promise<AuthState> {
  try {
    const buf = await fs.readFile(authFile, "utf-8");
    return JSON.parse(buf);
  } catch {
    return {};
  }
}

async function writeAuthState(state: AuthState | null) {
  try {
    if (!state || !state.token) {
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
  const state = await readAuthState();
  return Boolean(state.token && state.token === token);
}

export async function requireAuth(req: NextRequest): Promise<NextResponse | null> {
  const ok = await isAuthenticated(req);
  if (!ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function setAuthToken(token: string) {
  await writeAuthState({ token, issuedAt: Date.now() });
}

export async function clearAuthToken() {
  await writeAuthState(null);
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
