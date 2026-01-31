#!/usr/bin/env node
import { startServer } from './server.js';
import { DEFAULT_CONFIG } from './types.js';

const args = process.argv.slice(2);
const config: Record<string, any> = {};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const next = args[i + 1];
  
  switch (arg) {
    case '--port': case '-p': config.port = parseInt(next); i++; break;
    case '--host': config.host = next; i++; break;
    case '--project': config.projectId = next; i++; break;
    case '--claude-regions': config.claudeRegions = next.split(','); i++; break;
    case '--gemini-location': config.geminiLocation = next; i++; break;
    case '--max-concurrent': config.maxConcurrent = parseInt(next); i++; break;
    case '--enable-logging': config.enableRequestLogging = true; break;
    case '--disable-cache': config.enablePromptCache = false; break;
    case '--disable-metrics': config.enableMetrics = false; break;
    case '-h': case '--help':
      console.log('Vertex AI Proxy - OpenAI-compatible API for Claude/Gemini on Vertex AI\n');
      console.log('Usage: vertex-proxy [options]\n');
      console.log('Options:');
      console.log('  -p, --port <port>        Server port (default: 8001)');
      console.log('  --project <id>           Google Cloud project ID');
      console.log('  --claude-regions <list>  Comma-separated regions');
      console.log('  --max-concurrent <n>     Max concurrent requests');
      console.log('  --enable-logging         Enable request logging');
      console.log('  --disable-cache          Disable prompt caching');
      console.log('  -h, --help               Show help');
      process.exit(0);
  }
}

const projectId = config.projectId || process.env.PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
if (!projectId) {
  console.error('Error: PROJECT_ID required');
  process.exit(1);
}

config.projectId = projectId;
startServer(config);
