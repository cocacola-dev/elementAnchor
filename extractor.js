function extractElement(options) {
  const el = $0;
  if (!el) return { error: "No element selected in the Elements panel." };

  const opts = Object.assign(
    { children: true, pseudo: true, iframes: true, computedOnly: false },
    options
  );

  const collectedCSS = [];
  const collectedJS = [];
  const processedElements = new Set();

  function selectorFor(element) {
    if (element.id) return "#" + CSS.escape(element.id);
    let path = [];
    let cur = element;
    while (cur && cur.nodeType === 1) {
      let seg = cur.localName;
      if (cur.id) {
        seg = "#" + CSS.escape(cur.id);
        path.unshift(seg);
        break;
      }
      if (cur.className && typeof cur.className === "string") {
        const classes = cur.className.trim().split(/\s+/).slice(0, 2);
        if (classes.length) seg += "." + classes.map(c => CSS.escape(c)).join(".");
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.localName === cur.localName
        );
        if (siblings.length > 1) {
          seg += ":nth-child(" + (Array.from(parent.children).indexOf(cur) + 1) + ")";
        }
      }
      path.unshift(seg);
      cur = cur.parentElement;
    }
    return path.join(" > ");
  }

  function getMatchedRules(element, doc) {
    doc = doc || document;
    // Use the target document's own realm constructors so `instanceof` works
    // for rules that live in a nested iframe (cross-realm instanceof fails).
    const view = doc.defaultView || window;
    const StyleRule = view.CSSStyleRule || CSSStyleRule;
    const MediaRule = view.CSSMediaRule || CSSMediaRule;
    const rules = [];
    try {
      for (const sheet of doc.styleSheets) {
        try {
          const cssRules = sheet.cssRules || sheet.rules;
          if (!cssRules) continue;
          for (const rule of cssRules) {
            if (rule instanceof StyleRule) {
              try {
                if (element.matches(rule.selectorText.split(",").map(s => s.trim().replace(/::before|::after|::marker|:hover|:focus|:active/g, "")).join(","))) {
                  rules.push(rule);
                }
              } catch (_) {}
            } else if (rule instanceof MediaRule) {
              if (view.matchMedia(rule.conditionText || rule.media.mediaText).matches) {
                for (const sub of rule.cssRules) {
                  if (sub instanceof StyleRule) {
                    try {
                      if (element.matches(sub.selectorText.split(",").map(s => s.trim().replace(/::before|::after|::marker|:hover|:focus|:active/g, "")).join(","))) {
                        rules.push(sub);
                      }
                    } catch (_) {}
                  }
                }
              }
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
    return rules;
  }

  function getComputedCSS(element, selector) {
    const computed = window.getComputedStyle(element);
    const lines = [];
    for (let i = 0; i < computed.length; i++) {
      const prop = computed[i];
      const val = computed.getPropertyValue(prop);
      const defaults = ["none", "normal", "auto", "0px", "0", "", "rgba(0, 0, 0, 0)", "transparent", "start", "baseline"];
      if (!defaults.includes(val) && val !== "0px 0px" && val !== "0px 0px 0px 0px") {
        lines.push("  " + prop + ": " + val + ";");
      }
    }
    if (lines.length) {
      return selector + " {\n" + lines.join("\n") + "\n}";
    }
    return null;
  }

  function getCSSForElement(element) {
    if (processedElements.has(element)) return;
    processedElements.add(element);

    const selector = selectorFor(element);

    if (opts.computedOnly) {
      const block = getComputedCSS(element, selector);
      if (block) collectedCSS.push(block);
    } else {
      const matched = getMatchedRules(element);
      for (const rule of matched) {
        const text = rule.cssText;
        if (!collectedCSS.includes(text)) {
          collectedCSS.push(text);
        }
      }

      if (element.style && element.style.cssText) {
        collectedCSS.push(selector + " {\n  " + element.style.cssText.split(";").filter(Boolean).map(s => s.trim() + ";").join("\n  ") + "\n}");
      }
    }

    if (opts.pseudo) {
      for (const pseudo of ["::before", "::after", "::marker"]) {
        const ps = window.getComputedStyle(element, pseudo);
        const content = ps.getPropertyValue("content");
        if (content && content !== "none" && content !== "normal") {
          const lines = [];
          lines.push("  content: " + content + ";");
          for (const prop of ["display", "position", "width", "height", "background", "background-color", "background-image", "border", "color", "font-size", "font-family", "margin", "padding", "top", "left", "right", "bottom", "transform", "opacity", "z-index"]) {
            const val = ps.getPropertyValue(prop);
            if (val && val !== "none" && val !== "normal" && val !== "auto" && val !== "0px" && val !== "rgba(0, 0, 0, 0)") {
              lines.push("  " + prop + ": " + val + ";");
            }
          }
          collectedCSS.push(selector + pseudo + " {\n" + lines.join("\n") + "\n}");
        }
      }
    }
  }

  function collectScripts(element) {
    const scripts = element.querySelectorAll("script");
    scripts.forEach((s) => {
      if (s.textContent.trim()) {
        collectedJS.push(s.textContent.trim());
      }
    });

    const eventAttrs = [
      "onclick", "onchange", "onsubmit", "onload", "onerror",
      "onmouseover", "onmouseout", "onkeydown", "onkeyup", "onfocus", "onblur"
    ];
    function scanEvents(node) {
      if (node.nodeType !== 1) return;
      for (const attr of eventAttrs) {
        const val = node.getAttribute && node.getAttribute(attr);
        if (val) {
          collectedJS.push("// " + selectorFor(node) + " " + attr + "\n" + val);
        }
      }
    }
    scanEvents(element);
    if (opts.children) {
      element.querySelectorAll("*").forEach(scanEvents);
    }
  }

  function processElement(element) {
    getCSSForElement(element);

    if (opts.children) {
      element.querySelectorAll("*").forEach((child) => {
        getCSSForElement(child);
      });
    }

    collectScripts(element);

    if (opts.iframes) {
      const iframes = opts.children
        ? element.querySelectorAll("iframe")
        : element.localName === "iframe" ? [element] : [];
      iframes.forEach((iframe) => {
        const label = iframe.src || "inline";
        try {
          const doc = iframe.contentDocument;
          if (doc && doc.body) {
            // Collect only rules that match elements inside the iframe —
            // mirrors the top-document logic instead of dumping whole sheets.
            const seen = new Set();
            const iframeEls = [doc.body, ...doc.body.querySelectorAll("*")];
            for (const iel of iframeEls) {
              for (const rule of getMatchedRules(iel, doc)) {
                const text = rule.cssText;
                if (!seen.has(text)) {
                  seen.add(text);
                  collectedCSS.push("/* iframe: " + label + " */\n" + text);
                }
              }
              if (iel.style && iel.style.cssText) {
                collectedCSS.push("/* iframe: " + label + " */\n" + selectorFor(iel) + " {\n  " + iel.style.cssText.split(";").filter(Boolean).map(s => s.trim() + ";").join("\n  ") + "\n}");
              }
            }
            const iframeScripts = doc.querySelectorAll("script");
            iframeScripts.forEach((s) => {
              if (s.textContent.trim()) {
                collectedJS.push("// iframe: " + label + "\n" + s.textContent.trim());
              }
            });
          }
        } catch (_) {
          collectedCSS.push("/* iframe " + label + " — cross-origin, cannot access styles */");
        }
      });
    }
  }

  processElement(el);

  const tag = el.localName;
  const id = el.id ? "#" + el.id : "";
  const cls = el.className && typeof el.className === "string"
    ? "." + el.className.trim().split(/\s+/).join(".")
    : "";

  return {
    info: "<" + tag + id + cls + ">",
    html: opts.children ? el.outerHTML : el.cloneNode(false).outerHTML,
    css: collectedCSS.join("\n\n"),
    js: collectedJS.join("\n\n"),
  };
}
