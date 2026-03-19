#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import express from "express";

const ROOT = process.cwd();
const PAYLOAD_DIR = path.join(ROOT, "config", "payloads");
const ENVIRONMENTS = new Set(["dev", "staging", "prod"]);
const PRESETS = ["starter", "business-chat", "max-compat"];
const CLIENT_ID_RE = /^[a-z][a-z0-9-]{1,62}$/;

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 18797,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--host") {
      args.host = argv[i + 1] ?? "127.0.0.1";
      i += 1;
      continue;
    }
    if (value === "--port") {
      const next = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(next) && next >= 1 && next <= 65535) {
        args.port = next;
      }
      i += 1;
      continue;
    }
  }

  return args;
}

function splitCsv(value) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function sortUnique(values) {
  return Array.from(new Set(values)).toSorted((a, b) => a.localeCompare(b));
}

function validateInput(input) {
  const errors = [];
  if (typeof input.clientId !== "string" || !CLIENT_ID_RE.test(input.clientId)) {
    errors.push("clientId must match ^[a-z][a-z0-9-]{1,62}$");
  }

  if (typeof input.environment !== "string" || !ENVIRONMENTS.has(input.environment)) {
    errors.push("environment must be one of dev|staging|prod");
  }

  if (input.preset && !PRESETS.includes(input.preset)) {
    errors.push(`preset must be one of: ${PRESETS.join(", ")}`);
  }

  return errors;
}

function toPayload(input) {
  return {
    schemaVersion: "v1",
    clientId: input.clientId,
    environment: input.environment,
    ...(input.preset ? { preset: input.preset } : {}),
    ...(input.gatewayPort
      ? {
          deployment: {
            gatewayPort: Number.parseInt(input.gatewayPort, 10),
          },
        }
      : {}),
    integrations: {
      providers: sortUnique(splitCsv(input.providers)),
      channels: sortUnique(splitCsv(input.channels)),
      extensions: sortUnique(splitCsv(input.extensions)),
    },
    ...(splitCsv(input.secretKeys).length > 0
      ? {
          secretKeys: sortUnique(splitCsv(input.secretKeys)),
        }
      : {}),
    metadata: {
      ...(typeof input.owner === "string" && input.owner.trim().length > 0
        ? { owner: input.owner.trim() }
        : {}),
      ...(typeof input.ticket === "string" && input.ticket.trim().length > 0
        ? { ticket: input.ticket.trim() }
        : {}),
    },
  };
}

function writePayload(payload) {
  const outputPath = path.join(PAYLOAD_DIR, payload.clientId, `${payload.environment}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return outputPath;
}

function runNodeScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${scriptPath} failed`);
  }
  return result.stdout.trim();
}

function importPayloadAndGenerateMockEnv(payloadPath, clientId, environment) {
  const importOutput = runNodeScript(path.join(ROOT, "scripts", "import-client-payload.mjs"), [
    "--payload",
    payloadPath,
  ]);

  const manifestPath = path.join(ROOT, "config", "clients", clientId, environment, "manifest.json");
  const mockOutput = runNodeScript(path.join(ROOT, "scripts", "generate-client-mock-env.mjs"), [
    "--manifest",
    manifestPath,
  ]);

  return { importOutput, mockOutput, manifestPath };
}

function htmlPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>OpenClaw Client Onboarding</title>
    <style>
      :root {
        --bg: #f5f7f9;
        --panel: #ffffff;
        --ink: #0f1720;
        --muted: #4b5c70;
        --line: #d6dde5;
        --accent: #0f766e;
        --accent-ink: #ffffff;
      }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--ink);
        background: linear-gradient(160deg, #ecf2f6 0%, #f9fbfc 55%, #e9f6f4 100%);
      }
      main {
        max-width: 860px;
        margin: 2rem auto;
        padding: 1rem;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 1.25rem;
        box-shadow: 0 8px 25px rgba(8, 30, 64, 0.07);
      }
      h1 {
        margin-top: 0;
        font-size: 1.5rem;
      }
      p {
        color: var(--muted);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.75rem;
      }
      label {
        display: block;
        font-size: 0.9rem;
        font-weight: 600;
        margin-bottom: 0.25rem;
      }
      input,
      select,
      textarea,
      button {
        width: 100%;
        box-sizing: border-box;
        border-radius: 10px;
        border: 1px solid var(--line);
        padding: 0.6rem 0.7rem;
        font-size: 0.95rem;
      }
      textarea {
        min-height: 88px;
        resize: vertical;
      }
      button {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--accent-ink);
        font-weight: 700;
        cursor: pointer;
      }
      #result {
        margin-top: 1rem;
        white-space: pre-wrap;
        background: #f1f5f9;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 0.75rem;
      }
      @media (max-width: 760px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="panel">
        <h1>Client Onboarding (Internal)</h1>
        <p>Stores payloads with secret references only. No real secrets are persisted here.</p>
        <form id="f">
          <div class="grid">
            <div>
              <label for="clientId">Client ID</label>
              <input id="clientId" name="clientId" placeholder="acme" required />
            </div>
            <div>
              <label for="environment">Environment</label>
              <select id="environment" name="environment">
                <option value="dev">dev</option>
                <option value="staging">staging</option>
                <option value="prod">prod</option>
              </select>
            </div>
            <div>
              <label for="preset">Preset</label>
              <select id="preset" name="preset">
                <option value="">(none)</option>
                <option value="starter">starter</option>
                <option value="business-chat">business-chat</option>
                <option value="max-compat">max-compat</option>
              </select>
            </div>
            <div>
              <label for="gatewayPort">Gateway Port (optional)</label>
              <input id="gatewayPort" name="gatewayPort" placeholder="18789" />
            </div>
          </div>
          <div class="grid">
            <div>
              <label for="providers">Providers (comma-separated)</label>
              <textarea id="providers" name="providers" placeholder="openai, anthropic"></textarea>
            </div>
            <div>
              <label for="channels">Channels (comma-separated)</label>
              <textarea id="channels" name="channels" placeholder="telegram, webchat"></textarea>
            </div>
          </div>
          <div class="grid">
            <div>
              <label for="extensions">Extensions (comma-separated)</label>
              <textarea id="extensions" name="extensions" placeholder="matrix, msteams"></textarea>
            </div>
            <div>
              <label for="secretKeys">Extra Secret Keys (optional, comma-separated)</label>
              <textarea id="secretKeys" name="secretKeys" placeholder="CUSTOM_API_KEY"></textarea>
            </div>
          </div>
          <div class="grid">
            <div>
              <label for="owner">Owner (metadata)</label>
              <input id="owner" name="owner" placeholder="platform-team" />
            </div>
            <div>
              <label for="ticket">Ticket (metadata)</label>
              <input id="ticket" name="ticket" placeholder="onboard-123" />
            </div>
          </div>
          <p></p>
          <button type="submit">Generate Payload + Manifest + Mock Env</button>
        </form>
        <div id="result"></div>
      </div>
    </main>
    <script>
      const form = document.getElementById("f");
      const result = document.getElementById("result");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        const payload = Object.fromEntries(formData.entries());
        result.textContent = "Running...";
        try {
          const response = await fetch("/api/payload", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await response.json();
          result.textContent = JSON.stringify(data, null, 2);
        } catch (error) {
          result.textContent = String(error);
        }
      });
    </script>
  </body>
</html>`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/", (_req, res) => {
    res.type("html").send(htmlPage());
  });

  app.post("/api/payload", (req, res) => {
    try {
      const input = req.body ?? {};
      const errors = validateInput(input);
      if (errors.length > 0) {
        res.status(400).json({ ok: false, errors });
        return;
      }

      const payload = toPayload(input);
      const payloadPath = writePayload(payload);
      const run = importPayloadAndGenerateMockEnv(
        payloadPath,
        payload.clientId,
        payload.environment,
      );
      const payloadRel = path.relative(ROOT, payloadPath);
      const manifestRel = path.relative(ROOT, run.manifestPath);
      const mockRel = path.join(path.dirname(manifestRel), ".env.mock.example");

      res.json({
        ok: true,
        payloadPath: payloadRel,
        manifestPath: manifestRel,
        mockEnvPath: mockRel,
        importOutput: run.importOutput,
        mockOutput: run.mockOutput,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.listen(args.port, args.host, () => {
    console.log(`Client onboarding web app listening on http://${args.host}:${args.port}`);
  });
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: node scripts/client-onboarding-web.mjs [--host 127.0.0.1] [--port 18797]");
  process.exit(0);
}

main();
