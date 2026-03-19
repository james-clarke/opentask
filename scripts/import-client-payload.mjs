#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const DEFAULT_PRESET_PATH = path.join(ROOT, "config", "templates", "client-presets.json");
const DEFAULT_PAYLOAD_DIR = path.join(ROOT, "config", "payloads");

const ENVIRONMENTS = new Set(["dev", "staging", "prod"]);
const ID_RE = /^[a-z][a-z0-9-]{1,62}$/;

const PROVIDER_SECRET_ENV = {
  anthropic: "ANTHROPIC_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_AI_GATEWAY_API_KEY",
  gemini: "GEMINI_API_KEY",
  minimax: "MINIMAX_API_KEY",
  mistral: "MISTRAL_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  ollama: "OLLAMA_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  synthetic: "SYNTHETIC_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  xai: "XAI_API_KEY",
  zai: "ZAI_API_KEY",
};

function parseArgs(argv) {
  const args = {
    payload: "",
    presetFile: "",
    outDir: "",
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--payload") {
      args.payload = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (value === "--preset-file") {
      args.presetFile = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (value === "--out-dir") {
      args.outDir = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (value === "--dry-run") {
      args.dryRun = true;
      continue;
    }
  }

  return args;
}

function toAbsolutePath(filePath) {
  if (!filePath) {
    return "";
  }
  return path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sortUnique(values) {
  return Array.from(new Set(values)).toSorted((a, b) => a.localeCompare(b));
}

function buildSecretRefValue(secretKey, clientId, environment) {
  const normalizedClient = clientId.toUpperCase().replaceAll("-", "_");
  const normalizedEnv = environment.toUpperCase();
  return `${secretKey}_${normalizedClient}_${normalizedEnv}`;
}

function normalizeArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function collectProviderSecretKeys(providerIds) {
  const keys = [];
  for (const providerId of providerIds) {
    const key = PROVIDER_SECRET_ENV[providerId];
    if (key) {
      keys.push(key);
    }
  }
  return sortUnique(keys);
}

function validatePayload(payload, filePath) {
  const errors = [];

  if (payload?.schemaVersion !== "v1") {
    errors.push(`${filePath}: schemaVersion must be "v1"`);
  }

  if (typeof payload?.clientId !== "string" || !ID_RE.test(payload.clientId)) {
    errors.push(`${filePath}: clientId must match ${ID_RE.toString()}`);
  }

  if (typeof payload?.environment !== "string" || !ENVIRONMENTS.has(payload.environment)) {
    errors.push(`${filePath}: environment must be one of dev|staging|prod`);
  }

  if (payload?.preset && typeof payload.preset !== "string") {
    errors.push(`${filePath}: preset must be a string when provided`);
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

function buildManifest(payload, presets) {
  const preset = payload.preset ? presets[payload.preset] : undefined;
  if (payload.preset && !preset) {
    throw new Error(`Unknown preset "${payload.preset}"`);
  }

  const deployment = {
    gatewayPort: 18789,
    gatewayBind: "loopback",
    gatewayAuthMode: "token",
    ...preset?.deployment,
    ...payload.deployment,
  };

  const presetIntegrations = preset?.integrations ?? {
    providers: [],
    channels: [],
    extensions: [],
  };
  const payloadIntegrations = payload.integrations ?? {};

  const providers = sortUnique([
    ...normalizeArray(presetIntegrations.providers),
    ...normalizeArray(payloadIntegrations.providers),
  ]);
  const channels = sortUnique([
    ...normalizeArray(presetIntegrations.channels),
    ...normalizeArray(payloadIntegrations.channels),
  ]);
  const extensions = sortUnique([
    ...normalizeArray(presetIntegrations.extensions),
    ...normalizeArray(payloadIntegrations.extensions),
  ]);

  const autoSecretKeys = collectProviderSecretKeys(providers);
  if (deployment.gatewayAuthMode === "token") {
    autoSecretKeys.push("OPENCLAW_GATEWAY_TOKEN");
  }
  if (deployment.gatewayAuthMode === "password") {
    autoSecretKeys.push("OPENCLAW_GATEWAY_PASSWORD");
  }

  const payloadSecretKeys = normalizeArray(payload.secretKeys);
  const allSecretKeys = sortUnique([...autoSecretKeys, ...payloadSecretKeys]);

  const secretRefs = {};
  for (const secretKey of allSecretKeys) {
    secretRefs[secretKey] = buildSecretRefValue(secretKey, payload.clientId, payload.environment);
  }

  if (payload.secretRefOverrides && typeof payload.secretRefOverrides === "object") {
    for (const [secretKey, ref] of Object.entries(payload.secretRefOverrides)) {
      if (typeof ref === "string" && ref.trim().length > 0) {
        secretRefs[secretKey] = ref.trim();
      }
    }
  }

  return {
    schemaVersion: "v1",
    clientId: payload.clientId,
    environment: payload.environment,
    deployment,
    integrations: {
      providers,
      channels,
      extensions,
    },
    secretRefs,
    metadata: {
      ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
      ...(payload.preset ? { preset: payload.preset } : {}),
    },
  };
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function formatGeneratedJsonFiles(filePaths) {
  if (filePaths.length === 0) {
    return;
  }

  const oxfmtBin = path.join(ROOT, "node_modules", ".bin", "oxfmt");
  if (!fs.existsSync(oxfmtBin)) {
    return;
  }

  const result = spawnSync(oxfmtBin, ["--write", ...filePaths], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      `Failed to format generated manifests with oxfmt: ${result.stderr || result.stdout}`,
    );
  }
}

function listPayloadFiles(payloadPath) {
  const stat = fs.statSync(payloadPath);
  if (stat.isFile()) {
    return [payloadPath];
  }

  const files = [];
  const stack = [payloadPath];
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
      if (entry.isFile() && fullPath.endsWith(".json")) {
        files.push(fullPath);
      }
    }
  }

  return files.toSorted((a, b) => a.localeCompare(b));
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/import-client-payload.mjs --payload <file-or-dir>",
      "Options:",
      "  --preset-file <path>   Override client presets file",
      "  --out-dir <path>       Output base directory (defaults to config/clients)",
      "  --dry-run              Print output path only without writing files",
    ].join("\n"),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.payload) {
    printUsage();
    process.exit(1);
  }

  const payloadPath = toAbsolutePath(args.payload);
  const presetsPath = toAbsolutePath(args.presetFile) || DEFAULT_PRESET_PATH;
  const outBase = toAbsolutePath(args.outDir) || path.join(ROOT, "config", "clients");

  if (!fs.existsSync(payloadPath)) {
    console.error(`Payload path not found: ${payloadPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(presetsPath)) {
    console.error(`Preset file not found: ${presetsPath}`);
    process.exit(1);
  }

  const presetsFile = readJson(presetsPath);
  const presets = presetsFile?.presets ?? {};

  const payloadFiles = listPayloadFiles(payloadPath);
  if (payloadFiles.length === 0) {
    console.error(`No payload JSON files found at ${payloadPath}`);
    process.exit(1);
  }

  const generatedManifestPaths = [];

  for (const filePath of payloadFiles) {
    const payload = readJson(filePath);
    validatePayload(payload, filePath);
    const manifest = buildManifest(payload, presets);
    const outputPath = path.join(outBase, payload.clientId, payload.environment, "manifest.json");
    if (!args.dryRun) {
      writeJson(outputPath, manifest);
      generatedManifestPaths.push(outputPath);
    }
    console.log(`${args.dryRun ? "[dry-run] " : ""}${path.relative(ROOT, outputPath)}`);
  }

  if (!args.dryRun) {
    formatGeneratedJsonFiles(generatedManifestPaths);
  }
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printUsage();
  process.exit(0);
}

if (!process.argv.includes("--payload")) {
  const defaultPath = DEFAULT_PAYLOAD_DIR;
  if (fs.existsSync(defaultPath)) {
    process.argv.push("--payload", defaultPath);
  }
}

main();
