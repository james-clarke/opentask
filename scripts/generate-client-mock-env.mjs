#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

function parseArgs(argv) {
  const args = {
    manifest: "",
    out: "",
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--manifest") {
      args.manifest = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (value === "--out") {
      args.out = argv[i + 1] ?? "";
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

function toMockValue(secretRef) {
  return `mock-${secretRef.toLowerCase().replaceAll("_", "-")}`;
}

function buildEnvTemplate(manifestPath, manifest) {
  const lines = [
    "# Generated mock environment file for local testing only.",
    `# Source manifest: ${path.relative(ROOT, manifestPath)}`,
    "# Do not place real secrets in this file.",
    "",
  ];

  const refs = Object.values(manifest.secretRefs ?? {})
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .toSorted((a, b) => a.localeCompare(b));

  for (const ref of refs) {
    lines.push(`${ref}=${toMockValue(ref)}`);
  }

  return `${lines.join("\n")}\n`;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/generate-client-mock-env.mjs --manifest <path>",
      "Options:",
      "  --out <path>   Output env file path (default: next to manifest)",
      "  --dry-run      Print output path only",
    ].join("\n"),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) {
    printUsage();
    process.exit(1);
  }

  const manifestPath = toAbsolutePath(args.manifest);
  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest path not found: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = readJson(manifestPath);
  const defaultOut = path.join(path.dirname(manifestPath), ".env.mock.example");
  const outPath = toAbsolutePath(args.out) || defaultOut;
  const template = buildEnvTemplate(manifestPath, manifest);

  if (!args.dryRun) {
    fs.writeFileSync(outPath, template, "utf8");
  }

  console.log(`${args.dryRun ? "[dry-run] " : ""}${path.relative(ROOT, outPath)}`);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printUsage();
  process.exit(0);
}

main();
