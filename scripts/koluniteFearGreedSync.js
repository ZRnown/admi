const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CHANNEL_URL = "https://t.me/s/kolunite_notice";
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 15 * 1000;
const DEFAULT_STATE_FILE = path.join(__dirname, "..", ".data", "kolunite_fear_greed_sync.json");
const DEFAULT_CONFIG_PATH = path.join(__dirname, "..", "config.json");
const DEFAULT_FALLBACK_SOURCE_CHANNEL_ID = "965757505785434132";

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlToText(value) {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseFearGreedPosts(pageHtml) {
  const chunks = String(pageHtml || "").split('<div class="tgme_widget_message_wrap');
  const posts = [];

  for (const chunk of chunks) {
    if (!chunk.includes("今日恐慌与贪婪指数")) {
      continue;
    }

    const textMatch = chunk.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i);
    const datetimeMatch = chunk.match(/<time datetime="([^"]+)"/i);
    const imageMatch = chunk.match(/background-image:url\('([^']+)'\)/i);
    const sourceUrlMatch = chunk.match(/href="(https:\/\/t\.me\/kolunite_notice\/\d+)"/i);
    const channelNameMatch = chunk.match(
      /<a class="tgme_widget_message_owner_name"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i,
    );

    if (!textMatch || !datetimeMatch || !sourceUrlMatch) {
      continue;
    }

    posts.push({
      sourceUrl: sourceUrlMatch[1],
      imageUrl: imageMatch ? imageMatch[1] : undefined,
      message: htmlToText(textMatch[1]),
      postedAt: datetimeMatch[1],
      channelName: channelNameMatch ? htmlToText(channelNameMatch[1]) : "kolunite 公告群",
    });
  }

  return posts;
}

function formatDateInTimeZone(dateInput, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(dateInput));
}

function pickFearGreedPostForDate(posts, targetDate, timeZone = DEFAULT_TIMEZONE) {
  const matches = posts.filter((post) => formatDateInTimeZone(post.postedAt, timeZone) === targetDate);
  matches.sort((left, right) => new Date(left.postedAt).getTime() - new Date(right.postedAt).getTime());
  return matches.at(-1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadJsonFile(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallbackValue;
  }
}

function writeJsonFile(filePath, value) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function resolveWebhookUrlFromConfig(configPath, fallbackSourceChannelId) {
  const config = loadJsonFile(configPath, null);
  if (!config || !Array.isArray(config.accounts)) {
    return undefined;
  }

  for (const account of config.accounts) {
    const mappings = Array.isArray(account?.mappings) ? account.mappings : [];
    for (const mapping of mappings) {
      if (String(mapping?.sourceChannelId || "") !== String(fallbackSourceChannelId)) {
        continue;
      }
      if (typeof mapping?.targetWebhookUrl === "string" && mapping.targetWebhookUrl.trim()) {
        return mapping.targetWebhookUrl.trim();
      }
    }
  }

  return undefined;
}

async function fetchChannelPage(channelUrl) {
  const response = await fetch(channelUrl, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; KoluniteFearGreedSync/1.0)",
      accept: "text/html,application/xhtml+xml",
      "cache-control": "no-cache",
    },
  });
  if (!response.ok) {
    throw new Error(`Fetch channel page failed with status ${response.status}`);
  }
  return response.text();
}

function buildDiscordPayload(post) {
  const content = `${post.message}\n\n原帖：${post.sourceUrl}`;
  const embed = {
    url: post.sourceUrl,
    description: post.message,
    timestamp: new Date(post.postedAt).toISOString(),
    footer: {
      text: "来源 @kolunite_notice",
    },
  };

  if (post.imageUrl) {
    embed.image = { url: post.imageUrl };
  }

  return {
    username: post.channelName || "kolunite 公告群",
    content,
    embeds: [embed],
    allowed_mentions: {
      parse: [],
    },
  };
}

async function sendDiscordWebhook(webhookUrl, post) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(buildDiscordPayload(post)),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord webhook failed with status ${response.status}: ${body}`);
  }
}

function getTargetDate(timeZone, explicitDate) {
  if (explicitDate) {
    return explicitDate;
  }
  return formatDateInTimeZone(new Date(), timeZone);
}

async function findTodaysFearGreedPost(options = {}) {
  const channelUrl = options.channelUrl || DEFAULT_CHANNEL_URL;
  const timeZone = options.timeZone || DEFAULT_TIMEZONE;
  const targetDate = getTargetDate(timeZone, options.targetDate);
  const maxWaitMs = Number.isFinite(options.maxWaitMs) ? options.maxWaitMs : DEFAULT_MAX_WAIT_MS;
  const retryIntervalMs = Number.isFinite(options.retryIntervalMs)
    ? options.retryIntervalMs
    : DEFAULT_RETRY_INTERVAL_MS;
  const deadline = Date.now() + Math.max(0, maxWaitMs);

  while (true) {
    const html = await fetchChannelPage(channelUrl);
    const posts = parseFearGreedPosts(html);
    const post = pickFearGreedPostForDate(posts, targetDate, timeZone);
    if (post) {
      return post;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(retryIntervalMs);
  }
}

async function runSync(options = {}) {
  const channelUrl = options.channelUrl || process.env.KOLUNITE_CHANNEL_URL || DEFAULT_CHANNEL_URL;
  const timeZone = options.timeZone || process.env.KOLUNITE_TIMEZONE || DEFAULT_TIMEZONE;
  const targetDate = getTargetDate(timeZone, options.targetDate || process.env.KOLUNITE_TARGET_DATE);
  const stateFile = options.stateFile || process.env.KOLUNITE_STATE_FILE || DEFAULT_STATE_FILE;
  const configPath = options.configPath || process.env.KOLUNITE_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  const fallbackSourceChannelId =
    options.fallbackSourceChannelId ||
    process.env.KOLUNITE_FALLBACK_SOURCE_CHANNEL_ID ||
    DEFAULT_FALLBACK_SOURCE_CHANNEL_ID;
  const maxWaitMs = Number(options.maxWaitMs ?? process.env.KOLUNITE_MAX_WAIT_MS ?? DEFAULT_MAX_WAIT_MS);
  const retryIntervalMs = Number(
    options.retryIntervalMs ?? process.env.KOLUNITE_RETRY_INTERVAL_MS ?? DEFAULT_RETRY_INTERVAL_MS,
  );

  const webhookUrl =
    options.webhookUrl ||
    process.env.KOLUNITE_FEAR_GREED_WEBHOOK_URL ||
    resolveWebhookUrlFromConfig(configPath, fallbackSourceChannelId);
  if (!webhookUrl) {
    throw new Error("No Discord webhook URL available for kolunite fear and greed sync");
  }

  const post = await findTodaysFearGreedPost({
    channelUrl,
    timeZone,
    targetDate,
    maxWaitMs,
    retryIntervalMs,
  });
  if (!post) {
    throw new Error(`No kolunite fear and greed post found for ${targetDate}`);
  }

  const state = loadJsonFile(stateFile, {});
  if (state.lastSentSourceUrl === post.sourceUrl) {
    return {
      status: "skipped",
      reason: "already-sent",
      post,
    };
  }

  await sendDiscordWebhook(webhookUrl, post);
  writeJsonFile(stateFile, {
    lastSentSourceUrl: post.sourceUrl,
    lastSentPostedAt: post.postedAt,
    lastSentTargetDate: targetDate,
    sentAt: new Date().toISOString(),
  });

  return {
    status: "sent",
    post,
  };
}

async function main() {
  const result = await runSync();
  const prefix = result.status === "sent" ? "sent" : "skipped";
  console.log(
    `[kolunite-fear-greed-sync] ${prefix} ${result.post.sourceUrl} ${result.post.postedAt} ${result.post.message.split("\n")[0]}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[kolunite-fear-greed-sync] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildDiscordPayload,
  findTodaysFearGreedPost,
  formatDateInTimeZone,
  parseFearGreedPosts,
  pickFearGreedPostForDate,
  resolveWebhookUrlFromConfig,
  runSync,
};
