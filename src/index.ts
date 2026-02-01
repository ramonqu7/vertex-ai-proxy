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
  role: 'system' | 'user' | 'assistant';
  content: string | any[];
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
    maxTokens: 8192,
    inputPrice: 15,
    outputPrice: 75,
    regions: ['us-east5', 'europe-west1'],
    capabilities: ['text', 'vision', 'tools']
  },
  'claude-sonnet-4-5@20250514': {
    id: 'claude-sonnet-4-5@20250514',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    contextWindow: 200000,
    maxTokens: 8192,
    inputPrice: 3,
    outputPrice: 15,
    regions: ['us-east5', 'europe-west1'],
    capabilities: ['text', 'vision', 'tools']
  },
  'claude-haiku-4-5@20251001': {
    id: 'claude-haiku-4-5@20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    contextWindow: 200000,
    maxTokens: 8192,
    inputPrice: 0.25,
    outputPrice: 1.25,
    regions: ['us-east5', 'europe-west1'],
    capabilities: ['text', 'vision', 'tools']
  },
  // Gemini Models
  'gemini-3-pro-preview': {
    id: 'gemini-3-pro-preview',
    name: 'Gemini 3 Pro',
    provider: 'google',
    contextWindow: 1000000,
    maxTokens: 8192,
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
    maxTokens: 8192,
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
    maxTokens: 8192,
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
 * Priority: us-east5 -> us-central1 (global) -> europe-west1 -> other regions
 */
function getRegionFallbackOrder(modelId: string): string[] {
  const modelSpec = MODEL_CATALOG[modelId];
  if (!modelSpec) {
    // Default fallback order if model not found
    return ['us-east5', 'us-central1', 'europe-west1'];
  }
  
  const modelRegions = modelSpec.regions;
  const priorityOrder = ['us-east5', 'us-central1', 'europe-west1'];
  
  // Build ordered list: priority regions first (if available), then remaining
  const ordered: string[] = [];
  
  for (const region of priorityOrder) {
    if (modelRegions.includes(region)) {
      ordered.push(region);
    }
  }
  
  // Add any remaining model regions not in priority list
  for (const region of modelRegions) {
    if (!ordered.includes(region)) {
      ordered.push(region);
    }
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
      'gpt-4-turbo': 'claude-sonnet-4-5@20250514',
      'gpt-4o': 'claude-sonnet-4-5@20250514',
      'gpt-4o-mini': 'claude-haiku-4-5@20251001',
      'gpt-3.5-turbo': 'claude-haiku-4-5@20251001',
      'claude': 'claude-opus-4-5@20251101',
      'claude-latest': 'claude-opus-4-5@20251101',
      'opus': 'claude-opus-4-5@20251101',
      'sonnet': 'claude-sonnet-4-5@20250514',
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
  const { model: modelInput, messages, stream, max_tokens, temperature } = req.body;
  
  // Resolve model alias
  const modelId = resolveModel(modelInput, config);
  const modelSpec = getModelSpec(modelId);
  
  if (!modelSpec) {
    log(`Unknown model: ${modelInput} -> ${modelId}`, 'WARN');
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
      log(`Truncated ${cleanMessages.length - finalMessages.length} messages to fit context`);
    }
  }
  
  log(`Chat: ${modelInput} -> ${modelId} (${provider}), stream=${stream}, messages=${finalMessages.length}`);
  
  // Update stats
  proxyStats.requestCount++;
  proxyStats.lastRequestTime = Date.now();
  saveStats();
  
  try {
    if (provider === 'anthropic') {
      await handleAnthropicChatWithFallback(res, {
        modelId,
        system,
        messages: finalMessages,
        stream: stream ?? false,
        maxTokens: max_tokens || modelSpec?.maxTokens || 4096,
        temperature,
        config
      });
    } else if (provider === 'google') {
      await handleGeminiChat(res, {
        modelId,
        system,
        messages: finalMessages,
        stream: stream ?? false,
        maxTokens: max_tokens || modelSpec?.maxTokens || 4096,
        temperature,
        config,
        modelRegion: modelSpec?.regions?.[0]
      });
    } else {
      res.status(400).json({ error: `Unsupported provider: ${provider}` });
    }
  } catch (error: any) {
    log(`Error: ${error.message}`, 'ERROR');
    
    // Try fallback if configured
    const fallbacks = config.fallback_chains[modelId];
    if (fallbacks && fallbacks.length > 0) {
      log(`Trying model fallback: ${fallbacks[0]}`);
      req.body.model = fallbacks[0];
      return handleChatCompletions(req, res, config);
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

async function handleAnthropicChatWithFallback(res: Response, options: {
  modelId: string;
  system: string | null;
  messages: ChatMessage[];
  stream: boolean;
  maxTokens: number;
  temperature?: number;
  config: Config;
  modelRegion?: string;
}) {
  const { modelId, config } = options;
  const regions = getRegionFallbackOrder(modelId);
  
  let lastError: any = null;
  
  for (const region of regions) {
    try {
      log(`Trying region: ${region} for model ${modelId}`);
      await handleAnthropicChat(res, { ...options, region });
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
}) {
  const { modelId, system, messages, stream, maxTokens, temperature, config, region } = options;
  
  // Get access token via google-auth-library
  const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const accessToken = tokenResponse.token;
  
  const useRegion = region || config.default_region;
  const projectId = config.project_id;
  const url = `https://${useRegion}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${useRegion}/publishers/anthropic/models/${modelId}:${stream ? 'streamRawPredict' : 'rawPredict'}`;
  
  // Convert messages to Anthropic format
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
  
  if (stream) {
    requestBody.stream = true;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
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
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;
            
            try {
              const event = JSON.parse(data);
              
              if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                const chunk = {
                  id: `chatcmpl-${Date.now()}`,
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
                const chunk = {
                  id: `chatcmpl-${Date.now()}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: modelId,
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: 'stop'
                  }]
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            } catch (e) {
              // skip non-JSON lines
            }
          }
        }
      }
    }
    
    res.write('data: [DONE]\n\n');
    res.end();
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
    
    const result = await model.generateContentStream({ contents });
    
    for await (const chunk of result.stream) {
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (text) {
        const openaiChunk = {
          id: `chatcmpl-${Date.now()}`,
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
      id: `chatcmpl-${Date.now()}`,
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
    res.on('finish', () => {
      const duration = Date.now() - start;
      log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
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
