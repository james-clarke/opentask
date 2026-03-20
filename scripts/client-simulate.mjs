#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const VALID_PROFILES = new Set(["quick", "full"]);

function parseArgs(argv) {
  const args = {
    client: "",
    env: "",
    envFile: "",
    manifest: "",
    profile: "quick",
    teardown: false,
    json: false,
    keepGoing: false,
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
    if (value === "--env-file") {
      args.envFile = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (value === "--manifest") {
      args.manifest = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (value === "--profile") {
      const profile = argv[i + 1] ?? "";
      if (VALID_PROFILES.has(profile)) {
        args.profile = profile;
      }
      i += 1;
      continue;
    }
    if (value === "--teardown") {
      args.teardown = true;
      continue;
    }
    if (value === "--json") {
      args.json = true;
      continue;
    }
    if (value === "--keep-going") {
      args.keepGoing = true;
      continue;
    }
  }

  return args;
}

function requireArg(name, value) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new Error(`Missing required argument ${name}`);
}

function runNodeScript(scriptName, args) {
  const scriptPath = path.join(ROOT, "scripts", scriptName);
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
  });

  return {
    command: `node scripts/${scriptName} ${args.join(" ")}`,
    exitCode: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    durationMs: Date.now() - startedAt,
  };
}

function toAbsolutePath(inputPath) {
  if (!inputPath) {
    return "";
  }
  return path.isAbsolute(inputPath) ? inputPath : path.join(ROOT, inputPath);
}

function resolveManifestPath(client, env, overridePath) {
  return (
    toAbsolutePath(overridePath) ||
    path.join(ROOT, "config", "clients", client, env, "manifest.json")
  );
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

function resolveSecretValue(secretRef, envFileValues) {
  const processValue = process.env[secretRef];
  if (typeof processValue === "string" && processValue.length > 0) {
    return processValue;
  }
  const envValue = envFileValues[secretRef];
  if (typeof envValue === "string" && envValue.length > 0) {
    return envValue;
  }
  return "";
}

function buildComposeEnv(client, env, manifestPath, envFilePath) {
  const baseStateDir = path.join(os.homedir(), ".openclaw-clients", client, env);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const envFileValues = parseEnvFile(toAbsolutePath(envFilePath));
  const gatewayPort = manifest.deployment?.gatewayPort ?? 18789;
  const gatewayBind = manifest.deployment?.gatewayBind === "loopback" ? "loopback" : "lan";
  const gatewayTokenRef = manifest.secretRefs?.OPENCLAW_GATEWAY_TOKEN;
  const gatewayToken =
    typeof gatewayTokenRef === "string" && gatewayTokenRef.length > 0
      ? resolveSecretValue(gatewayTokenRef, envFileValues)
      : "";

  return {
    ...process.env,
    OPENCLAW_CONFIG_DIR: path.join(baseStateDir, "config"),
    OPENCLAW_WORKSPACE_DIR: path.join(baseStateDir, "workspace"),
    OPENCLAW_GATEWAY_PORT: String(gatewayPort),
    OPENCLAW_GATEWAY_BIND: gatewayBind,
    OPENCLAW_IMAGE: process.env.OPENCLAW_IMAGE || "openclaw:local",
    ...(gatewayToken ? { OPENCLAW_GATEWAY_TOKEN: gatewayToken } : {}),
  };
}

function runDockerComposeDown(client, env, composeEnv) {
  const command = [
    "compose",
    "-f",
    path.join(ROOT, "docker-compose.yml"),
    "-p",
    `openclaw-${client}-${env}`,
    "down",
    "--remove-orphans",
  ];

  const startedAt = Date.now();
  const result = spawnSync("docker", command, {
    cwd: ROOT,
    env: composeEnv,
    encoding: "utf8",
  });

  return {
    command: `docker ${command.join(" ")}`,
    exitCode: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    durationMs: Date.now() - startedAt,
  };
}

function runDockerComposeDownBestEffort(client, env, composeEnv) {
  const result = runDockerComposeDown(client, env, composeEnv);
  if (result.exitCode === 0) {
    return result;
  }

  return {
    ...result,
    exitCode: 0,
    stderr: `${result.stderr}\n(non-fatal cleanup step; continuing simulation)`
      .trim()
      .replace(/^\n+/, ""),
  };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runGatewayHealthInsideContainer(client, env, composeEnv, timeoutMs = 30000) {
  const command = [
    "compose",
    "-f",
    path.join(ROOT, "docker-compose.yml"),
    "-p",
    `openclaw-${client}-${env}`,
    "exec",
    "-T",
    "openclaw-gateway",
    "node",
    "-e",
    "fetch('http://127.0.0.1:18789/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
  ];

  const startedAt = Date.now();
  let attempts = 0;
  let lastStdout = "";
  let lastStderr = "";
  let lastExitCode = 1;

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    const result = spawnSync("docker", command, {
      cwd: ROOT,
      env: composeEnv,
      encoding: "utf8",
    });
    lastExitCode = result.status ?? 1;
    lastStdout = result.stdout?.trim() ?? "";
    lastStderr = result.stderr?.trim() ?? "";
    if (lastExitCode === 0) {
      return {
        command: `docker ${command.join(" ")}`,
        exitCode: 0,
        stdout: `gateway health probe passed after ${attempts} attempt(s)`,
        stderr: "",
        durationMs: Date.now() - startedAt,
      };
    }
    sleepMs(1000);
  }

  return {
    command: `docker ${command.join(" ")}`,
    exitCode: lastExitCode,
    stdout: lastStdout,
    stderr: lastStderr || `gateway health probe timed out after ${attempts} attempt(s)`,
    durationMs: Date.now() - startedAt,
  };
}

function runGatewayLogs(client, env, composeEnv, tail = 200) {
  const command = [
    "compose",
    "-f",
    path.join(ROOT, "docker-compose.yml"),
    "-p",
    `openclaw-${client}-${env}`,
    "logs",
    "--no-color",
    "--tail",
    String(tail),
    "openclaw-gateway",
  ];

  const startedAt = Date.now();
  const result = spawnSync("docker", command, {
    cwd: ROOT,
    env: composeEnv,
    encoding: "utf8",
  });

  return {
    command: `docker ${command.join(" ")}`,
    exitCode: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    durationMs: Date.now() - startedAt,
  };
}

function stepArgs(base, extra) {
  return [...base, ...extra];
}

function printStepResult(step) {
  const status = step.exitCode === 0 ? "PASS" : "FAIL";
  console.log(`[${status}] ${step.name} (${step.durationMs}ms)`);
  console.log(`  ${step.command}`);
  if (step.exitCode !== 0 && step.stderr) {
    console.log(`  stderr: ${step.stderr}`);
  }
}

function printReport(report) {
  console.log(`Client simulate profile: ${report.profile}`);
  console.log(`Client: ${report.client}`);
  console.log(`Environment: ${report.environment}`);
  console.log(`Teardown: ${report.teardown ? "yes" : "no"}`);
  console.log(`Overall: ${report.pass ? "PASS" : "FAIL"}`);
  for (const step of report.steps) {
    printStepResult(step);
  }
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/client-simulate.mjs --client <id> --env <dev|staging|prod> [--profile quick|full]",
      "Options:",
      "  --env-file <path>   Optional env file for secret refs",
      "  --manifest <path>   Optional manifest path override",
      "  --profile <mode>    quick (default) or full",
      "  --teardown          Run docker compose down in full profile",
      "  --keep-going        Continue remaining steps after a failure",
      "  --json              Print JSON report",
    ].join("\n"),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.client || !args.env) {
    printUsage();
    process.exit(1);
  }

  const client = requireArg("--client", args.client);
  const environment = requireArg("--env", args.env);
  const manifestPath = resolveManifestPath(client, environment, args.manifest);
  const composeEnv = buildComposeEnv(client, environment, manifestPath, args.envFile);

  const baseArgs = ["--client", client, "--env", environment];
  if (args.envFile) {
    baseArgs.push("--env-file", args.envFile);
  }
  if (args.manifest) {
    baseArgs.push("--manifest", args.manifest);
  }

  const steps = [];
  const queue = [];

  queue.push({
    name: "deploy-dry-run",
    execute: () => runNodeScript("client-deploy.mjs", stepArgs(baseArgs, ["--dry-run", "--json"])),
  });

  if (args.profile === "full") {
    queue.push({
      name: "cleanup-preexisting",
      execute: () => runDockerComposeDownBestEffort(client, environment, composeEnv),
    });

    queue.push({
      name: "deploy-apply",
      execute: () => runNodeScript("client-deploy.mjs", stepArgs(baseArgs, ["--apply"])),
    });
  }

  const verifyArgs = ["--json"];
  queue.push({
    name: "verify",
    execute: () => runNodeScript("client-verify.mjs", stepArgs(baseArgs, verifyArgs)),
  });

  if (args.profile === "full") {
    queue.push({
      name: "gateway-health-container",
      execute: () => runGatewayHealthInsideContainer(client, environment, composeEnv),
    });
  }

  if (args.profile === "full" && args.teardown) {
    queue.push({
      name: "teardown",
      execute: () => runDockerComposeDown(client, environment, composeEnv),
    });
  }

  let pass = true;
  for (const stepDef of queue) {
    const result = stepDef.execute();
    const step = {
      name: stepDef.name,
      ...result,
    };
    steps.push(step);
    if (step.exitCode !== 0) {
      if (step.name === "deploy-apply" || step.name === "gateway-health-container") {
        steps.push({
          name: "gateway-logs",
          ...runGatewayLogs(client, environment, composeEnv),
        });
      }
      pass = false;
      if (!args.keepGoing) {
        break;
      }
    }
  }

  const report = {
    profile: args.profile,
    client,
    environment,
    teardown: args.teardown,
    pass,
    steps,
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

main();
