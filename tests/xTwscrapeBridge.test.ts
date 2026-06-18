import test from "node:test";
import assert from "node:assert/strict";
import { buildTwscrapeInput, normalizeTwscrapeTweets } from "../src/xTwscrapeShape.ts";

test("buildTwscrapeInput uses user tweets mode for username rules", () => {
  assert.deepEqual(
    buildTwscrapeInput({
      sourceUserName: "@xdevelopers",
      includeReplies: false,
      includeRetweets: false,
      limit: 8,
      dbPath: ".data/twscrape/accounts.db",
      proxyUrl: "socks5://127.0.0.1:1080",
    }),
    {
      sourceUserName: "xdevelopers",
      includeReplies: false,
      includeRetweets: false,
      limit: 8,
      dbPath: ".data/twscrape/accounts.db",
      proxyUrl: "socks5://127.0.0.1:1080",
    },
  );
});

test("normalizeTwscrapeTweets maps twscrape model fields to existing tweet shape", () => {
  const tweets = normalizeTwscrapeTweets([
    {
      id: 123,
      rawContent: "hello",
      user: { id: 42, username: "xdevelopers", displayname: "X Developers" },
      inReplyToTweetId: 100,
      retweetedTweet: null,
    },
  ]);

  assert.deepEqual(tweets, [
    {
      id: "123",
      text: "hello",
      user: {
        id: "42",
        username: "xdevelopers",
        screen_name: "xdevelopers",
        name: "X Developers",
      },
      in_reply_to_status_id: "100",
      in_reply_to_status_id_str: "100",
      retweeted_status: undefined,
      is_retweet: false,
      url: "https://x.com/xdevelopers/status/123",
    },
  ]);
});
