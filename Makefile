SHELL := /usr/bin/env bash

CLIENT ?=
ENV ?=
PAYLOAD ?=config/payloads
MANIFEST ?=
ENV_FILE ?=
PROFILE ?=quick
TEARDOWN ?=0
REBUILD ?=0
KEEP_RUNNING ?=0

.PHONY: client-catalog client-catalog-check client-validate client-validate-strict client-import client-mock-env client-verify client-simulate client-host-check client-local-e2e deploy-dry-run deploy

define require_client_env
	@if [[ -z "$(CLIENT)" || -z "$(ENV)" ]]; then \
		echo "ERROR: CLIENT and ENV are required (example: make deploy-dry-run CLIENT=acme ENV=staging)"; \
		exit 1; \
	fi
endef

client-catalog:
	pnpm client:catalog

client-catalog-check:
	pnpm client:catalog:check

client-validate:
	pnpm client:validate

client-validate-strict:
	pnpm client:validate:strict

client-import:
	pnpm client:payload:import -- --payload "$(PAYLOAD)"

client-mock-env:
	@if [[ -z "$(MANIFEST)" ]]; then \
		echo "ERROR: MANIFEST is required (example: make client-mock-env MANIFEST=config/clients/example/dev/manifest.json)"; \
		exit 1; \
	fi
	pnpm client:mock-env -- --manifest "$(MANIFEST)"

client-verify:
	$(require_client_env)
	@if [[ -n "$(ENV_FILE)" ]]; then \
		pnpm client:verify -- --client "$(CLIENT)" --env "$(ENV)" --env-file "$(ENV_FILE)"; \
	else \
		pnpm client:verify -- --client "$(CLIENT)" --env "$(ENV)"; \
	fi

client-host-check:
	bash scripts/client-host-check.sh

client-simulate:
	$(require_client_env)
	@if [[ -n "$(ENV_FILE)" ]]; then \
		EXTRA_ENV_FILE="--env-file $(ENV_FILE)"; \
	else \
		EXTRA_ENV_FILE=""; \
	fi; \
	if [[ "$(TEARDOWN)" == "1" ]]; then \
		EXTRA_TEARDOWN="--teardown"; \
	else \
		EXTRA_TEARDOWN=""; \
	fi; \
	pnpm client:simulate -- --client "$(CLIENT)" --env "$(ENV)" --profile "$(PROFILE)" $$EXTRA_ENV_FILE $$EXTRA_TEARDOWN

client-local-e2e:
	$(require_client_env)
	@if [[ -n "$(ENV_FILE)" ]]; then \
		EXTRA_ENV_FILE="--env-file $(ENV_FILE)"; \
	else \
		EXTRA_ENV_FILE=""; \
	fi; \
	if [[ "$(REBUILD)" == "1" ]]; then \
		EXTRA_REBUILD="--rebuild"; \
	else \
		EXTRA_REBUILD=""; \
	fi; \
	if [[ "$(KEEP_RUNNING)" == "1" ]]; then \
		EXTRA_KEEP="--keep-running"; \
	else \
		EXTRA_KEEP=""; \
	fi; \
	pnpm client:onboarding:local-e2e -- --client "$(CLIENT)" --env "$(ENV)" $$EXTRA_ENV_FILE $$EXTRA_REBUILD $$EXTRA_KEEP

deploy-dry-run:
	$(require_client_env)
	@if [[ -n "$(ENV_FILE)" ]]; then \
		pnpm client:deploy:dry-run -- --client "$(CLIENT)" --env "$(ENV)" --env-file "$(ENV_FILE)"; \
	else \
		pnpm client:deploy:dry-run -- --client "$(CLIENT)" --env "$(ENV)"; \
	fi

deploy:
	$(require_client_env)
	@if [[ -n "$(ENV_FILE)" ]]; then \
		pnpm client:deploy -- --client "$(CLIENT)" --env "$(ENV)" --env-file "$(ENV_FILE)"; \
	else \
		pnpm client:deploy -- --client "$(CLIENT)" --env "$(ENV)"; \
	fi
