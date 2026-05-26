import { promises as fs } from "fs";
import path from "node:path";

export type ForwardStatsSnapshot = {
  date: string;
  total: number;
  byType?: Record<string, number>;
  byAccount?: Record<string, number>;
  updatedAt?: number;
};

const STATS_FILE = path.resolve(process.cwd(), ".data", "forward_stats.json");

let cachedStats: ForwardStatsSnapshot | null = null;
let writeTimer: NodeJS.Timeout | null = null;

function getTodayKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resetStats(): ForwardStatsSnapshot {
  return {
    date: getTodayKey(),
    total: 0,
    byType: {},
    byAccount: {},
    updatedAt: Date.now(),
  };
}

function ensureStatsLoaded() {
  if (cachedStats) return;
  cachedStats = resetStats();
  try {
    const raw = require("fs").readFileSync(STATS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      cachedStats = {
        ...cachedStats,
        ...parsed,
      };
    }
  } catch {}
  normalizeStats();
}

function normalizeStats() {
  if (!cachedStats) return;
  const today = getTodayKey();
  if (cachedStats.date !== today) {
    cachedStats = resetStats();
    return;
  }
  cachedStats.total = Number.isFinite(Number(cachedStats.total)) ? Number(cachedStats.total) : 0;
  cachedStats.byType = cachedStats.byType && typeof cachedStats.byType === "object" ? cachedStats.byType : {};
  cachedStats.byAccount =
    cachedStats.byAccount && typeof cachedStats.byAccount === "object" ? cachedStats.byAccount : {};
  cachedStats.updatedAt = Date.now();
}

function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    if (!cachedStats) return;
    try {
      await fs.mkdir(path.dirname(STATS_FILE), { recursive: true });
      await fs.writeFile(STATS_FILE, JSON.stringify(cachedStats, null, 2));
    } catch {}
  }, 500);
}

export function recordForwardStat(accountId: string, type?: string) {
  ensureStatsLoaded();
  if (!cachedStats) return;
  normalizeStats();

  cachedStats.total = (cachedStats.total || 0) + 1;
  if (accountId) {
    if (!cachedStats.byAccount) cachedStats.byAccount = {};
    cachedStats.byAccount[accountId] = (cachedStats.byAccount[accountId] || 0) + 1;
  }
  if (type) {
    if (!cachedStats.byType) cachedStats.byType = {};
    cachedStats.byType[type] = (cachedStats.byType[type] || 0) + 1;
  }
  cachedStats.updatedAt = Date.now();
  scheduleWrite();
}

export async function readForwardStatsSnapshot(): Promise<ForwardStatsSnapshot> {
  ensureStatsLoaded();
  if (!cachedStats) return resetStats();
  normalizeStats();
  return {
    date: cachedStats.date,
    total: cachedStats.total,
    byType: { ...(cachedStats.byType || {}) },
    byAccount: { ...(cachedStats.byAccount || {}) },
    updatedAt: cachedStats.updatedAt,
  };
}
