/**
 * pi-llama-progress
 *
 * Overlay on pi's built-in llama.cpp provider adding:
 * - Progress widget during prefill/generation (incl. compaction)
 * - End-of-turn TPS display
 *
 * Pure logic lives in ./logic.ts. This file owns fetch interception,
 * pi event wiring, and the UI reference.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
  UI_UPDATE_THROTTLE_MS,
  createProgressState,
  getWorkingMessage,
  shouldClearPrefill,
  createTurnStats,
  accumulateStep,
  formatTurnStats,
  ensureStreamOptions,
  captureStream,
  applyEvent,
  resetForNextTurn,
  type ProgressState,
} from "./logic.ts";

// ─── State ───────────────────────────────────────────────────────────────────

let originalFetch: typeof fetch | null = null;
let wrappedFetch: typeof fetch | null = null;
let uiRef: ExtensionUIContext | null = null;
let hasUIRef = false;
let waitInterval: ReturnType<typeof setInterval> | null = null;

function stopWait(): void {
  if (waitInterval) {
    clearInterval(waitInterval);
    waitInterval = null;
  }
}

// Progress renders in an extension widget (not the working message): pi
// replaces the status line with a fixed "Compacting..." indicator during
// compaction and ignores setWorkingMessage, so a widget is the only place
// that works for every request kind.
const WIDGET_KEY = "pi-llama-progress";

function clearWidget(): void {
  if (uiRef && hasUIRef) uiRef.setWidget(WIDGET_KEY, undefined);
}

// Component factory (the string[] widget path cannot express an empty line,
// pi-tui Text drops whitespace-only lines). Composed from the same
// primitives pi itself uses for string widgets: Text with paddingX=1,
// plus a trailing Spacer(1) so the line is not glued to the input box.
function widgetFactory(line: string) {
  return () => {
    const container = new Container();
    container.addChild(new Text(line, 1, 0));
    container.addChild(new Spacer(1));
    return container;
  };
}

// One shared state: pi issues chat requests sequentially (subagent children
// are separate processes with their own fetch). A new request resets it so
// an aborted request's leftover events cannot leak into the next one.
const state: ProgressState = createProgressState();

// Aggregate timings for the current agent run (one user prompt). pi fires
// turn_end per LLM response (one per tool step); the toast reports the
// whole run once, at agent_end. agent_settled is deferred while queued
// follow-up messages remain, so it is unreliable for per-run reporting.
const turnStats = createTurnStats();

// ─── UI update ───────────────────────────────────────────────────────────────

function updateUi(): void {
  if (!uiRef || !hasUIRef) return;
  const msg = getWorkingMessage(state);
  if (msg === null || shouldClearPrefill(state)) {
    uiRef.setWidget(WIDGET_KEY, undefined);
    state.lastUiUpdateMs = 0;
    return;
  }
  const now = Date.now();
  if (now - state.lastUiUpdateMs < UI_UPDATE_THROTTLE_MS) return;
  state.lastUiUpdateMs = now;
  uiRef.setWidget(WIDGET_KEY, widgetFactory(msg));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isChatCompletionsRequest(input: any): boolean {
  const url = typeof input === "string" ? input : input?.url;
  return typeof url === "string" && url.includes("/chat/completions");
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const globalState = globalThis as Record<PropertyKey, unknown>;
  if (globalState["pi-llama-progress/loaded"]) return;
  globalState["pi-llama-progress/loaded"] = true;

  originalFetch = globalThis.fetch;
  wrappedFetch = async (input: any, init?: any) => {
    if (!isChatCompletionsRequest(input)) {
      return originalFetch!(input, init);
    }
    try {
      if (init?.body !== undefined) {
        const res = ensureStreamOptions(init.body);
        if (res.handled) init.body = res.body;
      }
    } catch { /* ignore */ }

    if (uiRef && hasUIRef) {
      // Fresh request: discard any state left by an aborted previous one
      // (progress, timings, UI throttle).
      resetForNextTurn(state);
      const waitStart = Date.now();
      const tick = () => {
        // uiRef is nulled by session_shutdown; a pending fetch can still be
        // ticking at that point.
        if (!uiRef || !hasUIRef) return;
        // Real progress (llama.cpp prompt_progress) or generation has taken
        // over; don't clobber it.
        if (state.isGenerating || state.currentProgress) return;
        const secs = Math.floor((Date.now() - waitStart) / 1000);
        uiRef.setWidget(WIDGET_KEY, widgetFactory(`Waiting for response... (${secs}s)`));
      };
      tick(); // first tick immediate, no half-second blind spot
      // Stays armed until the first SSE event: servers like TabbyAPI send
      // HTTP headers immediately while prefill is still running, so
      // clearing on header arrival would freeze the counter mid-prefill.
      waitInterval = setInterval(tick, 500);
      try {
        const response = await originalFetch!(input, init);
        if (response.ok && response.body) {
          let firstEvent = true;
          return new Response(captureStream(response.body, (ev) => {
            if (firstEvent) {
              firstEvent = false;
              stopWait();
            }
            if (applyEvent(state, ev)) updateUi();
          }), {
            status: response.status,
            statusText: response.statusText,
            headers: new Headers(response.headers),
          });
        }
        stopWait();
        return response;
      } catch (err) {
        stopWait();
        throw err;
      }
    }
    return originalFetch!(input, init);
  };
  globalThis.fetch = wrappedFetch;

  const bindUi = (ctx: ExtensionContext) => {
    uiRef = ctx.ui;
    hasUIRef = ctx.hasUI;
  };

  // session_start covers resumed/loaded sessions where /compact may run
  // before any agent turn (before_agent_start would leave uiRef unset).
  pi.on("session_start", (_event: any, ctx: ExtensionContext) => bindUi(ctx));

  pi.on("before_agent_start", (_event: any, ctx: ExtensionContext) => bindUi(ctx));

  pi.on("session_before_compact", (_event: any, ctx: ExtensionContext) => {
    bindUi(ctx);
    if (uiRef && hasUIRef) uiRef.setWidget(WIDGET_KEY, widgetFactory("Compacting..."));
  });

  pi.on("turn_end", (_event: any, _ctx: ExtensionContext) => {
    // Per LLM response: fold this step's final timings into the run totals.
    // The toast fires once at agent_end.
    accumulateStep(turnStats, state.latestTimings);
    resetForNextTurn(state);
  });

  pi.on("agent_end", (_event: any, ctx: ExtensionContext) => {
    if (ctx.hasUI) {
      const display = formatTurnStats(turnStats);
      // Toast only, no footer duplication, no prefix.
      if (display) ctx.ui.notify(display);
    }
  });

  // Safety clear: an aborted request never sends [DONE], so the widget
  // could linger past an abort. Also stops a waiting ticker that never saw
  // an SSE event (aborted before the stream opened), and starts fresh run
  // totals (agent_start also precedes auto-retry/compaction runs).
  pi.on("agent_start", () => {
    stopWait();
    clearWidget();
    Object.assign(turnStats, createTurnStats());
  });

  pi.on("session_shutdown", () => {
    stopWait();
    if (uiRef && hasUIRef) uiRef.setWidget(WIDGET_KEY, undefined);
    uiRef = null;
    hasUIRef = false;
    // Restore only if our wrapper is still the active fetch: another
    // extension may have wrapped it on top of ours after we loaded.
    if (wrappedFetch && originalFetch && globalThis.fetch === wrappedFetch) {
      globalThis.fetch = originalFetch;
    }
    originalFetch = null;
    wrappedFetch = null;
    delete globalState["pi-llama-progress/loaded"];
  });
}
