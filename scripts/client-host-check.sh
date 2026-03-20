#!/usr/bin/env bash
set -euo pipefail

missing=0

check_cmd() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "MISSING: $cmd"
    echo "  hint: $hint"
    missing=1
  else
    echo "OK: $cmd ($(command -v "$cmd"))"
  fi
}

check_cmd node "Install Node 22.16+ or Node 24 (recommended)."
check_cmd pnpm "Run: corepack enable && corepack pnpm --version"
check_cmd docker "Install Docker Engine/Desktop, then ensure daemon is running."

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    echo "OK: docker compose"
  else
    echo "MISSING: docker compose"
    echo "  hint: Install Docker Compose v2 plugin (docker compose)."
    missing=1
  fi

  if docker info >/dev/null 2>&1; then
    echo "OK: docker daemon access"
  else
    echo "MISSING: docker daemon access"
    echo "  hint: Ensure Docker daemon is running and your user can access /var/run/docker.sock."
    echo "  hint: On Linux, add your user to docker group: sudo usermod -aG docker \$USER, then re-login."
    missing=1
  fi
fi

if [[ "$missing" -ne 0 ]]; then
  echo
  echo "Host dependency check failed."
  echo "For Docker-based setup on Linux, see docs/install/docker.md and docker-setup.sh."
  exit 1
fi

echo
echo "Host dependency check passed."
