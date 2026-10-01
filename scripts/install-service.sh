#!/bin/bash
# Installs Telegram Control as a systemd user service for the current user.
# Usage: npm run install-service
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/telegram-control.service"

if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "systemd user services are not available here. Run the bot with: npm start" >&2
  exit 1
fi

# Agents must find the same CLIs as your shell; drop the entries npm adds for this script
SERVICE_PATH="$(echo "$PATH" | tr ':' '\n' | grep -v -e 'node_modules/.bin' -e 'node-gyp-bin' | awk '!seen[$0]++' | paste -sd:)"

[ -f "$REPO_DIR/dist/index.js" ] || (cd "$REPO_DIR" && npm run build)

mkdir -p "$UNIT_DIR"
sed -e "s#^WorkingDirectory=.*#WorkingDirectory=$REPO_DIR#" \
    -e "s#^Environment=PATH=.*#Environment=PATH=$SERVICE_PATH#" \
    "$REPO_DIR/scripts/telegram-control.service" > "$UNIT"

systemctl --user daemon-reload
systemctl --user enable telegram-control >/dev/null
systemctl --user restart telegram-control
echo "Installed $UNIT and started the service."

if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  if loginctl enable-linger "$USER" 2>/dev/null; then
    echo "Enabled lingering: the bot keeps running after you log out."
  else
    echo "To keep the bot running after you log out, run: sudo loginctl enable-linger $USER"
  fi
fi

echo "Logs: journalctl --user -u telegram-control -f"
