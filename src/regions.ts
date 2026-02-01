/**
 * Vertex AI Model Region Discovery v2
 * 
 * Discovers which Claude models are available in which regions
 * by testing each known model in each region.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GoogleAuth } from 'google-auth-library';

// ============================================================================
// Constants
// ============================================================================

const DATA_DIR = path.join(os.homedir(), '.vertex_proxy');
const CACHE_FILE = path.join(DATA_DIR, 'model-regions.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// All known Vertex AI regions that support Claude
export const ALL_REGIONS = [
  'us-central1',
  'us-east1', 
  'us-east4',
  'us-east5',
  'us-south1',
  'us-west1',
  'us-west4',
  'europe-west1',
  'europe-west2',
  'europe-west3',
  'europe-west4',
  'europe-west9',
  'asia-east1',
  'asia-east2',
  'asia-northeast1',
  'asia-northeast3',
  'asia-south1',
  'asia-southeast1',
  'australia-southeast1',
  'me-central1',
  'me-west1',
  'northamerica-northeast1',
  'southamerica-east1'
];

// Known Claude model versions to check
export const CLAUDE_MODELS = [
  'claude-opus-4-5@20251101',
  'claude-sonnet-4-5@20250929',
  'claude-sonnet-4@20250514',
  'claude-haiku-4-5@20251001',
  'claude-opus-4@20250410',
  'claude-3-5-sonnet-v2@20241022',
  'claude-3-5-sonnet@20240620',
  'claude-3-5-haiku@20241022',
  'claude-3-opus@20240229',
  'claude-3-sonnet@20240229',
  'claude-3-haiku@20240307'
];

// Gemini models - usually available in different regions
export const GEMINI_MODELS = [
  'gemini-3-pro-preview',
  'gemini-3-pro-image-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash'
];

// ============================================================================
// Types
// ============================================================================

interface ModelRegionInfo {
  modelId: string;
  provider: 'anthropic' | 'google';
  availableRegions: string[];
  checkedRegions: string[];
  lastChecked: number;
}

interface RegionCache {
  version: number;
  projectId: string;
  lastUpdated: number;
  models: Record<string, ModelRegionInfo>;
}

interface DiscoveryProgress {
  total: number;
  completed: number;
  currentModel: string;
  currentRegion: string;
}

// ============================================================================
// Cache Management
// ============================================================================

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadRegionCache(): RegionCache | null {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      return data as RegionCache;
    }
  } catch (e) {}
  return null;
}

export function saveRegionCache(cache: RegionCache): void {
  ensureDataDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

export function isCacheValid(cache: RegionCache | null, projectId: string): boolean {
  if (!cache) return false;
  if (cache.projectId !== projectId) return false;
  if (Date.now() - cache.lastUpdated > CACHE_TTL_MS) return false;
  return true;
}

// ============================================================================
// Model Discovery
// ============================================================================

async function getAccessToken(): Promise<string> {
  const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  return tokenResponse.token || '';
}

/**
 * Check if a Claude model is available in a specific region
 * by attempting a minimal API call
 */
async function checkClaudeModelInRegion(
  projectId: string,
  region: string,
  modelId: string,
  accessToken: string
): Promise<{ available: boolean; error?: string }> {
  // Try to make a minimal rawPredict call with very small input
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/anthropic/models/${modelId}:rawPredict`;
  
  const testRequest = {
    anthropic_version: 'vertex-2023-10-16',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }]
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(testRequest),
      signal: AbortSignal.timeout(15000)
    });

    // Model is available if we get a successful response OR a rate limit error
    // (rate limit means the model exists but we hit quota)
    if (response.ok) {
      return { available: true };
    }
    
    const text = await response.text();
    
    // Rate limit or quota exceeded = model exists
    if (response.status === 429 || text.includes('quota') || text.includes('rate')) {
      return { available: true };
    }
    
    // Model not found in this region
    if (response.status === 404 || 
        text.includes('not found') || 
        text.includes('does not exist') ||
        text.includes('not supported') ||
        text.includes('is not available')) {
      return { available: false };
    }
    
    // Permission denied might mean model exists but not enabled
    if (response.status === 403 && text.includes('permission')) {
      return { available: false, error: 'permission_denied' };
    }

    // Other errors - assume not available but log
    return { available: false, error: `${response.status}: ${text.slice(0, 100)}` };
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.message?.includes('timeout')) {
      return { available: false, error: 'timeout' };
    }
    return { available: false, error: e.message?.slice(0, 100) };
  }
}

/**
 * Check if a Gemini model is available in a specific region
 */
async function checkGeminiModelInRegion(
  projectId: string,
  region: string,
  modelId: string,
  accessToken: string
): Promise<{ available: boolean; error?: string }> {
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${modelId}:generateContent`;
  
  const testRequest = {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    generationConfig: { maxOutputTokens: 1 }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(testRequest),
      signal: AbortSignal.timeout(15000)
    });

    if (response.ok) {
      return { available: true };
    }
    
    const text = await response.text();
    
    if (response.status === 429 || text.includes('quota') || text.includes('rate')) {
      return { available: true };
    }
    
    if (response.status === 404 || text.includes('not found')) {
      return { available: false };
    }

    return { available: false, error: `${response.status}` };
  } catch (e: any) {
    return { available: false, error: e.message?.slice(0, 50) };
  }
}

// ============================================================================
// Main Discovery Function
// ============================================================================

export interface DiscoveryOptions {
  projectId: string;
  regions?: string[];
  models?: string[];
  includeGemini?: boolean;
  onProgress?: (progress: DiscoveryProgress) => void;
  concurrency?: number;
}

export async function discoverModelRegions(options: DiscoveryOptions): Promise<RegionCache> {
  const {
    projectId,
    regions = ALL_REGIONS,
    models = CLAUDE_MODELS,
    includeGemini = false,
    onProgress,
    concurrency = 3  // Lower concurrency to avoid rate limits
  } = options;

  const accessToken = await getAccessToken();
  
  const cache: RegionCache = {
    version: 2,
    projectId,
    lastUpdated: Date.now(),
    models: {}
  };

  const allModels = [...models];
  if (includeGemini) {
    allModels.push(...GEMINI_MODELS);
  }

  let completed = 0;
  const total = allModels.length * regions.length;

  // Process each model
  for (const modelId of allModels) {
    const isGemini = GEMINI_MODELS.includes(modelId);
    const availableRegions: string[] = [];
    const checkedRegions: string[] = [];

    // Check regions in batches
    for (let i = 0; i < regions.length; i += concurrency) {
      const batch = regions.slice(i, i + concurrency);
      
      const results = await Promise.all(
        batch.map(async (region) => {
          onProgress?.({
            total,
            completed,
            currentModel: modelId,
            currentRegion: region
          });

          const result = isGemini
            ? await checkGeminiModelInRegion(projectId, region, modelId, accessToken)
            : await checkClaudeModelInRegion(projectId, region, modelId, accessToken);
          
          completed++;
          return { region, available: result.available, error: result.error };
        })
      );

      for (const { region, available, error } of results) {
        checkedRegions.push(region);
        if (available) {
          availableRegions.push(region);
        }
      }

      // Small delay between batches to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    cache.models[modelId] = {
      modelId,
      provider: isGemini ? 'google' : 'anthropic',
      availableRegions,
      checkedRegions,
      lastChecked: Date.now()
    };
  }

  saveRegionCache(cache);
  return cache;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the best region for a model based on cache
 */
export function getBestRegion(modelId: string, preferredRegions?: string[]): string | null {
  const cache = loadRegionCache();
  if (!cache) return null;

  const modelInfo = cache.models[modelId];
  if (!modelInfo || modelInfo.availableRegions.length === 0) return null;

  // Prefer requested regions
  if (preferredRegions) {
    for (const region of preferredRegions) {
      if (modelInfo.availableRegions.includes(region)) {
        return region;
      }
    }
  }

  // Default priority: us-east5 > us-central1 > europe-west1
  const priority = ['us-east5', 'us-central1', 'europe-west1', 'us-east1'];
  for (const region of priority) {
    if (modelInfo.availableRegions.includes(region)) {
      return region;
    }
  }

  return modelInfo.availableRegions[0];
}

/**
 * Get all regions for a model
 */
export function getModelRegions(modelId: string): string[] {
  const cache = loadRegionCache();
  if (!cache) return [];

  const modelInfo = cache.models[modelId];
  return modelInfo?.availableRegions || [];
}

/**
 * Format cache for display
 */
export function formatCacheForDisplay(cache: RegionCache): string {
  const lines: string[] = [];
  
  lines.push(`Model Region Cache (v${cache.version})`);
  lines.push(`${'='.repeat(50)}`);
  lines.push(`Project:  ${cache.projectId}`);
  lines.push(`Updated:  ${new Date(cache.lastUpdated).toISOString()}`);
  lines.push(`Age:      ${Math.round((Date.now() - cache.lastUpdated) / 1000 / 60)} minutes`);
  lines.push(``);

  // Group by provider
  const byProvider: Record<string, ModelRegionInfo[]> = { anthropic: [], google: [] };
  for (const model of Object.values(cache.models)) {
    byProvider[model.provider]?.push(model);
  }

  const providerNames: Record<string, string> = {
    anthropic: '🤖 Claude Models',
    google: '✨ Gemini Models'
  };

  for (const [provider, models] of Object.entries(byProvider)) {
    if (models.length === 0) continue;
    
    lines.push(`\n${providerNames[provider] || provider}`);
    lines.push(`${'─'.repeat(50)}`);
    
    for (const model of models.sort((a, b) => a.modelId.localeCompare(b.modelId))) {
      const regionCount = model.availableRegions.length;
      const status = regionCount > 0 ? `✓ ${regionCount} regions` : '✗ not available';
      lines.push(`  ${model.modelId}`);
      lines.push(`    ${status}: ${model.availableRegions.join(', ') || 'none'}`);
    }
  }

  return lines.join('\n');
}
