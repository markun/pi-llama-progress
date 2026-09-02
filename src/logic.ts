/**
 * pi-llama-progress — pure logic
 *
 * No side effects, no global mutation. All state lives in a ProgressState
 * object returned by createProgressState(). The wiring layer (index.ts)
 * owns fetch interception and pi event hooks and calls into these helpers.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

export const UI_UPDATE_THROTTLE_MS = 250;
export const MIN_GEN_ELAPSED_MS = 100;
export const BAR_WIDTH = 20;


// ─── Types ───────────────────────────────────────────────────────────────────

export interface PromptProgress {
  total?: number;
  processed?: number;
  time_ms?: number;
}

export interface Timings {
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_second?: number;
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_second?: number;
}

export interface ProgressState {
  // Prefill progress
  currentProgress: PromptProgress | null;
  // Generation phase
  generationTokens: number;
  tokenCountFromServer: boolean;
  isGenerating: boolean;
  // Local clock of generation start (fallback display for servers without
  // per-token timings, e.g. TabbyAPI)
  generationStartMs: number | null;
  // UI throttle
  lastUiUpdateMs: number;
  // TPS display
  latestTimings: Timings | null;
}

export function createProgressState(): ProgressState {
  return {
    currentProgress: null,
    generationTokens: 0,
    tokenCountFromServer: false,
    isGenerating: false,
    generationStartMs: null,
    lastUiUpdateMs: 0,
    latestTimings: null,
  };
}

// ─── Helpers: duration / rate / ETA ─────────────────────────────────────────

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export function fmtTime(ms: number | undefined): string {
  if (!ms || ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}

// ─── Prefill progress bar ────────────────────────────────────────────────────

export function buildPrefillMessage(p: PromptProgress): string {
  if (!p.total || p.processed === undefined) {
    return "Prefilling...";
  }
  const pct = Math.min(100, (p.processed / p.total) * 100);
  // Clamp filled: server overshoot (processed > total) must not make
  // repeat() receive a negative count and throw RangeError.
  const filled = Math.min(BAR_WIDTH, Math.max(0, Math.round((pct / 100) * BAR_WIDTH)));
  const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  let suffix = "";
  const timeMs = p.time_ms;
  if (timeMs && timeMs > 0 && p.processed > 0) {
    const rate = p.processed / (timeMs / 1000); // tok/s, > 0 here
    const etaSec = (p.total - p.processed) / rate;
    suffix = `${formatDuration(etaSec)} · ${rate.toFixed(1)} tok/s`;
  }
  return `Prefilling... ${bar} ${pct.toFixed(0).padStart(3)}%${suffix ? ` · ${suffix}` : ""}`;
}

// ─── Working message (prefill progress + generation TPS) ─────────────────────

export function getWorkingMessage(s: ProgressState, now: number = Date.now()): string | null {
  // Generation phase — show TPS from server-provided stats (no local clock).
  if (s.isGenerating) {
    const tps = s.latestTimings?.predicted_per_second;
    const elapsedMs = s.latestTimings?.predicted_ms;
    if (
      s.generationTokens > 0 &&
      tps &&
      tps > 0 &&
      elapsedMs &&
      elapsedMs >= MIN_GEN_ELAPSED_MS
    ) {
      return `${tps.toFixed(1)} tok/s (${s.generationTokens} tokens)`;
    }
    // Server without per-token timings (e.g. TabbyAPI): no rate is
    // available mid-stream, so show elapsed time only.
    if (s.generationStartMs !== null) {
      const secs = Math.max(0, Math.floor((now - s.generationStartMs) / 1000));
      return `Generating... (${secs}s)`;
    }
    return null;
  }
  // Prefill phase
  if (!s.currentProgress) return null;
  return buildPrefillMessage(s.currentProgress);
}

// Prefill is complete once the server reports all tokens processed.
export function prefillComplete(p: PromptProgress | null | undefined): boolean {
  return p?.total !== undefined && p.processed !== undefined && p.processed >= p.total;
}

// Prefill bar should clear once it hits 100% (and we're not generating yet).
export function shouldClearPrefill(s: ProgressState): boolean {
  return !s.isGenerating && prefillComplete(s.currentProgress);
}

// ─── End-of-turn TPS display ─────────────────────────────────────────────────

export function formatTps(data: Timings): string | null {
  const predicted = data.predicted_per_second;
  const prompt = data.prompt_per_second;
  const predictedMs = data.predicted_ms;
  const promptMs = data.prompt_ms;
  if (!predicted || predicted <= 0 || !predictedMs || predictedMs < MIN_GEN_ELAPSED_MS)
    return null;
  const genTime = fmtTime(predictedMs);
  const gen = `Generation: ${predicted.toFixed(1)} tok/s${genTime ? ` (${genTime})` : ""}`;
  if (!prompt || prompt <= 0) return gen;
  const promptTime = fmtTime(promptMs);
  return `Prefill: ${prompt.toFixed(1)} tok/s${promptTime ? ` (${promptTime})` : ""} | ${gen}`;
}

// ─── Per-agent-run stats accumulation ─────────────────────────────────────────────────

// pi fires turn_end for every LLM response within a user turn (one per tool
// step), so per-step timings are accumulated and reported once at agent_end.
export interface TurnStats {
  promptN: number;
  promptMs: number;
  completionN: number;
  completionMs: number;
}

export function createTurnStats(): TurnStats {
  return { promptN: 0, promptMs: 0, completionN: 0, completionMs: 0 };
}

// Fold one step's final timings into the running totals. Steps without
// usable generation stats (e.g. below the elapsed threshold) are skipped.
export function accumulateStep(t: TurnStats, step: Timings | null | undefined): void {
  if (
    step &&
    step.predicted_n &&
    step.predicted_n > 0 &&
    step.predicted_ms &&
    step.predicted_ms >= MIN_GEN_ELAPSED_MS
  ) {
    t.completionN += step.predicted_n;
    t.completionMs += step.predicted_ms;
  }
  if (step && step.prompt_n && step.prompt_n > 0 && step.prompt_ms && step.prompt_ms > 0) {
    t.promptN += step.prompt_n;
    t.promptMs += step.prompt_ms;
  }
}

// Aggregate TPS across all steps of the run, formatted like formatTps.
export function formatTurnStats(t: TurnStats): string | null {
  if (!t.completionN || !t.completionMs || t.completionMs < MIN_GEN_ELAPSED_MS) return null;
  const genTps = t.completionN / (t.completionMs / 1000);
  const genTime = fmtTime(t.completionMs);
  const gen = `Generation: ${genTps.toFixed(1)} tok/s${genTime ? ` (${genTime})` : ""}`;
  if (!t.promptN || !t.promptMs) return gen;
  const promptTps = t.promptN / (t.promptMs / 1000);
  const promptTime = fmtTime(t.promptMs);
  return `Prefill: ${promptTps.toFixed(1)} tok/s${promptTime ? ` (${promptTime})` : ""} | ${gen}`;
}

// ─── Request boundary reset ──────────────────────────────────────────────────

export function resetGenerationState(s: ProgressState): void {
  s.isGenerating = false;
  s.generationTokens = 0;
  s.tokenCountFromServer = false;
  s.generationStartMs = null;
}

export function resetForNextRequest(s: ProgressState): void {
  resetGenerationState(s);
  s.currentProgress = null;
}

export function resetForNextTurn(s: ProgressState): void {
  resetForNextRequest(s);
  s.lastUiUpdateMs = 0;
  s.latestTimings = null;
}

// ─── Stream option injection ─────────────────────────────────────────────────

// Ensures the chat-completions body requests the fields this plugin needs.
// Only mutates plain-object or JSON-string bodies; returns the (possibly
// updated) body and a flag indicating whether it was handled.
export function ensureStreamOptions(body: unknown): {
  body: unknown;
  handled: boolean;
} {
  if (typeof body === "string") {
    let p: Record<string, any>;
    try {
      p = JSON.parse(body);
    } catch {
      return { body, handled: false };
    }
    applyStreamOptions(p);
    return { body: JSON.stringify(p), handled: true };
  }
  if (body && typeof body === "object" && !isSpecialBody(body)) {
    const p = { ...(body as Record<string, any>) };
    applyStreamOptions(p);
    return { body: p, handled: true };
  }
  return { body, handled: false };
}

function isSpecialBody(body: unknown): boolean {
  // URLSearchParams / FormData / Blob / ReadableStream / Buffer — don't spread.
  return (
    body instanceof URLSearchParams ||
    typeof FormData !== "undefined" && body instanceof FormData ||
    typeof Blob !== "undefined" && body instanceof Blob ||
    typeof ReadableStream !== "undefined" && body instanceof ReadableStream ||
    Buffer.isBuffer(body)
  );
}

function applyStreamOptions(p: Record<string, any>): void {
  if (!p.stream_options) {
    p.stream_options = { include_usage: true };
  } else if (p.stream_options.include_usage === undefined) {
    // Clone: p is a copy of the caller's body, but stream_options would
    // still be the caller's object — mutating it would leak the change.
    p.stream_options = { ...p.stream_options, include_usage: true };
  }
  if (p.stream && !p.return_progress) {
    p.return_progress = true;
  }
  if (p.stream && !p.timings_per_token) {
    p.timings_per_token = true;
  }
}

// ─── Usage → Timings mapping ─────────────────────────────────────────────────

// Some servers (TabbyAPI) put full timing stats in the final `usage` chunk
// instead of streaming per-token `timings` events. Standard OpenAI usage has
// no timing fields, so the mapping only applies when the generation
// rate is present. Returns null when no usable stats are found.
export function usageToTimings(u: unknown): Timings | null {
  if (!u || typeof u !== "object") return null;
  const r = u as Record<string, unknown>;
  const num = (v: unknown): number | undefined => {
    const n = typeof v === "string" ? Number(v) : (v as number | undefined);
    return typeof n === "number" && Number.isFinite(n) ? n : undefined;
  };
  const genTps = num(r.completion_tokens_per_sec);
  if (genTps === undefined) return null;
  const completionTimeS = num(r.completion_time);
  const promptTimeS = num(r.prompt_time);
  return {
    predicted_n: num(r.completion_tokens),
    predicted_ms: completionTimeS !== undefined ? Math.round(completionTimeS * 1000) : undefined,
    predicted_per_second: genTps,
    prompt_n: num(r.prompt_tokens),
    prompt_ms: promptTimeS !== undefined ? Math.round(promptTimeS * 1000) : undefined,
    prompt_per_second: num(r.prompt_tokens_per_sec),
  };
}

// ─── SSE stream capture (pure) ───────────────────────────────────────────────

// Wraps a server response body, parses SSE `data:` lines, and invokes
// onEvent for each parsed event. Forwards the original bytes unchanged so
// the downstream consumer sees the SSE stream exactly as sent by the
// server. Reading is pull-driven: upstream reads only happen as fast as
// the downstream consumer reads, so backpressure is preserved.
export function captureStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: SseEvent) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let buffer = "";
  const decoder = new TextDecoder();

  const parseChunk = (value: Uint8Array) => {
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const payload = dataPayload(line);
      if (payload === null) continue;
      onEvent(parseSseLine(payload));
    }
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          // The final line may arrive without a trailing newline.
          const finalPayload = dataPayload(buffer);
          if (finalPayload !== null) onEvent(parseSseLine(finalPayload));
          decoder.decode();
          controller.close();
          return;
        }
        if (value) {
          parseChunk(value);
          // Forward the original bytes unchanged to preserve SSE framing
          controller.enqueue(value);
        }
      } catch (err) {
        reader.cancel(err).catch(() => {});
        controller.error(err);
      }
    },
    cancel(reason?: any) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

// ─── SSE line classification ─────────────────────────────────────────────────

export type SseEvent =
  | { kind: "done" }
  | { kind: "prompt_progress"; progress: PromptProgress }
  | { kind: "timings"; timings: Timings }
  | { kind: "usage"; usage: unknown }
  | { kind: "content"; content: string }
  | { kind: "other" };

// Extract the payload of an SSE data line; null for other event types.
// Per the SSE spec the space after "data:" is optional. Lines may carry a
// trailing carriage return (CRLF servers, e.g. TabbyAPI) while LF-only
// servers (llama-server) do not; `.` cannot match a line terminator, so the
// trailing `\r` must be consumed explicitly.
function dataPayload(line: string): string | null {
  const m = line.match(/^data:\ ?(.*)\r?$/);
  return m ? m[1] : null;
}

// Parse one SSE `data:` line (without the `data:` prefix).
export function parseSseLine(jsonStr: string): SseEvent {
  if (jsonStr === "[DONE]") return { kind: "done" };
  try {
    const chunk = JSON.parse(jsonStr);
    if (chunk.prompt_progress) return { kind: "prompt_progress", progress: chunk.prompt_progress };
    if (chunk.timings) return { kind: "timings", timings: chunk.timings };
    if (chunk.usage) return { kind: "usage", usage: chunk.usage };
    const delta = chunk.choices?.[0]?.delta;
    // reasoning_content (thinking models, e.g. Qwen via TabbyAPI) counts as
    // generated content for progress purposes.
    if (delta?.content) return { kind: "content", content: delta.content };
    if (delta?.reasoning_content) return { kind: "content", content: delta.reasoning_content };
    return { kind: "other" };
  } catch {
    return { kind: "other" };
  }
}

// Apply an SSE event to state. Returns true if a working-message update
// should be triggered by the caller.
export function applyEvent(s: ProgressState, ev: SseEvent, now: number = Date.now()): boolean {
  switch (ev.kind) {
    case "done":
      resetForNextRequest(s);
      return true;
    case "usage": {
      // TabbyAPI-style final chunk: carry the timing stats into the
      // turn-end toast. Standard OpenAI usage maps to null and is ignored.
      const t = usageToTimings(ev.usage);
      if (t) s.latestTimings = t;
      resetForNextRequest(s);
      return true;
    }
    case "prompt_progress":
      s.currentProgress = ev.progress;
      return true;
    case "timings": {
      s.latestTimings = ev.timings;
      if (!s.isGenerating && prefillComplete(s.currentProgress)) {
        s.isGenerating = true;
        s.generationTokens = 0;
        s.generationStartMs = now;
      }
      if (s.isGenerating && ev.timings.predicted_n !== undefined) {
        // Server predicted_n is authoritative. Discard any local content-chunk
        // count collected before the first timings event, then track the
        // server value (max guards against backward jumps).
        if (!s.tokenCountFromServer) s.generationTokens = 0;
        s.generationTokens = Math.max(s.generationTokens, ev.timings.predicted_n);
        s.tokenCountFromServer = true;
        return true;
      }
      return false;
    }
    case "content":
      if (!s.isGenerating) {
        s.isGenerating = true;
        s.generationStartMs = now;
      }
      // Local fallback count; superseded once server timings arrive
      if (!s.tokenCountFromServer) s.generationTokens++;
      return true;
    default:
      return false;
  }
}
