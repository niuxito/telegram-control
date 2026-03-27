#!/bin/bash
set -e

echo "=== Telegram Control — Raspberry Pi Install ==="

# 1. Update system
sudo apt-get update && sudo apt-get upgrade -y

# 2. Install build tools (needed for better-sqlite3 native compilation)
sudo apt-get install -y build-essential python3 git curl

# 3. Install Node.js 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "Node.js $(node --version) installed"
echo "npm $(npm --version) installed"

# 4. Install Claude Code CLI
npm install -g @anthropic-ai/claude-code
echo "→ Run: claude login"

# 5. Install gh CLI (GitHub CLI)
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt-get update && sudo apt-get install -y gh
echo "→ Run: gh auth login"

# 6. Install Vercel CLI
npm install -g vercel
echo "→ Run: vercel login"

# 7. Install npm dependencies
# (assumes the script is run from the project root)
npm install

# 8. Build TypeScript
npm run build

# 9. Setup .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo "→ Edit .env with your credentials"
fi

echo ""
echo "=== Installation complete ==="
echo "Next steps:"
echo "  1. claude login"
echo "  2. gh auth login"
echo "  3. vercel login"
echo "  4. Edit .env with your BOT_TOKEN, SUPERGROUP_ID, etc."
echo "  5. npm start"
