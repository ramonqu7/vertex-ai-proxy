#!/bin/bash
# Vertex AI Proxy Test Script
# Usage: ./test-proxy.sh [--all]
# Default: Skip Claude tests (add --all to include)

PROXY_URL="${PROXY_URL:-http://localhost:8001}"
GREEN="\033[32m"
RED="\033[31m"
YELLOW="\033[33m"
BLUE="\033[34m"
NC="\033[0m"
TEST_ALL="${1:-}"

echo "========================================"
echo "  Vertex AI Proxy Test Suite"
echo "  Endpoint: $PROXY_URL"
echo "========================================"
echo ""

# Check proxy
echo -n "Checking proxy... "
STATUS=$(curl -s "$PROXY_URL/")
if [ -n "$STATUS" ]; then
    UPTIME=$(echo "$STATUS" | jq -r ".uptime // 0")
    REQS=$(echo "$STATUS" | jq -r ".requestCount // 0")
    echo -e "${GREEN}✓${NC} Running (uptime: ${UPTIME}s, requests: $REQS)"
else
    echo -e "${RED}✗${NC} Not running"
    exit 1
fi

# Helper function
test_chat() {
    local name="$1"
    local model="$2"
    local prompt="$3"
    local max_tokens="${4:-100}"
    
    echo -n "   $name... "
    R=$(curl -s --max-time 30 -X POST "$PROXY_URL/v1/chat/completions" \
      -H "Content-Type: application/json" \
      -d "{\"model\": \"$model\", \"messages\": [{\"role\": \"user\", \"content\": \"$prompt\"}], \"max_tokens\": $max_tokens}")
    
    ERR=$(echo "$R" | jq -r ".error.message // empty" 2>/dev/null | head -c 80)
    if [ -n "$ERR" ]; then
        echo -e "${RED}✗${NC} $ERR"
        return 1
    fi
    
    C=$(echo "$R" | jq -r ".choices[0].message.content // empty" 2>/dev/null | tr -d n | head -c 60)
    if [ -n "$C" ]; then
        echo -e "${GREEN}✓${NC} \"$C\""
        return 0
    else
        echo -e "${RED}✗${NC} Empty response"
        return 1
    fi
}

# 1. Claude (optional)
if [ "$TEST_ALL" = "--all" ]; then
    echo ""
    echo -e "${BLUE}1. Text Generation (Claude)${NC}"
    test_chat "claude-sonnet-4-5" "claude-sonnet-4-5@20250929" "Say hello" 50
    test_chat "claude-haiku-4-5" "claude-haiku-4-5@20251001" "Say hi" 50
else
    echo ""
    echo -e "${YELLOW}1. Claude tests skipped (use --all to include)${NC}"
fi

# 2. Gemini Text
echo ""
echo -e "${BLUE}2. Text Generation (Gemini)${NC}"
test_chat "gemini-3-pro-preview" "gemini-3-pro-preview" "What is 2+2? Just the number." 4000
test_chat "gemini-2.5-pro" "gemini-2.5-pro" "Say hello in 3 words" 100
test_chat "gemini-2.5-flash" "gemini-2.5-flash" "Say hi" 50

# 3. Vision
echo ""
echo -e "${BLUE}3. Vision / Image Analysis${NC}"
echo -n "   gemini-3-pro + image URL... "
R=$(curl -s --max-time 30 -X POST "$PROXY_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"gemini-3-pro-preview\", \"messages\": [{\"role\": \"user\", \"content\": [{\"type\": \"text\", \"text\": \"What logo? One word.\"}, {\"type\": \"image_url\", \"image_url\": {\"url\": \"https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png\"}}]}], \"max_tokens\": 4000}")
C=$(echo "$R" | jq -r ".choices[0].message.content // empty" 2>/dev/null | head -c 60)
if [ -n "$C" ]; then echo -e "${GREEN}✓${NC} \"$C\""; else echo -e "${RED}✗${NC} Failed"; fi

# 4. Imagen
echo ""
echo -e "${BLUE}4. Image Generation (Imagen)${NC}"
echo -n "   imagen-4.0-generate-001... "
R=$(curl -s --max-time 30 -X POST "$PROXY_URL/v1/images/generations" \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"imagen-4.0-generate-001\", \"prompt\": \"red circle\", \"n\": 1}")
B=$(echo "$R" | jq -r ".data[0].b64_json // empty" 2>/dev/null)
if [ -n "$B" ]; then
    S=${#B}
    echo -e "${GREEN}✓${NC} Generated ($((S/1024))KB)"
else
    ERR=$(echo "$R" | jq -r ".error.message // empty" 2>/dev/null | head -c 60)
    echo -e "${RED}✗${NC} ${ERR:-Failed}"
fi

# 5. Gemini Native Image Gen
echo ""
echo -e "${BLUE}5. Native Image Gen (Gemini 3 Pro Image)${NC}"
echo -n "   gemini-3-pro-image-preview... "
R=$(curl -s --max-time 60 -X POST "$PROXY_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"gemini-3-pro-image-preview\", \"messages\": [{\"role\": \"user\", \"content\": \"Draw a blue square\"}], \"max_tokens\": 8000}")
B=$(echo "$R" | jq -r ".images[0].b64_json // empty" 2>/dev/null)
if [ -n "$B" ]; then
    S=${#B}
    echo -e "${GREEN}✓${NC} Generated ($((S/1024))KB)"
else
    C=$(echo "$R" | jq -r ".choices[0].message.content // empty" 2>/dev/null | head -c 40)
    if [ -n "$C" ]; then
        echo -e "${YELLOW}⊘${NC} Text only: \"$C\""
    else
        echo -e "${RED}✗${NC} Failed"
    fi
fi

# 6. Models
echo ""
echo -e "${BLUE}6. Models Endpoint${NC}"
echo -n "   GET /v1/models... "
R=$(curl -s "$PROXY_URL/v1/models")
N=$(echo "$R" | jq ".data | length" 2>/dev/null)
if [ "$N" -gt 0 ] 2>/dev/null; then
    echo -e "${GREEN}✓${NC} $N models available"
else
    echo -e "${RED}✗${NC} Failed"
fi

echo ""
echo "========================================"
echo "  Test Complete!"
echo "========================================"
