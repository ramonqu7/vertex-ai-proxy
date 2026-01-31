export interface ProxyConfig {
  projectId: string;
  claudeRegions: string[];
  geminiLocation: string;
  port: number;
  host: string;
  maxRetries: number;
  retryBaseDelay: number;
  requestTimeout: number;
  enablePromptCache: boolean;
  enableMetrics: boolean;
  enableRequestLogging: boolean;
  heartbeatInterval: number;
  maxConcurrent: number;
  queueSize: number;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ContentBlock {
  type: 'text' | 'image_url' | 'image';
  text?: string;
  image_url?: { url: string };
  source?: { type: string; media_type: string; data: string };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model?: string;
  messages: Message[];
  stream?: boolean;
  tools?: Tool[];
  max_tokens?: number;
  temperature?: number;
}

export interface StreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
}

export const DEFAULT_CONFIG: ProxyConfig = {
  projectId: process.env.PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '',
  claudeRegions: (process.env.CLAUDE_REGIONS || 'us-east5,us-east1,europe-west1').split(','),
  geminiLocation: process.env.GEMINI_LOCATION || 'us-east5',
  port: parseInt(process.env.PORT || '8001'),
  host: process.env.HOST || '0.0.0.0',
  maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
  retryBaseDelay: parseFloat(process.env.RETRY_BASE_DELAY || '0.5'),
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '300'),
  enablePromptCache: process.env.ENABLE_PROMPT_CACHE !== 'false',
  enableMetrics: process.env.ENABLE_METRICS !== 'false',
  enableRequestLogging: process.env.ENABLE_REQUEST_LOGGING === 'true',
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '15'),
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '10'),
  queueSize: parseInt(process.env.QUEUE_SIZE || '100'),
};

export const CLAUDE_MODELS: Record<string, string> = {
  'opus': 'claude-opus-4-5@20251101',
  'sonnet': 'claude-sonnet-4-5@20250929',
  'haiku': 'claude-haiku-3-5@20241022',
  'claude-opus-4-5': 'claude-opus-4-5@20251101',
  'claude-sonnet-4-5': 'claude-sonnet-4-5@20250929',
};

export const GEMINI_MODELS: Record<string, string> = {
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.0-flash': 'gemini-2.0-flash',
};
