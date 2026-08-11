// SPDX-License-Identifier: GPL-3.0-or-later
// popup.js - CoreLua extension popup controller.
// Talks to the background service worker (background.js) over chrome.runtime.
// Every status change re-renders the hero, info cards, server list and the
// offline error hint so the popup always reflects the live bridge state.

const SUPPORTED_HOSTS = [
  "chat.deepseek.com", "deepseek.com", "gemini.google.com", "kimi.com", "claude.ai",
];
const DEFAULT_AI_URL = "https://chat.deepseek.com/";

// ── Element refs ────────────────────────────────────────────
const el = {
  ver:       document.getElementById("ver"),
  hero:      document.getElementById("hero"),
  stTitle:   document.getElementById("stTitle"),
  stDetail:  document.getElementById("stDetail"),
  cTools:    document.getElementById("cTools"),
  cServers:  document.getElementById("cServers"),
  servers:   document.getElementById("servers"),
  serversList: document.getElementById("serversList"),
  errHint:   document.getElementById("errHint"),
  bridgePort: document.getElementById("bridgePort"),
  savePort: document.getElementById("savePort"),
  openAi:    document.getElementById("openAi"),
  reconnect: document.getElementById("reconnect"),
  restart:   document.getElementById("restart"),
  settings:  document.getElementById("settings"),
  diagToggle: document.getElementById("diagToggle"),
  diagBody:   document.getElementById("diagBody"),
  diagChevron: document.getElementById("diagChevron"),
  dPort:      document.getElementById("dPort"),
  dAttempts:  document.getElementById("dAttempts"),
  dError:     document.getElementById("dError"),
  dStudioApp: document.getElementById("dStudioApp"),
  dStudioProc: document.getElementById("dStudioProc"),
  dStudioPlace: document.getElementById("dStudioPlace"),
  dMcpAlive:  document.getElementById("dMcpAlive"),
  dExtVer:    document.getElementById("dExtVer"),
};

el.ver.textContent = `v${chrome.runtime.getManifest().version}`;

// Escape arbitrary strings before interpolating them into innerHTML. Server
// IDs and lastError strings come from the bridge, which is loopback-trusted,
// but defence-in-depth prevents a malformed server id (or a future remote
// status source) from injecting markup. Also used for the error-hint cause.
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Diagnostics panel toggle (collapsed by default to keep the popup compact).
el.diagToggle.addEventListener("click", () => {
  const open = el.diagBody.hasAttribute("hidden");
  if (open) {
    el.diagBody.removeAttribute("hidden");
    el.diagChevron.classList.add("open");
  } else {
    el.diagBody.setAttribute("hidden", "");
    el.diagChevron.classList.remove("open");
  }
});

// Helper: render a boolean/diagnostic value with a coloured class.
function diagVal(elNode, val, labels) {
  const truthy = val === true;
  const falsy = val === false;
  elNode.textContent = val == null ? "\u2014" : (truthy ? (labels && labels["true"] || "yes") : falsy ? (labels && labels["false"] || "no") : String(val));
  elNode.className = "diag-v" + (truthy ? " ok" : falsy ? " err" : "");
}

// ── Render a status snapshot from the background ────────────
function render(s) {
  s = s || {};
  const list = Array.isArray(s.servers) ? s.servers : [];
  const up = list.filter((x) => x.alive).length;
  const mcpOk = s.connected && (s.mcpAlive || up > 0 || (s.tools || 0) > 0);
  const studioOff = mcpOk && s.studio === false; // MCP up but no Studio attached
  const ok = mcpOk && !studioOff;
  const port = Number.isInteger(s.bridgePort) ? s.bridgePort : 47170;

  if (document.activeElement !== el.bridgePort) {
    el.bridgePort.value = String(port);
  }

  // Hero state + headline copy.
  el.hero.className = "hero " + (s.connected ? (ok ? "ok" : "warn") : "off");
  if (!s.connected) {
    el.stTitle.textContent = "Bridge offline";
    el.stDetail.textContent = "Run the CoreLua bridge on your PC to continue.";
  } else if (ok) {
    el.stTitle.textContent = "Connected";
    el.stDetail.textContent = "Roblox Studio ready — start a chat on a supported AI.";
  } else if (studioOff) {
    el.stTitle.textContent = "Studio not connected";
    el.stDetail.textContent = "Enable the MCP server in Studio's Assistant settings.";
  } else {
    el.stTitle.textContent = "Bridge OK";
    el.stDetail.textContent = "Open Roblox Studio and load a place.";
  }

  // Info cards.
  el.cTools.textContent = s.connected ? String(s.tools || 0) : "—";
  el.cTools.className = "stat-val" + (s.connected && (s.tools || 0) > 0 ? "" : " dim");
  el.cServers.textContent = s.connected ? `${up}/${list.length}` : "—";
  el.cServers.className = "stat-val" + (s.connected && up > 0 ? "" : " dim");

  // Server list (shown only when the bridge is up and there is at least one).
  if (s.connected && list.length) {
    el.servers.classList.add("show");
    el.serversList.innerHTML = list
      .map((x) =>
        `<div class="srv-row">
           <span class="srv-dot ${x.alive ? "alive" : "dead"}"></span>
           <span class="srv-name">${esc(x.id)}</span>
           <span class="srv-tools">${x.alive ? esc(x.tools) + " tools" : "down"}</span>
         </div>`)
      .join("");
  } else {
    el.servers.classList.remove("show");
  }

  // Offline error hint: show the underlying cause (refused / timeout / …) plus
  // the reconnect attempt count so a stuck bridge is easy to diagnose.
  if (!s.connected) {
    const cause = s.lastError ? String(s.lastError) : "";
    const attempts = s.connectAttempts || 0;
    let hint = "";
    if (/refused|connrefused|cannot|unable/i.test(cause)) {
      hint = `The bridge is not running on port <b>${esc(port)}</b> on this machine. Run <b>start.bat</b> (Windows).`;
    } else if (cause) {
      hint = `Could not reach the bridge: <b>${esc(cause)}</b>.`;
    } else {
      hint = `Looking for the bridge on port <b>${esc(port)}</b>${attempts > 1 ? ` (attempt ${esc(attempts)})` : ""}… Run <b>start.bat</b> if this persists.`;
    }
    el.errHint.innerHTML = hint;
    el.errHint.classList.add("show");
  } else {
    el.errHint.classList.remove("show");
  }

  // Diagnostics panel (always rendered so it is ready when expanded).
  el.dPort.textContent = String(port);
  el.dPort.className = "diag-v";
  el.dAttempts.textContent = String(s.connectAttempts || 0);
  el.dAttempts.className = "diag-v" + ((s.connectAttempts || 0) > 3 ? " warn" : "");
  el.dError.textContent = s.lastError ? esc(s.lastError) : "\u2014";
  el.dError.className = "diag-v" + (s.lastError ? " err" : "");
  diagVal(el.dStudioApp, s.studioApp, { true: "attached", false: "not attached" });
  diagVal(el.dStudioProc, s.studioProc, { true: "running", false: "not running" });
  diagVal(el.dStudioPlace, s.studio, { true: "loaded", false: "no place" });
  diagVal(el.dMcpAlive, s.mcpAlive, { true: "alive", false: "down" });
  if (!el.dExtVer.textContent || el.dExtVer.textContent === "\u2014") {
    el.dExtVer.textContent = "v" + chrome.runtime.getManifest().version;
  }
}

// ── Bridge message round-trip helpers ───────────────────────
function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (s) => { if (s) render(s); });
}

el.reconnect.addEventListener("click", () => {
  el.reconnect.disabled = true;
  chrome.runtime.sendMessage({ type: "reconnect" }, () => {
    setTimeout(() => { el.reconnect.disabled = false; refresh(); }, 600);
  });
});

el.restart.addEventListener("click", () => {
  el.restart.disabled = true;
  const original = el.restart.innerHTML;
  el.restart.textContent = "Restarting…";
  chrome.runtime.sendMessage({ type: "restart_mcp" }, () => {
    el.restart.innerHTML = original;
    el.restart.disabled = false;
    setTimeout(refresh, 600);
  });
});

el.savePort.addEventListener("click", () => {
  const raw = String(el.bridgePort.value || "").trim();
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    el.errHint.innerHTML = `Choose a valid bridge port between <b>1</b> and <b>65535</b>.`;
    el.errHint.classList.add("show");
    el.bridgePort.focus();
    return;
  }
  el.savePort.disabled = true;
  const original = el.savePort.textContent;
  el.savePort.textContent = "Saving…";
  chrome.runtime.sendMessage({ type: "set_bridge_port", port }, (res) => {
    el.savePort.disabled = false;
    el.savePort.textContent = original;
    if (!res || !res.ok) {
      el.errHint.innerHTML = `Could not save the bridge port.`;
      el.errHint.classList.add("show");
      return;
    }
    setTimeout(refresh, 300);
  });
});

el.openAi.addEventListener("click", () => chrome.tabs.create({ url: DEFAULT_AI_URL }));

// Open the in-page Switch AI / support panel on an already-open supported AI
// tab if one exists (so settings work without a started conversation), else
// open a fresh AI tab.
el.settings.addEventListener("click", () => {
  chrome.tabs.query({}, (tabs) => {
    const active = tabs.find((t) => t.active && t.url && SUPPORTED_HOSTS.some((h) => t.url.includes(h)));
    const anySupported = active || tabs.find((t) => t.url && SUPPORTED_HOSTS.some((h) => t.url.includes(h)));
    if (anySupported) {
      chrome.tabs.sendMessage(anySupported.id, { type: "cl-open-menu" });
      chrome.tabs.update(anySupported.id, { active: true });
    } else {
      chrome.tabs.create({ url: DEFAULT_AI_URL });
    }
  });
});

// Live status push from the background worker + a polling fallback.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "cl-status") render(msg);
});
refresh();
setInterval(refresh, 2000);
