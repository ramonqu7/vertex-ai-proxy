# Streaming Fixes for Clawdbot Integration

## Problem Summary
Clawdbot was experiencing streaming issues where after one prompt, subsequent requests would not stream properly or connections would fail.

## Root Causes Identified

### 1. Missing Anti-Buffering Header (GenAI Handler)
**Location:** `src/index.ts:1004`

The `handleGenAI Chat` function was missing the `X-Accel-Buffering: no` header, causing nginx reverse proxies to buffer the entire response before sending it to the client. This prevented real-time streaming.

### 2. Improper Error Handling During Streaming
**Location:** `src/index.ts:515-533`

When errors occurred mid-stream, the code attempted to send a JSON error response on a connection that already had streaming headers sent. This corrupted the response and left the client connection in a bad state, preventing subsequent requests from working properly.

### 3. Missing Initial Role Chunk
**Locations:**
- `handleGenAIChat` (line ~1001)
- `handleGeminiChat` (line ~861)

Some clients (including Clawdbot) expect an initial SSE chunk with the assistant role before content chunks. Without this, clients may not properly initialize the streaming response.

### 4. Inconsistent Completion IDs
**Locations:**
- `handleGenAIChat` (line ~1020)
- `handleGeminiChat` (line ~873)

Each chunk was generating a new completion ID with `Date.now()`, which could confuse clients expecting consistent IDs across all chunks in a single response.

## Fixes Applied

### Fix 1: Added X-Accel-Buffering Header
```typescript
res.setHeader("X-Accel-Buffering", "no");
```
Added to both `handleGenAIChat` and `handleGeminiChat` streaming sections.

### Fix 2: Fixed Error Handling
```typescript
catch (error: any) {
  log(`Error: ${error.message}`, 'ERROR');

  // If headers already sent (streaming started), we can't send JSON error
  if (res.headersSent) {
    log('Headers already sent, ending response', 'WARN');
    res.end();
    return;
  }

  // ... rest of error handling
}
```

Added header check in:
- `handleChatCompletions` main error handler
- `handleAnthropicChat` streaming error handler
- `handleGeminiChat` streaming error handler
- `handleGenAIChat` streaming error handler

### Fix 3: Added Initial Role Chunk
```typescript
// Send initial role chunk
res.write(`data: ${JSON.stringify({
  id: completionId,
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: modelId,
  choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
})}\n\n`);
```

Added to both `handleGenAIChat` and `handleGeminiChat` before streaming content.

### Fix 4: Consistent Completion IDs
```typescript
const completionId = `chatcmpl-${Date.now()}`;
```

Created once at the start of streaming and reused for all chunks in the response.

## Testing Recommendations

### 1. Test Single Request Streaming
```bash
curl -N http://localhost:8001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5@20250929",
    "messages": [{"role": "user", "content": "Count to 10 slowly"}],
    "stream": true
  }'
```

Should see smooth, unbuffered streaming output.

### 2. Test Multiple Consecutive Requests
Run the same request 3-5 times in succession. Each request should stream properly without connection issues.

### 3. Test with Clawdbot
Configure Clawdbot to use the proxy and send multiple prompts in a conversation. Verify that:
- First prompt streams properly
- Second prompt streams properly
- Subsequent prompts continue streaming
- No connection errors or hangs

### 4. Test Error Recovery
Simulate an error (e.g., invalid model, rate limit) during streaming. Verify that:
- The connection closes gracefully
- Subsequent requests work normally
- No corrupted responses are sent

## Expected Behavior After Fixes

1. **Consistent Streaming**: All requests should stream in real-time without buffering
2. **No Connection Corruption**: Errors during streaming should close the connection gracefully
3. **Multi-Request Stability**: Clawdbot can make multiple streaming requests in sequence without issues
4. **Proper SSE Format**: All streaming responses include initial role chunk, content chunks with consistent IDs, final stop chunk, and [DONE] marker

## Files Modified

- `src/index.ts`: All streaming handlers updated
- `dist/index.js`: Rebuilt from TypeScript source

## Version

Applied to version: 1.3.0
Date: 2026-02-01
