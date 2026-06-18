import { NextResponse, type NextRequest } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveMobileChannelAvatarPath(filename: string): string | null {
  const safeName = path.basename(filename);
  if (!safeName || safeName !== filename) {
    return null;
  }
  return path.join(process.cwd(), ".data", "mobile_channel_avatars", safeName);
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  return "image/jpeg";
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ filename: string }> },
) {
  const { filename } = await context.params;
  const filePath = resolveMobileChannelAvatarPath(filename);
  if (!filePath) {
    return new NextResponse("Not Found", { status: 404 });
  }

  try {
    const data = await fs.readFile(filePath);
    return new NextResponse(data, {
      headers: {
        "Content-Type": getContentType(filePath),
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new NextResponse("Not Found", { status: 404 });
  }
}
