import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Wiring tests for the extension entry point: fetch interception, body
// injection, SSE capture, waiting message, turn-end toast, shutdown restore.

function sseStream(chunks: string[]): ReadableStream<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

const CHAT_URL = "https://llama.local/v1/chat/completions";

// Widget content is a component factory. Render the last configured widget
// and return its first line (undefined if widget cleared or never set).
function lastWidgetLine(): string | undefined {
  const call = ui.setWidget.mock.calls.at(-1);
  if (!call || typeof call[1] !== "function") return undefined;
  return (call[1] as any)({}, {}).render(100)[0];
}

// First rendered line of any factory-configured widget (stream end clears
// the widget, so the last call may be the clear).
function anyWidgetLine(): string | undefined {
  const call = ui.setWidget.mock.calls.filter((c) => typeof c[1] === "function").at(-1);
  if (!call) return undefined;
  return (call[1] as any)({}, {}).render(100)[0];
}

let handlers: Record<string, (...args: any[]) => void> = {};
let ui: {
  notify: ReturnType<typeof vi.fn>;
  setWidget: ReturnType<typeof vi.fn>;
};
let fetchCalls: { input: any; init?: any }[] = [];
let nextResponse: Response = new Response(null);
let pending: Promise<Response> | null = null;
let pendingResolve: ((r: Response) => void) | null = null;
let mockFetch: any;

async function loadExtension() {
  vi.resetModules();
  handlers = {};
  const mod = await import("./index.ts");
  mod.default({ on: (event: string, handler: any) => { handlers[event] = handler; } } as any);
}

function startAgent() {
  handlers["before_agent_start"](null, { ui, hasUI: true });
}

beforeEach(async () => {
  ui = { notify: vi.fn(), setWidget: vi.fn() };
  fetchCalls = [];
  nextResponse = new Response(null);
  pending = null;
  pendingResolve = null;
  mockFetch = async (input: any, init?: any) => {
    fetchCalls.push({ input, init });
    if (pending) return pending;
    return nextResponse;
  };
  globalThis.fetch = mockFetch;
  await loadExtension();
});

afterEach(async () => {
  if (handlers["session_shutdown"]) handlers["session_shutdown"]();
  vi.useRealTimers();
});

describe("fetch interception", () => {
  it("passes non-chat-completions requests through untouched", async () => {
    nextResponse = new Response("ok");
    const res = await globalThis.fetch("https://llama.local/v1/embeddings", { body: JSON.stringify({ x: 1 }) });
    expect(res).toBe(nextResponse);
    expect(fetchCalls[0].init).toEqual({ body: JSON.stringify({ x: 1 }) });
  });

  // Object-body handling of ensureStreamOptions is covered in logic.test.ts;
  // the global fetch type (BodyInit) rules out plain-object bodies, so only
  // string bodies are exercised through the real fetch path here.
  it("injects stream options into JSON string body", async () => {
    startAgent();
    await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true, model: "m" }) });
    const b = JSON.parse(fetchCalls[0].init.body as string);
    expect(b.stream_options).toEqual({ include_usage: true });
    expect(b.return_progress).toBe(true);
    expect(b.timings_per_token).toBe(true);
    expect(b.model).toBe("m");
  });

  it("wraps chat-completions response body, forwarding bytes unchanged", async () => {
    startAgent();
    const chunks = [
      'data: {"prompt_progress":{"total":100,"processed":10}}\n',
      "data: [DONE]\n",
    ];
    nextResponse = new Response(sseStream(chunks));
    const res = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    expect(await readAll(res.body!)).toBe(chunks.join(""));
    expect(anyWidgetLine()).toContain("Prefilling...");
  });

  it("renders widget line plus one trailing empty line", async () => {
    startAgent();
    nextResponse = new Response(sseStream([
      'data: {"prompt_progress":{"total":100,"processed":10}}\n',
    ]));
    const res = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    const reader = res.body!.getReader();
    await reader.read(); // no [DONE]: widget stays configured
    const call = ui.setWidget.mock.calls.at(-1)!;
    const lines = (call[1] as any)({}, {}).render(80);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Prefilling...");
    expect(lines[1].trim()).toBe("");
  });

  it("does not wrap response when no UI attached", async () => {
    nextResponse = new Response(sseStream(["data: [DONE]\n"]));
    const res = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    expect(res).toBe(nextResponse);
  });

  it("binds UI on session_start (compact before any agent turn)", async () => {
    // Resumed session: no before_agent_start has fired yet
    handlers["session_start"]({ type: "session_start", reason: "startup" }, { ui, hasUI: true });
    nextResponse = new Response(sseStream([
      'data: {"prompt_progress":{"total":100,"processed":10}}\n',
      "data: [DONE]\n",
    ]));
    const res = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    await readAll(res.body!);
    expect(anyWidgetLine()).toContain("Prefilling...");
  });

  it("session_before_compact binds UI and shows 'Compacting...' immediately", async () => {
    handlers["session_before_compact"]({}, { ui, hasUI: true });
    expect(lastWidgetLine()).toContain("Compacting...");
  });
});

describe("waiting message", () => {
  it("shows 'Waiting for response...' in widget while fetch is pending, stops after", async () => {
    vi.useFakeTimers();
    startAgent();
    pending = new Promise<Response>((res) => { pendingResolve = res; });
    const p = globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    // first tick fires immediately, no timer advance needed
    expect(lastWidgetLine()).toContain("Waiting for response... (0s)");
    vi.advanceTimersByTime(600);
    expect(lastWidgetLine()).toContain("Waiting for response... (0s)");
    pendingResolve!(new Response(null));
    await p;
    const calls = ui.setWidget.mock.calls.length;
    vi.advanceTimersByTime(3000);
    // interval must be cleared once response arrives
    expect(ui.setWidget.mock.calls.length).toBe(calls);
  });

  it("survives session_shutdown while fetch is pending (no timer crash)", async () => {
    vi.useFakeTimers();
    startAgent();
    pending = new Promise<Response>((res) => { pendingResolve = res; });
    const p = globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    handlers["session_shutdown"]();
    // the 500ms interval may still fire after shutdown; it must not throw
    // on the nulled uiRef
    expect(() => vi.advanceTimersByTime(1500)).not.toThrow();
    pendingResolve!(new Response(null));
    await p;
  });

  it("keeps counting while server prefills (headers sent, no SSE yet), stops at first event", async () => {
    vi.useFakeTimers();
    startAgent();
    const encoder = new TextEncoder();
    let push: (chunk: string) => void = () => {};
    const src = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      },
    });
    // TabbyAPI sends headers immediately while prefill runs: the ticker
    // must keep counting instead of freezing at header arrival.
    pending = Promise.resolve(new Response(src));
    const res = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    vi.advanceTimersByTime(1500);
    expect(lastWidgetLine()).toContain("Waiting for response... (1s)");
    push('data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n');
    const reader = res.body!.getReader();
    await reader.read();
    const calls = ui.setWidget.mock.calls.length;
    vi.advanceTimersByTime(3000);
    // interval must be cleared once the first SSE event arrives
    expect(ui.setWidget.mock.calls.length).toBe(calls);
  });
});

describe("TabbyAPI-style streams (no prompt_progress / timings events)", () => {
  it("shows 'Generating...' during generation and toasts TPS from final usage", async () => {
    startAgent();
    nextResponse = new Response(sseStream([
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\r\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":25,"prompt_time":0.14,"prompt_tokens_per_sec":178.57,"completion_tokens":10,"completion_time":1.2,"completion_tokens_per_sec":8.3,"total_tokens":35,"total_time":1.34}}\r\n',
      "data: [DONE]\n",
    ]));
    const res = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    await readAll(res.body!);
    expect(anyWidgetLine()).toContain("Generating...");

    handlers["turn_end"](null, { ui, hasUI: true });
    handlers["agent_end"](null, { ui, hasUI: true });
    expect(ui.notify).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledWith(
      "Prefill: 178.6 tok/s (140ms) | Generation: 8.3 tok/s (1.2s)",
    );
  });

  it("standard OpenAI usage (no stats) yields no toast", async () => {
    startAgent();
    nextResponse = new Response(sseStream([
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\r\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\r\n',
      "data: [DONE]\n",
    ]));
    const res = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    await readAll(res.body!);

    handlers["turn_end"](null, { ui, hasUI: true });
    handlers["agent_end"](null, { ui, hasUI: true });
    expect(ui.notify).not.toHaveBeenCalled();
  });
});

describe("run-end toast", () => {
  it("notifies aggregate TPS once per agent run (not per tool step)", async () => {
    startAgent();
    // Step 1: tool-calling response
    nextResponse = new Response(sseStream([
      'data: {"timings":{"predicted_n":100,"predicted_ms":1000,"prompt_n":50,"prompt_ms":500}}\n',
      "data: [DONE]\n",
    ]));
    const res1 = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    await readAll(res1.body!);
    handlers["turn_end"](null, { ui, hasUI: true });
    expect(ui.notify).not.toHaveBeenCalled(); // no per-step toast

    // Step 2: final response
    nextResponse = new Response(sseStream([
      'data: {"timings":{"predicted_n":50,"predicted_ms":1000,"prompt_n":100,"prompt_ms":500}}\n',
      "data: [DONE]\n",
    ]));
    const res2 = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    await readAll(res2.body!);
    handlers["turn_end"](null, { ui, hasUI: true });
    expect(ui.notify).not.toHaveBeenCalled();

    handlers["agent_end"](null, { ui, hasUI: true });
    expect(ui.notify).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledWith("Prefill: 150.0 tok/s (1s) | Generation: 75.0 tok/s (2s)");

    // Next run: fresh totals, no stale toast
    handlers["agent_start"](null, { ui, hasUI: true });
    handlers["agent_end"](null, { ui, hasUI: true });
    expect(ui.notify).toHaveBeenCalledTimes(1);
  });

  it("no toast when generation below elapsed threshold", async () => {
    startAgent();
    nextResponse = new Response(sseStream([
      'data: {"timings":{"predicted_n":2,"predicted_ms":10}}\n',
      "data: [DONE]\n",
    ]));
    const res = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    await readAll(res.body!);

    handlers["turn_end"](null, { ui, hasUI: true });
    handlers["agent_end"](null, { ui, hasUI: true });
    expect(ui.notify).not.toHaveBeenCalled();
  });
});

describe("error and edge paths", () => {
  it("rethrows fetch rejection and stops the waiting message", async () => {
    vi.useFakeTimers();
    startAgent();
    let rejectFn: (e: Error) => void;
    pending = new Promise<Response>((_, rej) => { rejectFn = rej; });
    const p = globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    vi.advanceTimersByTime(600);
    expect(lastWidgetLine()).toContain("Waiting for response... (0s)");
    rejectFn!(new Error("boom"));
    await expect(p).rejects.toThrow("boom");
    const calls = ui.setWidget.mock.calls.length;
    vi.advanceTimersByTime(3000);
    expect(ui.setWidget.mock.calls.length).toBe(calls);
  });

  it("does not wrap non-OK responses", async () => {
    startAgent();
    nextResponse = new Response(null, { status: 500 });
    const res = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    expect(res).toBe(nextResponse);
  });
});

describe("widget lifecycle", () => {
  it("throttles updates, then clears when prefill reaches 100%", async () => {
    vi.useFakeTimers();
    startAgent();
    const encoder = new TextEncoder();
    let push: (chunk: string) => void = () => {};
    const src = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      },
    });
    nextResponse = new Response(src);
    const res = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    const reader = res.body!.getReader();

    push('data: {"prompt_progress":{"total":10,"processed":5}}\n');
    await reader.read();
    expect(lastWidgetLine()).toContain("Prefilling...");

    // Same tick as the last update: throttled, no new call
    const calls = ui.setWidget.mock.calls.length;
    push('data: {"prompt_progress":{"total":10,"processed":7}}\n');
    await reader.read();
    expect(ui.setWidget.mock.calls.length).toBe(calls);

    // After the throttle window: 100% prefill clears the widget
    vi.advanceTimersByTime(300);
    push('data: {"prompt_progress":{"total":10,"processed":10}}\n');
    await reader.read();
    expect(ui.setWidget).toHaveBeenLastCalledWith("pi-llama-progress", undefined);
  });

  it("clears widget at stream end", async () => {
    startAgent();
    nextResponse = new Response(sseStream([
      'data: {"prompt_progress":{"total":100,"processed":10}}\n',
      "data: [DONE]\n",
    ]));
    const res = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    await readAll(res.body!);
    expect(ui.setWidget).toHaveBeenLastCalledWith("pi-llama-progress", undefined);
  });

  it("new request resets stale state from an aborted previous request", async () => {
    startAgent();
    // Request A streams progress, then is aborted (no [DONE])
    nextResponse = new Response(sseStream([
      'data: {"prompt_progress":{"total":100,"processed":10}}\n',
    ]));
    const a = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    const ra = a.body!.getReader();
    await ra.read();
    expect(lastWidgetLine()).toContain(" 10%");

    // Request B starts: its reset must discard A's state, and B's own
    // progress must show
    pending = Promise.resolve(new Response(sseStream([
      'data: {"prompt_progress":{"total":100,"processed":50}}\n',
      "data: [DONE]\n",
    ])));
    const b = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    await readAll(b.body!);
    expect(anyWidgetLine()).toContain(" 50%");
  });

  it("clears stale widget on agent_start (aborted request)", async () => {
    startAgent();
    nextResponse = new Response(sseStream([
      'data: {"prompt_progress":{"total":100,"processed":10}}\n',
    ]));
    const res = await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    const reader = res.body!.getReader();
    await reader.read(); // no [DONE]: stream aborted by pi
    expect(lastWidgetLine()).toContain("Prefilling...");
    handlers["agent_start"](null, { ui, hasUI: true });
    expect(ui.setWidget).toHaveBeenLastCalledWith("pi-llama-progress", undefined);
  });

  it("clears waiting ticker on agent_settled (aborted before first SSE event)", async () => {
    vi.useFakeTimers();
    startAgent();
    // Stream that never emits an event: pi aborts it while waiting
    nextResponse = new Response(new ReadableStream<Uint8Array>({ start() {} }));
    await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    expect(lastWidgetLine()).toContain("Waiting for response...");
    handlers["agent_settled"](null, { ui, hasUI: true, isIdle: () => true });
    expect(ui.setWidget).toHaveBeenLastCalledWith("pi-llama-progress", undefined);
    // Ticker stopped: advancing time no longer updates the widget
    const calls = ui.setWidget.mock.calls.length;
    vi.advanceTimersByTime(2000);
    expect(ui.setWidget.mock.calls.length).toBe(calls);
  });

  it("keeps widget on agent_settled while another run is active", async () => {
    vi.useFakeTimers();
    startAgent();
    nextResponse = new Response(new ReadableStream<Uint8Array>({ start() {} }));
    await globalThis.fetch(CHAT_URL, { body: JSON.stringify({ stream: true }) });
    handlers["agent_settled"](null, { ui, hasUI: true, isIdle: () => false });
    expect(lastWidgetLine()).toContain("Waiting for response...");
  });
});

describe("session_shutdown", () => {
  it("restores original fetch", async () => {
    startAgent();
    expect(globalThis.fetch).not.toBe(mockFetch);
    handlers["session_shutdown"]();
    expect(globalThis.fetch).toBe(mockFetch);
  });

  it("clears widget", async () => {
    startAgent();
    handlers["session_shutdown"]();
    expect(ui.setWidget).toHaveBeenLastCalledWith("pi-llama-progress", undefined);
  });

  it("does not clobber a wrapper installed on top of ours", () => {
    startAgent();
    const outer = (async (input: any, init?: any) => mockFetch(input, init)) as typeof fetch;
    globalThis.fetch = outer; // another extension wraps us after we load
    handlers["session_shutdown"]();
    expect(globalThis.fetch).toBe(outer);
  });
});
