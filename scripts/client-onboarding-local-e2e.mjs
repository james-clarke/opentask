#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

function parseArgs(argv) {
  const args = {
    client: "",
    env: "",
    envFile: "",
    manifest: "",
    rebuild: false,
    keepRunning: false,
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
    if (value === "--rebuild") {
      args.rebuild = true;
      continue;
    }
    if (value === "--keep-running") {
      args.keepRunning = true;
      continue;
    }
    if (value === "--json") {
      args.json = true;
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

function runCommand(command, args) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
  });

  return {
    command: `${command} ${args.join(" ")}`,
    exitCode: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    durationMs: Date.now() - startedAt,
  };
}

function runNodeScript(scriptName, scriptArgs) {
  return runCommand(process.execPath, [path.join("scripts", scriptName), ...scriptArgs]);
}

function printStep(step) {
  const status = step.exitCode === 0 ? "PASS" : "FAIL";
  console.log(`[${status}] ${step.name} (${step.durationMs}ms)`);
  console.log(`  ${step.command}`);
  if (step.exitCode !== 0 && step.stderr) {
    console.log(`  stderr: ${step.stderr}`);
  }
  if (step.exitCode !== 0 && step.stdout) {
    console.log(`  stdout: ${step.stdout}`);
  }
}

function printReport(report) {
  console.log(`Local onboarding E2E: ${report.pass ? "PASS" : "FAIL"}`);
  console.log(`Client: ${report.client}`);
  console.log(`Environment: ${report.environment}`);
  console.log(`Rebuild: ${report.rebuild ? "yes" : "no"}`);
  console.log(`Keep running: ${report.keepRunning ? "yes" : "no"}`);

  for (const step of report.steps) {
    printStep(step);
  }

  if (report.pass) {
    console.log("Interaction guidance:");
    console.log("  - Gateway dashboard: http://127.0.0.1:18789/");
    console.log("  - Use WebChat from the Control UI for first interaction checks.");
    if (!report.keepRunning) {
      console.log(
        "  - Stack was torn down by default. Use --keep-running for interactive sessions.",
      );
    }
  }
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/client-onboarding-local-e2e.mjs --client <id> --env <dev|staging|prod> [--env-file <path>]",
      "Options:",
      "  --manifest <path>     Optional manifest path override",
      "  --rebuild             Rebuild Docker image (openclaw:local) before run",
      "  --keep-running        Keep stack up after success (default is teardown)",
      "  --json                Print JSON report",
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

  const steps = [];
  let pass = true;

  const hostCheck = runCommand(path.join("scripts", "client-host-check.sh"), []);
  steps.push({ name: "host-check", ...hostCheck });
  if (hostCheck.exitCode !== 0) {
    pass = false;
  }

  if (pass && args.rebuild) {
    const build = runCommand("docker", ["build", "-t", "openclaw:local", "-f", "Dockerfile", "."]);
    steps.push({ name: "docker-build", ...build });
    if (build.exitCode !== 0) {
      pass = false;
    }
  }

  if (pass && !args.rebuild) {
    const imageCheck = runCommand("docker", ["image", "inspect", "openclaw:local"]);
    steps.push({ name: "docker-image-check", ...imageCheck });
    if (imageCheck.exitCode !== 0) {
      pass = false;
      steps.push({
        name: "docker-image-check-hint",
        command: "Use --rebuild to build openclaw:local before local E2E",
        exitCode: 1,
        stdout: "Image openclaw:local was not found.",
        stderr: "Run with --rebuild once, then retry without rebuild for faster loops.",
        durationMs: 0,
      });
    }
  }

  if (pass) {
    const simulateArgs = ["--client", client, "--env", environment, "--profile", "full"];
    if (args.envFile) {
      simulateArgs.push("--env-file", args.envFile);
    }
    if (args.manifest) {
      simulateArgs.push("--manifest", args.manifest);
    }
    if (!args.keepRunning) {
      simulateArgs.push("--teardown");
    }
    simulateArgs.push("--json");

    const simulate = runNodeScript("client-simulate.mjs", simulateArgs);
    steps.push({ name: "simulate-full", ...simulate });
    if (simulate.exitCode !== 0) {
      pass = false;
    }
  }

  const report = {
    client,
    environment,
    rebuild: args.rebuild,
    keepRunning: args.keepRunning,
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
