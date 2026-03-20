import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("status polling uses visibility-aware scheduling instead of fixed interval loop", () => {
  assert.match(html, /const STATUS_POLL_VISIBLE_MS = 2000;/);
  assert.match(html, /const STATUS_POLL_HIDDEN_MS = 10000;/);
  assert.match(html, /function scheduleNextStatusPoll\(/);
  assert.doesNotMatch(html, /function startStatusPolling\(\)\s*{\s*setInterval\(/);
});

test("status polling fetches the lightweight status endpoint instead of the full config payload", () => {
  assert.match(
    html,
    /async function runStatusPoll\(\)[\s\S]*?const res = await fetch\('\/api\/config\/status'\);/,
  );
  assert.doesNotMatch(
    html,
    /async function runStatusPoll\(\)[\s\S]*?const res = await fetch\('\/api\/config'\);/,
  );
});

test("discord searchable selects only rebuild options while open", () => {
  assert.match(
    html,
    /if \(optionsEl && open\) {\s*const nextOptionsHtml = buildDiscordSearchableOptionButtons\(selectId\);/,
  );
});

test("renderMappings no longer emits debug console logs", () => {
  assert.doesNotMatch(html, /\[DEBUG\] renderMappings/);
});

test("async metadata hydration refreshes affected selects instead of rerendering the whole page", () => {
  assert.match(html, /function refreshCachedGuildSelects\(\)/);
  assert.match(
    html,
    /fetchDiscordGuilds\(accountId\)\s*\.finally\(\(\) => {\s*cachedGuildsLoading = false;\s*refreshCachedGuildSelects\(\);/,
  );
  assert.match(html, /function refreshTelegramDialogSelects\(accountId\)/);
  assert.doesNotMatch(html, /then\(\(\) => render\(\)\)/);
});

test("account-level form updates only rerender when the field changes visible structure", () => {
  assert.match(html, /const nonRerenderAccountFields = new Set\(\[/);
  assert.match(html, /function shouldRerenderAccountField\(field\)/);
  assert.match(html, /if \(shouldRerenderAccountField\(field\)\) {\s*render\(\);\s*}/);
  assert.match(html, /if \(field === 'mode'\) {\s*render\(\);\s*}/);
  assert.match(html, /if \(field === 'type' \|\| field === 'name'\) {\s*render\(\);\s*}/);
});

test("config saves use a trimmed payload and idle scheduling instead of serializing the full live state on every debounce", () => {
  assert.match(html, /function buildPersistedState\(\)/);
  assert.match(html, /function persistStatePayload\(\)/);
  assert.match(html, /const body = JSON\.stringify\(payload\);/);
  assert.match(html, /if \(body === lastPersistedStateJson\) {\s*return new Response\(null, { status: 204 }\);/);
  assert.match(html, /function scheduleDeferredSave\(\)/);
  assert.match(html, /saveIdleHandle = scheduleIdleTask\(async \(\) => {/);
});

test("hidden account-library modals are skipped during main render passes", () => {
  assert.match(html, /function renderAccountLibraryModal\(\) {\s*const modal = document\.getElementById\('accountLibraryModal'\);\s*if \(!modal\) return;\s*if \(modal\.classList\.contains\('hidden'\)\) return;/);
  assert.match(html, /function renderAccountLibraryEditModal\(\) {\s*const modal = document\.getElementById\('accountLibraryEditModal'\);\s*if \(!modal\) return;\s*if \(modal\.classList\.contains\('hidden'\)\) return;/);
  assert.match(html, /if \(accountTabsEl\.innerHTML !== tabsHtml\) {\s*accountTabsEl\.innerHTML = tabsHtml;\s*}/);
  assert.match(html, /const nextFormHtml = renderAccountForm\(activeAccount, currentForwardingType\);\s*if \(configFormEl\.innerHTML !== nextFormHtml\) {\s*configFormEl\.innerHTML = nextFormHtml;\s*}/);
});

test("status polling only builds account detail html for the active instance and skips redundant detail DOM writes", () => {
  assert.match(html, /function buildAccountCardSummary\(acc, options = {}\)/);
  assert.match(html, /const includeDetail = options\.includeDetail !== false;/);
  assert.match(html, /const summary = buildAccountCardSummary\(acc, \{ includeDetail: false \}\);/);
  assert.match(html, /const isActive = acc\.id === state\.activeId;\s*const summary = buildAccountCardSummary\(acc, \{ includeDetail: isActive \}\);/);
  assert.match(
    html,
    /if \(instanceDetailEl && isActive\) {\s*const nextDetailHtml = summary\.detailHtml \|\| '';\s*if \(instanceDetailEl\.innerHTML !== nextDetailHtml\) {\s*instanceDetailEl\.innerHTML = nextDetailHtml;\s*}\s*}/,
  );
});

test("library status refreshes avoid unconditional DOM rewrites during polling", () => {
  assert.match(html, /function isLibraryModalVisible\(\) {\s*const modal = document\.getElementById\('accountLibraryModal'\);\s*return Boolean\(modal && !modal\.classList\.contains\('hidden'\)\);\s*}/);
  assert.match(
    html,
    /if \(badgeEl\) {\s*const nextBadgeClassName = `px-2 py-0\.5 rounded-full text-xs \$\{getBadgeClass\(badgeState\)\}`;\s*if \(badgeEl\.textContent !== displayState\) {\s*badgeEl\.textContent = displayState;\s*}\s*if \(badgeEl\.className !== nextBadgeClassName\) {\s*badgeEl\.className = nextBadgeClassName;\s*}\s*}/,
  );
  assert.match(
    html,
    /if \(isLibraryModalVisible\(\) && \(stateChanged \|\| metadataChanged\)\) {\s*updateDiscordLibraryStatusElement\(remoteAcc\.id\);\s*}/,
  );
  assert.match(
    html,
    /if \(inlineBadgeEl\) {\s*const nextInlineBadgeClassName = `px-2 py-0\.5 rounded-full text-xs \$\{getBadgeClass\(badgeState\)\}`;\s*if \(inlineBadgeEl\.textContent !== displayState\) {\s*inlineBadgeEl\.textContent = displayState;\s*}\s*if \(inlineBadgeEl\.className !== nextInlineBadgeClassName\) {\s*inlineBadgeEl\.className = nextInlineBadgeClassName;\s*}\s*}/,
  );
});

test("status polling uses map lookups instead of repeated linear account searches", () => {
  assert.match(html, /const localAccountsById = new Map\(\(state\.accounts \|\| \[\]\)\.map\(\(acc\) => \[acc\.id, acc\]\)\);/);
  assert.match(html, /const localDiscordAccountsById = new Map\(\(\s*state\.discordAccounts \|\| \[\]\s*\)\.map\(\(acc\) => \[acc\.id, acc\]\)\);/);
  assert.match(html, /const localTelegramAccountsById = new Map\(\(\s*state\.telegramAccounts \|\| \[\]\s*\)\.map\(\(acc\) => \[acc\.id, acc\]\)\);/);
  assert.match(html, /const localAcc = localAccountsById\.get\(remoteAcc\.id\);/);
  assert.match(html, /const localAcc = localDiscordAccountsById\.get\(remoteAcc\.id\);/);
  assert.match(html, /const localAcc = localTelegramAccountsById\.get\(remoteAcc\.id\);/);
});

test("active status panels avoid redundant DOM writes during polling", () => {
  assert.match(
    html,
    /if \(badgeEl\) {\s*const nextBadgeClassName = `px-2 py-0\.5 rounded-full \$\{badgeState === 'online'[\s\S]*?\}`;\s*if \(badgeEl\.textContent !== displayState\) {\s*badgeEl\.textContent = displayState;\s*}\s*if \(badgeEl\.className !== nextBadgeClassName\) {\s*badgeEl\.className = nextBadgeClassName;\s*}\s*}/,
  );
  assert.match(
    html,
    /if \(pollEl\) {\s*const nextPollText = `最近拉取: \$\{summary\.lastPollLabel\}`;\s*if \(pollEl\.textContent !== nextPollText\) {\s*pollEl\.textContent = nextPollText;\s*}\s*}/,
  );
  assert.match(
    html,
    /if \(badgeEl\) {\s*const nextBadgeLabel = displayLabels\[normalizedState\] \|\| normalizedState;\s*const nextBadgeClassName = `px-2 py-0\.5 rounded-full \$\{[\s\S]*?\}`;\s*if \(badgeEl\.textContent !== nextBadgeLabel\) {\s*badgeEl\.textContent = nextBadgeLabel;\s*}\s*if \(badgeEl\.className !== nextBadgeClassName\) {\s*badgeEl\.className = nextBadgeClassName;\s*}\s*}/,
  );
});
