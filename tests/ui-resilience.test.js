const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resetTransientUiState,
} = require("../public/js/ui-resilience.js");

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial.filter(Boolean));
  }

  contains(value) {
    return this.values.has(value);
  }

  add(...values) {
    values.forEach((value) => {
      if (value) this.values.add(value);
    });
  }

  remove(...values) {
    values.forEach((value) => this.values.delete(value));
  }
}

function createElement(options = {}) {
  const classes = new FakeClassList(options.classes || []);
  return {
    id: options.id || "",
    className: (options.classes || []).join(" "),
    classList: classes,
    style: { ...(options.style || {}) },
    removed: false,
    remove() {
      this.removed = true;
    },
  };
}

test("resetTransientUiState hides visible modals and removes stale driver overlays", () => {
  const modal = createElement({
    id: "accountLibraryModal",
    classes: ["fixed", "inset-0"],
  });
  const alreadyHiddenModal = createElement({
    id: "syncProgressModal",
    classes: ["hidden", "fixed", "inset-0"],
  });
  const overlayA = createElement({ classes: ["driver-overlay"] });
  const overlayB = createElement({ classes: ["driver-popover"] });
  const body = createElement({ style: { overflow: "hidden" } });
  const documentElement = createElement({
    classes: ["driver-active", "driver-fade", "app-shell"],
  });

  const elementsById = new Map([
    [modal.id, modal],
    [alreadyHiddenModal.id, alreadyHiddenModal],
  ]);

  const document = {
    body,
    documentElement,
    getElementById(id) {
      return elementsById.get(id) || null;
    },
    querySelectorAll(selector) {
      assert.match(selector, /driver-/);
      return [overlayA, overlayB];
    },
  };

  const result = resetTransientUiState({ document });

  assert.equal(result.closedModals, 1);
  assert.equal(result.removedOverlays, 2);
  assert.equal(result.clearedClassCount, 2);
  assert.equal(body.style.overflow, "");
  assert.equal(modal.classList.contains("hidden"), true);
  assert.equal(alreadyHiddenModal.classList.contains("hidden"), true);
  assert.equal(documentElement.className, "app-shell");
  assert.equal(overlayA.removed, true);
  assert.equal(overlayB.removed, true);
});
