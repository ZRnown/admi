(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.safeParseJsonText = api.safeParseJsonText;
  root.readJsonResponse = api.readJsonResponse;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function safeParseJsonText(text) {
    const raw = typeof text === "string" ? text.trim() : "";
    if (!raw) {
      return { ok: true, empty: true, value: {} };
    }

    try {
      return { ok: true, empty: false, value: JSON.parse(raw) };
    } catch (error) {
      return { ok: false, error, raw };
    }
  }

  async function readJsonResponse(response) {
    const text = await response.text();
    const parsed = safeParseJsonText(text);

    if (!parsed.ok) {
      return { ok: false, error: "接口返回了非 JSON 响应", raw: parsed.raw };
    }

    if (parsed.empty) {
      return { ok: false, error: "接口返回空响应", value: {} };
    }

    return { ok: true, value: parsed.value };
  }

  return {
    safeParseJsonText,
    readJsonResponse,
  };
});
