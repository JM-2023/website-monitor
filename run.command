#!/bin/zsh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "[error] Node.js is not installed or not in PATH."
  echo "Install Node.js, then run again."
  read -k 1 "?Press any key to close..."
  echo
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[error] npm is not installed or not in PATH."
  echo "Install npm (bundled with Node.js), then run again."
  read -k 1 "?Press any key to close..."
  echo
  exit 1
fi

if ! npm run dev; then
  echo
  echo "[error] Failed to start monitor control panel."
  read -k 1 "?Press any key to close..."
  echo
  exit 1
fi
