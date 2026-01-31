import express, { Request, Response } from 'express';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { GoogleGenAI } from '@google/genai';
import {
  ProxyConfig, DEFAULT_CONFIG, ChatRequest, Message, Tool,
  CLAUDE_MODELS, GEMINI_MODELS, StreamChunk
} from './types.js';

// Request Queue for concurrency control
class RequestQueue {
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private activeCount = 0;
  
  constructor(private maxConcurrent: number, private maxQueueSize: number) {}
  
  async acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      return;
    }
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error('Queue full');
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }
  
  release(): void {
    this.activeCount--;
    const next = this.queue.shift();
    if (next) {
      this.activeCount++;
      next.resolve();
    }
  }
  
  get stats() {
    return { active: this.activeCount, queued: this.queue.length };
  }
}

// Metrics collector
class Metrics {
  private requestsTotal = new Map<string, number>();
  private requestDurations: number[] = [];
  private retriesTotal = new Map<string, number>();
  private regionFailures = new Map<string, number>();
  private cacheHits = 0;
  
  constructor(private enabled: boolean) {}
  
  incRequest(model: string, status: string) {
    if (!this.enabled) return;
    const key = `${model}:${status}`;
    this.requestsTotal.set(key, (this.requestsTotal.get(key) || 0) + 1);
  }
  
  observeDuration(duration: number) {
    if (!this.enabled) return;
    this.requestDurations.push(duration);
    if (this.requestDurations.length > 1000) this.requestDurations.shift();
  }
  
  incRetry(model: string, region: string) {
    if (!this.enabled) return;
    const key = `${model}:${region}`;
    this.retriesTotal.set(key, (this.retriesTotal.get(key) || 0) + 1);
  }
  
  incRegionFailure(region: string) {
    if (!this.enabled) return;
    this.regionFailures.set(region, (this.regionFailures.get(region) || 0) + 1);
  }
  
  incCacheHit() {
    if (this.enabled) this.cacheHits++;
  }
  
  getPrometheusMetrics(): string {
    const lines: string[] = [];
    lines.push('# HELP vertex_proxy_requests_total Total requests');
    lines.push('# TYPE vertex_proxy_requests_total counter');
    for (const [key, value] of this.requestsTotal) {
      const [model, stat] = key.split(':');
      lines.push(`vertex_proxy_requests_total{model="${model}",status="${stat}"} ${value}`);
    }
    lines.push(`# HELP vertex_proxy_cache_hits_total Cache hits`);
    lines.push(`# TYPE vertex_proxy_cache_hits_total counter`);
    lines.push(`vertex_proxy_cache_hits_total ${this.cacheHits}`);
    return lines.join('\n');
  }
}

// Client pool with region failover
class ClientPool {
  private claudeClients = new Map<string, AnthropicVertex>();
  private geminiClient: GoogleGenAI | null = null;
  private regionHealth = new Map<string, number>();
  
  constructor(private config: ProxyConfig, private metrics: Metrics) {
    this.initClients();
  }
  
  private initClients() {
    for (const region of this.config.claudeRegions) {
      try {
        this.claudeClients.set(region.trim(), new AnthropicVertex({
          projectId: this.config.projectId,
          region: region.trim(),
        }));
        this.regionHealth.set(region.trim(), Date.now());
        console.log(`Initialized Claude client for region: ${region}`);
      } catch (e) {
        console.warn(`Failed to init Claude client for ${region}: ${e}`);
      }
    }
    
    try {
      this.geminiClient = new GoogleGenAI({
        vertexai: true,
        project: this.config.projectId,
        location: this.config.geminiLocation,
      });
      console.log(`Initialized Gemini client for: ${this.config.geminiLocation}`);
    } catch (e) {
      console.warn(`Failed to init Gemini client: ${e}`);
    }
  }
  
  getClaudeClient(): { client: AnthropicVertex; region: string } {
    const sorted = [...this.regionHealth.entries()].sort((a, b) => b[1] - a[1]);
    for (const [region] of sorted) {
      const client = this.claudeClients.get(region);
      if (client) return { client, region };
    }
    throw new Error('No Claude clients available');
  }
  
  getGeminiClient(): GoogleGenAI {
    if (!this.geminiClient) throw new Error('Gemini client not available');
    return this.geminiClient;
  }
  
  markRegionSuccess(region: string) { this.regionHealth.set(region, Date.now()); }
  markRegionFailure(region: string) { this.regionHealth.set(region, 0); this.metrics.incRegionFailure(region); }
}

// Helpers
function getModelType(model?: string): { type: 'claude' | 'gemini'; modelId: string } {
  if (!model) return { type: 'claude', modelId: CLAUDE_MODELS['opus'] };
  const ml = model.toLowerCase();
  if (ml in CLAUDE_MODELS) return { type: 'claude', modelId: CLAUDE_MODELS[ml] };
  if (ml in GEMINI_MODELS) return { type: 'gemini', modelId: GEMINI_MODELS[ml] };
  if (ml.includes('gemini')) return { type: 'gemini', modelId: model };
  return { type: 'claude', modelId: CLAUDE_MODELS[ml] || CLAUDE_MODELS['opus'] };
}

function processContent(content: string | any[]): string | any[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content.map(item => {
    if (item?.type === 'text') return { type: 'text', text: item.text || '' };
    if (item?.type === 'image_url') {
      const url = item.image_url?.url || '';
      if (url.startsWith('data:')) {
        const [meta, data] = url.split(',');
        const mediaType = meta.includes(':') ? meta.split(':')[1].split(';')[0] : 'image/png';
        return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
      }
    }
    return item;
  }).filter(Boolean);
}

function convertTools(tools?: Tool[]): any[] | undefined {
  if (!tools?.length) return undefined;
  return tools.filter(t => t.type === 'function').map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || {},
  }));
}

function extractSystemAndMessages(messages: Message[], enableCache: boolean) {
  const systemParts: string[] = [];
  const anthropicMsgs: any[] = [];
  
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(typeof msg.content === 'string' ? msg.content : '');
    } else if (msg.role === 'tool') {
      anthropicMsgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id || '', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }],
      });
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      let processed = processContent(msg.content);
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        processed = msg.tool_calls.map(tc => ({
          type: 'tool_use', id: tc.id, name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        }));
      }
      anthropicMsgs.push({ role: msg.role, content: processed });
    }
  }
  
  let system: string | any[] | undefined = systemParts.length ? systemParts.join('\n\n') : undefined;
  if (enableCache && system && typeof system === 'string' && system.length > 1024) {
    system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }
  return { system, messages: anthropicMsgs };
}

function makeStreamChunk(id: string, model: string, delta: any, finishReason: string | null): StreamChunk {
  return { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Main server
export function createServer(config: Partial<ProxyConfig> = {}) {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const metrics = new Metrics(finalConfig.enableMetrics);
  const pool = new ClientPool(finalConfig, metrics);
  const queue = new RequestQueue(finalConfig.maxConcurrent, finalConfig.queueSize);
  
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });
  
  app.get(['/', '/health'], (req, res) => {
    res.json({ status: 'ok', version: '1.0.0', project: finalConfig.projectId, claude_regions: finalConfig.claudeRegions, gemini_location: finalConfig.geminiLocation, queue: queue.stats });
  });
  
  app.get('/metrics', (req, res) => {
    if (!finalConfig.enableMetrics) return res.status(404).send('Metrics disabled');
    res.type('text/plain').send(metrics.getPrometheusMetrics());
  });
  
  app.post('/v1/chat/completions', async (req, res) => {
    const startTime = Date.now();
    try { await queue.acquire(); } catch { return res.status(429).json({ error: { message: 'Too many requests' } }); }
    
    const timeoutId = setTimeout(() => { if (!res.headersSent) res.status(504).json({ error: { message: 'Timeout' } }); }, finalConfig.requestTimeout * 1000);
    
    try {
      const body = req.body as ChatRequest;
      const { type: modelType, modelId } = getModelType(body.model);
      const chunkId = `chatcmpl-${Date.now()}`;
      
      if (finalConfig.enableRequestLogging) console.log(`[${modelType.toUpperCase()}] model=${modelId}, msgs=${body.messages?.length}, stream=${body.stream}`);
      
      if (modelType === 'gemini') {
        const prompt = body.messages.map(m => `${m.role}: ${m.content}`).join('\n');
        const client = pool.getGeminiClient();
        if (body.stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.write(`data: ${JSON.stringify(makeStreamChunk(chunkId, modelId, { role: 'assistant' }, null))}\n\n`);
          const stream = await client.models.generateContentStream({ model: modelId, contents: prompt });
          for await (const chunk of stream) { if (chunk.text) res.write(`data: ${JSON.stringify(makeStreamChunk(chunkId, modelId, { content: chunk.text }, null))}\n\n`); }
          res.write(`data: ${JSON.stringify(makeStreamChunk(chunkId, modelId, {}, 'stop'))}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        const resp = await client.models.generateContent({ model: modelId, contents: prompt });
        return res.json({ id: chunkId, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: modelId, choices: [{ index: 0, message: { role: 'assistant', content: resp.text }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      }
      
      // Claude
      const { system, messages: anthropicMsgs } = extractSystemAndMessages(body.messages, finalConfig.enablePromptCache);
      const claudeParams: any = { model: modelId, max_tokens: body.max_tokens || 8192, messages: anthropicMsgs };
      if (system) claudeParams.system = system;
      if (body.temperature !== undefined) claudeParams.temperature = body.temperature;
      if (body.tools) claudeParams.tools = convertTools(body.tools);
      
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < finalConfig.maxRetries; attempt++) {
        const { client, region } = pool.getClaudeClient();
        try {
          if (body.stream && !body.tools) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.write(`data: ${JSON.stringify(makeStreamChunk(chunkId, modelId, { role: 'assistant' }, null))}\n\n`);
            let lastHb = Date.now();
            const stream = client.messages.stream(claudeParams);
            for await (const event of stream) {
              if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                res.write(`data: ${JSON.stringify(makeStreamChunk(chunkId, modelId, { content: event.delta.text }, null))}\n\n`);
              }
              if (Date.now() - lastHb > finalConfig.heartbeatInterval * 1000) { res.write(': ping\n\n'); lastHb = Date.now(); }
            }
            res.write(`data: ${JSON.stringify(makeStreamChunk(chunkId, modelId, {}, 'stop'))}\n\n`);
            res.write('data: [DONE]\n\n');
            pool.markRegionSuccess(region);
            metrics.incRequest(modelId, 'success');
            return res.end();
          }
          
          const response = await client.messages.create(claudeParams);
          pool.markRegionSuccess(region);
          
          let contentText = '';
          const toolCalls: any[] = [];
          for (const block of response.content) {
            if ('text' in block) contentText += block.text;
            if (block.type === 'tool_use') toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
          }
          
          const msg: any = { role: 'assistant', content: contentText || null };
          if (toolCalls.length) msg.tool_calls = toolCalls;
          
          const result = { id: `chatcmpl-${response.id}`, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: modelId, choices: [{ index: 0, message: msg, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens, total_tokens: response.usage.input_tokens + response.usage.output_tokens } };
          
          metrics.incRequest(modelId, 'success');
          metrics.observeDuration((Date.now() - startTime) / 1000);
          
          if (body.stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.write(`data: ${JSON.stringify(makeStreamChunk(chunkId, modelId, { role: 'assistant' }, null))}\n\n`);
            if (contentText) res.write(`data: ${JSON.stringify(makeStreamChunk(chunkId, modelId, { content: contentText }, null))}\n\n`);
            for (let i = 0; i < toolCalls.length; i++) {
              const tc = toolCalls[i];
              res.write(`data: ${JSON.stringify(makeStreamChunk(chunkId, modelId, { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }, null))}\n\n`);
              res.write(`data: ${JSON.stringify(makeStreamChunk(chunkId, modelId, { tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] }, null))}\n\n`);
            }
            res.write(`data: ${JSON.stringify(makeStreamChunk(chunkId, modelId, {}, toolCalls.length ? 'tool_calls' : 'stop'))}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          return res.json(result);
          
        } catch (e: any) {
          lastError = e;
          if (e?.status === 429) { pool.markRegionFailure(region); metrics.incRetry(modelId, region); continue; }
          if (e?.status >= 500) { metrics.incRetry(modelId, region); await sleep(finalConfig.retryBaseDelay * Math.pow(2, attempt) * 1000); continue; }
          throw e;
        }
      }
      throw lastError || new Error('All retries exhausted');
    } catch (e: any) {
      console.error('Error:', e.message || e);
      metrics.incRequest(req.body?.model || 'unknown', 'error');
      if (!res.headersSent) res.status(500).json({ error: { message: e.message || 'Internal error' } });
    } finally {
      clearTimeout(timeoutId);
      queue.release();
    }
  });
  
  return { app, config: finalConfig };
}

export function startServer(config: Partial<ProxyConfig> = {}): void {
  const { app, config: finalConfig } = createServer(config);
  app.listen(finalConfig.port, finalConfig.host, () => {
    console.log(`Vertex AI Proxy running at http://${finalConfig.host}:${finalConfig.port}`);
    console.log(`Project: ${finalConfig.projectId}`);
    console.log(`Claude regions: ${finalConfig.claudeRegions.join(', ')}`);
  });
}
