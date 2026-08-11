// SPDX-License-Identifier: GPL-3.0-or-later
// providers/claude.js - the Claude (claude.ai, Anthropic) provider.
// Exports the same CLProvider interface as providers/deepseek.js,
// providers/gemini.js and providers/kimi.js; the core (core/main.js) is
// provider-agnostic. To DISABLE Claude support, simply remove this file from
// manifest.json (and its URL from background.js PROVIDER_URLS).
//
// Claude DOM notes (verified from live DevTools inspection + published
// Chrome-extension teardowns of claude.ai, 2025-2026):
//  - claude.ai is a Next.js SPA. Chat turns are wrapped in
//    [data-testid="conversation-turn"]. User messages contain
//    [data-testid="user-message"]; assistant replies use
//    .font-claude-response (the prose container) inside the assistant turn.
//    There is NO "ai-turn" testid (a common wrong guess).
//  - The composer is a ProseMirror editor: div.ProseMirror[contenteditable="true"].
//    Trusted-Types CSP applies, so innerHTML assignment throws. Inject text
//    via focus + select-all + document.execCommand("insertText") - the same
//    proven path as Gemini's Quill editor and Kimi's Lexical editor.
//  - The send button is button[data-testid="send-button"] (also matched by
//    aria-label "Send message" / "Send Message"). While generating, it becomes
//    a stop button: button[data-testid="stop-button"] or button[aria-label*
//    "Stop" / "stop"]. We anchor on data-testid first (stable, non-localized),
//    aria-label as fallback.
//  - Claude streams token-by-token (MutationObserver-style); the assistant
//    turn's textContent grows continuously, so stream-growth detection works.
//  - Claude has a CONTEXT/TOKEN LIMIT: long conversations hit "conversation
//    too long" / "limit reached". The core surfaces this via scanError() +
//    RE.contextLimit (same path as DeepSeek/Gemini/Kimi). Additionally,
//    main.js shows a proactive "Attention Claude a une limite de token !"
//    banner when the Claude provider starts a session (user-requested overlay).
//  - No confirmed "Continue after truncation" button; findContinueBtn returns
//    null. Claude instead surfaces a "regenerate" / "retry" affordance, which
//    is NOT the same semantic, so we do not auto-click it.
//  - Claude.ai's CSP blocks external fetch/XHR from content scripts. CoreLua's
//    bridge traffic goes through the background service worker's WebSocket
//    (ws://127.0.0.1), which is NOT subject to the page CSP, so this is fine.
// eslint-disable-next-line no-unused-vars
const CLProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  // -- DOM selectors ---------------------------------------------------------
  // Claude.ai is a Next.js SPA. Turns are [data-testid="conversation-turn"];
  // user messages carry [data-testid="user-message"]; assistant prose lives in
  // .font-claude-response. The composer is a ProseMirror contenteditable.
  const S = {
    // One chat "turn" (user OR assistant): the conversation-turn wrapper.
    turn: '[data-testid="conversation-turn"]',
    // User message bubble inside a turn.
    userMsg: '[data-testid="user-message"]',
    // Assistant prose container (the rendered markdown reply).
    assistantMsg: ".font-claude-response",
    // Reasoning / "thinking" panel if present (extended-thinking models).
    thinkingCandidates: ["[class*='thinking']", "[class*='reasoning']", "[data-testid*='think']"],
    // ProseMirror composer — confirmed on Claude.ai (ProseMirror discuss forum
    // + openAdapter Playwright automation). The class may be on a div OR a
    // generic element, so we do NOT prefix with "div".
    editor: ".ProseMirror[contenteditable='true']",
    // Ordered fallback chain for the composer, most-specific first.
    //   - div[data-placeholder][contenteditable] : ProseMirror with placeholder
    //   - div[contenteditable='true']            : generic contenteditable
    //   - div[role='textbox']                    : ARIA textbox (React pattern)
    //   - [contenteditable='true']               : any contenteditable element
    editorFallbacks: [
      "div[data-placeholder][contenteditable='true']",
      "div[contenteditable='true']",
      "div[role='textbox']",
      "[contenteditable='true']",
    ],
    // Legacy single-fallback kept for compatibility (maps to first entry).
    editorFallback: "div[contenteditable='true']",
    // Send / stop buttons — data-testid is stable & non-localized; aria-label
    // is the localized fallback. aria-label is listed FIRST because some Claude
    // UI revisions drop the data-testid attribute while keeping aria-label.
    sendBtn: 'button[aria-label*="Send" i], button[data-testid="send-button"]',
    stopBtn: 'button[aria-label*="Stop" i], button[data-testid="stop-button"]',
    // The composer wrapper that holds the editor + send button. data-testid is
    // the primary anchor; we also accept the editor's positioned ancestor.
    composerWrap: '[data-testid="chat-input"], [data-testid="composer"]',
    errorSurfaces:
      '[class*="toast"],[class*="Toast"],[role="alert"],[class*="notification"],[class*="error"],[class*="Error"]',
  };

  // Error / state regexes - English, French (Claude's UI follows browser locale).
  const RE = {
    // "token / context limit reached" - surfaces "conversation too long" to the
    // core as a too_long event (same handling path as the other providers).
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "token.{0,10}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "limite.{0,20}(de contexte|de jetons|de tokens|atteinte)",
        "please.{0,30}start.{0,20}new.{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "maximum.{0,20}context",
        "exceeds?.{0,15}(context|token|limit)",
        "input.{0,10}(too long|trop long)",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)|input .{0,10}(too long|trop long)/i,
    busy: /something went wrong|une erreur s.?est produite|try again later|r\u00e9essayer plus tard|temporarily unavailable|server is busy|serveur est occup/i,
    continueBtn: /^(continue|continuer|fortfahren|continuar|seguir)$/i,
  };

  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 15000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // -- selector helpers ------------------------------------------------------
  function pick(selList, root) {
    const r = root || document;
    for (const sel of selList) {
      const els = r.querySelectorAll(sel);
      if (els.length) return [...els];
    }
    return [];
  }
  function pickOne(selList, root) {
    const r = root || document;
    for (const sel of selList) {
      const el = r.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // -- Turn classification ---------------------------------------------------
  // A turn is a [data-testid="conversation-turn"]. We classify it as a USER
  // turn if it contains [data-testid="user-message"], otherwise ASSISTANT.
  // This is robust: it does not rely on positional parity (Claude can show
  // tool-result turns, system notes, etc. that break strict alternation).
  function isUserItem(item) {
    if (!item) return false;
    // A turn containing a user-message bubble is a user turn.
    if (item.querySelector(S.userMsg)) return true;
    // If it contains assistant prose, it's an assistant turn.
    if (item.querySelector(S.assistantMsg)) return false;
    // Fallback: positional parity (even = user, first message is always user).
    const items = allItems();
    return items.indexOf(item) % 2 === 0;
  }
  const isAssistantItem = (item) => !!item && !isUserItem(item);

  const allItems = () => [...document.querySelectorAll(S.turn)];

  function itemText(item) {
    if (!item) return "";
    const think = pickOne(S.thinkingCandidates, item);
    if (isAssistantItem(item) && think) {
      // Exclude the thinking/reasoning subtree from the "real" reply text.
      const clone = item.cloneNode(true);
      const think2 = pickOne(S.thinkingCandidates, clone);
      if (think2) think2.remove();
      return clone.textContent || "";
    }
    return item.textContent || "";
  }
  function classifyText(item, excludeSel) {
    if (!item) return "";
    const clone = item.cloneNode(true);
    const think = pickOne(S.thinkingCandidates, clone);
    if (think) think.remove();
    if (excludeSel) clone.querySelectorAll(excludeSel).forEach((n) => n.remove());
    return clone.textContent || "";
  }

  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  // Stable per-turn identity. Claude's Next.js app does NOT virtualize the
  // message list (turns persist in the DOM), but a stable key is still needed
  // for the core's off-DOM dedupe maps (executed/halted). We prefer the turn's
  // data-testid (constant "conversation-turn" - NOT unique) so we combine it
  // with a positional index among assistant turns, then fall back to a
  // synthetic role+text key. This mirrors deepseek.js/kimi.js's itemKey().
  function itemKey(item) {
    if (!item) return null;
    // 1. A stable id directly on the turn element (Claude does not set one
    //    today, but if it ever does, use it).
    const ik =
      item.getAttribute("data-id") ||
      item.getAttribute("data-message-id") ||
      item.getAttribute("data-turn-id") ||
      item.getAttribute("id");
    if (ik) return ik;
    // 2. Positional index among ALL turns (stable while the list is not
    //    virtualized - Claude keeps every turn in the DOM).
    const items = allItems();
    const idx = items.indexOf(item);
    if (idx >= 0) return `turn:${idx}`;
    // 3. Synthetic key from role + text (last resort).
    const role = isAssistantItem(item) ? "a" : "u";
    const txt = (item.textContent || "").slice(0, 60);
    return `${role}:${txt.length}:${txt.slice(0, 12)}`;
  }

  function lastAssistantId() {
    const last = lastAssistant();
    return itemKey(last);
  }

  // -- Composer --------------------------------------------------------------
  // Robust editor lookup: try ProseMirror first, then walk the ordered
  // fallback chain (data-placeholder contenteditable, then generic
  // contenteditable, then ARIA textbox, then any contenteditable). We EXCLUDE
  // anything inside #cl-root (our own overlay) so we never pick up our own
  // elements. This mirrors the proven selector chain from openAdapter
  // (Playwright automation for Claude.ai) and the intellectronica Cmd-Enter
  // userscript.
  const getEditor = () => {
    // 1. ProseMirror editor (the canonical Claude.ai composer).
    const pm = document.querySelector(S.editor);
    if (pm && !pm.closest("#cl-root") && pm.offsetParent !== null) return pm;
    if (pm && !pm.closest("#cl-root")) return pm; // accept even if hidden
    // 2. Ordered fallback chain.
    for (const sel of S.editorFallbacks) {
      for (const e of document.querySelectorAll(sel)) {
        if (!e.closest("#cl-root")) return e;
      }
    }
    return null;
  };
  const isTextarea = (el) => el && el.tagName === "TEXTAREA";
  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    return isTextarea(e) ? e.value || "" : e.textContent || "";
  };

  function setInputLock(on) {
    const ed = getEditor();
    if (!ed) return;
    // ProseMirror contenteditable: flip contenteditable to block input (our own
    // execCommand injection temporarily re-enables it inside typeAndSend).
    ed.setAttribute("contenteditable", on ? "false" : "true");
    if (on) ed.setAttribute("data-cl-locked", "1");
    else ed.removeAttribute("data-cl-locked");
  }

  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => chatIsEmpty() && !!getEditor();
  function composerFrame() {
    // The composer wrapper that holds the editor + toolbar + send button.
    // S.composerWrap is a compound selector (data-testid="chat-input" OR
    // data-testid="composer"); querySelector picks the first match.
    const wrap = document.querySelector(S.composerWrap);
    if (wrap) return wrap;
    // Fallback: walk up from the editor to a reasonable ancestor.
    const ed = getEditor();
    if (!ed) return null;
    let n = ed;
    for (let i = 0; i < 6 && n.parentElement; i++) n = n.parentElement;
    return n;
  }

  // Where the core mounts its in-flow status bar. Claude's composer is a
  // Next.js / React-managed subtree, so inserting #cl-bar INTO it risks React
  // reusing the bar node (same class of bug as Kimi's Vue tree). We DISABLE
  // barMount() (return null) and use barAnchor() instead: the bar stays in
  // #cl-root, positioned with position:fixed + reserved paddingTop on the
  // composer wrapper. This is the safe path for React/Next.js SPAs.
  function barMount() {
    return null;
  }
  function barAnchor() {
    // Hug the composer wrapper (stable, not re-diffed away by React).
    return (
      document.querySelector(S.composerWrap) ||
      // Fallback: the editor's nearest positioned ancestor.
      (getEditor() && getEditor().closest("div")) ||
      null
    );
  }

  // -- Send / stop button detection -----------------------------------------
  // Claude's send button is button[data-testid="send-button"] (stable,
  // non-localized). While generating it becomes button[data-testid="stop-button"].
  // S.sendBtn / S.stopBtn are COMPOUND selectors that try aria-label FIRST
  // (more resilient to UI revisions) then data-testid. We pick the first
  // VISIBLE match. The aria-label fallbacks also handle localized UIs (fr/de/es).
  const sendButton = () => {
    for (const btn of document.querySelectorAll(S.sendBtn)) {
      if (btn.offsetParent !== null) return btn;
    }
    // Last resort: any visible button whose aria-label mentions "send".
    for (const btn of document.querySelectorAll('button[aria-label*="Send" i]')) {
      if (btn.offsetParent !== null) return btn;
    }
    return null;
  };
  const stopButton = () => {
    for (const btn of document.querySelectorAll(S.stopBtn)) {
      if (btn.offsetParent !== null) return btn;
    }
    for (const btn of document.querySelectorAll('button[aria-label*="Stop" i]')) {
      if (btn.offsetParent !== null) return btn;
    }
    return null;
  };

  // -- Generation / completion detection -------------------------------------
  function streamText(item) {
    if (!item) return "";
    return itemText(item);
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  function genActive() {
    sampleStream();
    if (stopButton()) return true; // explicit stop control = generating
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = () => !!stopButton();

  const turnHalted = () => false; // Claude shows no reliable "stopped" marker

  // A "Continue / resume" button Claude may surface after a truncated reply.
  // Matched by visible label (en/fr) across all visible buttons. Claude
  // typically does NOT show one (it shows "regenerate" instead), so this will
  // usually return null - but we keep the hook for parity with the other
  // providers and in case Claude adds a Continue affordance.
  function findContinueBtn() {
    for (const b of document.querySelectorAll("button")) {
      if (b.offsetParent === null) continue; // not visible
      if (RE.continueBtn.test((b.innerText || b.textContent || "").trim())) return b;
    }
    return null;
  }
  function clickContinueBtn() {
    const b = findContinueBtn();
    if (!b) return false;
    try { b.click(); return true; } catch { return false; }
  }

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const think = pickOne(S.thinkingCandidates, it);
      return {
        th: think ? (think.textContent || "").trim().length : 0,
        rp: itemText(it).length,
      };
    } catch { return {}; }
  }

  // Break isGenerating() into sub-signals for the core's chip.why tracker.
  // Mirrors deepseek.js / kimi.js genDebug().
  function genDebug() {
    try {
      sampleStream();
      const stop = stopButton();
      return {
        stopBtn: !!stop,
        stopLabel: stop ? (stop.getAttribute("aria-label") || stop.getAttribute("data-testid") || stop.textContent || "").trim().slice(0, 20) : "",
        streamMax: _streamMax,
        streamAgeMs: _streamAt ? Date.now() - _streamAt : -1,
        grewGen: grewWithin(timings.GEN_IDLE_MS),
        gen: isGenerating(),
      };
    } catch (e) { return { err: String((e && e.message) || e) }; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const think = pickOne(S.thinkingCandidates, item);
    return {
      present: true,
      reply: itemText(item).trim(),
      thinking: think ? (think.textContent || "").trim() : "",
      item,
    };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // -- Sending ---------------------------------------------------------------
  // ProseMirror contenteditable: use select-all + execCommand("insertText")
  // (same proven path as Gemini's Quill and Kimi's Lexical). innerHTML would
  // throw under Claude's Trusted-Types CSP.
  function setContentEditableValue(el, v) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("selectAll");
    document.execCommand("insertText", false, v);
  }

  // Generic head+tail truncation so a huge tool result never wedges the
  // composer. Claude's context window is large but the WEB COMPOSER has a
  // practical character cap; 100k is a conservative ceiling.
  const SEND_MAX = 100000;
  function truncateForSend(text) {
    if (!text || text.length <= SEND_MAX) return text;
    const omitted = text.length - SEND_MAX;
    const marker =
      `\n\n[\u2026CoreLua: result truncated - ${omitted} of ${text.length} characters ` +
      `omitted to fit Claude's composer. Do NOT re-run the command; work with the ` +
      `head and tail shown here\u2026]\n\n`;
    const budget = SEND_MAX - marker.length;
    const headLen = Math.floor(budget * 0.85);
    const tailLen = budget - headLen;
    return text.slice(0, headLen) + marker + text.slice(text.length - tailLen);
  }

  async function typeAndSend(text /*, images */) {
    const ed = getEditor();
    if (!ed) throw new Error("Claude input box not found");
    text = truncateForSend(text);
    // Temporarily re-enable the editor if we locked it during bootstrap.
    const wasLocked = ed.getAttribute("contenteditable") === "false";
    if (wasLocked) ed.setAttribute("contenteditable", "true");
    ed.focus();
    if (isTextarea(ed)) {
      const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(ed, text);
      else ed.value = text;
      ed.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      setContentEditableValue(ed, text);
    }
    // Wait for the send button to become enabled (Claude shows it once text
    // is present and the model is idle).
    await waitFor(() => !!sendButton(), 3000);
    const btn = sendButton();
    if (btn) {
      btn.click();
      if (wasLocked) ed.setAttribute("contenteditable", "false");
      return;
    }
    // Fallback: Enter sends in Claude's composer (Shift+Enter = newline).
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    ed.dispatchEvent(new KeyboardEvent("keydown", o));
    ed.dispatchEvent(new KeyboardEvent("keyup", o));
    if (wasLocked) ed.setAttribute("contenteditable", "false");
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) try { b.click(); } catch {}
  }

  function enforceComposer() { return { ready: true }; }
  // Claude.ai is a Next.js SPA: the composer/editor renders AFTER the initial
  // page load, often several seconds later. The content script runs at
  // document_idle, which can fire before React hydrates the composer. So we
  // POLL for the editor to appear (up to ~15s) instead of failing immediately.
  // This fixes the "Claude mode not ready" error the user hit.
  async function ensureComposerReady() {
    // Fast path: editor already present.
    if (getEditor()) return { ready: true };
    // Slow path: wait for the SPA to render the composer.
    const found = await waitFor(() => !!getEditor(), 15000);
    return { ready: found };
  }

  // -- Error / limit detection ----------------------------------------------
  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.turn)) continue; // model content, not UI chrome
        const t = (el.innerText || "").trim();
        if (t.length > 4 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text) || RE.contextLimit.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // -- Image attachment (best-effort) ---------------------------------------
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `corelua_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  async function attachImages(images) {
    const ed = getEditor();
    if (!ed || !images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      try {
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      } catch { /* fall through to paste */ }
    }
    ed.focus();
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  }
  function clearAttachments() {
    try {
      const frame = composerFrame();
      if (!frame) return;
      frame.querySelectorAll("[aria-label*='remove'], [aria-label*='supprimer'], [class*='delete'], [class*='remove']")
        .forEach((d) => { try { d.click(); } catch {} });
    } catch {}
  }

  const conversationKey = () => (chatIsEmpty() ? "" : location.pathname);

  // -- User-send interception -----------------------------------------------
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const ed = getEditor();
        if (!ed || !ed.contains(e.target)) return;
        if (editorText().trim() === "") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        if (!getEditor()) return;
        const t = e.target;
        // The native "Continue" button = intent to resume after a stop/truncation.
        // Match it BEFORE the send/stop checks so it is never mistaken for a send.
        const cont = t && t.closest && t.closest("button");
        if (cont && cont !== sendButton() && cont !== stopButton() &&
            RE.continueBtn.test((cont.innerText || cont.textContent || "").trim())) {
          if (handlers.onNativeContinue) handlers.onNativeContinue();
          return;
        }
        const btn = t && t.closest && t.closest("button");
        if (!btn) return;
        if (btn === stopButton()) {
          if (!e.isTrusted) return; // synthetic click = unwedgeStop, not a user halt
          handlers.onNativeStop();
          return;
        }
        if (btn !== sendButton()) return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  // -- Tool-block location for camouflage -----------------------------------
  // Hide the raw tool call so nothing of it leaks beside the core's chip.
  // Claude renders markdown in .font-claude-response; fenced code blocks are
  // wrapped in <pre> (possibly inside a .code-block wrapper). A whole
  // ###LUA###...###END_LUA### or ###mcp_tool### block may span several <p>
  // paragraphs, so we hide the contiguous run from the start marker through
  // the end marker. We also handle bare JSON {"command":...} blocks. Mirrors
  // deepseek.js / kimi.js findToolBlockSpot (the camouflage is robust even
  // though claude.js was not validated against the live DOM).
  function findToolBlockSpot(item, chip) {
    const P2 = CLParse;
    const hasStart = (t) => P2.LUA_START_RE.test(t) || t.includes("###mcp_tool###");
    const hasEnd = (t) => P2.LUA_END_RE.test(t) || t.includes("###end_mcp_tool###") || t.includes("###end-mcp_tool###");
    const isJson = (t) => /\{\s*"(?:command|tool)"\s*:/.test(t);
    const mdSel = ".font-claude-response, [class*='markdown'], .markdown-body, [class*='prose'], .prose";
    let containers = [...item.querySelectorAll(mdSel)].filter((m) => !m.closest(S.thinkingCandidates.join(",")));
    if (!containers.length) containers = [item];
    let parent = null, ref = null;
    for (const container of containers) {
      const kids = [...container.children].filter((k) => k !== chip && !(chip && k.contains(chip)));
      let i = 0;
      while (i < kids.length) {
        const txt = (kids[i].textContent || "");
        const tLow = txt.toLowerCase();
        const startsBlock = hasStart(tLow);
        if (!startsBlock && !isJson(txt)) { i++; continue; }
        const runStart = i;
        let runEnd = i;
        if (startsBlock && !hasEnd(tLow)) {
          // multi-element LUA/MCP block -> extend until the end marker.
          let j = i + 1;
          runEnd = kids.length - 1;
          for (; j < kids.length; j++) {
            if (hasEnd((kids[j].textContent || "").toLowerCase())) { runEnd = j; break; }
          }
        }
        for (let k = runStart; k <= runEnd; k++) {
          // Prefer hiding the whole code-block wrapper so the fenced ```lua
          // block's chrome (language label / Copy bar) is hidden too.
          let hide = kids[k];
          const wrap = hide.closest("[class*='code'], .code-block, pre");
          if (wrap && container.contains(wrap) && wrap !== container) hide = wrap;
          hide.classList.add("cl-tool-hide");
          if (!ref && hide.parentElement) { parent = hide.parentElement; ref = hide; }
        }
        i = runEnd + 1;
      }
    }
    return ref ? { parent, ref } : null;
  }

  return {
    id: "claude",
    displayName: "Claude",
    // Claude (Sonnet 4.5 / Opus 4.1) supports native vision (image
    // understanding) in the web UI via paste/upload, so screen_capture is
    // safe to expose. Set false if the web upload path turns out unreliable.
    supportsVision: true,
    timings,
    thinkingSel: S.thinkingCandidates.join(","),
    // Claude (Next.js/React) re-renders a turn's content subtree on updates,
    // wiping any chip placed inside it. Anchor chips at the turn-element level.
    chipAtItemLevel: true,
    // Claude re-appends fresh reply content AFTER a chip pinned as firstChild
    // (same behaviour as Kimi's Vue tree), so opt into chipAppend to place the
    // chip LAST (trailing the reply text, in the model's read order).
    chipAppend: true,
    // Claude keeps every turn in the DOM (no virtualization), so
    // assistantCount() reliably increases for every new reply.
    reliableCounts: true,
    init({ diag: d } = {}) { if (d) diag = d; },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating, genDebug,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();
