#!/bin/bash
set -euo pipefail

# ─────────────────────────────────────────────
#  Telegram Control — Raspberry Pi Installer
#  Idempotent: skips steps already completed.
#  Re-run freely after a partial install.
# ─────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

STEPS_TOTAL=9
STEP=0
ERRORS=()

info()    { echo -e "${CYAN}[${STEP}/${STEPS_TOTAL}]${RESET} $*"; }
success() { echo -e "  ${GREEN}✓${RESET} $*"; }
skip()    { echo -e "  ${YELLOW}↷${RESET} $* (already done)"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
fail()    { echo -e "  ${RED}✗${RESET} $*"; ERRORS+=("$*"); }

next_step() {
  STEP=$((STEP + 1))
  echo ""
  info "${BOLD}$*${RESET}"
}

# ── Trap unexpected errors ──────────────────
on_error() {
  local line=$1
  echo ""
  echo -e "${RED}${BOLD}Unexpected error on line ${line}.${RESET}"
  echo -e "Run with ${CYAN}bash -x $0${RESET} for a full trace."
  exit 1
}
trap 'on_error $LINENO' ERR

# ── Must run from project root ──────────────
if [ ! -f "package.json" ]; then
  echo -e "${RED}Error:${RESET} Run this script from the telegram-control project root."
  exit 1
fi

echo ""
echo -e "${BOLD}=== Telegram Control — Raspberry Pi Install ===${RESET}"
echo ""


# ────────────────────────────────────────────
next_step "System packages update"
# ────────────────────────────────────────────
if sudo apt-get update -qq && sudo apt-get upgrade -y -qq; then
  success "System updated"
else
  fail "apt-get update/upgrade failed"
fi


# ────────────────────────────────────────────
next_step "Build tools (build-essential, python3, git, curl)"
# ────────────────────────────────────────────
MISSING_PKGS=()
for pkg in build-essential python3 git curl; do
  dpkg -s "$pkg" &>/dev/null || MISSING_PKGS+=("$pkg")
done

if [ ${#MISSING_PKGS[@]} -eq 0 ]; then
  skip "All build tools already installed"
else
  if sudo apt-get install -y -qq "${MISSING_PKGS[@]}"; then
    success "Installed: ${MISSING_PKGS[*]}"
  else
    fail "Failed to install: ${MISSING_PKGS[*]}"
  fi
fi


# ────────────────────────────────────────────
next_step "Node.js 22"
# ────────────────────────────────────────────
CURRENT_NODE=$(node --version 2>/dev/null || echo "none")
NODE_MAJOR=$(echo "$CURRENT_NODE" | sed 's/v\([0-9]*\).*/\1/')

if [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null; then
  skip "Node.js $CURRENT_NODE already installed"
elif [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
  warn "Node.js $CURRENT_NODE found (≥18, compatible). Skipping upgrade to 22."
else
  if curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && \
     sudo apt-get install -y -qq nodejs; then
    success "Node.js $(node --version) installed"
  else
    fail "Node.js installation failed"
  fi
fi


# ────────────────────────────────────────────
next_step "npm global directory (~/.npm-global)"
# ────────────────────────────────────────────
if [ "$(npm config get prefix)" = "$HOME/.npm-global" ]; then
  skip "npm global prefix already set to ~/.npm-global"
else
  mkdir -p ~/.npm-global
  npm config set prefix '~/.npm-global'
  success "npm global dir set to ~/.npm-global"
fi

export PATH="$HOME/.npm-global/bin:$PATH"

for rc_file in ~/.bashrc ~/.profile; do
  if [ -f "$rc_file" ] && grep -q 'npm-global' "$rc_file" 2>/dev/null; then
    : # already present
  else
    echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$rc_file"
    success "Added ~/.npm-global/bin to PATH in $rc_file"
  fi
done


# ────────────────────────────────────────────
next_step "Claude Code CLI"
# ────────────────────────────────────────────
if command -v claude &>/dev/null; then
  skip "Claude CLI already installed ($(claude --version 2>/dev/null | head -1))"
else
  warn "Downloading from storage.googleapis.com — if this fails with 429, wait a few minutes and re-run."
  if curl -fsSL https://claude.ai/install.sh | bash; then
    success "Claude CLI installed"
  else
    fail "Claude CLI installation failed (try again in a few minutes)"
  fi
fi


# ────────────────────────────────────────────
next_step "gh CLI (GitHub)"
# ────────────────────────────────────────────
if command -v gh &>/dev/null; then
  skip "gh CLI already installed ($(gh --version | head -1))"
else
  KEYRING=/usr/share/keyrings/githubcli-archive-keyring.gpg
  LIST=/etc/apt/sources.list.d/github-cli.list

  if curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | sudo dd of="$KEYRING" status=none && \
     echo "deb [arch=$(dpkg --print-architecture) signed-by=${KEYRING}] https://cli.github.com/packages stable main" \
       | sudo tee "$LIST" > /dev/null && \
     sudo apt-get update -qq && \
     sudo apt-get install -y -qq gh; then
    success "gh CLI installed ($(gh --version | head -1))"
  else
    fail "gh CLI installation failed"
  fi
fi


# ────────────────────────────────────────────
next_step "Vercel CLI"
# ────────────────────────────────────────────
if command -v vercel &>/dev/null; then
  skip "Vercel CLI already installed ($(vercel --version 2>/dev/null))"
else
  if npm install -g vercel --silent; then
    success "Vercel CLI installed ($(vercel --version 2>/dev/null))"
  else
    fail "Vercel CLI installation failed"
  fi
fi


# ────────────────────────────────────────────
next_step "npm dependencies + TypeScript build"
# ────────────────────────────────────────────
if npm install --silent; then
  success "npm install done"
else
  fail "npm install failed"
fi

if npm run build; then
  success "TypeScript build done"
else
  fail "TypeScript build failed"
fi


# ────────────────────────────────────────────
next_step ".env setup"
# ────────────────────────────────────────────
if [ -f .env ]; then
  skip ".env already exists"
else
  if [ -f .env.example ]; then
    cp .env.example .env
    success ".env created from .env.example"
  else
    fail ".env.example not found — create .env manually"
  fi
fi


# ─────────────────────────────────────────────
#  Summary
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}═══════════════════════════════════════${RESET}"

if [ ${#ERRORS[@]} -gt 0 ]; then
  echo -e "${RED}${BOLD}Installation finished with errors:${RESET}"
  for err in "${ERRORS[@]}"; do
    echo -e "  ${RED}✗${RESET} $err"
  done
  echo ""
  echo -e "Fix the issues above and re-run: ${CYAN}bash scripts/install-raspberry.sh${RESET}"
  exit 1
else
  echo -e "${GREEN}${BOLD}Installation complete ✓${RESET}"
fi

echo ""
echo -e "${BOLD}Next steps:${RESET}"

if ! claude --version &>/dev/null 2>&1 || ! claude whoami &>/dev/null 2>&1; then
  echo -e "  ${YELLOW}1.${RESET} claude login"
else
  echo -e "  ${GREEN}1.${RESET} claude login ${GREEN}(already authenticated)${RESET}"
fi

if ! gh auth status &>/dev/null 2>&1; then
  echo -e "  ${YELLOW}2.${RESET} gh auth login"
else
  echo -e "  ${GREEN}2.${RESET} gh auth login ${GREEN}(already authenticated)${RESET}"
fi

if ! vercel whoami &>/dev/null 2>&1; then
  echo -e "  ${YELLOW}3.${RESET} vercel login"
else
  echo -e "  ${GREEN}3.${RESET} vercel login ${GREEN}(already authenticated)${RESET}"
fi

echo -e "  ${YELLOW}4.${RESET} nano .env  ${CYAN}# fill in BOT_TOKEN, SUPERGROUP_ID, OWNER_USER_ID, etc.${RESET}"
echo -e "  ${YELLOW}5.${RESET} npm start"
echo ""
