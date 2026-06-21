import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  appendDiscordComponentLinks,
  extractDiscordComponentLinks,
} from "../src/discordComponentLinks.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("extractDiscordComponentLinks reads nested url buttons", () => {
  const links = extractDiscordComponentLinks([
    {
      components: [
        { label: "Text", url: "https://example.com/text" },
        { data: { label: "HTML", url: "https://example.com/html" } },
      ],
    },
  ]);

  assert.deepEqual(links, [
    { label: "Text", url: "https://example.com/text" },
    { label: "HTML", url: "https://example.com/html" },
  ]);
});

test("extractDiscordComponentLinks reads component v2 accessory buttons", () => {
  const links = extractDiscordComponentLinks([
    {
      type: 9,
      accessory: {
        type: 2,
        label: "HTML",
        url: "https://example.com/html",
      },
    },
  ]);

  assert.deepEqual(links, [
    { label: "HTML", url: "https://example.com/html" },
  ]);
});

test("discord bridge serializer preserves component v2 accessory buttons", () => {
  const bridgeSource = readFileSync(
    path.join(__dirname, "..", "discord_bridge", "src", "discord_bridge", "main.py"),
    "utf8",
  );

  assert.match(bridgeSource, /getattr\(component,\s*"accessory",\s*None\)/);
  assert.match(bridgeSource, /item\["accessory"\]\s*=/);
});

test("appendDiscordComponentLinks adds links after content and dedupes urls", () => {
  const content = appendDiscordComponentLinks("@everyone", [
    {
      components: [
        { label: "Text", url: "https://example.com/text" },
        { label: "Copy", url: "https://example.com/text" },
      ],
    },
  ]);

  assert.equal(content, "@everyone\nText: https://example.com/text");
});

test("appendDiscordComponentLinks can render links as markdown", () => {
  const content = appendDiscordComponentLinks("content", [
    {
      components: [
        { label: "HTML", url: "https://example.com/html" },
      ],
    },
  ], { format: "markdown" });

  assert.equal(content, "content\n[HTML](https://example.com/html)");
});

test("sequential dedupe signature includes component links", () => {
  const source = readFileSync(path.join(__dirname, "..", "src", "bot.ts"), "utf8");

  assert.match(source, /extractDiscordComponentLinks\(.*message as any\)\.components\)/);
  assert.match(source, /\|\|components:\$\{componentLinks\}/);
});
