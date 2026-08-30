import { describe, it, expect, vi } from "vitest";
import { captureStream, parseSseLine, type SseEvent } from "./logic.js";

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
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

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
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

describe("captureStream", () => {
  it("passes original bytes through unchanged and emits events", async () => {
    const src = makeStream([
      'data: {"prompt_progress":{"total":100,"processed":10}}\n',
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
      "data: [DONE]\n",
    ]);
    const events: SseEvent[] = [];
    const out = await collect(captureStream(src, (ev) => events.push(ev)));

    // Output must be byte-identical to the input (no re-encoding, no
    // duplication, no dropped lines)
    expect(out).toBe(
      'data: {"prompt_progress":{"total":100,"processed":10}}\n' +
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n' +
        "data: [DONE]\n",
    );
    expect(events.map((e) => e.kind)).toEqual([
      "prompt_progress",
      "content",
      "done",
    ]);
  });

  it("handles split lines across chunks", async () => {
    const src = makeStream([
      'data: {"prompt_prog',
      'ress":{"total":10,"processed":5}}\n',
      "data: [DONE]\n",
    ]);
    const events: SseEvent[] = [];
    await collect(captureStream(src, (ev) => events.push(ev)));
    expect(events[0].kind).toBe("prompt_progress");
    expect(events[1].kind).toBe("done");
  });

  it("ignores non-data lines for events but forwards bytes", async () => {
    const src = makeStream([
      ": keep-alive\n",
      'data: {"usage":{}}\n',
    ]);
    const events: SseEvent[] = [];
    const out = await collect(captureStream(src, (ev) => events.push(ev)));
    expect(events.map((e) => e.kind)).toEqual(["usage"]);
    // Stream must be forwarded unchanged to preserve SSE framing
    expect(out).toContain(": keep-alive");
    expect(out).toContain('data: {"usage":{}}\n');
  });

  it("propagates upstream errors to the consumer", async () => {
    const encoder = new TextEncoder();
    const src = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: [DONE]\n"));
        controller.error(new Error("upstream boom"));
      },
    });
    const out = captureStream(src, () => {});
    await expect(collect(out)).rejects.toThrow("upstream boom");
  });

  it("cancels the upstream stream when the consumer cancels", async () => {
    const cancel = vi.fn();
    const src = new ReadableStream<Uint8Array>({
      pull() { /* stays open forever */ },
      cancel,
    });
    const out = captureStream(src, () => {});
    await out.cancel();
    expect(cancel).toHaveBeenCalled();
  });

  it("parseSseLine still exported + consistent", () => {
    expect(parseSseLine("[DONE]")).toEqual({ kind: "done" });
  });
});
