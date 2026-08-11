// SPDX-License-Identifier: GPL-3.0-or-later
// background.js - service worker.
// Owns ONE resilient WebSocket to the local bridge (ws://127.0.0.1:PORT).
// Keeping the socket here (not in the content script) avoids https→ws mixed
// content issues and centralises reconnect / timeout logic.
//
// Contract with content.js: every sendMessage ALWAYS gets a response object,
// even when the bridge is offline. The agentic loop must never hang waiting.

const DEFAULT_PORT = 47170;
let bridgePort = DEFAULT_PORT;

function normalisePort(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}

function bridgeUrl() {
  return `ws://127.0.0.1:${bridgePort}`;
}

// Chat sites where a CoreLua provider content script runs. Status pushes go
// to every tab matching these. Add the new provider's URL pattern here (and in
// manifest.json content_scripts + host_permissions) when integrating another AI.
const PROVIDER_URLS = ["https://chat.deepseek.com/*", "https://gemini.google.com/*", "https://kimi.com/*", "https://claude.ai/*"];

// Reconnect strategy: exponential backoff with a jitter so that, when the
// bridge comes back online, every simultaneously-disconnected extension does
// not retry on the exact same millisecond (a classic thundering-herd retry
// storm that briefly spikes the bridge's accept queue). Backoff is capped so
// a long outage still reconnects within a few seconds of recovery.
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 5000;
const JITTER_MS = 400; // ± up to this many ms of random spread
const HEARTBEAT_MS = 10000;
// If no message (incl. pong) arrives within this window while we believe we're
// connected, the socket is half-open: force a reconnect instead of letting
// pending requests slowly time out.
const STALE_SOCKET_MS = 25000;
const REQUEST_TIMEOUT_DEFAULT = 130000; // a bit above the 120s tool timeout

let ws = null;
let wsGen = 0; // incremented on every connect() — guards stale-socket callbacks
let connected = false;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastMessageAt = 0; // timestamp of the last frame received from the bridge
let connectAttempts = 0; // total connect attempts this session (for diagnostics)
let lastConnectError = null; // last error observed during a connect attempt
let nextId = 1;
const pending = new Map(); // id -> {resolve, timer}
let toolsCache = [];
let mcpAlive = false;
let serversCache = [];
// true/false = a PLACE is loaded and usable in Roblox Studio; null = unknown.
// The MCP process stays alive when Studio is closed or its MCP option is off,
// so this is probed separately (bridge "studio_status").
let studioConnected = null;
// true/false = a Roblox Studio app is connected to the MCP server at all; null =
// unknown. studioApp=true with studioConnected=false means "Studio open but no
// place"; studioApp=false means "Studio closed OR its MCP option disabled".
let studioApp = null;
// true/false = a Roblox Studio WINDOW/PROCESS exists on this machine (checked
// bridge-side via tasklist); null = unknown/old bridge. Distinguishes the two
// studioApp=false sub-cases the UI must word differently: Studio genuinely not
// launched ("open Roblox Studio") vs Studio OPEN but its MCP plugin never
// registered with the bridge - the documented fix for the latter is opening
// Assistant Settings > MCP Servers inside Studio (validated live 3x), which
// "open Roblox Studio" wording completely fails to convey.
let studioProc = null;

// Structured leveled logger. Keeps the service-worker console readable while
// still surfacing the rare error and the connect-failure cause (which used to
// be swallowed silently, leaving only "disconnected" with no hint why).
const LOG_DEBUG = false; // flip to true to trace every frame / reconnect tick
function log(...a) {
  console.log("[cl-bg]", ...a);
}
function logErr(...a) {
  console.error("[cl-bg]", ...a);
}
function logDbg(...a) {
  if (LOG_DEBUG) console.debug("[cl-bg]", ...a);
}

// ── WebSocket lifecycle ─────────────────────────────────────────────────
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  clearTimeout(reconnectTimer);
  connectAttempts++;
  const gen = ++wsGen;
  try {
    ws = new WebSocket(bridgeUrl());
  } catch (e) {
    lastConnectError = String(e);
    logErr("WebSocket ctor failed", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    if (gen !== wsGen) return; // stale socket from a superseded connect()
    connected = true;
    reconnectDelay = RECONNECT_MIN;
    lastMessageAt = Date.now();
    lastConnectError = null;
    log(
      `connected to bridge on port ${bridgePort} ` +
      `(after ${connectAttempts} attempt${connectAttempts === 1 ? "" : "s"})`
    );
    startHeartbeat();
    broadcastStatus();
  };

  ws.onmessage = (ev) => {
    if (gen !== wsGen) return; // stale socket
    lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      logDbg("dropped non-JSON frame");
      return;
    }
    handleBridgeMessage(msg);
  };

  ws.onclose = () => {
    if (gen !== wsGen) return; // stale socket — its replacement already reconnected
    const wasConnected = connected;
    connected = false;
    mcpAlive = false;
    studioConnected = null;
    studioApp = null;
    studioProc = null;
    serversCache = [];
    stopHeartbeat();
    failAllPending("bridge connection closed");
    if (wasConnected) {
      log("bridge connection closed, will retry");
    } else if (connectAttempts <= 3) {
      // Log the first few failed connect attempts so the console is not silent
      // during a bridge outage (the popup diagnostics show this too, but the
      // service-worker console should not be a black hole either).
      log(`connect attempt ${connectAttempts} failed${lastConnectError ? ": " + lastConnectError : ""}`);
    }
    broadcastStatus();
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    if (gen !== wsGen) return; // stale socket
    // Capture the failure reason so the popup / diagnostics can show WHY the
    // bridge is unreachable instead of just "offline". onclose follows; do not
    // double-close if the socket is already closing.
    lastConnectError = e && e.message ? e.message : "connection refused";
    logDbg("socket error:", lastConnectError);
    try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch {}
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  // Exponential backoff capped at RECONNECT_MAX, plus a random jitter so a
  // fleet of extensions recovering from the same bridge outage do not all
  // reconnect on the same tick.
  const jitter = Math.floor((Math.random() - 0.5) * 2 * JITTER_MS);
  const delay = Math.min(reconnectDelay, RECONNECT_MAX) + jitter;
  reconnectTimer = setTimeout(connect, Math.max(RECONNECT_MIN, delay));
  reconnectDelay = Math.min(reconnectDelay * 1.7, RECONNECT_MAX);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (connected) {
      // Half-open socket: the WS still reports OPEN but nothing comes through.
      // The pong (and every other frame) refreshes lastMessageAt; if it has
      // gone stale, drop the dead socket so onclose triggers a reconnect.
      if (lastMessageAt && Date.now() - lastMessageAt > STALE_SOCKET_MS) {
        log("socket stale, forcing reconnect");
        try { ws.close(); } catch {}
        return;
      }
      // Keeps the MV3 service worker alive AND detects a half-open socket.
      send({ type: "ping" }).catch(() => {});
      refreshStudioStatus();
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function setBridgePort(nextPort, { persist = true, reconnect = true } = {}) {
  const port = normalisePort(nextPort);
  const changed = port !== bridgePort;
  bridgePort = port;
  if (persist) {
    try { chrome.storage.local.set({ clBridgePort: port }); } catch {}
  }
  if (reconnect && changed) {
    lastConnectError = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try { ws.close(); } catch {}
    } else {
      connect();
    }
  }
  return port;
}

// Resolve once the socket is OPEN, or false after `timeout` ms.
function waitForConnection(timeout = 8000) {
  return new Promise((resolve) => {
    if (connected && ws && ws.readyState === WebSocket.OPEN) return resolve(true);
    connect(); // nudge a (re)connection - important after a worker wake-up
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (connected && ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > timeout) {
        clearInterval(iv);
        resolve(false);
      }
    }, 100);
  });
}

// ── request/response over the socket ────────────────────────────────────
async function send(obj, timeout = REQUEST_TIMEOUT_DEFAULT) {
  // The MV3 service worker can be suspended; the first message after a wake-up
  // arrives before the socket has re-opened. Wait for it instead of failing -
  // otherwise Kimi wrongly hears "bridge offline".
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
    await waitForConnection(8000);
  }
  return new Promise((resolve) => {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, kind: "disconnected", error: "bridge not connected" });
      return;
    }
    const id = nextId++;
    const payload = { ...obj, id };
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, kind: "timeout", error: "bridge did not respond in time" });
      }
    }, timeout);
    pending.set(id, { resolve, timer });
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, kind: "disconnected", error: String(e) });
    }
  });
}

// Ask the bridge whether a Roblox Studio instance is actually connected to the
// MCP server. Broadcasts only on change so the UI updates promptly but quietly.
let studioProbing = false;
async function refreshStudioStatus() {
  if (studioProbing || !connected) return;
  studioProbing = true;
  try {
    const r = await send({ type: "studio_status" }, 12000);
    const v = r && r.ok && typeof r.studio === "boolean" ? r.studio : null;
    if (v !== studioConnected) {
      studioConnected = v;
      broadcastStatus();
    }
  } finally {
    studioProbing = false;
  }
}

function handleBridgeMessage(msg) {
  if ("studio" in msg && (typeof msg.studio === "boolean" || msg.studio === null)) {
    studioConnected = msg.studio;
  }
  if ("studio_app" in msg && (typeof msg.studio_app === "boolean" || msg.studio_app === null)) {
    studioApp = msg.studio_app;
  }
  if ("studio_proc" in msg && (typeof msg.studio_proc === "boolean" || msg.studio_proc === null)) {
    studioProc = msg.studio_proc;
  }
  if (msg.type === "studio_status") {
    resolvePending(msg.id, { ok: true, studio: studioConnected });
    broadcastStatus();
    return;
  }
  if (msg.type === "connected") {
    mcpAlive = !!msg.mcp_alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    broadcastStatus();
    return;
  }
  if (msg.type === "pong") {
    resolvePending(msg.id, { ok: true });
    return;
  }
  if (msg.type === "tools") {
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    mcpAlive = !!msg.mcp_alive;
    resolvePending(msg.id, { ok: true, tools: toolsCache });
    broadcastStatus();
    return;
  }
  if (msg.type === "tool_result") {
    resolvePending(msg.id, msg.ok
      ? { ok: true, text: msg.text, images: msg.images || [] }
      : { ok: false, kind: msg.kind, error: msg.error });
    return;
  }
  if (msg.type === "mcp_status") {
    mcpAlive = !!msg.alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    resolvePending(msg.id, { ok: !!msg.ok, alive: msg.alive, error: msg.error });
    broadcastStatus();
    return;
  }
  if (msg.type === "server_changed") {
    // The bridge acks, then restarts itself to reload config.json. The socket
    // will drop right after this - the content script shows a spinner until the
    // reconnect lands and a fresh status arrives.
    resolvePending(msg.id, { ok: !!msg.ok, error: msg.error, restarting: !!msg.restarting });
    return;
  }
  if (msg.type === "error") {
    resolvePending(msg.id, { ok: false, error: msg.error });
    return;
  }
}

function resolvePending(id, value) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(value);
}

function failAllPending(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, kind: "disconnected", error: reason });
  }
  pending.clear();
}

// ── status push to any open DeepSeek tab + popup ─────────────────────────
function statusObj() {
  return {
    type: "cl-status",
    bridgePort,
    connected,
    mcpAlive,
    studio: studioConnected,
    studioApp,
    studioProc,
    tools: toolsCache.length,
    servers: serversCache,
    // Diagnostic context so the popup can explain an offline state instead of
    // just showing "Bridge offline" with no cause.
    connectAttempts,
    lastError: lastConnectError,
  };
}

function broadcastStatus() {
  chrome.runtime.sendMessage(statusObj()).catch(() => {});
  chrome.tabs.query({ url: PROVIDER_URLS }, (tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, statusObj()).catch(() => {});
  });
}

// ── messages from content.js / popup.js ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "status":
        if (!connected) connect(); // self-heal after a worker wake-up
        sendResponse(statusObj());
        break;
      case "list_tools": {
        // Prefer a live refresh; fall back to cache so the loop never stalls.
        // 10s, not 25s: a catalogue request only blocks this long when one of the
        // MCP servers is dead (typically Roblox in a degraded, Blender-only
        // session), and in that exact case we already hold a perfectly good cached
        // catalogue. Waiting the full 25s just froze the boot for no new data.
        const r = await send({ type: "list_tools" }, 10000);
        if (r.ok) sendResponse({ ok: true, tools: r.tools });
        else sendResponse({ ok: toolsCache.length > 0, tools: toolsCache, error: r.error });
        break;
      }
      case "call_tool": {
        const timeout = (msg.timeout || 120000) + 10000;
        const r = await send(
          { type: "call_tool", name: msg.name, arguments: msg.arguments, timeout: msg.timeout },
          timeout
        );
        sendResponse(r);
        break;
      }
      case "restart_mcp": {
        const r = await send({ type: "restart_mcp" }, 30000);
        sendResponse(r);
        break;
      }
      case "set_bridge_port": {
        const raw = msg.port;
        const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
          sendResponse({ ok: false, error: "invalid port" });
          break;
        }
        const port = setBridgePort(parsed, { persist: true, reconnect: true });
        broadcastStatus();
        sendResponse({ ok: true, port });
        break;
      }
      case "add_server": {
        const r = await send({
          type: "add_server", server_id: msg.server_id,
          command: msg.command, args: msg.args, env: msg.env,
        }, 15000);
        sendResponse(r);
        break;
      }
      case "remove_server": {
        const r = await send({ type: "remove_server", server_id: msg.server_id }, 15000);
        sendResponse(r);
        break;
      }
      case "reconnect":
        reconnectDelay = RECONNECT_MIN;
        connect();
        sendResponse({ ok: true });
        break;
      case "notify": {
        // Desktop notification fired by the content script (e.g. when a long
        // agent session finishes). Service-worker context is the only place a
        // chrome.notifications.create call is allowed from a content script's
        // behalf, so the content script routes it through here.
        try {
          const nid = "corelua-" + Date.now();
          chrome.notifications.create(nid, {
            type: "basic",
            iconUrl: chrome.runtime.getURL("icon.png"),
            title: msg.title || "CoreLua",
            message: msg.message || "",
            priority: 0,
          });
          // Auto-clear after 8s so stale notifications don't pile up.
          setTimeout(() => { try { chrome.notifications.clear(nid); } catch {} }, 8000);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async sendResponse
});

// Wake/keepalive hooks.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

try {
  chrome.storage.local.get("clBridgePort", (r) => {
    setBridgePort(r && r.clBridgePort, { persist: false, reconnect: false });
    connect();
    broadcastStatus();
  });
} catch {
  connect();
}
