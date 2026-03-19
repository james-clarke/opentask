#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import express from "express";

const ROOT = process.cwd();
const PAYLOAD_DIR = path.join(ROOT, "config", "payloads");
const PRESETS_PATH = path.join(ROOT, "config", "templates", "client-presets.json");
const CATALOG_PATH = path.join(ROOT, "config", "templates", "integration-catalog.json");
const ENVIRONMENTS = new Set(["dev", "staging", "prod"]);
const CLIENT_ID_RE = /^[a-z][a-z0-9-]{1,62}$/;

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 18797,
    token: process.env.OPENCLAW_ONBOARDING_WEB_TOKEN?.trim() || "",
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
    if (value === "--token") {
      args.token = (argv[i + 1] ?? "").trim();
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

function normalizeCatalogEntries(entries) {
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
    .filter((value) => value.length > 0);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadBootstrapData() {
  const presetsFile = fs.existsSync(PRESETS_PATH) ? readJson(PRESETS_PATH) : { presets: {} };
  const catalogFile = fs.existsSync(CATALOG_PATH)
    ? readJson(CATALOG_PATH)
    : {
        providers: [],
        channels: [],
        extensions: [],
      };

  const presetsRecord = presetsFile.presets ?? {};
  const presetNames = sortUnique(Object.keys(presetsRecord));

  return {
    presetKeys: presetNames,
    presets: Object.fromEntries(
      presetNames.map((name) => {
        const preset = presetsRecord[name] ?? {};
        return [
          name,
          {
            deployment: preset.deployment ?? {},
            integrations: {
              providers: sortUnique(preset.integrations?.providers ?? []),
              channels: sortUnique(preset.integrations?.channels ?? []),
              extensions: sortUnique(preset.integrations?.extensions ?? []),
            },
          },
        ];
      }),
    ),
    providers: sortUnique(normalizeCatalogEntries(catalogFile.providers)),
    channels: sortUnique(normalizeCatalogEntries(catalogFile.channels)),
    extensions: sortUnique(normalizeCatalogEntries(catalogFile.extensions)),
  };
}

function validateInput(input, bootstrap) {
  const errors = [];
  if (typeof input.clientId !== "string" || !CLIENT_ID_RE.test(input.clientId)) {
    errors.push("clientId must match ^[a-z][a-z0-9-]{1,62}$");
  }

  if (typeof input.environment !== "string" || !ENVIRONMENTS.has(input.environment)) {
    errors.push("environment must be one of dev|staging|prod");
  }

  if (
    typeof input.preset === "string" &&
    input.preset.trim().length > 0 &&
    !bootstrap.presetKeys.includes(input.preset.trim())
  ) {
    errors.push(`preset must be one of: ${bootstrap.presetKeys.join(", ")}`);
  }

  return errors;
}

function toPayload(input) {
  const trimmedPreset = typeof input.preset === "string" ? input.preset.trim() : "";
  const gatewayPort = typeof input.gatewayPort === "string" ? input.gatewayPort.trim() : "";
  return {
    schemaVersion: "v1",
    clientId: input.clientId,
    environment: input.environment,
    ...(trimmedPreset ? { preset: trimmedPreset } : {}),
    ...(gatewayPort
      ? {
          deployment: {
            gatewayPort: Number.parseInt(gatewayPort, 10),
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
  const oxfmtBin = path.join(ROOT, "node_modules", ".bin", "oxfmt");
  if (fs.existsSync(oxfmtBin)) {
    const formatResult = spawnSync(oxfmtBin, ["--write", outputPath], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (formatResult.status !== 0) {
      throw new Error(`Failed to format payload file ${outputPath}`);
    }
  }
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

function resolveRequestToken(req) {
  const headerValue = req.get("authorization");
  if (typeof headerValue === "string" && headerValue.toLowerCase().startsWith("bearer ")) {
    return headerValue.slice(7).trim();
  }

  const explicit = req.get("x-onboarding-token");
  if (typeof explicit === "string") {
    return explicit.trim();
  }

  return "";
}

function ensureAuthorized(req, token) {
  if (token.length === 0) {
    return true;
  }
  return resolveRequestToken(req) === token;
}

function previewManifestFromPayload(payload) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-preview-"));
  try {
    const payloadPath = path.join(tempRoot, "payload.json");
    const outDir = path.join(tempRoot, "clients");
    fs.writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    runNodeScript(path.join(ROOT, "scripts", "import-client-payload.mjs"), [
      "--payload",
      payloadPath,
      "--out-dir",
      outDir,
    ]);

    const manifestPath = path.join(outDir, payload.clientId, payload.environment, "manifest.json");
    const manifest = readJson(manifestPath);
    return {
      manifest,
      manifestPath,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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
        --ok-bg: #e9f8ef;
        --ok-ink: #0b6b2f;
        --err-bg: #fdecec;
        --err-ink: #8d1f1f;
      }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--ink);
        background: linear-gradient(160deg, #ecf2f6 0%, #f9fbfc 55%, #e9f6f4 100%);
      }
      main {
        max-width: 920px;
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
      .grid-1 {
        display: grid;
        grid-template-columns: 1fr;
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
      .hint {
        margin-top: 0.2rem;
        color: var(--muted);
        font-size: 0.82rem;
      }
      #result {
        margin-top: 1rem;
        white-space: pre-wrap;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 0.75rem;
      }
      .ok {
        background: var(--ok-bg);
        color: var(--ok-ink);
      }
      .err {
        background: var(--err-bg);
        color: var(--err-ink);
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
              <textarea id="providers" name="providers" list="providersList" placeholder="openai, anthropic"></textarea>
              <div class="hint" id="providersHint"></div>
            </div>
            <div>
              <label for="channels">Channels (comma-separated)</label>
              <textarea id="channels" name="channels" list="channelsList" placeholder="telegram, webchat"></textarea>
              <div class="hint" id="channelsHint"></div>
            </div>
          </div>
          <div class="grid">
            <div>
              <label for="extensions">Extensions (comma-separated)</label>
              <textarea id="extensions" name="extensions" list="extensionsList" placeholder="matrix, msteams"></textarea>
              <div class="hint" id="extensionsHint"></div>
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
          <div class="grid-1">
            <div>
              <label for="apiToken">API Token (optional if server token enabled)</label>
              <input id="apiToken" name="apiToken" placeholder="onboarding token" />
            </div>
          </div>
          <p></p>
          <div class="grid">
            <div>
              <button type="button" id="applyPresetBtn">Apply Preset To Fields</button>
            </div>
            <div>
              <button type="button" id="previewBtn">Preview Manifest</button>
            </div>
          </div>
          <p></p>
          <button type="submit">Generate Payload + Manifest + Mock Env</button>
        </form>
        <datalist id="providersList"></datalist>
        <datalist id="channelsList"></datalist>
        <datalist id="extensionsList"></datalist>
        <div id="result"></div>
      </div>
    </main>
    <script>
      const form = document.getElementById("f");
      const result = document.getElementById("result");
      const presetEl = document.getElementById("preset");
      const applyPresetBtn = document.getElementById("applyPresetBtn");
      const previewBtn = document.getElementById("previewBtn");
      const providersEl = document.getElementById("providers");
      const channelsEl = document.getElementById("channels");
      const extensionsEl = document.getElementById("extensions");
      const gatewayPortEl = document.getElementById("gatewayPort");
      const tokenEl = document.getElementById("apiToken");
      const providersHint = document.getElementById("providersHint");
      const channelsHint = document.getElementById("channelsHint");
      const extensionsHint = document.getElementById("extensionsHint");
      const providersList = document.getElementById("providersList");
      const channelsList = document.getElementById("channelsList");
      const extensionsList = document.getElementById("extensionsList");
      let bootstrapData = null;

      function topItems(values) {
        return values.slice(0, 14).join(", ");
      }

      function setDataListOptions(target, values) {
        target.innerHTML = "";
        for (const value of values) {
          const option = document.createElement("option");
          option.value = value;
          target.appendChild(option);
        }
      }

      function currentAuthToken() {
        return typeof tokenEl.value === "string" ? tokenEl.value.trim() : "";
      }

      function requestHeaders() {
        const headers = { "content-type": "application/json" };
        const token = currentAuthToken();
        if (token) {
          headers["x-onboarding-token"] = token;
        }
        return headers;
      }

      function applyPresetToForm() {
        if (!bootstrapData) {
          setResult("Bootstrap data not loaded yet.", false);
          return;
        }
        const presetName = presetEl.value.trim();
        if (!presetName) {
          setResult("Select a preset first.", false);
          return;
        }

        const preset = bootstrapData.presets?.[presetName];
        if (!preset) {
          setResult("Selected preset is not available.", false);
          return;
        }

        providersEl.value = (preset.integrations?.providers || []).join(", ");
        channelsEl.value = (preset.integrations?.channels || []).join(", ");
        extensionsEl.value = (preset.integrations?.extensions || []).join(", ");
        if (!gatewayPortEl.value && preset.deployment?.gatewayPort) {
          gatewayPortEl.value = String(preset.deployment.gatewayPort);
        }
        setResult('Applied preset "' + presetName + '" to form fields.', true);
      }

      function buildPayloadFromForm() {
        const formData = new FormData(form);
        const payload = Object.fromEntries(formData.entries());
        delete payload.apiToken;
        return payload;
      }

      async function runPreview() {
        setResult("Generating preview...", true);
        try {
          const response = await fetch("/api/preview", {
            method: "POST",
            headers: requestHeaders(),
            body: JSON.stringify(buildPayloadFromForm()),
          });
          const data = await response.json();
          if (!response.ok || !data.ok) {
            setResult(JSON.stringify(data, null, 2), false);
            return;
          }
          setResult(JSON.stringify(data, null, 2), true);
        } catch (error) {
          setResult(String(error), false);
        }
      }

      async function loadBootstrap() {
        const response = await fetch("/api/bootstrap");
        const data = await response.json();
        if (!data.ok) {
          throw new Error(data.error || "Failed to load bootstrap data");
        }
        bootstrapData = data;

        for (const preset of data.presetKeys) {
          const option = document.createElement("option");
          option.value = preset;
          option.textContent = preset;
          presetEl.appendChild(option);
        }

        setDataListOptions(providersList, data.providers);
        setDataListOptions(channelsList, data.channels);
        setDataListOptions(extensionsList, data.extensions);

        providersHint.textContent = data.providers.length
          ? "Known providers: " + topItems(data.providers)
          : "Known providers: none";
        channelsHint.textContent = data.channels.length
          ? "Known channels: " + topItems(data.channels)
          : "Known channels: none";
        extensionsHint.textContent = data.extensions.length
          ? "Known extensions: " + topItems(data.extensions)
          : "Known extensions: none";
        if (data.authRequired) {
          setResult("Server token guard is enabled. Enter API Token before submit/preview.", true);
        }
      }

      function setResult(content, ok) {
        result.textContent = content;
        result.className = ok ? "ok" : "err";
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        setResult("Running...", true);
        try {
          const response = await fetch("/api/payload", {
            method: "POST",
            headers: requestHeaders(),
            body: JSON.stringify(buildPayloadFromForm()),
          });

          const data = await response.json();
          if (!response.ok || !data.ok) {
            setResult(JSON.stringify(data, null, 2), false);
            return;
          }
          setResult(JSON.stringify(data, null, 2), true);
        } catch (error) {
          setResult(String(error), false);
        }
      });

      applyPresetBtn.addEventListener("click", applyPresetToForm);
      previewBtn.addEventListener("click", runPreview);

      loadBootstrap().catch((error) => {
        setResult(String(error), false);
      });
    </script>
  </body>
</html>`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const app = express();
  const bootstrap = loadBootstrapData();

  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/", (_req, res) => {
    res.type("html").send(htmlPage());
  });

  app.get("/api/bootstrap", (_req, res) => {
    res.json({
      ok: true,
      authRequired: args.token.length > 0,
      ...bootstrap,
    });
  });

  app.post("/api/preview", (req, res) => {
    try {
      if (!ensureAuthorized(req, args.token)) {
        res.status(401).json({ ok: false, error: "Unauthorized (invalid onboarding token)." });
        return;
      }

      const input = req.body ?? {};
      const errors = validateInput(input, bootstrap);
      if (errors.length > 0) {
        res.status(400).json({ ok: false, errors });
        return;
      }

      const payload = toPayload(input);
      const preview = previewManifestFromPayload(payload);

      res.json({
        ok: true,
        payload,
        manifest: preview.manifest,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/payload", (req, res) => {
    try {
      if (!ensureAuthorized(req, args.token)) {
        res.status(401).json({ ok: false, error: "Unauthorized (invalid onboarding token)." });
        return;
      }

      const input = req.body ?? {};
      const errors = validateInput(input, bootstrap);
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
    if (args.token.length > 0) {
      console.log("Onboarding API token guard: enabled");
    }
  });
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node scripts/client-onboarding-web.mjs [--host 127.0.0.1] [--port 18797] [--token <value>]",
  );
  process.exit(0);
}

main();
