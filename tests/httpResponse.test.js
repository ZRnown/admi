const test = require("node:test");
const assert = require("node:assert/strict");

const {
  safeParseJsonText,
  readJsonResponse,
} = require("../public/js/http-response.js");

test("safeParseJsonText marks empty payloads without throwing", () => {
  const result = safeParseJsonText("");

  assert.equal(result.ok, true);
  assert.equal(result.empty, true);
  assert.deepEqual(result.value, {});
});

test("readJsonResponse returns a controlled error for empty response bodies", async () => {
  const response = new Response("", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const result = await readJsonResponse(response);

  assert.equal(result.ok, false);
  assert.equal(result.error, "接口返回空响应");
});

test("readJsonResponse returns a controlled error for non-json bodies", async () => {
  const response = new Response("<html>bad</html>", {
    status: 500,
    headers: { "Content-Type": "text/html" },
  });

  const result = await readJsonResponse(response);

  assert.equal(result.ok, false);
  assert.equal(result.error, "接口返回了非 JSON 响应");
});
