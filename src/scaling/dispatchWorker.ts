import { setTimeout as sleep } from "node:timers/promises";

import type { ForwardDispatchJob } from "./dispatchTypes.js";
import { RedisDispatchQueue } from "./redisDispatchQueue.js";

export interface DispatchWorkerOptions {
  queue: RedisDispatchQueue;
  shardId: number;
  workerName: string;
  maxRetries: number;
  retryBaseMs: number;
  deadLetterTtlSec: number;
  dedupeTtlSec: number;
  executeJob: (job: ForwardDispatchJob) => Promise<void>;
}

export class DispatchWorker {
  private readonly queue: RedisDispatchQueue;
  private readonly shardId: number;
  private readonly workerName: string;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly deadLetterTtlSec: number;
  private readonly dedupeTtlSec: number;
  private readonly executeJob: (job: ForwardDispatchJob) => Promise<void>;
  private running = false;
  private processed = 0;
  private failed = 0;

  constructor(options: DispatchWorkerOptions) {
    this.queue = options.queue;
    this.shardId = options.shardId;
    this.workerName = options.workerName;
    this.maxRetries = Math.max(0, options.maxRetries);
    this.retryBaseMs = Math.max(100, options.retryBaseMs);
    this.deadLetterTtlSec = Math.max(60, options.deadLetterTtlSec);
    this.dedupeTtlSec = Math.max(60, options.dedupeTtlSec);
    this.executeJob = options.executeJob;
  }

  stop() {
    this.running = false;
  }

  async start() {
    this.running = true;
    console.log(
      `[DispatchWorker] Started worker=${this.workerName} shard=${this.shardId} retries=${this.maxRetries}`,
    );

    while (this.running) {
      const item = await this.queue.dequeue(this.shardId, 5);
      if (!item) {
        continue;
      }

      const job = item.job;
      try {
        const alreadyProcessed = await this.queue.isProcessed(job.dedupeKey);
        if (alreadyProcessed) {
          continue;
        }

        await this.executeJob(job);
        await this.queue.markProcessed(job.dedupeKey, this.dedupeTtlSec);

        this.processed += 1;
        if (this.processed % 20 === 0) {
          console.log(
            `[DispatchWorker] shard=${this.shardId} processed=${this.processed} failed=${this.failed}`,
          );
        }
      } catch (err: any) {
        this.failed += 1;
        const attempt = (job.retryMeta?.attempt ?? 0) + 1;
        const reason = String(err?.message || err || "unknown_error");

        if (attempt > this.maxRetries) {
          await this.queue.pushDeadLetter(this.shardId, job, reason, this.deadLetterTtlSec);
          console.error(
            `[DispatchWorker] DLQ shard=${this.shardId} job=${job.id} dedupe=${job.dedupeKey} reason=${reason}`,
          );
          continue;
        }

        const nextJob: ForwardDispatchJob = {
          ...job,
          retryMeta: {
            attempt,
            maxRetries: this.maxRetries,
            lastError: reason,
          },
        };

        const backoffMs = this.retryBaseMs * Math.pow(2, Math.max(0, attempt - 1));
        await sleep(backoffMs);
        await this.queue.enqueueToShard(this.shardId, nextJob);
      }
    }

    console.log(`[DispatchWorker] Stopped worker=${this.workerName} shard=${this.shardId}`);
  }
}
