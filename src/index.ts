/**
 * Vertex AI Proxy Server
 * 
 * Provides OpenAI and Anthropic compatible API endpoints for Google Vertex AI models.
 */

import express, { Request, Response, NextFunction } from 'express';
import { GoogleAuth } from 'google-auth-library';
import { VertexAI } from '@google-cloud/vertexai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { loadRegionCache } from './regions.js';

// ============================================================================
// Types
// ============================================================================

interface ModelSpec {
  id: string;
  name: string;
  provider: 'anthropic' | 'google' | 'imagen';
  contextWindow: number;
  maxTokens: number;
  inputPrice: number;
  outputPrice: number;
  regions: string[];
  capabilities: string[];
}

interface Config {
  project_id: string;
  default_region: string;
  google_region: string;
  model_aliases: Record<string, string>;
  fallback_chains: Record<string, string[]>;
  auto_truncate: boolean;
  reserve_output_tokens: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | any[];
  tool_call_id?: string;
  tool_calls?: any[];
  name?: string;
}

// ============================================================================
// Logging
// ============================================================================

const DATA_DIR = path.join(os.homedir(), '.vertex_proxy');
const LOG_FILE = path.join(DATA_DIR, 'proxy.log');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

interface ProxyStats {
  startTime: number;
  requestCount: number;
  lastRequestTime: number | null;
  port: number;
}

let proxyStats: ProxyStats = {
  startTime: Date.now(),
  requestCount: 0,
  lastRequestTime: null,
  port: 8001
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
  ensureDataDir();
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}\n`;
  
  // Console output
  console.log(logLine.trim());
  
  // File output
  try {
    fs.appendFileSync(LOG_FILE, logLine);
    
    // Rotate log if > 10MB
    const stats = fs.statSync(LOG_FILE);
    if (stats.size > 10 * 1024 * 1024) {
      const backupPath = LOG_FILE + '.1';
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      fs.renameSync(LOG_FILE, backupPath);
    }
  } catch (e) {
    // Ignore file logging errors
  }
}

function saveStats() {
  ensureDataDir();
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(proxyStats, null, 2));
  } catch (e) {
    // Ignore stats save errors
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

// ============================================================================
// Model Catalog
// ============================================================================

export const MODEL_CATALOG: Record<string, ModelSpec> = {
  // Claude Models
  'claude-opus-4-5@20251101': {
    id: 'claude-opus-4-5@20251101',
    name: 'Claude Opus 4.5',
    provider: 'anthropic',
    contextWindow: 200000,
    maxTokens: 64000,
    inputPrice: 15,
    outputPrice: 75,
    regions: ['us-east5', 'europe-west1', 'asia-southeast1', 'global'],
    capabilities: ['text', 'vision', 'tools']
  },
  'claude-sonnet-4-5@20250929': {
    id: 'claude-sonnet-4-5@20250929',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    contextWindow: 200000,
    maxTokens: 64000,
    inputPrice: 3,
    outputPrice: 15,
    regions: ['us-east5', 'europe-west1', 'asia-southeast1', 'global'],
    capabilities: ['text', 'vision', 'tools']
  },
  'claude-haiku-4-5@20251001': {
    id: 'claude-haiku-4-5@20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    contextWindow: 200000,
    maxTokens: 64000,
    inputPrice: 0.25,
    outputPrice: 1.25,
    regions: ['us-east5', 'europe-west1', 'asia-southeast1', 'global'],
    capabilities: ['text', 'vision', 'tools']
  },
  // Gemini Models
'gemini-3-pro-image-preview': {    id: 'gemini-3-pro-image-preview',    name: 'Gemini 3 Pro Image',    provider: 'google',    contextWindow: 65536,    maxTokens: 32768,    inputPrice: 2.5,    outputPrice: 15,    regions: ['global'],    capabilities: ['text', 'vision', 'image-generation']  },
  'gemini-3-pro-preview': {
    id: 'gemini-3-pro-preview',
    name: 'Gemini 3 Pro',
    provider: 'google',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputPrice: 2.5,
    outputPrice: 15,
    regions: ['global'],
    capabilities: ['text', 'vision', 'audio', 'video']
  },
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    contextWindow: 1000000,
    maxTokens: 64000,
    inputPrice: 1.25,
    outputPrice: 5,
    regions: ['us-central1', 'europe-west4'],
    capabilities: ['text', 'vision']
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'google',
    contextWindow: 1000000,
    maxTokens: 64000,
    inputPrice: 0.15,
    outputPrice: 0.60,
    regions: ['us-central1', 'europe-west4'],
    capabilities: ['text', 'vision']
  },
  'gemini-2.5-flash-lite': {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite',
    provider: 'google',
    contextWindow: 1000000,
    maxTokens: 64000,
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
    contextWindow: 0,
    maxTokens: 0,
    inputPrice: 0.08,
    outputPrice: 0,
    regions: ['us-central1'],
    capabilities: ['image-generation']
  }
};

// ============================================================================
// Dynamic Region Fallback
// ============================================================================

/**
 * Get ordered fallback regions for a model.
 * First checks cached discovery data, then falls back to static catalog.
 * Priority: us-east5 -> us-central1 -> europe-west1
 */
function getRegionFallbackOrder(modelId: string): string[] {
  const priorityOrder = ['us-east5', 'us-central1', 'europe-west1'];
  
  // Try cached region data first
  const cache = loadRegionCache();
  if (cache && cache.models[modelId]) {
    const cachedRegions = cache.models[modelId].availableRegions;
    if (cachedRegions.length > 0) {
      const ordered: string[] = [];
      for (const region of priorityOrder) {
        if (cachedRegions.includes(region)) {
          ordered.push(region);
        }
      }
      for (const region of cachedRegions) {
        if (!ordered.includes(region)) {
          ordered.push(region);
        }
      }
      log('Using cached regions for ' + modelId + ': ' + ordered.join(', '));
      return ordered;
    }
  }
  
  // Fall back to static catalog
  const modelSpec = MODEL_CATALOG[modelId];
  if (!modelSpec) {
    return priorityOrder;
  }
  
  const modelRegions = modelSpec.regions;
  const ordered: string[] = [];
  for (const region of priorityOrder) {
    if (modelRegions.includes(region)) ordered.push(region);
  }
  for (const region of modelRegions) {
    if (!ordered.includes(region)) ordered.push(region);
  }
  
  return ordered;
}

// ============================================================================
// Configuration
// ============================================================================

function loadConfig(): Config {
  const defaultConfig: Config = {
    project_id: process.env.GOOGLE_CLOUD_PROJECT || '',
    default_region: process.env.VERTEX_PROXY_REGION || 'us-east5',
    google_region: process.env.VERTEX_PROXY_GOOGLE_REGION || 'us-central1',
    model_aliases: {
      'gpt-4': 'claude-opus-4-5@20251101',
      'gpt-4-turbo': 'claude-sonnet-4-5@20250929',
      'gpt-4o': 'claude-sonnet-4-5@20250929',
      'gpt-4o-mini': 'claude-haiku-4-5@20251001',
      'gpt-3.5-turbo': 'claude-haiku-4-5@20251001',
      'claude': 'claude-opus-4-5@20251101',
      'claude-latest': 'claude-opus-4-5@20251101',
      'opus': 'claude-opus-4-5@20251101',
      'sonnet': 'claude-sonnet-4-5@20250929',
      'haiku': 'claude-haiku-4-5@20251001'
    },
    fallback_chains: {},
    auto_truncate: true,
    reserve_output_tokens: 4096
  };

  // Try to load config file
  const configPaths = [
    process.env.VERTEX_PROXY_CONFIG,
    path.join(os.homedir(), '.vertex-proxy', 'config.yaml'),
    path.join(os.homedir(), '.vertex-proxy', 'config.yml'),
    './config.yaml'
  ].filter(Boolean) as string[];

  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf8');
        const fileConfig = yaml.load(content) as Partial<Config>;
        return { ...defaultConfig, ...fileConfig };
      }
    } catch (e) {
      log(`Warning: Could not load config from ${configPath}`, 'WARN');
    }
  }

  return defaultConfig;
}

// ============================================================================
// Helper Functions
// ============================================================================

function resolveModel(modelInput: string, config: Config): string {
  // Check aliases first
  if (config.model_aliases[modelInput]) {
    return config.model_aliases[modelInput];
  }
  
  // Check if it's a known model
  if (MODEL_CATALOG[modelInput]) {
    return modelInput;
  }
  
  // Try adding version suffix for claude models
  if (modelInput.startsWith('claude-') && !modelInput.includes('@')) {
    // Find matching model
    for (const [id, spec] of Object.entries(MODEL_CATALOG)) {
      if (id.startsWith(modelInput)) {
        return id;
      }
    }
  }
  
  // Return as-is
  return modelInput;
}

function getModelSpec(modelId: string): ModelSpec | undefined {
  return MODEL_CATALOG[modelId];
}

function extractSystemMessage(messages: ChatMessage[]): { system: string | null; messages: ChatMessage[] } {
  let system: string | null = null;
  const filteredMessages: ChatMessage[] = [];
  
  for (const msg of messages) {
    if (msg.role === 'system') {
      // Combine multiple system messages
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      system = system ? `${system}\n\n${content}` : content;
    } else {
      filteredMessages.push(msg);
    }
  }
  
  return { system, messages: filteredMessages };
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}

function truncateMessages(
  messages: ChatMessage[],
  maxTokens: number,
  reserveTokens: number
): { messages: ChatMessage[]; truncated: boolean } {
  const targetTokens = maxTokens - reserveTokens;
  let totalTokens = 0;
  let truncated = false;
  
  // Always keep the last few messages
  const keepLast = 4;
  const lastMessages = messages.slice(-keepLast);
  const earlierMessages = messages.slice(0, -keepLast);
  
  // Estimate tokens for last messages
  for (const msg of lastMessages) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    totalTokens += estimateTokens(content);
  }
  
  // Add earlier messages from the end until we hit the limit
  const keptEarlier: ChatMessage[] = [];
  for (let i = earlierMessages.length - 1; i >= 0; i--) {
    const msg = earlierMessages[i];
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const tokens = estimateTokens(content);
    
    if (totalTokens + tokens > targetTokens) {
      truncated = true;
      break;
    }
    
    keptEarlier.unshift(msg);
    totalTokens += tokens;
  }
  
  return {
    messages: [...keptEarlier, ...lastMessages],
    truncated
  };
}

// ============================================================================
// API Handlers
// ============================================================================

async function handleChatCompletions(req: Request, res: Response, config: Config) {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const { model: modelInput, messages, stream, max_tokens, temperature, tools, tool_choice } = req.body;

  log(`[${requestId}] ====== NEW REQUEST ======`);
  log(`[${requestId}] Model: ${modelInput}, Stream: ${stream}, Messages: ${messages?.length}`);

  // Resolve model alias
  const modelId = resolveModel(modelInput, config);
  const modelSpec = getModelSpec(modelId);

  if (!modelSpec) {
    log(`[${requestId}] Unknown model: ${modelInput} -> ${modelId}`, 'WARN');
  }

  const provider = modelSpec?.provider || 'anthropic';

  // Extract system message (OpenAI format -> Anthropic format)
  const { system, messages: cleanMessages } = extractSystemMessage(messages);

  // Auto-truncate if needed
  let finalMessages = cleanMessages;
  if (config.auto_truncate && modelSpec) {
    const result = truncateMessages(
      cleanMessages,
      modelSpec.contextWindow,
      config.reserve_output_tokens
    );
    finalMessages = result.messages;
    if (result.truncated) {
      log(`[${requestId}] Truncated ${cleanMessages.length - finalMessages.length} messages to fit context`);
    }
  }

  log(`[${requestId}] Chat: ${modelInput} -> ${modelId} (${provider}), stream=${stream}, messages=${finalMessages.length}`);

  // Update stats
  proxyStats.requestCount++;
  proxyStats.lastRequestTime = Date.now();
  saveStats();

  // Track response lifecycle
  res.on('close', () => {
    log(`[${requestId}] Response closed by client`);
  });

  res.on('finish', () => {
    log(`[${requestId}] Response finished successfully`);
  });

  res.on('error', (err) => {
    log(`[${requestId}] Response error: ${err.message}`, 'ERROR');
  });
  
  try {
    if (provider === 'anthropic') {
      log(`[${requestId}] Routing to Anthropic handler`);
      await handleAnthropicChatWithFallback(res, {
        modelId,
        system,
        messages: finalMessages,
        stream: stream ?? false,
        maxTokens: max_tokens || modelSpec?.maxTokens || 4096,
        temperature,
        config,
        requestId,
        tools,
        tool_choice
      });
} else if (provider === 'google') {
      // Use @google/genai SDK for global region models (like gemini-3-pro-preview)
      const modelRegion = modelSpec?.regions?.[0];
      if (modelRegion === 'global') {
        await handleGenAIChat(res, {
          modelId,
          system,
          messages: finalMessages,
          stream: stream ?? false,
          maxTokens: max_tokens || modelSpec?.maxTokens || 4096,
          temperature,
          config
        });
      } else {
        await handleGeminiChat(res, {
          modelId,
          system,
          messages: finalMessages,
          stream: stream ?? false,
          maxTokens: max_tokens || modelSpec?.maxTokens || 4096,
          temperature,
          config,
          modelRegion
        });
      }
    } else {
      res.status(400).json({ error: `Unsupported provider: ${provider}` });
    }
  } catch (error: any) {
    log(`[${requestId}] ERROR caught in handleChatCompletions: ${error.message}`, 'ERROR');
    log(`[${requestId}] Error stack: ${error.stack}`, 'ERROR');

    // If headers already sent (streaming started), we can't send JSON error
    if (res.headersSent) {
      log(`[${requestId}] Headers already sent, ending response. Writable: ${res.writable}, Finished: ${res.writableFinished}`, 'WARN');
      if (res.writable) {
        res.end();
      }
      return;
    }

    // Try fallback if configured
    const fallbacks = config.fallback_chains[modelId];
    if (fallbacks && fallbacks.length > 0) {
      log(`[${requestId}] Trying model fallback: ${fallbacks[0]}`);
      req.body.model = fallbacks[0];
      return handleChatCompletions(req, res, config);
    }

    log(`[${requestId}] Sending error response`);
    res.status(500).json({
      error: {
        message: error.message,
        type: 'proxy_error',
        code: error.status || 500
      }
    });
  }
}

async function handleAnthropicChatWithFallback(res: Response, options: {
  modelId: string;
  system: string | null;
  messages: ChatMessage[];
  stream: boolean;
  maxTokens: number;
  temperature?: number;
  config: Config;
  modelRegion?: string;
  requestId?: string;
  tools?: any[];
  tool_choice?: any;
}) {
  const { modelId, config, requestId = 'unknown' } = options;
  const regions = getRegionFallbackOrder(modelId);

  log(`[${requestId}] Starting region fallback, available regions: ${regions.join(', ')}`);

  let lastError: any = null;

  for (const region of regions) {
    try {
      log(`[${requestId}] Trying region: ${region} for model ${modelId}`);
      await handleAnthropicChat(res, { ...options, region, requestId });
      log(`[${requestId}] Region ${region} succeeded`);
      return; // Success, exit
    } catch (error: any) {
      lastError = error;
      log(`Region ${region} failed: ${error.message}`, 'WARN');
      
      // Only retry on certain errors (capacity, unavailable, etc.)
      const shouldRetry = 
        error.status === 429 || // Rate limit
        error.status === 503 || // Service unavailable
        error.status === 500 || // Internal error
        error.message?.includes('capacity') ||
        error.message?.includes('overloaded') ||
        error.message?.includes('unavailable');
      
      if (!shouldRetry) {
        throw error; // Don't retry on client errors (400, 401, etc.)
      }
      
      // Continue to next region
    }
  }
  
  // All regions failed
  throw lastError || new Error('All regions failed');
}

async function handleAnthropicChat(res: Response, options: {
  modelId: string;
  system: string | null;
  messages: ChatMessage[];
  stream: boolean;
  maxTokens: number;
  temperature?: number;
  config: Config;
  modelRegion?: string;
  region?: string;
  requestId?: string;
  tools?: any[];
  tool_choice?: any;
}) {
  const { modelId, system, messages, stream, maxTokens, temperature, config, region, requestId = 'unknown', tools, tool_choice } = options;

  log(`[${requestId}] handleAnthropicChat: stream=${stream}, region=${region || config.default_region}`);
  
  // Get access token via google-auth-library
  const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const accessToken = tokenResponse.token;
  
  const useRegion = region || config.default_region;
  const projectId = config.project_id;
  const url = `https://${useRegion}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${useRegion}/publishers/anthropic/models/${modelId}:${stream ? 'streamRawPredict' : 'rawPredict'}`;
  
  // Convert messages to Anthropic format
  const anthropicMessages: any[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Handle tool messages (OpenAI format) -> convert to user message with tool_result
    if (msg.role === 'tool' || msg.tool_call_id) {
      // Find the corresponding assistant message with tool use
      const content: any[] = [];

      if (typeof msg.content === 'string') {
        content.push({
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || 'unknown',
          content: msg.content
        });
      }

      anthropicMessages.push({
        role: 'user',
        content
      });
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      // Assistant message with tool calls -> convert to tool_use content blocks
      const content: any[] = [];

      // Add text content if any
      if (typeof msg.content === 'string' && msg.content) {
        content.push({
          type: 'text',
          text: msg.content
        });
      }

      // Add tool use blocks
      for (const toolCall of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: JSON.parse(toolCall.function.arguments || '{}')
        });
      }

      anthropicMessages.push({
        role: 'assistant',
        content
      });
    } else {
      // Regular message
      anthropicMessages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content
      });
    }
  }
  
  const requestBody: any = {
    anthropic_version: 'vertex-2023-10-16',
    max_tokens: maxTokens,
    messages: anthropicMessages
  };

  if (system) {
    requestBody.system = system;
  }

  if (temperature !== undefined) {
    requestBody.temperature = temperature;
  }

  // Convert OpenAI-format tools to Claude's custom tool format
  if (tools && tools.length > 0) {
    const claudeTools = tools.map((tool: any) => {
      if (tool.type === 'function') {
        // Convert OpenAI function tool to Claude custom tool
        return {
          type: 'custom',
          name: tool.function.name,
          description: tool.function.description || '',
          input_schema: tool.function.parameters || {
            type: 'object',
            properties: {},
            required: []
          }
        };
      }
      // If already in Claude format, pass through
      return tool;
    });

    requestBody.tools = claudeTools;
  }

  if (tool_choice) {
    // Convert OpenAI tool_choice to Claude format if needed
    if (typeof tool_choice === 'object' && tool_choice.type === 'function') {
      requestBody.tool_choice = {
        type: 'tool',
        name: tool_choice.function?.name
      };
    } else if (tool_choice === 'auto' || tool_choice === 'none') {
      requestBody.tool_choice = { type: tool_choice };
    } else {
      requestBody.tool_choice = tool_choice;
    }
  }

  
  if (stream) {
    requestBody.stream = true;

    log(`[${requestId}] Setting up streaming response`);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    log(`[${requestId}] Sending streaming request to Vertex AI: ${url}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`[${requestId}] Vertex AI error response: ${response.status} ${errorText}`, 'ERROR');
      throw { status: response.status, message: errorText };
    }

    log(`[${requestId}] Vertex AI responded OK, starting stream`);
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const completionId = `chatcmpl-${Date.now()}`;
    let chunkCount = 0;
    let receivedMessageStop = false;

    if (reader) {
      try {
        // Send initial role chunk
        log(`[${requestId}] Sending initial role chunk`);
        res.write(`data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
        })}\n\n`);

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          log(`[${requestId}] Stream ended, total chunks: ${chunkCount}`);
          break;
        }
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            try {
              const event = JSON.parse(data);

              // Handle tool use events
              if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
                chunkCount++;
                const chunk = {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: modelId,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: 0,
                        id: event.content_block.id,
                        type: 'function',
                        function: {
                          name: event.content_block.name,
                          arguments: ''
                        }
                      }]
                    },
                    finish_reason: null
                  }]
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              } else if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
                chunkCount++;
                const chunk = {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: modelId,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: 0,
                        function: {
                          arguments: event.delta.partial_json
                        }
                      }]
                    },
                    finish_reason: null
                  }]
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                chunkCount++;
                const chunk = {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: modelId,
                  choices: [{
                    index: 0,
                    delta: { content: event.delta.text },
                    finish_reason: null
                  }]
                };
                const writeSuccess = res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                if (!writeSuccess) {
                  log(`[${requestId}] Backpressure detected on chunk ${chunkCount}`, 'WARN');
                }
              } else if (event.type === 'message_stop') {
                log(`[${requestId}] Received message_stop event`);
                receivedMessageStop = true;
              }
            } catch (e) {
              // skip non-JSON lines
            }
          }
        }
      }
      } catch (streamError: any) {
        log(`[${requestId}] Streaming error: ${streamError.message}`, 'ERROR');
        log(`[${requestId}] Headers sent: ${res.headersSent}, Writable: ${res.writable}`, 'ERROR');
        // Don't re-throw if headers already sent - just end the stream
        if (!res.headersSent) {
          throw streamError;
        }
        res.end();
        return;
      }
    }

    // Process any remaining data in buffer
    log(`[${requestId}] Processing remaining buffer (${buffer.length} bytes)`);
    if (buffer.trim()) {
      const line = buffer.trim();
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data && data !== '[DONE]') {
          try {
            const event = JSON.parse(data);
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              const chunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{
                  index: 0,
                  delta: { content: event.delta.text },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            } else if (event.type === 'message_stop') {
              log(`[${requestId}] Received message_stop event in buffer`);
              receivedMessageStop = true;
            }
          } catch (e) {
            // skip non-JSON
          }
        }
      }
    }
    
    // Send final stop chunk before [DONE]
    log(`[${requestId}] Sending final stop chunk`);
    const stopChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    };
    res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);

    log(`[${requestId}] Sending [DONE] and ending stream`);
    res.write('data: [DONE]\n\n');
    res.end();
    log(`[${requestId}] Stream ended successfully, writable=${res.writable}, finished=${res.writableFinished}`);
  } else {
    // Non-streaming response
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw { status: response.status, message: errorText };
    }
    
    const data = await response.json() as any;
    
    // Convert to OpenAI format
    const content = (data.content || [])
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('');
    
    res.json({
      id: data.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content
        },
        finish_reason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason
      }],
      usage: {
        prompt_tokens: data.usage?.input_tokens || 0,
        completion_tokens: data.usage?.output_tokens || 0,
        total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
      }
    });
  }
}

async function handleGeminiChat(res: Response, options: {
  modelId: string;
  system: string | null;
  messages: ChatMessage[];
  stream: boolean;
  maxTokens: number;
  temperature?: number;
  config: Config;
  modelRegion?: string;
}) {
  const { modelId, system, messages, stream, maxTokens, temperature, config, modelRegion } = options;
  
  const vertexAI = new VertexAI({
    project: config.project_id,
    location: modelRegion || config.google_region
  });
  
  const model = vertexAI.getGenerativeModel({
    model: modelId,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: temperature
    },
    systemInstruction: system || undefined
  });
  
  // Convert messages to Gemini format
  const contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }]
  }));
  
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const completionId = `chatcmpl-${Date.now()}`;

    try {
      // Send initial role chunk
      res.write(`data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      })}\n\n`);

      const result = await model.generateContentStream({ contents });

      for await (const chunk of result.stream) {
        const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text) {
          const openaiChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{
              index: 0,
              delta: { content: text },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
        }
      }

      const finalChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop'
        }]
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (streamError: any) {
      log(`Gemini streaming error: ${streamError.message}`, 'ERROR');
      // Don't re-throw if headers already sent - just end the stream
      if (!res.headersSent) {
        throw streamError;
      }
      res.end();
      return;
    }
  } else {
    const result = await model.generateContent({ contents });
    const response = result.response;
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: response.usageMetadata?.promptTokenCount || 0,
        completion_tokens: response.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: response.usageMetadata?.totalTokenCount || 0
      }
    });
  }
}
// Add this handler function after the existing handleGeminiChat function

async function handleGenAIChat(res: Response, options: {
  modelId: string;
  system: string | null;
  messages: ChatMessage[];
  stream: boolean;
  maxTokens: number;
  temperature?: number;
  config: Config;
}) {
  const { GoogleGenAI } = await import("@google/genai");
  const { modelId, system, messages, stream, maxTokens, temperature, config } = options;
  
  const ai = new GoogleGenAI({
    vertexai: true,
    project: config.project_id,
    location: "global"
  });
  
  // Helper to convert message content to Gemini parts
  function contentToParts(content: string | any[]): any[] {
    if (typeof content === "string") {
      return [{ text: content }];
    }
    
    // Handle array content (multimodal)
    return content.map(part => {
      if (part.type === "text") {
        return { text: part.text };
      } else if (part.type === "image_url") {
        const url = part.image_url?.url || "";
        // Check if its a base64 data URL
        if (url.startsWith("data:")) {
          const matches = url.match(/^data:([^;]+);base64,(.+)$/);
          if (matches) {
            return {
              inlineData: {
                mimeType: matches[1],
                data: matches[2]
              }
            };
          }
        }
        // For regular URLs, need to fetch and convert to base64
        return { pendingUrl: url };
      }
      return { text: JSON.stringify(part) };
    });
  }

  // Build contents from messages with pending URL resolution
  const rawContents = messages.map(msg => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: contentToParts(msg.content)
  }));

  // Resolve pending URLs to base64
  async function resolveParts(parts: any[]): Promise<any[]> {
    return Promise.all(parts.map(async (part) => {
      if (part.pendingUrl) {
        try {
          const response = await fetch(part.pendingUrl);
          const buffer = await response.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          const contentType = response.headers.get("content-type") || "image/jpeg";
          return {
            inlineData: {
              mimeType: contentType,
              data: base64
            }
          };
        } catch (e) {
          log("Failed to fetch image URL: " + part.pendingUrl, "WARN");
          return { text: "[Image could not be loaded]" };
        }
      }
      return part;
    }));
  }

  const contents = await Promise.all(rawContents.map(async (msg) => ({
    role: msg.role,
    parts: await resolveParts(msg.parts)
  })));

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const completionId = `chatcmpl-${Date.now()}`;

    try {
      // Send initial role chunk
      res.write(`data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      })}\n\n`);

      const response = await ai.models.generateContentStream({
        model: modelId,
        contents,
        config: {
          maxOutputTokens: maxTokens,
          temperature,
          systemInstruction: system || undefined
        }
      });

      for await (const chunk of response) {
        const text = chunk.text || "";
        if (text) {
          const openaiChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{
              index: 0,
              delta: { content: text },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
        }
      }

      // Send final stop chunk before [DONE]
      const stopChunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      };
      res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);

      res.write(`data: [DONE]\n\n`);
      res.end();
    } catch (streamError: any) {
      log(`GenAI streaming error: ${streamError.message}`, 'ERROR');
      // Don't re-throw - headers already sent, just end the stream
      if (!res.headersSent) {
        throw streamError;
      }
      res.end();
    }
  } else {
    const response = await ai.models.generateContent({
      model: modelId,
      contents,
      config: {
        maxOutputTokens: maxTokens,
        temperature,
        systemInstruction: system || undefined
      }
    });

    log("GenAI candidates: " + JSON.stringify(response.candidates, null, 2).slice(0, 2000));
    
    // Extract text and images from the response
    let text = "";
    const images: Array<{mimeType: string; data: string}> = [];
    
    try {
      if (response.candidates && response.candidates[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts as any[]) {
          if (part.text && !part.thought) {
            text += part.text;
          } else if (part.inlineData) {
            images.push({
              mimeType: part.inlineData.mimeType || "image/png",
              data: part.inlineData.data || ""
            });
          }
        }
      }
      // Fallback to response.text if no text found
      if (!text) {
        try {
          text = response.text || "";
        } catch (e) {}
      }
    } catch (e) {
      text = "";
    }
    
    log("Extracted text length: " + text.length + ", images: " + images.length);
    
    const result: any = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: response.usageMetadata?.promptTokenCount || 0,
        completion_tokens: response.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: response.usageMetadata?.totalTokenCount || 0
      }
    };
    
    // Add generated images to response
    if (images.length > 0) {
      result.images = images.map(img => ({
        b64_json: img.data,
        content_type: img.mimeType
      }));
    }
    
    res.json(result);
  }
}

async function handleAnthropicMessages(req: Request, res: Response, config: Config) {
  const { model: modelInput, messages, system, stream, max_tokens, temperature } = req.body;
  
  const modelId = resolveModel(modelInput, config);
  const modelSpec = getModelSpec(modelId);
  
  log(`Messages API: ${modelInput} -> ${modelId}, stream=${stream}`);
  
  // Update stats
  proxyStats.requestCount++;
  proxyStats.lastRequestTime = Date.now();
  saveStats();
  
  const regions = getRegionFallbackOrder(modelId);
  let lastError: any = null;
  
  for (const region of regions) {
    try {
      log(`Trying region: ${region} for model ${modelId}`);
      
      // Get access token via google-auth-library
      const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
      const client = await auth.getClient();
      const tokenResponse = await client.getAccessToken();
      const accessToken = tokenResponse.token;
      
      const projectId = config.project_id;
      const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/anthropic/models/${modelId}:${stream ? 'streamRawPredict' : 'rawPredict'}`;
      
      const requestBody: any = {
        anthropic_version: 'vertex-2023-10-16',
        max_tokens: max_tokens || modelSpec?.maxTokens || 4096,
        messages: messages
      };
      
      if (system) {
        requestBody.system = system;
      }
      
      if (temperature !== undefined) {
        requestBody.temperature = temperature;
      }
      
      if (stream) {
        requestBody.stream = true;
      }
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        const error: any = { status: response.status, message: errorText };
        
        // Only retry on certain errors
        const shouldRetry = 
          response.status === 429 || 
          response.status === 503 || 
          response.status === 500 ||
          errorText.includes('capacity') ||
          errorText.includes('overloaded');
        
        if (!shouldRetry) {
          throw error;
        }
        
        lastError = error;
        log(`Region ${region} failed: ${errorText}`, 'WARN');
        continue;
      }
      
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
        
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
              if (line.startsWith('event: ') || line.startsWith('data: ')) {
                res.write(line + '\n');
              } else if (line === '') {
                res.write('\n');
              }
            }
          }
        }
        
        res.end();
      } else {
        const data = await response.json();
        res.json(data);
      }
      
      return; // Success
      
    } catch (error: any) {
      lastError = error;
      log(`Region ${region} failed: ${error.message}`, 'WARN');
      
      // Check if we should retry
      const shouldRetry = 
        error.status === 429 || 
        error.status === 503 || 
        error.status === 500 ||
        error.message?.includes('capacity') ||
        error.message?.includes('overloaded');
      
      if (!shouldRetry) {
        throw error;
      }
    }
  }
  
  // All regions failed
  log(`All regions failed for ${modelId}`, 'ERROR');
  res.status(lastError?.status || 500).json({
    error: {
      type: 'api_error',
      message: lastError?.message || 'All regions failed'
    }
  });
}

async function handleModels(req: Request, res: Response, config: Config) {
  const models = Object.entries(MODEL_CATALOG).map(([id, spec]) => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: spec.provider === 'anthropic' ? 'anthropic' : 'google',
    permission: [],
    root: id,
    parent: null,
    // Extra info
    _vertex_proxy: {
      name: spec.name,
      provider: spec.provider,
      context_window: spec.contextWindow,
      max_tokens: spec.maxTokens,
      input_price_per_1m: spec.inputPrice,
      output_price_per_1m: spec.outputPrice,
      regions: spec.regions,
      capabilities: spec.capabilities
    }
  }));
  
  // Add aliases
  for (const [alias, target] of Object.entries(config.model_aliases)) {
    const targetSpec = MODEL_CATALOG[target];
    if (targetSpec) {
      models.push({
        id: alias,
        object: 'model',
        created: 1700000000,
        owned_by: 'vertex-proxy',
        permission: [],
        root: target,
        parent: null,
        _vertex_proxy: {
          name: `${alias} → ${targetSpec.name}`,
          provider: targetSpec.provider,
          context_window: targetSpec.contextWindow,
          max_tokens: targetSpec.maxTokens,
          input_price_per_1m: targetSpec.inputPrice,
          output_price_per_1m: targetSpec.outputPrice,
          regions: targetSpec.regions,
          capabilities: targetSpec.capabilities
        }
      });
    }
  }
  
  res.json({
    object: 'list',
    data: models
  });
}

// ============================================================================
// Image Generation Handler (Imagen)
// ============================================================================

async function handleImageGeneration(req: Request, res: Response, config: Config) {
  try {
    const { model, prompt, n = 1, size = '1024x1024' } = req.body;
    
    // Update stats
    proxyStats.requestCount++;
    proxyStats.lastRequestTime = Date.now();
    saveStats();
    
    // Resolve model alias
    let resolvedModel = config.model_aliases[model] || model || 'imagen-4.0-generate-001';
    const modelSpec = MODEL_CATALOG[resolvedModel];
    
    if (!modelSpec || modelSpec.provider !== 'imagen') {
      return res.status(400).json({
        error: {
          message: `Model ${resolvedModel} is not an image generation model`,
          type: 'invalid_request_error'
        }
      });
    }
    
    if (!prompt) {
      return res.status(400).json({
        error: {
          message: 'prompt is required',
          type: 'invalid_request_error'
        }
      });
    }
    
    log(`Imagen: ${resolvedModel}, prompt="${prompt.substring(0, 50)}..."`);
    
    // Parse size to get aspect ratio
    const [width, height] = size.split('x').map(Number);
    let aspectRatio = '1:1';
    if (width > height) aspectRatio = '16:9';
    else if (height > width) aspectRatio = '9:16';
    
    // Build Vertex AI Imagen API request
    const region = config.google_region || 'us-central1';
    const endpoint = `https://${region}-aiplatform.googleapis.com/v1/projects/${config.project_id}/locations/${region}/publishers/google/models/${resolvedModel}:predict`;
    
    // Get access token
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    
    const imagenRequest = {
      instances: [{ prompt }],
      parameters: {
        sampleCount: Math.min(n, 4), // Imagen supports 1-4
        aspectRatio,
        // Add safety settings if needed
        safetySetting: 'block_medium_and_above'
      }
    };
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(imagenRequest)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      log(`Imagen error: ${response.status} ${errorText}`, 'ERROR');
      return res.status(response.status).json({
        error: {
          message: `Imagen API error: ${errorText}`,
          type: 'api_error'
        }
      });
    }
    
    const result = await response.json() as any;
    
    // Convert Vertex AI response to OpenAI format
    const images = (result.predictions || []).map((pred: any, index: number) => ({
      b64_json: pred.bytesBase64Encoded,
      revised_prompt: prompt
    }));
    
    res.json({
      created: Math.floor(Date.now() / 1000),
      data: images
    });
    
  } catch (error: any) {
    log(`Imagen error: ${error.message}`, 'ERROR');
    res.status(500).json({
      error: {
        message: error.message,
        type: 'api_error'
      }
    });
  }
}

// ============================================================================
// Completions Handler (Legacy OpenAI API)
// ============================================================================

async function handleCompletions(req: Request, res: Response, config: Config) {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const { model: modelInput, prompt, stream, max_tokens, temperature, stop } = req.body;

  log(`[${requestId}] ====== NEW COMPLETIONS REQUEST ======`);
  log(`[${requestId}] Model: ${modelInput}, Stream: ${stream}, Prompt length: ${prompt?.length}`);

  // Convert prompt to messages format
  const messages: ChatMessage[] = [{
    role: 'user',
    content: typeof prompt === 'string' ? prompt : JSON.stringify(prompt)
  }];

  // Resolve model alias
  const modelId = resolveModel(modelInput, config);
  const modelSpec = getModelSpec(modelId);

  if (!modelSpec) {
    log(`[${requestId}] Unknown model: ${modelInput} -> ${modelId}`, 'WARN');
  }

  const provider = modelSpec?.provider || 'anthropic';

  log(`[${requestId}] Completions: ${modelInput} -> ${modelId} (${provider}), stream=${stream}`);

  // Update stats
  proxyStats.requestCount++;
  proxyStats.lastRequestTime = Date.now();
  saveStats();

  // Track response lifecycle
  res.on('close', () => {
    log(`[${requestId}] Response closed by client`);
  });

  res.on('finish', () => {
    log(`[${requestId}] Response finished successfully`);
  });

  res.on('error', (err) => {
    log(`[${requestId}] Response error: ${err.message}`, 'ERROR');
  });

  try {
    if (provider === 'anthropic') {
      log(`[${requestId}] Routing to Anthropic handler for completions`);

      // Use handleAnthropicChatWithFallback but wrap the response
      await handleAnthropicCompletions(res, {
        modelId,
        system: null,
        messages,
        stream: stream ?? false,
        maxTokens: max_tokens || modelSpec?.maxTokens || 4096,
        temperature,
        config,
        requestId,
        stop
      });
    } else {
      res.status(400).json({ error: `Unsupported provider for completions: ${provider}` });
    }
  } catch (error: any) {
    log(`[${requestId}] ERROR caught in handleCompletions: ${error.message}`, 'ERROR');

    // If headers already sent (streaming started), we can't send JSON error
    if (res.headersSent) {
      log(`[${requestId}] Headers already sent, ending response`, 'WARN');
      if (res.writable) {
        res.end();
      }
      return;
    }

    res.status(500).json({
      error: {
        message: error.message,
        type: 'proxy_error',
        code: error.status || 500
      }
    });
  }
}

async function handleAnthropicCompletions(res: Response, options: {
  modelId: string;
  system: string | null;
  messages: ChatMessage[];
  stream: boolean;
  maxTokens: number;
  temperature?: number;
  config: Config;
  requestId?: string;
  stop?: string | string[];
}) {
  const { modelId, system, messages, stream, maxTokens, temperature, config, requestId = 'unknown', stop } = options;
  const regions = getRegionFallbackOrder(modelId);

  log(`[${requestId}] Starting completions region fallback`);

  let lastError: any = null;

  for (const region of regions) {
    try {
      log(`[${requestId}] Trying region: ${region} for completions`);

      const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
      const client = await auth.getClient();
      const tokenResponse = await client.getAccessToken();
      const accessToken = tokenResponse.token;

      const useRegion = region || config.default_region;
      const projectId = config.project_id;
      const url = `https://${useRegion}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${useRegion}/publishers/anthropic/models/${modelId}:${stream ? 'streamRawPredict' : 'rawPredict'}`;

      const anthropicMessages = messages.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content
      }));

      const requestBody: any = {
        anthropic_version: 'vertex-2023-10-16',
        max_tokens: maxTokens,
        messages: anthropicMessages
      };

      if (system) {
        requestBody.system = system;
      }

      if (temperature !== undefined) {
        requestBody.temperature = temperature;
      }

      if (stop) {
        requestBody.stop_sequences = Array.isArray(stop) ? stop : [stop];
      }

      if (stream) {
        requestBody.stream = true;

        log(`[${requestId}] Setting up completions streaming response`);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorText = await response.text();
          log(`[${requestId}] Vertex AI error: ${response.status} ${errorText}`, 'ERROR');
          throw { status: response.status, message: errorText };
        }

        log(`[${requestId}] Vertex AI responded OK, starting completions stream`);
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const completionId = `cmpl-${Date.now()}`;
        let chunkCount = 0;

        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                log(`[${requestId}] Completions stream ended, total chunks: ${chunkCount}`);
                break;
              }

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const data = line.slice(6).trim();
                  if (!data || data === '[DONE]') continue;

                  try {
                    const event = JSON.parse(data);

                    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                      chunkCount++;
                      const chunk = {
                        id: completionId,
                        object: 'text_completion',
                        created: Math.floor(Date.now() / 1000),
                        model: modelId,
                        choices: [{
                          text: event.delta.text,
                          index: 0,
                          logprobs: null,
                          finish_reason: null
                        }]
                      };
                      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    } else if (event.type === 'message_stop') {
                      log(`[${requestId}] Received message_stop in completions`);
                    }
                  } catch (e) {
                    // skip non-JSON lines
                  }
                }
              }
            }
          } catch (streamError: any) {
            log(`[${requestId}] Completions streaming error: ${streamError.message}`, 'ERROR');
            if (!res.headersSent) {
              throw streamError;
            }
            res.end();
            return;
          }
        }

        // Send final chunk
        log(`[${requestId}] Sending completions final chunk`);
        const finalChunk = {
          id: completionId,
          object: 'text_completion',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{
            text: '',
            index: 0,
            logprobs: null,
            finish_reason: 'stop'
          }]
        };
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        log(`[${requestId}] Completions stream ended successfully`);

      } else {
        // Non-streaming
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw { status: response.status, message: errorText };
        }

        const data = await response.json() as any;

        const text = (data.content || [])
          .filter((block: any) => block.type === 'text')
          .map((block: any) => block.text)
          .join('');

        res.json({
          id: `cmpl-${Date.now()}`,
          object: 'text_completion',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{
            text,
            index: 0,
            logprobs: null,
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: data.usage?.input_tokens || 0,
            completion_tokens: data.usage?.output_tokens || 0,
            total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
          }
        });
      }

      return; // Success
    } catch (error: any) {
      lastError = error;
      log(`[${requestId}] Region ${region} failed for completions: ${error.message}`, 'WARN');

      const shouldRetry =
        error.status === 429 ||
        error.status === 503 ||
        error.status === 500 ||
        error.message?.includes('capacity') ||
        error.message?.includes('overloaded');

      if (!shouldRetry) {
        throw error;
      }
    }
  }

  throw lastError || new Error('All regions failed for completions');
}

// ============================================================================
// Server Setup
// ============================================================================

export async function startProxy(daemonMode = false) {
  const config = loadConfig();
  
  if (!config.project_id) {
    console.error('Error: GOOGLE_CLOUD_PROJECT is required');
    process.exit(1);
  }
  
  const app = express();
  const port = parseInt(process.env.VERTEX_PROXY_PORT || '8001');
  
  // Initialize stats
  proxyStats = {
    startTime: Date.now(),
    requestCount: 0,
    lastRequestTime: null,
    port
  };
  saveStats();
  
  // Middleware
  app.use(express.json({ limit: '50mb' }));
  
  // Logging middleware
  app.use((req, res, next) => {
    const start = Date.now();
    const reqId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    log(`[${reqId}] >>>>>> ${req.method} ${req.path}`);

    res.on('finish', () => {
      const duration = Date.now() - start;
      log(`[${reqId}] <<<<<< ${req.method} ${req.path} ${res.statusCode} ${duration}ms [FINISH]`);
    });

    res.on('close', () => {
      const duration = Date.now() - start;
      log(`[${reqId}] <<<<<< ${req.method} ${req.path} ${duration}ms [CLOSE]`);
    });

    next();
  });
  
  // Routes
  app.get('/', (req, res) => {
    res.json({
      name: 'Vertex AI Proxy',
      version: '1.1.0',
      status: 'running',
      project: config.project_id,
      uptime: Math.floor((Date.now() - proxyStats.startTime) / 1000),
      requestCount: proxyStats.requestCount,
      regions: {
        claude: config.default_region,
        gemini: config.google_region,
        imagen: config.google_region
      },
      endpoints: {
        models: '/v1/models',
        chat: '/v1/chat/completions',
        completions: '/v1/completions',
        messages: '/v1/messages',
        images: '/v1/images/generations'
      }
    });
  });
  
  app.get('/health', (req, res) => {
    res.json({ 
      status: 'ok',
      uptime: Math.floor((Date.now() - proxyStats.startTime) / 1000),
      requestCount: proxyStats.requestCount
    });
  });
  
  app.get('/v1/models', (req, res) => handleModels(req, res, config));

  app.post('/v1/chat/completions', (req, res) => handleChatCompletions(req, res, config));

  app.post('/v1/completions', (req, res) => handleCompletions(req, res, config));

  app.post('/v1/messages', (req, res) => handleAnthropicMessages(req, res, config));
  app.post('/messages', (req, res) => handleAnthropicMessages(req, res, config));
  
  // Image generation (Imagen)
  app.post('/v1/images/generations', (req, res) => handleImageGeneration(req, res, config));
  
  // Start server
  const server = app.listen(port, () => {
    const banner = `
╔══════════════════════════════════════════════════════════╗
║                  Vertex AI Proxy v1.1.0                  ║
╠══════════════════════════════════════════════════════════╣
║  Status:    Running                                      ║
║  Port:      ${port.toString().padEnd(45)}║
║  Project:   ${config.project_id.padEnd(45)}║
║  Claude:    ${config.default_region.padEnd(45)}║
║  Gemini:    ${config.google_region.padEnd(45)}║
╠══════════════════════════════════════════════════════════╣
║  Endpoints:                                              ║
║    GET  /v1/models              List models              ║
║    POST /v1/chat/completions    OpenAI chat format       ║
║    POST /v1/completions         OpenAI completions       ║
║    POST /v1/messages            Anthropic format         ║
║    POST /v1/images/generations  Image generation         ║
╠══════════════════════════════════════════════════════════╣
║  Features:                                               ║
║    • Dynamic region fallback (us-east5 → global → EU)    ║
║    • Logs: ~/.vertex_proxy/proxy.log                     ║
╚══════════════════════════════════════════════════════════╝
`;
    if (!daemonMode) {
      console.log(banner);
    }
    log(`Server started on port ${port}`);
  });
  
  return server;
}

// Export for daemon management
export { proxyStats, loadStats, DATA_DIR, LOG_FILE };

// Run if executed directly
if (process.env.VERTEX_PROXY_START === '1' || process.argv.includes('--start')) {
  startProxy();
}
