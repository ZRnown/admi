import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDiscordPasswordLoginError,
  normalizeDiscordStorageToken,
} from "../src/discordPasswordLogin.ts";

test("normalizeDiscordStorageToken strips wrapping quotes", () => {
  assert.equal(normalizeDiscordStorageToken('"abc.def.ghi"'), 'abc.def.ghi');
  assert.equal(normalizeDiscordStorageToken('abc.def.ghi'), 'abc.def.ghi');
  assert.equal(normalizeDiscordStorageToken(''), undefined);
});

test("buildDiscordPasswordLoginError detects captcha challenge", () => {
  const message = buildDiscordPasswordLoginError({
    loginPageVisible: true,
    mfaRequired: false,
    pageText: 'captcha required verify you are human',
  });
  assert.match(message, /captcha/i);
});

test("buildDiscordPasswordLoginError surfaces mfa state", () => {
  const message = buildDiscordPasswordLoginError({
    loginPageVisible: false,
    mfaRequired: true,
    pageText: '',
  });
  assert.match(message, /MFA/i);
});
