#!/usr/bin/env bash
set -euo pipefail

readonly PACKAGE_NAME="tokenless"
readonly PACKAGE_VERSION="${TOKENLESS_VERSION:-latest}"

fail() {
  printf 'Tokenless install failed: %s\n' "$*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail 'Node.js 22 or newer is required.'
command -v npm >/dev/null 2>&1 || fail 'npm is required with Node.js 22 or newer.'

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" =~ ^[0-9]+$ ]] || fail 'Could not determine the Node.js version.'
(( node_major >= 22 )) || fail "Node.js 22 or newer is required; found $(node --version)."

printf 'Installing %s@%s...\n' "$PACKAGE_NAME" "$PACKAGE_VERSION"
npm install --global "${PACKAGE_NAME}@${PACKAGE_VERSION}"

if [[ "$(id -u)" -eq 0 ]]; then
  cat <<'EOF'

Tokenless CLI is installed system-wide.

For security and correct browser-profile binding, do not run setup as root. Return to
your normal desktop account, install and enable the Tokenless browser extension, then run:

  tokenless setup --json
  tokenless doctor --json

EOF
  exit 0
fi

tokenless_bin="$(command -v tokenless || true)"
if [[ -z "$tokenless_bin" ]]; then
  global_prefix="$(npm prefix --global)"
  tokenless_bin="${global_prefix}/bin/tokenless"
fi
[[ -x "$tokenless_bin" ]] || fail "npm completed, but the tokenless executable is not on PATH. Add npm's global bin directory to PATH, then run tokenless setup --json."

cat <<'EOF'

Tokenless CLI is installed.

Install and enable the Tokenless browser extension before continuing. This script will
now open the provider page and verify the browser bridge; complete any visible sign-in
or permission prompt yourself.

EOF

"$tokenless_bin" setup --json
"$tokenless_bin" doctor --json
