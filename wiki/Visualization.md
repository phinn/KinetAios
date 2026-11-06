> 🌐 Language: **English** | [中文](Visualization.zh-CN.md)

# In-Answer Visualization Cards (viz-card)

> Available since v4.0.7. When an answer contains a **self-contained HTML document** — an architectural diagram, comparison matrix, dashboard mock, timeline — it is rendered as an **interactive card inline in the answer**, instead of a wall of escaped code.

## What triggers a card

The renderer recognizes a fenced code block whose language tag is `html` **and** whose content is a card-shaped document (has a top-level structural tag such as `<div>`/`<table>`/`<svg>` and is long enough). Regular short `html` snippets still render as normal code blocks.

## How it works

- The raw HTML is stored (HTML-escaped) in a collapsible `<details>` block under the card, and loaded into a `blob:` URL iframe.
- The iframe is sandboxed with **`allow-scripts` only** — deliberately **without** `allow-same-origin`, because a `blob:` document shares the host origin: combining the two flags cancels the sandbox and would let the inner script reach `parent.document` (and from there `window.kinet` → shell). The inner document's own `<script>` runs — that's the point (charts/interactivity), the sandbox is the only gate, so treat generated HTML as untrusted-but-scriptable content.
- **Auto height**: the host injects a boot script that measures the inner `document.body` height and reports it via `postMessage({type:'viz-height', id, h, w})`. The host matches the sender by a unique `data-viz-id` seeded at mount time (cross-origin `ev.source` is not comparable), clamps to **80–720px**, and writes the height back. `body.offsetHeight` is used — `documentElement.scrollHeight` would report the viewport height and create a feedback loop.
- **Content width**: when the inner-reported content width falls below 78% of the (constant) parent width, the card shrinks to content width; it grows back above 92% (hysteresis band). The measurement base is the **parent container**, never the card itself — measuring the card you are rewriting causes oscillation.
- **Title**: the first inner `<h1>–<h3>` is promoted to the card header (60-char cap); otherwise the i18n default title is kept.
- **Actions**: download HTML (`.html` blob), **download as PNG** — implemented as an offscreen `BrowserWindow` that loads the same HTML and `capturePage()`s it (SVG-foreignObject was tried and **does not work** for full HTML documents) — copy source, and toggle source view. Links inside the card are forwarded via `open-external` IPC, which only allows `http:`/`https:`.

## Escape hatches

- The `<details>` block keeps the full escaped source readable even if the blob fails to load.
- If an inner document misbehaves, only that iframe is affected: the sandbox blocks same-origin access, top navigation, and forms; downloads/links go through host-mediated handlers.

## Verification

E2E (Electron, headless): single-card height convergence (262px, 4 consistent reports, no feedback loop); dual-card id routing (heights `[84,332]`, 8 reports each to its own frame); narrow-card oscillation fix (20 samples, zero flips); PNG export via real IPC chain → offscreen window → capturePage → file on disk (9 KB PNG).
