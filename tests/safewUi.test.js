const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const accountActionRoute = fs.readFileSync(path.join(__dirname, "..", "app", "api", "account", "action", "route.ts"), "utf8");
const configRoute = fs.readFileSync(path.join(__dirname, "..", "app", "api", "config", "route.ts"), "utf8");
const safewRuleRoute = fs.readFileSync(path.join(__dirname, "..", "app", "api", "config", "safew-rule", "route.ts"), "utf8");

test("SafeW UI supports multiple bot accounts and rule-level bot selection", () => {
  assert.match(html, /function renderSafewAccountsSection\(acc\)/);
  assert.match(html, /function addSafewAccount\(\)/);
  assert.match(html, /function renderSafewAccountRuleSelect\(acc, mapping, idx\)/);
  assert.match(html, /updateSafewRuleAccountSelection\(\$\{idx\}, '\$\{escapeJsString\(mapping\?\.id \|\| ''\)\}', this\.value\)/);
});

test("SafeW rules do not auto-select a default bot", () => {
  assert.match(html, /<option value="" \$\{selectedId \? '' : 'selected'\}>请选择机器人<\/option>/);
  assert.doesNotMatch(html, />默认机器人<\/option>/);
  assert.doesNotMatch(html, /newMapping\.safewAccountId = firstSafew\.id/);
});

test("SafeW rule bot selection is persisted with a small keepalive request", () => {
  assert.match(html, /function updateSafewRuleAccountSelection\(idx, mappingId, value\)/);
  assert.match(html, /updateMapping\(idx, 'safewAccountId', value\)/);
  assert.match(html, /persistSafewRuleAccountSelection\(acc\.id, mappingId \|\| mapping\.id, idx, value\)/);
  assert.match(html, /fetch\('\/api\/config\/safew-rule'/);
  assert.match(html, /keepalive: true/);
  assert.match(html, /updateSafewRuleAccountSelection\(\$\{idx\}, '\$\{escapeJsString\(mapping\?\.id \|\| ''\)\}', this\.value\)/);
  assert.match(html, /mappingIndex,/);
  assert.match(safewRuleRoute, /const mappingIndex = Number\.isInteger\(body\?\.mappingIndex\)/);
  assert.match(safewRuleRoute, /mappings\[mappingIndex\]/);
  assert.match(safewRuleRoute, /\(mapping as any\)\.safewAccountId = safewAccountId/);
  assert.match(safewRuleRoute, /delete \(mapping as any\)\.safewAccountId/);
  assert.match(safewRuleRoute, /await saveMultiConfig\(multi\)/);
  assert.match(safewRuleRoute, /await fs\.writeFile\(triggerFile/);
});

test("SafeW rule bot selection is returned by the config API", () => {
  assert.match(configRoute, /safewAccountId:[\s\S]*savedRule as any\)\.safewAccountId/);
});

test("instance header avoids duplicate running status badge", () => {
  assert.doesNotMatch(html, /id="instance-status-badge"/);
  assert.doesNotMatch(html, /#instance-status-badge/);
  assert.match(html, /id="btn-start-instance"[\s\S]*已启动/);
});

test("case-insensitive keyword toggle is hidden from the frontend", () => {
  assert.doesNotMatch(html, /关键词不区分大小写/);
});

test("SafeW UI hides API base URL and source identity controls", () => {
  const safeWSectionStart = html.indexOf("function renderSafewAccountsSection(acc)");
  const safeWSectionEnd = html.indexOf("function renderSafewAccountRuleSelect", safeWSectionStart);
  assert.ok(safeWSectionStart > 0);
  assert.ok(safeWSectionEnd > safeWSectionStart);
  const safeWSection = html.slice(safeWSectionStart, safeWSectionEnd);
  assert.doesNotMatch(safeWSection, /API Base URL/);
  assert.doesNotMatch(safeWSection, /apiBaseUrl/);

  assert.match(html, /forwardingType !== 'discord-to-safew'[\s\S]*使用源用户的昵称/);
});

test("SafeW config includes bot start and stop controls", () => {
  const safeWSectionStart = html.indexOf("function renderSafewAccountsSection(acc)");
  const safeWSectionEnd = html.indexOf("function renderSafewAccountRuleSelect", safeWSectionStart);
  assert.ok(safeWSectionStart > 0);
  assert.ok(safeWSectionEnd > safeWSectionStart);
  const safeWSection = html.slice(safeWSectionStart, safeWSectionEnd);

  assert.match(safeWSection, /requestSafewBotStart\('\$\{escapeJsString\(item\.id\)\}'\)/);
  assert.match(safeWSection, /requestSafewBotStop\('\$\{escapeJsString\(item\.id\)\}'\)/);
  assert.match(safeWSection, /safew-status-badge-/);
  assert.match(safeWSection, /safew-status-msg-/);
  assert.match(safeWSection, /登录/);
  assert.match(safeWSection, /停止/);
  assert.match(html, /async function requestSafewBotStart\(safewId\)/);
  assert.match(html, /async function requestSafewBotStop\(safewId\)/);
  assert.doesNotMatch(html, /requestSafewBotStart\(\)[\s\S]*await startInstance\(\)/);
});

test("SafeW config can load joined groups with names and ids", () => {
  const safeWSectionStart = html.indexOf("function renderSafewAccountsSection(acc)");
  const safeWSectionEnd = html.indexOf("function renderSafewAccountRuleSelect", safeWSectionStart);
  assert.ok(safeWSectionStart > 0);
  assert.ok(safeWSectionEnd > safeWSectionStart);
  const safeWSection = html.slice(safeWSectionStart, safeWSectionEnd);

  assert.match(safeWSection, /toggleSafewGroups\('\$\{escapeJsString\(item\.id\)\}'\)/);
  assert.match(safeWSection, /refreshSafewBotGroups\('\$\{escapeJsString\(item\.id\)\}'\)/);
  assert.match(safeWSection, /renderSafewGroups\(item\)/);
  assert.match(html, /async function requestSafewBotGroups\(safewId\)/);
  assert.match(html, /async function refreshSafewBotGroups\(safewId\)/);
  assert.match(html, /function renderSafewGroups\(item\)/);
  assert.match(html, /action: 'safewGroups'/);
});

test("SafeW group list is expandable and keeps cached groups when refresh returns empty", () => {
  const safeWSectionStart = html.indexOf("function renderSafewAccountsSection(acc)");
  const safeWSectionEnd = html.indexOf("function renderSafewAccountRuleSelect", safeWSectionStart);
  assert.ok(safeWSectionStart > 0);
  assert.ok(safeWSectionEnd > safeWSectionStart);
  const safeWSection = html.slice(safeWSectionStart, safeWSectionEnd);

  assert.match(safeWSection, /toggleSafewGroups\('\$\{escapeJsString\(item\.id\)\}'\)/);
  assert.match(safeWSection, /refreshSafewBotGroups\('\$\{escapeJsString\(item\.id\)\}'\)/);
  assert.match(html, /function toggleSafewGroups\(safewId\)/);
  assert.match(html, /async function refreshSafewBotGroups\(safewId\)/);
  assert.match(html, /safewGroupsOpen/);
  assert.match(html, /保留已有/);
  assert.match(html, /title="点击复制"/);
  assert.match(html, /cursor-pointer/);
  assert.match(accountActionRoute, /const mergeSafewGroups = \(cached: any, fetched: any\)/);
  assert.match(accountActionRoute, /bot\.groups = mergeSafewGroups\(bot\.groups, fetchedGroups\)/);
  assert.match(accountActionRoute, /refreshedCount: fetchedGroups\.length/);
});

test("forwarding type selector follows enabled forwarding types from config", () => {
  [
    "discord-to-discord",
    "discord-to-telegram",
    "telegram-to-discord",
    "telegram-to-telegram",
    "telegram-to-dingtalk",
    "discord-to-feishu",
    "discord-to-dingtalk",
  ].forEach((type) => {
    assert.match(
      html,
      new RegExp(`!state\\.enabledForwardingTypes \\|\\| state\\.enabledForwardingTypes\\.includes\\('${type}'\\)`),
    );
  });
  assert.match(html, /enabledForwardingTypes: data\.enabledForwardingTypes \|\| null/);
  assert.match(html, /forwardingType: 'discord-to-discord'/);
});

test("mobile client instances keep their name and start stop controls", () => {
  assert.match(html, /<h2 class="font-semibold text-slate-800">\$\{acc\.name \|\| '未命名实例'\}<\/h2>/);
  assert.match(html, /onclick="startInstance\(\)" id="btn-start-instance"/);
  assert.match(html, /onclick="stopInstance\(\)" id="btn-stop-instance"/);
});

test("discord mobile client instances still go through the start logic", () => {
  assert.match(html, /const needsDiscord = type === 'discord-to-discord' \|\| type === 'discord-to-mobile-client'/);
  assert.match(html, /if \(type === 'discord-to-mobile-client'\) \{\s*ensureMobileClientTarget\(acc\);\s*acc\.mobileClientTarget\.enabled = true;/);
});

test("discord mobile client instances stay enabled when stopped", () => {
  const stopStart = html.indexOf("async function stopInstance()");
  const stopEnd = html.indexOf("async function requestSafewBotStart", stopStart);
  assert.ok(stopStart > 0);
  assert.ok(stopEnd > stopStart);
  const stopSource = html.slice(stopStart, stopEnd);

  assert.match(stopSource, /if \(type === 'discord-to-mobile-client'\) \{\s*ensureMobileClientTarget\(acc\);\s*acc\.mobileClientTarget\.enabled = true;/);
});

test("start and stop instance refresh status immediately after saving", () => {
  const startStart = html.indexOf("async function startInstance()");
  const startEnd = html.indexOf("async function stopInstance()", startStart);
  assert.ok(startStart > 0);
  assert.ok(startEnd > startStart);
  const startSource = html.slice(startStart, startEnd);

  const stopStart = html.indexOf("async function stopInstance()");
  const stopEnd = html.indexOf("async function requestSafewBotStart", stopStart);
  assert.ok(stopStart > 0);
  assert.ok(stopEnd > stopStart);
  const stopSource = html.slice(stopStart, stopEnd);

  assert.match(html, /async function refreshStatusNow\(\)/);
  assert.match(html, /function updateActiveInstanceControls\(acc\)/);
  assert.match(startSource, /updateActiveInstanceControls\(acc\);[\s\S]*await saveConfigImmediate\(\);[\s\S]*await refreshStatusNow\(\);/);
  assert.match(stopSource, /updateActiveInstanceControls\(acc\);[\s\S]*await saveConfigImmediate\(\);[\s\S]*await refreshStatusNow\(\);/);
});

test("stop instance disables Discord-backed SafeW instances even when using account library", () => {
  const stopStart = html.indexOf("async function stopInstance()");
  const stopEnd = html.indexOf("async function requestSafewBotStart", stopStart);
  assert.ok(stopStart > 0);
  assert.ok(stopEnd > stopStart);
  const stopSource = html.slice(stopStart, stopEnd);

  assert.match(stopSource, /const needsDiscord =[\s\S]*'discord-to-safew'/);
  assert.match(stopSource, /if \(needsDiscord\) \{[\s\S]*acc\.loginRequested = false;/);
  assert.match(stopSource, /clearConnectHold\(`discord:\$\{acc\.id\}`\)/);
  assert.match(stopSource, /clearDisconnectHold\(`discord:\$\{acc\.id\}`\)/);
  assert.match(stopSource, /acc\.loginState = 'idle';/);
  assert.match(stopSource, /acc\.loginMessage = '已停止';/);
  assert.doesNotMatch(stopSource, /if \(!usingDiscordLibrary\) \{\s*acc\.loginRequested = false;/);
  assert.doesNotMatch(stopSource, /acc\.loginState = 'disconnecting';/);
  assert.doesNotMatch(stopSource, /acc\.loginMessage = '正在停止\.\.\.';/);
});

test("copy helper falls back when browser clipboard api is unavailable", () => {
  assert.match(html, /function copyToClipboard\(text, type\)/);
  assert.match(html, /function fallbackCopyToClipboard\(value, type\)/);
  assert.match(html, /navigator\.clipboard && typeof navigator\.clipboard\.writeText === 'function'/);
  assert.doesNotMatch(html, /navigator\.clipboard\.writeText\(text\)\.then/);
  assert.match(html, /copyToClipboard\('\$\{escapeJsString\(String\(group\.id \|\| ''\)\)\}', 'SafeW 群组ID'\)/);
});

test("empty visible instance state keeps account library and real add button", () => {
  const emptyStart = html.indexOf("if (visibleAccounts.length === 0)");
  const emptyEnd = html.indexOf("const activeAccount = visibleAccounts", emptyStart);
  assert.ok(emptyStart > 0);
  assert.ok(emptyEnd > emptyStart);
  const emptyState = html.slice(emptyStart, emptyEnd);

  assert.doesNotMatch(emptyState, /appEl\.innerHTML =/);
  assert.match(emptyState, /document\.getElementById\('accountTabs'\)/);
  assert.match(emptyState, /document\.getElementById\('configForm'\)/);
  assert.match(emptyState, /addAccount\(\); render\(\);/);
  assert.match(emptyState, /renderAccountLibraryModal\(\)/);
  assert.match(html, /id="accountLibraryBtn"[\s\S]*openAccountLibrary\(\)/);
});

test("adding an instance persists immediately", () => {
  const addStart = html.indexOf("function addAccount()");
  const addEnd = html.indexOf("function removeAccount()", addStart);
  assert.ok(addStart > 0);
  assert.ok(addEnd > addStart);
  const addSource = html.slice(addStart, addEnd);

  assert.match(addSource, /return saveConfigImmediate\(\)\.catch/);
  assert.match(html, /await addAccount\(\);/);
});

test("account tabs can be dragged to reorder instances and persist the order", () => {
  assert.match(html, /let draggingAccountId = null;/);
  assert.match(html, /function handleAccountTabDragStart\(event, accountId\)/);
  assert.match(html, /function handleAccountTabDrop\(event, targetAccountId\)/);
  assert.match(html, /function handleAccountTabDragEnd\(\)/);
  assert.match(html, /function moveAccountBefore\(dragAccountId, targetAccountId\)/);
  assert.match(html, /draggable="true"/);
  assert.match(html, /ondragstart="handleAccountTabDragStart\(event, '\$\{acc\.id\}'\)"/);
  assert.match(html, /ondragend="handleAccountTabDragEnd\(\)"/);
  assert.match(html, /ondrop="handleAccountTabDrop\(event, '\$\{acc\.id\}'\)"/);
  assert.match(html, /data-account-tab-id="\$\{escapeHtml\(acc\.id\)\}"/);
  assert.match(html, /cursor-grab/);
  const moveStart = html.indexOf("function moveAccountBefore(dragAccountId, targetAccountId)");
  const moveEnd = html.indexOf("function render()", moveStart);
  assert.ok(moveStart > 0);
  assert.ok(moveEnd > moveStart);
  const moveSource = html.slice(moveStart, moveEnd);
  assert.match(moveSource, /state\.accounts\.splice\(dragIndex, 1\)/);
  assert.match(moveSource, /state\.accounts\.splice\(insertIndex, 0, moved\)/);
  assert.match(moveSource, /saveConfigImmediate\(\)/);
});

test("mobile client account tabs show the configured instance name", () => {
  assert.match(html, /function getAccountTabTitle\(acc\)/);
  assert.match(html, /return String\(acc\?\.name \|\| '未命名实例'\)\.trim\(\) \|\| '未命名实例';/);
  assert.match(html, /\$\{escapeHtml\(getAccountTabTitle\(acc\)\)\}/);
  assert.doesNotMatch(html, /<span class="text-sm font-medium">\$\{getAccountDisplayName\(acc\)\}<\/span>/);
});
