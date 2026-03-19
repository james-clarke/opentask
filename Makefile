SHELL := /usr/bin/env bash

CLIENT ?=
ENV ?=
PAYLOAD ?=config/payloads
MANIFEST ?=
ENV_FILE ?=

.PHONY: client-catalog client-catalog-check client-validate client-validate-strict client-import client-mock-env deploy-dry-run deploy

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
