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
  formatTps,
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
        const secs = Math.floor((Date.now() - waitStart) / 1000);
        uiRef.setWidget(WIDGET_KEY, widgetFactory(`Waiting for response... (${secs}s)`));
      };
      tick(); // first tick immediate, no half-second blind spot
      const waitInterval = setInterval(tick, 500);
      try {
        const response = await originalFetch!(input, init);
        clearInterval(waitInterval);
        if (response.ok && response.body) {
          return new Response(captureStream(response.body, (ev) => {
            if (applyEvent(state, ev)) updateUi();
          }), {
            status: response.status,
            statusText: response.statusText,
            headers: new Headers(response.headers),
          });
        }
        return response;
      } catch (err) {
        clearInterval(waitInterval);
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

  pi.on("turn_end", (_event: any, ctx: ExtensionContext) => {
    if (ctx.hasUI) {
      const timings = state.latestTimings;
      const display = timings ? formatTps(timings) : null;
      // Toast only, no footer duplication, no prefix.
      if (display) ctx.ui.notify(display);
    }
    resetForNextTurn(state);
  });

  // Safety clear: an aborted request never sends [DONE], so the widget
  // could linger past an abort.
  pi.on("agent_start", () => {
    clearWidget();
  });

  pi.on("session_shutdown", () => {
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
