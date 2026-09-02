#!/bin/bash
# Makes `playwright-cli` usable in every session.
# Remote containers are ephemeral, so the global npm install and the generated
# browser config have to be recreated each time a session starts.
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CONFIG="$PROJECT_DIR/.playwright/cli.config.json"

if ! command -v playwright-cli >/dev/null 2>&1; then
  npm install -g @playwright/cli@latest
fi

mkdir -p "$PROJECT_DIR/.playwright"

# Browser downloads are blocked by the remote network policy, but the container
# ships a Chromium at /opt/pw-browsers. Point the CLI at it, and drop the
# sandbox when running as root (Chromium refuses to start otherwise).
opts=()
[ -x /opt/pw-browsers/chromium ] && opts+=('"executablePath": "/opt/pw-browsers/chromium"')
[ "$(id -u)" = "0" ] && opts+=('"chromiumSandbox": false')

if [ ${#opts[@]} -eq 0 ]; then
  # Local machines use Playwright's own browser resolution.
  [ -f "$CONFIG" ] || printf '{}\n' > "$CONFIG"
  exit 0
fi

joined=$(printf ',\n      %s' "${opts[@]}")
printf '{\n  "browser": {\n    "launchOptions": {\n      %s\n    }\n  }\n}\n' "${joined:8}" > "$CONFIG"
