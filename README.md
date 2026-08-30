# pi-llama-progress

Progress bar + TPS overlay for [pi](https://pi.dev) with [llama.cpp](https://llama.app/).

Works with any llama.cpp model configured in pi's built-in llama.cpp provider (`/login llama.cpp`, see the [llama.cpp docs](https://pi.dev)). This plugin adds visual feedback on top — no model discovery or provider registration. It intercepts the chat/completions request the provider sends through pi.

## Features

- **Progress widget** — live line above the editor during every request (including compaction): `Prefilling... ██████░░░░░░░░░░░░░░ 30% · 2s · 45.2 tok/s`, then `24.5 tok/s (42 tokens)` during generation. Cleared at stream end (or on next agent start if aborted). Rendered with one trailing empty line for visual separation.
- **End-of-turn stats** — `Prefill: 120.3 tok/s (800ms) | Generation: 24.5 tok/s (1.2s)`
- **Wait timer** — `Waiting for response... (3s)` in the widget while the server processes the prompt

## Install

```bash
pi install npm:pi-llama-progress
```

Or from git / a local checkout:

```bash
pi install git:github.com/markun/pi-llama-progress
pi install ./pi-llama-progress
```

## Development

```bash
npm install
npm run check   # typecheck + tests
```

Pure logic lives in `src/logic.ts`, pi wiring in `src/index.ts`.

## Inspired by

- [pi-llama-cpp](https://www.npmjs.com/package/pi-llama-cpp) — progress reporting
- [pi-llama-cpp-stats](https://www.npmjs.com/package/pi-llama-cpp-stats) — prefill progress bar implementation
