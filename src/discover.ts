/**
 * Model Discovery - Probes Vertex AI to find available models per region
 */

import { GoogleAuth } from "google-auth-library";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CACHE_FILE = path.join(os.homedir(), ".vertex_proxy", "model_cache.json");
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

interface ModelAvailability {
  modelId: string;
  region: string;
  available: boolean;
  lastChecked: number;
  error?: string;
}

interface ModelCache {
  lastUpdated: number;
  models: Record<string, ModelAvailability[]>;
}

const REGIONS = ["us-east5", "europe-west1", "asia-southeast1", "asia-east1", "us-central1"];

const CLAUDE_MODELS = [
  "claude-opus-4-5@20251101",
  "claude-sonnet-4-5@20250929",
  "claude-sonnet-4@20250514",
  "claude-haiku-4-5@20251001",
  "claude-opus-4@20250410",
  "claude-3-haiku@20240307",
  "claude-3-5-sonnet@20240620",
  "claude-3-5-sonnet-v2@20241022",
];

export async function discoverModels(projectId: string): Promise<ModelCache> {
  const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const accessToken = tokenResponse.token;

  const cache: ModelCache = { lastUpdated: Date.now(), models: {} };

  for (const modelId of CLAUDE_MODELS) {
    cache.models[modelId] = [];
    
    for (const region of REGIONS) {
      const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/anthropic/models/${modelId}:rawPredict`;
      
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

        const data = await response.json() as any;
        const available = response.ok || (data.content && data.content.length > 0);
        
        cache.models[modelId].push({
          modelId,
          region,
          available,
          lastChecked: Date.now(),
          error: available ? undefined : data.error?.message
        });
        
        console.log(`  ${modelId} @ ${region}: ${available ? "✓" : "✗"}`);
        
      } catch (e: any) {
        cache.models[modelId].push({
          modelId,
          region,
          available: false,
          lastChecked: Date.now(),
          error: e.message
        });
      }
    }
  }

  // Save cache
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  
  return cache;
}

export function loadModelCache(): ModelCache | null {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as ModelCache;
      if (Date.now() - cache.lastUpdated < CACHE_TTL) {
        return cache;
      }
    }
  } catch (e) {}
  return null;
}

export function getBestRegion(modelId: string): string | null {
  const cache = loadModelCache();
  if (!cache || !cache.models[modelId]) return null;
  
  const available = cache.models[modelId].filter(m => m.available);
  if (available.length === 0) return null;
  
  // Prefer us-east5 > europe-west1 > others
  const priority = ["us-east5", "europe-west1", "asia-southeast1", "us-central1"];
  for (const region of priority) {
    if (available.find(m => m.region === region)) {
      return region;
    }
  }
  
  return available[0].region;
}
