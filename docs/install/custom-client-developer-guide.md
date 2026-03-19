---
summary: "Developer-focused walkthrough of the custom client deployment workflow, contracts, and CI checks"
read_when:
  - You need to understand how payloads, manifests, presets, and deploy planning fit together
  - You are extending the fork deployment system for new channels, providers, or extensions
  - You are debugging CI failures in the client deploy contract workflow
title: "Custom Client Developer Guide"
---

# Custom Client Developer Guide

This guide explains the fork deployment system end to end.

It is designed for maintainers who need to understand exactly how the client pipeline works before changing scripts or adding integrations.

## System overview

The pipeline has four layers:

1. **Catalog + presets**
   - `config/templates/integration-catalog.json`
   - `config/templates/client-presets.json`
2. **Payload input**
   - `config/payloads/<client>/<env>.json`
3. **Generated client manifests**
   - `config/clients/<client>/<env>/manifest.json`
4. **Deploy planning/apply**
   - `scripts/client-deploy.mjs`

The design rule is simple: payloads and manifests store **secret references only**. Secret values come from runtime environment variables or env files.

## Contracts and artifacts

### Manifest schema (source of truth)

- `config/templates/client-manifest.schema.json`

Important guarantees:

- `environment` is strict enum: `dev`, `staging`, `prod`
- `secretRefs` values must look like env variable IDs
- deployment fields are constrained (`gatewayPort`, `gatewayBind`, `gatewayAuthMode`)

### Integration catalog

- Generator: `scripts/generate-client-integration-catalog.mjs`
- Output: `config/templates/integration-catalog.json`

Catalog behavior:

- Provider list = core provider IDs + extension IDs
- Channel list = core channel IDs + extension channels discovered from extension `package.json` metadata (`openclaw.channel.id`)
- Extension list = folder names under `extensions/`

### Presets

- File: `config/templates/client-presets.json`
- Current presets:
  - `starter`
  - `business-chat`
  - `max-compat`

Presets provide accessibility-first defaults for non-power-users.

### Payload format

- Importer: `scripts/import-client-payload.mjs`
- Inputs: one file or a directory under `config/payloads/`

Payload supports:

- `schemaVersion`, `clientId`, `environment`
- optional `preset`
- optional integration overrides
- optional deployment overrides
- optional `secretKeys` and `secretRefOverrides`

Importer output path is deterministic:

- `config/clients/<clientId>/<environment>/manifest.json`

### Mock env templates

- Generator: `scripts/generate-client-mock-env.mjs`
- Output: `config/clients/<client>/<env>/.env.mock.example`

This gives local fake values for each required secret ref without using real credentials.

## Validation behavior

Validator script:

- `scripts/validate-client-manifest.mjs`

Checks include:

- JSON schema validation
- gateway auth requirements (`OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD` ref)
- integration IDs against catalog

Environment-specific unknown integration policy:

- `dev`: warnings
- `staging`/`prod`: hard errors

## Deploy planning and apply

Deploy script:

- `scripts/client-deploy.mjs`

Modes:

- `--dry-run`: prints deploy plan and fails if required refs are missing
- `--apply`: runs `docker compose up -d` with manifest-derived settings

Key behavior:

- Compose project name is deterministic: `openclaw-<client>-<env>`
- Client state directories are deterministic under `~/.openclaw-clients/<client>/<env>/`
- Secret values are resolved from process env first, then `--env-file`

## Internal onboarding web app

Internal app entrypoint:

- `scripts/client-onboarding-web.mjs`

Purpose:

- operator-facing payload editor before a customer-facing portal
- writes payload files and triggers manifest + mock env regeneration

Start command:

```bash
pnpm client:onboarding:web
```

Optional token guard:

```bash
OPENCLAW_ONBOARDING_WEB_TOKEN=local-onboarding-token pnpm client:onboarding:web
```

Default URL:

- `http://127.0.0.1:18797/`

Endpoints:

- `GET /` interactive form
- `GET /api/bootstrap` catalog + presets for form hints
- `POST /api/preview` manifest preview without writing payload/manifests
- `POST /api/payload` payload write + import + mock env generation
- `GET /healthz` health check

Security posture:

- binds to loopback by default for internal-only usage
- supports optional API token guard via `OPENCLAW_ONBOARDING_WEB_TOKEN` (or `--token`)
- accepts and stores secret references only (no real secret values)

UI behavior:

- bootstrap endpoint populates known provider/channel/extension hints
- preset selection supports one-click field population
- preview mode shows resolved manifest output before file writes

## Command reference

Catalog and contract checks:

```bash
pnpm client:catalog
pnpm client:catalog:check
pnpm client:validate
pnpm client:validate:strict
```

Payload and mock flow:

```bash
pnpm client:payload:import -- --payload config/payloads/example
pnpm client:mock-env -- --manifest config/clients/example/dev/manifest.json
```

Deploy planning:

```bash
pnpm client:deploy:dry-run -- --client example --env dev --env-file config/clients/example/dev/.env.mock.example
```

Makefile wrappers:

```bash
make deploy-dry-run CLIENT=example ENV=dev ENV_FILE=config/clients/example/dev/.env.mock.example
make deploy CLIENT=example ENV=dev ENV_FILE=config/clients/example/dev/.env.mock.example
```

## CI workflow

Workflow file:

- `.github/workflows/client-deploy-contract.yml`

Main CI entry command:

- `pnpm client:check`

What it enforces:

1. catalog file is up to date
2. payload import is reproducible (`config/clients` stays unchanged)
3. strict manifest validation passes
4. deploy dry-run passes for example `dev`, `staging`, and `prod`

## How to add a new integration safely

1. Add/enable integration in payload presets or payload files
2. Regenerate catalog if extension metadata changed:
   - `pnpm client:catalog`
3. Re-import payloads:
   - `pnpm client:payload:import -- --payload config/payloads`
4. Regenerate mock env templates if needed
5. Run contract checks:
   - `pnpm client:check`

If CI fails, use the exact failing command locally and fix from top to bottom.

## Upstream sync rules for maintainers

- Keep root docs close to upstream and isolate fork behavior in custom docs pages.
- Prefer adding files under `config/`, `scripts/`, and custom docs instead of patching core runtime logic.
- Run `pnpm client:check` after each upstream rebase to catch drift early.

For operator setup and deployment intent, see [Custom Client Deploy](/install/custom-client-deploy).
