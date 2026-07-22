// Self-contained ops dashboard, served same-origin at GET /ops-dashboard. It
// polls this same process's own /api/health, /api/alerts/recent,
// /api/backup-status, and /api/ops-config -- no external requests, no CDN
// assets, so it works on a firewalled production host with no internet egress.
//
// Deliberately NOT a claude.ai Artifact: an artifact is viewed from an
// arbitrary browser, and this host has no confirmed public hostname (a
// hardcoded 127.0.0.1 would resolve to the VIEWER's machine, not this server).
// Serving it from the app itself means it's reachable however this backend is
// already reached, with no new exposure surface beyond the existing
// unauthenticated /api/health and /metrics endpoints it reads from.

export const OPS_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Momi Backend — Ops Dashboard</title>
<style>
  :root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --surface-2: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #898781;
    --gridline: #e1e0d9;
    --baseline: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --series-1: #2a78d6;
    --status-good: #0ca30c;
    --status-warning: #fab219;
    --status-serious: #ec835a;
    --status-critical: #d03b3b;
    --status-good-bg: rgba(12,163,12,0.10);
    --status-warning-bg: rgba(250,178,25,0.14);
    --status-serious-bg: rgba(236,131,90,0.14);
    --status-critical-bg: rgba(208,59,59,0.10);
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --surface-2: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted: #898781;
      --gridline: #2c2c2a;
      --baseline: #383835;
      --border: rgba(255,255,255,0.10);
      --series-1: #3987e5;
      --status-good: #0ca30c;
      --status-warning: #fab219;
      --status-serious: #ec835a;
      --status-critical: #e66767;
      --status-good-bg: rgba(12,163,12,0.16);
      --status-warning-bg: rgba(250,178,25,0.18);
      --status-serious-bg: rgba(236,131,90,0.18);
      --status-critical-bg: rgba(230,103,103,0.16);
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-1: #1a1a19; --surface-2: #0d0d0d; --text-primary: #ffffff;
    --text-secondary: #c3c2b7; --text-muted: #898781; --gridline: #2c2c2a;
    --baseline: #383835; --border: rgba(255,255,255,0.10); --series-1: #3987e5;
    --status-good: #0ca30c; --status-warning: #fab219; --status-serious: #ec835a; --status-critical: #e66767;
    --status-good-bg: rgba(12,163,12,0.16); --status-warning-bg: rgba(250,178,25,0.18);
    --status-serious-bg: rgba(236,131,90,0.18); --status-critical-bg: rgba(230,103,103,0.16);
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--surface-2);
    color: var(--text-primary);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.45;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 20px 20px 48px; }

  header.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  header.top h1 { font-size: 18px; font-weight: 650; margin: 0; }
  header.top .sub { color: var(--text-secondary); font-size: 12.5px; margin-top: 2px; }
  .top-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .clock { font-variant-numeric: tabular-nums; color: var(--text-secondary); font-size: 12.5px; }
  .refresh-note { color: var(--text-muted); font-size: 12px; }
  button.ghost {
    background: transparent; border: 1px solid var(--border); color: var(--text-primary);
    border-radius: 6px; padding: 5px 10px; font-size: 12.5px; cursor: pointer;
  }
  button.ghost:hover { background: var(--surface-1); }

  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px 4px 8px; border-radius: 999px; font-size: 12.5px; font-weight: 600; white-space: nowrap; }
  .pill .dot { width: 8px; height: 8px; border-radius: 999px; flex: none; }
  .pill.good { background: var(--status-good-bg); color: var(--status-good); }
  .pill.warning { background: var(--status-warning-bg); color: #8a5a00; }
  .pill.serious { background: var(--status-serious-bg); color: #8a3d1c; }
  .pill.critical { background: var(--status-critical-bg); color: var(--status-critical); }
  .pill.unknown { background: var(--surface-1); color: var(--text-muted); border: 1px solid var(--border); }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .pill.warning { color: #ffd980; }
    :root:where(:not([data-theme="light"])) .pill.serious { color: #ffc0a0; }
  }
  :root[data-theme="dark"] .pill.warning { color: #ffd980; }
  :root[data-theme="dark"] .pill.serious { color: #ffc0a0; }
  .pill.good .dot { background: var(--status-good); }
  .pill.warning .dot { background: var(--status-warning); }
  .pill.serious .dot { background: var(--status-serious); }
  .pill.critical .dot { background: var(--status-critical); }
  .pill.unknown .dot { background: var(--text-muted); }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card {
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px 16px; min-height: 108px; display: flex; flex-direction: column; gap: 6px;
  }
  .card .card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .card .label { color: var(--text-secondary); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em; }
  .card .value { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .card .value .unit { font-size: 13px; font-weight: 500; color: var(--text-secondary); margin-left: 4px; }
  .card .detail { color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .card .meter-track { height: 6px; border-radius: 999px; background: var(--gridline); overflow: hidden; margin-top: 2px; }
  .card .meter-fill { height: 100%; border-radius: 999px; transition: width 0.4s ease; }
  .spark-row { display: flex; align-items: flex-end; gap: 10px; }
  .spark-row svg { flex: none; }
  .spark-nums { color: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; line-height: 1.6; }

  section.panel { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px 6px; margin-bottom: 20px; }
  section.panel h2 { font-size: 13px; font-weight: 650; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
  section.panel h2 .count { color: var(--text-muted); font-weight: 500; font-size: 12px; }

  table.alerts { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  table.alerts th { text-align: left; color: var(--text-muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.02em; padding: 6px 8px; border-bottom: 1px solid var(--gridline); position: sticky; top: 0; background: var(--surface-1); }
  table.alerts td { padding: 7px 8px; border-bottom: 1px solid var(--gridline); vertical-align: top; }
  table.alerts tr:last-child td { border-bottom: none; }
  table.alerts .rule { font-weight: 600; }
  table.alerts .detail-cell { color: var(--text-secondary); max-width: 480px; }
  table.alerts .time-cell { color: var(--text-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .alerts-scroll { max-height: 340px; overflow-y: auto; }
  .empty-note { color: var(--text-muted); font-size: 12.5px; padding: 10px 2px 14px; }

  .conn-banner {
    display: none; background: var(--status-critical-bg); color: var(--status-critical);
    border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; font-size: 13px; margin-bottom: 16px;
  }
  .conn-banner.show { display: block; }

  footer.note { color: var(--text-muted); font-size: 11.5px; margin-top: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div>
      <h1>Momi Backend — Ops Dashboard</h1>
      <div class="sub" id="roleSub">connecting…</div>
    </div>
    <div class="top-right">
      <span class="pill unknown" id="overallPill"><span class="dot"></span>connecting</span>
      <span class="refresh-note" id="lastUpdated">—</span>
      <button class="ghost" id="pauseBtn" type="button">Pause</button>
    </div>
  </header>

  <div class="conn-banner" id="connBanner">Could not reach this process's own API. The page will keep retrying — if this persists, the backend may be down.</div>

  <div class="grid" id="statGrid"></div>

  <section class="panel">
    <h2>Queue depth <span class="count" id="queueSparkNote"></span></h2>
    <div class="spark-row" id="queueSparkRow"></div>
  </section>

  <section class="panel">
    <h2>Recent alerts <span class="count" id="alertsCount"></span></h2>
    <div class="alerts-scroll">
      <table class="alerts" id="alertsTable">
        <thead><tr><th>Rule</th><th>Phase</th><th>Severity</th><th>Role</th><th>Detail</th><th>When</th></tr></thead>
        <tbody id="alertsBody"></tbody>
      </table>
      <div class="empty-note" id="alertsEmpty" style="display:none;">No alerts recorded by this process yet.</div>
    </div>
  </section>

  <footer class="note">
    Same-origin data only, refreshed every 5s. Thresholds shown are read live from this process's own configuration.
  </footer>
</div>

<script>
(function () {
  "use strict";

  var POLL_MS = 5000;
  var HISTORY_LEN = 120; // 10 min at 5s
  var paused = false;

  var state = {
    config: null,
    health: null,
    alerts: [],
    backup: null,
    queueHistory: [], // { t, queued, runpodActive, capacity }
    rssHistory: [],
    connOk: true,
  };

  function qs(id) { return document.getElementById(id); }

  function fmtBytes(bytes) {
    if (bytes == null) return "—";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var v = bytes, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + " " + units[i];
  }

  function fmtRelative(atMs) {
    if (!atMs) return "—";
    var deltaS = Math.round((Date.now() - atMs) / 1000);
    if (deltaS < 5) return "just now";
    if (deltaS < 60) return deltaS + "s ago";
    var m = Math.floor(deltaS / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 48) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  function pillHtml(status, label) {
    return '<span class="pill ' + status + '"><span class="dot"></span>' + label + '</span>';
  }

  function statusRank(s) { return { good: 0, warning: 1, serious: 2, critical: 3, unknown: -1 }[s] ?? -1; }

  function worstStatus(list) {
    var best = "good", bestRank = 0;
    for (var i = 0; i < list.length; i += 1) {
      var r = statusRank(list[i]);
      if (r > bestRank) { bestRank = r; best = list[i]; }
    }
    return best;
  }

  // --- fetch helpers -------------------------------------------------
  function getJson(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(url + " -> " + r.status);
      return r.json();
    });
  }

  function refreshConfig() {
    return getJson("/api/ops-config").then(function (cfg) { state.config = cfg; }).catch(function () {});
  }

  function refreshHealth() {
    return getJson("/api/health").then(function (h) {
      state.health = h;
      state.connOk = true;
      var now = Date.now();
      state.queueHistory.push({ t: now, queued: h.queue.queued, runpodActive: h.queue.runpodActive, capacity: h.queue.capacity });
      if (state.queueHistory.length > HISTORY_LEN) state.queueHistory.shift();
      state.rssHistory.push({ t: now, rss: h.memory.rssMiB });
      if (state.rssHistory.length > HISTORY_LEN) state.rssHistory.shift();
    }).catch(function () { state.connOk = false; });
  }

  function refreshAlerts() {
    return getJson("/api/alerts/recent").then(function (a) { state.alerts = a.alerts || []; }).catch(function () {});
  }

  function refreshBackup() {
    return getJson("/api/backup-status").then(function (b) { state.backup = b; }).catch(function () { state.backup = null; });
  }

  // --- sparkline (inline SVG, no deps) --------------------------------
  function sparklineSvg(values, width, height, color) {
    var w = width, h = height;
    if (!values.length) {
      return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"></svg>';
    }
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var range = max - min || 1;
    var pad = 3;
    var pts = values.map(function (v, i) {
      var x = values.length === 1 ? w / 2 : (i / (values.length - 1)) * (w - pad * 2) + pad;
      var y = h - pad - ((v - min) / range) * (h - pad * 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    return (
      '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="trend sparkline">' +
      '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />' +
      "</svg>"
    );
  }

  // --- rendering -------------------------------------------------------
  function renderHeader() {
    var h = state.health;
    qs("roleSub").textContent = h ? ("role: " + h.role + " · pid " + (h.pid || "?") + " · uptime " + Math.floor(h.uptimeSeconds / 60) + "m") : "connecting…";

    var statuses = [];
    if (h) {
      if (h.queue.dispatcher && h.queue.dispatcher.enabled) {
        var leaseDead = !h.queue.dispatcher.active;
        statuses.push(leaseDead ? "critical" : "good");
      }
      if (state.config) {
        if (h.memory.rssMiB > state.config.watchdogMemoryHighMiB) statuses.push("warning");
        if (h.outputDiskFreeBytes != null && h.outputDiskFreeBytes < state.config.watchdogDiskFreeMinBytes) statuses.push("warning");
      }
    }
    if (state.backup && state.backup.status && state.backup.status.ok === false) statuses.push("critical");
    if (!state.connOk) statuses.push("critical");

    var overall = h ? worstStatus(statuses) : "unknown";
    qs("overallPill").outerHTML = '<span id="overallPill" class="pill ' + overall + '"><span class="dot"></span>' + (h ? overall : "connecting") + "</span>";

    qs("connBanner").className = "conn-banner" + (state.connOk ? "" : " show");
    qs("lastUpdated").textContent = state.connOk ? ("updated " + fmtRelative(Date.now() - 200)) : "retrying…";
  }

  function statCard(label, value, unit, detail, status, meterPct) {
    var meter = "";
    if (meterPct != null) {
      var pct = Math.max(0, Math.min(100, meterPct));
      var color = "var(--status-" + (status === "unknown" ? "good" : status) + ")";
      meter = '<div class="meter-track"><div class="meter-fill" style="width:' + pct.toFixed(0) + "%;background:" + color + ';"></div></div>';
    }
    return (
      '<div class="card">' +
        '<div class="card-head"><span class="label">' + label + "</span>" + pillHtml(status, status === "unknown" ? "n/a" : status) + "</div>" +
        '<div class="value">' + value + (unit ? '<span class="unit">' + unit + "</span>" : "") + "</div>" +
        meter +
        '<div class="detail">' + detail + "</div>" +
      "</div>"
    );
  }

  function renderStatGrid() {
    var h = state.health, cfg = state.config;
    var cards = [];

    if (!h) {
      qs("statGrid").innerHTML = '<div class="card"><div class="label">Status</div><div class="value">—</div><div class="detail">Waiting for first successful poll…</div></div>';
      return;
    }

    var q = h.queue;
    var capPct = q.capacity > 0 ? (q.runpodActive / q.capacity) * 100 : 0;
    cards.push(statCard(
      "Queue", q.queued, "queued",
      q.runpodActive + " / " + q.capacity + " RunPod slots active · " + q.active + " active",
      q.queued > 0 && capPct < 100 ? "warning" : "good",
      capPct
    ));

    if (q.dispatcher && q.dispatcher.enabled) {
      var d = q.dispatcher;
      var leaseStatus = d.active ? "good" : "critical";
      var expiresIn = d.expiresAt ? Math.round((d.expiresAt - Date.now()) / 1000) : null;
      cards.push(statCard(
        "Dispatcher lease",
        d.heldByThisProcess ? "held" : (d.active ? "held elsewhere" : "none"),
        "",
        d.active ? ("expires in " + (expiresIn != null ? expiresIn + "s" : "?")) : "no live lease",
        leaseStatus,
        null
      ));
    }

    if (h.mediaIndex) {
      var mi = h.mediaIndex;
      var lag = (mi.dirtyRevision || 0) - (mi.cachedRevision || 0);
      cards.push(statCard("Media index", mi.cachedItems, "items", "lag " + lag + " rev · built " + mi.builtRevision, lag > 5 ? "warning" : "good", null));
    }

    var memThreshold = cfg ? cfg.watchdogMemoryHighMiB : null;
    var memPct = memThreshold ? (h.memory.rssMiB / memThreshold) * 100 : null;
    cards.push(statCard(
      "Memory (RSS)", h.memory.rssMiB, "MiB",
      memThreshold ? ("alert above " + memThreshold + " MiB") : "threshold unknown",
      memThreshold && h.memory.rssMiB > memThreshold ? "warning" : "good",
      memPct
    ));

    if (h.outputDiskFreeBytes != null) {
      var diskThreshold = cfg ? cfg.watchdogDiskFreeMinBytes : null;
      var diskOkPct = diskThreshold ? Math.min(100, (h.outputDiskFreeBytes / (diskThreshold * 3)) * 100) : null;
      cards.push(statCard(
        "Output disk free", fmtBytes(h.outputDiskFreeBytes), "",
        diskThreshold ? ("alert below " + fmtBytes(diskThreshold)) : "threshold unknown",
        diskThreshold && h.outputDiskFreeBytes < diskThreshold ? "warning" : "good",
        diskOkPct
      ));
    }

    if (state.backup) {
      var b = state.backup.status;
      if (b) {
        cards.push(statCard(
          "Last backup", b.ok ? "ok" : "failed", "",
          fmtRelative(Date.parse(b.at) || null) + (b.uploaded ? " · shipped offsite" : " · local only"),
          b.ok ? "good" : "critical",
          null
        ));
      } else {
        cards.push(statCard("Backups", "n/a", "", h.role === "api" ? "backups run on the dispatcher only" : "not enabled on this process", "unknown", null));
      }
    }

    qs("statGrid").innerHTML = cards.join("");
  }

  function renderQueueSpark() {
    var hist = state.queueHistory;
    var queuedVals = hist.map(function (p) { return p.queued; });
    var activeVals = hist.map(function (p) { return p.runpodActive; });
    var current = queuedVals.length ? queuedVals[queuedVals.length - 1] : 0;
    var max = queuedVals.length ? Math.max.apply(null, queuedVals) : 0;

    qs("queueSparkNote").textContent = hist.length ? ("last " + hist.length + " samples") : "";
    qs("queueSparkRow").innerHTML =
      sparklineSvg(queuedVals, 420, 46, "var(--series-1)") +
      '<div class="spark-nums">now: ' + current + "<br>peak: " + max + "<br>RunPod active: " + (activeVals.length ? activeVals[activeVals.length - 1] : 0) + "</div>";
  }

  function ruleLabel(rule) {
    return String(rule).replace(/_/g, " ");
  }

  function renderAlerts() {
    var alerts = state.alerts;
    qs("alertsCount").textContent = alerts.length ? ("(" + alerts.length + ")") : "";
    if (!alerts.length) {
      qs("alertsTable").style.display = "none";
      qs("alertsEmpty").style.display = "block";
      return;
    }
    qs("alertsTable").style.display = "table";
    qs("alertsEmpty").style.display = "none";
    qs("alertsBody").innerHTML = alerts.map(function (a) {
      var sev = a.severity === "critical" ? "critical" : (a.severity === "warning" ? "warning" : "unknown");
      var phasePill = a.phase === "firing" ? pillHtml(sev, "firing") : pillHtml("good", "resolved");
      return (
        "<tr>" +
        '<td class="rule">' + ruleLabel(a.rule) + "</td>" +
        "<td>" + phasePill + "</td>" +
        "<td>" + pillHtml(sev, a.severity) + "</td>" +
        "<td>" + a.role + "</td>" +
        '<td class="detail-cell">' + (a.detail || "") + "</td>" +
        '<td class="time-cell">' + fmtRelative(a.atMs) + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderAll() {
    renderHeader();
    renderStatGrid();
    renderQueueSpark();
    renderAlerts();
  }

  function tick() {
    if (paused) return;
    Promise.all([refreshHealth(), refreshAlerts(), refreshBackup()]).then(renderAll);
  }

  qs("pauseBtn").addEventListener("click", function () {
    paused = !paused;
    qs("pauseBtn").textContent = paused ? "Resume" : "Pause";
  });

  refreshConfig().then(function () {
    tick();
    setInterval(tick, POLL_MS);
    setInterval(function () { if (!paused) renderHeader(); }, 1000); // relative-time ticks between polls
  });
})();
</script>
</body>
</html>
`;
