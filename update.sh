#!/bin/bash
# Update vertex-ai-proxy from npm and restart
set -e

cd "$(dirname "$0")"
export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"

echo "Checking for updates..."
CURRENT=$(node -p "require(\"./package.json\").version" 2>/dev/null || echo "unknown")
LATEST=$(npm view vertex-ai-proxy version 2>/dev/null || echo "unknown")

echo "Current: $CURRENT"
echo "Latest:  $LATEST"

if [ "$CURRENT" = "$LATEST" ]; then
    echo "Already up to date!"
    exit 0
fi

echo ""
echo "Updating vertex-ai-proxy..."
npm update

echo ""
echo "Rebuilding..."
npm run build

echo ""
echo "Restarting proxy..."
pkill -f "vertex-ai-proxy/dist" 2>/dev/null || true
sleep 2
screen -dmS proxy bash -c "cd $PWD && VERTEX_PROXY_START=1 node dist/index.js"
sleep 3

# Verify
if curl -s localhost:8001/ > /dev/null 2>&1; then
    echo "✓ Proxy restarted successfully!"
    curl -s localhost:8001/ | jq -r ".version"
else
    echo "✗ Failed to restart proxy"
    exit 1
fi
