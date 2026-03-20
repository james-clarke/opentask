#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const VALID_ENVIRONMENTS = new Set(["dev", "staging", "prod"]);

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
    client: "",
    env: "",
    manifest: "",
    envFile: "",
    json: false,
    strict: false,
    checkGateway: false,
    gatewayTimeoutMs: 5000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--client") {
      args.client = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (value === "--env") {
      args.env = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (value === "--manifest") {
      args.manifest = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (value === "--env-file") {
      args.envFile = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (value === "--gateway-timeout-ms") {
      const parsed = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.gatewayTimeoutMs = parsed;
      }
      i += 1;
      continue;
    }
    if (value === "--json") {
      args.json = true;
      continue;
    }
    if (value === "--strict") {
      args.strict = true;
      continue;
    }
    if (value === "--check-gateway") {
      args.checkGateway = true;
      continue;
    }
  }

  return args;
}

function toAbsolutePath(inputPath) {
  if (!inputPath) {
    return "";
  }
  return path.isAbsolute(inputPath) ? inputPath : path.join(ROOT, inputPath);
}

function parseEnvFile(filePath) {
  const values = {};
  if (!filePath || !fs.existsSync(filePath)) {
    return values;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    values[key] = value;
  }
  return values;
}

function requireArg(name, value) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new Error(`Missing required argument ${name}`);
}

function loadManifest(args) {
  const client = requireArg("--client", args.client);
  const environment = requireArg("--env", args.env);

  if (!VALID_ENVIRONMENTS.has(environment)) {
    throw new Error("--env must be one of dev|staging|prod");
  }

  const manifestPath =
    toAbsolutePath(args.manifest) ||
    path.join(ROOT, "config", "clients", client, environment, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }

  return {
    client,
    environment,
    manifestPath,
    manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
  };
}

function resolveSecretValue(secretRef, fileEnv) {
  const envValue = process.env[secretRef];
  if (typeof envValue === "string" && envValue.length > 0) {
    return envValue;
  }

  const fileValue = fileEnv[secretRef];
  if (typeof fileValue === "string" && fileValue.length > 0) {
    return fileValue;
  }

  return "";
}

function findMissingSecretRefs(manifest, fileEnv) {
  const refs = Object.values(manifest.secretRefs ?? {}).filter(
    (value) => typeof value === "string",
  );
  const unique = Array.from(new Set(refs)).toSorted((a, b) => a.localeCompare(b));
  return unique.filter((ref) => resolveSecretValue(ref, fileEnv).length === 0);
}

function evaluateProviders(manifest) {
  const warnings = [];
  const providers = manifest.integrations?.providers ?? [];
  const mapped = [];

  for (const provider of providers) {
    const envKey = PROVIDER_SECRET_ENV[provider];
    if (!envKey) {
      warnings.push(`No known secret mapping for provider "${provider}".`);
      continue;
    }
    mapped.push({ provider, envKey });
  }

  return { warnings, mapped };
}

async function checkGatewayHealth(manifest, timeoutMs) {
  const port = manifest.deployment?.gatewayPort ?? 18789;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      method: "GET",
      signal: controller.signal,
    });

    return {
      ok: response.ok,
      status: response.status,
      url: `http://127.0.0.1:${port}/healthz`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url: `http://127.0.0.1:${port}/healthz`,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function printReport(report) {
  console.log(`Client: ${report.client}`);
  console.log(`Environment: ${report.environment}`);
  console.log(`Manifest: ${report.manifestPath}`);
  console.log(`Providers: ${report.providers.join(", ") || "none"}`);
  console.log(`Channels: ${report.channels.join(", ") || "none"}`);
  console.log(`Extensions: ${report.extensions.join(", ") || "none"}`);

  if (report.missingSecretRefs.length > 0) {
    console.log("Missing secret refs:");
    for (const ref of report.missingSecretRefs) {
      console.log(`  - ${ref}`);
    }
  } else {
    console.log("Missing secret refs: none");
  }

  if (report.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of report.warnings) {
      console.log(`  - ${warning}`);
    }
  }

  if (report.errors.length > 0) {
    console.log("Errors:");
    for (const error of report.errors) {
      console.log(`  - ${error}`);
    }
  }

  if (report.gateway) {
    console.log(
      `Gateway health: ${report.gateway.ok ? "ok" : "failed"} (${report.gateway.url}${
        report.gateway.status ? ` status=${report.gateway.status}` : ""
      })`,
    );
  }

  console.log(`Result: ${report.pass ? "PASS" : "FAIL"}`);
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/client-verify.mjs --client <id> --env <dev|staging|prod> [--env-file <path>]",
      "Options:",
      "  --manifest <path>           Override manifest path",
      "  --env-file <path>           Optional env file for secret refs",
      "  --check-gateway             Probe local gateway /healthz from manifest port",
      "  --gateway-timeout-ms <ms>   Gateway probe timeout (default 5000)",
      "  --strict                    Treat warnings as failures",
      "  --json                      Print JSON output",
    ].join("\n"),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.client || !args.env) {
    printUsage();
    process.exit(1);
  }

  const loaded = loadManifest(args);
  const fileEnv = parseEnvFile(toAbsolutePath(args.envFile));
  const missingSecretRefs = findMissingSecretRefs(loaded.manifest, fileEnv);
  const providerEvaluation = evaluateProviders(loaded.manifest);

  const warnings = [...providerEvaluation.warnings];
  const errors = [];

  if (missingSecretRefs.length > 0) {
    errors.push(`Missing ${missingSecretRefs.length} required secret reference values.`);
  }

  const gateway = args.checkGateway
    ? await checkGatewayHealth(loaded.manifest, args.gatewayTimeoutMs)
    : null;
  if (gateway && !gateway.ok) {
    errors.push(`Gateway health check failed (${gateway.url}).`);
  }

  const report = {
    client: loaded.client,
    environment: loaded.environment,
    manifestPath: path.relative(ROOT, loaded.manifestPath),
    providers: loaded.manifest.integrations?.providers ?? [],
    channels: loaded.manifest.integrations?.channels ?? [],
    extensions: loaded.manifest.integrations?.extensions ?? [],
    providerSecretMappings: providerEvaluation.mapped,
    missingSecretRefs,
    warnings,
    errors,
    gateway,
    pass: errors.length === 0 && (!args.strict || warnings.length === 0),
  };

  if (args.json) {
    console.log(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReport(report);
  }

  if (!report.pass) {
    process.exit(1);
  }
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printUsage();
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
