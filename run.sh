#!/bin/bash
# vault-graph launcher
cd "$(dirname "$0")"
if [ ! -d "${VAULT_GRAPH_VAULT:-/Users/artur/Library/Mobile Documents/iCloud~md~obsidian/Documents/second-brain-v2}" ]; then
  echo "vault not found — set VAULT_GRAPH_VAULT env var" >&2
  exit 1
fi
PORT="${VAULT_GRAPH_PORT:-8777}"
echo "vault-graph → http://localhost:$PORT"
( sleep 1 && open "http://localhost:$PORT" ) &
exec python3 server.py