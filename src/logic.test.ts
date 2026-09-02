import { describe, it, expect, vi } from "vitest";
import {
  createProgressState,
  getWorkingMessage,
  shouldClearPrefill,
  buildPrefillMessage,
  prefillComplete,
  formatTps,
  createTurnStats,
  accumulateStep,
  formatTurnStats,
  fmtTime,
  formatDuration,
  captureStream,
  ensureStreamOptions,
  parseSseLine,
  applyEvent,
  usageToTimings,
  resetGenerationState,
  resetForNextTurn,
  MIN_GEN_ELAPSED_MS,
} from "./logic.js";

describe("formatDuration", () => {
  it("rounds sub-minute to seconds", () => {
    expect(formatDuration(2.4)).toBe("2s");
    expect(formatDuration(59.9)).toBe("60s");
  });
  it("splits minutes and seconds", () => {
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(125.6)).toBe("2m 6s");
  });
});

describe("fmtTime", () => {
  it("returns empty for missing/zero", () => {
    expect(fmtTime(undefined)).toBe("");
    expect(fmtTime(0)).toBe("");
  });
  it("formats ms and seconds", () => {
    expect(fmtTime(500)).toBe("500ms");
    expect(fmtTime(1000)).toBe("1s");
    expect(fmtTime(1200)).toBe("1.2s");
    expect(fmtTime(2000)).toBe("2s");
  });
});

describe("buildPrefillMessage", () => {
  it("shows bare label when total/processed missing", () => {
    expect(buildPrefillMessage({})).toBe("Prefilling...");
  });
  it("builds bar at 30%", () => {
    const msg = buildPrefillMessage({ total: 100, processed: 30, time_ms: 2000 });
    // 30% of 20 = 6 filled
    expect(msg).toContain("██████░░░░░░░░░░░░░░");
    expect(msg).toContain(" 30%");
  });
  it("builds full bar at 100%", () => {
    const msg = buildPrefillMessage({ total: 10, processed: 10, time_ms: 1000 });
    expect(msg).toContain("████████████████████");
    expect(msg).toContain("100%");
  });
  it("includes ETA + tps suffix when time present", () => {
    const msg = buildPrefillMessage({ total: 100, processed: 50, time_ms: 1000 });
    expect(msg).toContain("tok/s");
    expect(msg).toContain("s"); // ETA
  });
  it("clamps bar and percent on server overshoot (processed > total)", () => {
    const msg = buildPrefillMessage({ total: 100, processed: 150, time_ms: 1000 });
    expect(msg).toContain("████████████████████");
    expect(msg).toContain("100%");
    expect(msg).not.toContain("150%");
  });
  it("omits the rate/ETA suffix for negative time_ms", () => {
    const msg = buildPrefillMessage({ total: 100, processed: 50, time_ms: -1000 });
    expect(msg).toContain(" 50%");
    expect(msg).not.toContain("tok/s");
  });
});

describe("getWorkingMessage", () => {
  it("null before prefill received", () => {
    const s = createProgressState();
    expect(getWorkingMessage(s)).toBeNull();
  });
  it("prefill bar before generation", () => {
    const s = createProgressState();
    s.currentProgress = { total: 100, processed: 40, time_ms: 1000 };
    expect(getWorkingMessage(s)).toContain("Prefilling...");
  });
  it("null during generation until elapsed threshold met", () => {
    const s = createProgressState();
    s.isGenerating = true;
    s.generationTokens = 5;
    s.latestTimings = {
      predicted_per_second: 24.5,
      predicted_ms: MIN_GEN_ELAPSED_MS - 1, // below threshold
    };
    expect(getWorkingMessage(s)).toBeNull();
  });
  it("shows TPS once elapsed meets threshold", () => {
    const s = createProgressState();
    s.isGenerating = true;
    s.generationTokens = 42;
    s.latestTimings = {
      predicted_per_second: 24.5,
      predicted_ms: MIN_GEN_ELAPSED_MS + 50,
    };
    expect(getWorkingMessage(s)).toBe("24.5 tok/s (42 tokens)");
  });
  it("falls back to 'Generating... (Ns)' when server sends no timings", () => {
    const s = createProgressState();
    s.isGenerating = true;
    s.generationStartMs = 1000;
    expect(getWorkingMessage(s, 3499)).toBe("Generating... (2s)");
  });
  it("server timings take precedence over the local fallback", () => {
    const s = createProgressState();
    s.isGenerating = true;
    s.generationStartMs = 1000;
    s.generationTokens = 42;
    s.latestTimings = {
      predicted_per_second: 24.5,
      predicted_ms: MIN_GEN_ELAPSED_MS + 50,
    };
    expect(getWorkingMessage(s, 3499)).toBe("24.5 tok/s (42 tokens)");
  });
});

describe("usageToTimings", () => {
  it("maps TabbyAPI usage stats to Timings", () => {
    const t = usageToTimings({
      prompt_tokens: 25,
      prompt_time: 0.14,
      prompt_tokens_per_sec: 178.57,
      completion_tokens: 294,
      completion_time: 2.06,
      completion_tokens_per_sec: 142.64,
      total_tokens: 319,
      total_time: 2.21,
    });
    expect(t).toEqual({
      predicted_n: 294,
      predicted_ms: 2060,
      predicted_per_second: 142.64,
      prompt_n: 25,
      prompt_ms: 140,
      prompt_per_second: 178.57,
    });
  });
  it("returns null for standard OpenAI usage (no timing fields)", () => {
    expect(usageToTimings({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 })).toBeNull();
  });
  it("returns null for non-object input", () => {
    expect(usageToTimings(null)).toBeNull();
    expect(usageToTimings("x")).toBeNull();
    expect(usageToTimings(undefined)).toBeNull();
  });
  it("coerces string numbers (TabbyAPI schema allows string rates)", () => {
    const t = usageToTimings({
      completion_tokens: 10,
      completion_time: "1.0",
      completion_tokens_per_sec: "12.5",
    });
    expect(t?.predicted_per_second).toBe(12.5);
    expect(t?.predicted_ms).toBe(1000);
  });
});

describe("prefillComplete", () => {
  it("handles missing, partial, exact, and overshoot", () => {
    expect(prefillComplete(null)).toBe(false);
    expect(prefillComplete({})).toBe(false);
    expect(prefillComplete({ total: 10, processed: 9 })).toBe(false);
    expect(prefillComplete({ total: 10, processed: 10 })).toBe(true);
    expect(prefillComplete({ total: 10, processed: 12 })).toBe(true);
  });
});

describe("shouldClearPrefill", () => {
  it("true at 100% not generating", () => {
    const s = createProgressState();
    s.currentProgress = { total: 10, processed: 10 };
    expect(shouldClearPrefill(s)).toBe(true);
  });
  it("false while generating", () => {
    const s = createProgressState();
    s.isGenerating = true;
    s.currentProgress = { total: 10, processed: 10 };
    expect(shouldClearPrefill(s)).toBe(false);
  });
  it("false below 100%", () => {
    const s = createProgressState();
    s.currentProgress = { total: 10, processed: 9 };
    expect(shouldClearPrefill(s)).toBe(false);
  });
});

describe("formatTps", () => {
  it("null when predicted missing or below threshold", () => {
    expect(formatTps({})).toBeNull();
    expect(formatTps({ predicted_per_second: 10, predicted_ms: MIN_GEN_ELAPSED_MS - 1 })).toBeNull();
  });
  it("generation-only format", () => {
    const out = formatTps({ predicted_per_second: 24.5, predicted_ms: 1200 });
    expect(out).toBe("Generation: 24.5 tok/s (1.2s)");
  });
  it("prefill + generation format", () => {
    const out = formatTps({
      predicted_per_second: 24.5,
      predicted_ms: 1200,
      prompt_per_second: 120.3,
      prompt_ms: 800,
    });
    expect(out).toBe("Prefill: 120.3 tok/s (800ms) | Generation: 24.5 tok/s (1.2s)");
  });
});

describe("ensureStreamOptions", () => {
  it("adds missing fields to string body", () => {
    const { body, handled } = ensureStreamOptions(
      JSON.stringify({ stream: true, model: "x" }),
    );
    const p = JSON.parse(body as string);
    expect(handled).toBe(true);
    expect(p.stream_options).toEqual({ include_usage: true });
    expect(p.return_progress).toBe(true);
    expect(p.timings_per_token).toBe(true);
  });
  it("does not clobber existing include_usage", () => {
    const { body } = ensureStreamOptions(
      JSON.stringify({ stream: true, stream_options: { include_usage: false } }),
    );
    const p = JSON.parse(body as string);
    expect(p.stream_options.include_usage).toBe(false);
  });
  it("adds include_usage to existing stream_options without other fields", () => {
    const { body } = ensureStreamOptions(
      JSON.stringify({ stream: true, stream_options: { keep: 1 } }),
    );
    const p = JSON.parse(body as string);
    expect(p.stream_options).toEqual({ keep: 1, include_usage: true });
  });
  it("leaves non-JSON string bodies untouched", () => {
    const { body, handled } = ensureStreamOptions("not json");
    expect(handled).toBe(false);
    expect(body).toBe("not json");
  });
  it("handles plain object body", () => {
    const { body, handled } = ensureStreamOptions({ stream: true });
    expect(handled).toBe(true);
    expect((body as any).return_progress).toBe(true);
  });
  it("does not touch special bodies", () => {
    const fd = new FormData();
    const { handled } = ensureStreamOptions(fd);
    expect(handled).toBe(false);
  });
  it("does not mutate the caller's stream_options object", () => {
    const callerOptions = { keep: 1 };
    const { body } = ensureStreamOptions({ stream: true, stream_options: callerOptions });
    expect((body as any).stream_options).toEqual({ keep: 1, include_usage: true });
    expect(callerOptions).toEqual({ keep: 1 });
  });
});

describe("captureStream", () => {
  const enc = new TextEncoder();
  const oneChunk = (s: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(s));
        c.close();
      },
    });

  async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
    const events: string[] = [];
    const stream = captureStream(body, (ev) => events.push(ev.kind));
    const reader = stream.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    return events;
  }

  it("parses a final line without a trailing newline", async () => {
    const events = await collect(
      oneChunk('data: {"prompt_progress":{"total":10,"processed":5}}'),
    );
    expect(events).toContain("prompt_progress");
  });

  it("accepts data: without a space (per SSE spec)", async () => {
    const events = await collect(oneChunk('data:{"timings":{"predicted_per_second":1}}\n'));
    expect(events).toContain("timings");
  });

  it("ignores non-data lines (comments, event types)", async () => {
    const events = await collect(
      oneChunk(": comment\nevent: progress\ndata: {\"timings\":{\"a\":1}}\n"),
    );
    expect(events).toEqual(["timings"]);
  });

  it("drains nothing until the consumer reads", async () => {
    let pulls = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(enc.encode(`data: {"n":${pulls}}\n`));
      },
    });
    captureStream(upstream, () => {});
    expect(pulls).toBe(0);
  });

  it("applies backpressure: upstream is not drained ahead of the consumer", async () => {
    const chunks = Array.from({ length: 20 }, (_, i) => enc.encode(`data: {"n":${i}}\n`));
    let pulls = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        if (pulls <= chunks.length) c.enqueue(chunks[pulls - 1]);
        else c.close();
      },
    });
    const out = captureStream(upstream, () => {});
    const reader = out.getReader();
    await reader.read(); // one chunk consumed; queue fully drained
    await new Promise((r) => setTimeout(r, 0)); // let any pending pulls settle
    expect(pulls).toBeLessThan(chunks.length);
    while (!(await reader.read()).done) { /* drain */ }
    // +1: the pull that closes the stream
    expect(pulls).toBe(chunks.length + 1);
  });

  it("cancels the upstream when the consumer cancels mid-stream", async () => {
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"n":1}\n'));
        // never closes: without cancel propagation this would leak forever
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const out = captureStream(upstream, () => {});
    const reader = out.getReader();
    await reader.read();
    await reader.cancel();
    expect(upstreamCancelled).toBe(true);
  });

  it("parses CRLF-framed streams (TabbyAPI sends \r\n, llama-server \n)", async () => {
    const events: string[] = [];
    const stream = captureStream(
      oneChunk(
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\r\n\r\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":3,"completion_time":1.0,"completion_tokens_per_sec":3.0}}\r\n\r\n' +
          'data: [DONE]\r\n\r\n',
      ),
      (ev) => events.push(ev.kind),
    );
    const reader = stream.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    expect(events).toEqual(["content", "usage", "done"]);
  });

  it("parses CRLF when the final line has no trailing newline", async () => {
    const events: string[] = [];
    const stream = captureStream(oneChunk('data: [DONE]\r'), (ev) => events.push(ev.kind));
    const reader = stream.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    expect(events).toEqual(["done"]);
  });
});

describe("parseSseLine", () => {
  it("detects [DONE]", () => {
    expect(parseSseLine("[DONE]")).toEqual({ kind: "done" });
  });
  it("parses prompt_progress", () => {
    const ev = parseSseLine(JSON.stringify({ prompt_progress: { total: 100, processed: 10 } }));
    expect(ev.kind).toBe("prompt_progress");
  });
  it("parses timings", () => {
    const ev = parseSseLine(JSON.stringify({ timings: { predicted_per_second: 5 } }));
    expect(ev.kind).toBe("timings");
  });
  it("parses usage", () => {
    const ev = parseSseLine(JSON.stringify({ usage: { total_tokens: 3 } }));
    expect(ev.kind).toBe("usage");
  });
  it("parses content delta", () => {
    const ev = parseSseLine(JSON.stringify({ choices: [{ delta: { content: "hi" } }] }));
    expect(ev).toEqual({ kind: "content", content: "hi" });
  });
  it("parses reasoning_content delta as content (thinking models)", () => {
    const ev = parseSseLine(JSON.stringify({ choices: [{ delta: { reasoning_content: "hmm" } }] }));
    expect(ev).toEqual({ kind: "content", content: "hmm" });
  });
  it("returns other on invalid json", () => {
    expect(parseSseLine("not json")).toEqual({ kind: "other" });
  });
  it("returns other for valid json without known fields", () => {
    expect(parseSseLine(JSON.stringify({ foo: 1 }))).toEqual({ kind: "other" });
  });
});

describe("applyEvent", () => {
  it("prompt_progress sets prefill state", () => {
    const s = createProgressState();
    applyEvent(s, { kind: "prompt_progress", progress: { total: 100, processed: 20 } });
    expect(s.currentProgress?.processed).toBe(20);
  });

  it("timings flips to generation only after prefill done", () => {
    const s = createProgressState();
    s.currentProgress = { total: 100, processed: 50 }; // not done
    applyEvent(s, { kind: "timings", timings: { predicted_n: 3 } });
    expect(s.isGenerating).toBe(false);

    s.currentProgress = { total: 100, processed: 100 };
    applyEvent(s, { kind: "timings", timings: { predicted_n: 7 } });
    expect(s.isGenerating).toBe(true);
    expect(s.generationTokens).toBe(7);
  });

  it("timings predicted_n uses max to avoid backward jumps", () => {
    const s = createProgressState();
    s.isGenerating = true;
    s.tokenCountFromServer = true;
    s.generationTokens = 10;
    applyEvent(s, { kind: "timings", timings: { predicted_n: 5 } });
    // Should keep 10, not drop to 5
    expect(s.generationTokens).toBe(10);
    applyEvent(s, { kind: "timings", timings: { predicted_n: 15 } });
    expect(s.generationTokens).toBe(15);
  });

  it("content delta increments tokens and flips generating", () => {
    const s = createProgressState();
    applyEvent(s, { kind: "content", content: "a" });
    applyEvent(s, { kind: "content", content: "b" });
    expect(s.isGenerating).toBe(true);
    expect(s.generationTokens).toBe(2);
  });

  it("content flip records generation start time", () => {
    const s = createProgressState();
    applyEvent(s, { kind: "content", content: "a" }, 1234);
    expect(s.generationStartMs).toBe(1234);
  });

  it("usage with timing stats stores final timings for the turn-end toast", () => {
    const s = createProgressState();
    s.isGenerating = true;
    applyEvent(s, {
      kind: "usage",
      usage: {
        prompt_tokens: 5,
        prompt_time: 0.1,
        prompt_tokens_per_sec: 50,
        completion_tokens: 10,
        completion_time: 1.2,
        completion_tokens_per_sec: 8.3,
      },
    });
    expect(s.latestTimings?.predicted_per_second).toBe(8.3);
    expect(s.latestTimings?.predicted_ms).toBe(1200);
    expect(s.latestTimings?.prompt_per_second).toBe(50);
    // request-boundary reset still happened
    expect(s.isGenerating).toBe(false);
    expect(s.generationStartMs).toBeNull();
  });

  it("usage without timing fields leaves latestTimings untouched", () => {
    const s = createProgressState();
    s.latestTimings = { predicted_per_second: 24.5, predicted_ms: 1200 };
    applyEvent(s, {
      kind: "usage",
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
    expect(s.latestTimings).toEqual({ predicted_per_second: 24.5, predicted_ms: 1200 });
  });

  it("local content count is discarded when server count arrives", () => {
    const s = createProgressState();
    s.currentProgress = { total: 10, processed: 10 };
    applyEvent(s, { kind: "content", content: "a" });
    applyEvent(s, { kind: "content", content: "b" });
    expect(s.generationTokens).toBe(2);
    applyEvent(s, { kind: "timings", timings: { predicted_n: 1 } });
    // Server value wins, not max(local=2, server=1)
    expect(s.tokenCountFromServer).toBe(true);
    expect(s.generationTokens).toBe(1);
    // Content chunks no longer inflate the server count
    applyEvent(s, { kind: "content", content: "c" });
    expect(s.generationTokens).toBe(1);
  });

  it("resets tokenCountFromServer on request boundary", () => {
    const s = createProgressState();
    s.tokenCountFromServer = true;
    resetGenerationState(s);
    expect(s.tokenCountFromServer).toBe(false);
  });

  it("reset clears generation start time", () => {
    const s = createProgressState();
    s.generationStartMs = 5;
    resetGenerationState(s);
    expect(s.generationStartMs).toBeNull();
  });

  it("other event leaves state untouched and requests no update", () => {
    const s = createProgressState();
    s.currentProgress = { total: 10, processed: 3 };
    expect(applyEvent(s, { kind: "other" })).toBe(false);
    expect(s.currentProgress?.processed).toBe(3);
  });

  it("done + usage reset for next request", () => {
    const s = createProgressState();
    s.currentProgress = { total: 1, processed: 1 };
    s.isGenerating = true;
    s.generationTokens = 9;
    applyEvent(s, { kind: "done" });
    expect(s.currentProgress).toBeNull();
    expect(s.isGenerating).toBe(false);
    expect(s.generationTokens).toBe(0);
  });
});

describe("resetForNextTurn", () => {
  it("clears timings and UI throttle", () => {
    const s = createProgressState();
    s.latestTimings = { predicted_per_second: 1 };
    s.lastUiUpdateMs = 123;
    resetForNextTurn(s);
    expect(s.latestTimings).toBeNull();
    expect(s.lastUiUpdateMs).toBe(0);
  });
});

describe("run stats accumulation", () => {
  it("accumulates multiple steps and formats aggregate TPS", () => {
    const t = createTurnStats();
    accumulateStep(t, { predicted_n: 100, predicted_ms: 1000, prompt_n: 50, prompt_ms: 500 });
    accumulateStep(t, { predicted_n: 50, predicted_ms: 1000, prompt_n: 100, prompt_ms: 500 });
    expect(formatTurnStats(t)).toBe("Prefill: 150.0 tok/s (1s) | Generation: 75.0 tok/s (2s)");
  });

  it("skips steps below the generation elapsed threshold", () => {
    const t = createTurnStats();
    accumulateStep(t, { predicted_n: 2, predicted_ms: 10 });
    accumulateStep(t, { predicted_n: 100, predicted_ms: 1000 });
    expect(formatTurnStats(t)).toBe("Generation: 100.0 tok/s (1s)");
  });

  it("null when no usable stats accumulated", () => {
    expect(formatTurnStats(createTurnStats())).toBeNull();
    const t = createTurnStats();
    accumulateStep(t, null);
    accumulateStep(t, { prompt_n: 10, prompt_ms: 100 }); // prompt only, no generation
    expect(formatTurnStats(t)).toBeNull();
  });

  it("derives prefill rate from server rate when prompt_n includes cached tokens (TabbyAPI)", () => {
    const t = createTurnStats();
    // TabbyAPI: prompt_n = total (cached + new), prompt_per_second = new only
    accumulateStep(t, {
      predicted_n: 68,
      predicted_ms: 2240,
      prompt_n: 27638,
      prompt_ms: 730,
      prompt_per_second: 336.99,
    });
    expect(formatTurnStats(t)).toBe("Prefill: 337.0 tok/s (730ms) | Generation: 30.4 tok/s (2.2s)");
  });

  it("generation-only format when a step has no prompt stats", () => {
    const t = createTurnStats();
    accumulateStep(t, { predicted_n: 200, predicted_ms: 1000 });
    expect(formatTurnStats(t)).toBe("Generation: 200.0 tok/s (1s)");
  });
});
