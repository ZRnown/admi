import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const typesSource = readFileSync(
  new URL("../telegram_bridge/src/telegram_bridge/telegram_types.py", import.meta.url),
  "utf8",
);
const clientSource = readFileSync(
  new URL("../telegram_bridge/src/telegram_bridge/client.py", import.meta.url),
  "utf8",
);
const botSource = readFileSync(
  new URL("../telegram_bridge/src/telegram_bridge/bot.py", import.meta.url),
  "utf8",
);

test("telegram dialog metadata marks forum topic groups", () => {
  assert.match(typesSource, /class TelegramChannel\(BaseModel\):/);
  assert.match(typesSource, /class TelegramChannel\(BaseModel\):[\s\S]*model_config = \{"populate_by_name": True\}/);
  assert.match(typesSource, /is_forum: Optional\[bool\] = Field\(default=None, alias="isForum"\)/);
  assert.match(clientSource, /async def _detect_forum_channel\(self, client: TelegramClient, entity: Any\)/);
  assert.match(clientSource, /is_forum=await self\._detect_forum_channel\(client, entity\)/);
  assert.match(botSource, /async def _detect_forum_channel\(self, client: TelegramClient, entity: Any\)/);
  assert.match(botSource, /is_forum=await self\._detect_forum_channel\(bot, entity\)/);
});
