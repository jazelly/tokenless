#!/usr/bin/env bash
set -euo pipefail

readonly PACKAGE_NAME="tokenless"
readonly PACKAGE_VERSION="${TOKENLESS_VERSION:-latest}"

fail() {
  printf 'Tokenless API install failed / 安装失败: %s\n' "$*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail 'Node.js 22.13+ is required / 需要 Node.js 22.13+。'
command -v npm >/dev/null 2>&1 || fail 'npm is required / 需要 npm。'
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)' \
  || fail "Node.js 22.13+ is required / 需要 Node.js 22.13+；found / 当前版本: $(node --version)"

printf 'Installing / 正在安装 %s@%s...\n' "$PACKAGE_NAME" "$PACKAGE_VERSION"
npm install --global "${PACKAGE_NAME}@${PACKAGE_VERSION}"

if [[ "$(id -u)" -eq 0 ]]; then
  cat <<'EOF'

Tokenless API CLI is installed system-wide. Run setup from your normal desktop account.
Tokenless API CLI 已安装到系统。请返回普通桌面用户账户运行 setup。

  tokenless skills sync --json
  uv --version
  tokenless setup
  tokenless doctor --json

Setup requires uv and your selected browser. Sign in and approve browser prompts yourself.
Setup 需要 uv 和你选择的浏览器。请自行登录并批准浏览器提示。
EOF
  exit 0
fi

tokenless_bin="$(command -v tokenless || true)"
if [[ -z "$tokenless_bin" ]]; then
  global_prefix="$(npm prefix --global)"
  tokenless_bin="${global_prefix}/bin/tokenless"
fi
[[ -x "$tokenless_bin" ]] || fail "Add npm's global bin directory to PATH / 请将 npm 全局 bin 目录加入 PATH。"

"$tokenless_bin" skills sync --json
command -v uv >/dev/null 2>&1 || fail 'CLI and skills installed; setup requires uv. Install uv, then run tokenless setup / CLI 与 skills 已安装；setup 需要 uv。安装 uv 后运行 tokenless setup。'

cat <<'EOF'

Tokenless API CLI and matching skills are installed. Setup now uses the default browser
and creates or reuses the default logical profile, prepares G4F, and checks providers.
Tokenless API CLI 与配套 skills 已安装。Setup 将使用默认浏览器，创建或复用默认逻辑
profile，准备 G4F 并检查 provider。

Complete sign-in, CAPTCHA, consent, and browser connection prompts yourself.
请自行完成登录、验证码、授权与浏览器连接提示。

This CLI installer does not install the optional macOS menu app.
此 CLI 安装器不安装可选的 macOS 菜单栏 App。
EOF

"$tokenless_bin" setup --defaults --json
"$tokenless_bin" doctor --json
