#!/usr/bin/env bash
# Checks what The Starchy Times needs, installs the npm packages, and tells you how to start it.
set -u
cd "$(dirname "$0")"
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; MISSING=1; }
MISSING=0

echo "Checking requirements..."
if command -v node >/dev/null 2>&1; then
  v=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$v" -ge 18 ]; then ok "Node.js $(node -v)"; else bad "Node.js 18 or newer is needed (found $(node -v))"; fi
else bad "Node.js is missing (sudo apt install nodejs npm)"; fi

if command -v python3 >/dev/null 2>&1 && python3 -c "import gi; gi.require_version('Gtk','3.0'); gi.require_version('WebKit2','4.0')" 2>/dev/null; then
  ok "Desktop window support (python3-gi + WebKit2GTK 4.0)"
else
  echo "  - Desktop window support not found. You can still use it in a browser, or install it with:"
  echo "      sudo apt install python3-gi gir1.2-webkit2-4.0"
fi

[ "$MISSING" -eq 1 ] && { echo; echo "Fix the items marked ✗ and run ./setup.sh again."; exit 1; }

echo; echo "Installing packages..."
npm install --omit=dev --no-audit --no-fund || { echo "npm install failed"; exit 1; }

echo
echo "All set. Start it with:"
echo "  python3 launch.py     # desktop window"
echo "  node server.js        # or: open http://127.0.0.1:9876 in a browser"
echo
echo "Optional: add a short command to your shell:"
echo "  echo \"alias dashboard='python3 $(pwd)/launch.py &'\" >> ~/.bashrc"
