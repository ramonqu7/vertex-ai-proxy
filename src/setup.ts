#!/usr/bin/env node
import { execSync } from 'child_process';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Vertex AI Proxy Setup - Install as systemd service

Usage: vertex-ai-proxy-setup [options]

Options:
  --project=<id>    Google Cloud project ID (required)
  --port=<port>     Server port (default: 8001)
  --regions=<list>  Claude regions (default: us-east5,us-east1,europe-west1)
  --uninstall       Remove the service
  -h, --help        Show help

Examples:
  vertex-ai-proxy-setup --project=my-project
  vertex-ai-proxy-setup --project=my-project --port=8080
  vertex-ai-proxy-setup --uninstall
`);
  process.exit(0);
}

const user = process.env.USER || execSync('whoami').toString().trim();
const home = homedir();
const systemdDir = join(home, '.config/systemd/user');
const servicePath = join(systemdDir, 'vertex-ai-proxy.service');

if (args.includes('--uninstall')) {
  try {
    execSync('systemctl --user stop vertex-ai-proxy 2>/dev/null || true', { stdio: 'inherit' });
    execSync('systemctl --user disable vertex-ai-proxy 2>/dev/null || true', { stdio: 'inherit' });
    execSync(`rm -f ${servicePath}`, { stdio: 'inherit' });
    execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
    console.log('✅ Service uninstalled');
  } catch (e) {
    console.error('Uninstall failed:', e);
  }
  process.exit(0);
}

const projectId = args.find(a => a.startsWith('--project='))?.split('=')[1] 
  || process.env.PROJECT_ID 
  || process.env.GOOGLE_CLOUD_PROJECT;

if (!projectId) {
  console.error('Error: --project=<id> or PROJECT_ID required');
  console.error('Run: vertex-ai-proxy-setup --project=your-gcp-project');
  process.exit(1);
}

const port = args.find(a => a.startsWith('--port='))?.split('=')[1] || '8001';
const regions = args.find(a => a.startsWith('--regions='))?.split('=')[1] || 'us-east5,us-east1,europe-west1';

let nodePath: string, vapPath: string;
try {
  nodePath = execSync('which node').toString().trim();
  vapPath = execSync('which vertex-ai-proxy').toString().trim();
} catch {
  console.error('Error: vertex-ai-proxy not found in PATH');
  console.error('Install with: npm install -g vertex-ai-proxy');
  process.exit(1);
}

const serviceContent = `[Unit]
Description=Vertex AI Proxy - OpenAI-compatible API for Claude/Gemini
After=network.target

[Service]
Type=simple
Environment=PROJECT_ID=${projectId}
Environment=PORT=${port}
Environment=CLAUDE_REGIONS=${regions}
Environment=ENABLE_METRICS=true
Environment=ENABLE_REQUEST_LOGGING=false
ExecStart=${nodePath} ${vapPath}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

if (!existsSync(systemdDir)) {
  mkdirSync(systemdDir, { recursive: true });
}

writeFileSync(servicePath, serviceContent);
console.log(`Created: ${servicePath}`);

try {
  execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
  execSync('systemctl --user enable vertex-ai-proxy', { stdio: 'inherit' });
  execSync('systemctl --user start vertex-ai-proxy', { stdio: 'inherit' });
  
  console.log('\n✅ Vertex AI Proxy installed and started!');
  console.log(`   Port: ${port}`);
  console.log(`   Project: ${projectId}`);
  console.log(`   Regions: ${regions}`);
  console.log('\nCommands:');
  console.log('   systemctl --user status vertex-ai-proxy');
  console.log('   systemctl --user restart vertex-ai-proxy');
  console.log('   journalctl --user -u vertex-ai-proxy -f');
} catch (e: any) {
  console.error('Failed to start service:', e.message);
  process.exit(1);
}
