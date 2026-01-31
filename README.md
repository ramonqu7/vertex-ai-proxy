# vertex-ai-proxy

OpenAI-compatible proxy for Google Vertex AI, supporting **Claude** and **Gemini** models with automatic failover, retries, and prompt caching.

[![npm version](https://badge.fury.io/js/vertex-ai-proxy.svg)](https://www.npmjs.com/package/vertex-ai-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- 🔄 **Automatic Region Failover** - Seamlessly switches between regions on rate limits (429)
- 🔁 **Smart Retries** - Exponential backoff with jitter for transient errors
- 💰 **Prompt Caching** - Reduces costs up to 90% for repeated system prompts (Claude)
- 📊 **Prometheus Metrics** - Monitor latency, errors, cache hits at `/metrics`
- ⏱️ **Request Timeout** - Configurable timeout (default 300s)
- 📋 **Request Queue** - Prevents overload with configurable concurrency limits
- 💓 **Heartbeat Ping** - Keeps long-running streaming connections alive
- 🔀 **Multi-Model Support** - Claude Opus/Sonnet/Haiku + Gemini Pro/Flash
- ⚡ **Full Streaming** - Including tool/function calls

## Installation

```bash
npm install -g vertex-ai-proxy
```

## Quick Start

```bash
# Set your Google Cloud project
export PROJECT_ID=your-project-id

# Authenticate with Google Cloud
gcloud auth application-default login

# Start the proxy
vertex-ai-proxy
```

The proxy starts on `http://localhost:8001` by default.

## Usage

### CLI Options

```bash
vertex-ai-proxy [options]

Options:
  -p, --port <port>           Server port (default: 8001)
  --host <host>               Server host (default: 0.0.0.0)
  --project <id>              Google Cloud project ID
  --claude-regions <regions>  Comma-separated failover regions
  --gemini-location <loc>     Gemini location
  --max-concurrent <n>        Max concurrent requests (default: 10)
  --enable-logging            Enable request logging
  --disable-cache             Disable prompt caching
  --disable-metrics           Disable Prometheus metrics
  -h, --help                  Show help
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROJECT_ID` | - | Google Cloud project ID (required) |
| `CLAUDE_REGIONS` | `us-east5,us-east1,europe-west1` | Comma-separated failover regions |
| `GEMINI_LOCATION` | `us-east5` | Gemini location |
| `PORT` | `8001` | Server port |
| `MAX_CONCURRENT` | `10` | Max concurrent requests |
| `QUEUE_SIZE` | `100` | Max queue size |
| `MAX_RETRIES` | `3` | Max retries per request |
| `REQUEST_TIMEOUT` | `300` | Request timeout in seconds |
| `ENABLE_PROMPT_CACHE` | `true` | Enable Anthropic prompt caching |
| `ENABLE_METRICS` | `true` | Enable Prometheus metrics |
| `ENABLE_REQUEST_LOGGING` | `false` | Enable detailed request logging |
| `HEARTBEAT_INTERVAL` | `15` | Streaming heartbeat interval (seconds) |

### With Clawdbot

Add to your `clawdbot.json`:

```json
{
  "models": {
    "providers": {
      "vertex": {
        "baseUrl": "http://localhost:8001/v1",
        "apiKey": "dummy",
        "api": "openai-completions",
        "models": [
          {
            "id": "opus",
            "name": "Claude Opus 4.5 (Vertex)",
            "contextWindow": 200000,
            "maxTokens": 16384
          }
        ]
      }
    }
  }
}
```

### Programmatic Usage

```typescript
import { createServer, startServer } from 'vertex-ai-proxy';

// Option 1: Start with defaults
startServer({ projectId: 'my-project' });

// Option 2: Get Express app for custom middleware
const { app, config } = createServer({
  projectId: 'my-project',
  claudeRegions: ['us-east5', 'us-central1'],
  maxConcurrent: 20,
});
app.listen(8080);
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Health check |
| `GET /health` | Health check with config details |
| `GET /metrics` | Prometheus metrics |
| `POST /v1/chat/completions` | OpenAI-compatible chat API |

## Model Aliases

### Claude
| Alias | Model |
|-------|-------|
| `opus` | claude-opus-4-5@20251101 |
| `sonnet` | claude-sonnet-4-5@20250929 |
| `haiku` | claude-haiku-3-5@20241022 |

### Gemini
| Alias | Model |
|-------|-------|
| `gemini-3-pro` | gemini-3-pro-preview |
| `gemini-2.5-pro` | gemini-2.5-pro |
| `gemini-2.0-flash` | gemini-2.0-flash |

## Region Failover

When a region returns 429 (rate limited), the proxy automatically tries the next region:

```
us-east5 (primary) → us-east1 → europe-west1
```

Healthy regions are prioritized based on recent success.

## Metrics

Prometheus metrics available at `/metrics`:

- `vertex_proxy_requests_total{model,status}` - Total requests
- `vertex_proxy_request_duration_seconds` - Request latency
- `vertex_proxy_retries_total{model,region}` - Retry count
- `vertex_proxy_region_failures_total{region}` - Region failures
- `vertex_proxy_cache_hits_total` - Prompt cache hits

## Requirements

- Node.js 18+
- Google Cloud authentication (ADC or service account)
- Vertex AI API enabled

## License

MIT

## Contributing

PRs welcome! Please open an issue first to discuss changes.
