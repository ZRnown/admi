import { createClient, type RedisClientType } from "redis";

import { computeShardIndex } from "./instanceIsolation.js";
import type { ForwardDispatchJob } from "./dispatchTypes.js";

export interface RedisDispatchQueueOptions {
  redisUrl: string;
  namespace: string;
  shardCount: number;
  standbyTtlSeconds?: number;
}

export interface DequeuedDispatchJob {
  shardId: number;
  queueKey: string;
  job: ForwardDispatchJob;
}

export class RedisDispatchQueue {
  private readonly client: RedisClientType;
  private readonly namespace: string;
  private readonly shardCount: number;
  private readonly standbyTtlSeconds: number;
  private connected = false;

  constructor(options: RedisDispatchQueueOptions) {
    this.namespace = options.namespace;
    this.shardCount = Math.max(1, options.shardCount);
    this.standbyTtlSeconds = Math.max(5, options.standbyTtlSeconds ?? 120);
    this.client = createClient({ url: options.redisUrl });
    this.client.on("error", (err) => {
      console.error(`[DispatchQueue] Redis error: ${String(err?.message || err)}`);
    });
  }

  getShardCount(): number {
    return this.shardCount;
  }

  async connect() {
    if (this.connected) {
      return;
    }
    if (!this.client.isOpen) {
      await this.client.connect();
    }
    this.connected = true;
  }

  async disconnect() {
    if (!this.client.isOpen) {
      this.connected = false;
      return;
    }
    await this.client.quit();
    this.connected = false;
  }

  getQueueKey(shardId: number): string {
    return `${this.namespace}:stream:${shardId}`;
  }

  getDeadLetterKey(shardId: number): string {
    return `${this.namespace}:dlq:${shardId}`;
  }

  private getDedupeKey(dedupeKey: string): string {
    return `${this.namespace}:dedupe:${dedupeKey}`;
  }

  private getStandbyActivityKey(channelId: string): string {
    return `${this.namespace}:standby:activity:${channelId}`;
  }

  computeShard(instanceId: string): number {
    return computeShardIndex(instanceId, this.shardCount);
  }

  async enqueue(job: ForwardDispatchJob): Promise<{ shardId: number; queueKey: string }> {
    const shardId = this.computeShard(job.instanceId);
    const queueKey = this.getQueueKey(shardId);
    await this.enqueueToShard(shardId, job);
    return { shardId, queueKey };
  }

  async enqueueToShard(shardId: number, job: ForwardDispatchJob): Promise<void> {
    await this.connect();
    const queueKey = this.getQueueKey(shardId);
    await this.client.sendCommand(["RPUSH", queueKey, JSON.stringify(job)]);
  }

  async dequeue(shardId: number, timeoutSeconds = 5): Promise<DequeuedDispatchJob | null> {
    await this.connect();
    const queueKey = this.getQueueKey(shardId);
    const raw = await this.client.sendCommand(["BLPOP", queueKey, String(timeoutSeconds)]);
    if (!Array.isArray(raw) || raw.length < 2) {
      return null;
    }
    const payload = raw[1];
    if (typeof payload !== "string") {
      return null;
    }
    let job: ForwardDispatchJob;
    try {
      job = JSON.parse(payload) as ForwardDispatchJob;
    } catch {
      return null;
    }
    return {
      shardId,
      queueKey,
      job,
    };
  }

  async pushDeadLetter(
    shardId: number,
    job: ForwardDispatchJob,
    reason: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.connect();
    const dlqKey = this.getDeadLetterKey(shardId);
    const payload = JSON.stringify({
      failedAt: Date.now(),
      reason,
      job,
    });
    await this.client.sendCommand(["RPUSH", dlqKey, payload]);
    await this.client.sendCommand(["EXPIRE", dlqKey, String(Math.max(60, ttlSeconds))]);
  }

  async markProcessed(dedupeKey: string, ttlSeconds: number): Promise<void> {
    await this.connect();
    const key = this.getDedupeKey(dedupeKey);
    await this.client.sendCommand(["SET", key, String(Date.now()), "EX", String(Math.max(60, ttlSeconds))]);
  }

  async isProcessed(dedupeKey: string): Promise<boolean> {
    await this.connect();
    const key = this.getDedupeKey(dedupeKey);
    const result = await this.client.sendCommand(["EXISTS", key]);
    if (typeof result === "number") {
      return result > 0;
    }
    if (typeof result === "string") {
      return Number(result) > 0;
    }
    return false;
  }

  async markStandbyActivity(channelId: string, atMs = Date.now()): Promise<void> {
    await this.connect();
    const key = this.getStandbyActivityKey(channelId);
    await this.client.sendCommand([
      "SET",
      key,
      String(atMs),
      "EX",
      String(this.standbyTtlSeconds),
    ]);
  }

  async hasStandbyActivitySince(channelId: string, sinceMs: number): Promise<boolean> {
    await this.connect();
    const key = this.getStandbyActivityKey(channelId);
    const value = await this.client.sendCommand(["GET", key]);
    if (typeof value !== "string") {
      return false;
    }
    const ts = Number(value);
    return Number.isFinite(ts) && ts > sinceMs;
  }
}
