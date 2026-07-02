/* ============================================================
   Notes — embeddable Figma-style commenting (a little tool by Konpo)
   One <script> tag. No auth. Click anything, leave a comment, resolve.
   Self-contained: all UI lives in a Shadow DOM so it never clashes
   with the host page's styles (and the host can't restyle it).
   ============================================================ */
(function () {
  "use strict";
  if (window.__konpoComments) return;

  /* ---------- config ---------- */
  var script =
    document.currentScript ||
    (function () {
      var s = document.querySelectorAll('script[src*="embed.js"]');
      return s.length ? s[s.length - 1] : null;
    })();
  var ds = (script && script.dataset) || {};
  var cfg = window.KonpoNotes || window.KonpoKomments || window.KonpoComments || {};

  function originFromScript() {
    try {
      return new URL(script.src).origin;
    } catch (e) {
      return "";
    }
  }
  var ENDPOINT = (cfg.endpoint || ds.endpoint || originFromScript()).replace(/\/$/, "");
  var PROJECT = cfg.project || ds.project || location.hostname || "default";

  // ---- Host gate (e.g. "staging only" in Webflow) ----------------------------
  // Webflow publishes the same custom code to staging (*.webflow.io) AND the live
  // custom domain, so there's no native "staging-only" switch. Instead the widget
  // gates itself: with data-staging (or data-allow-hosts) set, it boots on the
  // listed hosts and silently no-ops everywhere else. No attrs => runs everywhere
  // (unchanged). data-staging defaults the allow-list to Webflow staging + local.
  function hostMatches(host, pat) {
    pat = String(pat).trim().toLowerCase();
    if (!pat) return false;
    host = String(host).toLowerCase();
    if (pat.charAt(0) === "*") pat = pat.slice(1); // "*.webflow.io" -> ".webflow.io"
    if (pat.charAt(0) === ".") return host === pat.slice(1) || host.slice(-pat.length) === pat;
    return host === pat;
  }
  var _stagingRaw = cfg.staging != null ? cfg.staging : ds.staging; // attr present (even empty) => on
  var _stagingOn = _stagingRaw != null && !/^(0|false|no|off)$/i.test(String(_stagingRaw));
  var _allowRaw = String(cfg.allowHosts || ds.allowHosts || "").trim();
  var _allow = _allowRaw ? _allowRaw.split(",") : [];
  if (_stagingOn && !_allow.length) _allow = ["*.webflow.io", "localhost", "127.0.0.1"];
  if (_allow.length && !_allow.some(function (p) { return hostMatches(location.hostname, p); })) return;
  // ---- Brand: Konpo Notes ----------------------------------------------------
  // Konpo Notes is Konpo's internal review tool. Single brand — no white-labeling.
  var BRAND = {
    name: "Comments", accent: 250.5, lottie: true, // hue 250.5 @ 75% L = lighter brand purple #9680FF exactly
    mark: '<svg viewBox="0 0 24 24" width="16" height="16" fill="#5B21B6" aria-hidden="true"><circle cx="6" cy="12" r="2.1"/><circle cx="12" cy="12" r="2.1"/><circle cx="18" cy="12" r="2.1"/></svg>',
    creditText: "A little commenting tool by ", creditName: "Konpo", creditUrl: "https://kp-comments.vercel.app/",
  };
  // Accent is interpolated into the stylesheet text, so force it to a numeric hue (0–360).
  var ACCENT_H = String(Math.max(0, Math.min(360, Number(cfg.accent || ds.accent) || BRAND.accent)));
  var POSITION = cfg.position || ds.position || "bottom";
  var API = ENDPOINT + "/api/comments";
  var PATH = location.pathname;

  // ---- Host hooks (optional) -------------------------------------------------
  // The widget is host-agnostic: it renders in a Shadow DOM and knows nothing
  // about YOUR app's router, tabs, modals or panels — so it can't reopen them on
  // its own. It captures what it safely can (route, scroll, a stable selector, an
  // in-element percent position) and delegates the app-specific "screen state" to
  // hooks the host wires up via window.KonpoNotes:
  //   screenId()              -> stable id for the current screen/view (string)
  //   captureState(anchorEl)  -> a small JSON-able object describing the UI state
  //                              (open tab/modal/panel) to store with the comment
  //   restoreState(uiState,t) -> reopen that state before the pin is revealed;
  //                              may return a Promise (awaited before we resolve
  //                              the element and scroll/highlight). No hook wired?
  //                              the widget still restores route + scroll + pin.
  var HOOKS = {
    screenId: typeof cfg.screenId === "function" ? cfg.screenId : null,
    captureState: typeof cfg.captureState === "function" ? cfg.captureState : null,
    restoreState: typeof cfg.restoreState === "function" ? cfg.restoreState : null,
  };
  // data-open: start with the bar shown (default is hidden). Only sets the FIRST-visit
  // default — once the user toggles, their choice persists and wins.
  var _openRaw = cfg.open != null ? cfg.open : ds.open;
  var START_OPEN = _openRaw != null && !/^(0|false|no|off)$/i.test(String(_openRaw));
  // Easter egg — ONLY on the Konpo Notes landing page: pins cycle through a warm
  // purple→orange scale instead of the single accent. Pure demo flourish.
  var EGG = PROJECT === "konpo-comments-site";
  var EGG_SCALE = ["#9747ff","#a451f0","#b45ce0","#c566d2","#d873c2","#e87fb0","#f38aa0","#fb938a","#fba374","#fbb45e","#faa34a","#f97316","#f1592a"];

  /* ---------- state ---------- */
  var state = {
    threads: [],           // all threads for this project (comments + stamps), filtered by path
    name: localStorage.getItem("konpo:name") || "",
    placing: false,
    stamping: false,       // stamp tool armed? (click to drop the chosen sticker)
    stampChar: "",         // the sticker currently armed for stamping
    filter: "open",        // "open" | "all"
    openThreadId: null,
    openClientId: null,    // survives the tmp -> server id swap
    durable: true,
    pendingOps: {},        // id -> { resolved?:bool, deleted?:bool } reapplied until the server confirms
    composer: null,        // { pop, anchor } for the active new-comment popover
    panelOpen: false,      // side panel (comment list) open?
    navAt: null,           // { path, createdAt } of the last arrow-navigated comment (survives resolve)
    edge: "bottom",        // which screen edge the dock is snapped to (resets to bottom on load)
    dockFrac: 0.5,         // fraction along that edge (0..1) where the dock sits
    userFilter: null,      // panel: show only this author's comments (null = everyone)
    dockLevel: 2,          // dock is binary now: 2 = shown (pins + tools), 0 = hidden off-screen (peek tab)
  };

  var els = {};
  var pinEls = {};         // threadId -> pin element
  var cleanup = [];        // teardown handlers
  var pollTimer = null;
  var ro = null;

  /* ---------- tiny dom helpers ---------- */
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs)
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") el.className = attrs[k];
        else if (k === "text") el.textContent = attrs[k]; // always textContent for user data
        else if (k === "html") el.innerHTML = attrs[k];   // ONLY trusted inline SVG / static markup
        else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else if (attrs[k] != null) el.setAttribute(k, attrs[k]);
      });
    (kids || []).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }
  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }
  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    cleanup.push(function () { target.removeEventListener(type, fn, opts); });
  }
  function rand() { return Math.random().toString(36).slice(2, 10); }

  /* ---------- icons (trusted, inline) ---------- */
  var ICON = {
    comment:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.4 9 9 0 0 1-3.8-.8L3 21l1.9-5.6a8.4 8.4 0 0 1-.8-3.6A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/></svg>',
    // chat bubble whose typing dots bounce on click (see .comment-btn.k-tap .chat-dot)
    bubble:
      '<svg class="chat-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.4 9 9 0 0 1-3.8-.8L3 21l1.9-5.6a8.4 8.4 0 0 1-.8-3.6A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/><circle class="chat-dot d1" cx="8.5" cy="11.5" r="1.05" fill="currentColor" stroke="none"/><circle class="chat-dot d2" cx="12" cy="11.5" r="1.05" fill="currentColor" stroke="none"/><circle class="chat-dot d3" cx="15.5" cy="11.5" r="1.05" fill="currentColor" stroke="none"/></svg>',
    check:
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    close:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    camera:
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3"/></svg>',
    expand:
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
    send:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
    reopen:
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    trash:
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
    list:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    brand: BRAND.mark,
    collapse: // chevrons-down: the bar hides downward
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/></svg>',
    copy:
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    eye:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19M6.61 6.61A18.5 18.5 0 0 0 2 12s3 8 10 8a9.1 9.1 0 0 0 3.07-.53"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/><path d="M3 3l18 18"/></svg>',
    stamp:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 14.5s1.4 2 4 2 4-2 4-2"/><path d="M9 9.5h.01M15 9.5h.01"/></svg>',
    // filled chat bubble for the collapsed launcher
    chat:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3.5c5.1 0 9 3.1 9 7.2 0 4-3.9 7.2-9 7.2-.9 0-1.8-.1-2.6-.3l-4 1.7a.6.6 0 0 1-.83-.7l.86-3.36C3.5 14.9 3 13.1 3 10.7 3 6.6 6.9 3.5 12 3.5Z"/></svg>',
  };

  // Sticker set for the stamp tool. "+1" renders as a styled text sticker; the rest are emoji.
  var STAMPS = ["👍", "👎", "❤️", "🔥", "✅", "❓", "🎉", "😂", "👀", "💯", "😍", "👏"]; // 12 = two rows of 6

  /* ---------- avatars: boring-avatars "beam" algorithm ported to vanilla JS (MIT, github.com/boringdesigners/boring-avatars), Konpo purple palette ---------- */
  var AVATAR_COLORS = ["#4C1D95", "#6D28D9", "#9747FF", "#B794F6", "#E9DDFF"]; // konpo purples, dark -> pale
  var AVATAR_SIZE = 36;
  function baHash(name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    return Math.abs(hash);
  }
  function baDigit(number, nth) { return Math.floor((number / Math.pow(10, nth)) % 10); }
  function baBool(number, nth) { return baDigit(number, nth) % 2 === 0; }
  function baUnit(number, range, index) {
    var value = number % range;
    if (index && baDigit(number, index) % 2 === 0) return -value;
    return value;
  }
  function baColor(number) { return AVATAR_COLORS[number % AVATAR_COLORS.length]; }
  function baContrast(hex) {
    hex = hex.charAt(0) === "#" ? hex.slice(1) : hex;
    var r = parseInt(hex.substr(0, 2), 16), g = parseInt(hex.substr(2, 2), 16), b = parseInt(hex.substr(4, 2), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? "#000000" : "#FFFFFF";
  }
  function beamSvg(name) {
    var S = AVATAR_SIZE, n = baHash(name || ""), c = S / 2;
    var wrapperColor = baColor(n), faceColor = baContrast(wrapperColor), bgColor = baColor(n + 13);
    var pX = baUnit(n, 10, 1), wtX = pX < 5 ? pX + S / 9 : pX;
    var pY = baUnit(n, 10, 2), wtY = pY < 5 ? pY + S / 9 : pY;
    var wRot = baUnit(n, 360), wScale = 1 + baUnit(n, S / 12) / 10;
    var mouthOpen = baBool(n, 2), isCircle = baBool(n, 1);
    var eyeSpread = baUnit(n, 5), mouthSpread = baUnit(n, 3), faceRot = baUnit(n, 10, 3);
    var ftX = wtX > S / 6 ? wtX / 2 : baUnit(n, 8, 1);
    var ftY = wtY > S / 6 ? wtY / 2 : baUnit(n, 7, 2);
    var mouth = mouthOpen
      ? '<path d="M15 ' + (19 + mouthSpread) + 'c2 1 4 1 6 0" stroke="' + faceColor + '" fill="none" stroke-linecap="round"/>'
      : '<path d="M13,' + (19 + mouthSpread) + ' a1,0.75 0 0,0 10,0" fill="' + faceColor + '"/>';
    return '<svg viewBox="0 0 ' + S + ' ' + S + '" width="100%" height="100%" fill="none" aria-hidden="true">' +
      '<rect width="' + S + '" height="' + S + '" fill="' + bgColor + '"/>' +
      '<rect x="0" y="0" width="' + S + '" height="' + S + '" rx="' + (isCircle ? S : S / 6) + '" fill="' + wrapperColor +
      '" transform="translate(' + wtX + ' ' + wtY + ') rotate(' + wRot + ' ' + c + ' ' + c + ') scale(' + wScale + ')"/>' +
      '<g transform="translate(' + ftX + ' ' + ftY + ') rotate(' + faceRot + ' ' + c + ' ' + c + ')">' + mouth +
      '<rect x="' + (14 - eyeSpread) + '" y="14" width="1.5" height="2" rx="1" fill="' + faceColor + '"/>' +
      '<rect x="' + (20 + eyeSpread) + '" y="14" width="1.5" height="2" rx="1" fill="' + faceColor + '"/>' +
      '</g></svg>';
  }

  /* ---------- styles (scoped to the shadow root, Konpo controls tokens) ---------- */
  var CSS =
    ":host{all:initial;--accent-h:" +
    ACCENT_H +
    ";--accent-s:100%;--accent-l:75%;" + // lighter Konpo purple (#9680FF); dark #9747FF reserved for hover
    "--accent:hsl(var(--accent-h) var(--accent-s) var(--accent-l));" +
    "--accent-hover:hsl(266 100% 64%);" + // #9747FF — the darker purple, only on hover
    "--accent-ring:hsl(var(--accent-h) var(--accent-s) var(--accent-l) / .28);" +
    "--accent-on:#fff;" +
    "--surface:rgba(255,255,255,.72);--surface-solid:#fff;--surface-2:rgba(255,255,255,.86);" +
    "--inset:rgba(0,0,0,.04);--hairline:rgba(0,0,0,.06);--text:#0e0e12;--text-muted:#6b6b76;--text-faint:#9a9aa3;" +
    "--blur:blur(40px) saturate(180%);--shadow:0 8px 32px rgba(0,0,0,.08);--shadow-2:0 4px 16px rgba(0,0,0,.06);" +
    "--ease:cubic-bezier(.22,1,.36,1);--spring:cubic-bezier(.34,1.56,.64,1);" +
    "font-family:'Google Sans Flex',-apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif;font-optical-sizing:auto;" +
    "font-size:13px;letter-spacing:-.01em;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}" +
    /* Always light — the widget does not follow the host page's dark mode. */
    ".root{position:fixed;inset:0;z-index:2147483600;pointer-events:none;color:var(--text);}" +
    ".root *{box-sizing:border-box;}" +
    ".root.placing{cursor:crosshair;pointer-events:auto;background:transparent;}" +
    ".hl{position:fixed;pointer-events:none;border:1.5px solid var(--accent);border-radius:8px;background:hsl(var(--accent-h) var(--accent-s) var(--accent-l)/.08);transition:all .06s linear;display:none;z-index:1;}" +
    /* reveal pulse: a brief ring around the element (or pin) a comment points to */
    ".pulse{position:fixed;pointer-events:none;border-radius:10px;z-index:4;box-shadow:0 0 0 2px var(--accent),0 0 0 7px var(--accent-ring);opacity:0;}" +
    ".pulse.show{animation:konpoReveal 1.5s var(--ease);}" +
    "@keyframes konpoReveal{0%{opacity:0;transform:scale(1.06);}12%{opacity:1;transform:scale(1);}72%{opacity:1;}100%{opacity:0;transform:scale(1);}}" +
    ".pin-layer{transition:opacity .34s var(--spring);}" +
    ".root.notes-hidden .pin-layer{opacity:0;visibility:hidden;pointer-events:none;transition:opacity .3s var(--ease),visibility .3s;}" +
    ".pin{position:fixed;width:30px;height:30px;transform:translate(-50%,-100%);pointer-events:auto;border:none;padding:0;cursor:pointer;background:transparent;z-index:5;}" +
    ".pin .bubble{position:absolute;inset:0;display:grid;place-items:center;background:var(--accent);color:var(--accent-on);border-radius:50% 50% 50% 2px;box-shadow:var(--shadow-2),0 0 0 2px var(--surface-solid);font-weight:700;font-size:12px;transition:transform .12s var(--ease);}" +
    ".pin:hover .bubble{transform:scale(1.12);}" +
    ".pin.sel .bubble{box-shadow:var(--shadow),0 0 0 2px var(--surface-solid),0 0 0 5px var(--accent-ring);}" +
    ".pin.resolved .bubble{background:var(--surface-solid);color:var(--accent);box-shadow:var(--shadow-2),0 0 0 1.5px var(--hairline);}" +
    ".pin.orphan .bubble{opacity:.5;}" +
    /* stamps: emoji stickers dropped on the page, centered on the click point */
    ".root.stamping{cursor:none;pointer-events:auto;background:transparent;}" +
    ".root.stamping .stamp,.root.stamping .pin{pointer-events:none;}" + /* stamp freely over existing marks */
    ".stamp{position:fixed;transform:translate(-50%,-50%) rotate(var(--r,0deg)) scale(var(--s,1));pointer-events:auto;border:none;padding:0;margin:0;background:transparent;cursor:pointer;z-index:6;font-size:30px;line-height:1;user-select:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.22));transition:transform .14s var(--spring);}" +
    ".stamp:hover{transform:translate(-50%,-50%) rotate(var(--r,0deg)) scale(calc(var(--s,1) * 1.14));}" +
    ".stamp-em{display:inline-block;}" +
    /* quick-remove x: floats at the sticker's top-right on hover. transform-origin top-right + */
    /* counter scale/rotate keep it a constant, upright ~18px regardless of the sticker's tilt or grow size */
    ".stamp-x{position:absolute;top:-2px;right:-2px;width:18px;height:18px;padding:0;border:none;border-radius:50%;background:#fff;color:#33333a;display:grid;place-items:center;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.3),0 0 0 1px rgba(0,0,0,.06);opacity:0;pointer-events:none;transform-origin:top right;transform:rotate(calc(-1 * var(--r,0deg))) scale(calc(.7 / var(--s,1)));transition:opacity .13s var(--ease),transform .16s var(--spring),background .14s var(--ease),color .14s var(--ease);z-index:2;}" +
    ".stamp:hover .stamp-x,.stamp-x:focus-visible{opacity:1;pointer-events:auto;transform:rotate(calc(-1 * var(--r,0deg))) scale(calc(1 / var(--s,1)));}" +
    ".stamp-x:hover{background:var(--accent);color:var(--accent-on);}" +
    ".stamp-x svg{width:11px;height:11px;}" +
    ".stamp.orphan{opacity:.5;}" +
    ".stamp.plus{font-size:0;}" + /* +1 renders as a styled chip, not text */
    ".stamp.plus:after{content:'+1';font-size:19px;font-weight:800;color:#fff;background:var(--accent);border-radius:8px;padding:3px 7px;box-shadow:0 0 0 2px #fff,0 2px 4px rgba(0,0,0,.25);font-family:-apple-system,system-ui,sans-serif;letter-spacing:-.02em;}" +
    ".stamp-preview{position:fixed;transform:translate(-50%,-50%);pointer-events:none;z-index:22;font-size:30px;line-height:1;opacity:.9;filter:drop-shadow(0 2px 3px rgba(0,0,0,.22));display:none;}" +
    ".stamp-preview.plus{font-size:0;}" +
    ".stamp-preview.plus:after{content:'+1';font-size:19px;font-weight:800;color:#fff;background:var(--accent);border-radius:8px;padding:3px 7px;box-shadow:0 0 0 2px #fff,0 2px 4px rgba(0,0,0,.25);font-family:-apple-system,system-ui,sans-serif;letter-spacing:-.02em;}" +
    /* stamp picker + tiny delete popover */
    ".pop.stamp-pop{padding:10px;width:236px;transform-origin:var(--pop-origin-x,50%) bottom;animation:konpoStampPop .34s var(--spring);}" + /* .pop.stamp-pop beats .pop's blur-in */
    "@keyframes konpoStampPop{from{opacity:0;transform:translateY(10px) scale(.82);}to{opacity:1;transform:translateY(0) scale(1);}}" +
    ".stamp-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:4px;}" +
    ".stamp-grid button{height:34px;border:none;background:transparent;border-radius:9px;font-size:20px;line-height:1;cursor:pointer;display:grid;place-items:center;transition:background .14s var(--ease),transform .1s var(--ease);}" +
    ".stamp-grid button:hover{background:var(--inset);transform:scale(1.12);}" +
    ".stamp-grid button.armed{background:hsl(var(--accent-h) var(--accent-s) var(--accent-l)/.16);box-shadow:inset 0 0 0 1.5px var(--accent);}" +
    ".stamp-grid button .plus-chip{font-size:12px;font-weight:800;color:#fff;background:var(--accent);border-radius:6px;padding:2px 5px;letter-spacing:-.02em;}" +
    ".stamp-hint{font-size:11px;color:var(--text-faint);padding:8px 2px 2px;text-align:center;}" +
    ".surface{background:var(--surface);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border:1px solid var(--hairline);box-shadow:var(--shadow);pointer-events:auto;}" +
    ".dock{position:fixed;display:flex;align-items:center;gap:6px;padding:7px;border-radius:999px;background:var(--surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:var(--shadow);touch-action:none;transition:transform .46s var(--spring),opacity .3s var(--ease),padding .42s var(--spring),left .3s var(--spring),top .3s var(--spring);}" +
    /* the dock can be dragged to any screen edge; an edge class owns its anchoring + hide transforms */
    ".dock.e-bottom{bottom:20px;transform:translateX(-50%);}" +
    ".dock.e-bottom.away{transform:translateX(-50%) translateY(240%);}" +
    ".dock.e-top{top:16px;transform:translateX(-50%);}" +
    ".dock.e-top.away{transform:translateX(-50%) translateY(-240%);}" +
    ".dock.e-left{left:16px;transform:translateY(-50%);}" +
    ".dock.e-left.away{transform:translateY(-50%) translateX(-240%);}" +
    ".dock.e-right{right:16px;transform:translateY(-50%);}" +
    ".dock.e-right.away{transform:translateY(-50%) translateX(240%);}" +
    ".dock.away{opacity:0;pointer-events:none;}" +
    ".dock.dragging{transition:none!important;transform:none!important;cursor:grabbing;}" +
    ".dock-rest{display:flex;align-items:center;gap:6px;overflow:hidden;max-width:680px;opacity:1;transition:max-width .44s var(--spring),max-height .44s var(--spring),opacity .26s var(--ease),margin-left .44s var(--spring),margin-top .44s var(--spring);}" +
    /* vertical rail (snapped to a side): axis-flipped, icons only */
    ".dock.vert{flex-direction:column;}" +
    ".dock.vert .dock-rest{flex-direction:column;max-width:none;max-height:680px;}" +
    ".dock.vert.collapsed .dock-rest{max-width:none;max-height:0;margin-left:0;margin-top:-6px;width:38px;}" + /* keep the bubble a circle */
    ".dock.vert .sep{width:22px;height:1px;margin:2px 0;}" +
    ".dock.vert .brand-name,.dock.vert .brand-kc{max-width:0;min-width:0;opacity:0;margin-left:0;padding:0;border-width:0;}" +
    ".dock.vert .brand{padding:0;gap:0;}" +
    ".dock.vert .comment-btn{width:38px;height:38px;padding:0;justify-content:center;gap:0;}" +
    ".dock.vert .comment-btn span,.dock.vert .comment-btn .kc{display:none;}" +
    ".dock.vert .name-chip{padding:0;width:38px;height:38px;justify-content:center;max-width:none;background:transparent;box-shadow:none;}" +
    ".dock.vert .name-chip .nm-label{display:none;}" +
    ".dock.vert .collapse-btn svg{transform:rotate(90deg);}" +
    /* thin, subtle accent frame; border-radius rounds the corners to match the window */
    ".mode-ring{position:fixed;inset:0;pointer-events:none;z-index:24;border-radius:10px;box-shadow:inset 0 0 0 1.5px hsl(var(--accent-h) var(--accent-s) var(--accent-l)/.5);opacity:0;transition:opacity .25s var(--ease),box-shadow .22s var(--spring);}" +
    ".mode-ring.shown{opacity:1;}" +
    ".root.placing .mode-ring{opacity:1;box-shadow:inset 0 0 0 2px hsl(var(--accent-h) var(--accent-s) var(--accent-l)/.72),inset 0 0 26px hsl(var(--accent-h) var(--accent-s) var(--accent-l)/.12);}" +
    ".icon-btn{width:38px;height:38px;display:grid;place-items:center;border:none;background:transparent;color:var(--text);border-radius:999px;cursor:pointer;transition:background .18s var(--ease),color .18s var(--ease),transform .2s var(--spring);}" +
    ".icon-btn.kc-btn{width:auto;display:inline-flex;align-items:center;gap:6px;padding:0 11px;}" + /* icon + a keyboard-hint chip */
    ".icon-btn:active{transform:scale(.88);}" +
    ".icon-btn:hover{background:var(--inset);}" +
    ".icon-btn.active{background:var(--accent);color:var(--accent-on);box-shadow:0 4px 16px var(--accent-ring);}" +
    ".comment-btn{display:inline-flex;align-items:center;gap:6px;height:38px;padding:0 15px 0 12px;border:none;border-radius:999px;background:hsl(var(--accent-h) var(--accent-s) var(--accent-l)/.12);color:var(--accent-hover);font:inherit;font-weight:600;font-size:13px;cursor:pointer;flex:0 0 auto;white-space:nowrap;transition:background .18s var(--ease),color .18s var(--ease),transform .2s var(--spring);}" +
    ".comment-btn:hover{background:hsl(var(--accent-h) var(--accent-s) var(--accent-l)/.2);}" +
    ".comment-btn:active{transform:scale(.95);}" +
    ".comment-btn.active{background:var(--accent);color:var(--accent-on);box-shadow:0 4px 16px var(--accent-ring);}" +
    ".comment-btn svg{width:18px;height:18px;flex:0 0 auto;}" +
    /* icons animate on CLICK (not hover): .k-tap is added on click, removed shortly after */
    ".chat-dot{transform-box:fill-box;transform-origin:center;}" +
    ".comment-btn.k-tap .chat-dot{animation:konpoChatDot .5s var(--ease) both;}" +
    ".comment-btn.k-tap .chat-dot.d2{animation-delay:.1s;}" +
    ".comment-btn.k-tap .chat-dot.d3{animation-delay:.2s;}" +
    "@keyframes konpoChatDot{0%,100%{transform:translateY(0);}42%{transform:translateY(-2.6px);}}" +
    ".icon-btn.k-tap svg,.comment-btn.k-tap .chat-ico{animation:konpoIconPop .42s var(--spring);}" +
    "@keyframes konpoIconPop{0%{transform:scale(1);}35%{transform:scale(.82);}70%{transform:scale(1.1);}100%{transform:scale(1);}}" +
    ".kc{display:inline-flex;align-items:center;justify-content:center;min-width:15px;height:15px;padding:0 4px;border:1px solid currentColor;border-bottom-width:2px;border-radius:4px;font-family:'Google Sans Code',ui-monospace,Menlo,monospace;font-size:9.5px;font-weight:700;line-height:1;opacity:.5;flex:0 0 auto;box-sizing:border-box;}" +
    ".tool-kc{transition:opacity .18s var(--ease),max-width .2s var(--ease),margin .2s var(--ease);max-width:24px;overflow:hidden;}" +
    ".comment-btn.active .tool-kc{opacity:0;max-width:0;min-width:0;margin-left:-6px;border-width:0;padding:0;}" +
    ".brand-kc{margin-left:-2px;transition:opacity .24s var(--ease),max-width .44s var(--spring),margin .44s var(--spring),border-width .2s;max-width:24px;overflow:hidden;}" +
    ".btn-kc{display:inline-flex;align-items:center;gap:7px;}" +
    ".btn-kc .kc{opacity:.65;}" +
    ".view-btn{display:inline-flex;align-items:center;gap:6px;height:38px;padding:0 14px;border:none;border-radius:999px;background:transparent;color:var(--text);font:inherit;font-weight:600;font-size:13px;cursor:pointer;flex:0 0 auto;white-space:nowrap;transition:background .18s var(--ease),color .18s var(--ease);}" +
    ".view-btn:hover{background:var(--inset);}" +
    ".view-btn.active{background:var(--accent);color:var(--accent-on);box-shadow:0 4px 16px var(--accent-ring);}" +
    ".view-btn svg{width:18px;height:18px;flex:0 0 auto;}" +
    ".count{min-width:30px;height:30px;padding:0 11px;border-radius:999px;display:inline-flex;align-items:center;gap:6px;background:var(--inset);color:var(--text-muted);font-weight:600;font-size:12px;}" +
    ".count b{color:var(--text);font-weight:700;}" +
    ".count .ci{display:inline-flex;align-items:center;gap:4px;color:var(--text-muted);}" +
    ".count .ci svg{width:14px;height:14px;display:block;}" +
    ".count .ci.done{color:var(--accent);}" +
    ".confetti{position:fixed;inset:0;pointer-events:none;z-index:25;overflow:hidden;}" +
    ".confetti-piece{position:absolute;border-radius:2px;will-change:transform,opacity;}" +
    ".seg{display:inline-flex;background:var(--inset);border-radius:999px;padding:3px;gap:2px;}" +
    ".seg button{display:inline-flex;align-items:center;border:none;background:transparent;color:var(--text-muted);font:inherit;font-weight:600;font-size:12px;padding:5px 10px 5px 12px;border-radius:999px;cursor:pointer;transition:background .24s var(--spring),color .18s var(--ease),transform .2s var(--spring);}" +
    ".seg button:active{transform:scale(.94);}" +
    ".seg button .seg-n{margin-left:6px;display:inline-block;min-width:16px;height:16px;line-height:16px;padding:0 5px;border-radius:999px;background:var(--inset);color:var(--text-faint);font-size:10px;font-weight:700;text-align:center;font-variant-numeric:tabular-nums;}" +
    ".seg button.on .seg-n{background:hsl(var(--accent-h) var(--accent-s) var(--accent-l)/.16);color:var(--accent);}" +
    ".seg button.on{background:var(--surface-solid);color:var(--text);box-shadow:var(--shadow-2);}" +
    ".name-chip{height:32px;padding:0 12px 0 5px;border-radius:999px;background:var(--inset);color:var(--text);font-weight:600;font-size:12px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:7px;max-width:160px;}" +
    ".name-chip .avi{width:24px;height:24px;border-radius:50%;overflow:hidden;flex:0 0 auto;transition:filter .25s var(--ease);}" +
    ".name-chip .avi svg{width:100%;height:100%;display:block;}" +
    ".name-chip.noname .avi{filter:grayscale(1) brightness(.45);}" + /* dark until a name exists */
    ".name-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    ".name-pop{width:312px;}" +
    ".name-card{padding:16px;display:flex;flex-direction:column;gap:14px;}" +
    ".name-head{display:flex;align-items:center;gap:13px;}" +
    ".name-avatar{width:46px;height:46px;border-radius:50%;overflow:hidden;flex:0 0 auto;background:var(--accent);box-shadow:0 0 0 3px var(--accent-ring);}" +
    ".name-avatar svg{width:100%;height:100%;display:block;}" +
    ".name-title{font-weight:700;font-size:15px;letter-spacing:-.015em;}" +
    ".name-sub{font-size:12px;color:var(--text-muted);line-height:1.45;margin-top:3px;}" +
    ".name-input{height:46px;font-size:14px;}" +
    ".name-card .btn{width:100%;justify-content:center;}" +
    ".sep{width:1px;height:22px;background:var(--hairline);margin:0 2px;}" +
    ".pop{position:fixed;width:300px;max-width:calc(100vw - 24px);border-radius:20px;padding:0;overflow:hidden;z-index:20;visibility:hidden;background:var(--surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none;animation:konpoPopIn .22s var(--ease);}" +
    /* beui-style entrances: popovers blur+fade in, the panel scales in with a spring */
    "@keyframes konpoPopIn{from{opacity:0;filter:blur(7px);}to{opacity:1;filter:blur(0);}}" +
    "@keyframes konpoPanelIn{from{opacity:0;transform:translateX(10px) scale(.98);}to{opacity:1;transform:none;}}" +
    ".pop-head{display:flex;align-items:center;gap:10px;padding:12px 14px 8px;}" +
    ".avatar{width:26px;height:26px;border-radius:50%;background:var(--accent);color:var(--accent-on);display:grid;place-items:center;font-weight:700;font-size:11px;flex:0 0 auto;text-transform:uppercase;overflow:hidden;}" +
    ".avatar svg{width:100%;height:100%;display:block;}" +
    ".who{display:flex;flex-direction:column;line-height:1.25;min-width:0;flex:1;}" +
    ".who .nm{font-weight:600;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    ".who .tm{color:var(--text-faint);font-size:11px;}" +
    ".body-txt{padding:2px 14px 12px;font-size:13px;font-weight:350;line-height:1.5;white-space:pre-wrap;word-break:break-word;}" +
    ".target-chip{margin:0 14px 10px;display:inline-flex;align-items:center;gap:6px;max-width:calc(100% - 28px);font-size:11px;color:var(--text-muted);background:var(--inset);border-radius:999px;padding:3px 9px;width:fit-content;font-family:'Google Sans Code',ui-monospace,'SF Mono',Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    ".replies{max-height:230px;overflow:auto;border-top:1px solid var(--hairline);}" +
    ".reply{padding:10px 14px;border-top:1px solid var(--hairline);}" +
    ".reply:first-child{border-top:none;}" +
    ".reply .body-txt{padding:4px 0 0;}" +
    ".reply .pop-head{padding:0;}" +
    ".pop-foot{display:flex;gap:8px;align-items:flex-end;padding:10px 12px;border-top:1px solid var(--hairline);background:var(--surface-2);}" +
    ".actions{display:flex;flex-direction:column;gap:2px;padding:8px;border-top:1px solid var(--hairline);}" +
    ".actions .btn-ghost{width:100%;height:36px;justify-content:flex-start;padding:0 10px;}" +
    ".actions .btn-ghost.danger{color:var(--text-muted);}" +
    ".actions .btn-ghost.danger:hover{color:#e5484d;background:hsl(358 70% 55% / .1);}" +
    /* screenshot + environment: every comment carries the page it was made on */
    ".sec-label{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-faint);}" +
    ".shot-sec{padding:8px 14px 2px;}" +
    ".shot-sec .sec-label{margin-bottom:7px;}" +
    ".shot-thumb{position:relative;display:block;width:100%;padding:0;border:1px solid var(--hairline);border-radius:12px;overflow:hidden;background:var(--inset);cursor:zoom-in;aspect-ratio:16 / 10;transition:box-shadow .18s var(--ease);}" +
    ".shot-thumb img{width:100%;height:100%;object-fit:cover;object-position:top center;display:block;}" +
    ".shot-thumb:hover{box-shadow:var(--shadow-2);}" +
    ".shot-thumb .shot-badge{position:absolute;left:8px;bottom:8px;display:inline-flex;align-items:center;gap:5px;padding:3px 8px 3px 6px;border-radius:999px;background:rgba(14,14,18,.72);color:#fff;font-size:11px;font-weight:600;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);}" +
    ".shot-thumb .shot-badge svg{width:12px;height:12px;}" +
    ".shot-thumb .shot-zoom{position:absolute;top:8px;right:8px;width:26px;height:26px;border-radius:8px;background:rgba(14,14,18,.6);color:#fff;display:grid;place-items:center;opacity:0;transition:opacity .16s var(--ease);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);}" +
    ".shot-thumb:hover .shot-zoom{opacity:1;}" +
    ".shot-cap{display:flex;align-items:center;gap:9px;height:74px;border:1px dashed var(--hairline);border-radius:12px;color:var(--text-muted);font-size:12px;justify-content:center;background:var(--inset);}" +
    ".shot-cap .spin{width:14px;height:14px;border:2px solid var(--hairline);border-top-color:var(--accent);border-radius:50%;animation:konpoSpin .7s linear infinite;}" +
    "@keyframes konpoSpin{to{transform:rotate(360deg);}}" +
    ".info-sec{padding:9px 14px 4px;}" +
    ".info-head{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;user-select:none;}" +
    ".info-head .info-toggle{font-size:11px;font-weight:600;color:var(--accent);flex:0 0 auto;}" +
    ".info-grid{margin:9px 0 0;display:grid;grid-template-columns:auto 1fr;gap:7px 12px;}" +
    ".info-sec.collapsed .info-grid{display:none;}" +
    ".info-grid dt{font-size:11.5px;color:var(--text-muted);white-space:nowrap;}" +
    ".info-grid dd{margin:0;font-size:11.5px;color:var(--text);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}" +
    ".info-grid dd.mono{font-family:'Google Sans Code',ui-monospace,Menlo,monospace;font-size:10.5px;white-space:normal;word-break:break-word;}" +
    ".info-grid dd a{color:var(--accent);text-decoration:none;}" +
    ".info-grid dd a:hover{text-decoration:underline;}" +
    ".lightbox{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:5vh 5vw;background:rgba(14,14,18,.8);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);pointer-events:auto;animation:konpoPopIn .16s var(--ease);cursor:zoom-out;}" +
    ".lightbox img{max-width:100%;max-height:100%;border-radius:12px;box-shadow:0 20px 70px rgba(0,0,0,.5);cursor:default;}" +
    ".lightbox .lb-close{position:absolute;top:18px;right:18px;width:38px;height:38px;border:none;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;display:grid;place-items:center;cursor:pointer;transition:background .16s var(--ease);}" +
    ".lightbox .lb-close:hover{background:rgba(255,255,255,.26);}" +
    "textarea.field{flex:1;resize:none;min-height:38px;max-height:120px;padding:9px 12px;border-radius:12px;border:1px solid var(--hairline);background:var(--surface-solid);color:var(--text);font:inherit;line-height:1.4;outline:none;transition:border-color .18s,box-shadow .18s;}" +
    "input.field{height:40px;padding:0 12px;border-radius:12px;border:1px solid var(--hairline);background:var(--surface-solid);color:var(--text);font:inherit;outline:none;width:100%;transition:border-color .18s,box-shadow .18s;}" +
    ".field:focus{border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-ring);}" +
    ".field::placeholder{color:var(--text-faint);}" +
    ".btn{height:40px;padding:0 16px;border:none;border-radius:12px;background:var(--accent);color:var(--accent-on);font:inherit;font-weight:600;cursor:pointer;box-shadow:0 4px 16px var(--accent-ring);transition:background .18s var(--ease),transform .12s var(--ease);white-space:nowrap;}" +
    ".btn:hover{background:var(--accent-hover);}" +
    ".btn:active{transform:scale(.97);}" +
    ".btn:disabled{opacity:.45;box-shadow:none;cursor:default;}" +
    ".btn.send{width:40px;padding:0;display:grid;place-items:center;flex:0 0 auto;}" +
    ".btn-ghost{height:32px;padding:0 12px;border:none;border-radius:10px;background:transparent;color:var(--text-muted);font:inherit;font-weight:600;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}" +
    ".btn-ghost:hover{background:var(--inset);color:var(--text);}" +
    ".btn-ghost.resolve{color:var(--accent);}" +
    ".spacer{flex:1;}" +
    ".composer{padding:12px;display:flex;flex-direction:column;gap:8px;}" +
    ".composer .row{display:flex;gap:8px;}" +
    ".hint{font-size:11px;color:var(--text-faint);padding:0 2px;}" +
    ".toast{position:fixed;left:50%;bottom:80px;transform:translateX(-50%) translateY(8px) scale(.98);max-width:min(420px,calc(100vw - 24px));padding:13px 14px 13px 16px;border-radius:16px;font-size:13px;font-weight:500;line-height:1.45;color:var(--text);display:flex;gap:11px;align-items:flex-start;opacity:0;transition:opacity .26s var(--ease),transform .42s var(--spring);pointer-events:auto;}" +
    ".toast.show{opacity:1;transform:translateX(-50%) translateY(0) scale(1);}" +
    ".toast .tdot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--accent);margin-top:6px;box-shadow:0 0 0 4px var(--accent-ring);}" +
    ".toast .tmsg{flex:1 1 auto;padding-top:1px;}" +
    ".toast .tmsg b{font-weight:650;color:var(--text);}" +
    ".toast .tmsg .tip-kbd{display:inline-block;min-width:16px;text-align:center;padding:1px 5px;margin:0 1px;border:1px solid var(--hairline);border-bottom-width:2px;border-radius:5px;background:var(--surface-solid);color:var(--text);font-family:'Google Sans Code',ui-monospace,Menlo,monospace;font-size:11px;font-weight:700;line-height:1.3;box-shadow:0 1px 0 rgba(0,0,0,.06);}" +
    ".toast .x{cursor:pointer;color:var(--text-faint);flex:0 0 auto;width:24px;height:24px;margin:-3px -3px 0 0;display:grid;place-items:center;border-radius:8px;transition:background .16s var(--ease),color .16s var(--ease);}" +
    ".toast .x:hover{background:var(--inset);color:var(--text);}" +
    ".panel{position:fixed;top:16px;right:16px;bottom:84px;width:300px;max-width:calc(100vw - 32px);border-radius:20px;display:none;flex-direction:column;overflow:hidden;z-index:16;background:var(--surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:var(--shadow);}" +
    ".panel.open{display:flex;animation:konpoPanelIn .3s var(--spring);}" +
    ".panel-head{display:flex;align-items:center;gap:8px;padding:10px 8px 10px 16px;border-bottom:1px solid var(--hairline);}" +
    ".panel-users{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--hairline);overflow-x:auto;scrollbar-width:none;flex:0 0 auto;}" +
    ".panel-users::-webkit-scrollbar{display:none;}" +
    ".u-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px 0 4px;border-radius:999px;border:none;background:var(--inset);color:var(--text);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;flex:0 0 auto;max-width:140px;transition:background .15s var(--ease),color .15s var(--ease);}" +
    ".u-chip .u-av{width:20px;height:20px;border-radius:50%;overflow:hidden;flex:0 0 auto;}" +
    ".u-chip .u-av svg{width:100%;height:100%;display:block;}" +
    ".u-chip .u-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    ".u-chip .u-all{padding-left:6px;}" +
    ".u-chip .u-n{font-size:10px;font-weight:700;color:var(--text-faint);}" +
    ".u-chip.on{background:var(--accent);color:var(--accent-on);}" +
    ".u-chip.on .u-n{color:var(--accent-on);opacity:.8;}" +
    ".panel-foot{padding:10px;border-top:1px solid var(--hairline);}" +
    ".panel-foot .btn{width:100%;height:42px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font-size:13px;}" +
    ".panel-foot .btn svg{width:15px;height:15px;flex:0 0 auto;}" +
    ".panel-foot .btn span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    ".panel-credit{text-align:center;font-size:11px;color:var(--text-faint);padding:9px 0 1px;}" +
    ".panel-credit a{color:var(--accent);text-decoration:none;font-weight:600;}" +
    ".panel-credit a:hover{text-decoration:underline;}" +
    ".panel-head .ptitle{font-weight:600;font-size:13px;flex:1;}" +
    ".panel-head .pn{color:var(--text-faint);font-weight:500;}" +
    ".panel-list{flex:1;overflow:auto;}" +
    ".panel-empty{padding:30px 18px;text-align:center;color:var(--text-faint);font-size:12.5px;line-height:1.5;}" +
    ".pitem{display:flex;gap:10px;padding:12px 14px;border:none;border-bottom:1px solid var(--hairline);background:transparent;color:inherit;font:inherit;text-align:left;width:100%;cursor:pointer;transition:background .15s var(--ease);}" +
    ".pitem:hover{background:var(--inset);}" +
    ".pitem.sel{background:var(--inset);}" +
    ".pitem .pnum{width:22px;height:22px;border-radius:999px;background:var(--accent);color:var(--accent-on);font-size:11px;font-weight:700;display:grid;place-items:center;flex:0 0 auto;}" +
    ".pitem.res .pnum{background:var(--surface-solid);color:var(--accent);box-shadow:0 0 0 1.5px var(--hairline);}" +
    ".pitem .pcol{flex:1;min-width:0;}" +
    ".pitem .pwho{font-weight:600;font-size:12px;margin-bottom:1px;}" +
    ".pitem .ptxt{color:var(--text-muted);font-size:12.5px;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}" +
    ".pitem .pmeta{color:var(--text-faint);font-size:11px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    ".panel-group{display:flex;align-items:center;gap:8px;padding:12px 16px 5px;border-top:1px solid var(--hairline);}" +
    ".panel-group:first-child{border-top:none;}" +
    ".panel-group .pg-path{flex:1;min-width:0;font-size:11px;font-weight:700;color:var(--text-muted);font-family:'Google Sans Code',ui-monospace,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    ".panel-group .pg-cur{color:var(--accent);}" +
    ".panel-group .pg-n{font-size:10px;font-weight:700;color:var(--text-faint);}" +
    ".brand{display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 10px 0 4px;border:none;background:transparent;color:var(--text);border-radius:999px;cursor:pointer;}" +
    ".brand.brand-logo-only{padding:0 4px;}" + /* logo only — balanced padding, no label */
    ".brand:hover{background:var(--inset);}" +
    ".brand-mark{width:30px;height:30px;border-radius:9px;background:transparent;display:grid;place-items:center;flex:0 0 auto;overflow:hidden;transition:width .46s var(--spring),height .46s var(--spring),border-radius .46s var(--spring);}" +
    ".brand-mark svg{width:100%;height:100%;display:block;}" +
    ".brand-name{font-weight:700;font-size:13px;letter-spacing:-.01em;white-space:nowrap;max-width:140px;opacity:1;overflow:hidden;transition:max-width .44s var(--spring),opacity .24s var(--ease),margin-left .44s var(--spring);}" +
    ".brand-tip{position:fixed;z-index:30;background:var(--accent);border:none;border-radius:13px;box-shadow:0 8px 28px var(--accent-ring),0 4px 12px rgba(0,0,0,.18);padding:10px 16px;font-size:12.5px;line-height:1.5;color:var(--accent-on);text-align:center;white-space:nowrap;pointer-events:auto;opacity:0;visibility:hidden;transform:translateY(4px);transition:opacity .2s var(--ease),transform .34s var(--spring),visibility .2s;}" +
    ".brand-tip.show{opacity:1;visibility:visible;transform:translateY(0);}" +
    ".brand-tip:before{content:'';position:absolute;left:0;right:0;bottom:-9px;height:9px;}" + /* invisible hover bridge across the caret gap */
    ".brand-tip:after{content:'';position:absolute;left:var(--caret-x,50%);bottom:-4px;margin-left:-4px;width:8px;height:8px;background:var(--accent);transform:rotate(45deg);}" +
    ".brand-tip.flip:before{bottom:auto;top:-9px;}" +
    ".brand-tip.flip:after{bottom:auto;top:-4px;}" +
    ".brand-tip a{color:var(--accent-on);text-decoration:underline;font-weight:600;}" +
    ".brand-tip .tip-kbd{display:inline-block;vertical-align:middle;min-width:17px;text-align:center;padding:2px 6px;margin:0 5px;border:1px solid rgba(0,0,0,.12);border-bottom-width:2px;border-radius:5px;background:#fff;color:#1a1a1a;font-family:'Google Sans Code',ui-monospace,Menlo,monospace;font-size:11px;font-weight:700;line-height:1.3;box-shadow:0 1px 1px rgba(0,0,0,.14);}" +
    ".collapse-btn{width:32px;height:32px;}" +
    ".dock.collapsed{padding:5px;}" +
    ".dock.collapsed .dock-rest{max-width:0;opacity:0;margin-left:-6px;pointer-events:none;}" +
    ".dock.collapsed .brand{padding:0;gap:0;}" +
    ".dock.collapsed .brand-name{max-width:0;opacity:0;margin-left:0;}" +
    ".dock.collapsed .brand-kc{max-width:0;min-width:0;opacity:0;margin-left:0;padding:0;border-width:0;}" +
    ".dock.collapsed .brand-mark{width:38px;height:38px;border-radius:12px;}" +
    ".panel-brand{display:flex;align-items:center;gap:8px;padding:10px 8px 0 16px;}" +
    ".panel-brand .brand-mark{width:22px;height:22px;border-radius:7px;}" +
    ".panel-brand .pbname{font-weight:700;font-size:12.5px;letter-spacing:-.01em;}" +
    /* peek launcher: the branded toggle shown when the bar is hidden — click to reopen */
    ".peek{position:fixed;display:inline-flex;align-items:center;gap:7px;pointer-events:auto;cursor:pointer;z-index:26;background:var(--surface-solid);border:1px solid var(--hairline);box-shadow:0 6px 22px rgba(0,0,0,.16);color:var(--text);font-weight:600;font-size:12.5px;letter-spacing:-.01em;transition:transform .42s var(--spring),box-shadow .2s var(--ease);}" +
    ".peek:hover{box-shadow:0 10px 28px rgba(0,0,0,.22);}" +
    ".peek .peek-mark{width:20px;height:20px;display:grid;place-items:center;flex:0 0 auto;overflow:hidden;color:var(--accent);}" +
    ".peek .peek-mark svg{width:18px;height:18px;display:block;}" +
    ".peek .peek-label{white-space:nowrap;}" +
    ".peek.e-bottom{bottom:0;padding:7px 15px 9px;border-radius:14px 14px 0 0;transform:translateX(-50%) translateY(120%);}" +
    ".peek.e-bottom.shown{transform:translateX(-50%) translateY(0);}" +
    ".peek.e-top{top:0;padding:9px 15px 7px;border-radius:0 0 14px 14px;transform:translateX(-50%) translateY(-120%);}" +
    ".peek.e-top.shown{transform:translateX(-50%) translateY(0);}" +
    ".peek.e-left{left:0;flex-direction:column;padding:10px 8px;border-radius:0 14px 14px 0;transform:translateY(-50%) translateX(-120%);}" +
    ".peek.e-left.shown{transform:translateY(-50%) translateX(0);}" +
    ".peek.e-right{right:0;flex-direction:column;padding:10px 8px;border-radius:14px 0 0 14px;transform:translateY(-50%) translateX(120%);}" +
    ".peek.e-right.shown{transform:translateY(-50%) translateX(0);}" +
    ".peek.e-left .peek-label,.peek.e-right .peek-label{display:none;}" + /* side rail: icon only */
    /* ---------- mobile: icons-only dock, bottom-sheet panel, bigger targets ---------- */
    "@media (max-width:640px){" +
      ".dock{gap:4px;padding:6px;max-width:calc(100vw - 16px);}" +
      ".dock.e-bottom{bottom:12px;}" +
      ".dock.e-top{top:10px;}" +
      ".dock.e-left{left:10px;}" +
      ".dock.e-right{right:10px;}" +
      ".dock.vert{max-width:none;max-height:calc(100vh - 16px);}" +
      ".dock-rest{gap:4px;}" +
      /* collapsed bubble must be a true circle: cancel the mobile gap exactly */
      ".dock.collapsed{gap:0;padding:5px;}" +
      ".dock.collapsed .dock-rest{margin-left:0;height:38px;}" + /* 42px touch buttons inside would otherwise stretch the bubble */
      ".dock.vert.collapsed .dock-rest{height:auto;width:38px;margin-top:0;}" + /* mobile gap is 0, so no -6px cancel */
      ".dock.vert .comment-btn,.dock.vert .name-chip{width:42px;height:42px;}" +
      ".dock .kc{display:none;}" + /* keyboard hints are meaningless on touch */
      ".brand{padding:0 2px 0 2px;gap:0;}" +
      ".brand-name{max-width:0;opacity:0;margin-left:0;}" + /* logo only — same as collapsed */
      ".comment-btn{width:42px;height:42px;padding:0;justify-content:center;gap:0;}" +
      ".comment-btn span{display:none;}" + /* icon-only Comment button */
      ".comment-btn svg{width:20px;height:20px;}" +
      ".icon-btn{width:42px;height:42px;}" +
      ".name-chip{padding:0;width:42px;height:42px;justify-content:center;background:transparent;box-shadow:none;}" + /* just the avatar, no chip background */
      ".name-chip .nm-label{display:none;}" + /* avatar alone = identity */
      ".name-chip .avi{width:28px;height:28px;}" +
      ".collapse-btn{display:none;}" + /* tap the logo or swipe down instead */
      ".sep{margin:0;}" +
      ".panel{top:auto;left:8px;right:8px;bottom:72px;width:auto;max-width:none;max-height:62vh;border-radius:18px;}" +
      ".pop{width:min(340px,calc(100vw - 20px));}" +
      ".name-pop{width:min(340px,calc(100vw - 20px));}" +
      ".toast{bottom:72px;}" +
      ".mode-ring{border-radius:8px;box-shadow:inset 0 0 0 1.5px hsl(var(--accent-h) var(--accent-s) var(--accent-l)/.5);}" +
    "}";

  /* ---------- mount ---------- */
  var host = document.createElement("div");
  host.id = "konpo-comments-host";
  var shadow = host.attachShadow({ mode: "open" });
  var styleTag = document.createElement("style");
  styleTag.textContent = CSS;
  shadow.appendChild(styleTag);
  var root = h("div", { class: "root" });
  shadow.appendChild(root);
  els.highlight = h("div", { class: "hl" });
  root.appendChild(els.highlight);
  els.pulse = h("div", { class: "pulse" }); // transient highlight when revealing a comment
  root.appendChild(els.pulse);
  els.pinLayer = h("div", { class: "pin-layer" });
  root.appendChild(els.pinLayer);
  els.confetti = h("div", { class: "confetti" });
  root.appendChild(els.confetti);
  els.modeRing = h("div", { class: "mode-ring" });
  root.appendChild(els.modeRing);
  els.stampPreview = h("div", { class: "stamp-preview" }); // follows the cursor while stamping
  root.appendChild(els.stampPreview);

  function mount() {
    (document.body || document.documentElement).appendChild(host);
    buildDock();
    buildPanel();
  }

  // Google Sans Flex (UI) + Google Sans Code (snippets). @font-face declared inside a
  // Shadow DOM is ignored by browsers, so the stylesheet must live in the host <head>;
  // once registered there the shadow's font-family picks it up. Falls back to system
  // fonts if the host's CSP blocks the request. Injected once, non-blocking.
  function loadFonts() {
    try {
      if (document.getElementById("konpo-fonts")) return;
      var head = document.head || document.documentElement;
      ["https://fonts.googleapis.com", "https://fonts.gstatic.com"].forEach(function (href, i) {
        var pc = document.createElement("link");
        pc.rel = "preconnect"; pc.href = href; if (i === 1) pc.crossOrigin = "anonymous";
        head.appendChild(pc);
      });
      var link = document.createElement("link");
      link.id = "konpo-fonts";
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Google+Sans+Code:wght@400..600&family=Google+Sans+Flex:wght@300..700&display=swap";
      head.appendChild(link);
    } catch (e) {}
  }

  // If an ancestor of the host establishes a containing block (transform/filter on
  // html/body), our position:fixed layer is offset from the viewport. Measure it and
  // compensate so pins still land on their targets (handles the common translate case).
  function layerOffset() {
    var r = root.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }

  /* ---------- animated logo (Lottie, lazy-loaded with graceful fallback to the dot mark) ---------- */
  var LOGO_LOADING = false, LOGO_READY = false, LOGO_DATA = null;
  function loadLogo() {
    if (!BRAND.lottie) return; // no animated logo -> keep the static dot mark
    if (LOGO_READY) { mountLogos(); return; }
    if (LOGO_LOADING) return;
    LOGO_LOADING = true;
    var s = document.createElement("script");
    s.src = ENDPOINT + "/lottie_light.min.js";
    s.async = true;
    s.onload = function () { LOGO_READY = true; LOGO_LOADING = false; mountLogos(); };
    s.onerror = function () { LOGO_LOADING = false; }; // CSP/offline: keep the dot-mark fallback
    (document.head || document.documentElement).appendChild(s);
  }
  // Fetch the animation JSON ourselves so we control the fallback: the static dots are
  // only swapped out once the data actually arrives. If the fetch is blocked (CORS on a
  // cross-origin embed, CSP, offline) the dot mark simply stays. Then play it in every
  // .brand-mark (dock + panel). Uses animationData (not path:) to avoid a second fetch.
  function mountLogos() {
    if (!window.lottie) return;
    if (LOGO_DATA) { playLogos(); return; }
    fetch(ENDPOINT + "/konpo-lottie.json", { cache: "force-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data) { LOGO_DATA = data; playLogos(); } })
      .catch(function () {}); // keep the dot mark
  }
  function playLogos() {
    var marks = shadow.querySelectorAll(".brand-mark");
    Array.prototype.forEach.call(marks, function (m) {
      if (m.__lottie || !LOGO_DATA) return;
      clear(m);
      m.style.background = "transparent";
      try {
        m.__lottie = window.lottie.loadAnimation({
          container: m,
          renderer: "svg",
          loop: true,
          autoplay: true,
          animationData: LOGO_DATA,
          rendererSettings: { preserveAspectRatio: "xMidYMid meet" },
        });
      } catch (e) {}
    });
  }

  /* ---------- dock ---------- */
  function buildDock() {
    var dock = h("div", { class: "surface dock e-bottom" }); // data-position="bottom-right" maps to dockFrac below

    // Just the Lottie logo now — the credit tooltip shows on hover (listeners below).
    els.brand = h("button", { class: "brand brand-logo-only", "aria-label": BRAND.name }, [
      h("span", { class: "brand-mark", html: ICON.brand }),
    ]);
    // Hovering the logo pops the Konpo credit tooltip.
    els.brandTip = h("div", { class: "brand-tip" });
    root.appendChild(els.brandTip);
    function fillBrandTip() {
      clear(els.brandTip);
      els.brandTip.appendChild(document.createTextNode(BRAND.creditText));
      if (BRAND.creditName) els.brandTip.appendChild(h("a", { href: BRAND.creditUrl, target: "_blank", rel: "noopener noreferrer", text: BRAND.creditName + " ↗" }));
    }
    function showBrandTip() {
      if (state.dockLevel === 0) return;
      cancelTipHide();
      fillBrandTip();
      els.brandTip.classList.add("show");
      var br = els.brand.getBoundingClientRect(), off = layerOffset();
      var w = els.brandTip.offsetWidth, hh = els.brandTip.offsetHeight;
      var brandCenter = br.left - off.x + br.width / 2;
      var x = brandCenter - w / 2, y = br.top - off.y - hh - 5;
      var flip = y < 8; // dock at the top edge -> tooltip goes below the logo
      if (flip) y = br.bottom - off.y + 5;
      els.brandTip.classList.toggle("flip", flip);
      if (x + w > window.innerWidth - 12) x = window.innerWidth - 12 - w;
      if (x < 12) x = 12;
      els.brandTip.style.left = x + "px";
      els.brandTip.style.top = y + "px";
      els.brandTip.style.setProperty("--caret-x", (brandCenter - x) + "px");
    }
    var _tipHide = null;
    function cancelTipHide() { if (_tipHide) { clearTimeout(_tipHide); _tipHide = null; } }
    function scheduleTipHide() { cancelTipHide(); _tipHide = setTimeout(function () { els.brandTip.classList.remove("show"); }, 220); }
    els.brand.addEventListener("mouseenter", showBrandTip);
    els.brand.addEventListener("mouseleave", scheduleTipHide);
    els.brandTip.addEventListener("mouseenter", cancelTipHide);
    els.brandTip.addEventListener("mouseleave", scheduleTipHide);
    els.toolBtn = h("button", { class: "comment-btn", title: "Leave a comment (press C)", onclick: togglePlacing });
    els.toolBtn.innerHTML = ICON.bubble;
    els.toolLabel = h("span", { text: "Comment" });
    els.toolBtn.appendChild(els.toolLabel);
    els.toolKc = h("span", { class: "kc tool-kc", text: "C" });
    els.toolBtn.appendChild(els.toolKc);
    els.stampBtn = h("button", { class: "icon-btn", title: "Stamp — drop emoji stickers on the page", html: ICON.stamp, onclick: toggleStampPicker });
    els.listBtn = h("button", { class: "icon-btn", title: "View comments (K) — click one to jump, or use ←/→", onclick: togglePanel });
    els.listBtn.innerHTML = ICON.list;
    els.nameAvi = h("span", { class: "avi" });
    els.nameAvi.innerHTML = beamSvg(state.name || "");
    els.nameChip = h("button", { class: "name-chip", title: "", "aria-label": "Set your name", onclick: function () { askName(); } }, [
      els.nameAvi,
      h("span", { class: "nm-label" }),
    ]);
    els.collapseBtn = h("button", { class: "icon-btn collapse-btn", title: "Hide the bar", html: ICON.collapse, onclick: hideDock });

    // Icons animate on CLICK, not hover: replay the .k-tap animation on each click.
    [els.toolBtn, els.listBtn, els.stampBtn, els.collapseBtn].forEach(function (b) {
      b.addEventListener("click", function () {
        b.classList.remove("k-tap"); void b.offsetWidth; b.classList.add("k-tap");
        clearTimeout(b.__tapT); b.__tapT = setTimeout(function () { b.classList.remove("k-tap"); }, 700);
      });
    });

    els.dockRest = h("div", { class: "dock-rest" }, [
      h("div", { class: "sep" }),
      els.toolBtn,
      els.listBtn,
      els.stampBtn,
      h("div", { class: "sep" }),
      els.nameChip,
      els.collapseBtn,
    ]);
    dock.appendChild(els.brand);
    dock.appendChild(els.dockRest);
    root.appendChild(dock);
    els.dock = dock;

    // The bar can be dragged to any screen edge and snaps there (sides become a
    // vertical icons-only rail). A fast flick toward the snapped edge hides it,
    // leaving the peek tab on that edge to bring it back. Position resets to
    // bottom-center on every page load by design.
    els.peek = h("div", { class: "peek e-bottom", role: "button", tabindex: "0", title: "Show " + BRAND.name + " — press K", "aria-label": "Show " + BRAND.name }, [
      h("span", { class: "peek-mark", html: ICON.bubble }),
      h("span", { class: "peek-label", text: BRAND.name }),
    ]);
    root.appendChild(els.peek);
    function restoreDock() { showDock(); } // the launcher brings the whole bar back
    els.peek.addEventListener("click", restoreDock);
    els.peek.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); restoreDock(); }
    });
    on(els.peek, "touchend", function (e) {
      e.preventDefault(); // avoid the synthetic click double-firing
      restoreDock();
    }, { passive: false });

    var drag = null;
    on(els.dock, "pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === "mouse") return;
      var r = els.dock.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, t: Date.now(), gx: e.clientX - r.left, gy: e.clientY - r.top, on: false, lx: e.clientX, ly: e.clientY, lt: Date.now(), vx: 0, vy: 0 };
      // NOTE: do NOT capture the pointer here — capture retargets the eventual
      // click to the dock, which silently broke every button (logo couldn't
      // expand). Capture only once a real drag starts, below.
    });
    on(els.dock, "pointermove", function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.on && dx * dx + dy * dy < 64) return; // 8px threshold: taps stay taps
      if (!drag.on) {
        drag.on = true;
        els.dock.classList.add("dragging");
        try { els.dock.setPointerCapture(e.pointerId); } catch (err) {}
      }
      var now = Date.now(), dt = Math.max(1, now - drag.lt);
      drag.vx = (e.clientX - drag.lx) / dt; drag.vy = (e.clientY - drag.ly) / dt;
      drag.lx = e.clientX; drag.ly = e.clientY; drag.lt = now;
      var w = els.dock.offsetWidth, hgt = els.dock.offsetHeight;
      var x = Math.min(Math.max(e.clientX - drag.gx, 4), window.innerWidth - w - 4);
      var y = Math.min(Math.max(e.clientY - drag.gy, 4), window.innerHeight - hgt - 4);
      els.dock.style.left = x + "px";
      els.dock.style.top = y + "px";
      els.dock.style.right = "auto";
      els.dock.style.bottom = "auto";
      e.preventDefault();
    });
    function endDrag(e) {
      if (!drag) return;
      var was = drag; drag = null;
      if (!was.on) return; // plain tap — let the click do its thing
      els.dock.classList.remove("dragging");
      suppressDockClick = true; // the drag shouldn't also trigger the button under the finger
      setTimeout(function () { suppressDockClick = false; }, 0);
      var r = els.dock.getBoundingClientRect();
      var pvx = Math.max(-1.2, Math.min(1.2, was.vx)); // clamp: violent flicks shouldn't teleport the projection
      var pvy = Math.max(-1.2, Math.min(1.2, was.vy));
      var cx = r.left + r.width / 2 + pvx * 120; // project a little momentum
      var cy = r.top + r.height / 2 + pvy * 120;
      var d = { left: cx, right: window.innerWidth - cx, top: cy, bottom: window.innerHeight - cy };
      var edge = "bottom";
      Object.keys(d).forEach(function (k) { if (d[k] < d[edge]) edge = k; });
      var speed = Math.sqrt(was.vx * was.vx + was.vy * was.vy);
      var toward = { left: -was.vx, right: was.vx, top: -was.vy, bottom: was.vy }[edge];
      var moved = Math.abs(e.clientX - was.x) + Math.abs(e.clientY - was.y);
      function fracAlong(ed) {
        return (ed === "left" || ed === "right")
          ? (r.top + r.height / 2) / window.innerHeight
          : (r.left + r.width / 2) / window.innerWidth;
      }
      // Two ways to hide by hand: shove it out (release with the pointer at or
      // past a screen boundary) or flick it fast into the edge it lives on.
      var shovedOut = e.clientX <= 8 || e.clientY <= 8 || e.clientX >= window.innerWidth - 8 || e.clientY >= window.innerHeight - 8;
      var flicked = edge === state.edge && speed > 0.45 && toward > 0.3 && moved > 40 && Date.now() - was.t < 500;
      if (shovedOut || flicked) {
        state.edge = edge; // peek tab lands on the edge it was pushed into
        state.dockFrac = fracAlong(edge);
        applyDockPlacement();
        state.dockLevel = 0;
        applyDockLevel();
        return;
      }
      state.edge = edge;
      state.dockFrac = fracAlong(edge);
      applyDockPlacement();
      flipSnap(r); // glide from the drop point to the snapped spot
    }
    on(els.dock, "pointerup", endDrag);
    on(els.dock, "pointercancel", function () {
      if (drag && drag.on) els.dock.classList.remove("dragging");
      drag = null;
      applyDockPlacement();
    });
    on(els.dock, "click", function (e) {
      if (suppressDockClick) { e.stopPropagation(); e.preventDefault(); }
    }, true);

    // Two states only: shown or hidden. Default hidden (unless data-open) so pins stay
    // out of the way while iterating; the last choice persists so a review survives reloads.
    var pref = null;
    try { pref = localStorage.getItem("konpo:dock"); } catch (e) {}
    state.dockLevel = pref === "1" ? 2 : pref === "" ? 0 : (START_OPEN ? 2 : 0);
    state.edge = "bottom";
    if (POSITION === "bottom-right") state.dockFrac = 0.92; // honor data-position
    applyDockPlacement();
    applyDockLevel();
    refreshDock();
  }

  var suppressDockClick = false;

  // Anchor the dock (and the peek tab) to the current edge at the current
  // fraction along it. Edge classes own the transforms; we only write the
  // along-edge coordinate, so collapse/expand stays centered via transform.
  function applyDockPlacement() {
    var edge = state.edge, vert = edge === "left" || edge === "right";
    var s = els.dock.style;
    s.left = s.right = s.top = s.bottom = "";
    els.dock.classList.remove("e-bottom", "e-top", "e-left", "e-right");
    els.dock.classList.add("e-" + edge);
    els.dock.classList.toggle("vert", vert);
    var frac = Math.min(Math.max(state.dockFrac, 0.06), 0.94);
    if (vert) s.top = Math.round(frac * window.innerHeight) + "px";
    else s.left = Math.round(frac * window.innerWidth) + "px";
    if (els.peek) {
      var p = els.peek;
      p.className = "peek e-" + edge + (state.dockLevel === 0 ? " shown" : "");
      p.style.left = p.style.top = "";
      if (vert) p.style.top = Math.round(frac * window.innerHeight) + "px";
      else p.style.left = Math.round(frac * window.innerWidth) + "px";
    }
  }

  // FLIP: after re-anchoring, start from an inverse offset and let the spring
  // transition glide the dock into its snapped position.
  function flipSnap(prevRect) {
    var nr = els.dock.getBoundingClientRect();
    var dx = prevRect.left - nr.left, dy = prevRect.top - nr.top;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    var base = getComputedStyle(els.dock).transform;
    els.dock.style.transition = "none";
    els.dock.style.transform = "translate(" + dx + "px," + dy + "px)" + (base && base !== "none" ? " " + base : "");
    void els.dock.offsetWidth; // commit the start frame
    els.dock.style.transition = "";
    els.dock.style.transform = "";
  }

  function applyDockLevel() {
    var shown = state.dockLevel === 2;
    els.dock.classList.toggle("away", !shown); // hidden = slid off-screen (peek tab brings it back)
    // Pins/comments and the accent ring only show when the bar is shown, so they
    // stay out of the way while iterating.
    root.classList.toggle("notes-hidden", !shown);
    if (els.peek) els.peek.classList.toggle("shown", !shown);
    if (els.modeRing) els.modeRing.classList.toggle("shown", shown);
    if (els.brandTip) els.brandTip.classList.remove("show");
    if (!shown) {
      if (state.panelOpen) togglePanel();
      if (state.placing) togglePlacing();
      if (state.stamping) disarmStamping();
      closePopovers();
    }
    try { localStorage.setItem("konpo:dock", shown ? "1" : ""); } catch (e) {}
    if (shown) maybeShowExpandTip();
  }
  // First time the bar is shown: gently explain how to drop a comment.
  function maybeShowExpandTip() {
    var seen;
    try { seen = localStorage.getItem("konpo:seen-droptip") === "1"; } catch (e) { seen = false; }
    if (seen) return;
    try { localStorage.setItem("konpo:seen-droptip", "1"); } catch (e) {}
    setTimeout(function () {
      if (state.dockLevel !== 2 || state.placing) return;
      var msg = h("div", {}, [
        document.createTextNode("Click "),
        h("b", { text: "Comment" }),
        document.createTextNode(" or press "),
        h("span", { class: "tip-kbd", text: "C" }),
        document.createTextNode(" — then click anywhere on the page to leave a note."),
      ]);
      toast(msg, { duration: 9000 });
    }, 750);
  }
  // The bar is binary: shown (pins + tools) or hidden (off-screen, peek tab).
  function showDock() { state.dockLevel = 2; applyDockLevel(); }
  function hideDock() { state.dockLevel = 0; applyDockLevel(); }
  function toggleDock() { if (state.dockLevel === 2) hideDock(); else showDock(); } // K / logo / chevron


  function refreshDock() {
    els.toolBtn.className = "comment-btn" + (state.placing ? " active" : "");
    els.toolLabel.textContent = state.placing ? "Cancel" : "Comment";
    els.nameChip.querySelector(".nm-label").textContent = state.name || "Add your name";
    els.nameChip.className = "name-chip" + (state.name ? "" : " unset noname");
    if (els.nameAvi) els.nameAvi.innerHTML = beamSvg(state.name || "");
    if (els.listBtn) els.listBtn.className = "icon-btn" + (state.panelOpen ? " active" : "");
    if (els.stampBtn) els.stampBtn.className = "icon-btn" + (state.stamping ? " active" : "");
    refreshPanel();
  }

  /* ---------- side panel: list of comments ---------- */
  function buildPanel() {
    var brand = h("div", { class: "panel-brand" }, [
      h("span", { class: "brand-mark", html: ICON.brand }),
      h("span", { class: "pbname", text: BRAND.name }),
      h("div", { class: "spacer" }),
      h("button", { class: "icon-btn", title: "Close", html: ICON.close, onclick: togglePanel }),
    ]);
    els.segOpen = h("button", { onclick: function () { setFilter("open"); } }, [h("span", { text: "Open" }), h("span", { class: "seg-n" })]);
    els.segAll = h("button", { onclick: function () { setFilter("all"); } }, [h("span", { text: "All" }), h("span", { class: "seg-n" })]);
    els.seg = h("div", { class: "seg" }, [els.segOpen, els.segAll]);
    var head = h("div", { class: "panel-head" }, [els.seg]);
    els.panelUsers = h("div", { class: "panel-users" });
    els.panelList = h("div", { class: "panel-list" });
    els.copyAllBtn = h("button", { class: "btn", title: "One prompt with every open comment — paste it into Claude", onclick: copyAllPrompt });
    els.copyAllBtn.innerHTML = ICON.copy + "<span>Copy open comments for Claude</span>";
    var creditKids = [document.createTextNode(BRAND.creditText)];
    if (BRAND.creditName) creditKids.push(h("a", { href: BRAND.creditUrl, target: "_blank", rel: "noopener noreferrer", text: BRAND.creditName + " ↗" }));
    var credit = h("div", { class: "panel-credit" }, creditKids);
    var foot = h("div", { class: "panel-foot" }, [els.copyAllBtn, credit]);
    els.panel = h("div", { class: "surface panel" }, [brand, head, els.panelUsers, els.panelList, foot]);
    root.appendChild(els.panel);
  }

  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    els.panel.classList.toggle("open", state.panelOpen);
    if (els.listBtn) els.listBtn.className = "icon-btn" + (state.panelOpen ? " active" : "");
    refreshPanel();
  }

  function chronoMap() {
    var ranked = onPathThreads().filter(function (t) { return !isStamp(t); }).sort(function (a, b) { return a.createdAt - b.createdAt; });
    var m = {};
    ranked.forEach(function (t, i) { m[t.id] = i + 1; });
    return m;
  }
  // panel is project-wide (comments span pages); pins stay current-page. Stamps never list.
  function panelThreads() {
    return state.threads.filter(function (t) {
      if (isStamp(t)) return false;
      if (state.filter !== "all" && t.resolved) return false;
      if (state.userFilter && (t.author || "Anonymous") !== state.userFilter) return false;
      return true;
    });
  }
  // per-page chronological numbering (matches each page's pin numbers)
  function chronoMapAll() {
    var byPath = {}, m = {};
    state.threads.forEach(function (t) { if (isStamp(t)) return; var p = t.path || "/"; (byPath[p] = byPath[p] || []).push(t); });
    Object.keys(byPath).forEach(function (p) {
      byPath[p].sort(function (a, b) { return a.createdAt - b.createdAt; }).forEach(function (t, i) { m[t.id] = i + 1; });
    });
    return m;
  }

  // One avatar chip per author in the panel — tap to see only their comments.
  function refreshUserChips() {
    if (!els.panelUsers) return;
    var counts = {};
    state.threads.forEach(function (t) {
      if (isStamp(t)) return;
      var a = t.author || "Anonymous";
      counts[a] = counts[a] || { total: 0, open: 0 };
      counts[a].total++;
      if (!t.resolved) counts[a].open++;
    });
    var authors = Object.keys(counts).sort(function (a, b) { return counts[b].total - counts[a].total || (a < b ? -1 : 1); });
    // a filter for a single voice is noise — only show the row when there's a choice
    if (authors.length < 2) {
      state.userFilter = null;
      els.panelUsers.style.display = "none";
      return;
    }
    // drop a stale filter if that author's comments are gone
    if (state.userFilter && !counts[state.userFilter]) state.userFilter = null;
    els.panelUsers.style.display = "";
    clear(els.panelUsers);
    var totalComments = state.threads.filter(function (t) { return !isStamp(t); }).length;
    var all = h("button", { class: "u-chip" + (state.userFilter ? "" : " on"), onclick: function () { state.userFilter = null; refreshPanel(); } }, [
      h("span", { class: "u-all", text: "All" }),
      h("span", { class: "u-n", text: String(totalComments) }),
    ]);
    els.panelUsers.appendChild(all);
    authors.forEach(function (a) {
      var av = h("span", { class: "u-av" });
      av.innerHTML = beamSvg(a);
      var chip = h("button", { class: "u-chip" + (state.userFilter === a ? " on" : ""), title: a, onclick: function () {
        state.userFilter = state.userFilter === a ? null : a;
        refreshPanel();
      } }, [
        av,
        h("span", { class: "u-name", text: a }),
        h("span", { class: "u-n", text: String(counts[a].open) }),
      ]);
      els.panelUsers.appendChild(chip);
    });
  }

  function refreshPanel() {
    if (!state.panelOpen || !els.panelList) return;
    var comments = state.threads.filter(function (t) { return !isStamp(t); });
    var openN = comments.filter(function (t) { return !t.resolved; }).length;
    els.segOpen.querySelector(".seg-n").textContent = String(openN);
    els.segAll.querySelector(".seg-n").textContent = String(comments.length);
    els.segOpen.className = state.filter === "open" ? "on" : "";
    els.segAll.className = state.filter === "all" ? "on" : "";
    refreshUserChips();
    if (els.copyAllBtn) {
      // the copy button follows the author filter (refreshUserChips may have cleared a stale one)
      var who = state.userFilter;
      var copyN = who ? comments.filter(function (t) { return !t.resolved && (t.author || "Anonymous") === who; }).length : openN;
      els.copyAllBtn.disabled = copyN === 0;
      els.copyAllBtn.querySelector("span").textContent = who ? "Copy " + who + "’s comments for Claude" : "Copy open comments for Claude";
      els.copyAllBtn.title = who
        ? "One prompt with " + who + "’s open comments — paste it into Claude"
        : "One prompt with every open comment — paste it into Claude";
    }
    var items = panelThreads();
    var scrollTop = els.panelList.scrollTop;
    clear(els.panelList);
    if (!items.length) {
      els.panelList.appendChild(h("div", { class: "panel-empty", text: state.userFilter ? "No " + (state.filter === "all" ? "" : "open ") + "comments from " + state.userFilter + "." : state.filter === "all" ? "No comments yet." : "No open comments — press C to leave one." }));
      return;
    }
    var numById = chronoMapAll();
    // group by page so the panel calls out which page each comment lives on
    var groups = {};
    items.forEach(function (t) { var p = t.path || "/"; (groups[p] = groups[p] || []).push(t); });
    var paths = Object.keys(groups).sort(function (a, b) {
      if (a === PATH) return -1;
      if (b === PATH) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    paths.forEach(function (p) {
      els.panelList.appendChild(h("div", { class: "panel-group" }, [
        h("span", { class: "pg-path" + (p === PATH ? " pg-cur" : ""), text: p === PATH ? p + " · this page" : p }),
        h("span", { class: "pg-n", text: String(groups[p].length) }),
      ]));
      groups[p].slice().sort(function (a, b) { return a.createdAt - b.createdAt; }).forEach(function (t) {
        var pnum = h("div", { class: "pnum" });
        if (t.resolved) pnum.innerHTML = ICON.check;
        else pnum.textContent = String(numById[t.id] || "");
        var meta = (t.label ? t.label + " · " : "") + timeAgo(t.createdAt) +
          (t.replies && t.replies.length ? " · " + t.replies.length + (t.replies.length > 1 ? " replies" : " reply") : "");
        var row = h("button", {
          class: "pitem" + (t.resolved ? " res" : "") + (state.openThreadId === t.id ? " sel" : ""),
        }, [
          pnum,
          h("div", { class: "pcol" }, [
            h("div", { class: "pwho", text: t.author || "Anonymous" }),
            h("div", { class: "ptxt", text: t.body }),
            h("div", { class: "pmeta", text: meta }),
          ]),
        ]);
        row.addEventListener("click", (function (th) { return function () { gotoThread(th); }; })(t));
        els.panelList.appendChild(row);
      });
    });
    els.panelList.scrollTop = scrollTop;
  }

  // Click a list item -> restore the exact context the comment was made in:
  // navigate to its route (if elsewhere), let the host reopen any modal/tab/panel,
  // then scroll to the anchored element, place its pin, and flash a highlight.
  // Same document already? Only the URL fields differ from where we are.
  function sameView(t) {
    if (!t.url) return (t.path || "/") === PATH;
    try {
      var u = new URL(t.url, location.href);
      return u.pathname === location.pathname && u.search === location.search && u.hash === location.hash;
    } catch (e) { return (t.path || "/") === PATH; }
  }
  function gotoThread(t) {
    if (!sameView(t) && t.url) {
      // comment lives on another route — remember to open + reveal it on arrival
      try { sessionStorage.setItem("konpo:open", t.clientId || t.id); } catch (e) {}
      var reloads = true;
      try {
        var u = new URL(t.url, location.href);
        reloads = u.pathname !== location.pathname || u.search !== location.search; // hash-only won't reload
      } catch (e) {}
      window.location.href = t.url;
      if (!reloads) {
        // hash router: the document stays put, so drive the reveal ourselves
        var same = findThread(t.id) || t;
        setTimeout(function () { PATH = location.pathname; openThread(same); revealThread(same); }, 60);
      }
      return;
    }
    var cur = findThread(t.id) || t;
    openThread(cur);
    revealThread(cur);
  }

  /* ---------- generic screen convention (data-konpo-screen / data-konpo-goto) ----------
     A drop-in way for ANY app to make comments precisely locatable across screens
     with zero widget-specific JS: tag each view/tab/panel container with
     data-konpo-screen="name" and the control that opens it with data-konpo-goto="name".
     The widget records which screens a comment is nested in and, on reveal, replays
     the navigation (outer->inner) before scrolling to the element. Apps that prefer
     one function can expose window.konpoGoTo(name) instead. */
  function screenChain(el) { // names of data-konpo-screen ancestors, outermost first
    var out = [], n = el;
    while (n && n.nodeType === 1) {
      var name = n.getAttribute && n.getAttribute("data-konpo-screen");
      if (name) out.unshift(name);
      n = n.parentElement;
    }
    return out;
  }
  function screenEl(name) { try { return document.querySelector("[data-konpo-screen=" + cssAttrVal(name) + "]"); } catch (e) { return null; } }
  function screenIsVisible(name) { var el = screenEl(name); return !!(el && targetShowable(el, null)); }
  function gotoScreen(name) {
    if (typeof window.konpoGoTo === "function") { try { window.konpoGoTo(name); return true; } catch (e) {} }
    var ctrl = null;
    try { ctrl = document.querySelector("[data-konpo-goto=" + cssAttrVal(name) + "]"); } catch (e) {}
    if (ctrl && ctrl.click) { ctrl.click(); return true; }
    return false;
  }
  function waitUntil(fn, ms) {
    return new Promise(function (resolve) {
      var deadline = Date.now() + (ms || 3500);
      (function tick() { var ok = false; try { ok = fn(); } catch (e) {} if (ok || Date.now() > deadline) { resolve(); return; } setTimeout(tick, 100); })();
    });
  }

  // Reopen the UI state a comment was placed in. Webflow Tabs/Dropdowns and the
  // generic data-konpo-screen convention are handled automatically with no host
  // code; the host restoreState hook (for anything custom) runs after. Returns a
  // Promise so reveal waits for async navigation before resolving the element.
  function autoRestoreState(ui) {
    if (!ui) return;
    if (ui._wfTab) { // click the matching Webflow tab link
      var link = safeQuery(".w-tab-menu [data-w-tab=" + cssAttrVal(ui._wfTab) + "]");
      if (link && link.click && !(link.classList && link.classList.contains("w--current"))) link.click();
    }
    if (typeof ui._wfDropdown === "number" && ui._wfDropdown >= 0) { // open the Webflow dropdown
      var dd = document.querySelectorAll(".w-dropdown")[ui._wfDropdown];
      if (dd && !dd.classList.contains("w--open")) {
        var toggle = dd.querySelector(".w-dropdown-toggle");
        if (toggle && toggle.click) toggle.click();
      }
    }
    var chain = ui._scr; // navigate the data-konpo-screen chain outer -> inner
    if (!chain || !chain.length) return;
    return chain.reduce(function (p, name) {
      return p.then(function () {
        if (screenIsVisible(name)) return; // already there
        if (gotoScreen(name)) return waitUntil(function () { return screenIsVisible(name); });
      });
    }, Promise.resolve());
  }
  function restoreUiState(t) {
    if (!t) return null;
    var ui = t.uiState;
    var auto;
    try { auto = autoRestoreState(ui); } catch (e) {}
    return Promise.resolve(auto).then(function () {
      if (HOOKS.restoreState && ui) { try { return HOOKS.restoreState(ui, t); } catch (e) {} }
      return null;
    });
  }
  // Open any collapsed <details> that contains the element, so it can lay out.
  function openDetailsAncestors(el) {
    var n = el;
    while (n && n !== document.body) {
      if (n.tagName === "DETAILS" && !n.open) n.open = true;
      n = n.parentElement;
    }
  }
  function isRenderable(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0; // present but display:none (hidden tab) => wait
  }
  // Is the anchored element actually visible on the CURRENT view? Catches the three
  // ways a comment's target can be present-but-not-really-there: CSS-hidden
  // (display/visibility/opacity), zero-size, or laid out but covered by an overlay
  // / another screen (e.g. a full-screen login or modal on top of the app). The
  // occlusion test asks "is the target the top element at its own anchor point?" —
  // our own overlay/pins are filtered out, and an off-screen anchor counts as
  // visible (it's just scrolled away, the pin should still track it).
  function targetShowable(el, t) {
    if (!el) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    var ax = r.left + (t && t.relX != null ? t.relX : 0.5) * r.width;
    var ay = r.top + (t && t.relY != null ? t.relY : 0.5) * r.height;
    if (ax < 0 || ay < 0 || ax >= window.innerWidth || ay >= window.innerHeight) return true; // scrolled off-screen, not covered
    var stack = document.elementsFromPoint(ax, ay);
    for (var i = 0; i < stack.length; i++) {
      if (stack[i] === host) continue; // skip our own pins / overlay
      return stack[i] === el || el.contains(stack[i]) || stack[i].contains(el);
    }
    return true; // nothing there but us
  }
  // Poll for the anchored element — in an SPA/tab it only becomes visible after the
  // route loads and its state is restored (async render). Gives up after a few seconds.
  function resolveAnchor(t, cb) {
    if (!t || !t.selector) { cb(null); return; }
    var deadline = Date.now() + 4000;
    (function tick() {
      var el = safeQuery(t.selector);
      if (el) openDetailsAncestors(el); // reveal <details> so the hidden target can lay out
      if (el && targetShowable(el, t)) { cb(el); return; }
      if (Date.now() > deadline) { cb(null); return; }
      setTimeout(tick, 120);
    })();
  }
  // Restore context -> resolve element -> scroll, re-anchor the pin, highlight.
  function revealThread(t) {
    if (!t) return;
    Promise.resolve(restoreUiState(t)).then(function () {
      resolveAnchor(t, function (el) {
        if (el) {
          if (el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
          // after the smooth scroll settles: re-lay the pin on the element + flash it
          setTimeout(function () { layout(); flashHighlight(el); }, 420);
        } else {
          // The target isn't visible on the current view — it's on another screen /
          // behind an overlay, or was removed. Don't jump to a stale position over an
          // unrelated screen; tell the user where it lives (the thread still opens so
          // they can read it, and its pin reappears when that view is shown).
          toast("This comment was left on another screen — open that view to see it in place.", { duration: 4000 });
        }
      });
    });
  }

  // open a thread requested from another page (after cross-page navigation)
  function openPending() {
    var key = null;
    try { key = sessionStorage.getItem("konpo:open"); } catch (e) {}
    if (!key) return;
    var t = null;
    for (var i = 0; i < state.threads.length; i++) {
      if (state.threads[i].id === key || state.threads[i].clientId === key) { t = state.threads[i]; break; }
    }
    if (!t) return;
    try { sessionStorage.removeItem("konpo:open"); } catch (e) {}
    if (state.dockLevel !== 2) showDock(); // arriving at a jumped-to comment shows the bar + pins
    state.navAt = { path: t.path || "/", createdAt: t.createdAt }; // keep arrow-nav position across the jump
    openThread(t);
    revealThread(t); // restore host UI state, wait for the element, scroll + highlight
  }

  /* ---------- arrow-key navigation: jump between open comments (across pages) ----------
     Always available while the bar is shown — no separate mode. Stable global order
     (path, then creation time); position is tracked by (path, createdAt) so resolving
     the current comment doesn't lose your place. */
  function navCmp(a, b) {
    var pa = a.path || "/", pb = b.path || "/";
    if (pa !== pb) return pa < pb ? -1 : 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  }
  function navList() {
    return state.threads.filter(function (t) { return !isStamp(t) && !t.resolved; }).sort(navCmp);
  }
  function navStep(delta) {
    var list = navList();
    if (!list.length) { toast("No open comments to jump to.", { duration: 1800 }); return; }
    var cur = findOpenThread();
    var ref = (cur && !cur.resolved) ? cur : state.navAt;
    var t = null, i;
    if (!ref) {
      // no reference yet: start on the open thread, else first on this page, else first overall
      if (cur && !cur.resolved) t = cur;
      if (!t) for (i = 0; i < list.length; i++) if ((list[i].path || "/") === PATH) { t = list[i]; break; }
      t = t || list[0];
    } else if (delta > 0) {
      for (i = 0; i < list.length; i++) if (navCmp(list[i], ref) > 0) { t = list[i]; break; }
      t = t || list[0]; // wrap
    } else {
      for (i = list.length - 1; i >= 0; i--) if (navCmp(list[i], ref) < 0) { t = list[i]; break; }
      t = t || list[list.length - 1]; // wrap
    }
    state.navAt = { path: t.path || "/", createdAt: t.createdAt };
    var pos = 1;
    for (i = 0; i < list.length; i++) if (list[i].id === t.id) { pos = i + 1; break; }
    gotoThread(t); // navigates cross-page (the bar is re-shown on arrival)
    if ((t.path || "/") === PATH) toast(pos + " of " + list.length + " open · ←/→ to move", { duration: 2000 });
  }

  /* ---------- name ---------- */
  function ensureName(cb) {
    if (state.name) return cb();
    askName(cb);
  }
  function askName(cb) {
    closePopovers();
    // Distinct identity step — deliberately NOT styled like the comment composer,
    // so people don't mistake it for the comment box and type their note here.
    var avatar = h("div", { class: "name-avatar" });
    avatar.innerHTML = beamSvg(state.name || "");
    var input = h("input", { class: "field name-input", type: "text", placeholder: "Type your name…", value: state.name || "", maxlength: "40" });
    input.addEventListener("input", function () {
      var v = input.value.trim();
      avatar.innerHTML = beamSvg(v || "");
      // mirror live in the dock chip: the dark avatar gains color as you type
      if (els.nameAvi) {
        els.nameAvi.innerHTML = beamSvg(v || "");
        els.nameChip.classList.toggle("noname", !v);
        els.nameChip.classList.toggle("unset", !v);
      }
    });
    var save = h("button", { class: "btn btn-kc", onclick: function () {
      var v = input.value.trim();
      if (!v) { input.focus(); return; }
      state.name = v;
      localStorage.setItem("konpo:name", v);
      refreshDock();
      closePopovers();
      if (typeof cb === "function") cb();
    } }, [
      document.createTextNode(cb ? "Start commenting" : "Save name"),
      h("span", { class: "kc", text: "↵" }),
    ]);
    var pop = h("div", { class: "surface pop name-pop" }, [
      h("div", { class: "name-card" }, [
        h("div", { class: "name-head" }, [
          avatar,
          h("div", {}, [
            h("div", { class: "name-title", text: "Who’s leaving notes?" }),
            h("div", { class: "name-sub", text: "No login — your name just tags the comments you leave, so people know who’s who." }),
          ]),
        ]),
        input,
        save,
      ]),
    ]);
    pop.style.left = "50%";
    pop.style.bottom = "74px";
    pop.style.top = "auto";
    pop.style.transform = "translateX(-50%)";
    root.appendChild(pop);
    pop.style.visibility = "visible";
    els.popover = pop;
    input.focus();
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") save.click();
      if (e.key === "Escape") closePopovers();
    });
  }

  /* ---------- placing comments ---------- */
  function togglePlacing() {
    // Get the name out of the way BEFORE placing, so the identity step isn't
    // interleaved with picking an element (which is what made it feel like a comment).
    if (!state.placing && !state.name) {
      askName(function () { if (!state.placing) togglePlacing(); });
      return;
    }
    // Arming the tool implies showing the bar so pins are visible.
    if (!state.placing && state.dockLevel !== 2) showDock();
    if (!state.placing && state.stamping) disarmStamping(); // comments & stamps are exclusive
    state.placing = !state.placing;
    root.classList.toggle("placing", state.placing);
    els.highlight.style.display = "none";
    refreshDock();
    if (!state.placing) closePopovers();
  }

  function isOurNode(node) {
    return node === host || (node && node.getRootNode && node.getRootNode() === shadow);
  }

  function targetUnder(x, y) {
    var prev = root.style.pointerEvents;
    root.style.pointerEvents = "none";
    var el = document.elementFromPoint(x, y);
    root.style.pointerEvents = prev;
    if (!el || isOurNode(el) || el === document.documentElement) return null;
    return el;
  }

  function onMoveWhilePlacing(e) {
    if (!state.placing) return;
    var el = targetUnder(e.clientX, e.clientY);
    if (!el) { els.highlight.style.display = "none"; return; }
    var r = el.getBoundingClientRect();
    var off = layerOffset();
    var s = els.highlight.style;
    s.display = "block";
    s.left = r.left - off.x + "px";
    s.top = r.top - off.y + "px";
    s.width = r.width + "px";
    s.height = r.height + "px";
  }

  // Host-supplied context captured with each comment so it can be reconstructed
  // on click. Both are optional and degrade to "" / null when no hook is wired.
  function currentScreenId() {
    if (HOOKS.screenId) {
      try { var s = HOOKS.screenId(); if (s != null && s !== "") return String(s); } catch (e) {}
    }
    var b = document.body;
    if (b && b.getAttribute && b.getAttribute("data-screen")) return b.getAttribute("data-screen");
    return "";
  }
  // Built-in capture of common, class-based UI state so context restores with ZERO
  // per-element markup on the host page (Webflow Tabs & Dropdowns out of the box;
  // native <details> is handled at reveal time). A host captureState hook merges on top.
  function wfDropdownIndex(dd) {
    var all = document.querySelectorAll(".w-dropdown");
    for (var i = 0; i < all.length; i++) if (all[i] === dd) return i;
    return -1;
  }
  function autoCaptureState(el) {
    if (!el || !el.closest) return null;
    var s = null;
    var pane = el.closest(".w-tab-pane"); // Webflow Tabs
    if (pane && pane.getAttribute("data-w-tab")) (s = s || {})._wfTab = pane.getAttribute("data-w-tab");
    var dd = el.closest(".w-dropdown");    // Webflow Dropdown
    if (dd) { var i = wfDropdownIndex(dd); if (i >= 0) (s = s || {})._wfDropdown = i; }
    var chain = screenChain(el);           // generic data-konpo-screen convention
    if (chain.length) (s = s || {})._scr = chain;
    return s;
  }
  function captureUiState(el) {
    var s = autoCaptureState(el);
    if (HOOKS.captureState) {
      try {
        var hostS = HOOKS.captureState(el);
        if (hostS && typeof hostS === "object") s = Object.assign(s || {}, hostS);
      } catch (e) {}
    }
    if (!s) return null;
    try {
      var json = JSON.stringify(s); // JSON-clean + size-guard (server enforces too)
      return json && json.length <= 4000 ? JSON.parse(json) : null;
    } catch (e) { return null; }
  }

  // The persisted anchor for a click over an element — shared by comments and stamps.
  function anchorFrom(el, cx, cy) {
    var r = el.getBoundingClientRect();
    return {
      selector: cssPath(el),
      label: labelFor(el),
      relX: clamp01(r.width ? (cx - r.left) / r.width : 0.5),
      relY: clamp01(r.height ? (cy - r.top) / r.height : 0.5),
      pageX: cx + window.scrollX,
      pageY: cy + window.scrollY,
      scrollX: window.scrollX,   // where the page was scrolled when placed
      scrollY: window.scrollY,
      screenId: currentScreenId(),
      uiState: captureUiState(el), // host's tab/modal/panel state (if any)
    };
  }

  function onClickWhilePlacing(e) {
    if (!state.placing) return;
    var el = targetUnder(e.clientX, e.clientY);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    var anchor = anchorFrom(el, e.clientX, e.clientY);
    togglePlacing(); // disarm after one placement (Figma-like)
    openComposer(anchor);
  }

  /* ---------- stamps: pick a sticker, then click the page to drop it (repeatable) ---------- */
  function toggleStampPicker() {
    if (state.stamping) { disarmStamping(); return; } // armed -> turn off
    if (els.popover && els.popover.__stampPicker) { closePopovers(); return; }
    openStampPicker();
  }
  function openStampPicker() {
    closePopovers();
    if (state.placing) togglePlacing();      // comments and stamps are mutually exclusive
    if (state.dockLevel !== 2) showDock();
    var grid = h("div", { class: "stamp-grid" });
    STAMPS.forEach(function (ch) {
      var btn = h("button", { title: "Stamp " + ch, "data-ch": ch, onclick: function () { armStamp(ch); } });
      if (ch === "+1") btn.appendChild(h("span", { class: "plus-chip", text: "+1" }));
      else btn.textContent = ch;
      grid.appendChild(btn);
    });
    var pop = h("div", { class: "surface pop stamp-pop" }, [grid]);
    pop.__stampPicker = true;
    root.appendChild(pop);
    els.popover = pop;
    // Centered directly above the emoji button; springs up from the button (CSS animation).
    var br = els.stampBtn.getBoundingClientRect(), off = layerOffset();
    var w = pop.offsetWidth || 236, hgt = pop.offsetHeight || 120, pad = 8;
    var cx = br.left + br.width / 2;
    var x = Math.max(pad, Math.min(cx - w / 2, window.innerWidth - w - pad));
    var y = Math.max(pad, br.top - hgt - 10);
    pop.style.left = (x - off.x) + "px";
    pop.style.top = (y - off.y) + "px";
    pop.style.setProperty("--pop-origin-x", (cx - x) + "px");
    pop.style.visibility = "visible";
  }
  var stampHold = null;            // { el, x, y, scale, t0, raf } while a sticker is held to grow
  var STAMP_MAX = 5, STAMP_RATE = 1.4; // grows STAMP_RATE× per second, capped at STAMP_MAX
  function armStamp(ch) {
    state.stampChar = ch;
    state.stamping = true;
    root.classList.add("stamping");
    els.stampPreview.className = "stamp-preview" + (ch === "+1" ? " plus" : "");
    els.stampPreview.textContent = ch === "+1" ? "" : ch;
    els.stampPreview.style.display = "none"; // appears on first move over the page
    if (els.popover && els.popover.__stampPicker) closePopovers(); // clear the page for stamping
    refreshDock();
  }
  function disarmStamping() {
    endStampHold(true);
    state.stamping = false;
    state.stampChar = "";
    root.classList.remove("stamping");
    els.stampPreview.style.display = "none";
    if (els.popover && els.popover.__stampPicker) closePopovers();
    refreshDock();
  }
  function positionPreview(x, y, scale, shake) {
    var off = layerOffset(), s = els.stampPreview.style, sk = shake || { dx: 0, dy: 0, r: 0 };
    s.display = "block";
    s.left = (x - off.x) + "px";
    s.top = (y - off.y) + "px";
    s.transform = "translate(-50%,-50%) translate(" + sk.dx + "px," + sk.dy + "px) rotate(" + sk.r + "deg) scale(" + (scale || 1) + ")";
  }
  function onMoveWhileStamping(e) {
    if (!state.stamping || stampHold) return; // while holding, the sticker grows in place
    positionPreview(e.clientX, e.clientY, 1);
  }
  // Hold to grow: press and hold on the page — the sticker shakes and grows the longer you
  // hold; release to drop it at that size. A quick tap drops the default size.
  function onStampDown(e) {
    if (!state.stamping) return;
    if (e.button !== undefined && e.button !== 0 && e.pointerType === "mouse") return;
    var el = targetUnder(e.clientX, e.clientY);
    if (!el) return; // over our own UI (dock/picker) — ignore
    e.preventDefault();
    e.stopPropagation();
    stampHold = { el: el, x: e.clientX, y: e.clientY, scale: 1, t0: Date.now(), raf: 0 };
    (function grow() {
      if (!stampHold) return;
      var held = (Date.now() - stampHold.t0) / 1000;
      stampHold.scale = Math.min(STAMP_MAX, 1 + held * STAMP_RATE);
      var amp = 1 + stampHold.scale * 0.9; // shakes harder as it grows
      positionPreview(stampHold.x, stampHold.y, stampHold.scale, {
        dx: (Math.random() - 0.5) * amp, dy: (Math.random() - 0.5) * amp, r: (Math.random() - 0.5) * amp * 0.8,
      });
      stampHold.raf = requestAnimationFrame(grow);
    })();
  }
  function onStampUp() {
    if (!stampHold) return;
    var hld = stampHold;
    endStampHold(true);
    createStamp(anchorFrom(hld.el, hld.x, hld.y), state.stampChar, hld.scale); // stays armed for rapid stamping
  }
  function endStampHold(resetPreview) {
    if (!stampHold) return;
    if (stampHold.raf) cancelAnimationFrame(stampHold.raf);
    stampHold = null;
    if (resetPreview) { els.stampPreview.style.display = "none"; els.stampPreview.style.transform = ""; }
  }
  function createStamp(anchor, ch, scale) {
    if (!ch) return;
    scale = Math.max(1, Math.min(STAMP_MAX, scale || 1));
    var clientId = "c_" + rand();
    var temp = {
      id: "tmp_" + rand(), clientId: clientId, project: PROJECT, path: PATH, url: location.href,
      kind: "stamp", stamp: ch, scale: scale,
      selector: anchor.selector, label: anchor.label, relX: anchor.relX, relY: anchor.relY,
      pageX: anchor.pageX, pageY: anchor.pageY, scrollX: anchor.scrollX, scrollY: anchor.scrollY,
      screenId: anchor.screenId, uiState: anchor.uiState,
      author: state.name || "Anonymous", createdAt: Date.now(), _pending: true, _createdLocally: Date.now(),
    };
    state.threads.push(temp);
    persistCache();
    updatePins();
    api("POST", {
      project: PROJECT, clientId: clientId, path: PATH, url: location.href, kind: "stamp", stamp: ch, scale: scale,
      selector: anchor.selector, label: anchor.label, relX: anchor.relX, relY: anchor.relY,
      pageX: anchor.pageX, pageY: anchor.pageY, scrollX: anchor.scrollX, scrollY: anchor.scrollY,
      screenId: anchor.screenId, uiState: anchor.uiState, author: state.name || "Anonymous",
    }).then(function (res) {
      if (!res || !res.thread) return;
      Object.assign(temp, res.thread); temp._pending = false;
      persistCache(); updatePins();
    }).catch(function () { toast("Stamp saved locally — couldn't reach the server.", { duration: 2500 }); });
  }
  /* ---------- screenshot + environment capture ----------
     When a comment is placed we grab a DOM snapshot (html2canvas, lazily loaded
     from a CDN) plus the browser/OS/screen facts, so every comment carries the
     context a developer needs — no more chasing versions and resolutions. Capture
     kicks off while the composer is open, hidden behind the time spent typing; on
     submit the image is uploaded to Blob and the comment is patched with its URL.
     Every step degrades to a no-op: a failed library load, capture, or upload
     never blocks the comment, and if Blob isn't configured the shot still previews
     for the author this session via an in-memory data URL. */
  var localShots = {};                 // id -> data URL, in-memory only (never persisted / uploaded)
  var _h2cPromise = null;
  var H2C_SRC = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
  function loadHtml2canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (_h2cPromise) return _h2cPromise;
    _h2cPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = H2C_SRC; s.async = true;
      s.onload = function () { window.html2canvas ? resolve(window.html2canvas) : reject(new Error("no html2canvas")); };
      s.onerror = function () { _h2cPromise = null; reject(new Error("html2canvas load failed")); };
      (document.head || document.documentElement).appendChild(s);
    });
    return _h2cPromise;
  }

  function envDetails() {
    var ua = navigator.userAgent || "", m;
    var browser =
      (m = ua.match(/Edg\/(\d+)/)) ? "Edge " + m[1] :
      (m = ua.match(/OPR\/(\d+)/)) ? "Opera " + m[1] :
      (/Chrome\/(\d+)/.test(ua) && !/Chromium/.test(ua)) ? "Chrome " + ua.match(/Chrome\/(\d+)/)[1] :
      (m = ua.match(/Firefox\/(\d+)/)) ? "Firefox " + m[1] :
      (/Version\/(\d+).*Safari/.test(ua)) ? "Safari " + ua.match(/Version\/(\d+)/)[1] :
      "Unknown";
    var os =
      /Windows NT 10/.test(ua) ? "Windows 10/11" :
      /Windows/.test(ua) ? "Windows" :
      /Mac OS X/.test(ua) ? "macOS" :
      /Android/.test(ua) ? "Android" :
      /(iPhone|iPad|iPod)/.test(ua) ? "iOS" :
      /Linux/.test(ua) ? "Linux" : "Unknown";
    return {
      browser: browser, os: os,
      screen: (screen.width || 0) + " × " + (screen.height || 0) + " px",
      viewport: window.innerWidth + " × " + window.innerHeight + " px",
      dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
      colorDepth: (screen.colorDepth || 24) + " bit",
      ua: ua.slice(0, 400),
    };
  }

  // Capture the current viewport as a downscaled JPEG data URL. Resolves null on any failure.
  function captureViewport() {
    return loadHtml2canvas().then(function (html2canvas) {
      var bg = "";
      try { bg = getComputedStyle(document.body).backgroundColor; } catch (e) {}
      if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") bg = "#ffffff";
      return html2canvas(document.body, {
        backgroundColor: bg,
        scale: Math.min(window.devicePixelRatio || 1, 2),
        useCORS: true,
        logging: false,
        ignoreElements: function (el) { return el === host; }, // never shoot our own overlay
        x: window.scrollX, y: window.scrollY,
        width: window.innerWidth, height: window.innerHeight,
        windowWidth: document.documentElement.scrollWidth,
        windowHeight: document.documentElement.scrollHeight,
      });
    }).then(function (canvas) {
      var MAXW = 1600, w = canvas.width, ht = canvas.height, out = canvas;
      if (w > MAXW) {
        var k = MAXW / w;
        out = document.createElement("canvas");
        out.width = Math.round(w * k); out.height = Math.round(ht * k);
        out.getContext("2d").drawImage(canvas, 0, 0, out.width, out.height);
      }
      return { dataUrl: out.toDataURL("image/jpeg", 0.82), w: out.width, h: out.height };
    }).catch(function () { return null; });
  }

  // Upload a captured shot to Blob (via the server). Resolves the public URL, or
  // null when Blob isn't configured / the upload fails.
  function uploadShot(id, shot) {
    if (!shot || !shot.dataUrl) return Promise.resolve(null);
    return fetch(ENDPOINT + "/api/screenshot", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: PROJECT, id: id, img: shot.dataUrl }),
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (res) { return res && res.url ? res.url : null; })
      .catch(function () { return null; });
  }

  // After the thread has a real id: await the capture, upload it, and patch the URL in.
  function finalizeShot(thread, cap) {
    if (!cap || !cap.capturePromise) { thread._shotPending = false; rerenderOpen(); return; }
    cap.capturePromise.then(function (shot) {
      if (!shot) { thread._shotPending = false; rerenderOpen(); return; }
      thread.shotW = shot.w; thread.shotH = shot.h;
      return uploadShot(thread.id, shot).then(function (url) {
        thread._shotPending = false;
        if (url) {
          thread.shot = url;
          persistCache();
          api("PATCH", { project: PROJECT, id: thread.id, shot: url, shotW: shot.w, shotH: shot.h }).catch(function () {});
        } else {
          localShots[thread.id] = shot.dataUrl; // Blob off / upload failed: preview locally this session
        }
        rerenderOpen(); updatePins();
      });
    }).catch(function () { thread._shotPending = false; rerenderOpen(); });
  }

  function shortUrl(u) { return String(u || "").replace(/^https?:\/\//, "").replace(/\/$/, ""); }

  function openLightbox(src) {
    var img = h("img", { src: src, alt: "Screenshot" });
    var closeBtn = h("button", { class: "lb-close", title: "Close", html: ICON.close });
    var box = h("div", { class: "lightbox" }, [img, closeBtn]);
    function close() { if (box.parentNode) box.parentNode.removeChild(box); document.removeEventListener("keydown", onKey, true); }
    function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); close(); } }
    box.addEventListener("click", function (e) { if (e.target === box || e.target === closeBtn) close(); });
    img.addEventListener("click", function (e) { e.stopPropagation(); });
    document.addEventListener("keydown", onKey, true);
    root.appendChild(box);
  }

  function openComposer(anchor) {
    closePopovers();
    var capturePromise = captureViewport(); // starts now; latency hides behind typing
    var env = envDetails();
    ensureName(function () {
      var ta = h("textarea", { class: "field", placeholder: "Be specific and clear, so we don't have to ask you to clarify later", rows: "2" });
      var submit = h("button", {
        class: "btn btn-kc",
        onclick: function () {
          var v = ta.value.trim();
          if (!v) return;
          createThread(anchor, v, { capturePromise: capturePromise, env: env });
          closePopovers();
        },
      }, [
        document.createTextNode("Comment"),
        h("span", { class: "kc", text: "↵" }),
      ]);
      var pop = h("div", { class: "surface pop" }, [
        h("div", { class: "composer" }, [
          h("div", { class: "target-chip", text: anchor.label }),
          ta,
          h("div", { class: "row" }, [
            h("button", { class: "btn-ghost", text: "Cancel", onclick: closePopovers }),
            h("div", { class: "spacer" }),
            submit,
          ]),
        ]),
      ]);
      root.appendChild(pop);
      els.popover = pop;
      state.composer = { pop: pop, anchor: anchor };
      positionPopover(pop, anchorViewport(anchor));
      ta.focus();
      ta.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit.click(); }
        if (e.key === "Escape") closePopovers();
      });
    });
  }

  function anchorViewport(anchor) {
    return { x: anchor.pageX - window.scrollX, y: anchor.pageY - window.scrollY };
  }

  /* ---------- thread popover ----------
     The reply box (foot) is built ONCE and never destroyed, so in-progress reply
     text and focus survive the 5s poll, resolves, and re-renders. Only the body
     region (comment + replies + actions) is rebuilt. */
  function openThread(thread) {
    closePopovers();
    state.openThreadId = thread.id;
    state.openClientId = thread.clientId || null;

    var pop = h("div", { class: "surface pop" });
    var bodyRegion = h("div");

    var rta = h("textarea", { class: "field", placeholder: "Reply…", rows: "1" });
    function doReply() {
      var v = rta.value.trim();
      if (!v) return;
      var t = findOpenThread();
      if (!t) return;
      addReply(t, v);
      rta.value = "";
    }
    var send = h("button", { class: "btn send", html: ICON.send, onclick: doReply });
    rta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doReply(); }
      if (e.key === "Escape") closePopovers();
    });
    var foot = h("div", { class: "pop-foot" }, [rta, send]);

    function renderBody() {
      var t = findOpenThread();
      if (!t) { closePopovers(); return; }
      clear(bodyRegion);
      bodyRegion.appendChild(commentBlock(t, true));
      if (t.label) bodyRegion.appendChild(h("div", { class: "target-chip", text: t.label }));
      appendShotAndInfo(bodyRegion, t);
      if (t.replies && t.replies.length) {
        var rl = h("div", { class: "replies" });
        t.replies.forEach(function (r) { rl.appendChild(h("div", { class: "reply" }, [commentBlock(r, false)])); });
        bodyRegion.appendChild(rl);
      }
      var resolveBtn = h("button", {
        class: "btn-ghost resolve",
        html: (t.resolved ? ICON.reopen : ICON.check) + "<span style='margin-left:6px'>" + (t.resolved ? "Reopen" : "Resolve") + "</span>",
        onclick: function () { toggleResolve(findOpenThread()); },
      });
      var copyBtn = h("button", { class: "btn-ghost", title: "Copy this feedback as a Claude Code prompt", html: ICON.copy + "<span style='margin-left:6px'>Copy for Claude</span>", onclick: function () { copyPrompt(findOpenThread()); } });
      var sendBtn = h("button", { class: "btn-ghost", title: "Send this comment to Claude — files a GitHub issue Claude can act on", html: ICON.send + "<span style='margin-left:6px'>Send to Claude</span>", onclick: function () { sendToClaude(findOpenThread()); } });
      var delBtn = h("button", { class: "btn-ghost danger", title: "Delete this comment", html: ICON.trash + "<span style='margin-left:6px'>Delete</span>", onclick: function () { deleteThread(findOpenThread()); } });
      bodyRegion.appendChild(h("div", { class: "actions" }, [resolveBtn, copyBtn, sendBtn, delBtn]));
    }
    pop._rerender = renderBody;

    renderBody();
    pop.appendChild(bodyRegion);
    pop.appendChild(foot);
    root.appendChild(pop);
    els.popover = pop;

    var pinEl = pinEls[thread.id];
    var pr = pinEl && getComputedStyle(pinEl).display !== "none" ? pinEl.getBoundingClientRect() : null;
    // when the pin is hidden (target not on this view), anchor the popover to the
    // viewport centre instead of the top-left corner its 0×0 rect would give
    var rect = (pr && (pr.width || pr.height)) ? pr : { left: window.innerWidth / 2, top: window.innerHeight / 2 };
    positionPopover(pop, { x: rect.left, y: rect.top });
    updatePins();
  }

  function rerenderOpen() {
    if (els.popover && els.popover._rerender) els.popover._rerender();
  }

  function commentBlock(item, isHead) {
    var head = h("div", { class: "pop-head" }, [
      avatarEl(item.author),
      h("div", { class: "who" }, [
        h("div", { class: "nm", text: item.author || "Anonymous" }),
        h("div", { class: "tm", text: timeAgo(item.createdAt) }),
      ]),
      isHead ? h("button", { class: "btn-ghost", title: "Close", html: ICON.close, onclick: closePopovers }) : null,
    ]);
    return h("div", {}, [head, h("div", { class: "body-txt", text: item.body })]);
  }

  function avatarEl(name) {
    var a = h("div", { class: "avatar", title: name || "Anonymous" });
    a.innerHTML = beamSvg(name || ""); // boring-avatars "beam", generated inline
    return a;
  }

  // Screenshot thumbnail (click to expand) + the auto-captured environment details,
  // rendered under the comment. Any part is skipped when its data is absent.
  function appendShotAndInfo(container, t) {
    var shotUrl = t.shot || localShots[t.id] || "";
    if (t._shotPending && !shotUrl) {
      container.appendChild(h("div", { class: "shot-sec" }, [
        h("div", { class: "sec-label", text: "Screenshot" }),
        h("div", { class: "shot-cap" }, [h("span", { class: "spin" }), h("span", { text: "Capturing screenshot…" })]),
      ]));
    } else if (shotUrl) {
      var thumb = h("button", { class: "shot-thumb", title: "Click to expand", onclick: function () { openLightbox(shotUrl); } }, [
        h("img", { src: shotUrl, alt: "Screenshot", loading: "lazy" }),
        h("span", { class: "shot-zoom", html: ICON.expand }),
        h("span", { class: "shot-badge", html: ICON.camera + "<span>Screenshot</span>" }),
      ]);
      container.appendChild(h("div", { class: "shot-sec" }, [
        h("div", { class: "sec-label", text: "Screenshot" }),
        thumb,
      ]));
    }

    var m = t.meta;
    if (!m && !t.url && !t.selector) return;
    var grid = h("dl", { class: "info-grid" });
    function row(k, v, mono) {
      if (v == null || v === "") return;
      grid.appendChild(h("dt", { text: k }));
      grid.appendChild(h("dd", mono ? { class: "mono" } : {}, [typeof v === "string" || typeof v === "number" ? document.createTextNode(String(v)) : v]));
    }
    if (t.url) row("Logged at", h("a", { href: t.url, target: "_blank", rel: "noopener noreferrer", text: shortUrl(t.url) }));
    if (m) { row("Operating system", m.os); row("Browser", m.browser); }
    if (t.selector) row("Selector", t.selector, true);
    if (m) {
      row("Resolution", m.screen);
      row("Browser window", m.viewport);
      if (m.dpr) row("Pixel ratio", m.dpr + "×");
      row("Color depth", m.colorDepth);
    }
    var sec = h("div", { class: "info-sec collapsed" });
    var toggle = h("span", { class: "info-toggle", text: "Show details" });
    var head = h("div", {
      class: "info-head",
      onclick: function () { toggle.textContent = sec.classList.toggle("collapsed") ? "Show details" : "Hide details"; },
    }, [h("div", { class: "sec-label", text: "Additional info" }), toggle]);
    sec.appendChild(head);
    sec.appendChild(grid);
    container.appendChild(sec);
  }

  /* ---------- popover positioning (never detaches the node) ---------- */
  function positionPopover(pop, at) {
    var off = layerOffset();
    var w = pop.offsetWidth || 300;
    var hgt = pop.offsetHeight || 200;
    var pad = 12;
    var x = at.x + 16, y = at.y;
    if (x + w > window.innerWidth - pad) x = at.x - w - 16;
    if (x < pad) x = pad;
    if (y + hgt > window.innerHeight - pad) y = window.innerHeight - hgt - pad;
    if (y < pad) y = pad;
    pop.style.left = x - off.x + "px";
    pop.style.top = y - off.y + "px";
    pop.style.visibility = "visible";
  }

  function closePopovers() {
    if (els.popover && els.popover.parentNode) els.popover.parentNode.removeChild(els.popover);
    els.popover = null;
    state.composer = null;
    if (state.openThreadId || state.openClientId) {
      state.openThreadId = null;
      state.openClientId = null;
      updatePins();
    }
  }

  /* ---------- pins ---------- */
  function isStamp(t) { return !!(t && t.kind === "stamp"); }
  // A small, stable tilt for each dropped sticker, derived from its id so it
  // stays put across re-renders/polls. Ranges roughly -9°..+9°.
  function stampRot(id) {
    var h = 0, s = String(id || "");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (((h % 19) + 19) % 19) - 9; // integer degrees in [-9, 9]
  }
  function onPathThreads() {
    return state.threads.filter(function (t) {
      return t.path === PATH || (!t.path && PATH === "/");
    });
  }
  function visibleThreads() { // comments on this page, respecting the open/all filter
    return onPathThreads().filter(function (t) {
      return !isStamp(t) && (state.filter === "all" ? true : !t.resolved);
    });
  }
  function pathStamps() { return onPathThreads().filter(isStamp); } // stamps always show

  function updatePins() {
    var vis = visibleThreads();
    var stamps = pathStamps();
    var numById = chronoMap();
    var keep = {};
    vis.forEach(function (t) {
      keep[t.id] = true;
      var pin = pinEls[t.id];
      if (!pin) {
        pin = h("button", { class: "pin" }, [h("span", { class: "bubble" })]);
        pin.addEventListener("click", function (e) {
          e.stopPropagation();
          var cur = findThread(t.id) || t;
          openThread(cur);
        });
        pinEls[t.id] = pin;
        els.pinLayer.appendChild(pin);
      }
      var bubble = pin.querySelector(".bubble");
      if (t.resolved) bubble.innerHTML = ICON.check;
      else bubble.textContent = String(numById[t.id] || "");
      pin.className = "pin" + (t.resolved ? " resolved" : "") + (state.openThreadId === t.id ? " sel" : "");
      // easter egg: tint each open pin by its number along the warm scale
      if (EGG) bubble.style.background = t.resolved ? "" : EGG_SCALE[((numById[t.id] || 1) - 1) % EGG_SCALE.length];
    });
    stamps.forEach(function (t) {
      keep[t.id] = true;
      var el = pinEls[t.id];
      if (!el) {
        // div (not button) so the remove control below can be a real nested button
        el = h("div", { class: "stamp" });
        el._em = h("span", { class: "stamp-em" }); // holds the emoji; kept separate so the x survives re-renders
        var rm = h("button", { class: "stamp-x", title: "Remove sticker", "aria-label": "Remove sticker", html: ICON.close });
        rm.addEventListener("click", function (e) {
          e.stopPropagation();
          e.preventDefault();
          deleteThread(findThread(t.id) || t);
        });
        el.appendChild(el._em);
        el.appendChild(rm);
        pinEls[t.id] = el;
        els.pinLayer.appendChild(el);
      }
      var ch = t.stamp || "";
      el.className = "stamp" + (ch === "+1" ? " plus" : "");
      el._em.textContent = ch === "+1" ? "" : ch;
      el.style.setProperty("--s", t.scale || 1); // hold-to-grow size
      el.style.setProperty("--r", stampRot(t.id) + "deg"); // slight per-sticker tilt, stable across re-renders
    });
    Object.keys(pinEls).forEach(function (id) {
      if (!keep[id]) {
        if (pinEls[id].parentNode) pinEls[id].parentNode.removeChild(pinEls[id]);
        delete pinEls[id];
      }
    });
    layout();
    refreshPanel();
  }

  function layout() {
    var off = layerOffset();
    Object.keys(pinEls).forEach(function (id) {
      var t = findThread(id);
      if (!t) return;
      var pin = pinEls[id];
      var el = t.selector ? safeQuery(t.selector) : null;
      // Only show a pin when its target is genuinely visible on the CURRENT view.
      // Not found, CSS-hidden, zero-size, or covered by an overlay / another screen
      // (e.g. a login page on top of the app) -> hide it rather than float it at a
      // stale saved position over an unrelated screen. It stays in the list + count
      // and reappears in place when its own view is shown (scroll/resize/observer/poll
      // all re-run layout).
      if (!el || !targetShowable(el, t)) { pin.style.display = "none"; return; }
      pin.style.display = "";
      pin.classList.remove("orphan");
      maybeReanchor(t, el); // upgrade a legacy/brittle selector to the robust form
      var r = el.getBoundingClientRect();
      var x = r.left + (t.relX || 0) * r.width;
      var y = r.top + (t.relY || 0) * r.height;
      pin.style.left = x - off.x + "px";
      pin.style.top = y - off.y + "px";
    });
    // keep the open thread popover glued to its pin (reposition only — no detach)
    var open = findOpenThread();
    if (open && els.popover && pinEls[open.id]) {
      var pr = pinEls[open.id].getBoundingClientRect();
      positionPopover(els.popover, { x: pr.left, y: pr.top });
    }
    // keep the composer glued to its anchor point
    if (state.composer && state.composer.pop) {
      positionPopover(state.composer.pop, anchorViewport(state.composer.anchor));
    }
  }

  function safeQuery(sel) {
    try { return document.querySelector(sel); } catch (e) { return null; }
  }

  // One-time-per-session heal: when a comment's element is on the page, regenerate
  // its selector with the current (robust, body-rooted) builder and, if it changed,
  // persist + push the upgrade. This retires legacy/brittle selectors from older
  // comments so they stop drifting — it only ever re-points at the element the pin
  // is already sitting on, so it can't move a comment.
  var reanchored = {};
  function maybeReanchor(t, el) {
    if (!t || !el || t._pending) return;
    var id = t.id;
    if (!id || id.slice(0, 4) === "tmp_") return; // needs a real server id to PATCH
    if (reanchored[id]) return;
    reanchored[id] = true; // attempt once per session, success or not
    var fresh = cssPath(el);
    if (!fresh || fresh === t.selector) return;
    if (safeQuery(fresh) !== el) return; // only accept a verified round-trip
    t.selector = fresh;
    t.label = labelFor(el) || t.label;
    persistCache();
    api("PATCH", { project: PROJECT, id: id, selector: fresh, label: t.label }).catch(function () {});
  }

  /* ---------- reveal highlight (brief pulse around an element / its pin) ---------- */
  function flashRect(r) {
    if (!els.pulse || !r) return;
    var off = layerOffset(), pad = 4;
    var s = els.pulse.style;
    s.left = (r.left - off.x - pad) + "px";
    s.top = (r.top - off.y - pad) + "px";
    s.width = (r.width + pad * 2) + "px";
    s.height = (r.height + pad * 2) + "px";
    els.pulse.classList.remove("show");
    void els.pulse.offsetWidth; // restart the animation from the top
    els.pulse.classList.add("show");
    clearTimeout(els.pulse._t);
    els.pulse._t = setTimeout(function () { els.pulse.classList.remove("show"); }, 1500);
  }
  function flashHighlight(el) { if (el) flashRect(el.getBoundingClientRect()); }

  /* ---------- thread lookup ---------- */
  function findThread(id) {
    for (var i = 0; i < state.threads.length; i++) if (state.threads[i].id === id) return state.threads[i];
    return null;
  }
  function findOpenThread() {
    if (!state.openThreadId && !state.openClientId) return null;
    var t = state.openThreadId ? findThread(state.openThreadId) : null;
    if (!t && state.openClientId) {
      for (var i = 0; i < state.threads.length; i++)
        if (state.threads[i].clientId && state.threads[i].clientId === state.openClientId) { t = state.threads[i]; break; }
    }
    if (t) state.openThreadId = t.id; // resync after a tmp -> server id swap
    return t;
  }
  function dedupById(list) {
    var seen = {}, out = [];
    list.forEach(function (t) { if (!seen[t.id]) { seen[t.id] = 1; out.push(t); } });
    return out;
  }

  /* ---------- data ops (optimistic) ---------- */
  function createThread(anchor, bodyText, cap) {
    var clientId = "c_" + rand();
    var meta = cap && cap.env ? cap.env : null;
    var temp = {
      id: "tmp_" + rand(), clientId: clientId, project: PROJECT, path: PATH, url: location.href,
      selector: anchor.selector, label: anchor.label, relX: anchor.relX, relY: anchor.relY,
      pageX: anchor.pageX, pageY: anchor.pageY,
      scrollX: anchor.scrollX, scrollY: anchor.scrollY, screenId: anchor.screenId, uiState: anchor.uiState,
      author: state.name, body: bodyText, meta: meta,
      resolved: false, createdAt: Date.now(), replies: [], _pending: true, _replyQueue: [],
      _shotPending: !!(cap && cap.capturePromise), _createdLocally: Date.now(),
    };
    state.threads.push(temp);
    persistCache();
    updatePins();
    refreshDock();
    confettiBurst(anchor.pageX - window.scrollX, anchor.pageY - window.scrollY, 6, 0.6); // tiny pop when a comment is dropped
    api("POST", {
      project: PROJECT, clientId: clientId, path: PATH, url: location.href,
      selector: anchor.selector, label: anchor.label, relX: anchor.relX, relY: anchor.relY,
      pageX: anchor.pageX, pageY: anchor.pageY,
      scrollX: anchor.scrollX, scrollY: anchor.scrollY, screenId: anchor.screenId, uiState: anchor.uiState,
      author: state.name, body: bodyText, meta: meta,
    }).then(function (res) {
      if (!res || !res.thread) { finalizeShot(temp, cap); return; }
      var oldId = temp.id;
      var queued = temp._replyQueue || [];
      var localReplies = temp.replies || [];
      Object.assign(temp, res.thread);
      temp._pending = false;
      temp.replies = localReplies.length ? localReplies : (res.thread.replies || []);
      // migrate any optimistic resolve/delete made before confirmation
      if (state.pendingOps[oldId]) {
        var op = state.pendingOps[oldId];
        state.pendingOps[temp.id] = op;
        if (oldId !== temp.id) delete state.pendingOps[oldId];
        if (typeof op.resolved === "boolean") api("PATCH", { project: PROJECT, id: temp.id, resolved: op.resolved }).catch(function () {});
        if (op.deleted) api("DELETE", { project: PROJECT, id: temp.id }).catch(function () {});
      }
      if (state.openThreadId === oldId) state.openThreadId = temp.id;
      queued.forEach(function (rb) { sendReply(temp, rb); });
      persistCache();
      updatePins();
      finalizeShot(temp, cap); // upload against the real id, then patch the URL in
    }).catch(function () {
      toast("Saved locally — couldn't reach the comments server.");
      finalizeShot(temp, cap); // still preview the shot locally this session
    });
  }

  function addReply(thread, bodyText) {
    thread.replies = thread.replies || [];
    thread.replies.push({ id: "tmp_" + rand(), author: state.name, body: bodyText, createdAt: Date.now() });
    persistCache();
    rerenderOpen();
    if (thread._pending) { (thread._replyQueue = thread._replyQueue || []).push(bodyText); return; }
    sendReply(thread, bodyText);
  }
  function sendReply(thread, bodyText) {
    api("POST", { project: PROJECT, action: "reply", threadId: thread.id, author: state.name, body: bodyText })
      .then(function (res) { if (res && res.thread) { thread.replies = res.thread.replies; persistCache(); rerenderOpen(); } })
      .catch(function () { toast("Reply saved locally — server unreachable."); });
  }

  function toggleResolve(thread) {
    if (!thread) return;
    var willResolve = !thread.resolved;
    if (willResolve) {
      var _pin = pinEls[thread.id];
      if (_pin) { var _pr = _pin.getBoundingClientRect(); confettiBurst(_pr.left, _pr.top); }
      else if (els.popover) { var _rr = els.popover.getBoundingClientRect(); confettiBurst(_rr.left + _rr.width / 2, _rr.top + 24); }
    }
    thread.resolved = willResolve;
    state.pendingOps[thread.id] = Object.assign({}, state.pendingOps[thread.id], { resolved: willResolve });
    persistCache();
    refreshDock();
    if (willResolve && state.filter === "open") {
      closePopovers(); // would otherwise leave an orphaned, unanchored popover
    } else {
      rerenderOpen();
      updatePins();
    }
    if (!thread._pending) {
      // Keep the optimistic op until a server READ confirms it (see mergeServer).
      // Clearing on write-success lets a stale CDN poll resurrect the resolved pin.
      api("PATCH", { project: PROJECT, id: thread.id, resolved: willResolve }).catch(function () {});
    }
  }

  function deleteThread(thread) {
    if (!thread) return;
    state.pendingOps[thread.id] = Object.assign({}, state.pendingOps[thread.id], { deleted: true });
    state.threads = state.threads.filter(function (t) { return t.id !== thread.id; });
    persistCache();
    closePopovers();
    updatePins();
    refreshDock();
    if (!thread._pending) {
      // Keep the delete op until a server READ shows it's gone (see mergeServer).
      api("DELETE", { project: PROJECT, id: thread.id }).catch(function () {});
    } else {
      delete state.pendingOps[thread.id];
    }
  }

  function clearOp(id, key) {
    var op = state.pendingOps[id];
    if (!op) return;
    delete op[key];
    if (!Object.keys(op).length) delete state.pendingOps[id];
  }

  function setFilter(f) {
    state.filter = f;
    refreshDock();
    updatePins();
  }

  /* ---------- api + sync ---------- */
  function api(method, payload) {
    var url = API + (method === "GET" ? "?project=" + encodeURIComponent(PROJECT) : "");
    return fetch(url, {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(payload || {}),
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function sync() {
    api("GET").then(function (res) {
      if (!res) return;
      if (res.durable === false && state.durable) {
        state.durable = false;
        toast("Backend is up, but Blob storage isn't connected yet — comments won't persist across restarts until BLOB_READ_WRITE_TOKEN is set on the deployment (see README).");
      } else if (res.durable) {
        state.durable = true;
      }
      mergeServer(res.threads || []);
    }).catch(function () { /* offline: keep local cache */ });
  }

  function mergeServer(serverThreads) {
    var byId = {}, byClient = {};
    serverThreads.forEach(function (t) { byId[t.id] = t; if (t.clientId) byClient[t.clientId] = t; });

    // Reconcile optimistic ops against the server READ, not the write response.
    // The Blob CDN read can lag a write by ~1-2s; clearing an op on write-success
    // lets a stale poll resurrect a just-resolved/deleted item. So we clear an op
    // only once the server read actually reflects it.
    Object.keys(state.pendingOps).forEach(function (id) {
      var op = state.pendingOps[id], st = byId[id];
      if (!op) return;
      if (op.deleted) { if (!st) delete state.pendingOps[id]; }
      else if (typeof op.resolved === "boolean" && st && st.resolved === op.resolved) clearOp(id, "resolved");
    });

    // Local creates the server read hasn't surfaced yet — keep them so a just-saved
    // comment doesn't blink out in the window between write-confirm and CDN catch-up.
    var now = Date.now();
    var pending = state.threads.filter(function (t) {
      if (byId[t.id] || (t.clientId && byClient[t.clientId])) return false;
      if (state.pendingOps[t.id] && state.pendingOps[t.id].deleted) return false;
      return t._pending || (t._createdLocally && now - t._createdLocally < 60000);
    });

    var merged = serverThreads
      .filter(function (t) { return !(state.pendingOps[t.id] && state.pendingOps[t.id].deleted); })
      .map(function (t) {
        var op = state.pendingOps[t.id];
        if (op && typeof op.resolved === "boolean") return Object.assign({}, t, { resolved: op.resolved });
        return t;
      });

    state.threads = dedupById(merged.concat(pending));
    persistCache();
    refreshDock();
    updatePins();

    if (state.openThreadId || state.openClientId) {
      if (findOpenThread()) rerenderOpen();
      else closePopovers();
    }
    openPending();
  }

  /* ---------- local cache (offline resilience) ---------- */
  function cacheKey() { return "konpo:cache:" + PROJECT + ":" + PATH; }
  function persistCache() {
    try { localStorage.setItem(cacheKey(), JSON.stringify(onPathThreads())); } catch (e) {}
  }
  function loadCache() {
    try {
      var raw = localStorage.getItem(cacheKey());
      if (raw) {
        var cached = JSON.parse(raw) || [];
        // a capture can't still be running after a reload — clear any stale "pending"
        // flag so a mid-capture refresh doesn't leave a stuck "Capturing…" spinner
        cached.forEach(function (t) { if (t && t._shotPending) t._shotPending = false; });
        // merge cache for this path with any already-loaded threads from other paths
        var others = state.threads.filter(function (t) { return !(t.path === PATH || (!t.path && PATH === "/")); });
        state.threads = dedupById(cached.concat(others));
      }
    } catch (e) {}
  }

  /* ---------- toast ---------- */
  function toast(msg, opts) {
    opts = opts || {};
    if (els.toast && els.toast.parentNode) els.toast.parentNode.removeChild(els.toast);
    var body = h("div", { class: "tmsg" });
    if (msg && msg.nodeType) body.appendChild(msg); else body.textContent = msg;
    var t = h("div", { class: "surface toast" }, [
      h("div", { class: "tdot" }),
      body,
      h("div", { class: "x", html: ICON.close, onclick: function () { hide(); } }),
    ]);
    els.toast = t;
    root.appendChild(t);
    requestAnimationFrame(function () { t.classList.add("show"); });
    var to = setTimeout(hide, opts.duration || 6000);
    function hide() { clearTimeout(to); t.classList.remove("show"); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 420); }
  }

  /* ---------- copy feedback as a Claude Code prompt ----------
     Optimized so a connected Claude Code can locate the element fast: leads with the
     element's visible text (the quickest grep target), plus tag/id/classes, the CSS
     selector, the page route, and a ready-to-run ripgrep command. */
  function promptBlock(thread) {
    var el = thread.selector ? safeQuery(thread.selector) : null;
    var tag = el ? el.tagName.toLowerCase() : ((thread.label || "").split(" ")[0] || "element");
    var id = el && el.id ? el.id : "";
    var classes = el && typeof el.className === "string" ? el.className.trim() : "";
    var text = el ? (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160)
                  : (thread.label || "").replace(/^[^·]*·\s*/, "");
    var attrs = [];
    if (el) ["href", "aria-label", "alt", "placeholder", "name", "data-testid", "id"].forEach(function (a) {
      if (a === "id") return; // already shown
      var v = el.getAttribute && el.getAttribute(a);
      if (v) attrs.push(a + '="' + v + '"');
    });

    var feedback = (thread.author || "Anonymous") + ": " + (thread.body || "");
    (thread.replies || []).forEach(function (r) { feedback += "\n  ↳ " + (r.author || "Anonymous") + ": " + (r.body || ""); });

    var sig = "<" + tag + (id ? ' id="' + id + '"' : "") + (classes ? ' class="' + classes + '"' : "") + (attrs.length ? " " + attrs.join(" ") : "") + ">";
    var L = [];
    L.push("WHERE — find this element (the visible text is the fastest locator):");
    if (text) L.push('• Visible text: "' + text + '"');
    L.push("• Element: " + sig);
    L.push("• CSS selector: " + (thread.selector || "(not captured)"));
    L.push("• Page route: " + (thread.path || "/") + (thread.url ? "  (" + thread.url + ")" : ""));
    if (text) L.push("• Fast find: rg -nF " + JSON.stringify(text.slice(0, 60)));
    L.push("");
    L.push("FEEDBACK:");
    L.push(feedback);
    return L;
  }
  function buildPrompt(thread) {
    var L = ["Apply this design feedback from Notes to the codebase.", ""];
    L = L.concat(promptBlock(thread));
    L.push("");
    L.push("TASK: Locate that element in the source (grep the visible text first, then confirm with the selector/route), apply the change the feedback asks for, and keep the edit minimal and consistent with the surrounding code. Don't touch unrelated code.");
    return L.join("\n");
  }
  // One combined prompt for the whole panel list — shared header/task, numbered items.
  function buildPromptAll(threads, who) {
    var n = threads.length;
    var L = ["Apply these " + n + " design feedback items from Notes" + (who ? " (all left by " + who + ")" : "") + " to the codebase.", ""];
    threads.forEach(function (t, i) {
      L.push("──── ITEM " + (i + 1) + " of " + n + (t.resolved ? " (already resolved — skip unless asked)" : "") + " ────");
      L = L.concat(promptBlock(t));
      L.push("");
    });
    L.push("TASK: Work through the items one by one. For each, locate the element in the source (grep the visible text first, then confirm with the selector/route), apply the change the feedback asks for, and keep each edit minimal and consistent with the surrounding code. Don't touch unrelated code.");
    return L.join("\n");
  }
  function copyPrompt(thread) {
    if (!thread) return;
    copyText(buildPrompt(thread)).then(
      function () { toast("Copied as a Claude Code prompt — paste it into Claude."); },
      function () { toast("Couldn't copy to clipboard automatically."); }
    );
  }
  // Send a comment straight to Claude — the backend files a GitHub issue with
  // @claude (which opens a PR). Dormant until the dispatch endpoint is configured.
  function sendToClaude(thread) {
    if (!thread || thread._sending) return;
    thread._sending = true;
    toast("Sending to Claude…", { duration: 4000 });
    api2("POST", ENDPOINT + "/api/dispatch", { project: PROJECT, threadId: thread.id })
      .then(function (res) {
        if (res && res.configured === false) { toast("“Send to Claude” isn’t set up yet — add a repo + token (see README)."); return; }
        if (res && res.url) {
          toast(h("div", {}, [
            document.createTextNode("Sent to Claude — a PR will follow. "),
            h("a", { href: res.url, target: "_blank", rel: "noopener noreferrer", text: "View issue ↗", style: "color:var(--accent);font-weight:600;text-decoration:none" }),
          ]), { duration: 9000 });
        } else { toast("Couldn’t send to Claude."); }
      })
      .catch(function () { toast("Couldn’t reach the Send-to-Claude endpoint."); })
      .then(function () { thread._sending = false; });
  }
  function api2(method, url, payload) {
    return fetch(url, { method: method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function copyAllPrompt() {
    // Open comments only — resolved feedback is done, no reason to hand it to Claude.
    // When an author is selected in the panel filter, copy just their comments.
    var who = state.userFilter;
    var items = state.threads.filter(function (t) {
      return !isStamp(t) && !t.resolved && (!who || (t.author || "Anonymous") === who);
    }).sort(function (a, b) { return a.createdAt - b.createdAt; });
    if (!items.length) { toast(who ? "No open comments from " + who + " to copy." : "No open comments to copy."); return; }
    copyText(buildPromptAll(items, who)).then(
      function () { toast("Copied " + items.length + " open comment" + (items.length === 1 ? "" : "s") + (who ? " from " + who : "") + " as one Claude Code prompt — paste it into Claude."); },
      function () { toast("Couldn't copy to clipboard automatically."); }
    );
  }
  function copyText(text) {
    // Synchronous execCommand fallback — works even when the document isn't focused
    // (which makes navigator.clipboard.writeText reject in embedded/widget contexts).
    function legacy() {
      return new Promise(function (resolve, reject) {
        try {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
          (document.body || document.documentElement).appendChild(ta);
          ta.focus();
          ta.select();
          try { ta.setSelectionRange(0, text.length); } catch (e) {}
          var ok = document.execCommand("copy");
          ta.remove();
          ok ? resolve() : reject(new Error("execCommand copy failed"));
        } catch (e) { reject(e); }
      });
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(legacy); // reject (e.g. unfocused) -> fall back
    }
    return legacy();
  }

  function countChip(iconSvg, n, isDone, titleTxt) {
    var span = h("span", { class: "ci" + (isDone ? " done" : ""), title: titleTxt });
    span.innerHTML = iconSvg; // trusted inline icon
    span.appendChild(h("b", { text: String(n) }));
    return span;
  }

  /* ---------- purple confetti (self-contained, fired on resolve) ---------- */
  function confettiBurst(x, y, count, sizeScale) {
    if (!els.confetti) return;
    count = count || 20;
    sizeScale = sizeScale || 1;
    var colors = ["#9680FF", "#B794F6", "#6D28D9", "#E9DDFF"];
    for (var i = 0; i < count; i++) {
      var p = document.createElement("div");
      p.className = "confetti-piece";
      var size = (5 + Math.random() * 5) * sizeScale;
      p.style.width = size + "px";
      p.style.height = size * 0.55 + "px";
      p.style.background = colors[i % colors.length];
      p.style.left = x + "px";
      p.style.top = y + "px";
      els.confetti.appendChild(p);
      animateConfetti(p);
    }
  }
  function animateConfetti(p) {
    var angle = Math.random() * Math.PI * 2;
    var velocity = 70 + Math.random() * 130;
    var vx = Math.cos(angle) * velocity;
    var vy = Math.sin(angle) * velocity - (110 + Math.random() * 70);
    var rot = Math.random() * 360, spin = (Math.random() - 0.5) * 720, start = null;
    function frame(ts) {
      if (start === null) start = ts;
      var t = (ts - start) / 1000;
      p.style.transform = "translate(" + vx * t + "px," + (vy * t + 0.5 * 1100 * t * t) + "px) rotate(" + (rot + spin * t) + "deg)";
      p.style.opacity = String(Math.max(0, 1 - t / 1.15));
      if (t < 1.15) requestAnimationFrame(frame);
      else if (p.parentNode) p.parentNode.removeChild(p);
    }
    requestAnimationFrame(frame);
    setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p); }, 1800); // safety cleanup if tab was hidden
  }

  /* ---------- utils ---------- */
  function clamp01(n) { return Math.max(0, Math.min(1, n)); }
  function initials(name) {
    if (!name) return "?";
    var p = name.trim().split(/\s+/);
    return (p[0][0] + (p[1] ? p[1][0] : "")).toUpperCase();
  }
  function timeAgo(ts) {
    if (!ts) return "";
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    var m = Math.floor(s / 60); if (m < 60) return m + "m ago";
    var hr = Math.floor(m / 60); if (hr < 24) return hr + "h ago";
    var d = Math.floor(hr / 24); if (d < 7) return d + "d ago";
    return new Date(ts).toLocaleDateString();
  }
  function labelFor(el) {
    var tag = el.tagName.toLowerCase();
    var txt = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (el.id) return tag + "#" + el.id;
    if (txt) return tag + " · " + (txt.length > 32 ? txt.slice(0, 32) + "…" : txt);
    var cls = el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/)[0] : "";
    return tag + cls;
  }
  // Stable, layout-independent hooks a host can add to survive DOM changes.
  // data-comment-anchor is the dedicated, intentional one and is tried FIRST (even
  // ahead of id, which some frameworks auto-generate); the rest are common test attrs.
  var STABLE_ATTRS = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa", "name"];
  function cssAttrVal(v) { return '"' + String(v).replace(/(["\\])/g, "\\$1") + '"'; }
  function attrSel(node, a) {
    var v = node.getAttribute(a);
    if (!v) return null;
    var sel = "[" + a + "=" + cssAttrVal(v) + "]";
    if (uniq(sel)) return sel;
    var tsel = node.tagName.toLowerCase() + sel; // disambiguate with the tag
    return uniq(tsel) ? tsel : null;
  }
  // A unique selector for THIS node from an intentional anchor, id, or test attr.
  function stableSelectorFor(node) {
    if (!node || node.nodeType !== 1 || !node.getAttribute) return null;
    var anchor = attrSel(node, "data-comment-anchor"); // dedicated hook wins
    if (anchor) return anchor;
    if (node.id && uniq("#" + cssEsc(node.id))) return "#" + cssEsc(node.id);
    for (var i = 0; i < STABLE_ATTRS.length; i++) {
      var s = attrSel(node, STABLE_ATTRS[i]);
      if (s) return s;
    }
    return null;
  }
  // tag + absolute 1-based position among element siblings — deterministic and,
  // once rooted, unique. (nth-of-type on its own drifts when sibling tags change.)
  function nthChild(node) {
    var idx = 1, sib = node;
    while ((sib = sib.previousElementSibling)) idx++;
    return node.tagName.toLowerCase() + ":nth-child(" + idx + ")";
  }
  // Full path from <body> down to el — always resolves to el on the current DOM.
  function fullChildPath(el) {
    var parts = [], node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      parts.unshift(nthChild(node));
      node = node.parentNode;
    }
    return parts.length ? "body > " + parts.join(" > ") : "body";
  }
  // Prefer a stable selector on the element itself; otherwise build a path anchored
  // at the nearest ancestor that HAS a stable (unique) selector, else rooted at
  // <body>. Rooting + absolute :nth-child makes the selector resolve to the RIGHT
  // element no matter which section it's in (an unrooted path matched the first
  // similar element anywhere, or nothing — the "saved position" fallback). The
  // result is round-trip verified; if it doesn't land back on el we use the full path.
  function cssPath(el) {
    if (!(el instanceof Element)) return "";
    if (el === document.body) return "body";
    if (el === document.documentElement) return "html";
    var direct = stableSelectorFor(el);
    if (direct) return direct;
    var parts = [], node = el, rooted = false;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      var stable = stableSelectorFor(node);
      if (stable) { parts.unshift(stable); rooted = true; break; }
      parts.unshift(nthChild(node));
      node = node.parentNode;
    }
    var sel = (rooted ? "" : "body > ") + parts.join(" > ");
    if (safeQuery(sel) === el) return sel;
    return fullChildPath(el); // guaranteed to match on the current DOM
  }
  function uniq(sel) { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } }
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }

  /* ---------- global listeners ---------- */
  on(document, "mousemove", onMoveWhilePlacing, true);
  on(document, "mousemove", onMoveWhileStamping, true);
  on(document, "click", onClickWhilePlacing, true);
  on(document, "pointerdown", onStampDown, true); // stamps: press-and-hold to grow
  on(document, "pointerup", onStampUp, true);
  on(document, "pointercancel", function () { endStampHold(true); }, true);
  on(document, "keydown", function (e) {
    if (e.key === "Escape") {
      if (state.placing) togglePlacing();
      else if (state.stamping) disarmStamping();
      else closePopovers();
      return;
    }
    var editable = function (n) { return n && (/^(input|textarea|select)$/i.test(n.tagName) || n.isContentEditable); };
    var typing = editable(e.target);
    var inShadow = e.composedPath && e.composedPath().some(editable);
    var mod = e.metaKey || e.ctrlKey || e.altKey;
    // Arrow keys jump between open comments whenever the bar is shown — no separate mode.
    if (state.dockLevel === 2 && !state.stamping && !typing && !inShadow && !mod) {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); navStep(1); return; }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); navStep(-1); return; }
    }
    if ((e.key === "c" || e.key === "C") && !typing && !inShadow && !els.popover && !mod) {
      togglePlacing();
    }
    if ((e.key === "k" || e.key === "K") && !typing && !inShadow && !els.popover && !mod) {
      if (state.dockLevel !== 2) showDock(); // bring the bar up if hidden, then open the list
      togglePanel(); // K opens/closes View comments
    }
  });

  var rafPending = false;
  function scheduleLayout() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; layout(); });
  }
  on(window, "scroll", scheduleLayout, true);
  on(window, "resize", scheduleLayout, true);
  on(window, "resize", function () { if (els.dock) applyDockPlacement(); }, true);
  if (window.ResizeObserver) {
    try { ro = new ResizeObserver(scheduleLayout); ro.observe(document.documentElement); } catch (e) {}
  }

  // outside-click closes popovers (but not clicks inside our shadow UI, and not while placing)
  on(document, "mousedown", function (e) {
    if (!els.popover || state.placing) return;
    var path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(host) === -1) closePopovers();
  }, true);

  /* ---------- SPA route changes ---------- */
  function onRouteChange() {
    if (location.pathname === PATH) return;
    PATH = location.pathname;
    closePopovers();
    loadCache();
    updatePins();
    refreshDock();
    sync();
  }
  ["pushState", "replaceState"].forEach(function (m) {
    if (!history[m] || history["__konpo_" + m]) return;
    var orig = history[m];
    history["__konpo_" + m] = orig;
    history[m] = function () {
      var r = orig.apply(this, arguments);
      try { onRouteChange(); } catch (e) {}
      return r;
    };
  });
  on(window, "popstate", onRouteChange);
  // hash routers keep the same pathname — refresh pins and honor a pending open
  on(window, "hashchange", function () { openPending(); scheduleLayout(); });

  /* ---------- teardown ---------- */
  function destroy() {
    if (pollTimer) clearInterval(pollTimer);
    if (ro) try { ro.disconnect(); } catch (e) {}
    cleanup.forEach(function (fn) { try { fn(); } catch (e) {} });
    ["pushState", "replaceState"].forEach(function (m) {
      if (history["__konpo_" + m]) { history[m] = history["__konpo_" + m]; delete history["__konpo_" + m]; }
    });
    if (host.parentNode) host.parentNode.removeChild(host);
    window.__konpoComments = false;
  }

  /* ---------- boot ---------- */
  function boot() {
    mount();
    loadCache();
    updatePins();
    refreshDock();
    openPending(); // if we arrived via a cross-page comment jump, this re-shows the bar
    loadFonts();
    sync();
    loadLogo();
    pollTimer = setInterval(function () { if (document.visibilityState === "visible") sync(); }, 5000);
    on(document, "visibilitychange", function () { if (document.visibilityState === "visible") sync(); });
  }

  window.__konpoComments = window.__konpoKomments = window.__konpoNotes = { destroy: destroy, version: "1.1.0", project: PROJECT, reveal: function (id) { var t = findThread(id); if (t) { openThread(t); revealThread(t); } } };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
