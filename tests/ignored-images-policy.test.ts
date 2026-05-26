import test from "node:test";
import assert from "node:assert/strict";

import { shouldSkipMessageForIgnoredImages } from "../src/messageFilterDecisions.ts";

test("shouldSkipMessageForIgnoredImages keeps text when an ignored image is attached", () => {
  assert.equal(
    shouldSkipMessageForIgnoredImages({
      shouldIgnoreImages: true,
      hasImage: true,
      hasTextContent: true,
    }),
    false,
  );
});

test("shouldSkipMessageForIgnoredImages skips pure image messages when images are ignored", () => {
  assert.equal(
    shouldSkipMessageForIgnoredImages({
      shouldIgnoreImages: true,
      hasImage: true,
      hasTextContent: false,
    }),
    true,
  );
});

test("shouldSkipMessageForIgnoredImages does not skip messages without images", () => {
  assert.equal(
    shouldSkipMessageForIgnoredImages({
      shouldIgnoreImages: true,
      hasImage: false,
      hasTextContent: false,
    }),
    false,
  );
});
