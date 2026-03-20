---
summary: "Phase-by-phase implementation roadmap for customer onboarding automation, verification, and maintainability"
read_when:
  - You want the next implementation backlog in execution order
  - You need a test strategy that avoids spinning up new servers per change
  - You are planning customer-facing onboarding and connection verification milestones
title: "Custom Client Phase Roadmap"
---

# Custom Client Phase Roadmap

This roadmap prioritizes a customer-friendly onboarding experience while keeping internals robust and maintainable for operators.

## Current completed phases

1. Contract foundations (manifest schema + validation)
2. Integration catalog + presets
3. Payload import + mock env generation
4. Deploy dry-run/apply flow
5. Contract CI gate
6. Internal onboarding web app

## Phase 7 (now): verification-first onboarding automation

Primary objective:

- add a robust verification path so operators can validate onboarding outcomes without repeatedly provisioning new servers

Backlog:

1. Add local verification command (`client:verify`) for secret refs + provider readiness checks
2. Add optional local gateway health probe from the manifest port
3. Add Makefile wrapper (`make client-verify CLIENT=<id> ENV=<env>`)
4. Wire verification into onboarding docs and operator flow

Validation strategy:

- contract checks: `pnpm client:check` (no new server needed)
- local verify checks: `pnpm client:verify -- --client <id> --env <env> --env-file <path>`
- optional gateway probe when a local stack is already running: `--check-gateway`

## Phase 8: staged simulation and teardown workflow

Primary objective:

- allow repeatable local smoke runs against one machine using isolated per-client compose projects

Backlog:

1. Add `client:simulate` command:
   - apply deploy
   - run verify
   - optional teardown
2. Add profile-based simulation presets (`quick`, `full`)
3. Add report output (JSON + plain text summary)

## Phase 9: model and channel connection probes

Primary objective:

- verify model/channel setup quality before exposing to customers

Backlog:

1. Add provider probe adapters (OpenAI, Anthropic, OpenRouter first)
2. Add channel readiness checks (configured vs reachable/authenticated)
3. Publish pass/fail matrix in verification output

## Phase 10: customer-facing onboarding surface

Primary objective:

- move from internal operator UI to controlled customer self-service

Backlog:

1. Add auth and audit requirements for customer-facing mode
2. Expose a constrained onboarding form using presets and guided defaults
3. Keep internals private (manifests, secret refs, deploy internals)

## Phase 11: productized skills/actions/commands

Primary objective:

- ship a user-friendly product layer while preserving maintainability

Backlog:

1. Package curated skill bundles per customer segment
2. Add safe default action sets
3. Add command templates with guardrails and docs
4. Add contract tests for skills/actions configuration drift

## Maintenance guardrails

- keep root `README.md` close to upstream
- keep fork-specific ops in `config/`, `scripts/`, and custom docs pages
- run `pnpm client:check` on every onboarding/deploy change
- run `pnpm check` before landing to `main`

For implementation details and commands, see [Custom Client Developer Guide](/install/custom-client-developer-guide).
