#!/usr/bin/env node

/**
 * Vertex AI Proxy CLI
 * 
 * Commands:
 *   vertex-ai-proxy                       Start the proxy server
 *   vertex-ai-proxy start                 Start as background daemon
 *   vertex-ai-proxy stop                  Stop the daemon
 *   vertex-ai-proxy restart               Restart the daemon
 *   vertex-ai-proxy status                Show proxy status
 *   vertex-ai-proxy logs                  Show proxy logs
 *   vertex-ai-proxy test                  Run proxy test suite
 *   vertex-ai-proxy update                Update from npm
 *   vertex-ai-proxy models                List all available models
 *   vertex-ai-proxy models fetch          Fetch/verify models from Vertex AI
 *   vertex-ai-proxy models info <model>   Show detailed model info
 *   vertex-ai-proxy models enable <model> Enable a model
 *   vertex-ai-proxy config                Show current config
 *   vertex-ai-proxy config set            Interactive config setup
 *   vertex-ai-proxy config set-default    Set default model
 *   vertex-ai-proxy config add-alias      Add model alias
 *   vertex-ai-proxy config export         Export for OpenClaw
 *   vertex-ai-proxy setup-openclaw        Configure OpenClaw integration
 *   vertex-ai-proxy check                 Check Google Cloud setup
 *   vertex-ai-proxy install-service       Install as systemd service
 */

import { fileURLToPath } from 'url';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { execSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import * as readline from 'readline';

const VERSION = '1.3.0';
const CONFIG_DIR = path.join(os.homedir(), '.vertex-proxy');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');
const DATA_DIR = path.join(os.homedir(), '.vertex_proxy');
const PID_FILE = path.join(DATA_DIR, 'proxy.pid');
const LOG_FILE = path.join(DATA_DIR, 'proxy.log');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

// ============================================================================
// Types
// ============================================================================

interface ModelInfo {
  id: string;
  name: string;
  provider: 'anthropic' | 'google' | 'imagen';
  description: string;
  contextWindow: number;
  maxTokens: number;
  inputPrice: number;
  outputPrice: number;
  regions: string[];
  capabilities: string[];
  available?: boolean;
}

interface Config {
  project_id: string;
  default_region: string;
  google_region: string;
  model_aliases: Record<string, string>;
  fallback_chains: Record<string, string[]>;
  default_model: string;
  enabled_models: string[];
  auto_truncate: boolean;
  reserve_output_tokens: number;
}

interface ProxyStats {
  startTime: number;
  requestCount: number;
  lastRequestTime: number | null;
  port: number;
}

// ============================================================================
// Model Catalog (Updated with correct token counts from Vertex AI docs)
// ============================================================================

const MODEL_CATALOG: Record<string, ModelInfo> = {
  // Claude Models (all: 200k input, 64k output)
  'claude-opus-4-5@20251101': {
    id: 'claude-opus-4-5@20251101',
    name: 'Claude Opus 4.5',
    provider: 'anthropic',
    description: 'Most capable Claude. Best for complex reasoning.',
    contextWindow: 200000,
    maxTokens: 64000,
    inputPrice: 15,
    outputPrice: 75,
    regions: ['us-east5', 'europe-west1', 'asia-southeast1', 'global'],
    capabilities: ['text', 'vision', 'tools', 'computer-use']
  },
  'claude-sonnet-4-5@20250929': {
    id: 'claude-sonnet-4-5@20250929',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    description: 'Balanced performance and cost. Great for coding.',
    contextWindow: 200000,
    maxTokens: 64000,
    inputPrice: 3,
    outputPrice: 15,
    regions: ['us-east5', 'europe-west1', 'asia-southeast1', 'global'],
    capabilities: ['text', 'vision', 'tools', 'thinking']
  },
  'claude-sonnet-4@20250514': {
    id: 'claude-sonnet-4@20250514',
    name: 'Claude Sonnet 4',
    provider: 'anthropic',
    description: 'Previous Sonnet generation.',
    contextWindow: 200000,
    maxTokens: 64000,
    inputPrice: 3,
    outputPrice: 15,
    regions: ['us-east5', 'europe-west1', 'asia-east1', 'global'],
    capabilities: ['text', 'vision', 'tools', 'thinking']
  },
  'claude-haiku-4-5@20251001': {
    id: 'claude-haiku-4-5@20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    description: 'Fastest and most affordable. Great for coding.',
    contextWindow: 200000,
    maxTokens: 64000,
    inputPrice: 0.80,
    outputPrice: 4,
    regions: ['us-east5', 'europe-west1', 'asia-east1', 'global'],
    capabilities: ['text', 'vision', 'tools', 'thinking']
  },
  'claude-opus-4@20250410': {
    id: 'claude-opus-4@20250410',
    name: 'Claude Opus 4',
    provider: 'anthropic',
    description: 'Previous Opus generation.',
    contextWindow: 200000,
    maxTokens: 64000,
    inputPrice: 15,
    outputPrice: 75,
    regions: ['us-east5', 'europe-west1', 'asia-southeast1', 'global'],
    capabilities: ['text', 'vision', 'tools']
  },
  // Gemini Models
  'gemini-3-pro-preview': {
    id: 'gemini-3-pro-preview',
    name: 'Gemini 3 Pro',
    provider: 'google',
    description: 'Latest Gemini with multimodal.',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputPrice: 2.5,
    outputPrice: 15,
    regions: ['global'],
    capabilities: ['text', 'vision', 'audio', 'video', 'tools']
  },
  'gemini-3-pro-image-preview': {
    id: 'gemini-3-pro-image-preview',
    name: 'Gemini 3 Pro Image',
    provider: 'google',
    description: 'Native image generation.',
    contextWindow: 65536,
    maxTokens: 32768,
    inputPrice: 2.5,
    outputPrice: 15,
    regions: ['global'],
    capabilities: ['text', 'vision', 'image-generation']
  },
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    description: 'Previous Gemini Pro.',
    contextWindow: 1000000,
    maxTokens: 8192,
    inputPrice: 1.25,
    outputPrice: 5,
    regions: ['us-central1', 'europe-west4'],
    capabilities: ['text', 'vision', 'tools']
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'google',
    description: 'Fast and affordable Gemini.',
    contextWindow: 1000000,
    maxTokens: 8192,
    inputPrice: 0.15,
    outputPrice: 0.60,
    regions: ['us-central1', 'europe-west4'],
    capabilities: ['text', 'vision', 'tools']
  },
  'gemini-2.5-flash-lite': {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite',
    provider: 'google',
    description: 'Most affordable Gemini.',
    contextWindow: 1000000,
    maxTokens: 8192,
    inputPrice: 0.075,
    outputPrice: 0.30,
    regions: ['us-central1', 'europe-west4'],
    capabilities: ['text']
  },
  // Imagen Models
  'imagen-4.0-generate-001': {
    id: 'imagen-4.0-generate-001',
    name: 'Imagen 4 Generate',
    provider: 'imagen',
    description: 'Best quality image generation.',
    contextWindow: 0,
    maxTokens: 0,
    inputPrice: 0.04,
    outputPrice: 0,
    regions: ['us-central1'],
    capabilities: ['image-generation']
  },
  'imagen-4.0-fast-generate-001': {
    id: 'imagen-4.0-fast-generate-001',
    name: 'Imagen 4 Fast',
    provider: 'imagen',
    description: 'Faster image generation.',
    contextWindow: 0,
    maxTokens: 0,
    inputPrice: 0.02,
    outputPrice: 0,
    regions: ['us-central1'],
    capabilities: ['image-generation']
  },
  'imagen-4.0-ultra-generate-001': {
    id: 'imagen-4.0-ultra-generate-001',
    name: 'Imagen 4 Ultra',
    provider: 'imagen',
    description: 'Highest quality images.',
    contextWindow: 0,
    maxTokens: 0,
    inputPrice: 0.08,
    outputPrice: 0,
    regions: ['us-central1'],
    capabilities: ['image-generation']
  }
};

// ============================================================================
// Helper Functions
// ============================================================================

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadConfig(): Config {
  const defaultConfig: Config = {
    project_id: process.env.GOOGLE_CLOUD_PROJECT || '',
    default_region: 'us-east5',
    google_region: 'us-central1',
    model_aliases: {},
    fallback_chains: {},
    default_model: 'claude-sonnet-4-5@20250929',
    enabled_models: [],
    auto_truncate: true,
    reserve_output_tokens: 4096
  };

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf8');
      const fileConfig = yaml.load(content) as Partial<Config>;
      return { ...defaultConfig, ...fileConfig };
    }
  } catch (e) {}

  return defaultConfig;
}

function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  
  const enabledModelsYaml = config.enabled_models.length > 0 
    ? config.enabled_models.map(m => `  - "${m}"`).join('\n')
    : '  []';
    
  const aliasesYaml = Object.keys(config.model_aliases).length > 0
    ? Object.entries(config.model_aliases).map(([k, v]) => `  ${k}: "${v}"`).join('\n')
    : '  {}';
    
  const fallbacksYaml = Object.keys(config.fallback_chains).length > 0
    ? Object.entries(config.fallback_chains).map(([k, v]) => 
        `  "${k}":\n${v.map(m => `    - "${m}"`).join('\n')}`
      ).join('\n')
    : '  {}';
  
  const yamlContent = `# Vertex AI Proxy Configuration
# Generated: ${new Date().toISOString()}

project_id: "${config.project_id}"
default_region: "${config.default_region}"
google_region: "${config.google_region}"

default_model: "${config.default_model}"

enabled_models:
${enabledModelsYaml}

model_aliases:
${aliasesYaml}

fallback_chains:
${fallbacksYaml}

auto_truncate: ${config.auto_truncate}
reserve_output_tokens: ${config.reserve_output_tokens}
`;

  fs.writeFileSync(CONFIG_FILE, yamlContent);
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await prompt(`${question} ${hint} `);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

async function promptSelect(question: string, options: string[]): Promise<number> {
  console.log(question);
  options.forEach((opt, i) => console.log(chalk.gray(`  ${i + 1}) ${opt}`)));
  const answer = await prompt(chalk.cyan('Select (number): '));
  const num = parseInt(answer);
  if (isNaN(num) || num < 1 || num > options.length) return 0;
  return num - 1;
}

function formatPrice(input: number, output: number): string {
  if (input === 0 && output === 0) return chalk.green('Per-image');
  return chalk.yellow(`$${input}/$${output}`);
}

function formatCapabilities(caps: string[]): string {
  const icons: Record<string, string> = {
    'text': '📝', 'vision': '👁️', 'audio': '🎵', 'video': '🎬',
    'tools': '🔧', 'thinking': '🧠', 'image-generation': '🎨', 'image-edit': '✏️',
    'computer-use': '🖥️'
  };
  return caps.map(c => icons[c] || c).join(' ');
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// ============================================================================
// Daemon Management
// ============================================================================

function getPid(): number | null {
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
      if (!isNaN(pid)) return pid;
    }
  } catch (e) {}
  return null;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function loadStats(): ProxyStats | null {
  try {
    if (fs.existsSync(STATS_FILE)) {
      return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    }
  } catch (e) {}
  return null;
}

async function startDaemon(options: any) {
  console.log(chalk.blue.bold('\n🚀 Starting Vertex AI Proxy Daemon\n'));
  
  const existingPid = getPid();
  if (existingPid && isRunning(existingPid)) {
    console.log(chalk.yellow(`⚠️  Proxy already running (PID: ${existingPid})`));
    console.log(chalk.gray('   Use: vertex-ai-proxy restart'));
    return;
  }
  
  const config = loadConfig();
  let projectId = options.project || config.project_id || process.env.GOOGLE_CLOUD_PROJECT;
  
  if (!projectId) {
    console.log(chalk.red('Project ID required. Use --project or run config set'));
    process.exit(1);
  }
  
  const port = options.port || '8001';
  ensureDataDir();
  
  // Build the command to run
  const distPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
  const srcPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
  let serverPath = fs.existsSync(distPath) ? distPath : srcPath;
  
  // Spawn detached process
  const env = {
    ...process.env,
    GOOGLE_CLOUD_PROJECT: projectId,
    VERTEX_PROXY_PORT: port,
    VERTEX_PROXY_REGION: options.region || config.default_region,
    VERTEX_PROXY_GOOGLE_REGION: options.googleRegion || config.google_region,
    VERTEX_PROXY_START: '1'
  };
  
  const logStream = fs.openSync(LOG_FILE, 'a');
  
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: ['ignore', logStream, logStream],
    env
  });
  
  // Write PID file
  fs.writeFileSync(PID_FILE, child.pid!.toString());
  
  // Unref to allow parent to exit
  child.unref();
  
  console.log(chalk.green(`✓ Started daemon`));
  console.log(chalk.gray(`   PID:  ${child.pid}`));
  console.log(chalk.gray(`   Port: ${port}`));
  console.log(chalk.gray(`   Logs: ${LOG_FILE}`));
  console.log();
  console.log(chalk.gray('Commands:'));
  console.log(chalk.gray('  vertex-ai-proxy status   - Check status'));
  console.log(chalk.gray('  vertex-ai-proxy logs     - View logs'));
  console.log(chalk.gray('  vertex-ai-proxy stop     - Stop daemon'));
}

async function stopDaemon() {
  console.log(chalk.blue.bold('\n🛑 Stopping Vertex AI Proxy\n'));
  
  const pid = getPid();
  if (!pid) {
    console.log(chalk.yellow('⚠️  No PID file found. Proxy may not be running.'));
    return;
  }
  
  if (!isRunning(pid)) {
    console.log(chalk.yellow(`⚠️  Process ${pid} not running. Cleaning up PID file.`));
    fs.unlinkSync(PID_FILE);
    return;
  }
  
  try {
    process.kill(pid, 'SIGTERM');
    console.log(chalk.green(`✓ Sent SIGTERM to PID ${pid}`));
    
    // Wait for process to exit
    let attempts = 0;
    while (isRunning(pid) && attempts < 10) {
      await new Promise(resolve => setTimeout(resolve, 500));
      attempts++;
    }
    
    if (isRunning(pid)) {
      console.log(chalk.yellow('   Process still running, sending SIGKILL...'));
      process.kill(pid, 'SIGKILL');
    }
    
    // Clean up PID file
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
    
    console.log(chalk.green('✓ Daemon stopped'));
  } catch (e: any) {
    console.log(chalk.red(`Error stopping daemon: ${e.message}`));
  }
}

async function restartDaemon(options: any) {
  console.log(chalk.blue.bold('\n🔄 Restarting Vertex AI Proxy\n'));
  
  const pid = getPid();
  if (pid && isRunning(pid)) {
    await stopDaemon();
    // Wait a moment for port to free
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  await startDaemon(options);
}

async function showStatus() {
  console.log(chalk.blue.bold('\n📊 Vertex AI Proxy Status\n'));
  
  const pid = getPid();
  const stats = loadStats();
  const config = loadConfig();
  
  // Process status
  console.log(chalk.cyan('Process:'));
  if (pid && isRunning(pid)) {
    console.log(chalk.green(`  ✓ Running (PID: ${pid})`));
  } else if (pid) {
    console.log(chalk.red(`  ✗ Not running (stale PID: ${pid})`));
  } else {
    console.log(chalk.red('  ✗ Not running'));
  }
  
  // Stats
  if (stats) {
    console.log();
    console.log(chalk.cyan('Stats:'));
    console.log(`  Port:           ${stats.port}`);
    console.log(`  Uptime:         ${formatUptime(Date.now() - stats.startTime)}`);
    console.log(`  Requests:       ${stats.requestCount}`);
    if (stats.lastRequestTime) {
      const ago = formatUptime(Date.now() - stats.lastRequestTime);
      console.log(`  Last request:   ${ago} ago`);
    }
  }
  
  // Configuration
  console.log();
  console.log(chalk.cyan('Configuration:'));
  console.log(`  Project:        ${config.project_id || chalk.red('Not set')}`);
  console.log(`  Claude region:  ${config.default_region}`);
  console.log(`  Gemini region:  ${config.google_region}`);
  console.log(`  Default model:  ${config.default_model}`);
  
  // Health check
  if (pid && isRunning(pid) && stats) {
    console.log();
    console.log(chalk.cyan('Health Check:'));
    const spinner = ora('Checking...').start();
    
    try {
      const response = await fetch(`http://localhost:${stats.port}/health`, {
        signal: AbortSignal.timeout(5000)
      });
      
      if (response.ok) {
        const data = await response.json() as any;
        spinner.succeed(chalk.green(`Healthy - ${data.requestCount || 0} requests, uptime ${formatUptime((data.uptime || 0) * 1000)}`));
      } else {
        spinner.fail(chalk.red(`Unhealthy - HTTP ${response.status}`));
      }
    } catch (e: any) {
      spinner.fail(chalk.red(`Failed - ${e.message}`));
    }
  }
  
  // Files
  console.log();
  console.log(chalk.cyan('Files:'));
  console.log(`  Config:  ${CONFIG_FILE} ${fs.existsSync(CONFIG_FILE) ? chalk.green('✓') : chalk.gray('(not found)')}`);
  console.log(`  PID:     ${PID_FILE} ${fs.existsSync(PID_FILE) ? chalk.green('✓') : chalk.gray('(not found)')}`);
  console.log(`  Logs:    ${LOG_FILE} ${fs.existsSync(LOG_FILE) ? chalk.green('✓') : chalk.gray('(not found)')}`);
  console.log(`  Stats:   ${STATS_FILE} ${fs.existsSync(STATS_FILE) ? chalk.green('✓') : chalk.gray('(not found)')}`);
  
  console.log();
}

async function showLogs(options: any) {
  const lines = options.lines || 50;
  
  if (!fs.existsSync(LOG_FILE)) {
    console.log(chalk.yellow('No log file found. Proxy may not have run yet.'));
    console.log(chalk.gray(`Expected: ${LOG_FILE}`));
    return;
  }
  
  if (options.follow) {
    console.log(chalk.blue.bold(`📜 Tailing ${LOG_FILE}\n`));
    console.log(chalk.gray('Press Ctrl+C to exit\n'));
    
    // Use tail -f
    const tail = spawn('tail', ['-f', '-n', lines.toString(), LOG_FILE], {
      stdio: 'inherit'
    });
    
    // Handle Ctrl+C
    process.on('SIGINT', () => {
      tail.kill();
      process.exit(0);
    });
    
    await new Promise<void>((resolve) => {
      tail.on('close', resolve);
    });
  } else {
    console.log(chalk.blue.bold(`📜 Last ${lines} lines of ${LOG_FILE}\n`));
    
    try {
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      const allLines = content.trim().split('\n');
      const lastLines = allLines.slice(-lines);
      
      for (const line of lastLines) {
        // Color code by level
        if (line.includes('[ERROR]')) {
          console.log(chalk.red(line));
        } else if (line.includes('[WARN]')) {
          console.log(chalk.yellow(line));
        } else {
          console.log(line);
        }
      }
      
      console.log();
      console.log(chalk.gray(`Tip: vertex-ai-proxy logs -f (follow mode)`));
    } catch (e: any) {
      console.log(chalk.red(`Error reading log: ${e.message}`));
    }
  }
}

// ============================================================================
// Update Command
// ============================================================================

async function runUpdate(options: any) {
  console.log(chalk.blue.bold('\n📦 Updating Vertex AI Proxy\n'));
  
  const spinner = ora('Checking for updates...').start();
  
  try {
    // Check current version
    const currentVersion = VERSION;
    
    // Check npm for latest version
    let latestVersion: string;
    try {
      const npmInfo = execSync('npm view vertex-ai-proxy version 2>/dev/null', { encoding: 'utf8' }).trim();
      latestVersion = npmInfo;
    } catch (e) {
      spinner.fail('Failed to check npm registry');
      console.log(chalk.gray('   Ensure you have npm access'));
      return;
    }
    
    if (currentVersion === latestVersion) {
      spinner.succeed(`Already at latest version (${currentVersion})`);
      return;
    }
    
    spinner.text = `Updating ${currentVersion} → ${latestVersion}...`;
    
    // Stop daemon if running
    const pid = getPid();
    if (pid && isRunning(pid)) {
      spinner.text = 'Stopping daemon...';
      await stopDaemon();
    }
    
    // Run npm update
    spinner.text = 'Installing update...';
    
    const installCmd = options.global 
      ? 'npm install -g vertex-ai-proxy@latest'
      : 'npm install vertex-ai-proxy@latest';
    
    execSync(installCmd, { stdio: 'pipe' });
    
    spinner.succeed(`Updated to version ${latestVersion}`);
    
    // Restart if was running
    if (pid && isRunning(pid)) {
      console.log(chalk.gray('   Restarting daemon...'));
      await startDaemon({});
    }
    
    console.log();
    console.log(chalk.gray('Tip: Run `vertex-ai-proxy status` to verify'));
    
  } catch (e: any) {
    spinner.fail(`Update failed: ${e.message}`);
    console.log(chalk.gray('\nTry manually: npm install -g vertex-ai-proxy@latest'));
  }
}

// ============================================================================
// Test Command
// ============================================================================

async function runTest(options: any) {
  console.log(chalk.blue.bold('\n🧪 Running Proxy Tests\n'));
  
  const stats = loadStats();
  const port = options.port || stats?.port || 8001;
  const proxyUrl = `http://localhost:${port}`;
  
  // Check if proxy is running
  const pid = getPid();
  if (!pid || !isRunning(pid)) {
    console.log(chalk.yellow('⚠️  Proxy not running. Starting...'));
    await startDaemon({ port: port.toString() });
    // Wait for startup
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Define tests
  const tests = [
    { name: 'Health endpoint', test: testHealth },
    { name: 'Models endpoint', test: testModels },
    { name: 'Gemini text', test: testGeminiText },
    { name: 'Gemini vision', test: testGeminiVision },
  ];
  
  if (options.all) {
    tests.push(
      { name: 'Claude text', test: testClaudeText },
      { name: 'Imagen generation', test: testImagen },
      { name: 'Gemini native image', test: testGeminiImage },
    );
  }
  
  let passed = 0;
  let failed = 0;
  
  for (const { name, test } of tests) {
    const spinner = ora(name).start();
    try {
      const result = await test(proxyUrl);
      spinner.succeed(`${name}: ${result}`);
      passed++;
    } catch (e: any) {
      spinner.fail(`${name}: ${e.message}`);
      failed++;
    }
  }
  
  console.log();
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`Results: ${chalk.green(`${passed} passed`)}, ${failed > 0 ? chalk.red(`${failed} failed`) : '0 failed'}`);
  
  if (!options.all) {
    console.log(chalk.gray('\nTip: vertex-ai-proxy test --all (include Claude, Imagen)'));
  }
}

async function testHealth(url: string): Promise<string> {
  const response = await fetch(`${url}/health`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as any;
  return `uptime ${data.uptime}s`;
}

async function testModels(url: string): Promise<string> {
  const response = await fetch(`${url}/v1/models`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as any;
  return `${data.data?.length || 0} models`;
}

async function testGeminiText(url: string): Promise<string> {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Say "ok" and nothing else' }],
      max_tokens: 10
    })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as any;
  const text = data.choices?.[0]?.message?.content || '';
  return `"${text.slice(0, 20)}"`;
}

async function testGeminiVision(url: string): Promise<string> {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-3-pro-preview',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What logo? One word.' },
          { type: 'image_url', image_url: { url: 'https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png' }}
        ]
      }],
      max_tokens: 100
    })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as any;
  const text = data.choices?.[0]?.message?.content || '';
  return `"${text.slice(0, 20)}"`;
}

async function testClaudeText(url: string): Promise<string> {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5@20251001',
      messages: [{ role: 'user', content: 'Say "ok"' }],
      max_tokens: 10
    })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as any;
  const text = data.choices?.[0]?.message?.content || '';
  return `"${text.slice(0, 20)}"`;
}

async function testImagen(url: string): Promise<string> {
  const response = await fetch(`${url}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'imagen-4.0-generate-001',
      prompt: 'red circle',
      n: 1
    })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as any;
  const size = data.data?.[0]?.b64_json?.length || 0;
  if (size === 0) throw new Error('No image returned');
  return `${Math.round(size / 1024)}KB`;
}

async function testGeminiImage(url: string): Promise<string> {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-3-pro-image-preview',
      messages: [{ role: 'user', content: 'Draw a blue square' }],
      max_tokens: 8000
    })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as any;
  const size = data.images?.[0]?.b64_json?.length || 0;
  if (size === 0) {
    const text = data.choices?.[0]?.message?.content || '';
    return `text only: "${text.slice(0, 20)}"`;
  }
  return `${Math.round(size / 1024)}KB`;
}

// ============================================================================
// Commands
// ============================================================================

const program = new Command();

program
  .name('vertex-ai-proxy')
  .description('Proxy server for Vertex AI models with OpenAI-compatible API')
  .version(VERSION);

// --- Daemon management commands ---
program.command('start')
  .description('Start the proxy as a background daemon')
  .option('-p, --port <port>', 'Port', '8001')
  .option('--project <project>', 'GCP Project ID')
  .option('--region <region>', 'Claude region', 'us-east5')
  .option('--google-region <region>', 'Gemini region', 'us-central1')
  .action(startDaemon);

program.command('stop')
  .description('Stop the background daemon')
  .action(stopDaemon);

program.command('restart')
  .description('Restart the background daemon')
  .option('-p, --port <port>', 'Port', '8001')
  .option('--project <project>', 'GCP Project ID')
  .option('--region <region>', 'Claude region', 'us-east5')
  .option('--google-region <region>', 'Gemini region', 'us-central1')
  .action(restartDaemon);

program.command('status')
  .alias('health')
  .description('Show proxy status and health')
  .action(showStatus);

program.command('logs')
  .description('Show proxy logs')
  .option('-f, --follow', 'Follow log output (tail -f style)')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .action(showLogs);

// --- New commands ---
program.command('update')
  .description('Update vertex-ai-proxy from npm')
  .option('-g, --global', 'Update global installation')
  .action(runUpdate);

program.command('test')
  .description('Run proxy test suite')
  .option('-p, --port <port>', 'Proxy port')
  .option('-a, --all', 'Run all tests including Claude and Imagen')
  .action(runTest);

// --- models command ---
const modelsCmd = program.command('models').description('List and manage models');

modelsCmd
  .command('list').alias('ls')
  .description('List all known models')
  .option('-a, --all', 'Show all details')
  .option('-p, --provider <provider>', 'Filter by provider')
  .option('--json', 'Output as JSON')
  .action(listModels);

modelsCmd.command('fetch')
  .description('Check model availability in Vertex AI')
  .action(fetchModels);

modelsCmd.command('info <model>')
  .description('Show detailed model info')
  .action(showModelInfo);

modelsCmd.command('enable <model>')
  .description('Enable a model in config')
  .option('--alias <alias>', 'Set an alias')
  .action(enableModel);

modelsCmd.command('disable <model>')
  .description('Disable a model')
  .action(disableModel);


modelsCmd.command("discover")
  .description("Probe Vertex AI to discover available Claude models per region")
  .action(async () => {
    console.log(chalk.blue.bold("\n🔍 Discovering Available Claude Models\n"));
    
    const config = loadConfig();
    if (!config.project_id) {
      console.log(chalk.red("No project ID. Run: vertex-ai-proxy config set"));
      return;
    }

    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const accessToken = tokenResponse.token;

    const REGIONS = ["us-east5", "europe-west1", "asia-southeast1", "asia-east1"];
    const CLAUDE_MODELS = [
      "claude-opus-4-5@20251101",
      "claude-sonnet-4-5@20250929",
      "claude-sonnet-4@20250514",
      "claude-haiku-4-5@20251001",
      "claude-3-haiku@20240307",
      "claude-3-5-sonnet@20240620",
      "claude-3-5-sonnet-v2@20241022",
    ];

    const results: Record<string, string[]> = {};

    for (const modelId of CLAUDE_MODELS) {
      results[modelId] = [];
      process.stdout.write(chalk.cyan(`  ${modelId}:`));
      
      for (const region of REGIONS) {
        const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${config.project_id}/locations/${region}/publishers/anthropic/models/${modelId}:rawPredict`;
        
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              anthropic_version: "vertex-2023-10-16",
              max_tokens: 1,
              messages: [{ role: "user", content: "hi" }]
            })
          });

          if (response.ok) {
            results[modelId].push(region);
            process.stdout.write(chalk.green(` ${region}✓`));
          } else {
            process.stdout.write(chalk.gray(` ${region}✗`));
          }
        } catch (e) {
          process.stdout.write(chalk.red(` ${region}!`));
        }
      }
      console.log();
    }

    // Save to cache
    ensureDataDir();
    const cacheFile = path.join(DATA_DIR, "model_regions.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ updated: Date.now(), models: results }, null, 2));
    
    console.log(chalk.green(`\n✓ Saved to ${cacheFile}`));
    
    // Summary
    console.log(chalk.yellow.bold("\n📊 Available Models:\n"));
    for (const [modelId, regions] of Object.entries(results)) {
      if (regions.length > 0) {
        console.log(`  ${chalk.green("✓")} ${modelId}: ${regions.join(", ")}`);
      } else {
        console.log(`  ${chalk.red("✗")} ${modelId}: not available`);
      }
    }
    
    console.log(chalk.gray("\nNote: Enable Claude at https://console.cloud.google.com/vertex-ai/model-garden"));
  });

modelsCmd.action(() => listModels({}));

// --- config command ---
const configCmd = program.command('config').description('Manage configuration');

configCmd.command('show')
  .description('Show current config')
  .option('--json', 'Output as JSON')
  .action(showConfig);

configCmd.command('set')
  .description('Interactive config setup')
  .action(interactiveConfig);

configCmd.command('set-default <model>')
  .description('Set default model')
  .action(setDefaultModel);

configCmd.command('add-alias <alias> <model>')
  .description('Add model alias')
  .action(addAlias);

configCmd.command('remove-alias <alias>')
  .description('Remove alias')
  .action(removeAlias);

configCmd.command('set-fallback <model> <fallbacks...>')
  .description('Set fallback chain')
  .action(setFallback);

configCmd.command('export')
  .description('Export for OpenClaw')
  .option('-o, --output <file>', 'Output file')
  .action(exportForOpenClaw);

configCmd.action(() => showConfig({}));

// --- other commands ---
program.command('setup-openclaw')
  .description('Configure OpenClaw integration')
  .option('--project <project>', 'GCP Project ID')
  .option('--port <port>', 'Proxy port', '8001')
  .action(setupOpenClaw);

program.command('check')
  .description('Check Google Cloud setup')
  .action(checkSetup);

program.command('install-service')
  .description('Install as systemd service')
  .option('--project <project>', 'GCP Project ID')
  .option('--port <port>', 'Proxy port', '8001')
  .option('--user', 'Install as user service')
  .action(installService);

// Default: start server (foreground)
program
  .option('-p, --port <port>', 'Port', '8001')
  .option('--project <project>', 'GCP Project ID')
  .option('--region <region>', 'Claude region', 'us-east5')
  .option('--google-region <region>', 'Gemini region', 'us-central1')
  .action((options, command) => {
    if (command.args.length === 0) startServer(options);
  });

// ============================================================================
// Command Implementations
// ============================================================================

async function listModels(options: any) {
  console.log(chalk.blue.bold('\n📋 Available Vertex AI Models\n'));
  
  const config = loadConfig();
  let models = Object.values(MODEL_CATALOG);
  
  if (options.provider) {
    models = models.filter(m => m.provider === options.provider);
  }
  
  if (options.json) {
    console.log(JSON.stringify(models, null, 2));
    return;
  }
  
  const byProvider: Record<string, ModelInfo[]> = {};
  for (const model of models) {
    if (!byProvider[model.provider]) byProvider[model.provider] = [];
    byProvider[model.provider].push(model);
  }
  
  const providerNames: Record<string, string> = {
    anthropic: '🤖 Claude (Anthropic)',
    google: '✨ Gemini (Google)',
    imagen: '🎨 Imagen (Google)'
  };
  
  for (const [provider, providerModels] of Object.entries(byProvider)) {
    console.log(chalk.yellow.bold(`\n${providerNames[provider] || provider}\n`));
    
    for (const model of providerModels) {
      const isEnabled = config.enabled_models.includes(model.id);
      const isDefault = config.default_model === model.id;
      
      const status = isDefault ? chalk.green('★ DEFAULT') : 
                     isEnabled ? chalk.blue('✓ enabled') : chalk.gray('○');
      
      console.log(`  ${status} ${chalk.white.bold(model.id)}`);
      console.log(`     ${chalk.gray(model.name)} - ${model.description}`);
      
      if (options.all) {
        console.log(`     ${chalk.cyan('Context:')} ${(model.contextWindow / 1000).toFixed(0)}K`);
        console.log(`     ${chalk.cyan('Max out:')} ${(model.maxTokens / 1000).toFixed(0)}K`);
        console.log(`     ${chalk.cyan('Price:')} ${formatPrice(model.inputPrice, model.outputPrice)} /1M tok`);
        console.log(`     ${chalk.cyan('Regions:')} ${model.regions.join(', ')}`);
        console.log(`     ${chalk.cyan('Caps:')} ${formatCapabilities(model.capabilities)}`);
      }
      console.log();
    }
  }
  
  if (Object.keys(config.model_aliases).length > 0) {
    console.log(chalk.yellow.bold('\n🏷️  Your Aliases\n'));
    for (const [alias, target] of Object.entries(config.model_aliases)) {
      console.log(`  ${chalk.cyan(alias)} → ${target}`);
    }
  }
  
  console.log(chalk.gray('\nTip: vertex-ai-proxy models info <model>'));
  console.log(chalk.gray('     vertex-ai-proxy models enable <model>'));
}

async function fetchModels() {
  console.log(chalk.blue.bold('\n🔍 Checking Vertex AI Models...\n'));
  
  const config = loadConfig();
  if (!config.project_id) {
    console.log(chalk.red('No project ID. Run: vertex-ai-proxy config set'));
    return;
  }
  
  const spinner = ora('Checking models...').start();
  
  for (const [id, model] of Object.entries(MODEL_CATALOG)) {
    if (model.provider !== 'anthropic') continue;
    spinner.text = `Checking ${model.name}...`;
    
    try {
      execSync(
        `gcloud ai models describe publishers/anthropic/models/${id.split('@')[0]} --region=${config.default_region} --project=${config.project_id} 2>&1`,
        { encoding: 'utf8', timeout: 10000 }
      );
      MODEL_CATALOG[id].available = true;
    } catch (e: any) {
      MODEL_CATALOG[id].available = e.message?.includes('not found') ? false : undefined;
    }
  }
  
  spinner.succeed('Check complete');
  
  console.log(chalk.yellow.bold('\n📊 Model Availability\n'));
  for (const [id, model] of Object.entries(MODEL_CATALOG)) {
    if (model.provider !== 'anthropic') continue;
    const status = model.available === true ? chalk.green('✓ Available') :
                   model.available === false ? chalk.red('✗ Not enabled') :
                   chalk.yellow('? Unknown');
    console.log(`  ${status} ${model.name} (${id})`);
  }
  
  console.log(chalk.gray('\nEnable models at: https://console.cloud.google.com/vertex-ai/model-garden'));
}

async function showModelInfo(modelId: string) {
  let model = MODEL_CATALOG[modelId];
  
  if (!model) {
    const matches = Object.entries(MODEL_CATALOG).filter(([id, m]) => 
      id.includes(modelId) || m.name.toLowerCase().includes(modelId.toLowerCase())
    );
    if (matches.length === 0) {
      console.log(chalk.red(`Not found: ${modelId}`));
      return;
    }
    if (matches.length > 1) {
      console.log(chalk.yellow('Multiple matches:'));
      matches.forEach(([id, m]) => console.log(`  - ${id} (${m.name})`));
      return;
    }
    model = matches[0][1];
  }
  
  const config = loadConfig();
  
  console.log(chalk.blue.bold(`\n📖 ${model.name}\n`));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`${chalk.cyan('ID:')}           ${model.id}`);
  console.log(`${chalk.cyan('Provider:')}     ${model.provider}`);
  console.log(`${chalk.cyan('Description:')}  ${model.description}`);
  console.log();
  console.log(`${chalk.cyan('Context:')}      ${(model.contextWindow / 1000).toFixed(0)}K tokens`);
  console.log(`${chalk.cyan('Max Output:')}   ${(model.maxTokens / 1000).toFixed(0)}K tokens`);
  console.log(`${chalk.cyan('Price:')}        $${model.inputPrice} in / $${model.outputPrice} out (per 1M)`);
  console.log();
  console.log(`${chalk.cyan('Regions:')}      ${model.regions.join(', ')}`);
  console.log(`${chalk.cyan('Capabilities:')} ${formatCapabilities(model.capabilities)}`);
  console.log(chalk.gray('─'.repeat(50)));
  
  const isDefault = config.default_model === model.id;
  const isEnabled = config.enabled_models.includes(model.id);
  
  if (isDefault) console.log(chalk.green('★ This is your default model'));
  else if (isEnabled) console.log(chalk.blue('✓ Enabled in your config'));
  else console.log(chalk.gray(`○ Not enabled. Run: vertex-ai-proxy models enable ${model.id}`));
  
  const aliases = Object.entries(config.model_aliases)
    .filter(([_, t]) => t === model.id).map(([a]) => a);
  if (aliases.length > 0) console.log(chalk.cyan(`\nAliases: ${aliases.join(', ')}`));
}

async function enableModel(modelId: string, options: any) {
  const model = MODEL_CATALOG[modelId];
  if (!model) {
    console.log(chalk.red(`Not found: ${modelId}`));
    return;
  }
  
  const config = loadConfig();
  if (!config.enabled_models.includes(modelId)) {
    config.enabled_models.push(modelId);
  }
  if (options.alias) {
    config.model_aliases[options.alias] = modelId;
  }
  saveConfig(config);
  
  console.log(chalk.green(`✓ Enabled ${model.name}`));
  if (options.alias) console.log(chalk.blue(`  Alias: ${options.alias} → ${modelId}`));
}

async function disableModel(modelId: string) {
  const config = loadConfig();
  config.enabled_models = config.enabled_models.filter(m => m !== modelId);
  for (const [alias, target] of Object.entries(config.model_aliases)) {
    if (target === modelId) delete config.model_aliases[alias];
  }
  saveConfig(config);
  console.log(chalk.yellow(`✓ Disabled ${modelId}`));
}

async function showConfig(options: any) {
  const config = loadConfig();
  
  if (options.json) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  
  console.log(chalk.blue.bold('\n⚙️  Configuration\n'));
  console.log(`${chalk.cyan('Config file:')}    ${CONFIG_FILE}`);
  console.log(`${chalk.cyan('Project ID:')}     ${config.project_id || chalk.red('Not set')}`);
  console.log(`${chalk.cyan('Claude region:')}  ${config.default_region}`);
  console.log(`${chalk.cyan('Gemini region:')}  ${config.google_region}`);
  console.log(`${chalk.cyan('Default model:')} ${config.default_model}`);
  
  if (config.enabled_models.length > 0) {
    console.log(chalk.yellow.bold('\n📦 Enabled Models\n'));
    config.enabled_models.forEach(m => {
      const model = MODEL_CATALOG[m];
      console.log(`  • ${m} ${chalk.gray(`(${model?.name || 'unknown'})`)}`);
    });
  }
  
  if (Object.keys(config.model_aliases).length > 0) {
    console.log(chalk.yellow.bold('\n🏷️  Aliases\n'));
    for (const [alias, target] of Object.entries(config.model_aliases)) {
      console.log(`  ${chalk.cyan(alias)} → ${target}`);
    }
  }
  
  if (Object.keys(config.fallback_chains).length > 0) {
    console.log(chalk.yellow.bold('\n🔀 Fallbacks\n'));
    for (const [model, fallbacks] of Object.entries(config.fallback_chains)) {
      console.log(`  ${model}`);
      fallbacks.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
    }
  }
}

async function interactiveConfig() {
  console.log(chalk.blue.bold('\n⚙️  Interactive Configuration\n'));
  
  const config = loadConfig();
  
  // Project ID
  let currentProject = config.project_id;
  try {
    currentProject = currentProject || execSync('gcloud config get-value project 2>/dev/null', { encoding: 'utf8' }).trim();
  } catch (e) {}
  
  const projectId = await prompt(chalk.cyan(`Project ID [${currentProject || 'none'}]: `)) || currentProject;
  if (projectId) config.project_id = projectId;
  
  // Default model
  console.log(chalk.yellow('\n📦 Select default model:\n'));
  const modelOptions = [
    'claude-opus-4-5@20251101 - Most capable ($$)',
    'claude-sonnet-4-5@20250929 - Balanced ($)',
    'claude-haiku-4-5@20251001 - Fast & cheap',
    'gemini-3-pro-preview - Google\'s best',
    'gemini-2.5-flash - Fast Gemini'
  ];
  const modelIds = [
    'claude-opus-4-5@20251101', 'claude-sonnet-4-5@20250929', 'claude-haiku-4-5@20251001',
    'gemini-3-pro-preview', 'gemini-2.5-flash'
  ];
  
  const modelChoice = await promptSelect('', modelOptions);
  config.default_model = modelIds[modelChoice];
  
  // Enable models
  if (await promptYesNo(chalk.cyan('\nEnable all Claude models?'))) {
    ['claude-opus-4-5@20251101', 'claude-sonnet-4-5@20250929', 'claude-haiku-4-5@20251001']
      .forEach(m => { if (!config.enabled_models.includes(m)) config.enabled_models.push(m); });
  }
  
  if (await promptYesNo(chalk.cyan('Enable Gemini models?'))) {
    ['gemini-3-pro-preview', 'gemini-2.5-flash']
      .forEach(m => { if (!config.enabled_models.includes(m)) config.enabled_models.push(m); });
  }
  
  // Aliases
  if (await promptYesNo(chalk.cyan('Set up common aliases (opus, sonnet, haiku, gpt-4)?'))) {
    config.model_aliases = {
      ...config.model_aliases,
      opus: 'claude-opus-4-5@20251101',
      sonnet: 'claude-sonnet-4-5@20250929',
      haiku: 'claude-haiku-4-5@20251001',
      gemini: 'gemini-3-pro-preview',
      'gemini-flash': 'gemini-2.5-flash',
      'gpt-4': 'claude-opus-4-5@20251101',
      'gpt-4o': 'claude-sonnet-4-5@20250929',
      'gpt-4o-mini': 'claude-haiku-4-5@20251001'
    };
  }
  
  // Fallbacks
  if (await promptYesNo(chalk.cyan('Set up fallback chains?'))) {
    config.fallback_chains = {
      'claude-opus-4-5@20251101': ['claude-sonnet-4-5@20250929', 'gemini-3-pro-preview'],
      'claude-sonnet-4-5@20250929': ['claude-haiku-4-5@20251001', 'gemini-2.5-flash'],
      'claude-haiku-4-5@20251001': ['gemini-2.5-flash-lite']
    };
  }
  
  saveConfig(config);
  console.log(chalk.green(`\n✓ Saved to ${CONFIG_FILE}`));
  
  // OpenClaw
  if (fs.existsSync(path.join(os.homedir(), '.openclaw'))) {
    if (await promptYesNo(chalk.cyan('\nConfigure OpenClaw?'))) {
      await setupOpenClaw({ project: config.project_id });
    }
  }
}

async function setDefaultModel(modelId: string) {
  const config = loadConfig();
  const resolved = config.model_aliases[modelId] || modelId;
  const model = MODEL_CATALOG[resolved];
  
  if (!model) {
    console.log(chalk.red(`Not found: ${modelId}`));
    return;
  }
  
  config.default_model = resolved;
  if (!config.enabled_models.includes(resolved)) {
    config.enabled_models.push(resolved);
  }
  saveConfig(config);
  
  console.log(chalk.green(`✓ Default: ${model.name} (${resolved})`));
}

async function addAlias(alias: string, modelId: string) {
  if (!MODEL_CATALOG[modelId]) {
    console.log(chalk.red(`Not found: ${modelId}`));
    return;
  }
  const config = loadConfig();
  config.model_aliases[alias] = modelId;
  saveConfig(config);
  console.log(chalk.green(`✓ ${alias} → ${modelId}`));
}

async function removeAlias(alias: string) {
  const config = loadConfig();
  if (!config.model_aliases[alias]) {
    console.log(chalk.yellow(`Not found: ${alias}`));
    return;
  }
  delete config.model_aliases[alias];
  saveConfig(config);
  console.log(chalk.green(`✓ Removed ${alias}`));
}

async function setFallback(modelId: string, fallbacks: string[]) {
  const config = loadConfig();
  config.fallback_chains[modelId] = fallbacks;
  saveConfig(config);
  console.log(chalk.green(`✓ Fallbacks for ${modelId}:`));
  fallbacks.forEach((f, i) => console.log(`   ${i + 1}. ${f}`));
}

async function exportForOpenClaw(options: any) {
  const config = loadConfig();
  
  const openclawConfig = {
    env: {
      GOOGLE_CLOUD_PROJECT: config.project_id,
      GOOGLE_CLOUD_LOCATION: config.default_region
    },
    agents: {
      defaults: {
        model: {
          primary: `vertex/${config.default_model}`,
          fallbacks: config.fallback_chains[config.default_model]?.map(m => `vertex/${m}`) || []
        }
      }
    },
    models: {
      mode: 'merge',
      providers: {
        vertex: {
          baseUrl: 'http://localhost:8001/v1',
          apiKey: 'vertex-proxy',
          api: 'anthropic-messages',
          models: config.enabled_models.map(id => {
            const m = MODEL_CATALOG[id];
            return {
              id,
              name: m?.name || id,
              input: m?.capabilities.includes('vision') ? ['text', 'image'] : ['text'],
              contextWindow: m?.contextWindow || 200000,
              maxTokens: m?.maxTokens || 8192
            };
          })
        }
      }
    }
  };
  
  const output = JSON.stringify(openclawConfig, null, 2);
  
  if (options.output) {
    fs.writeFileSync(options.output, output);
    console.log(chalk.green(`✓ Exported to ${options.output}`));
  } else {
    console.log(chalk.blue.bold('\n📋 OpenClaw Config\n'));
    console.log(chalk.gray('Add to ~/.openclaw/openclaw.json:\n'));
    console.log(output);
  }
}

async function setupOpenClaw(options: any) {
  console.log(chalk.blue.bold('\n🦞 OpenClaw Setup\n'));
  
  const config = loadConfig();
  let projectId = options.project || config.project_id;
  
  if (!projectId) {
    projectId = await prompt(chalk.cyan('GCP Project ID: '));
    if (!projectId) {
      console.log(chalk.red('Required.'));
      return;
    }
    config.project_id = projectId;
    saveConfig(config);
  }
  
  await exportForOpenClaw({});
  
  console.log(chalk.blue('\n📋 Next:\n'));
  console.log('  1. Add config to ~/.openclaw/openclaw.json');
  console.log('  2. Start proxy: vertex-ai-proxy start');
  console.log('  3. Restart OpenClaw: openclaw gateway restart');
}

async function checkSetup() {
  console.log(chalk.blue.bold('\n🔍 Checking Setup\n'));
  
  const s1 = ora('gcloud CLI...').start();
  try {
    const v = execSync('gcloud --version', { encoding: 'utf8' }).split('\n')[0];
    s1.succeed(`gcloud: ${v}`);
  } catch (e) {
    s1.fail('gcloud not found');
    console.log(chalk.yellow('  https://cloud.google.com/sdk/docs/install'));
    return;
  }
  
  const s2 = ora('Authentication...').start();
  try {
    const account = execSync('gcloud config get-value account', { encoding: 'utf8' }).trim();
    if (account) s2.succeed(`Auth: ${account}`);
    else { s2.fail('Not authenticated'); console.log(chalk.yellow('  gcloud auth login')); return; }
  } catch (e) { s2.fail('Auth check failed'); return; }
  
  const s3 = ora('ADC...').start();
  const adcPath = path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
  if (fs.existsSync(adcPath)) s3.succeed('ADC configured');
  else { s3.fail('ADC missing'); console.log(chalk.yellow('  gcloud auth application-default login')); return; }
  
  const s4 = ora('Project...').start();
  const config = loadConfig();
  let project = config.project_id;
  try { project = project || execSync('gcloud config get-value project', { encoding: 'utf8' }).trim(); } catch (e) {}
  if (project) s4.succeed(`Project: ${project}`);
  else { s4.warn('No project'); console.log(chalk.yellow('  vertex-ai-proxy config set')); }
  
  console.log(chalk.green('\n✓ Ready!\n'));
}

async function installService(options: any) {
  console.log(chalk.blue.bold('\n🔧 Install Service\n'));
  
  const config = loadConfig();
  const projectId = options.project || config.project_id;
  const port = options.port || '8001';
  
  if (!projectId) {
    console.log(chalk.red('Project required. Use --project or run config set'));
    return;
  }
  
  const user = os.userInfo().username;
  const home = os.homedir();
  const nodePath = process.execPath;
  const adcPath = path.join(home, '.config', 'gcloud', 'application_default_credentials.json');
  
  const service = `[Unit]
Description=Vertex AI Proxy
After=network.target

[Service]
Type=simple
User=${user}
Environment="GOOGLE_CLOUD_PROJECT=${projectId}"
Environment="VERTEX_PROXY_PORT=${port}"
Environment="GOOGLE_APPLICATION_CREDENTIALS=${adcPath}"
ExecStart=${nodePath} ${process.argv[1]} --port ${port}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`;

  if (options.user) {
    const serviceDir = path.join(home, '.config', 'systemd', 'user');
    const servicePath = path.join(serviceDir, 'vertex-ai-proxy.service');
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(servicePath, service);
    
    console.log(chalk.green(`✓ Created ${servicePath}\n`));
    console.log(chalk.yellow('Run:'));
    console.log('  systemctl --user daemon-reload');
    console.log('  systemctl --user enable vertex-ai-proxy');
    console.log('  systemctl --user start vertex-ai-proxy');
  } else {
    const servicePath = '/tmp/vertex-ai-proxy.service';
    fs.writeFileSync(servicePath, service);
    
    console.log(chalk.yellow('Run (sudo required):'));
    console.log(`  sudo cp ${servicePath} /etc/systemd/system/`);
    console.log('  sudo systemctl daemon-reload');
    console.log('  sudo systemctl enable vertex-ai-proxy');
    console.log('  sudo systemctl start vertex-ai-proxy');
  }
}

async function startServer(options: any) {
  console.log(chalk.blue.bold('\n🚀 Vertex AI Proxy\n'));
  
  const config = loadConfig();
  let projectId = options.project || config.project_id || process.env.GOOGLE_CLOUD_PROJECT;
  
  if (!projectId) {
    console.log(chalk.yellow('⚠️  No project ID.\n'));
    projectId = await prompt(chalk.cyan('GCP Project ID: '));
    if (!projectId) {
      console.log(chalk.red('Required.'));
      process.exit(1);
    }
  }
  
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  process.env.VERTEX_PROXY_PORT = options.port;
  process.env.VERTEX_PROXY_REGION = options.region || config.default_region;
  process.env.VERTEX_PROXY_GOOGLE_REGION = options.googleRegion || config.google_region;
  
  console.log(chalk.gray(`   Project:  ${projectId}`));
  console.log(chalk.gray(`   Port:     ${options.port}`));
  console.log(chalk.gray(`   Region:   ${process.env.VERTEX_PROXY_REGION}`));
  console.log(chalk.gray(`   Default:  ${config.default_model}\n`));
  
  try {
    // Try dist first, then src for dev
    let serverModule;
    const distPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
    const srcPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
    
    try {
      serverModule = await import(distPath);
    } catch (e) {
      serverModule = await import(srcPath);
    }
    
    await serverModule.startProxy();
  } catch (e: any) {
    console.log(chalk.red('Failed to start:'), e.message);
    console.log(chalk.gray('\nBuild first: npm run build'));
    process.exit(1);
  }
}

// ============================================================================
// Run
// ============================================================================

program.parse();
