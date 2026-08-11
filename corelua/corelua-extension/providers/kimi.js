// SPDX-License-Identifier: GPL-3.0-or-later
// providers/kimi.js - the Kimi (kimi.com, Moonshot AI) provider.
// Exports the same CLProvider interface as providers/deepseek.js and
// providers/gemini.js; the core (core/main.js) is provider-agnostic.
//
// ⚠️ UNLIKE deepseek.js / gemini.js, THIS FILE WAS NOT "validated live" - it was
// written without a live browser session against kimi.com, so several selectors
// below are best-effort guesses based on common patterns for React chat SPAs,
// not confirmed Kimi DOM. It follows defensive/generic strategies wherever
// possible (role/aria-label/placeholder matching instead of hashed class names)
// so it has a decent chance of working out of the box, but you WILL likely need
// to open kimi.com, hit F12 (DevTools) → Elements, and adjust the few spots
// marked "VERIFY" below. Quick way to find each one:
//   - Right-click the message input box → Inspect → note the tag (textarea vs
//     contenteditable div) and any stable attribute (data-testid, aria-label,
//     placeholder text).
//   - Right-click one of your own sent messages → Inspect → walk up to the
//     smallest ancestor that wraps just that turn; do the same for a Kimi reply.
//   - Right-click the send button (paper-plane icon) while idle, then again
//     while Kimi is generating (it usually becomes a stop/square icon) → note
//     any aria-label/data-testid differences between the two states.
// Once you have those, update the `S` selectors and `iconName`/button-matching
// logic below - the rest of the file (turn tracking, stream-growth detection,
// truncation, token-limit detection, hooks) is written to survive most sites
// with vanilla React textareas + a virtualized/non-virtualized message list.
// eslint-disable-next-line no-unused-vars
const CLProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  // ── DOM selectors ──────────────────────────────────────────────────────
  // VERIFY: these are generic best-guesses. Kimi's web app is a React SPA;
  // most React chat apps expose either a <textarea> or a contenteditable div
  // for the composer, and mark turns with role="listitem"/data-role or a
  // repeated wrapper class. Tighten these once you've inspected the live DOM.
  const S = {
    // Candidate selectors for one chat "turn" (a user OR assistant message).
    // CONFIRMED via live kimi.com DOM inspection + JS bundle analysis:
    // Kimi renders each turn as <div class="segment-user"> or
    // <div class="segment-assistant"> inside .message-list. These are the
    // ONLY selectors that match the real Kimi DOM; the generic guesses
    // ([data-testid*='message'], [class*='message-item'], etc.) match NOTHING
    // on kimi.com. Generic fallbacks are kept last for robustness only.
    turnCandidates: [
      ".segment-user",
      ".segment-assistant",
      "[data-testid*='message']",
      "[class*='message-item']",
      "[role='listitem']",
    ],
    // Composer input: CONFIRMED via live inspection - Kimi uses a Lexical
    // editor rendered as <div class="chat-input-editor" contenteditable="true"
    // role="textbox" data-lexical-editor="true">. This is NOT a textarea.
    editorCandidates: [
      ".chat-input-editor[contenteditable='true']",
      "[contenteditable='true'][data-lexical-editor='true']",
      "[contenteditable='true'][role='textbox']",
      "div[contenteditable='true']",
      "textarea",
    ],
    // Reasoning / "thinking" panel, if Kimi shows one for reasoning models.
    thinkingCandidates: ["[class*='think']", "[class*='reasoning']"],
    errorSurfaces:
      '[class*="toast"],[class*="Toast"],[class*="notification"],[role="alert"],[class*="modal"],[class*="Modal"]',
  };

  // Error / state regexes — English, French, and Simplified Chinese (Kimi's
  // primary UI locale is Chinese; the site may also render zh copy even when
  // the browser is set to French/English). Extend as you see real strings.
  const RE = {
    // "token / context limit reached" in en/fr/zh - this is the piece you
    // specifically asked for: whenever Kimi's UI surfaces a context/token-limit
    // notice, scanError() below will catch it and the core treats it as a
    // "too_long" event (same handling path as DeepSeek/Gemini's contextLimit).
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "token.{0,10}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "limite.{0,20}(de contexte|de jetons|de tokens|atteinte)",
        "please.{0,30}start.{0,20}new.{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "maximum.{0,20}context",
        "已达到.{0,10}(上限|限制)",       // "reached the (cap|limit)"
        "上下文.{0,10}(过长|超出|超限)",   // "context too long / exceeded"
        "(令牌|token).{0,10}(超出|限制)",  // "token exceeded/limit"
        "对话.{0,10}(过长|太长)",         // "conversation too long"
        "请.{0,10}(开启|新建).{0,10}(对话|会话)", // "please start a new chat"
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)|对话.{0,10}(过长|太长)/i,
    busy: /server is busy|serveur est occup|please try again|réessayer plus tard|服务.{0,6}(繁忙|异常)|请稍后再试/i,
    // A "Continue / resume after truncation" button, matched by visible label
    // in en/fr/zh - same purpose as DeepSeek's .ds-button Continue control.
    continueBtn: /^(continue|continuer|继续(生成)?|fortfahren|continuar|seguir|続行)$/i,
  };

  const timings = {
    GEN_IDLE_MS: 1000,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── selector helpers (try each candidate until one matches) ─────────────
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

  // ── Turn classification ──────────────────────────────────────────────────
  // VERIFY: without live DOM we can't key off a hashed "user" modifier class
  // like deepseek.js does, so we classify by position (Kimi, like most chat
  // UIs, alternates user/assistant) combined with a best-effort content check:
  // an item that CONTAINS the live composer's editor is never a turn; beyond
  // that we fall back to alternating parity (even index = user, odd = model)
  // seeded from whichever the newest item's role appears to be. If your dump
  // shows a stable per-turn "role" attribute (e.g. data-role="user"), replace
  // this whole block with a direct attribute check - it will be much safer.
  function roleAttr(item) {
    if (!item) return null;
    const a =
      item.getAttribute("data-role") ||
      item.getAttribute("data-message-author-role") ||
      item.getAttribute("data-testid");
    if (!a) return null;
    if (/user|human|me/i.test(a)) return "user";
    if (/assistant|model|kimi|bot|ai/i.test(a)) return "assistant";
    return null;
  }

  // allItems(): return ALL chat turns (user + assistant) in DOCUMENT ORDER.
  // CRITICAL: pick() returns only the FIRST selector that matches, so we can't
  // use it for turnCandidates when user and assistant turns use different
  // classes (.segment-user vs .segment-assistant). Instead we query a combined
  // selector so both kinds are returned and then de-dupe + sort by document
  // position. This preserves the correct interleaving order the core relies on
  // for positional fallback and for knowing which turn is "last".
  function allItems() {
    const combined = S.turnCandidates.join(",");
    const els = [...document.querySelectorAll(combined)];
    if (els.length <= 1) return els;
    // De-dupe (a nested .segment-assistant inside a .segment-user is unlikely
    // but possible in edge cases) and sort by document order.
    const seen = new Set();
    const unique = els.filter((e) => {
      if (seen.has(e)) return false;
      seen.add(e);
      // Drop any element that is a descendant of another already-collected
      // turn (prevents double-counting nested turns).
      return !els.some((o) => o !== e && o.contains(e) && !e.contains(o));
    });
    return unique.sort((a, b) => {
      if (a === b) return 0;
      const rel = a.compareDocumentPosition(b);
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }
  function isUserItem(item) {
    if (!item) return false;
    // CONFIRMED: Kimi marks user turns with class "segment-user" and assistant
    // turns with class "segment-assistant". Check these directly first - far
    // more reliable than positional parity (which breaks if Kimi ever shows
    // two consecutive assistant turns or inserts system messages).
    if (item.classList && item.classList.contains("segment-user")) return true;
    if (item.classList && item.classList.contains("segment-assistant")) return false;
    // 2. A role attribute on the turn or its parent.
    const r = roleAttr(item);
    if (r) return r === "user";
    // 3. Fallback: even positional index among all turns = user (first message
    //    in any chat is always the user's).
    const items = allItems();
    return items.indexOf(item) % 2 === 0;
  }
  const isAssistantItem = (item) => !!item && !isUserItem(item);

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

  // Stable per-turn identity for ANY item (not just the last). Kimi (like most
  // React chat SPAs) may virtualize its message list, so a positional index is
  // NOT stable once old turns detach. We prefer a stable attribute on the turn
  // or its parent - try the common React/Vue virtual-list keys, then fall back
  // to the item's own data-id / aria id, and finally null (the core handles a
  // null key gracefully with positional fallback). This mirrors deepseek.js's
  // itemKey() so the core's off-DOM dedupe maps (executed/halted) survive
  // virtualization and scrolling.
  function itemKey(item) {
    if (!item) return null;
    // 1. A virtual-list key on the parent wrapper (React/Vue common pattern).
    const p = item.parentElement;
    if (p) {
      const vk =
        p.getAttribute("data-virtual-list-item-key") ||
        p.getAttribute("data-key") ||
        p.getAttribute("data-id");
      if (vk != null) return vk;
    }
    // 2. A stable id directly on the turn element.
    const ik =
      item.getAttribute("data-id") ||
      item.getAttribute("data-message-id") ||
      item.getAttribute("data-turn-id") ||
      item.getAttribute("id");
    if (ik) return ik;
    // 3. Last resort: a synthetic key from the role + text hash, so two turns
    //    with the same role but different content never collide. This is NOT
    //    virtualization-safe (the text can change as a stream settles) but it
    //    is far better than a raw positional index.
    const role = isAssistantItem(item) ? "a" : "u";
    const txt = (item.textContent || "").slice(0, 60);
    return `${role}:${txt.length}:${txt.slice(0, 12)}`;
  }

  // The id of the newest assistant turn - the core uses this as a
  // virtualization-safe "send token" so it can tell two back-to-back tool
  // turns apart even when assistantCount() stalls on a virtualized list.
  function lastAssistantId() {
    const last = lastAssistant();
    return itemKey(last);
  }

  // ── Composer ──────────────────────────────────────────────────────────
  const getEditor = () => {
    for (const sel of S.editorCandidates) {
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
    if (isTextarea(ed)) {
      if (on) {
        if (!ed.dataset.clPlaceholder) ed.dataset.clPlaceholder = ed.getAttribute("placeholder") || "";
        ed.setAttribute("readonly", "");
        ed.setAttribute("placeholder", "⏳ Agent working… please wait");
      } else {
        ed.removeAttribute("readonly");
        if (ed.dataset.clPlaceholder != null) ed.setAttribute("placeholder", ed.dataset.clPlaceholder);
      }
    } else {
      ed.setAttribute("contenteditable", on ? "false" : "true");
    }
  }

  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => chatIsEmpty() && !!getEditor();
  function composerFrame() {
    const ed = getEditor();
    if (!ed) return null;
    let n = ed;
    for (let i = 0; i < 6 && n.parentElement; i++) n = n.parentElement;
    return n;
  }
  // barMount() is intentionally DISABLED for Kimi: inserting #cl-bar into
  // .chat-input-editor-container (a Vue-managed node) makes Vue's next diff
  // reuse the bar as a host and nest the editor INSIDE it, so the overlay
  // vanishes on the first re-render. Returning null makes core/main.js
  // placeBar() fall through to barAnchor() below, which keeps the bar in
  // #cl-root and positions it with position:fixed + reserved padding-top on
  // the composer's outer container - safe for Vue/React SPAs.
  function barMount() {
    return null;
  }
  // barAnchor(): return the composer element to "hug" with the anchored bar.
  // We pick .chat-editor-content (the stable outer wrapper of the composer that
  // is NOT itself re-diffed away by Vue) so the bar sits flush on its top edge
  // and the reserved paddingTop pushes the editor down without overlap. Falls
  // back to .chat-input then .chat-input-editor-container if the outer wrapper
  // is absent (e.g. a different Kimi layout revision).
  function barAnchor() {
    return (
      document.querySelector(".chat-editor-content") ||
      document.querySelector(".chat-input") ||
      document.querySelector(".chat-input-editor-container") ||
      null
    );
  }

  // ── Send / stop button detection ───────────────────────────────────────────
  // Kimi's send button is <div class="send-button-container"> with NO aria-label,
  // NO title, NO button tag - only an inner SVG whose `name` attribute is "Send".
  // The same div toggles its SVG `name` to "Stop" while generating. So we detect
  // by CLASS NAME first (most reliable), then by SVG `name` attribute, then by
  // aria-label/title text as a last-resort fallback for other Kimi layouts.
  const SEND_RE = /^(send|envoyer|发送)$/i;
  const STOP_RE = /^(stop|arr[eê]ter|停止|暂停)$/i;
  // SVG `name` attribute used by Kimi's icon set (Send / Stop / etc.).
  const iconName = (el) => {
    const svg = el && el.querySelector("svg");
    if (!svg) return "";
    return (svg.getAttribute("name") || svg.getAttribute("data-name") || "").trim();
  };
  function composerButtons() {
    const frame = composerFrame();
    if (!frame) return [];
    // Kimi uses <div> buttons, not <button> - collect both.
    return [...frame.querySelectorAll("button, .send-button-container, [class*='send-button'], [class*='stop-button']")]
      .filter((b) => b.offsetParent !== null);
  }
  function findButtonByLabel(re) {
    return (
      composerButtons().find((b) => {
        const label = (b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent || "").trim();
        return re.test(label);
      }) || null
    );
  }
  // Primary detection: Kimi's send/stop are <div class="send-button-container">
  // with an inner SVG name="Send" / "Stop". Match by class + SVG name.
  function findSendButton() {
    // 1. The verified Kimi selector.
    const byClass = document.querySelector(".send-button-container");
    if (byClass && byClass.offsetParent !== null) return byClass;
    // 2. Any element whose SVG name attribute is "Send".
    for (const b of composerButtons()) {
      if (iconName(b) === "Send") return b;
    }
    // 3. Fallback: aria-label/title text match (other Kimi layouts).
    return findButtonByLabel(SEND_RE);
  }
  function findStopButton() {
    // 1. Stop button container (Kimi reuses send-button-container with a Stop SVG,
    //    but some layouts have a dedicated stop class).
    const byClass = document.querySelector(".stop-button-container, .send-button-container.stop");
    if (byClass && byClass.offsetParent !== null) return byClass;
    // 2. Any element whose SVG name attribute is "Stop".
    for (const b of composerButtons()) {
      if (iconName(b) === "Stop") return b;
    }
    // 3. The send-button-container itself may host the Stop icon while generating.
    const sendBox = document.querySelector(".send-button-container");
    if (sendBox && sendBox.offsetParent !== null && iconName(sendBox) === "Stop") return sendBox;
    // 4. Fallback: aria-label/title text match.
    return findButtonByLabel(STOP_RE);
  }
  const sendButton = findSendButton;
  const stopButton = findStopButton;

  // ── Generation / completion detection ─────────────────────────────────
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
    if (stopButton()) return true; // an explicit stop control = generating
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = () => !!stopButton();

  const turnHalted = () => false; // VERIFY if Kimi shows a "stopped" marker
  // A "Continue / resume" button Kimi may surface after a truncated reply.
  // Matched by visible label (en/fr/zh) across all visible buttons, not just
  // the composer toolbar - Kimi typically renders it at the foot of the
  // truncated message. Mirrors deepseek.js's findContinueBtn.
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

  // Break isGenerating() into its sub-signals so the core's chip.why tracker
  // can show WHICH one flickered false (a "chip shows done but the model is
  // still writing" report is diagnosed from this). Mirrors deepseek.js's
  // genDebug() - the fields are read by main.js's diag("chip.why", { g: ... }).
  function genDebug() {
    try {
      sampleStream();
      const stop = stopButton();
      return {
        stopBtn: !!stop,
        stopLabel: stop ? (stop.getAttribute("aria-label") || stop.getAttribute("title") || stop.textContent || "").trim().slice(0, 20) : "",
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

  // ── Sending ───────────────────────────────────────────────────────────
  function setTextareaValue(el, v) {
    const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function setContentEditableValue(el, v) {
    el.focus();
    // Kimi uses a Lexical editor. Clear any existing content first (selectAll
    // + delete), then insert the new text. A bare selectAll + insertText can
    // leave stale text in Lexical when the editor already has content (confirmed
    // via live testing on kimi.com), so we explicitly delete first.
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("selectAll");
    document.execCommand("delete");
    document.execCommand("insertText", false, v);
  }

  // Generic head+tail truncation so a huge tool result never wedges the
  // composer. No confirmed Kimi character cap - this is a conservative
  // default; tighten SEND_MAX if you find Kimi's real limit.
  const SEND_MAX = 100000;
  function truncateForSend(text) {
    if (!text || text.length <= SEND_MAX) return text;
    const omitted = text.length - SEND_MAX;
    const marker =
      `\n\n[…CoreLua: result truncated - ${omitted} of ${text.length} characters ` +
      `omitted to fit Kimi's composer. Do NOT re-run the command; work with the ` +
      `head and tail shown here…]\n\n`;
    const budget = SEND_MAX - marker.length;
    const headLen = Math.floor(budget * 0.85);
    const tailLen = budget - headLen;
    return text.slice(0, headLen) + marker + text.slice(text.length - tailLen);
  }

  async function typeAndSend(text /*, images */) {
    const ed = getEditor();
    if (!ed) throw new Error("Kimi input box not found");
    text = truncateForSend(text);
    ed.focus();
    if (isTextarea(ed)) setTextareaValue(ed, text);
    else setContentEditableValue(ed, text);
    await waitFor(() => !!sendButton(), 2000);
    const btn = sendButton();
    if (btn) { btn.click(); return; }
    // Fallback: Enter usually sends in single-line composers.
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    ed.dispatchEvent(new KeyboardEvent("keydown", o));
    ed.dispatchEvent(new KeyboardEvent("keyup", o));
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) try { b.click(); } catch {}
  }

  function enforceComposer() { return { ready: true }; }
  // ensureComposerReady(): poll for the Lexical editor to appear. Kimi is a
  // Vue SPA that renders the composer asynchronously after route changes (e.g.
  // navigating to /chat/xxx or opening a new chat), so getEditor() may return
  // null for a second or two right after page load. Without polling, the core's
  // startSession() would bail with "mode not ready" on a freshly-loaded Kimi
  // tab. We wait up to 15s (matching claude.js) for the editor to appear.
  async function ensureComposerReady() {
    if (getEditor()) return { ready: true };
    const found = await waitFor(() => !!getEditor(), 15000);
    return { ready: found };
  }

  // ── Error / limit detection ────────────────────────────────────────────
  // This is what surfaces "token/context limit reached" to the core: it scans
  // visible toast/alert/modal surfaces for RE.contextLimit and, if found,
  // returns the matched text so core/main.js treats it as a too_long event
  // (same handling as DeepSeek's/Gemini's contextLimit regex).
  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.turnCandidates.join(","))) continue; // model content, not UI chrome
        const t = (el.innerText || "").trim();
        if (t.length > 4 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text) || RE.contextLimit.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // ── Image attachment (best-effort; VERIFY Kimi's real upload path) ─────
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

  // ── User-send interception ─────────────────────────────────────────────
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
        // The native "Continue" button = a clear intent to RESUME after a stop/
        // truncation. Match it by label BEFORE the send/stop checks so a
        // Continue button is never mistaken for a plain send. Mirrors
        // deepseek.js's onNativeContinue handling.
        const cont = t && t.closest && t.closest("button");
        if (cont && cont !== sendButton() && cont !== stopButton() &&
            RE.continueBtn.test((cont.innerText || cont.textContent || "").trim())) {
          handlers.onNativeContinue();
          return;
        }
        // Kimi's send/stop are <div class="send-button-container"> (NOT <button>),
        // so t.closest("button") returns null for them. Check the send/stop
        // button containers directly: if the click landed inside one, treat it
        // as a send/stop click. This is the Kimi-specific fix - the generic
        // button-closest path below still handles real <button> elements.
        const sb = sendButton();
        const stb = stopButton();
        if (sb && t && sb.contains(t)) {
          if (handlers.isBlocked()) return;
          if (!handlers.isStarted()) {
            if (!chatIsEmpty()) return;
            handlers.onBlockedAttempt();
            return;
          }
          handlers.onUserMessage(assistantCount());
          return;
        }
        if (stb && t && stb.contains(t)) {
          if (!e.isTrusted) return;
          handlers.onNativeStop();
          return;
        }
        // Generic <button> path (for any real button elements in Kimi's UI).
        const btn = t && t.closest && t.closest("button");
        if (!btn) return;
        if (btn === stopButton()) {
          if (!e.isTrusted) return;
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

  // ── Tool-block location for camouflage ──────────────────────────────────────────────────────────────
  // Hide the raw tool call so nothing of it leaks beside the core's chip.
  // Kimi's markdown (like DeepSeek's) often SPLITS a ###LUA### … ###END_LUA###
  // block across several <p> paragraphs, so we hide the whole CONTIGUOUS RUN of
  // block-level children from the start marker through the end marker. We also
  // handle fenced code blocks (Kimi renders ```lua fences as a <pre>/<code>
  // wrapper) and bare JSON {"command":…} blocks. Returns where to insert the
  // chip: {parent, ref} - or null if no tool block was found. Mirrors
  // deepseek.js's findToolBlockSpot (validated live) so the camouflage is robust
  // even though kimi.js was not validated against the live DOM.
  function findToolBlockSpot(item, chip) {
    const P2 = CLParse;
    const hasStart = (t) => P2.LUA_START_RE.test(t) || t.includes("###mcp_tool###");
    const hasEnd = (t) => P2.LUA_END_RE.test(t) || t.includes("###end_mcp_tool###") || t.includes("###end-mcp_tool###");
    const isJson = (t) => /\{\s*"(?:command|tool)"\s*:/.test(t);
    // The reply markdown containers: try common Kimi/React markdown wrappers,
    // falling back to the item itself if none match. Exclude the
    // reasoning/think area (the camouflage never hides a quoted command there).
    const mdSel = "[class*='markdown'], .markdown-body, [class*='prose'], .prose";
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
        // Found the start of a tool block. Hide this child…
        const runStart = i;
        let runEnd = i;
        if (startsBlock && !hasEnd(tLow)) {
          // multi-element LUA/MCP block → extend until the end marker (or, if the
          // turn is still truncated, to the end of this container).
          let j = i + 1;
          runEnd = kids.length - 1;
          for (; j < kids.length; j++) {
            if (hasEnd((kids[j].textContent || "").toLowerCase())) { runEnd = j; break; }
          }
        }
        for (let k = runStart; k <= runEnd; k++) {
          // Prefer hiding the whole code-block wrapper (language label / Copy bar)
          // so the fenced ```lua block's chrome is hidden too, not just the <pre>.
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
    id: "kimi",
    displayName: "Kimi",
    // VERIFY: flip true once you confirm Kimi's web chat accepts pasted/
    // uploaded images and the model actually reads them (K2.5+ supports
    // native vision per Moonshot's own announcements, but the WEB UI upload
    // path needs to be confirmed before screen_capture is safe to expose).
    supportsVision: false,
    timings,
    thinkingSel: S.thinkingCandidates.join(","),
    chipAtItemLevel: true,
    // Kimi (like Qwen) re-appends fresh reply content AFTER a chip pinned as
    // firstChild, silently shoving it above the text it was meant to trail. Opt
    // into chipAppend so the chip is placed LAST (trailing the reply text, in
    // the model's actual read order: narration, then the tool call it wrote at
    // the end of the turn). The core's chip-drift guards (sweep + ensureOwnedChip)
    // keep it seated through Vue/React re-renders. main.js line ~3575 explicitly
    // treats Kimi as a chipAppend provider, so this MUST be true.
    chipAppend: true,
    reliableCounts: false,
    init({ diag: d } = {}) { if (d) diag = d; },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating, genDebug,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();
