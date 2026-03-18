const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildLightweightSelectOptions,
  buildFullSelectOptions,
} = require("../public/js/discord-select-helpers.js");

test("buildLightweightSelectOptions keeps a closed select to one selected option", () => {
  const html = buildLightweightSelectOptions({
    selectedId: "1204215926334165002",
    selectedLabel: "# whale-monitor",
    placeholderLabel: "选择频道",
    unknownPrefix: "频道",
  });

  assert.equal((html.match(/<option\b/g) || []).length, 1);
  assert.match(html, /1204215926334165002/);
  assert.match(html, /# whale-monitor/);
});

test("buildLightweightSelectOptions falls back to the placeholder when nothing is selected", () => {
  const html = buildLightweightSelectOptions({
    selectedId: "",
    selectedLabel: "",
    placeholderLabel: "选择服务器",
    unknownPrefix: "服务器",
  });

  assert.equal(html, "<option value=\"\">选择服务器</option>");
});

test("buildFullSelectOptions renders the full filtered list when the dropdown is open", () => {
  const html = buildFullSelectOptions({
    items: [
      { id: "1", name: "Alpha", type: 0 },
      { id: "2", name: "Beta", type: 0 },
      { id: "3", name: "Gamma", type: 0 },
    ],
    selectedId: "2",
    selectedLabel: "",
    query: "be",
    placeholderLabel: "选择频道",
    emptyResultsLabel: "无匹配频道",
    renderItemLabel: (item) => `# ${item.name}`,
  });

  assert.equal((html.match(/<option\b/g) || []).length, 2);
  assert.doesNotMatch(html, /Alpha/);
  assert.match(html, /Beta/);
  assert.doesNotMatch(html, /Gamma/);
});
