import { assignInstancesToShards } from "./instanceIsolation.js";

export interface InstanceRouteStats {
  instanceId: string;
  routeCount: number;
  mediaRouteCount?: number;
  standbyRouteCount?: number;
}

export interface TopologyPlannerOptions {
  maxInstancesPerShard?: number;
  maxRoutesPerWorker?: number;
  minShards?: number;
  maxShards?: number;
  workerReplicaFloor?: number;
}

export interface TopologyPlan {
  totalInstances: number;
  totalRoutes: number;
  totalMediaRoutes: number;
  totalStandbyRoutes: number;
  recommendedShards: number;
  recommendedWorkers: number;
  hottestShardLoad: number;
  avgRoutesPerInstance: number;
  shardLoads: number[];
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function buildTopologyPlan(
  stats: InstanceRouteStats[],
  options: TopologyPlannerOptions = {},
): TopologyPlan {
  const normalizedStats = (stats || []).filter((item) => item?.instanceId);
  const totalInstances = normalizedStats.length;
  const totalRoutes = normalizedStats.reduce((sum, item) => sum + Math.max(item.routeCount || 0, 0), 0);
  const totalMediaRoutes = normalizedStats.reduce(
    (sum, item) => sum + Math.max(item.mediaRouteCount || 0, 0),
    0,
  );
  const totalStandbyRoutes = normalizedStats.reduce(
    (sum, item) => sum + Math.max(item.standbyRouteCount || 0, 0),
    0,
  );

  const maxInstancesPerShard = positiveInt(options.maxInstancesPerShard, 250);
  const maxRoutesPerWorker = positiveInt(options.maxRoutesPerWorker, 500);
  const minShards = positiveInt(options.minShards, 1);
  const maxShards = positiveInt(options.maxShards, Math.max(minShards, 2048));
  const workerReplicaFloor = positiveInt(options.workerReplicaFloor, 1);

  const rawShardCount = Math.ceil(Math.max(totalInstances, 1) / maxInstancesPerShard);
  const recommendedShards = clamp(Math.max(minShards, rawShardCount), minShards, maxShards);

  const shardMap = assignInstancesToShards(
    normalizedStats.map((item) => item.instanceId),
    recommendedShards,
  );

  const routeCountById = new Map(normalizedStats.map((item) => [item.instanceId, Math.max(item.routeCount || 0, 0)]));
  const shardLoads: number[] = [];
  for (let shard = 0; shard < recommendedShards; shard++) {
    const instanceIds = shardMap.get(shard) || [];
    const routes = instanceIds.reduce((sum, id) => sum + (routeCountById.get(id) || 0), 0);
    shardLoads.push(routes);
  }

  const hottestShardLoad = shardLoads.length > 0 ? Math.max(...shardLoads) : 0;
  const recommendedWorkers = Math.max(
    workerReplicaFloor,
    recommendedShards,
    Math.ceil(Math.max(totalRoutes, 1) / maxRoutesPerWorker),
  );

  return {
    totalInstances,
    totalRoutes,
    totalMediaRoutes,
    totalStandbyRoutes,
    recommendedShards,
    recommendedWorkers,
    hottestShardLoad,
    avgRoutesPerInstance: totalInstances > 0 ? totalRoutes / totalInstances : 0,
    shardLoads,
  };
}

export function formatTopologyPlan(plan: TopologyPlan): string {
  return [
    `实例=${plan.totalInstances}`,
    `路由=${plan.totalRoutes}`,
    `OCR敏感路由=${plan.totalMediaRoutes}`,
    `主备路由=${plan.totalStandbyRoutes}`,
    `建议分片=${plan.recommendedShards}`,
    `建议Worker=${plan.recommendedWorkers}`,
    `最热分片负载=${plan.hottestShardLoad}`,
    `平均路由/实例=${plan.avgRoutesPerInstance.toFixed(2)}`,
  ].join(" | ");
}
