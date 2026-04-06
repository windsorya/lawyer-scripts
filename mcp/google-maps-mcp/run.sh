#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi
if [ -z "$GOOGLE_MAPS_API_KEY" ]; then
    echo "❌ 請設定 GOOGLE_MAPS_API_KEY"
    exit 1
fi
echo "🗺️  啟動 Google Maps MCP Server..."
python3 mcp_server.py
