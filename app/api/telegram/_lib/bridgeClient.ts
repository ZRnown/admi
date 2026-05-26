import { telegramBridgeManager } from "@/src/processManager";
import { TelegramBridgeClient } from "@/src/telegramBridgeClient";

let cachedClient: TelegramBridgeClient | null = null;
let cachedPid: number | null = null;

export async function getBridgeClient(): Promise<TelegramBridgeClient> {
  if (!telegramBridgeManager.isRunning()) {
    const start = await telegramBridgeManager.start();
    if (!start.success) {
      throw new Error(start.message || "Failed to start Telegram Bridge");
    }
  }

  const process = telegramBridgeManager.getProcess();
  if (!process || !process.pid) {
    throw new Error("Telegram Bridge process is not available");
  }

  if (!cachedClient || cachedPid !== process.pid) {
    cachedClient = new TelegramBridgeClient(process);
    cachedPid = process.pid;
  }

  return cachedClient;
}
