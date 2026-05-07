(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.DiscordSelectHelpers = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeNamedQuery(value) {
    return String(value || "").trim().toLowerCase();
  }

  function resolveSelectedLabel(selectedId, selectedLabel, placeholderLabel, unknownPrefix) {
    const label = String(selectedLabel || "").trim();
    if (label) {
      return label;
    }
    if (!selectedId) {
      return placeholderLabel;
    }
    return unknownPrefix ? `${unknownPrefix} (${selectedId})` : String(selectedId);
  }

  function resolveSelectedLabelFromItems(items, selectedId, renderItemLabel) {
    if (!selectedId || !Array.isArray(items) || items.length === 0) {
      return "";
    }
    const matched = items.find((item) => String(item?.id || "") === String(selectedId));
    if (!matched) {
      return "";
    }
    if (typeof renderItemLabel === "function") {
      return String(renderItemLabel(matched) || "").trim();
    }
    return String(matched?.name || matched?.title || matched?.label || matched?.id || "").trim();
  }

  function buildLightweightSelectOptions(options = {}) {
    const selectedId = String(options.selectedId || "");
    const placeholderLabel = String(options.placeholderLabel || "请选择");
    if (!selectedId) {
      return `<option value="">${escapeHtml(placeholderLabel)}</option>`;
    }
    const selectedLabel =
      String(options.selectedLabel || "").trim() ||
      resolveSelectedLabelFromItems(options.items, selectedId, options.renderItemLabel);
    const label = resolveSelectedLabel(
      selectedId,
      selectedLabel,
      placeholderLabel,
      options.unknownPrefix || "",
    );
    return `<option value="${escapeHtml(selectedId)}" selected>${escapeHtml(label)}</option>`;
  }

  function filterNamedItems(items, query, selectedId) {
    const normalizedQuery = normalizeNamedQuery(query);
    if (!normalizedQuery) {
      return items;
    }
    return items.filter((item) => {
      if (!item || typeof item !== "object") {
        return false;
      }
      const itemId = String(item.id || "");
      if (selectedId && itemId === String(selectedId)) {
        return true;
      }
      const haystack = [item.name, item.title, item.label]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }

  function buildFullSelectOptions(options = {}) {
    const items = Array.isArray(options.items) ? options.items : [];
    const selectedId = String(options.selectedId || "");
    const placeholderLabel = String(options.placeholderLabel || "请选择");
    const emptyResultsLabel = String(options.emptyResultsLabel || placeholderLabel);
    const query = options.query;
    const renderItemLabel =
      typeof options.renderItemLabel === "function"
        ? options.renderItemLabel
        : (item) => item?.name || item?.title || item?.label || item?.id || "";

    const visibleItems = filterNamedItems(items, query, selectedId);
    const normalizedQuery = normalizeNamedQuery(query);
    const emptyLabel = visibleItems.length === 0 && normalizedQuery ? emptyResultsLabel : placeholderLabel;
    let html = `<option value="">${escapeHtml(emptyLabel)}</option>`;

    visibleItems.forEach((item) => {
      const itemId = String(item?.id || "");
      html += `<option value="${escapeHtml(itemId)}" ${itemId === selectedId ? "selected" : ""}>${escapeHtml(
        renderItemLabel(item),
      )}</option>`;
    });

    if (selectedId && !items.some((item) => String(item?.id || "") === selectedId)) {
      const label = resolveSelectedLabel(
        selectedId,
        options.selectedLabel,
        placeholderLabel,
        options.unknownPrefix || "",
      );
      html += `<option value="${escapeHtml(selectedId)}" selected>${escapeHtml(label)}</option>`;
    }

    return html;
  }

  function shouldAutoSyncGuildsForEmptyCache(options = {}) {
    if (!options.accountId) {
      return false;
    }
    if (!options.hasToken) {
      return false;
    }
    if (options.loading || options.inFlight || options.attempted) {
      return false;
    }
    return !Array.isArray(options.guilds) || options.guilds.length === 0;
  }

  return {
    buildFullSelectOptions,
    buildLightweightSelectOptions,
    shouldAutoSyncGuildsForEmptyCache,
  };
});
