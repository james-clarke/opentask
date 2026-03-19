#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const EXTENSIONS_DIR = path.join(ROOT, "extensions");
const OUTPUT_PATH = path.join(ROOT, "config", "templates", "integration-catalog.json");

const CORE_CHANNEL_IDS = [
  "bluebubbles",
  "discord",
  "googlechat",
  "imessage",
  "irc",
  "line",
  "mattermost",
  "msteams",
  "nextcloud-talk",
  "nostr",
  "signal",
  "slack",
  "synology-chat",
  "telegram",
  "tlon",
  "twitch",
  "webchat",
  "whatsapp",
  "zalo",
  "zalouser",
];

const CORE_PROVIDER_IDS = [
  "anthropic",
  "cloudflare-ai-gateway",
  "gemini",
  "minimax",
  "mistral",
  "moonshot",
  "ollama",
  "openai",
  "openrouter",
  "synthetic",
  "vercel-ai-gateway",
  "xai",
  "zai",
];

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    write: argv.includes("--write") || !argv.includes("--check"),
  };
}

function readExtensionIds() {
  if (!fs.existsSync(EXTENSIONS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

function readChannelExtensionIds() {
  const extensionIds = readExtensionIds();
  const channelIds = [];

  for (const extensionId of extensionIds) {
    const packageJsonPath = path.join(EXTENSIONS_DIR, extensionId, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      const channelId = parsed?.openclaw?.channel?.id;
      if (typeof channelId === "string" && channelId.trim().length > 0) {
        channelIds.push(channelId.trim());
      }
    } catch {
      // Ignore malformed extension package metadata.
    }
  }

  return sortUnique(channelIds);
}

function sortUnique(ids) {
  return Array.from(new Set(ids)).toSorted((a, b) => a.localeCompare(b));
}

function toEntry(id, source) {
  return { id, source };
}

function buildCatalog() {
  const extensionIds = readExtensionIds();
  const channelExtensionIds = readChannelExtensionIds();
  const providers = sortUnique([...CORE_PROVIDER_IDS, ...extensionIds]);
  const channels = sortUnique([...CORE_CHANNEL_IDS, ...channelExtensionIds]);
  const extensions = sortUnique(extensionIds);

  const providerEntries = providers.map((id) =>
    toEntry(id, CORE_PROVIDER_IDS.includes(id) ? "core" : "extension"),
  );
  const channelEntries = channels.map((id) =>
    toEntry(id, CORE_CHANNEL_IDS.includes(id) ? "core" : "extension"),
  );
  const extensionEntries = extensions.map((id) => toEntry(id, "extension"));

  return {
    schemaVersion: "v1",
    providers: providerEntries,
    channels: channelEntries,
    extensions: extensionEntries,
  };
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = buildCatalog();
  const nextText = stableStringify(catalog);
  const existingText = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, "utf8") : "";

  if (args.check) {
    if (existingText !== nextText) {
      console.error("integration-catalog.json is out of date. Run: pnpm client:catalog");
      process.exit(1);
    }
    console.log("integration-catalog.json is up to date.");
    return;
  }

  if (args.write) {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, nextText, "utf8");
    console.log(`Wrote ${path.relative(ROOT, OUTPUT_PATH)}`);
  }
}

main();
