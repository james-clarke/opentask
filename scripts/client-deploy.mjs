#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const COMPOSE_FILE = path.join(ROOT, "docker-compose.yml");
const VALID_ENVIRONMENTS = new Set(["dev", "staging", "prod"]);

function parseArgs(argv) {
  const args = {
    client: "",
    env: "",
    manifest: "",
    envFile: "",
    mode: "dry-run",
    json: false,
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
    if (value === "--apply") {
      args.mode = "apply";
      continue;
    }
    if (value === "--dry-run") {
      args.mode = "dry-run";
      continue;
    }
    if (value === "--json") {
      args.json = true;
      continue;
    }
  }

  return args;
}

function toAbsolutePath(value) {
  if (!value) {
    return "";
  }
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function parseEnvFile(filePath) {
  const env = {};
  if (!filePath || !fs.existsSync(filePath)) {
    return env;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals < 1) {
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim();
    env[key] = value;
  }

  return env;
}

function requireArg(name, value) {
  if (value && value.trim().length > 0) {
    return value.trim();
  }
  throw new Error(`Missing required argument: ${name}`);
}

function loadManifest(args) {
  const client = requireArg("--client", args.client);
  const env = requireArg("--env", args.env);
  if (!VALID_ENVIRONMENTS.has(env)) {
    throw new Error("--env must be one of dev|staging|prod");
  }

  const manifestPath =
    toAbsolutePath(args.manifest) ||
    path.join(ROOT, "config", "clients", client, env, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return { client, env, manifestPath, manifest };
}

function resolveSecretValue(secretRef, fileEnv) {
  if (typeof process.env[secretRef] === "string" && process.env[secretRef].length > 0) {
    return process.env[secretRef];
  }
  if (typeof fileEnv[secretRef] === "string" && fileEnv[secretRef].length > 0) {
    return fileEnv[secretRef];
  }
  return "";
}

function buildPlan(input) {
  const { client, env, manifestPath, manifest, args } = input;
  const fileEnv = parseEnvFile(toAbsolutePath(args.envFile));

  const baseStateDir = path.join(os.homedir(), ".openclaw-clients", client, env);
  const configDir = path.join(baseStateDir, "config");
  const workspaceDir = path.join(baseStateDir, "workspace");

  const deployment = manifest.deployment ?? {};
  const gatewayPort = deployment.gatewayPort ?? 18789;
  const gatewayBind = deployment.gatewayBind === "loopback" ? "loopback" : "lan";
  const gatewayAuthMode = deployment.gatewayAuthMode ?? "token";

  const secretRefs = manifest.secretRefs ?? {};
  const requiredRefs = Object.values(secretRefs)
    .filter((value) => typeof value === "string")
    .toSorted();

  const missingSecretRefs = requiredRefs.filter((ref) => !resolveSecretValue(ref, fileEnv));

  const warnings = [];
  const errors = [];
  if (gatewayAuthMode !== "token") {
    errors.push(
      `gatewayAuthMode=${gatewayAuthMode} is not supported by docker-compose.yml yet (token mode only).`,
    );
  }

  if (gatewayBind === "lan") {
    warnings.push("Gateway bind is exposed on LAN; keep firewall and auth policy strict.");
  }

  if (missingSecretRefs.length > 0) {
    errors.push(`Missing ${missingSecretRefs.length} secret reference value(s) in env/env-file.`);
  }

  const runtimeEnv = {
    OPENCLAW_CONFIG_DIR: configDir,
    OPENCLAW_WORKSPACE_DIR: workspaceDir,
    OPENCLAW_GATEWAY_PORT: String(gatewayPort),
    OPENCLAW_GATEWAY_BIND: gatewayBind,
    OPENCLAW_IMAGE: process.env.OPENCLAW_IMAGE || "openclaw:local",
  };

  const gatewayTokenRef = secretRefs.OPENCLAW_GATEWAY_TOKEN;
  if (typeof gatewayTokenRef === "string" && gatewayTokenRef.length > 0) {
    const value = resolveSecretValue(gatewayTokenRef, fileEnv);
    if (value) {
      runtimeEnv.OPENCLAW_GATEWAY_TOKEN = value;
    }
  }

  const commandPreview = [
    "docker",
    "compose",
    "-f",
    COMPOSE_FILE,
    "-p",
    `openclaw-${client}-${env}`,
    "up",
    "-d",
    "openclaw-gateway",
    "openclaw-cli",
  ];

  return {
    client,
    environment: env,
    manifestPath: path.relative(ROOT, manifestPath),
    mode: args.mode,
    composeFile: path.relative(ROOT, COMPOSE_FILE),
    composeProject: `openclaw-${client}-${env}`,
    runtimeEnvPublic: {
      OPENCLAW_CONFIG_DIR: runtimeEnv.OPENCLAW_CONFIG_DIR,
      OPENCLAW_WORKSPACE_DIR: runtimeEnv.OPENCLAW_WORKSPACE_DIR,
      OPENCLAW_GATEWAY_PORT: runtimeEnv.OPENCLAW_GATEWAY_PORT,
      OPENCLAW_GATEWAY_BIND: runtimeEnv.OPENCLAW_GATEWAY_BIND,
      OPENCLAW_IMAGE: runtimeEnv.OPENCLAW_IMAGE,
    },
    integrationSummary: {
      providers: manifest.integrations?.providers ?? [],
      channels: manifest.integrations?.channels ?? [],
      extensions: manifest.integrations?.extensions ?? [],
    },
    requiredSecretRefs: requiredRefs,
    missingSecretRefs,
    warnings,
    errors,
    commandPreview,
    runtimeEnv,
  };
}

function printPlan(plan) {
  console.log(`Client: ${plan.client}`);
  console.log(`Environment: ${plan.environment}`);
  console.log(`Manifest: ${plan.manifestPath}`);
  console.log(`Compose project: ${plan.composeProject}`);
  console.log(`Compose file: ${plan.composeFile}`);
  console.log("Runtime env:");
  for (const [key, value] of Object.entries(plan.runtimeEnvPublic)) {
    console.log(`  - ${key}=${String(value)}`);
  }

  console.log("Integrations:");
  console.log(
    `  - providers (${plan.integrationSummary.providers.length}): ${plan.integrationSummary.providers.join(", ") || "none"}`,
  );
  console.log(
    `  - channels (${plan.integrationSummary.channels.length}): ${plan.integrationSummary.channels.join(", ") || "none"}`,
  );
  console.log(
    `  - extensions (${plan.integrationSummary.extensions.length}): ${plan.integrationSummary.extensions.join(", ") || "none"}`,
  );

  if (plan.requiredSecretRefs.length > 0) {
    console.log("Required secret refs:");
    for (const ref of plan.requiredSecretRefs) {
      const status = plan.missingSecretRefs.includes(ref) ? "missing" : "ok";
      console.log(`  - ${ref} (${status})`);
    }
  }

  if (plan.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of plan.warnings) {
      console.log(`  - ${warning}`);
    }
  }

  if (plan.errors.length > 0) {
    console.log("Errors:");
    for (const error of plan.errors) {
      console.log(`  - ${error}`);
    }
  }

  console.log(`Command preview: ${plan.commandPreview.join(" ")}`);
}

function runApply(plan) {
  if (plan.errors.length > 0) {
    throw new Error("Cannot apply deployment while plan contains errors.");
  }

  fs.mkdirSync(plan.runtimeEnv.OPENCLAW_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(plan.runtimeEnv.OPENCLAW_WORKSPACE_DIR, { recursive: true });
  ensureGatewayBootstrapConfig(plan);

  const child = spawnSync(plan.commandPreview[0], plan.commandPreview.slice(1), {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      ...plan.runtimeEnv,
    },
  });

  if (child.status !== 0) {
    throw new Error(`docker compose exited with status ${child.status ?? 1}`);
  }
}

function ensureGatewayBootstrapConfig(plan) {
  const configPath = path.join(plan.runtimeEnv.OPENCLAW_CONFIG_DIR, "openclaw.json");
  let config = {};

  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (parsed && typeof parsed === "object") {
        config = parsed;
      }
    } catch {
      // If the file is invalid JSON, recreate a safe minimal config.
      config = {};
    }
  }

  const currentGateway = config.gateway && typeof config.gateway === "object" ? config.gateway : {};
  config.gateway = {
    ...currentGateway,
    mode: "local",
    bind: plan.runtimeEnv.OPENCLAW_GATEWAY_BIND,
  };

  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/client-deploy.mjs --client <id> --env <dev|staging|prod> [--dry-run]",
      "  node scripts/client-deploy.mjs --client <id> --env <dev|staging|prod> --apply",
      "Options:",
      "  --manifest <path>   Override manifest path",
      "  --env-file <path>   Optional env file supplying secret values",
      "  --json              Print plan as JSON",
    ].join("\n"),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.client || !args.env) {
    printUsage();
    process.exit(1);
  }

  const loaded = loadManifest(args);
  const plan = buildPlan({ ...loaded, args });

  if (args.json) {
    const printable = {
      ...plan,
      runtimeEnv: undefined,
    };
    console.log(`${JSON.stringify(printable, null, 2)}\n`);
  } else {
    printPlan(plan);
  }

  if (args.mode === "apply") {
    runApply(plan);
  } else if (plan.errors.length > 0) {
    process.exit(1);
  }
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printUsage();
  process.exit(0);
}

main();
