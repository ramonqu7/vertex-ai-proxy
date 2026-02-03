# Vertex AI Proxy for OpenClaw & Clawdbot

[![npm version](https://badge.fury.io/js/vertex-ai-proxy.svg)](https://badge.fury.io/js/vertex-ai-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A proxy server that lets you use **Google Vertex AI models** (Claude, Gemini, Imagen) with [OpenClaw](https://github.com/openclaw/openclaw), [Clawdbot](https://github.com/clawdbot/clawdbot), and other OpenAI-compatible tools.

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  OpenClaw   │────▶│  Vertex Proxy    │────▶│  Vertex AI API  │
│  Clawdbot   │◀────│  (This Server)   │◀────│  Claude/Gemini  │
└─────────────┘     └──────────────────┘     └─────────────────┘
```

## Features

- 🤖 **Multi-model support**: Claude (Opus, Sonnet, Haiku), Gemini, Imagen
- 🔄 **Format conversion**: Translates between OpenAI ↔ Anthropic API formats
- 📡 **Streaming**: Full SSE streaming support
- 🏷️ **Model aliases**: Create friendly names like `my-assistant` → `claude-opus-4-5`
- 🔀 **Fallback chains**: Automatic failover when models are unavailable
- 🌍 **Dynamic region fallback**: Automatically tries us-east5 → us-central1 → europe-west1
- 📏 **Context management**: Auto-truncate messages to fit model limits
- 🔐 **Google ADC**: Uses Application Default Credentials (no API keys needed)
- 🔧 **Daemon mode**: Run as background service with `start`/`stop`/`restart`
- 📝 **Logging**: Built-in log management with `logs` command

## Quick Start

### 1. Install

```bash
npm install -g vertex-ai-proxy
```

### 2. Setup Google Cloud

```bash
# Authenticate
gcloud auth application-default login

# Set your project & enable Vertex AI
gcloud config set project YOUR_PROJECT_ID
gcloud services enable aiplatform.googleapis.com
```

### 3. Run

```bash
# Start the proxy
vertex-ai-proxy start --project YOUR_PROJECT_ID

# Check status
vertex-ai-proxy status
```

## CLI Commands

### Daemon Management

```bash
# Start as background daemon
vertex-ai-proxy start
vertex-ai-proxy start --port 8001 --project your-project

# Stop the daemon
vertex-ai-proxy stop

# Restart
vertex-ai-proxy restart

# Check status (running, uptime, request count, health)
vertex-ai-proxy status

# View logs
vertex-ai-proxy logs           # Last 50 lines
vertex-ai-proxy logs -n 100    # Last 100 lines  
vertex-ai-proxy logs -f        # Follow (tail -f style)
```

### Model Management

```bash
# List all available models
vertex-ai-proxy models

# Show detailed model info
vertex-ai-proxy models info claude-opus-4-5@20251101

# Show all details including pricing
vertex-ai-proxy models list --all

# Check which models are enabled in your Vertex AI project
vertex-ai-proxy models fetch

# Enable a model in your config
vertex-ai-proxy models enable claude-opus-4-5@20251101

# Enable with an alias
vertex-ai-proxy models enable claude-opus-4-5@20251101 --alias opus

# Disable a model
vertex-ai-proxy models disable gemini-2.5-flash
```

### Configuration

```bash
# Show current configuration
vertex-ai-proxy config

# Interactive configuration setup
vertex-ai-proxy config set

# Set default model
vertex-ai-proxy config set-default claude-sonnet-4-5@20250514

# Add a model alias
vertex-ai-proxy config add-alias fast claude-haiku-4-5@20251001

# Remove an alias
vertex-ai-proxy config remove-alias fast

# Set fallback chain
vertex-ai-proxy config set-fallback claude-opus-4-5@20251101 claude-sonnet-4-5@20250514 gemini-2.5-pro

# Export configuration for OpenClaw
vertex-ai-proxy config export
vertex-ai-proxy config export -o openclaw-snippet.json
```

### Setup & Utilities

```bash
# Check Google Cloud setup (auth, ADC, project)
vertex-ai-proxy check

# Configure OpenClaw integration
vertex-ai-proxy setup-openclaw

# Install as systemd service
vertex-ai-proxy install-service --user      # User service (no sudo)
vertex-ai-proxy install-service             # System service (requires sudo)
```

## Prerequisites

- **Google Cloud CLI**: [Install here](https://cloud.google.com/sdk/docs/install)
- **GCP Project** with Vertex AI enabled
- **Claude Access**: Enable in [Model Garden](https://console.cloud.google.com/vertex-ai/model-garden) (search "Claude" → click Enable)


## Configuration

### Environment Variables

```bash
# Required
export GOOGLE_CLOUD_PROJECT="your-project-id"

# Optional (with defaults)
export VERTEX_PROXY_PORT="8001"
export VERTEX_PROXY_REGION="us-east5"           # For Claude
export VERTEX_PROXY_GOOGLE_REGION="us-central1" # For Gemini/Imagen
```

### Config File

Create `~/.vertex-proxy/config.yaml`:

```yaml
# Google Cloud Settings
project_id: "your-project-id"
default_region: "us-east5"
google_region: "us-central1"

# Model Aliases (optional)
model_aliases:
  my-best: "claude-opus-4-5@20251101"
  my-fast: "claude-haiku-4-5@20251001"
  my-cheap: "gemini-2.5-flash-lite"
  
  # OpenAI compatibility
  gpt-4: "claude-opus-4-5@20251101"
  gpt-4o: "claude-sonnet-4-5@20250514"
  gpt-4o-mini: "claude-haiku-4-5@20251001"

# Fallback Chains (optional)
fallback_chains:
  claude-opus-4-5@20251101:
    - "claude-sonnet-4-5@20250514"
    - "gemini-2.5-pro"

# Context Management
auto_truncate: true
reserve_output_tokens: 4096
```

### Data Files

The proxy stores runtime data in `~/.vertex_proxy/`:

- `proxy.log` - Request/error logs
- `proxy.pid` - Daemon PID file
- `stats.json` - Runtime statistics (uptime, request count)

## Clawdbot Integration

### Setting Up a Fake Auth Profile

Clawdbot normally uses Anthropic's API directly, but you can route it through the Vertex AI Proxy by setting up a "fake" auth profile. This lets you use your Google Cloud credits and take advantage of Vertex AI's infrastructure.

#### Step 1: Start the Proxy

```bash
# Start the proxy daemon
vertex-ai-proxy start --project YOUR_GCP_PROJECT

# Verify it's running
vertex-ai-proxy status
```

#### Step 2: Configure Clawdbot

Add to your Clawdbot config (`~/.clawdbot/clawdbot.json` or equivalent):

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "vertex": {
        "baseUrl": "http://localhost:8001/v1",
        "apiKey": "vertex-proxy-fake-key",
        "api": "anthropic-messages",
        "models": [
          {
            "id": "claude-opus-4-5@20251101",
            "name": "Claude Opus 4.5 (Vertex)",
            "input": ["text", "image"],
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "claude-sonnet-4-5@20250514", 
            "name": "Claude Sonnet 4.5 (Vertex)",
            "input": ["text", "image"],
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "claude-haiku-4-5@20251001",
            "name": "Claude Haiku 4.5 (Vertex)",
            "input": ["text", "image"],
            "contextWindow": 200000,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "vertex/claude-sonnet-4-5@20250514"
      }
    }
  }
}
```

#### Step 3: Using Model Aliases

You can use the built-in aliases for convenience:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "vertex/sonnet"
      }
    },
    "my-agent": {
      "model": {
        "primary": "vertex/opus"
      }
    }
  }
}
```

The proxy automatically maps:
- `opus` → `claude-opus-4-5@20251101`
- `sonnet` → `claude-sonnet-4-5@20250514`
- `haiku` → `claude-haiku-4-5@20251001`
- `gpt-4` → `claude-opus-4-5@20251101`
- `gpt-4o` → `claude-sonnet-4-5@20250514`

#### Why Use Vertex AI Proxy with Clawdbot?

1. **Cost management**: Use Google Cloud credits and billing
2. **Enterprise features**: VPC Service Controls, audit logging
3. **Region control**: Run in specific regions for compliance
4. **Automatic failover**: Built-in region fallback for reliability
5. **No separate API key**: Uses your existing GCP authentication

## OpenClaw Integration

### Quick Setup

Run the setup script to automatically configure OpenClaw:

```bash
# After installing vertex-ai-proxy
npx vertex-ai-proxy setup-openclaw
```

### Manual Configuration

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "env": {
    "GOOGLE_CLOUD_PROJECT": "your-project-id",
    "GOOGLE_CLOUD_LOCATION": "us-east5"
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "vertex/claude-opus-4-5@20251101"
      },
      "models": {
        "vertex/claude-opus-4-5@20251101": { "alias": "opus" },
        "vertex/claude-sonnet-4-5@20250514": { "alias": "sonnet" },
        "vertex/claude-haiku-4-5@20251001": { "alias": "haiku" }
      }
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "vertex": {
        "baseUrl": "http://localhost:8001/v1",
        "apiKey": "vertex-proxy",
        "api": "anthropic-messages",
        "models": [
          {
            "id": "claude-opus-4-5@20251101",
            "name": "Claude Opus 4.5 (Vertex)",
            "input": ["text", "image"],
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "claude-sonnet-4-5@20250514",
            "name": "Claude Sonnet 4.5 (Vertex)",
            "input": ["text", "image"],
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "claude-haiku-4-5@20251001",
            "name": "Claude Haiku 4.5 (Vertex)",
            "input": ["text", "image"],
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "gemini-3-pro",
            "name": "Gemini 3 Pro (Vertex)",
            "input": ["text", "image", "audio", "video"],
            "contextWindow": 1000000,
            "maxTokens": 8192
          },
          {
            "id": "gemini-2.5-pro",
            "name": "Gemini 2.5 Pro (Vertex)",
            "input": ["text", "image"],
            "contextWindow": 1000000,
            "maxTokens": 8192
          },
          {
            "id": "gemini-2.5-flash",
            "name": "Gemini 2.5 Flash (Vertex)",
            "input": ["text", "image"],
            "contextWindow": 1000000,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

### Start the Proxy as a Service

```bash
# Install and enable as systemd service
sudo npx vertex-ai-proxy install-service

# Or use the daemon commands
vertex-ai-proxy start
openclaw gateway restart
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Health check and server info |
| `GET /health` | Simple health check with stats |
| `GET /v1/models` | List available models |
| `POST /v1/chat/completions` | OpenAI-compatible chat (recommended) |
| `POST /v1/messages` | Anthropic Messages API |
| `POST /v1/images/generations` | Image generation (Imagen) |

### Example Requests

**Chat Completion (OpenAI format):**
```bash
curl http://localhost:8001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-5@20251101",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

**Chat Completion (Anthropic format):**
```bash
curl http://localhost:8001/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-5@20251101",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

**Image Generation:**
```bash
curl http://localhost:8001/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "model": "imagen-4.0-generate-001",
    "prompt": "A cute robot learning to paint",
    "n": 1,
    "size": "1024x1024"
  }'
```

## Available Models

### Claude Models (Anthropic on Vertex)

| Model | ID | Context | Price (per 1M tokens) |
|-------|----|---------|-----------------------|
| Opus 4.5 | `claude-opus-4-5@20251101` | 200K | $15 / $75 |
| Sonnet 4.5 | `claude-sonnet-4-5@20250514` | 200K | $3 / $15 |
| Haiku 4.5 | `claude-haiku-4-5@20251001` | 200K | $0.25 / $1.25 |

### Gemini Models

| Model | ID | Context | Price (per 1M tokens) | Best For |
|-------|----|---------|-----------------------|----------|
| Gemini 3 Pro | `gemini-3-pro` | 1M | $2.50 / $15 | Latest & greatest |
| Gemini 2.5 Pro | `gemini-2.5-pro` | 1M | $1.25 / $5 | Complex reasoning |
| Gemini 2.5 Flash | `gemini-2.5-flash` | 1M | $0.15 / $0.60 | Fast responses |
| Gemini 2.5 Flash Lite | `gemini-2.5-flash-lite` | 1M | $0.075 / $0.30 | Budget-friendly |

### Imagen Models (Image Generation)

| Model | ID | Description | Price |
|-------|-----|-------------|-------|
| Imagen 4 | `imagen-4.0-generate-001` | Best quality | ~$0.04/image |
| Imagen 4 Fast | `imagen-4.0-fast-generate-001` | Lower latency | ~$0.02/image |
| Imagen 4 Ultra | `imagen-4.0-ultra-generate-001` | Highest quality | ~$0.08/image |

## Troubleshooting

### "Requested entity was not found"

1. Check your project ID is correct
2. Ensure Claude is enabled in Model Garden
3. Verify you're using a supported region (`us-east5` or `europe-west1` for Claude)

### "Permission denied"

```bash
# Re-authenticate
gcloud auth application-default login

# Check current credentials
gcloud auth application-default print-access-token
```

### "Model not found" in OpenClaw/Clawdbot

Ensure the model is defined in `models.providers.vertex.models[]` in your config.

### Streaming not working

Check that your client supports SSE (Server-Sent Events). The proxy sends:
```
data: {"choices":[{"delta":{"content":"Hello"}}]}

data: [DONE]
```

### Check proxy logs

```bash
# View recent logs
vertex-ai-proxy logs

# Follow logs in real-time
vertex-ai-proxy logs -f
```

## Development

```bash
# Clone and install
git clone https://github.com/anthropics/vertex-ai-proxy.git
cd vertex-ai-proxy
npm install

# Run in development mode
npm run dev

# Run tests
npm test

# Build
npm run build
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Related Projects

- [OpenClaw](https://github.com/openclaw/openclaw) - Personal AI assistant
- [Clawdbot](https://github.com/clawdbot/clawdbot) - Discord/multi-platform AI bot
- [Anthropic Vertex SDK](https://github.com/anthropics/anthropic-sdk-python) - Official Python SDK
- [Google Vertex AI](https://cloud.google.com/vertex-ai) - Google's AI platform

## Google Search Grounding

Enable real-time web search for Gemini models to get up-to-date information.

### Per-Request

```bash
# Via header
curl http://localhost:8001/v1/chat/completions \
  -H "X-Enable-Grounding: true" \
  -H "Content-Type: application/json" \
  -d '{"model": "gemini-2.5-flash", "messages": [{"role": "user", "content": "Bitcoin price today"}]}'

# Via body parameter
curl http://localhost:8001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Latest news about AI"}],
    "grounding": true
  }'

# With custom threshold (0-1, lower = more likely to search)
curl http://localhost:8001/v1/chat/completions \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [...],
    "grounding": {"mode": "MODE_DYNAMIC", "dynamicThreshold": 0.3}
  }'
```

### Global Config

Enable grounding by default in `~/.vertex-proxy/config.yaml`:

```yaml
grounding:
  enabled: true
  mode: MODE_DYNAMIC
  dynamicThreshold: 0.3
```

### Response

When grounding is used, the response includes source information:

```json
{
  "choices": [...],
  "grounding": {
    "web_search_queries": ["bitcoin price USD today"],
    "sources": [
      {"uri": "https://...", "title": "..."}
    ]
  }
}
```

Supported models: `gemini-3-pro-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`
