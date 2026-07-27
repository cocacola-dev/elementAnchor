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
      (lastResult.css || "/* No styles */") +
      "\n</style>\n</head>\n<body>\n" +
      lastResult.html +
      (lastResult.js ? "\n<script>\n" + lastResult.js + "\n<\/script>" : "") +
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
