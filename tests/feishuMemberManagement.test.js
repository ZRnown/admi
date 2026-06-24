const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const html = readFileSync(join(__dirname, "../public/index.html"), "utf8");
const routeSource = readFileSync(join(__dirname, "../app/api/feishu/members/route.ts"), "utf8");
const listRouteSource = readFileSync(join(__dirname, "../app/api/feishu/members/list/route.ts"), "utf8");
const senderSource = readFileSync(join(__dirname, "../src/feishuSender.ts"), "utf8");

test("Feishu member management API is authenticated and scoped to Discord-to-Feishu accounts", () => {
  assert.match(routeSource, /import \{ requireAuth \} from "@\/app\/api\/_lib\/auth";/);
  assert.match(routeSource, /const auth = await requireAuth\(req\);/);
  assert.match(routeSource, /\(account\.forwardingType \|\| "discord-to-discord"\) !== "discord-to-feishu"/);
  assert.match(routeSource, /sender\.manageChatMembers\(\{/);
});

test("Feishu member list API is authenticated and scoped to Discord-to-Feishu accounts", () => {
  assert.match(listRouteSource, /import \{ requireAuth \} from "@\/app\/api\/_lib\/auth";/);
  assert.match(listRouteSource, /const auth = await requireAuth\(req\);/);
  assert.match(listRouteSource, /\(account\.forwardingType \|\| "discord-to-discord"\) !== "discord-to-feishu"/);
  assert.match(listRouteSource, /sender\.listChatMembers\(chatId, "open_id"\)/);
});

test("Feishu sender can add and remove chat members through the Feishu IM API", () => {
  assert.match(senderSource, /async resolveOpenIdsByContacts\(inputs: string\[\]\)/);
  assert.match(senderSource, /\/open-apis\/contact\/v3\/users\/batch_get_id\?user_id_type=open_id/);
  assert.match(senderSource, /async listChatMembers\(/);
  assert.match(senderSource, /async manageChatMembers\(params: \{/);
  assert.match(senderSource, /action: "add" \| "remove";/);
  assert.match(senderSource, /const method = params\.action === "remove" \? "DELETE" : "POST";/);
  assert.match(senderSource, /\/open-apis\/im\/v1\/chats\/\$\{encodeURIComponent\(chatId\)\}\/members\?member_id_type=\$\{memberIdType\}/);
  assert.match(senderSource, /JSON\.stringify\(\{ id_list: memberIds \}\)/);
});

test("Feishu member management UI is only mounted in the Discord-to-Feishu config block", () => {
  assert.match(html, /function renderFeishuMemberTool\(acc\)/);
  assert.match(html, /fetch\('\/api\/feishu\/members'/);
  assert.match(html, /批量拉人/);
  assert.match(html, /批量踢人/);
  assert.match(html, /手机号\/邮箱（推荐）/);
  assert.match(html, /刷新群列表/);
  assert.match(html, /fetchFeishuMemberChats/);
  assert.match(html, /查看成员/);
  assert.match(html, /fetch\('\/api\/feishu\/members\/list'/);
  assert.match(html, /查看群成员并勾选要踢出的人/);
  assert.match(
    html,
    /forwardingType === 'discord-to-feishu' \? `[\s\S]*renderFeishuMemberTool\(acc\)[\s\S]*` : ''\}/,
  );
});
