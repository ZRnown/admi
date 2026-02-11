const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const INVALID_SEGMENT_CHARS = /[^a-zA-Z0-9:_-]/g;

function sanitizeSegment(value: string): string {
  const normalized = value.trim().replace(INVALID_SEGMENT_CHARS, "_");
  return normalized || "unknown";
}

function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

export interface InstanceIsolationKeys {
  queueKey: string;
  deadLetterKey: string;
  lockKey: string;
  metricsPrefix: string;
  streamChannel: string;
}

export function buildInstanceIsolationKeys(instanceId: string, namespace = "bridge"): InstanceIsolationKeys {
  const safeNamespace = sanitizeSegment(namespace);
  const safeInstanceId = sanitizeSegment(instanceId);

  return {
    queueKey: `${safeNamespace}:queue:${safeInstanceId}`,
    deadLetterKey: `${safeNamespace}:dlq:${safeInstanceId}`,
    lockKey: `${safeNamespace}:lock:${safeInstanceId}`,
    metricsPrefix: `${safeNamespace}.instance.${safeInstanceId}`,
    streamChannel: `${safeNamespace}:stream:${safeInstanceId}`,
  };
}

export function computeShardIndex(instanceId: string, shardCount: number): number {
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error("shardCount must be a positive integer");
  }
  const safeInstanceId = sanitizeSegment(instanceId);
  return fnv1a32(safeInstanceId) % shardCount;
}

export function assignInstancesToShards(instanceIds: string[], shardCount: number): Map<number, string[]> {
  const buckets = new Map<number, string[]>();
  for (let i = 0; i < shardCount; i++) {
    buckets.set(i, []);
  }

  for (const instanceId of instanceIds) {
    const shard = computeShardIndex(instanceId, shardCount);
    buckets.get(shard)?.push(instanceId);
  }

  return buckets;
}
