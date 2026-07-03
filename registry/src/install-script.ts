export const installScript = `#!/usr/bin/env bash

set -euo pipefail

fail() {
  printf 'overlearn install: %s\\n' "$1" >&2
  exit 1
}

warn() {
  printf 'overlearn install: %s\\n' "$1" >&2
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "$1 is required to install Overlearn."
  fi
}

detect_asset() {
  os_name=$(uname -s 2>/dev/null || true)
  arch_name=$(uname -m 2>/dev/null || true)

  case "$os_name" in
    Linux)
      os="linux"
      ;;
    Darwin)
      os="darwin"
      ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      fail "Windows is not supported by this installer. Use WSL, then run this installer inside Linux."
      ;;
    *)
      fail "unsupported operating system: $os_name"
      ;;
  esac

  case "$arch_name" in
    x86_64 | amd64)
      arch="x64"
      ;;
    arm64 | aarch64)
      arch="arm64"
      ;;
    *)
      fail "unsupported CPU architecture: $arch_name"
      ;;
  esac

  printf 'learn-%s-%s\\n' "$os" "$arch"
}

release_path() {
  if [ -z "\${OVERLEARN_VERSION:-}" ]; then
    printf 'latest/download\\n'
    return
  fi

  case "\${OVERLEARN_VERSION}" in
    v*)
      printf 'download/%s\\n' "\${OVERLEARN_VERSION}"
      ;;
    *)
      printf 'download/v%s\\n' "\${OVERLEARN_VERSION}"
      ;;
  esac
}

install_dir() {
  if [ -n "\${OVERLEARN_INSTALL_DIR:-}" ]; then
    printf '%s\\n' "\${OVERLEARN_INSTALL_DIR}"
    return
  fi

  if [ -z "\${HOME:-}" ]; then
    fail "HOME is not set; set OVERLEARN_INSTALL_DIR to choose an install directory."
  fi

  printf '%s/.local/bin\\n' "\${HOME}"
}

print_path_hint() {
  dir="$1"

  case ":\${PATH:-}:" in
    *":$dir:"*)
      return
      ;;
  esac

  shell_name=$(basename "\${SHELL:-sh}")
  if [ -n "\${HOME:-}" ]; then
    case "$shell_name" in
      zsh)
        profile="\${HOME}/.zshrc"
        ;;
      bash)
        profile="\${HOME}/.bashrc"
        ;;
      fish)
        printf '\\nPATH hint:\\n  %s is not on PATH. Add this to %s/.config/fish/config.fish:\\n    fish_add_path %s\\n' "$dir" "\${HOME}" "$dir"
        return
        ;;
      *)
        profile="\${HOME}/.profile"
        ;;
    esac
  else
    profile="your shell profile"
  fi

  printf '\\nPATH hint:\\n  %s is not on PATH. Add this to %s:\\n    export PATH="%s:\\044PATH"\\n' "$dir" "$profile" "$dir"
}

print_manual_plugin_install() {
  cat <<'MANUAL_PLUGIN'

Manual Claude Code plugin install:
  claude plugin marketplace add OverseedAI/overlearn
  claude plugin install overlearn@overlearn
MANUAL_PLUGIN
}

run_claude_command() {
  description="$1"
  shift

  if output=$("$@" 2>&1); then
    printf 'Claude Code: %s.\\n' "$description"
    return 0
  fi

  case "$output" in
    *already* | *Already*)
      printf 'Claude Code: %s already done.\\n' "$description"
      return 0
      ;;
  esac

  warn "Claude Code \${description} failed; continuing."
  if [ -n "$output" ]; then
    while IFS= read -r line; do
      printf '  %s\\n' "$line" >&2
    done <<< "$output"
  fi
  return 1
}

install_claude_plugin() {
  if ! command -v claude >/dev/null 2>&1; then
    warn "Claude Code CLI not found; skipping plugin install."
    print_manual_plugin_install
    return
  fi

  run_claude_command "marketplace registered" claude plugin marketplace add OverseedAI/overlearn || true
  if ! run_claude_command "plugin installed" claude plugin install overlearn@overlearn; then
    print_manual_plugin_install
  fi
}

require_command curl
require_command uname
require_command mktemp

asset=$(detect_asset)
target_dir=$(install_dir)
download_base="\${OVERLEARN_DL_BASE:-https://github.com/OverseedAI/overlearn/releases}"
download_url="\${download_base%/}/$(release_path)/$asset"

tmp_dir=$(mktemp -d "\${TMPDIR:-/tmp}/overlearn-install.XXXXXX")
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT HUP INT TERM

tmp_file="$tmp_dir/learn"

printf 'Downloading %s\\n' "$download_url"
curl -fL --retry 2 --connect-timeout 15 --output "$tmp_file" "$download_url"

mkdir -p "$target_dir"
chmod 0755 "$tmp_file"
mv "$tmp_file" "$target_dir/learn"
chmod 0755 "$target_dir/learn"

printf 'Installed learn to %s/learn\\n' "$target_dir"
print_path_hint "$target_dir"

install_claude_plugin

cat <<'QUICKSTART'

Quickstart:
  learn start my-course
  /learn in Claude Code
QUICKSTART
`;
