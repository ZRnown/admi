import process from "node:process";

import { SenderBot } from "./senderBot.js";
import { getEnv } from "./env.js";
import { DispatchWorker } from "./scaling/dispatchWorker.js";
import { RedisDispatchQueue } from "./scaling/redisDispatchQueue.js";
import type { ForwardDispatchJob } from "./scaling/dispatchTypes.js";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

async function run() {
  const env = getEnv();
  if (env.DISPATCH_MODE !== "redis") {
    console.log("[DispatchWorker] DISPATCH_MODE is not redis, worker exits.");
    return;
  }

  if (!env.REDIS_URL) {
    throw new Error("REDIS_URL is required when DISPATCH_MODE=redis");
  }

  const namespace = env.INSTANCE_QUEUE_NAMESPACE || "bridge";
  const shardCount = parsePositiveInt(process.env.INSTANCE_SHARD_COUNT, 8);
  const shardId = parsePositiveInt(process.env.DISPATCH_SHARD_ID, 0);
  const workerName = process.env.DISPATCH_WORKER_NAME || `worker-${process.pid}`;

  const queue = new RedisDispatchQueue({
    redisUrl: env.REDIS_URL,
    namespace,
    shardCount,
    standbyTtlSeconds: parsePositiveInt(process.env.STANDBY_ACTIVITY_TTL_SEC, 120),
  });
  await queue.connect();

  const senderCache = new Map<string, SenderBot>();

  const executeJob = async (job: ForwardDispatchJob) => {
    if (job.target.kind !== "webhook") {
      throw new Error(`Unsupported target kind in worker: ${job.target.kind}`);
    }

    const webhookUrl = job.target.webhookUrl.trim();
    if (!webhookUrl) {
      throw new Error("Webhook URL is empty");
    }

    let sender = senderCache.get(webhookUrl);
    if (!sender) {
      sender = new SenderBot({ webhookUrl });
      senderCache.set(webhookUrl, sender);
    }

    const result = await sender.sendData([job.payload]);
    if (!result || result.length === 0) {
      throw new Error("Webhook sender returned empty result");
    }
  };

  const worker = new DispatchWorker({
    queue,
    shardId,
    workerName,
    maxRetries: parsePositiveInt(env.DISPATCH_MAX_RETRIES ? String(env.DISPATCH_MAX_RETRIES) : undefined, 5),
    retryBaseMs: parsePositiveInt(
      env.DISPATCH_RETRY_BASE_MS ? String(env.DISPATCH_RETRY_BASE_MS) : undefined,
      1000,
    ),
    deadLetterTtlSec: parsePositiveInt(
      env.DISPATCH_DLQ_TTL_SEC ? String(env.DISPATCH_DLQ_TTL_SEC) : undefined,
      86400,
    ),
    dedupeTtlSec: parsePositiveInt(
      env.DISPATCH_DEDUPE_TTL_SEC ? String(env.DISPATCH_DEDUPE_TTL_SEC) : undefined,
      86400,
    ),
    executeJob,
  });

  const shutdown = async () => {
    worker.stop();
    await queue.disconnect();
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await worker.start();
  await queue.disconnect();
}

run().catch((err) => {
  console.error(`[DispatchWorker] Fatal error: ${String(err?.message || err)}`);
  process.exit(1);
});
