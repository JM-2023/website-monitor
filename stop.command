#!/bin/zsh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

typeset -a TARGET_PIDS

add_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return
  [[ "$pid" == <-> ]] || return

  local existing
  for existing in "${TARGET_PIDS[@]}"; do
    [[ "$existing" == "$pid" ]] && return
  done
  TARGET_PIDS+=("$pid")
}

if command -v pgrep >/dev/null 2>&1; then
  while IFS= read -r line; do
    local_pid="${line%% *}"
    local_cmd="${line#* }"
    if [[ "$local_cmd" == *"$SCRIPT_DIR/.out/control-server.js"* ]] || \
       [[ "$local_cmd" == *"$SCRIPT_DIR/.out/index.js"* ]] || \
       [[ "$local_cmd" == *"$SCRIPT_DIR/scripts/dev.mjs"* ]]; then
      add_pid "$local_pid"
    fi
  done < <(pgrep -af node 2>/dev/null || true)
fi

if command -v lsof >/dev/null 2>&1; then
  while IFS= read -r pid; do
    add_pid "$pid"
  done < <(lsof -nP -tiTCP -sTCP:LISTEN -a -c node -iTCP:3210-3235 2>/dev/null || true)
fi

if [[ ${#TARGET_PIDS[@]} -eq 0 ]]; then
  echo "No monitor process found."
  exit 0
fi

echo "Stopping monitor process(es): ${TARGET_PIDS[*]}"
for pid in "${TARGET_PIDS[@]}"; do
  if ! kill "$pid" 2>/dev/null; then
    :
  fi
done

sleep 1

typeset -a STILL_RUNNING
for pid in "${TARGET_PIDS[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    STILL_RUNNING+=("$pid")
  fi
done

if [[ ${#STILL_RUNNING[@]} -gt 0 ]]; then
  echo "Force stopping process(es): ${STILL_RUNNING[*]}"
  for pid in "${STILL_RUNNING[@]}"; do
    kill -9 "$pid" 2>/dev/null || true
  done
fi

typeset -a REMAINING
for pid in "${TARGET_PIDS[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    REMAINING+=("$pid")
  fi
done

if [[ ${#REMAINING[@]} -gt 0 ]]; then
  echo "Some processes are still running: ${REMAINING[*]}"
  echo "Try running this script with higher privileges."
  exit 1
fi

echo "Stop complete."
