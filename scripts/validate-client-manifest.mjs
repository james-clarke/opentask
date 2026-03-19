#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import Ajv2020 from "ajv/dist/2020.js";

const ROOT = process.cwd();
const DEFAULT_MANIFEST_DIR = path.join(ROOT, "config", "clients");
const DEFAULT_SCHEMA_PATH = path.join(ROOT, "config", "templates", "client-manifest.schema.json");
const DEFAULT_CATALOG_PATH = path.join(ROOT, "config", "templates", "integration-catalog.json");

const CORE_CHANNEL_IDS = new Set([
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
]);

const CORE_PROVIDER_IDS = new Set([
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
]);

const ENV_REF_RE = /^[A-Z][A-Z0-9_]{2,127}$/;

function parseArgs(argv) {
  const args = {
    file: "",
    dir: "",
    schema: "",
    catalog: "",
    failOnWarnings: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--file") {
      args.file = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (value === "--dir") {
      args.dir = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (value === "--schema") {
      args.schema = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (value === "--catalog") {
      args.catalog = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (value === "--fail-on-warnings") {
      args.failOnWarnings = true;
      continue;
    }
  }

  return args;
}

function asAbsolutePath(inputPath) {
  if (!inputPath) {
    return "";
  }
  return path.isAbsolute(inputPath) ? inputPath : path.join(ROOT, inputPath);
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function listExtensionIds() {
  const extensionsDir = path.join(ROOT, "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return new Set();
  }
  return new Set(
    fs
      .readdirSync(extensionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
}

function normalizeCatalogList(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry && typeof entry === "object" && typeof entry.id === "string") {
        return entry.id;
      }
      return "";
    })
    .filter(Boolean);
}

function loadCatalogSets(catalogPath) {
  const extensionIds = listExtensionIds();
  const fallbackKnownChannels = new Set([...CORE_CHANNEL_IDS, ...extensionIds]);
  const fallbackKnownProviders = new Set([...CORE_PROVIDER_IDS, ...extensionIds]);
  const fallbackExtensions = new Set(extensionIds);

  if (!catalogPath || !fs.existsSync(catalogPath)) {
    return {
      knownChannels: fallbackKnownChannels,
      knownProviders: fallbackKnownProviders,
      knownExtensions: fallbackExtensions,
    };
  }

  let parsed;
  try {
    parsed = readJson(catalogPath);
  } catch {
    return {
      knownChannels: fallbackKnownChannels,
      knownProviders: fallbackKnownProviders,
      knownExtensions: fallbackExtensions,
    };
  }

  const knownChannels = new Set(normalizeCatalogList(parsed.channels));
  const knownProviders = new Set(normalizeCatalogList(parsed.providers));
  const knownExtensions = new Set(normalizeCatalogList(parsed.extensions));

  return {
    knownChannels: knownChannels.size > 0 ? knownChannels : fallbackKnownChannels,
    knownProviders: knownProviders.size > 0 ? knownProviders : fallbackKnownProviders,
    knownExtensions: knownExtensions.size > 0 ? knownExtensions : fallbackExtensions,
  };
}

function listManifestFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const files = [];
  const stack = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === "manifest.json") {
        files.push(fullPath);
      }
    }
  }

  return files.toSorted((a, b) => a.localeCompare(b));
}

function formatAjvErrors(errors) {
  if (!errors || errors.length === 0) {
    return [];
  }
  return errors.map((error) => {
    const location = error.instancePath || "/";
    const message = error.message ?? "schema validation error";
    return `${location} ${message}`;
  });
}

function collectUnknown(items, knownSet) {
  return items.filter((item) => !knownSet.has(item));
}

function validateSemanticRules(manifest, context) {
  const { filePath, knownChannels, knownProviders, knownExtensions } = context;
  const errors = [];
  const warnings = [];
  const env = manifest.environment;
  const isStrictEnv = env === "staging" || env === "prod";

  const unknownProviders = collectUnknown(manifest.integrations.providers, knownProviders);
  const unknownChannels = collectUnknown(manifest.integrations.channels, knownChannels);
  const unknownExtensions = collectUnknown(manifest.integrations.extensions, knownExtensions);

  for (const provider of unknownProviders) {
    const message = `${filePath}: unknown provider integration "${provider}"`;
    if (isStrictEnv) {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  }

  for (const channel of unknownChannels) {
    const message = `${filePath}: unknown channel integration "${channel}"`;
    if (isStrictEnv) {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  }

  for (const extension of unknownExtensions) {
    const message = `${filePath}: extension "${extension}" is not installed under extensions/`;
    if (isStrictEnv) {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  }

  if (manifest.deployment.gatewayAuthMode === "token") {
    const value = manifest.secretRefs.OPENCLAW_GATEWAY_TOKEN;
    if (!value || !ENV_REF_RE.test(value)) {
      errors.push(`${filePath}: token mode requires secretRefs.OPENCLAW_GATEWAY_TOKEN`);
    }
  }

  if (manifest.deployment.gatewayAuthMode === "password") {
    const value = manifest.secretRefs.OPENCLAW_GATEWAY_PASSWORD;
    if (!value || !ENV_REF_RE.test(value)) {
      errors.push(`${filePath}: password mode requires secretRefs.OPENCLAW_GATEWAY_PASSWORD`);
    }
  }

  const secretRefValues = Object.values(manifest.secretRefs);
  const duplicateSecretRefs = secretRefValues.filter(
    (ref, index) => secretRefValues.indexOf(ref) !== index,
  );
  if (duplicateSecretRefs.length > 0) {
    warnings.push(
      `${filePath}: duplicate secret ref targets found (${Array.from(
        new Set(duplicateSecretRefs),
      ).join(", ")})`,
    );
  }

  return { errors, warnings };
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/validate-client-manifest.mjs --file <path>",
      "  node scripts/validate-client-manifest.mjs --dir <path>",
      "Options:",
      "  --schema <path>         Override schema path",
      "  --catalog <path>        Override integration catalog path",
      "  --fail-on-warnings      Treat warnings as errors",
    ].join("\n"),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const schemaPath = asAbsolutePath(args.schema) || DEFAULT_SCHEMA_PATH;
  const catalogPath = asAbsolutePath(args.catalog) || DEFAULT_CATALOG_PATH;
  const filePath = asAbsolutePath(args.file);
  const dirPath = asAbsolutePath(args.dir) || (!filePath ? DEFAULT_MANIFEST_DIR : "");

  if (!fs.existsSync(schemaPath)) {
    console.error(`Schema file not found: ${schemaPath}`);
    process.exit(1);
  }

  let manifestPaths = [];
  if (filePath) {
    manifestPaths = [filePath];
  } else if (dirPath) {
    manifestPaths = listManifestFiles(dirPath);
  }

  if (manifestPaths.length === 0) {
    console.warn("No manifest files found. Nothing to validate.");
    process.exit(0);
  }

  const schema = readJson(schemaPath);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  const { knownChannels, knownProviders, knownExtensions } = loadCatalogSets(catalogPath);

  const allErrors = [];
  const allWarnings = [];

  for (const manifestPath of manifestPaths) {
    if (!fs.existsSync(manifestPath)) {
      allErrors.push(`${manifestPath}: file does not exist`);
      continue;
    }

    let manifest;
    try {
      manifest = readJson(manifestPath);
    } catch (error) {
      allErrors.push(
        `${manifestPath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }

    const valid = validate(manifest);
    if (!valid) {
      for (const message of formatAjvErrors(validate.errors)) {
        allErrors.push(`${manifestPath}: ${message}`);
      }
      continue;
    }

    const semantic = validateSemanticRules(manifest, {
      filePath: manifestPath,
      knownChannels,
      knownProviders,
      knownExtensions,
    });
    allErrors.push(...semantic.errors);
    allWarnings.push(...semantic.warnings);
  }

  for (const warning of allWarnings) {
    console.warn(`WARN: ${warning}`);
  }

  if (allWarnings.length > 0 && args.failOnWarnings) {
    allErrors.push("Warnings are treated as errors because --fail-on-warnings is set.");
  }

  if (allErrors.length > 0) {
    for (const error of allErrors) {
      console.error(`ERROR: ${error}`);
    }
    process.exit(1);
  }

  console.log(`Validated ${manifestPaths.length} manifest file(s) successfully.`);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printUsage();
  process.exit(0);
}

main();
