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

# 4. Configure npm global directory in user home (avoids sudo for npm install -g)
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
# Add to PATH for current session and future sessions
export PATH="$HOME/.npm-global/bin:$PATH"
if ! grep -q 'npm-global' ~/.bashrc 2>/dev/null; then
  echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
fi
if ! grep -q 'npm-global' ~/.profile 2>/dev/null; then
  echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.profile
fi
echo "npm global dir set to ~/.npm-global"

# 5. Install Claude Code CLI (native installer — npm is deprecated)
curl -fsSL https://claude.ai/install.sh | bash
echo "→ Run: claude login"

# 6. Install gh CLI (GitHub CLI)
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt-get update && sudo apt-get install -y gh
echo "→ Run: gh auth login"

# 7. Install Vercel CLI
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
