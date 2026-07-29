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

  // Lazily-created clean iframe used to read a tag's user-agent default styles,
  // so computed-mode capture can drop every property that just equals the UA
  // default. Kept isolated (about:blank has no author CSS) so inherited values
  // the element actually needs — color, font-family — differ from the neutral
  // baseline and are preserved. Cached per tag; torn down at the end.
  const defaultsCache = new Map();
  let defaultsFrame = null;
  let defaultsDoc = null;
  let defaultsWin = null;

  function getDefaultComputed(tagName) {
    if (defaultsCache.has(tagName)) return defaultsCache.get(tagName);
    let map = null;
    try {
      if (!defaultsFrame) {
        defaultsFrame = document.createElement("iframe");
        defaultsFrame.setAttribute("aria-hidden", "true");
        defaultsFrame.style.cssText =
          "position:absolute;left:-9999px;top:0;width:0;height:0;border:0;visibility:hidden;";
        document.body.appendChild(defaultsFrame);
        defaultsDoc = defaultsFrame.contentDocument;
        defaultsWin = defaultsFrame.contentWindow;
      }
      if (defaultsDoc && defaultsDoc.body) {
        const probe = defaultsDoc.createElement(tagName);
        defaultsDoc.body.appendChild(probe);
        const cs = defaultsWin.getComputedStyle(probe);
        map = {};
        for (let i = 0; i < cs.length; i++) {
          map[cs[i]] = cs.getPropertyValue(cs[i]);
        }
        defaultsDoc.body.removeChild(probe);
      }
    } catch (_) {
      map = null; // fall back to no filtering for this tag
    }
    defaultsCache.set(tagName, map);
    return map;
  }

  // Build a selector RELATIVE to the captured root `el`. The preview/export
  // only contain el's subtree, so an absolute path anchored at a distant
  // ancestor (#content > …) would match nothing there — the generated rules
  // would silently fail to apply. Stopping at el keeps selectors self-contained.
  function selectorFor(element) {
    if (element.id) return "#" + CSS.escape(element.id);
    let path = [];
    let cur = element;
    while (cur && cur.nodeType === 1) {
      let seg = cur.localName;
      if (cur.id) {
        // An id inside the captured subtree is unique — anchor the path here.
        seg = "#" + CSS.escape(cur.id);
        path.unshift(seg);
        break;
      }
      if (cur.className && typeof cur.className === "string") {
        const classes = cur.className.trim().split(/\s+/).slice(0, 2);
        if (classes.length) seg += "." + classes.map(c => CSS.escape(c)).join(".");
      }
      // The captured root tops the isolated subtree: it has no siblings in the
      // preview/export, so drop the positional qualifier and stop climbing.
      if (cur === el) {
        path.unshift(seg);
        break;
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

  // Walk every rule in the document, descending into grouping rules
  // (@media, @supports, @layer, @container) but not into style rules.
  function eachRule(doc, cb) {
    doc = doc || document;
    const view = doc.defaultView || window;
    const StyleRule = view.CSSStyleRule || CSSStyleRule;
    function walk(rules) {
      for (const rule of rules) {
        cb(rule);
        if (rule.cssRules && !(rule instanceof StyleRule)) {
          try { walk(rule.cssRules); } catch (_) {}
        }
      }
    }
    for (const sheet of doc.styleSheets) {
      try {
        const rules = sheet.cssRules || sheet.rules;
        if (rules) walk(rules);
      } catch (_) {}
    }
  }

  // The element's matched/computed rules only carry declarations that live on
  // the element and its descendants. Two things a faithful preview also needs
  // live elsewhere: CSS custom properties (design tokens defined on :root or an
  // ancestor) and @font-face rules (at-rules, never matched to an element).
  // Without these, var() references collapse and custom fonts fall back.
  function collectContextCSS(element, doc) {
    doc = doc || document;
    const view = doc.defaultView || window;
    const FontFaceRule = view.CSSFontFaceRule || CSSFontFaceRule;
    const cssText = collectedCSS.join("\n");
    const blocks = [];

    // --- Custom properties referenced via var(), resolved from the element's
    // computed style so inheritance from :root/ancestors is handled for free.
    const computed = view.getComputedStyle(element);
    const chosen = new Map();
    const queue = [];
    const varRe = /var\(\s*(--[A-Za-z0-9_-]+)/g;
    let m;
    while ((m = varRe.exec(cssText))) queue.push(m[1]);
    while (queue.length) {
      const name = queue.shift();
      if (chosen.has(name)) continue;
      const val = computed.getPropertyValue(name).trim();
      if (!val) continue;
      chosen.set(name, val);
      // If the browser left nested references unresolved, chase them too.
      let mm;
      const nested = /var\(\s*(--[A-Za-z0-9_-]+)/g;
      while ((mm = nested.exec(val))) queue.push(mm[1]);
    }
    if (chosen.size) {
      const lines = [];
      for (const [k, v] of chosen) lines.push("  " + k + ": " + v + ";");
      blocks.push(":root {\n" + lines.join("\n") + "\n}");
    }

    // --- @font-face rules for families the element (or its captured rules)
    // actually use, so custom/icon fonts render instead of falling back.
    const families = new Set();
    function addFamilies(str) {
      if (!str) return;
      str.split(",").forEach((f) => {
        const name = f.trim().replace(/^["']|["']$/g, "").toLowerCase();
        if (name) families.add(name);
      });
    }
    let fm;
    const famRe = /font-family:\s*([^;}]+)/gi;
    while ((fm = famRe.exec(cssText))) addFamilies(fm[1]);
    addFamilies(computed.fontFamily);
    for (const pseudo of ["::before", "::after"]) {
      addFamilies(view.getComputedStyle(element, pseudo).fontFamily);
    }
    eachRule(doc, (rule) => {
      if (rule instanceof FontFaceRule) {
        const fam = (rule.style.getPropertyValue("font-family") || "")
          .trim().replace(/^["']|["']$/g, "").toLowerCase();
        if (families.has(fam)) blocks.push(rule.cssText);
      }
    });

    // --- @keyframes for animations the element (and, if captured, its
    // descendants) actually run. Like @font-face, these at-rules are never
    // matched to an element, so without this the animation has no timeline
    // to play and nothing moves in the preview.
    const KeyframesRule = view.CSSKeyframesRule || CSSKeyframesRule;
    const animNames = new Set();
    function addAnim(str) {
      if (!str || str === "none") return;
      str.split(",").forEach((n) => {
        const name = n.trim();
        if (name && name !== "none") animNames.add(name);
      });
    }
    addAnim(computed.animationName);
    for (const pseudo of ["::before", "::after"]) {
      addAnim(view.getComputedStyle(element, pseudo).animationName);
    }
    if (opts.children) {
      let count = 0;
      for (const d of element.querySelectorAll("*")) {
        if (++count > 500) break; // guard against huge subtrees
        addAnim(view.getComputedStyle(d).animationName);
      }
    }
    let an;
    const anRe = /animation-name:\s*([^;}]+)/gi;
    while ((an = anRe.exec(cssText))) addAnim(an[1]);
    if (animNames.size) {
      eachRule(doc, (rule) => {
        if (rule instanceof KeyframesRule && animNames.has(rule.name)) {
          blocks.push(rule.cssText);
        }
      });
    }

    return blocks.join("\n\n");
  }

  function getComputedCSS(element, selector) {
    const computed = window.getComputedStyle(element);
    const defaults = getDefaultComputed(element.localName);
    const lines = [];
    for (let i = 0; i < computed.length; i++) {
      const prop = computed[i];
      // Custom properties are already substituted into concrete values in
      // computed mode, so the token declarations themselves are dead weight.
      if (prop.startsWith("--")) continue;
      const val = computed.getPropertyValue(prop);
      if (!val) continue;
      // Drop anything that just matches this tag's user-agent default — that's
      // the bulk of the noise (ruby-*, mask-*, scroll-timeline-*, -webkit-*…).
      if (defaults && defaults[prop] === val) continue;
      lines.push("  " + prop + ": " + val + ";");
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

  // Prepend inherited design tokens + @font-face rules so the collected CSS is
  // self-contained: it now renders correctly on its own (preview, export, or
  // pasted elsewhere) instead of silently losing var() values and fonts.
  const context = collectContextCSS(el, el.ownerDocument || document);
  if (context) {
    collectedCSS.unshift("/* --- inherited variables, @font-face & @keyframes --- */\n" + context);
  }

  // Remove the throwaway defaults iframe we injected for computed-mode filtering.
  if (defaultsFrame && defaultsFrame.parentNode) {
    defaultsFrame.parentNode.removeChild(defaultsFrame);
  }

  // Count stylesheets we couldn't read — cross-origin sheets throw on .cssRules.
  // In matched-rule mode these are silently skipped, so the panel can use this
  // to nudge the user toward Computed only (which bypasses the restriction).
  let blockedSheets = 0;
  try {
    const doc = el.ownerDocument || document;
    for (const sheet of doc.styleSheets) {
      try {
        if (!(sheet.cssRules || sheet.rules)) { /* empty, not blocked */ }
      } catch (_) {
        blockedSheets++;
      }
    }
  } catch (_) {}

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
    // Absolute base of the element's document so relative asset URLs
    // (images, fonts, backgrounds) resolve when rendered in the preview iframe.
    baseURI: (el.ownerDocument || document).baseURI,
    // How many stylesheets were unreadable (cross-origin) — drives the hint.
    blockedSheets: blockedSheets,
  };
}
