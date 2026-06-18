const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const forwarderSource = fs.readFileSync(path.join(root, "src", "mobileClientForwarder.ts"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "src", "index.ts"), "utf8");
const telegramClientSource = fs.readFileSync(path.join(root, "telegram_bridge", "src", "telegram_bridge", "client.py"), "utf8");
const telegramBotSource = fs.readFileSync(path.join(root, "telegram_bridge", "src", "telegram_bridge", "bot.py"), "utf8");
const telegramMainSource = fs.readFileSync(path.join(root, "telegram_bridge", "src", "telegram_bridge", "main.py"), "utf8");
const telegramTypesSource = fs.readFileSync(path.join(root, "telegram_bridge", "src", "telegram_bridge", "telegram_types.py"), "utf8");

test("mobile client forwarder falls back to the production sync endpoint when old config has no URL", () => {
  assert.match(forwarderSource, /DEFAULT_MOBILE_CLIENT_SYNC_ENDPOINT/);
  assert.match(forwarderSource, /resolveMobileClientTarget/);
  assert.match(forwarderSource, /process\.env\.MOBILE_CLIENT_SYNC_ENDPOINT/);
  assert.match(forwarderSource, /http:\/\/192\.210\.141\.219:8765/);
  assert.doesNotMatch(forwarderSource, /Boolean\(target\?\.enabled && normalizeValue\(target\.endpoint\) && normalizeValue\(target\.adminToken\)\)/);
});

test("telegram channel avatars are captured and forwarded as mobile channel avatars", () => {
  assert.match(telegramTypesSource, /chat_avatar_file:\s*Optional\[str\]/);
  assert.match(telegramClientSource, /chat_avatar_file = await self\._get_avatar_file\(event\.client, chat\)/);
  assert.match(telegramClientSource, /chat_avatar_file=chat_avatar_file/);
  assert.match(telegramBotSource, /chat_avatar_file=chat_avatar_file/);
  assert.match(telegramMainSource, /"chat_avatar_file": message_data\.get\("chat_avatar_file"\)/);
  assert.match(indexSource, /params\??\.chat_avatar_file/);
  assert.match(indexSource, /buildTelegramAvatarUrl\(\s*cleanText\(params\?\.chat_avatar_file\)/);
});

test("telegram mobile avatars fall back to the mobile admin proxy URL", () => {
  assert.match(indexSource, /function buildTelegramAvatarUrl\([\s\S]*adminBaseOverride\?: string/);
  assert.match(indexSource, /const adminBase = cleanText\(adminBaseOverride\)/);
  assert.match(indexSource, /adminBase && avatarFile[\s\S]*return `\$\{adminBase\}\/api\/telegram\/avatar\/\$\{encodeURIComponent\(avatarFile\)\}`/);
  assert.match(indexSource, /const mobileClientAdminBase = resolveMobileClientAdminBase\(account\);/);
  assert.match(indexSource, /buildTelegramAvatarUrl\(\s*cleanText\(params\?\.chat_avatar_file\),[\s\S]*sourceChatUsername,\s*mobileClientAdminBase/);
  assert.match(indexSource, /authorAvatarUrl: buildTelegramAvatarUrl\([\s\S]*mobileClientAdminBase/);
});

test("telegram mobile IPC logging records routing metadata without message text", () => {
  assert.match(indexSource, /\[TG->Mobile\]\[IPC\] 收到/);
  assert.match(indexSource, /chat=\$\{sourceChatId \|\| sourceChatUsername \|\| "unknown"\}/);
  assert.match(indexSource, /topic=\$\{messageTopicId \|\| "未识别"\}/);
  assert.match(indexSource, /media=\$\{mediaItems\.length\}/);
  assert.doesNotMatch(indexSource, /\[TG->Mobile\]\[IPC\][^\n]+params\.text/);
});
