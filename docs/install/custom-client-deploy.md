---
summary: "Fork operator guide for custom client deployments while staying close to upstream OpenClaw"
read_when:
  - You maintain a fork that deploys OpenClaw for multiple clients
  - You need repeatable onboarding inputs without a production web UI yet
  - You want a low-friction upstream sync workflow
title: "Custom Client Deploy"
---

# Custom Client Deploy

This guide is for fork operators building client-specific OpenClaw deployments.
It prioritizes two goals:

1. keep upstream merges predictable and low-conflict
2. make client onboarding/deploy flows deterministic before a full portal exists

For detailed maintainer internals (payload contract, scripts, CI, and troubleshooting), see [Custom Client Developer Guide](/install/custom-client-developer-guide).
For the execution-order backlog, see [Custom Client Phase Roadmap](/install/custom-client-phase-roadmap).

## Keep fork divergence small

Prefer adding fork-specific logic in dedicated deployment surfaces instead of editing core runtime paths.

Suggested fork-owned paths:

- `scripts/deploy/`
- `config/templates/`
- `config/clients/`
- `docs/install/custom-client-deploy`

Treat broad edits under `src/` as last resort.

## Upstream sync workflow

### One-time setup

```bash
git remote add upstream https://github.com/openclaw/openclaw.git
git fetch upstream
```

### Recommended cadence

- Sync from upstream at least weekly.
- Sync before starting any major fork feature.
- Sync again before opening a large deployment PR.

### Safe sync steps

```bash
git fetch upstream origin
git checkout main
git rebase upstream/main
pnpm install
pnpm check
pnpm test -- src/commands/onboard-non-interactive.gateway.test.ts
```

Then push your rebased fork main:

```bash
git push origin main
```

If your branch policy requires merge commits, replace rebase with merge, but keep the same validation gates.

## Conflict prevention rules

- Keep root `README.md` close to upstream.
- Prefer new docs pages over rewriting upstream docs pages.
- Avoid changing shared onboarding internals unless required.
- When you must patch core behavior, isolate it behind small wrappers and keep tests focused.

## Onboarding without a web UI (now)

Before building a subscriber-facing portal, use a payload + template pipeline.

### 1) Use the manifest contract (Phase 1)

Phase 1 contract artifacts:

- Schema: `config/templates/client-manifest.schema.json`
- Template: `config/templates/client-manifest.example.json`
- Example manifest: `config/clients/example/dev/manifest.json`

Environment is a strict enum: `dev`, `staging`, `prod`.

Use JSON with non-secret fields plus secret reference IDs.

```json
{
  "clientId": "acme",
  "environment": "prod",
  "schemaVersion": "v1",
  "deployment": {
    "gatewayBind": "loopback",
    "gatewayPort": 18789,
    "gatewayAuthMode": "token"
  },
  "integrations": {
    "providers": ["openai"],
    "channels": ["telegram", "webchat"],
    "extensions": ["discord", "matrix"]
  },
  "secretRefs": {
    "OPENAI_API_KEY": "OPENAI_API_KEY_ACME_PROD",
    "OPENCLAW_GATEWAY_TOKEN": "OPENCLAW_GATEWAY_TOKEN_ACME_PROD"
  }
}
```

Validate all manifests:

```bash
pnpm client:validate
```

Strict mode (warnings fail CI):

```bash
pnpm client:validate:strict
```

Phase 2 catalog/preset assets:

- `config/templates/integration-catalog.json`
- `config/templates/client-presets.json`

Regenerate and verify the integration catalog:

```bash
pnpm client:catalog
pnpm client:catalog:check
```

Preset keys for non-power-user accessibility:

- `starter`
- `business-chat`
- `max-compat`

Phase 3 mock onboarding artifacts:

- Payloads: `config/payloads/example/*.json`
- Generated manifests: `config/clients/<client>/<env>/manifest.json`
- Generated mock env templates: `config/clients/<client>/<env>/.env.mock.example`

Generate manifests from payload files:

```bash
pnpm client:payload:import -- --payload config/payloads/example
```

Generate a mock env template from one manifest:

```bash
pnpm client:mock-env -- --manifest config/clients/example/dev/manifest.json
```

Phase 4 deploy workflow (deterministic CLI + Makefile):

- Deploy planner/apply script: `scripts/client-deploy.mjs`
- Makefile targets: `deploy-dry-run`, `deploy`

Plan deployment without starting containers:

```bash
make deploy-dry-run CLIENT=example ENV=staging
```

Use mock env refs when needed:

```bash
make deploy-dry-run CLIENT=example ENV=staging ENV_FILE=config/clients/example/staging/.env.mock.example
```

Apply deployment (idempotent compose up):

```bash
make deploy CLIENT=example ENV=staging
```

If secret refs are not already exported in shell env, provide an env file:

```bash
node scripts/client-deploy.mjs --client example --env staging --env-file config/clients/example/staging/.env.mock.example --dry-run
```

Phase 6 internal onboarding web app (operator-only):

- Script: `scripts/client-onboarding-web.mjs`
- NPM command: `pnpm client:onboarding:web`
- Default bind: `127.0.0.1:18797`
- Optional API token guard: `OPENCLAW_ONBOARDING_WEB_TOKEN=<token>`

Start the app:

```bash
pnpm client:onboarding:web
```

Then open:

- `http://127.0.0.1:18797/`

Optional token-protected mode:

```bash
OPENCLAW_ONBOARDING_WEB_TOKEN=local-onboarding-token pnpm client:onboarding:web
```

When token mode is enabled, include the same token in the UI "API Token" field before submitting.

Each submit writes payloads and regenerates:

- `config/payloads/<client>/<env>.json`
- `config/clients/<client>/<env>/manifest.json`
- `config/clients/<client>/<env>/.env.mock.example`

Preview mode before writing files:

- Use the `Preview Manifest` button in the UI to call `POST /api/preview`
- This validates inputs and shows the generated manifest without updating payload/manifests on disk

Phase 7 verification command:

- Script: `scripts/client-verify.mjs`
- NPM command: `pnpm client:verify -- --client <id> --env <env>`
- Makefile command: `make client-verify CLIENT=<id> ENV=<env>`

Verify with env refs + optional local gateway health probe:

```bash
pnpm client:verify -- --client example --env dev --env-file config/clients/example/dev/.env.mock.example
pnpm client:verify -- --client example --env dev --env-file config/clients/example/dev/.env.mock.example --check-gateway
```

Validation behavior for unknown integrations:

- `dev`: unknown provider/channel/extension values warn
- `staging` and `prod`: unknown provider/channel/extension values fail validation

### 2) Use mock secret refs for development

For local testing, use fake values only:

- `OPENAI_API_KEY_ACME_PROD=mock-openai-key`
- `OPENCLAW_GATEWAY_TOKEN_ACME_PROD=mock-gateway-token`

Do not commit real values. Commit only templates and sample placeholders.

You can source generated mock values locally without running gateway setup:

```bash
set -a
source config/clients/example/dev/.env.mock.example
set +a
```

### 3) Reuse non-interactive onboarding

Drive setup from scripts using existing CLI contracts:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN_ACME_PROD \
  --accept-risk \
  --json
```

This keeps your mock flow and future production flow aligned.

## Should you build a simple onboarding web app now?

Yes, but keep it thin and internal first.

### Recommended rollout

- **Phase 0 (now):** CLI/script pipeline with payload files and mock refs
- **Phase 1:** internal operator web form that writes the same payload contract
- **Phase 2:** customer-facing portal only after auth, audit, and secret lifecycle policies are finalized

### Requirements for a thin internal app

- Validate payloads before writing any config
- Store secret references only in generated config
- Send real secret values to your secret backend, not git
- Keep an audit trail of who changed client onboarding data

## Pre-build checklist

- Upstream sync completed and rebased cleanly
- `pnpm check` passes
- A scoped onboarding validation test passes
- Client payload schema version pinned
- No plaintext secrets in repo files or logs
