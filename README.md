# ⚓ Element Anchor

A Chrome DevTools extension that anchors into any element, pulls its **HTML**, **CSS** (including pseudo-elements and matched rules) and **JavaScript** back out — iframes included — and renders a **live preview** of the result.

Select an element in the **Elements** panel and Element Anchor captures a clean, self-contained snapshot you can preview, copy, or export as a standalone `.html` file.

## Features

- **One-click capture** of the selected element — auto-captures as you move through the Elements tree.
- **Live preview** — renders the capture in a sandboxed iframe, so you see a faithful replica instead of just code. Switchable backdrop (checker / light / dark) so light-on-light and dark-on-dark elements stay visible.
- **Faithful styles** — folds in the inherited CSS variables, `@font-face`, and `@keyframes` the element actually uses, so fonts, design tokens, and animations render correctly and the copied CSS is self-contained.
- **Animation controls** — **Replay** and **Loop** CSS keyframe animations right in the preview.
- **Computed styles by default** — captures resolved values (filtered against per-tag user-agent defaults to cut noise), which also works on sites whose CSS is cross-origin. Toggle it off for authored matched rules, with a one-click hint when cross-origin stylesheets block that mode.
- **Scoped CSS** — generated selectors are relative to the captured element (including `::before` / `::after` / `::marker`), so the snapshot renders standalone.
- **Iframe traversal** — reaches into same-origin iframes and captures their matched styles and scripts too.
- **Optional `Run JS`** in the preview, plus a heads-up before clicking links that would navigate the sandbox.
- **Pin** to freeze the current capture so navigating the DOM doesn't overwrite it.
- **Copy** each section individually, **Copy All**, or **Export** a ready-to-open `.html` file.
- Auto-matches your **DevTools light/dark theme**.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.

## Usage

![Using Element Anchor](docs/usage29jul.jpg)

1. Open **DevTools** (`F12` or `Ctrl+Shift+I`) on any page.
2. Go to the **Elements** tab and click the element you want to capture.
3. Open the **Element Anchor** pane on the right (click the `»` overflow arrow if it's hidden).
4. It captures automatically — a **live preview** renders at the top, with the **HTML**, **CSS** and **JavaScript** below in collapsible sections (collapsed by default).
5. Use the **◐ / ○ / ●** button to switch the preview backdrop, **Replay** / **Loop** any animation, and toggle **Run JS** if you need scripts to execute.
6. Use **Copy** on any section, **Copy All**, or **Export .html** to save a standalone file. Hit **📌 Pin** to freeze the current capture while you keep browsing the DOM.

> **Tip:** *Computed only* is on by default and works everywhere, including sites whose stylesheets are cross-origin. Turn it off to capture the original authored rules instead — if that leaves styles missing because a stylesheet is cross-origin, the panel offers a one-click switch back.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Extension manifest (MV3) |
| `devtools.html` / `devtools.js` | Registers the DevTools sidebar pane |
| `panel.html` / `panel.js` | The panel UI and its logic |
| `extractor.js` | Injected into the page to extract HTML/CSS/JS |
| `icons/` | Extension icons |

## License

[MIT](LICENSE) © 2026 cocacola-dev — free to use, modify, and distribute for personal **and** commercial projects.

> Note: the source code is MIT. The anchor icon is Twemoji, licensed separately under CC-BY 4.0 (see Credits below).

## Credits

The anchor icon is adapted (resized) from **Twemoji**:

- Graphic: `2693.svg` (⚓ anchor)
- Author: Copyright 2020 Twitter, Inc. and other contributors — https://github.com/twitter/twemoji
- License: [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)
