import { spawn, spawnSync } from "child_process";
import { promises as fs } from "fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { ProxyAgent } from "proxy-agent";
import { createHash } from "crypto";
import { getEnv } from "./env";
import type { AccountConfig, MultiConfig, TruthSocialForwardingRule, XForwardingRule, XStreamMode } from "./config";
import { SenderBot } from "./senderBot";
import { FileLogger } from "./logger";
import { clampPercent, getLanguageRatio } from "./languageFilter";
import { formatKeywordGroups, matchParsedKeywordGroups, parseKeywordGroups } from "./keywordMatcher";
import { recordForwardStat } from "./forwardStats";
import { runTwscrape } from "./xTwscrapeBridge";

const STATE_FILE = path.resolve(process.cwd(), ".data", "external_forward_state.json");
const STATUS_FILE = path.resolve(process.cwd(), ".data", "external_forward_status.json");
const DEFAULT_X_BASE_URL = "https://api.twitterapi.io";
const X_WEBSOCKET_URL = "wss://ws.twitterapi.io/twitter/tweet/websocket";
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const DEFAULT_X_STREAM_MODE: XStreamMode = "poll";
const X_RULE_TAG_PREFIX = "admi:x:";
const X_RULE_MIN_INTERVAL_SECONDS = 100;
const X_WS_RECONNECT_SECONDS = 90;

type ExternalSourceType = "x" | "truthsocial";
type ExternalForwardingType = "x-to-discord" | "truthsocial-to-discord";

type ExternalState = {
  x: Record<string, Record<string, string>>;
  truthsocial: Record<string, Record<string, string>>;
};

type ExternalRuleStatus = {
  lastPollAt?: number;
  lastSuccessAt?: number;
  lastForwardAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  lastItemId?: string;
};

type ExternalStatusState = {
  x: Record<string, Record<string, ExternalRuleStatus>>;
  truthsocial: Record<string, Record<string, ExternalRuleStatus>>;
};

type ExternalRunningAccount = {
  accountId: string;
  signature: string;
  timers: Map<string, NodeJS.Timeout>;
  senderCache: Map<string, SenderBot>;
  inFlight: Set<string>;
  ws?: any;
  wsReconnectTimer?: NodeJS.Timeout;
  xMode?: XStreamMode;
  xRuleById?: Map<string, XForwardingRule>;
  xRuleByTag?: Map<string, XForwardingRule>;
};

const runningAccounts = new Map<string, ExternalRunningAccount>();
let cachedState: ExternalState = { x: {}, truthsocial: {} };
let stateLoaded = false;
let stateWriteTimer: NodeJS.Timeout | null = null;
let cachedStatus: ExternalStatusState = { x: {}, truthsocial: {} };
let statusLoaded = false;
let statusWriteTimer: NodeJS.Timeout | null = null;

function ensureStateLoaded() {
  if (stateLoaded) return;
  try {
    const raw = require("fs").readFileSync(STATE_FILE, "utf-8");
    cachedState = JSON.parse(raw);
  } catch {}
  cachedState.x = cachedState.x || {};
  cachedState.truthsocial = cachedState.truthsocial || {};
  stateLoaded = true;
}

function scheduleStateWrite() {
  if (stateWriteTimer) return;
  stateWriteTimer = setTimeout(async () => {
    stateWriteTimer = null;
    try {
      await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
      await fs.writeFile(STATE_FILE, JSON.stringify(cachedState, null, 2));
    } catch {}
  }, 500);
}

function ensureStatusLoaded() {
  if (statusLoaded) return;
  try {
    const raw = require("fs").readFileSync(STATUS_FILE, "utf-8");
    cachedStatus = JSON.parse(raw);
  } catch {}
  cachedStatus.x = cachedStatus.x || {};
  cachedStatus.truthsocial = cachedStatus.truthsocial || {};
  statusLoaded = true;
}

function scheduleStatusWrite() {
  if (statusWriteTimer) return;
  statusWriteTimer = setTimeout(async () => {
    statusWriteTimer = null;
    try {
      await fs.mkdir(path.dirname(STATUS_FILE), { recursive: true });
      await fs.writeFile(STATUS_FILE, JSON.stringify(cachedStatus, null, 2));
    } catch {}
  }, 500);
}

function updateRuleStatus(
  kind: ExternalSourceType,
  accountId: string,
  ruleId: string,
  patch: Partial<ExternalRuleStatus>,
) {
  ensureStatusLoaded();
  if (!cachedStatus[kind]) cachedStatus[kind] = {};
  if (!cachedStatus[kind][accountId]) cachedStatus[kind][accountId] = {};
  const prev = cachedStatus[kind][accountId][ruleId] || {};
  cachedStatus[kind][accountId][ruleId] = { ...prev, ...patch };
  scheduleStatusWrite();
}

function getLastSeen(kind: ExternalSourceType, accountId: string, ruleId: string): string | undefined {
  ensureStateLoaded();
  const bucket = cachedState[kind] || {};
  return bucket[accountId]?.[ruleId];
}

function setLastSeen(kind: ExternalSourceType, accountId: string, ruleId: string, value?: string) {
  if (!value) return;
  ensureStateLoaded();
  if (!cachedState[kind]) cachedState[kind] = {};
  if (!cachedState[kind][accountId]) cachedState[kind][accountId] = {};
  cachedState[kind][accountId][ruleId] = value;
  scheduleStateWrite();
}

function buildSignature(account: AccountConfig): string {
  const payload = {
    forwardingType: account.forwardingType,
    loginRequested: account.loginRequested,
    xConfig: account.xConfig,
    truthSocialConfig: account.truthSocialConfig,
    proxyUrl: account.proxyUrl,
    replacementsDictionary: account.replacementsDictionary,
    enableTranslation: account.enableTranslation,
    translationProvider: account.translationProvider,
    translationApiKey: account.translationApiKey,
    translationSecret: account.translationSecret,
    translationBaseUrl: account.translationBaseUrl,
    translationModel: account.translationModel,
    translationPrompt: account.translationPrompt,
    deepseekApiKey: account.deepseekApiKey,
    watermark: account.watermark,
    watermarkSecondary: account.watermarkSecondary,
    watermarks: account.watermarks,
    watermarkEnabled: account.watermarkEnabled,
    caseInsensitiveKeywords: account.caseInsensitiveKeywords,
    blockedKeywords: account.blockedKeywords,
    excludeKeywords: account.excludeKeywords,
  };
  return createHash("md5").update(JSON.stringify(payload)).digest("hex");
}

function isExternalForwardingType(type?: string): type is ExternalForwardingType {
  return type === "x-to-discord" || type === "truthsocial-to-discord";
}

function getPollIntervalSeconds(ruleInterval?: number, accountInterval?: number): number {
  const candidate =
    typeof ruleInterval === "number" && ruleInterval > 0
      ? ruleInterval
      : typeof accountInterval === "number" && accountInterval > 0
        ? accountInterval
        : DEFAULT_POLL_INTERVAL_SECONDS;
  return Math.max(10, Math.round(candidate));
}

function buildSender(account: AccountConfig, running: ExternalRunningAccount, webhookUrl: string): SenderBot {
  const cached = running.senderCache.get(webhookUrl);
  if (cached) return cached;
  const proxy = account.proxyUrl || getEnv().PROXY_URL;
  const httpAgent = proxy ? new ProxyAgent(proxy as any) : undefined;
  const sender = new SenderBot({
    replacementsDictionary: account.replacementsDictionary || {},
    webhookUrl,
    httpAgent,
    enableTranslation: account.enableTranslation === true,
    translationProvider: account.translationProvider || "deepseek",
    translationApiKey: account.translationApiKey || account.deepseekApiKey,
    translationSecret: account.translationSecret,
    translationBaseUrl: account.translationBaseUrl,
    translationModel: account.translationModel,
    translationPrompt: account.translationPrompt,
    watermark: account.watermark,
    watermarkSecondary: account.watermarkSecondary,
    watermarks: account.watermarks,
    watermarkEnabled: account.watermarkEnabled !== false,
  });
  running.senderCache.set(webhookUrl, sender);
  return sender;
}

function shouldSkipByLanguage(
  account: AccountConfig,
  rule: XForwardingRule | TruthSocialForwardingRule,
  text: string,
  logger: FileLogger,
  logPrefix: string,
): boolean {
  const ratio = getLanguageRatio(text);
  const englishRatio = Math.round(ratio.englishRatio);
  const chineseRatio = Math.round(ratio.chineseRatio);

  const globalEnglishThreshold = clampPercent(account.ignoreEnglishThreshold, 100);
  const globalChineseThreshold = clampPercent(account.ignoreChineseThreshold, 100);
  const ruleEnglishThreshold = clampPercent(rule.ignoreEnglishThreshold, globalEnglishThreshold);
  const ruleChineseThreshold = clampPercent(rule.ignoreChineseThreshold, globalChineseThreshold);

  if (account.ignoreEnglish && englishRatio >= globalEnglishThreshold) {
    logger.info(`${logPrefix} [SKIP] 忽略英文(占比${englishRatio}%>=${globalEnglishThreshold}%)`);
    return true;
  }
  if (account.ignoreChinese && chineseRatio >= globalChineseThreshold) {
    logger.info(`${logPrefix} [SKIP] 忽略中文(占比${chineseRatio}%>=${globalChineseThreshold}%)`);
    return true;
  }
  if (rule.ignoreEnglish && englishRatio >= ruleEnglishThreshold) {
    logger.info(`${logPrefix} [SKIP] 规则忽略英文(占比${englishRatio}%>=${ruleEnglishThreshold}%)`);
    return true;
  }
  if (rule.ignoreChinese && chineseRatio >= ruleChineseThreshold) {
    logger.info(`${logPrefix} [SKIP] 规则忽略中文(占比${chineseRatio}%>=${ruleChineseThreshold}%)`);
    return true;
  }
  return false;
}

function shouldSkipByKeywords(
  account: AccountConfig,
  rule: XForwardingRule | TruthSocialForwardingRule,
  text: string,
  logger: FileLogger,
  logPrefix: string,
): boolean {
  const caseInsensitive = account.caseInsensitiveKeywords !== false;
  const hasText = text.trim().length > 0;
  const globalGroups = parseKeywordGroups(account.blockedKeywords);
  const ruleGroups = parseKeywordGroups(rule.blockedKeywords);

  if (globalGroups.length > 0 && hasText) {
    const { matchedGroups } = matchParsedKeywordGroups(text, globalGroups, { caseInsensitive });
    if (matchedGroups.length === 0) {
      logger.info(`${logPrefix} [SKIP] 未命中全局触发关键词`);
      return true;
    }
    logger.info(`${logPrefix} [FILTER] 全局关键词命中: ${formatKeywordGroups(matchedGroups)}`);
  } else if (ruleGroups.length > 0 && hasText) {
    const { matchedGroups } = matchParsedKeywordGroups(text, ruleGroups, { caseInsensitive });
    if (matchedGroups.length === 0) {
      logger.info(`${logPrefix} [SKIP] 未命中规则触发关键词`);
      return true;
    }
    logger.info(`${logPrefix} [FILTER] 规则关键词命中: ${formatKeywordGroups(matchedGroups)}`);
  }

  const globalExcludes = parseKeywordGroups(account.excludeKeywords);
  if (globalExcludes.length > 0 && hasText) {
    const { matchedGroups } = matchParsedKeywordGroups(text, globalExcludes, { caseInsensitive });
    if (matchedGroups.length > 0) {
      logger.info(`${logPrefix} [SKIP] 命中全局屏蔽关键词: ${formatKeywordGroups(matchedGroups)}`);
      return true;
    }
  }

  const ruleExcludes = parseKeywordGroups(rule.excludeKeywords);
  if (ruleExcludes.length > 0 && hasText) {
    const { matchedGroups } = matchParsedKeywordGroups(text, ruleExcludes, { caseInsensitive });
    if (matchedGroups.length > 0) {
      logger.info(`${logPrefix} [SKIP] 命中规则屏蔽关键词: ${formatKeywordGroups(matchedGroups)}`);
      return true;
    }
  }

  return false;
}

function stripHtml(input: string): string {
  if (!input) return "";
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\\s+/g, " ")
    .trim();
}

async function requestJson(url: URL, headers: Record<string, string>, proxyUrl?: string): Promise<any> {
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;
  const agent = proxyUrl ? new ProxyAgent(proxyUrl as any) : undefined;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "GET",
        headers,
        agent,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            reject(new Error(`响应解析失败: ${String(e)}`));
          }
        });
      },
    );
    req.on("error", (err) => reject(err));
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error("请求超时"));
    });
    req.end();
  });
}

async function requestJsonPost(
  url: URL,
  headers: Record<string, string>,
  body: any,
  proxyUrl?: string,
): Promise<any> {
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;
  const agent = proxyUrl ? new ProxyAgent(proxyUrl as any) : undefined;
  const payload = JSON.stringify(body ?? {});
  const requestHeaders = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  };

  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "POST",
        headers: requestHeaders,
        agent,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            reject(new Error(`响应解析失败: ${String(e)}`));
          }
        });
      },
    );
    req.on("error", (err) => reject(err));
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error("请求超时"));
    });
    req.write(payload);
    req.end();
  });
}

async function requestJsonDelete(
  url: URL,
  headers: Record<string, string>,
  body: any,
  proxyUrl?: string,
): Promise<any> {
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;
  const agent = proxyUrl ? new ProxyAgent(proxyUrl as any) : undefined;
  const payload = JSON.stringify(body ?? {});
  const requestHeaders = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  };

  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "DELETE",
        headers: requestHeaders,
        agent,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            reject(new Error(`响应解析失败: ${String(e)}`));
          }
        });
      },
    );
    req.on("error", (err) => reject(err));
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error("请求超时"));
    });
    req.write(payload);
    req.end();
  });
}

function extractXItems(payload: any): any[] {
  if (!payload) return [];
  if (Array.isArray(payload.tweets)) return payload.tweets;
  if (Array.isArray(payload.data?.tweets)) return payload.data.tweets;
  if (payload.tweet) return [payload.tweet];
  if (payload.data?.tweet) return [payload.data.tweet];
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

function getTweetId(tweet: any): string | undefined {
  return (
    tweet?.id ||
    tweet?.id_str ||
    tweet?.tweet_id ||
    tweet?.tweetId ||
    tweet?.status_id
  )?.toString();
}

function getTweetText(tweet: any): string {
  return (
    tweet?.full_text ||
    tweet?.text ||
    tweet?.content ||
    tweet?.body ||
    ""
  );
}

function getTweetUserName(tweet: any, fallback?: string): string | undefined {
  return (
    tweet?.user?.screen_name ||
    tweet?.user?.userName ||
    tweet?.user?.username ||
    tweet?.user?.handle ||
    tweet?.author?.username ||
    tweet?.author?.userName ||
    tweet?.user_name ||
    fallback
  );
}

function getTweetUserId(tweet: any): string | undefined {
  return (
    tweet?.user?.id ||
    tweet?.user?.id_str ||
    tweet?.user_id ||
    tweet?.userId ||
    tweet?.author_id ||
    tweet?.author?.id
  )?.toString();
}

function isTweetReply(tweet: any): boolean {
  if (!tweet) return false;
  if (tweet.in_reply_to_status_id || tweet.in_reply_to_status_id_str) return true;
  if (tweet.in_reply_to_user_id || tweet.in_reply_to_user_id_str) return true;
  const referenced = tweet.referenced_tweets || tweet.referencedTweets;
  if (Array.isArray(referenced)) {
    return referenced.some((item) => item?.type === "replied_to");
  }
  return false;
}

function isTweetRetweet(tweet: any): boolean {
  if (!tweet) return false;
  if (tweet.retweeted_status || tweet.retweetedStatus) return true;
  if (tweet.is_retweet === true || tweet.retweeted === true) return true;
  const referenced = tweet.referenced_tweets || tweet.referencedTweets;
  if (Array.isArray(referenced)) {
    return referenced.some((item) => item?.type === "retweeted");
  }
  return false;
}

function resolveXStreamMode(account: AccountConfig): XStreamMode {
  if ((account.xConfig as any)?.sourceProvider === "twscrape") return "poll";
  return account.xConfig?.mode === "websocket" ? "websocket" : DEFAULT_X_STREAM_MODE;
}

function resolveXSourceProvider(account: AccountConfig): "twitterapi" | "twscrape" {
  return (account.xConfig as any)?.sourceProvider === "twscrape" ? "twscrape" : "twitterapi";
}

function buildXRuleTag(accountId: string, ruleId: string): string {
  const tag = `${X_RULE_TAG_PREFIX}${accountId}:${ruleId}`;
  return tag.length > 200 ? tag.slice(0, 200) : tag;
}

function buildXRuleValue(rule: XForwardingRule): string | undefined {
  const handle = rule.sourceUserName ? rule.sourceUserName.replace(/^@+/, "") : "";
  if (handle) return `from:${handle}`;
  if (rule.sourceUserId) return `from:${rule.sourceUserId}`;
  return undefined;
}

function getXRuleIntervalSeconds(rule: XForwardingRule, account: AccountConfig): number {
  const interval = getPollIntervalSeconds(rule.pollIntervalSeconds, account.xConfig?.pollIntervalSeconds);
  return Math.max(X_RULE_MIN_INTERVAL_SECONDS, interval);
}

async function syncXWebsocketRules(
  account: AccountConfig,
  running: ExternalRunningAccount,
  logger: FileLogger,
): Promise<void> {
  const mappings = account.xConfig?.mappings || [];
  running.xRuleById = new Map();
  running.xRuleByTag = new Map();
  if (mappings.length === 0) return;

  const apiKey = account.xConfig?.apiKey;
  if (!apiKey) {
    for (const rule of mappings) {
      updateRuleStatus("x", account.id, rule.id, { lastError: "缺少 X API Key", lastErrorAt: Date.now() });
    }
    logger.error(`[X->Discord] 账号 ${account.name || account.id} 缺少 X API Key`);
    return;
  }

  const baseUrl = account.xConfig?.apiBaseUrl || DEFAULT_X_BASE_URL;
  const headers = { "x-api-key": apiKey };
  let existingRules: any[] = [];
  try {
    const payload = await requestJson(new URL("/oapi/tweet_filter/get_rules", baseUrl), headers, account.proxyUrl);
    existingRules = Array.isArray(payload?.rules) ? payload.rules : [];
  } catch (e: any) {
    logger.error(`[X->Discord] 获取 WebSocket 规则失败: ${String(e?.message || e)}`);
    for (const rule of mappings) {
      updateRuleStatus("x", account.id, rule.id, {
        lastError: String(e?.message || e),
        lastErrorAt: Date.now(),
      });
    }
  }

  const existingByTag = new Map<string, any>();
  for (const rule of existingRules) {
    if (rule?.tag) existingByTag.set(String(rule.tag), rule);
  }

  const desiredTags = new Set<string>();
  for (const rule of mappings) {
    const tag = buildXRuleTag(account.id, rule.id);
    const value = buildXRuleValue(rule);
    if (!value) {
      logger.error(`[X->Discord] 规则 ${rule.id} 缺少用户名或用户ID，无法创建 WebSocket 过滤规则`);
      updateRuleStatus("x", account.id, rule.id, { lastError: "规则缺少用户名/用户ID", lastErrorAt: Date.now() });
      continue;
    }

    desiredTags.add(tag);
    const intervalSeconds = getXRuleIntervalSeconds(rule, account);
    const existing = existingByTag.get(tag);
    let ruleId = existing?.rule_id || existing?.ruleId;
    if (existing) {
      const existingValue = existing.value || existing.rule_value;
      const existingInterval = Number(existing.interval_seconds ?? existing.intervalSeconds ?? 0);
      const needsUpdate =
        existingValue !== value || (Number.isFinite(existingInterval) && Math.round(existingInterval) !== intervalSeconds);
      if (needsUpdate && ruleId) {
        try {
          const payload = await requestJsonPost(
            new URL("/oapi/tweet_filter/update_rule", baseUrl),
            headers,
            {
              rule_id: ruleId,
              tag,
              value,
              interval_seconds: intervalSeconds,
              is_effect: 1,
            },
            account.proxyUrl,
          );
          ruleId = payload?.rule_id || payload?.ruleId || ruleId;
        } catch (e: any) {
          logger.error(`[X->Discord] 更新 WebSocket 规则失败(${tag}): ${String(e?.message || e)}`);
          updateRuleStatus("x", account.id, rule.id, {
            lastError: String(e?.message || e),
            lastErrorAt: Date.now(),
          });
        }
      }
    } else {
      try {
        const payload = await requestJsonPost(
          new URL("/oapi/tweet_filter/add_rule", baseUrl),
          headers,
          { tag, value, interval_seconds: intervalSeconds },
          account.proxyUrl,
        );
        ruleId = payload?.rule_id || payload?.ruleId || ruleId;
      } catch (e: any) {
        logger.error(`[X->Discord] 新增 WebSocket 规则失败(${tag}): ${String(e?.message || e)}`);
        updateRuleStatus("x", account.id, rule.id, {
          lastError: String(e?.message || e),
          lastErrorAt: Date.now(),
        });
      }
    }

    if (ruleId) {
      running.xRuleById?.set(String(ruleId), rule);
    }
    running.xRuleByTag?.set(tag, rule);
  }

  for (const rule of existingRules) {
    const tag = String(rule?.tag || "");
    if (!tag.startsWith(`${X_RULE_TAG_PREFIX}${account.id}:`)) continue;
    if (desiredTags.has(tag)) continue;
    const ruleId = rule?.rule_id || rule?.ruleId;
    if (!ruleId) continue;
    try {
      await requestJsonDelete(
        new URL("/oapi/tweet_filter/delete_rule", baseUrl),
        headers,
        { rule_id: ruleId },
        account.proxyUrl,
      );
    } catch (e: any) {
      logger.error(`[X->Discord] 删除 WebSocket 规则失败(${tag}): ${String(e?.message || e)}`);
    }
  }
}

function matchXRulesForTweet(rules: XForwardingRule[], tweet: any): XForwardingRule[] {
  const userId = getTweetUserId(tweet);
  const userName = getTweetUserName(tweet);
  const normalizedName = userName ? userName.toLowerCase() : "";
  return rules.filter((rule) => {
    if (rule.sourceUserId && userId && rule.sourceUserId === userId) return true;
    if (rule.sourceUserName && normalizedName && rule.sourceUserName.toLowerCase() === normalizedName) return true;
    return false;
  });
}

async function forwardXRule(account: AccountConfig, rule: XForwardingRule, running: ExternalRunningAccount, logger: FileLogger) {
  const logPrefix = `[X->Discord] ${account.name || account.id} :: ${rule.sourceUserName || rule.sourceUserId}`;
  const now = Date.now();
  updateRuleStatus("x", account.id, rule.id, { lastPollAt: now });
  const sourceProvider = resolveXSourceProvider(account);
  let tweets: any[] = [];

  if (sourceProvider === "twscrape") {
    try {
      tweets = await runTwscrape({
        sourceUserName: rule.sourceUserName,
        sourceUserId: rule.sourceUserId,
        includeReplies: rule.includeReplies === true,
        includeRetweets: rule.includeRetweets === true,
        limit: 10,
        dbPath: (account.xConfig as any)?.twscrapeDbPath,
        proxyUrl: account.proxyUrl,
      });
    } catch (e: any) {
      logger.error(`${logPrefix} twscrape 获取推文失败: ${String(e?.message || e)}`);
      updateRuleStatus("x", account.id, rule.id, { lastError: String(e?.message || e), lastErrorAt: Date.now() });
      return;
    }
    updateRuleStatus("x", account.id, rule.id, { lastSuccessAt: Date.now(), lastError: "", lastErrorAt: undefined });
  } else {
  const apiKey = account.xConfig?.apiKey;
  if (!apiKey) {
    logger.error(`${logPrefix} 缺少 X API Key`);
    updateRuleStatus("x", account.id, rule.id, { lastError: "缺少 X API Key", lastErrorAt: Date.now() });
    return;
  }
  const baseUrl = account.xConfig?.apiBaseUrl || DEFAULT_X_BASE_URL;
  const url = new URL("/twitter/user/last_tweets", baseUrl);
  if (rule.sourceUserId) {
    url.searchParams.set("userId", rule.sourceUserId);
  } else if (rule.sourceUserName) {
    url.searchParams.set("userName", rule.sourceUserName);
  }
  const includeReplies = rule.includeReplies === true;
  if (includeReplies) {
    url.searchParams.set("includeReplies", "true");
  }

  let payload: any;
  try {
    payload = await requestJson(url, { "x-api-key": apiKey }, account.proxyUrl);
  } catch (e: any) {
    logger.error(`${logPrefix} 获取推文失败: ${String(e?.message || e)}`);
    updateRuleStatus("x", account.id, rule.id, { lastError: String(e?.message || e), lastErrorAt: Date.now() });
    return;
  }
  updateRuleStatus("x", account.id, rule.id, { lastSuccessAt: Date.now(), lastError: "", lastErrorAt: undefined });

  tweets = extractXItems(payload);
  }
  if (tweets.length === 0) return;

  const lastSeen = getLastSeen("x", account.id, rule.id);
  const newTweets: any[] = [];

  for (const tweet of tweets) {
    const id = getTweetId(tweet);
    if (!id) continue;
    if (lastSeen && id === lastSeen) break;
    newTweets.push(tweet);
  }

  if (!lastSeen) {
    const latest = tweets[0];
    const forwarded = await forwardSingleTweet(account, rule, running, logger, latest);
    const latestId = getTweetId(latest);
    setLastSeen("x", account.id, rule.id, latestId);
    if (forwarded) {
      updateRuleStatus("x", account.id, rule.id, { lastForwardAt: Date.now(), lastItemId: latestId });
    }
    return;
  }

  if (newTweets.length === 0) return;

  const newestId = getTweetId(newTweets[0]);
  newTweets.reverse();
  for (const tweet of newTweets) {
    const forwarded = await forwardSingleTweet(account, rule, running, logger, tweet);
    if (forwarded) {
      updateRuleStatus("x", account.id, rule.id, {
        lastForwardAt: Date.now(),
        lastItemId: getTweetId(tweet),
      });
    }
  }
  setLastSeen("x", account.id, rule.id, newestId);
}

async function forwardSingleTweet(
  account: AccountConfig,
  rule: XForwardingRule,
  running: ExternalRunningAccount,
  logger: FileLogger,
  tweet: any,
) : Promise<boolean> {
  const tweetId = getTweetId(tweet);
  if (!tweetId) return false;
  if (!rule.includeReplies && isTweetReply(tweet)) return false;
  if (!rule.includeRetweets && isTweetRetweet(tweet)) return false;

  const userName = getTweetUserName(tweet, rule.sourceUserName);
  const text = getTweetText(tweet);
  const cleanText = stripHtml(text);

  const logPrefix = `[X->Discord] ${account.name || account.id} :: ${userName || rule.sourceUserId || tweetId}`;

  if (shouldSkipByKeywords(account, rule, cleanText, logger, logPrefix)) return false;
  if (shouldSkipByLanguage(account, rule, cleanText, logger, logPrefix)) return false;

  const url = userName
    ? `https://x.com/${userName}/status/${tweetId}`
    : `https://x.com/i/web/status/${tweetId}`;
  const contentParts = [];
  if (userName) contentParts.push(`@${userName}`);
  if (cleanText) contentParts.push(cleanText);
  contentParts.push(url);

  const sender = buildSender(account, running, rule.targetWebhookUrl);
  const stripEnglish = rule.stripEnglish ?? account.stripEnglish;
  const stripChinese = rule.stripChinese ?? account.stripChinese;

  await sender.sendData([
    {
      content: contentParts.join("\n"),
      username: userName ? `@${userName}` : undefined,
      ruleReplacementsDictionary: rule.replacementsDictionary,
      stripEnglish,
      stripChinese,
      watermark: rule.watermark,
      watermarkSecondary: rule.watermarkSecondary,
      watermarks: rule.watermarks,
    },
  ]);

  logger.info(`${logPrefix} 转发成功: ${tweetId}`);
  recordForwardStat(account.id, "x-to-discord");
  return true;
}

async function handleXWebsocketPayload(
  account: AccountConfig,
  running: ExternalRunningAccount,
  logger: FileLogger,
  payload: any,
) {
  if (!payload) return;
  const eventType = String(payload.event_type || payload.eventType || payload.type || "").toLowerCase();
  if (eventType === "connected") {
    logger.info(`[X->Discord] WebSocket 已连接 (${account.name || account.id})`);
    const now = Date.now();
    (account.xConfig?.mappings || []).forEach((rule) => {
      updateRuleStatus("x", account.id, rule.id, { lastSuccessAt: now, lastError: "", lastErrorAt: undefined });
    });
    return;
  }
  if (eventType === "ping") {
    return;
  }

  const tweets = extractXItems(payload);
  if (tweets.length === 0) return;
  const ruleId = payload.rule_id || payload.ruleId;
  const ruleTag = payload.rule_tag || payload.ruleTag || payload.tag;
  let taggedRules: XForwardingRule[] = [];
  if (ruleId && running.xRuleById?.has(String(ruleId))) {
    taggedRules = [running.xRuleById.get(String(ruleId))!];
  } else if (ruleTag && running.xRuleByTag?.has(String(ruleTag))) {
    taggedRules = [running.xRuleByTag.get(String(ruleTag))!];
  }

  const allRules = account.xConfig?.mappings || [];
  for (const tweet of tweets) {
    const candidates = taggedRules.length > 0 ? taggedRules : matchXRulesForTweet(allRules, tweet);
    if (candidates.length === 0) continue;
    for (const rule of candidates) {
      const tweetId = getTweetId(tweet);
      if (!tweetId) continue;
      const lastSeen = getLastSeen("x", account.id, rule.id);
      if (lastSeen && lastSeen === tweetId) continue;
      updateRuleStatus("x", account.id, rule.id, { lastPollAt: Date.now(), lastSuccessAt: Date.now(), lastError: "", lastErrorAt: undefined });
      let forwarded = false;
      try {
        forwarded = await forwardSingleTweet(account, rule, running, logger, tweet);
      } catch (e: any) {
        logger.error(`[X->Discord] WebSocket 转发失败: ${String(e?.message || e)}`);
        updateRuleStatus("x", account.id, rule.id, { lastError: String(e?.message || e), lastErrorAt: Date.now() });
      }
      if (forwarded) {
        updateRuleStatus("x", account.id, rule.id, {
          lastForwardAt: Date.now(),
          lastItemId: tweetId,
        });
      }
      setLastSeen("x", account.id, rule.id, tweetId);
    }
  }
}

function scheduleXWebsocketReconnect(
  account: AccountConfig,
  running: ExternalRunningAccount,
  logger: FileLogger,
  reason: string,
) {
  if (!runningAccounts.has(account.id)) return;
  if (running.wsReconnectTimer) return;
  running.wsReconnectTimer = setTimeout(() => {
    running.wsReconnectTimer = undefined;
    if (!runningAccounts.has(account.id)) return;
    connectXWebsocket(account, running, logger);
  }, X_WS_RECONNECT_SECONDS * 1000);
  logger.error(`[X->Discord] WebSocket 断开(${reason})，${X_WS_RECONNECT_SECONDS}s 后重连`);
}

function connectXWebsocket(account: AccountConfig, running: ExternalRunningAccount, logger: FileLogger) {
  const apiKey = account.xConfig?.apiKey;
  if (!apiKey) {
    const now = Date.now();
    (account.xConfig?.mappings || []).forEach((rule) => {
      updateRuleStatus("x", account.id, rule.id, { lastError: "缺少 X API Key", lastErrorAt: now });
    });
    logger.error(`[X->Discord] 无法建立 WebSocket：缺少 X API Key`);
    return;
  }

  const WebSocketCtor = (globalThis as any).WebSocket;
  if (!WebSocketCtor) {
    const now = Date.now();
    (account.xConfig?.mappings || []).forEach((rule) => {
      updateRuleStatus("x", account.id, rule.id, { lastError: "当前 Node 不支持 WebSocket", lastErrorAt: now });
    });
    logger.error(`[X->Discord] 当前 Node 不支持 WebSocket`);
    return;
  }

  try {
    if (running.ws) {
      try {
        running.ws.close();
      } catch {}
      running.ws = undefined;
    }
    const ws = new WebSocketCtor(X_WEBSOCKET_URL, {
      headers: { "x-api-key": apiKey },
    });
    running.ws = ws;

    ws.onopen = () => {
      logger.info(`[X->Discord] WebSocket 已建立连接`);
    };

    ws.onmessage = (event: any) => {
      const raw =
        typeof event?.data === "string"
          ? event.data
          : Buffer.isBuffer(event?.data)
            ? event.data.toString("utf-8")
            : event?.data instanceof ArrayBuffer
              ? Buffer.from(event.data).toString("utf-8")
              : "";
      if (!raw) return;
      let payload: any;
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        logger.error(`[X->Discord] WebSocket 消息解析失败: ${String(e)}`);
        return;
      }
      handleXWebsocketPayload(account, running, logger, payload).catch(() => {});
    };

    ws.onerror = (err: any) => {
      const message = String(err?.message || err);
      logger.error(`[X->Discord] WebSocket 错误: ${message}`);
      (account.xConfig?.mappings || []).forEach((rule) => {
        updateRuleStatus("x", account.id, rule.id, { lastError: message, lastErrorAt: Date.now() });
      });
      running.ws = undefined;
      scheduleXWebsocketReconnect(account, running, logger, "error");
    };

    ws.onclose = (event: any) => {
      const code = event?.code ? `code=${event.code}` : "unknown";
      running.ws = undefined;
      scheduleXWebsocketReconnect(account, running, logger, code);
    };
  } catch (e: any) {
    logger.error(`[X->Discord] WebSocket 初始化失败: ${String(e?.message || e)}`);
    (account.xConfig?.mappings || []).forEach((rule) => {
      updateRuleStatus("x", account.id, rule.id, { lastError: String(e?.message || e), lastErrorAt: Date.now() });
    });
  }
}

async function startXWebsocketAccount(account: AccountConfig, running: ExternalRunningAccount, logger: FileLogger) {
  const mappings = account.xConfig?.mappings || [];
  if (mappings.length === 0) {
    logger.error(`[X->Discord] 账号 ${account.name || account.id} 未配置任何 X 转发规则`);
    return;
  }
  await syncXWebsocketRules(account, running, logger);
  connectXWebsocket(account, running, logger);
}

function extractTruthStatuses(payload: any): any[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.statuses)) return payload.statuses;
  if (Array.isArray(payload.posts)) return payload.posts;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.data?.statuses)) return payload.data.statuses;
  if (Array.isArray(payload.data?.posts)) return payload.data.posts;
  if (Array.isArray(payload.results)) return payload.results;
  return [];
}

function getTruthId(item: any): string | undefined {
  return (
    item?.id ||
    item?.status_id ||
    item?.post_id ||
    item?.truth_id ||
    item?.truthId
  )?.toString();
}

function getTruthText(item: any): string {
  return (
    item?.content ||
    item?.text ||
    item?.body ||
    item?.status ||
    ""
  );
}

function getTruthHandle(item: any, fallback?: string): string | undefined {
  const handle =
    item?.account?.username ||
    item?.account?.acct ||
    item?.user?.username ||
    item?.user?.handle ||
    fallback;
  return handle ? handle.replace(/^@+/, "") : undefined;
}

async function runTruthbrush(handle: string, username?: string, password?: string): Promise<any> {
  const pythonCandidates = [
    process.env.PYTHON,
    process.env.PYTHON_BIN,
    process.env.PYTHON_EXECUTABLE,
    "python3",
    "python",
  ].filter(Boolean) as string[];
  const pythonBin = pythonCandidates.find((bin) => {
    try {
      spawnSync(bin, ["-V"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });

  if (!pythonBin) {
    throw new Error("未找到可用的 Python 解释器");
  }

  const args = ["-m", "truthbrush", "statuses", handle];
  const env = {
    ...process.env,
    ...(username ? { TRUTHSOCIAL_USERNAME: username } : {}),
    ...(password ? { TRUTHSOCIAL_PASSWORD: password } : {}),
  };

  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `truthbrush exited with code ${code}`));
        return;
      }
      const text = stdout.trim();
      const jsonStart = text.indexOf("{");
      const jsonEnd = text.lastIndexOf("}");
      const payloadText = jsonStart >= 0 && jsonEnd >= jsonStart ? text.slice(jsonStart, jsonEnd + 1) : text;
      try {
        resolve(JSON.parse(payloadText));
      } catch (e) {
        reject(new Error("无法解析 truthbrush 输出"));
      }
    });
  });
}

async function forwardTruthRule(
  account: AccountConfig,
  rule: TruthSocialForwardingRule,
  running: ExternalRunningAccount,
  logger: FileLogger,
) {
  const logPrefix = `[TruthSocial->Discord] ${account.name || account.id} :: ${rule.sourceHandle}`;
  updateRuleStatus("truthsocial", account.id, rule.id, { lastPollAt: Date.now() });
  const username = account.truthSocialConfig?.username;
  const password = account.truthSocialConfig?.password;

  let payload: any;
  try {
    payload = await runTruthbrush(rule.sourceHandle, username, password);
  } catch (e: any) {
    logger.error(`${logPrefix} 获取动态失败: ${String(e?.message || e)}`);
    updateRuleStatus("truthsocial", account.id, rule.id, { lastError: String(e?.message || e), lastErrorAt: Date.now() });
    return;
  }
  updateRuleStatus("truthsocial", account.id, rule.id, { lastSuccessAt: Date.now(), lastError: "", lastErrorAt: undefined });

  const statuses = extractTruthStatuses(payload);
  if (statuses.length === 0) return;

  const lastSeen = getLastSeen("truthsocial", account.id, rule.id);
  const newItems: any[] = [];
  for (const status of statuses) {
    const id = getTruthId(status);
    if (!id) continue;
    if (lastSeen && id === lastSeen) break;
    newItems.push(status);
  }

  if (!lastSeen) {
    const latest = statuses[0];
    const forwarded = await forwardSingleTruth(account, rule, running, logger, latest);
    const latestId = getTruthId(latest);
    setLastSeen("truthsocial", account.id, rule.id, latestId);
    if (forwarded) {
      updateRuleStatus("truthsocial", account.id, rule.id, { lastForwardAt: Date.now(), lastItemId: latestId });
    }
    return;
  }

  if (newItems.length === 0) return;

  const newestId = getTruthId(newItems[0]);
  newItems.reverse();
  for (const status of newItems) {
    const forwarded = await forwardSingleTruth(account, rule, running, logger, status);
    if (forwarded) {
      updateRuleStatus("truthsocial", account.id, rule.id, {
        lastForwardAt: Date.now(),
        lastItemId: getTruthId(status),
      });
    }
  }
  setLastSeen("truthsocial", account.id, rule.id, newestId);
}

async function forwardSingleTruth(
  account: AccountConfig,
  rule: TruthSocialForwardingRule,
  running: ExternalRunningAccount,
  logger: FileLogger,
  status: any,
) : Promise<boolean> {
  const statusId = getTruthId(status);
  if (!statusId) return false;

  const handle = getTruthHandle(status, rule.sourceHandle) || rule.sourceHandle;
  const text = stripHtml(getTruthText(status));
  const logPrefix = `[TruthSocial->Discord] ${account.name || account.id} :: ${handle}`;

  if (shouldSkipByKeywords(account, rule, text, logger, logPrefix)) return false;
  if (shouldSkipByLanguage(account, rule, text, logger, logPrefix)) return false;

  const url = status?.url || `https://truthsocial.com/@${handle}/posts/${statusId}`;
  const contentParts = [`@${handle}`, text, url].filter(Boolean);

  const sender = buildSender(account, running, rule.targetWebhookUrl);
  const stripEnglish = rule.stripEnglish ?? account.stripEnglish;
  const stripChinese = rule.stripChinese ?? account.stripChinese;

  await sender.sendData([
    {
      content: contentParts.join("\n"),
      username: `@${handle}`,
      ruleReplacementsDictionary: rule.replacementsDictionary,
      stripEnglish,
      stripChinese,
      watermark: rule.watermark,
      watermarkSecondary: rule.watermarkSecondary,
      watermarks: rule.watermarks,
    },
  ]);

  logger.info(`${logPrefix} 转发成功: ${statusId}`);
  recordForwardStat(account.id, "truthsocial-to-discord");
  return true;
}

function scheduleRule(
  account: AccountConfig,
  running: ExternalRunningAccount,
  ruleId: string,
  intervalSeconds: number,
  poller: () => Promise<void>,
) {
  if (running.timers.has(ruleId)) {
    clearInterval(running.timers.get(ruleId)!);
  }
  const timer = setInterval(() => {
    if (running.inFlight.has(ruleId)) return;
    running.inFlight.add(ruleId);
    poller()
      .catch(() => {})
      .finally(() => running.inFlight.delete(ruleId));
  }, intervalSeconds * 1000);
  running.timers.set(ruleId, timer);

  setTimeout(() => {
    if (running.inFlight.has(ruleId)) return;
    running.inFlight.add(ruleId);
    poller()
      .catch(() => {})
      .finally(() => running.inFlight.delete(ruleId));
  }, 1000);
}

function stopRunningAccount(accountId: string) {
  const running = runningAccounts.get(accountId);
  if (!running) return;
  for (const timer of running.timers.values()) {
    clearInterval(timer);
  }
  running.timers.clear();
  if (running.wsReconnectTimer) {
    clearTimeout(running.wsReconnectTimer);
    running.wsReconnectTimer = undefined;
  }
  if (running.ws) {
    try {
      running.ws.close();
    } catch {}
    running.ws = undefined;
  }
  running.xRuleById?.clear();
  running.xRuleByTag?.clear();
  running.senderCache.clear();
  running.inFlight.clear();
  runningAccounts.delete(accountId);
}

async function startExternalAccount(account: AccountConfig, logger: FileLogger) {
  const forwardingType = account.forwardingType as ExternalForwardingType;
  const running: ExternalRunningAccount = {
    accountId: account.id,
    signature: buildSignature(account),
    timers: new Map(),
    senderCache: new Map(),
    inFlight: new Set(),
  };
  runningAccounts.set(account.id, running);

  if (forwardingType === "x-to-discord") {
    const mappings = account.xConfig?.mappings || [];
    if (mappings.length === 0) {
      logger.error(`[X->Discord] 账号 ${account.name || account.id} 未配置任何 X 转发规则`);
      return;
    }
    const mode = resolveXStreamMode(account);
    running.xMode = mode;
    if (mode === "websocket") {
      await startXWebsocketAccount(account, running, logger);
      logger.info(`[X->Discord] 已启用 WebSocket 模式 (${mappings.length} 条规则)`);
      return;
    }
    for (const rule of mappings) {
      const interval = getPollIntervalSeconds(rule.pollIntervalSeconds, account.xConfig?.pollIntervalSeconds);
      scheduleRule(account, running, rule.id, interval, async () => {
        await forwardXRule(account, rule, running, logger);
      });
      logger.info(`[X->Discord] 已启用规则 ${rule.sourceUserName || rule.sourceUserId} (间隔 ${interval}s)`);
    }
  } else if (forwardingType === "truthsocial-to-discord") {
    const mappings = account.truthSocialConfig?.mappings || [];
    if (mappings.length === 0) {
      logger.error(`[TruthSocial->Discord] 账号 ${account.name || account.id} 未配置任何 TruthSocial 转发规则`);
      return;
    }
    for (const rule of mappings) {
      const interval = getPollIntervalSeconds(rule.pollIntervalSeconds, account.truthSocialConfig?.pollIntervalSeconds);
      scheduleRule(account, running, rule.id, interval, async () => {
        await forwardTruthRule(account, rule, running, logger);
      });
      logger.info(`[TruthSocial->Discord] 已启用规则 @${rule.sourceHandle} (间隔 ${interval}s)`);
    }
  }
}

export async function reconcileExternalForwarders(config: MultiConfig, logger: FileLogger) {
  const activeIds = new Set<string>();

  for (const account of config.accounts) {
    if (!isExternalForwardingType(account.forwardingType)) {
      stopRunningAccount(account.id);
      continue;
    }

    if (!account.loginRequested) {
      stopRunningAccount(account.id);
      continue;
    }

    activeIds.add(account.id);
    const signature = buildSignature(account);
    const existing = runningAccounts.get(account.id);

    if (!existing) {
      await startExternalAccount(account, logger);
      continue;
    }

    if (existing.signature !== signature) {
      stopRunningAccount(account.id);
      await startExternalAccount(account, logger);
    }
  }

  for (const accountId of runningAccounts.keys()) {
    if (!activeIds.has(accountId)) {
      stopRunningAccount(accountId);
    }
  }
}

export function shutdownExternalForwarders() {
  for (const accountId of runningAccounts.keys()) {
    stopRunningAccount(accountId);
  }
}
