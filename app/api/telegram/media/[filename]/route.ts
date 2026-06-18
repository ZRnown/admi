import { NextResponse, type NextRequest } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import { resolveDataPath } from "@/src/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveMediaPath(filename: string): string | null {
  const safeName = path.basename(filename);
  if (!safeName || safeName !== filename) {
    return null;
  }
  return resolveDataPath("telegram_media", safeName);
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ filename: string }> },
) {
  const { filename } = await context.params;
  const filePath = resolveMediaPath(filename);
  if (!filePath) {
    return new NextResponse("Not Found", { status: 404 });
  }

  try {
    const data = await fs.readFile(filePath);
    return new NextResponse(data, {
      headers: {
        "Content-Type": getContentType(filePath),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new NextResponse("Not Found", { status: 404 });
  }
}
