(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.UiResilience = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DEFAULT_TRANSIENT_MODAL_IDS = [
    "changePasswordModal",
    "ruleConfigModal",
    "accountLibraryModal",
    "accountCreateModal",
    "syncProgressModal",
    "accountLibraryEditModal",
    "scheduledContentModal",
    "librarySyncInfoModal",
    "freeApiSelectModal",
    "longMessageModal",
    "confirmModal",
  ];

  const DRIVER_CLASS_PREFIXES = ["driver-", "driverjs-"];
  const DRIVER_OVERLAY_SELECTOR = [
    '[class*="driver-"]',
    '[class*="driverjs-"]',
  ].join(",");

  function addHiddenClass(element) {
    if (!element || !element.classList || typeof element.classList.add !== "function") {
      return false;
    }
    if (typeof element.classList.contains === "function" && element.classList.contains("hidden")) {
      return false;
    }
    element.classList.add("hidden");
    return true;
  }

  function stripPrefixedClasses(element, prefixes) {
    if (!element) return 0;
    const rawClassName =
      typeof element.className === "string"
        ? element.className
        : typeof element.getAttribute === "function"
          ? element.getAttribute("class") || ""
          : "";
    if (!rawClassName) return 0;

    const classes = rawClassName.split(/\s+/).filter(Boolean);
    const kept = classes.filter(
      (name) => !prefixes.some((prefix) => String(name).startsWith(prefix)),
    );
    const removedCount = classes.length - kept.length;
    if (removedCount === 0) return 0;

    const nextClassName = kept.join(" ");
    if (typeof element.className === "string") {
      element.className = nextClassName;
    } else if (typeof element.setAttribute === "function") {
      element.setAttribute("class", nextClassName);
    }
    return removedCount;
  }

  function resetTransientUiState(options = {}) {
    const doc = options.document;
    if (!doc) {
      return { closedModals: 0, removedOverlays: 0, clearedClassCount: 0 };
    }

    const modalIds =
      Array.isArray(options.modalIds) && options.modalIds.length > 0
        ? options.modalIds
        : DEFAULT_TRANSIENT_MODAL_IDS;

    let closedModals = 0;
    modalIds.forEach((id) => {
      const element = typeof doc.getElementById === "function" ? doc.getElementById(id) : null;
      if (addHiddenClass(element)) {
        closedModals += 1;
      }
    });

    const body = options.body || doc.body || null;
    if (body && body.style) {
      body.style.overflow = "";
    }

    let clearedClassCount = 0;
    clearedClassCount += stripPrefixedClasses(doc.documentElement, DRIVER_CLASS_PREFIXES);
    clearedClassCount += stripPrefixedClasses(body, DRIVER_CLASS_PREFIXES);

    let removedOverlays = 0;
    if (typeof doc.querySelectorAll === "function") {
      const seen = new Set();
      Array.from(doc.querySelectorAll(DRIVER_OVERLAY_SELECTOR)).forEach((node) => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        if (typeof node.remove === "function") {
          node.remove();
          removedOverlays += 1;
        }
      });
    }

    return { closedModals, removedOverlays, clearedClassCount };
  }

  return {
    DEFAULT_TRANSIENT_MODAL_IDS,
    resetTransientUiState,
  };
});
