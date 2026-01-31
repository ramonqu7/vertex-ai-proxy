# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-01-31

### Added
- Initial release
- OpenAI-compatible API for Claude and Gemini on Vertex AI
- Automatic region failover (us-east5 → us-east1 → europe-west1)
- Smart retry logic with exponential backoff
- Request timeout (configurable, default 300s)
- Request queue with concurrency limits (default: 10 concurrent, 100 queued)
- Streaming heartbeat ping (default: every 15s)
- Prometheus metrics at `/metrics`
- Anthropic prompt caching support
- Full streaming support including tool/function calls
- CLI with extensive configuration options
- Programmatic API for custom integrations

### Supported Models

#### Claude (via Anthropic Vertex SDK)
- claude-opus-4-5@20251101 (alias: opus)
- claude-sonnet-4-5@20250929 (alias: sonnet)
- claude-haiku-3-5@20241022 (alias: haiku)

#### Gemini (via Google GenAI SDK)
- gemini-3-pro-preview (alias: gemini-3-pro)
- gemini-2.5-pro
- gemini-2.0-flash

## [1.0.1] - 2026-01-31

### Fixed
- Updated @anthropic-ai/vertex-sdk to v0.14.2 for Node.js 24 compatibility
- Fixed ESM module resolution issues

## [1.0.2] - 2026-01-31

### Added
- `vertex-ai-proxy-setup` command for systemd service installation
  - Auto-start on boot
  - `--project`, `--port`, `--regions` options
  - `--uninstall` to remove service
