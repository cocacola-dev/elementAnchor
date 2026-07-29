(function () {
  const btnCapture = document.getElementById("btn-capture");
  const btnPin = document.getElementById("btn-pin");
  const btnCopyAll = document.getElementById("btn-copy-all");
  const btnExport = document.getElementById("btn-export");
  const statusEl = document.getElementById("status");
  const elementInfo = document.getElementById("element-info");

  // Match the panel to the user's DevTools theme (dark is the CSS default).
  try {
    if (chrome.devtools.panels.themeName !== "dark") {
      document.body.classList.add("theme-light");
    }
  } catch (_) {}

  const previewFrame = document.getElementById("preview-frame");
  const previewStage = document.getElementById("preview-stage");
  const previewEmpty = document.getElementById("preview-empty");
  const optRunJS = document.getElementById("opt-runjs");
  const btnBg = document.getElementById("btn-bg");
  const animControls = document.getElementById("anim-controls");
  const btnReplay = document.getElementById("btn-replay");
  const optLoop = document.getElementById("opt-loop");
  const previewNote = document.getElementById("preview-note");
  const xoriginHint = document.getElementById("xorigin-hint");
  const btnEnableComputed = document.getElementById("btn-enable-computed");
  const optComputed = document.getElementById("opt-computed");

  const htmlCode = document.getElementById("html-code");
  const cssCode = document.getElementById("css-code");
  const jsCode = document.getElementById("js-code");
  const htmlSize = document.getElementById("html-size");
  const cssSize = document.getElementById("css-size");
  const jsSize = document.getElementById("js-size");

  let lastResult = null;
  let extractorSource = "";
  let captureSeq = 0;
  let selectionTimer = null;
  let pinned = false;

  // kind: true | "success" | "error" | "info" (default). `true` kept for back-compat.
  function setStatus(msg, kind) {
    if (kind === true) kind = "success";
    else if (!kind) kind = "info";
    statusEl.textContent = msg;
    statusEl.className = "status" + (kind !== "info" ? " " + kind : "");
    if (kind === "success") {
      setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ""; }, 3000);
    }
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    return (bytes / 1024).toFixed(1) + " KB";
  }

  function byteLength(str) {
    return new TextEncoder().encode(str).length;
  }

  function indentHTML(html) {
    // Whitespace-sensitive elements can't be safely re-indented — reformatting
    // would corrupt their rendered content, so leave the HTML untouched.
    if (/<(pre|textarea)[\s>]/i.test(html)) return html;
    let result = "";
    let indent = 0;
    const tokens = html.replace(/>\s*</g, ">\n<").split("\n");
    for (const token of tokens) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("</")) indent = Math.max(0, indent - 1);
      result += "  ".repeat(indent) + trimmed + "\n";
      if (
        trimmed.startsWith("<") &&
        !trimmed.startsWith("</") &&
        !trimmed.endsWith("/>") &&
        !trimmed.match(/^<(img|br|hr|input|meta|link|source|area|base|col|embed|track|wbr)\b/i)
      ) {
        indent++;
      }
    }
    return result.trim();
  }

  function evalInFrame(code, frameURL) {
    return new Promise((resolve) => {
      const opts = frameURL ? { frameURL: frameURL } : {};
      chrome.devtools.inspectedWindow.eval(code, opts, (result, exception) => {
        resolve({ result, exception });
      });
    });
  }

  function getAllFrameURLs() {
    return new Promise((resolve) => {
      const tabId = chrome.devtools.inspectedWindow.tabId;
      chrome.webNavigation.getAllFrames({ tabId: tabId }, (frames) => {
        if (chrome.runtime.lastError || !frames) {
          resolve([]);
          return;
        }
        const urls = frames
          .filter((f) => f.url && f.url !== "about:blank" && !f.url.startsWith("chrome"))
          .map((f) => f.url);
        resolve(urls);
      });
    });
  }

  async function findFrameWithSelection() {
    const probe = "!!$0";

    const topResult = await evalInFrame(probe, null);
    if (!topResult.exception && topResult.result === true) {
      return null;
    }

    const frameURLs = await getAllFrameURLs();

    for (const url of frameURLs) {
      try {
        const res = await evalInFrame(probe, url);
        if (!res.exception && res.result === true) {
          return url;
        }
      } catch (_) {}
    }

    return null;
  }

  function escapeAttr(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  // Stop captured CSS/JS from prematurely closing the <style>/<script> wrapper.
  // The HTML parser ends a raw-text element only on a literal "</style" /
  // "</script"; splitting that sequence keeps the content inside. The stray
  // backslash is inert in both CSS and — where it only ever appears inside a
  // string like `"</script>"` — JS.
  function guardRawText(str) {
    return String(str).replace(/<\/(style|script)/gi, "<\\/$1");
  }

  // Render the captured element into the sandboxed preview iframe. The iframe
  // is a unique opaque origin: with no `allow-scripts` token nothing executes,
  // so the static HTML+CSS replica can't touch the page or the panel. Toggling
  // "Run JS" adds `allow-scripts` and injects the captured scripts/handlers.
  function renderPreview(result) {
    if (!result) {
      previewFrame.removeAttribute("srcdoc");
      previewFrame.style.display = "none";
      previewEmpty.style.display = "";
      return;
    }
    previewEmpty.style.display = "none";
    previewFrame.style.display = "";
    const runJS = optRunJS.checked;
    // Force every finite animation to repeat. Injected after the captured CSS
    // so !important wins regardless of what the element declares.
    const loopCSS = optLoop.checked
      ? "\n*,*::before,*::after{animation-iteration-count:infinite!important;}"
      : "";
    const base = result.baseURI
      ? '<base href="' + escapeAttr(result.baseURI) + '">'
      : "";
    const doc =
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" + base +
      "<style>html,body{margin:0;padding:0;}\n" + guardRawText(result.css || "") + loopCSS + "</style>" +
      "</head><body>" +
      result.html +
      (runJS && result.js ? "<script>\n" + guardRawText(result.js) + "\n<\/script>" : "") +
      "</body></html>";
    // Set sandbox before srcdoc so the new document loads under the right policy.
    previewFrame.setAttribute("sandbox", runJS ? "allow-scripts" : "");
    previewFrame.srcdoc = doc;
  }

  function displayResult(result) {
    lastResult = result;
    elementInfo.textContent = result.info + (result.frameURL ? "  [iframe]" : "");
    elementInfo.classList.remove("flash");
    void elementInfo.offsetWidth; // restart the flash animation
    elementInfo.classList.add("flash");

    const formattedHTML = indentHTML(result.html);
    htmlCode.textContent = formattedHTML;
    htmlSize.textContent = formatBytes(byteLength(result.html));

    cssCode.textContent = result.css || "No styles captured";
    cssSize.textContent = formatBytes(byteLength(result.css || ""));

    jsCode.textContent = result.js || "No scripts found";
    jsSize.textContent = formatBytes(byteLength(result.js || ""));

    // Only surface Replay/Loop when the capture actually has a keyframe
    // animation — the extractor only emits @keyframes when one is in use.
    const hasAnimation = /@keyframes/i.test(result.css || "");
    animControls.style.display = hasAnimation ? "inline-flex" : "none";

    // Warn about links only when the capture contains an anchor — clicking one
    // in the sandbox navigates the frame and can trigger a redirect.
    previewNote.style.display = /<a[\s>]/i.test(result.html || "") ? "flex" : "none";

    // Nudge toward Computed only when matched-rule mode hit unreadable
    // cross-origin stylesheets — that's the silent dead end on CDN-styled sites.
    const crossOrigin = !optComputed.checked && result.blockedSheets > 0;
    xoriginHint.style.display = crossOrigin ? "flex" : "none";

    renderPreview(result);

    setStatus("Captured successfully" + (result.frameURL ? " (from iframe)" : ""), true);
  }

  async function capture() {
    if (!extractorSource) {
      setStatus("Extractor not loaded yet — try again.", "error");
      return;
    }

    const options = {
      children: document.getElementById("opt-children").checked,
      pseudo: document.getElementById("opt-pseudo").checked,
      iframes: document.getElementById("opt-iframes").checked,
      computedOnly: document.getElementById("opt-computed").checked,
    };

    const seq = ++captureSeq;
    setStatus("Capturing...", false);
    xoriginHint.style.display = "none"; // clear any stale hint before re-checking

    const frameURL = await findFrameWithSelection();
    if (seq !== captureSeq) return; // a newer capture superseded this one

    const code = extractorSource + "\nextractElement(" + JSON.stringify(options) + ");";
    const { result, exception } = await evalInFrame(code, frameURL);
    if (seq !== captureSeq) return; // a newer capture superseded this one

    if (exception) {
      setStatus(
        "Error: " + (exception.value || exception.description || JSON.stringify(exception)),
        "error"
      );
      return;
    }
    if (!result) {
      setStatus("No result — select an element in the Elements panel first.", "error");
      return;
    }
    if (result.error) {
      setStatus(result.error, "error");
      return;
    }

    result.frameURL = frameURL;
    displayResult(result);
  }

  // Load the extractor source
  fetch(chrome.runtime.getURL("extractor.js"))
    .then((r) => r.text())
    .then((src) => {
      extractorSource = src;
      setStatus("Ready — select an element and click Capture", false);
    })
    .catch((err) => {
      setStatus("Failed to load extractor: " + err.message, "error");
    });

  btnCapture.addEventListener("click", capture);

  // Re-render the existing capture when JS execution is toggled — no re-capture
  // needed since we already hold the HTML/CSS/JS.
  optRunJS.addEventListener("change", () => renderPreview(lastResult));

  // The cross-origin hint's action: switch to Computed only and re-capture,
  // which reads styles via getComputedStyle and sidesteps the restriction.
  btnEnableComputed.addEventListener("click", () => {
    optComputed.checked = true;
    xoriginHint.style.display = "none";
    capture();
  });

  // Replay re-renders the iframe from scratch — a fresh document restarts every
  // load-driven CSS animation, which is the only way to retrigger them without
  // reaching into the sandboxed frame's DOM.
  btnReplay.addEventListener("click", () => renderPreview(lastResult));

  // Toggling Loop re-renders so the infinite-iteration override is applied (or
  // removed) and the animation restarts under the new setting.
  optLoop.addEventListener("change", () => renderPreview(lastResult));

  // Cycle the preview backdrop so light-on-light / dark-on-dark elements stay
  // visible. Pure CSS via data-bg — no re-render needed. The glyph fills to
  // match the current backdrop (half / hollow / solid) as a live indicator.
  const BG_MODES = ["checker", "light", "dark"];
  const BG_GLYPH = { checker: "◐", light: "○", dark: "●" };
  btnBg.addEventListener("click", () => {
    const next = BG_MODES[(BG_MODES.indexOf(previewStage.dataset.bg) + 1) % BG_MODES.length];
    previewStage.dataset.bg = next;
    btnBg.textContent = BG_GLYPH[next];
    btnBg.title = "Preview background: " + next;
  });

  // Pin freezes the current capture so navigating the Elements tree doesn't
  // overwrite what you're looking at. The Capture button still forces a refresh.
  btnPin.addEventListener("click", () => {
    pinned = !pinned;
    btnPin.classList.toggle("active", pinned);
    btnPin.innerHTML = pinned ? "\u{1F4CC} Pinned" : "\u{1F4CC} Pin";
    setStatus(pinned ? "Pinned — auto-capture paused" : "Auto-capture resumed", pinned ? "info" : true);
  });

  // Auto-capture when the selected element changes in the Elements panel.
  // Debounced so clicking rapidly through the Elements tree doesn't fire a
  // burst of overlapping captures.
  function scheduleCapture() {
    if (pinned) return;
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(capture, 150);
  }
  chrome.devtools.panels.elements.onSelectionChanged.addListener(scheduleCapture);

  // Collapsible sections
  document.querySelectorAll(".section-header[data-target]").forEach((header) => {
    header.addEventListener("click", (e) => {
      if (e.target.closest(".section-actions")) return;
      const body = document.getElementById(header.dataset.target);
      body.classList.toggle("collapsed");
    });
  });

  // Per-section copy buttons
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const body = document.getElementById(btn.dataset.copy);
      const pre = body.querySelector("pre");
      if (pre && pre.textContent) {
        navigator.clipboard.writeText(pre.textContent).then(() => {
          const original = btn.textContent;
          btn.textContent = "Copied!";
          setTimeout(() => { btn.textContent = original; }, 1500);
        });
      }
    });
  });

  // Copy all sections
  btnCopyAll.addEventListener("click", () => {
    if (!lastResult) {
      setStatus("Nothing captured yet", false);
      return;
    }
    const all =
      "<!-- HTML -->\n" + lastResult.html +
      "\n\n/* CSS */\n" + (lastResult.css || "") +
      "\n\n// JavaScript\n" + (lastResult.js || "");
    navigator.clipboard.writeText(all).then(() => {
      setStatus("All sections copied to clipboard", true);
    });
  });

  // Export as standalone .html file
  btnExport.addEventListener("click", () => {
    if (!lastResult) {
      setStatus("Nothing captured yet", false);
      return;
    }
    const doc = "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Exported Element</title>\n<style>\n" +
      guardRawText(lastResult.css || "/* No styles */") +
      "\n</style>\n</head>\n<body>\n" +
      lastResult.html +
      (lastResult.js ? "\n<script>\n" + guardRawText(lastResult.js) + "\n<\/script>" : "") +
      "\n</body>\n</html>";

    const blob = new Blob([doc], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "exported-element.html";
    a.click();
    URL.revokeObjectURL(url);
    setStatus("Exported as exported-element.html", true);
  });
})();
