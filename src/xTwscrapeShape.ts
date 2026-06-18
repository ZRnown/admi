export type TwscrapeInput = {
  sourceUserName?: string;
  sourceUserId?: string;
  includeReplies?: boolean;
  includeRetweets?: boolean;
  limit?: number;
  dbPath?: string;
  proxyUrl?: string;
};

export function buildTwscrapeInput(input: TwscrapeInput): TwscrapeInput {
  const sourceUserName =
    typeof input.sourceUserName === "string" && input.sourceUserName.trim()
      ? input.sourceUserName.trim().replace(/^@+/, "")
      : undefined;
  const sourceUserId =
    typeof input.sourceUserId === "string" && input.sourceUserId.trim() ? input.sourceUserId.trim() : undefined;
  return {
    ...(sourceUserName ? { sourceUserName } : {}),
    ...(sourceUserId ? { sourceUserId } : {}),
    includeReplies: input.includeReplies === true,
    includeRetweets: input.includeRetweets === true,
    limit: Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.min(50, Math.round(Number(input.limit))) : 10,
    ...(typeof input.dbPath === "string" && input.dbPath.trim() ? { dbPath: input.dbPath.trim() } : {}),
    ...(typeof input.proxyUrl === "string" && input.proxyUrl.trim() ? { proxyUrl: input.proxyUrl.trim() } : {}),
  };
}

function pickText(value: any): string {
  return typeof value === "string" ? value : "";
}

function pickId(value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

export function normalizeTwscrapeTweets(items: any[]): any[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const id = pickId(item.id ?? item.id_str ?? item.idStr);
      if (!id) return null;
      const user = item.user || {};
      const username = pickText(user.username || user.screen_name || user.userName).replace(/^@+/, "");
      const userId = pickId(user.id ?? user.id_str ?? user.idStr);
      const displayName = pickText(user.displayname || user.displayName || user.name);
      const replyId = pickId(item.inReplyToTweetId ?? item.inReplyToTweetIdStr ?? item.in_reply_to_status_id_str);
      const retweetedTweet = item.retweetedTweet ?? item.retweeted_status;

      return {
        id,
        text: pickText(item.rawContent || item.full_text || item.text),
        user: {
          id: userId,
          username,
          screen_name: username,
          name: displayName,
        },
        in_reply_to_status_id: replyId,
        in_reply_to_status_id_str: replyId,
        retweeted_status: retweetedTweet || undefined,
        is_retweet: Boolean(retweetedTweet),
        url: item.url || (username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/web/status/${id}`),
      };
    })
    .filter(Boolean);
}
