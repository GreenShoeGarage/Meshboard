import { APP_VERSION, defaultSettings, emptyProject, normalizeProject } from "./models.js";
import { createDemoProject } from "./demo.js";
import { deleteProject, estimateStorage, loadCurrentProject, loadSettings, saveProject, saveSettings } from "./storage.js";
import { MeshtasticAdapter } from "./meshtastic-adapter.js";
import { csv, downloadBlob, escapeHtml as e, fmtAge, fmtTime, median, nodeId, safeObject } from "./utils.js";
import { NODE_COLUMNS, appendNodeObservation, filteredSortedNodes, metadataFor, metricStats, nodeMetricSeries, statusForNode, svgSparkline } from "./node-intelligence.js";
import { filteredPackets, hexLines, portNumStats, relatedPackets } from "./packet-lab.js";
import { analyticsStats, metricDescriptor, packetRateBins, rangeLabel, rfNodeStats, rfPoints, svgHistogram, svgPacketRate, svgTimeSeries, telemetryKinds, telemetryMetricKeys, telemetryNumericValues, telemetryPoints } from "./rf-telemetry.js";
const app = document.querySelector("#app");
const fallback = document.querySelector("#startup-fallback");
if (!app)
    throw new Error("Application mount point #app was not found.");
let project = emptyProject();
let settings = loadSettings();
let storageText = "Checking…";
let saveTimer;
let renderTimer;
let rxPulse = false;
let txPulse = false;
const runtime = {
    view: "home", connection: "DISCONNECTED", saveState: "saved", rxCount: 0, txCount: 0,
    decodeErrors: 0, protocolErrors: 0, sdkState: "Not initialized", nodeSearch: "", packetSearch: "", messageSearch: "",
    packetLivePaused: false, packetNewWhilePaused: 0,
    messageStateFilter: "all", selectedConversation: "channel:0", messageDestination: "broadcast", messageChannel: 0, reconnectAttempt: 0,
    sync: { phase: "idle", config: 0, modules: 0, channels: 0, nodes: 0, myInfo: false, metadata: false }
};
function now() { return new Date().toISOString(); }
function addTimeline(type, text, severity = "INFO", nodeNum, provenance = "OBSERVED") {
    project.timeline.push({ id: crypto.randomUUID(), time: now(), type, severity, nodeNum, text, provenance });
    if (project.timeline.length > 10000)
        project.timeline.splice(0, project.timeline.length - 10000);
}
const adapter = new MeshtasticAdapter({
    connection(state, reason) {
        const previous = runtime.connection;
        runtime.connection = state;
        runtime.connectionReason = reason;
        runtime.stateChangedAt = now();
        if (state === "CONNECTED")
            runtime.connectedAt = now();
        if (state === "DISCONNECTED")
            runtime.disconnectedAt = now();
        if (state === "CONNECTED" && previous !== "CONNECTED")
            addTimeline("radio connected", "Meshtastic radio synchronized and ready.");
        if (state === "DISCONNECTED" && previous !== "DISCONNECTED" && reason)
            addTimeline("radio disconnected", reason);
        if (state === "RECOVERING" && previous !== "RECOVERING")
            addTimeline("radio recovery", reason || "Recovering unexpected radio disconnect.", "LOW");
        scheduleSave();
        queueRender();
    },
    progress(progress) { runtime.sync = progress; queueRender(); },
    diagnostics(update) {
        if (update.serialInfo)
            runtime.serialInfo = { ...runtime.serialInfo, ...update.serialInfo };
        const { serialInfo: _serialInfo, ...rest } = update;
        Object.assign(runtime, rest);
        queueRender();
    },
    nodes(nodes) {
        const previous = new Map(project.nodes.map(n => [n.num, n]));
        const latestPackets = new Map();
        for (const packet of project.packets)
            if (packet.direction === "RX" && packet.source !== undefined)
                latestPackets.set(packet.source, packet);
        project.nodes = nodes.map(n => {
            const prior = previous.get(n.num);
            const packet = latestPackets.get(n.num);
            return { ...n, notes: prior?.notes, rssi: packet?.rssi ?? n.rssi, snr: packet?.snr ?? n.snr };
        });
        for (const n of project.nodes)
            appendNodeObservation(project, {
                id: crypto.randomUUID(), nodeNum: n.num, time: now(), kind: "NODEDB", lastHeard: n.lastHeard, battery: n.battery, voltage: n.voltage,
                rssi: n.rssi, snr: n.snr, hops: n.hops, latitude: n.latitude, longitude: n.longitude, altitude: n.altitude,
                channelUtilization: n.channelUtilization, airUtilTx: n.airUtilTx, provenance: "OBSERVED"
            }, settings.nodeHistoryLimit);
        evaluateFindings();
        scheduleSave();
        queueRender();
    },
    channels(channels) { project.channels = channels; scheduleSave(); queueRender(); },
    radio(radio) {
        const defined = Object.fromEntries(Object.entries(radio).filter(([, v]) => v !== undefined));
        project.radio = { ...project.radio, ...defined };
        scheduleSave();
        queueRender();
    },
    packet(packet) {
        project.packets.push(packet);
        if (project.packets.length > settings.livePacketLimit * 5)
            project.packets.splice(0, project.packets.length - settings.livePacketLimit * 5);
        if (runtime.packetLivePaused && runtime.packetPauseAt && new Date(packet.time).getTime() > new Date(runtime.packetPauseAt).getTime())
            runtime.packetNewWhilePaused++;
        linkPacketToMessage(packet.id, packet.packetId);
        if (packet.direction === "RX" && packet.source !== undefined && (typeof packet.rssi === "number" || typeof packet.snr === "number")) {
            const node = project.nodes.find(n => n.num === packet.source);
            if (node) {
                if (typeof packet.rssi === "number")
                    node.rssi = packet.rssi;
                if (typeof packet.snr === "number")
                    node.snr = packet.snr;
                node.lastHeard = packet.time;
            }
            appendNodeObservation(project, { id: crypto.randomUUID(), nodeNum: packet.source, time: packet.time, kind: "PACKET",
                lastHeard: packet.time, rssi: packet.rssi, snr: packet.snr, hops: node?.hops, packetRecordId: packet.id, provenance: "OBSERVED" }, settings.nodeHistoryLimit);
        }
        scheduleSave();
        queueRender();
    },
    message(message) {
        const existing = project.messages.find(m => m.packetId === message.packetId && m.direction === message.direction);
        if (existing)
            Object.assign(existing, message, { state: existing.state === "SENDING" ? existing.state : message.state });
        else
            project.messages.push(message);
        if (project.messages.length > 10000)
            project.messages.splice(0, project.messages.length - 10000);
        const target = existing || message;
        if (target.packetId !== undefined) {
            const packet = project.packets.find(p => p.packetId === target.packetId);
            if (packet)
                target.packetRecordId = packet.id;
        }
        if (target.direction === "RX" && runtime.view === "messages" && document.visibilityState === "visible" && conversationKeyForMessage(target) === runtime.selectedConversation) {
            project.messaging.readAt[runtime.selectedConversation] = target.time;
        }
        scheduleSave();
        queueRender();
    },
    messageState(packetId, state, reason) {
        const message = project.messages.find(m => m.packetId === packetId);
        if (!message)
            return;
        applyMessageState(message, state, reason);
        scheduleSave();
        queueRender();
    },
    telemetry(reading) {
        project.telemetry.push(reading);
        if (project.telemetry.length > settings.telemetryLimit)
            project.telemetry.splice(0, project.telemetry.length - settings.telemetryLimit);
        const num = (key) => { const value = reading.values[key]; return typeof value === "number" && Number.isFinite(value) ? value : undefined; };
        const battery = num("batteryLevel") ?? num("battery");
        const voltage = num("voltage");
        const channelUtilization = num("channelUtilization");
        const airUtilTx = num("airUtilTx");
        const node = project.nodes.find(n => n.num === reading.nodeNum);
        if (node) {
            if (battery !== undefined)
                node.battery = battery;
            if (voltage !== undefined)
                node.voltage = voltage;
            if (channelUtilization !== undefined)
                node.channelUtilization = channelUtilization;
            if (airUtilTx !== undefined)
                node.airUtilTx = airUtilTx;
        }
        if ([battery, voltage, channelUtilization, airUtilTx].some(v => v !== undefined))
            appendNodeObservation(project, { id: crypto.randomUUID(), nodeNum: reading.nodeNum, time: reading.time, kind: "TELEMETRY", battery, voltage, channelUtilization, airUtilTx, telemetryRecordId: reading.id, provenance: "OBSERVED" }, settings.nodeHistoryLimit);
        scheduleSave();
        queueRender();
    },
    position(position) {
        project.positions.push(position);
        if (project.positions.length > 10000)
            project.positions.splice(0, project.positions.length - 10000);
        const n = project.nodes.find(x => x.num === position.nodeNum);
        if (n) {
            n.latitude = position.latitude;
            n.longitude = position.longitude;
            n.altitude = position.altitude;
        }
        appendNodeObservation(project, { id: crypto.randomUUID(), nodeNum: position.nodeNum, time: position.time, kind: "POSITION", latitude: position.latitude, longitude: position.longitude, altitude: position.altitude, positionRecordId: position.id, provenance: "OBSERVED" }, settings.nodeHistoryLimit);
        scheduleSave();
        queueRender();
    },
    config(config) {
        const hasKeys = (v) => !!v && typeof v === "object" && Object.keys(v).length > 0;
        project.config = {
            radio: hasKeys(config.radio) ? config.radio : project.config.radio,
            modules: hasKeys(config.modules) ? config.modules : project.config.modules
        };
        scheduleSave();
        queueRender();
    },
    timeline(event) { project.timeline.push(event); scheduleSave(); queueRender(); },
    activity(direction) {
        if (direction === "RX") {
            runtime.rxCount++;
            rxPulse = true;
            setTimeout(() => { rxPulse = false; queueRender(); }, 220);
        }
        else {
            runtime.txCount++;
            txPulse = true;
            setTimeout(() => { txPulse = false; queueRender(); }, 220);
        }
    },
    sdkState(state) { runtime.sdkState = state; queueRender(); },
    error(kind, error) {
        if (kind === "decode")
            runtime.decodeErrors++;
        else
            runtime.protocolErrors++;
        addTimeline(`${kind} error`, error instanceof Error ? error.message : String(error), "MEDIUM");
        queueRender();
    }
});
function evaluateFindings() {
    const manual = project.findings.filter(f => !f.id.startsWith("AUTO-"));
    const auto = [];
    for (const n of project.nodes) {
        if (typeof n.battery === "number" && n.battery < 20)
            auto.push({ id: `AUTO-BATT-${n.num}`, title: "LOW BATTERY", severity: "HIGH", confidence: "HIGH", nodeNum: n.num, observedValue: `${n.battery.toFixed(0)}%`, threshold: "< 20%", firstObserved: now(), lastObserved: now(), status: "OPEN" });
        const status = statusForNode(n, settings);
        if (status === "LOST")
            auto.push({ id: `AUTO-STALE-${n.num}`, title: "STALE NODE", severity: "MEDIUM", confidence: "HIGH", nodeNum: n.num, observedValue: fmtAge(n.lastHeard), threshold: `> ${settings.lostMinutes} minutes`, firstObserved: now(), lastObserved: now(), status: "OPEN" });
    }
    const previous = new Map(project.findings.map(f => [f.id, f]));
    project.findings = [...manual, ...auto.map(f => {
            const old = previous.get(f.id);
            return old ? { ...f, firstObserved: old.firstObserved, status: old.status, notes: old.notes } : f;
        })];
}
function scheduleSave() {
    runtime.saveState = "unsaved";
    if (saveTimer)
        clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
        runtime.saveState = "saving";
        queueRender();
        try {
            await saveProject(project);
            runtime.saveState = "saved";
        }
        catch (err) {
            console.error(err);
            runtime.saveState = "error";
        }
        queueRender();
    }, 350);
}
function queueRender(force = false) {
    if (!force) {
        const active = document.activeElement;
        if (active?.matches("input, textarea, select"))
            return;
    }
    if (renderTimer)
        return;
    renderTimer = window.setTimeout(() => { renderTimer = undefined; render(); }, 120);
}
function navItems() {
    return [
        ["home", "HOME", "⌂", false], ["messages", "MESSAGES", "✉", false], ["nodes", "NODES", "◉", false], ["map", "MAP", "⌖", false],
        ["topology", "TOPOLOGY", "⌘", true], ["rf", "RF", "⌁", true], ["packets", "PACKETS", "⇄", true], ["telemetry", "TELEMETRY", "⌁", false],
        ["radio", "RADIO", "▣", false], ["channels", "CHANNELS", "≋", false], ["configuration", "CONFIGURATION", "⚙", true], ["timeline", "TIMELINE", "◷", true],
        ["logbook", "LOGBOOK", "✎", false], ["compare", "COMPARE", "↔", true], ["evidence", "EVIDENCE", "▤", true], ["diagnostics", "DIAGNOSTICS", "◇", true],
        ["settings", "SETTINGS", "⚙", false], ["help", "HELP", "?", false]
    ];
}
function render() {
    applyTheme();
    const advanced = settings.mode === "advanced";
    const nav = navItems().filter(x => advanced || !x[3]).map(([id, label, icon]) => `<button class="nav-item ${runtime.view === id ? "active" : ""}" data-view="${id}"><span>${icon}</span><b>${label}</b></button>`).join("");
    const connClass = runtime.connection.toLowerCase();
    const serialSupported = "serial" in navigator;
    app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand"><div class="brand-mark">M</div><div><h1>MESHBOARD</h1><small>Meshtastic Network Field Instrument</small></div></div>
        <div class="top-project"><span>PROJECT</span><strong>${e(project.name)}</strong>${project.demo ? '<em class="demo-chip">DEMO DATA</em>' : ""}</div>
        <div class="radio-status"><span>RADIO</span><strong>${e(project.radio.shortName || project.radio.longName || "—")}</strong></div>
        <div class="activity"><span class="activity-dot ${rxPulse ? "pulse" : ""}"></span>RX ${runtime.rxCount}<span class="activity-dot tx ${txPulse ? "pulse" : ""}"></span>TX ${runtime.txCount}</div>
        <button class="conn ${connClass}" data-action="connection">● ${runtime.connection}</button>
        <div class="version">v${APP_VERSION}</div>
      </header>
      <aside class="sidebar">
        <div class="mode-switch"><button data-action="mode-easy" class="${settings.mode === "easy" ? "active" : ""}">EASY</button><button data-action="mode-advanced" class="${settings.mode === "advanced" ? "active" : ""}">ADVANCED</button></div>
        <nav>${nav}</nav>
        <div class="side-actions">
          <button data-action="load-demo">LOAD DEMO</button>
          <button data-action="fresh-start">FRESH START</button>
          <button data-action="import-project">IMPORT</button>
          <button data-action="export-project">EXPORT</button>
        </div>
        <div class="privacy-note"><b>LOCAL OPERATION</b><span>Radio traffic and project data remain local unless you explicitly export them.</span></div>
      </aside>
      <main class="workspace">
        ${!serialSupported ? `<div class="banner warning"><b>WEB SERIAL NOT AVAILABLE.</b> Live USB radio connection requires a compatible Chromium-based browser. Saved projects and demo/review mode still work.</div>` : ""}
        ${runtime.connection === "ERROR" ? `<div class="banner danger"><b>CONNECTION ERROR</b>${e(runtime.connectionReason || "Unknown connection error")}</div>` : ""}
        ${runtime.connection === "RECOVERING" || runtime.connection === "RECONNECTING" ? `<div class="banner warning recovery-banner"><b>${runtime.connection}</b>${e(runtime.connectionReason || "Restoring the USB/Meshtastic connection.")}${runtime.nextReconnectAt ? `<span>Next attempt ${e(fmtTime(runtime.nextReconnectAt))}</span>` : ""}</div>` : ""}
        ${viewHtml(runtime.view)}
      </main>
      <footer class="statusbar">
        <span class="save ${runtime.saveState}">● ${runtime.saveState.toUpperCase()}</span>
        <span>${e(runtime.sdkState)}</span>${runtime.connection === "SYNCHRONIZING" ? `<span class="status-sync">nodes ${runtime.sync.nodes} · channels ${runtime.sync.channels} · config ${runtime.sync.config} · modules ${runtime.sync.modules}</span>` : ""}<span class="spacer"></span><span>IndexedDB local project storage</span><span>MESHBOARD v${APP_VERSION}</span>
      </footer>
      <input type="file" id="import-file" accept="application/json,.json" hidden />
    </div>`;
    fallback?.remove();
    bindRenderedControls();
}
function viewHtml(view) {
    switch (view) {
        case "home": return homeView();
        case "messages": return messagesView();
        case "nodes": return nodesView();
        case "map": return mapView();
        case "topology": return topologyView();
        case "rf": return rfView();
        case "packets": return packetsView();
        case "telemetry": return telemetryView();
        case "radio": return radioView();
        case "channels": return channelsView();
        case "configuration": return configView();
        case "timeline": return timelineView();
        case "logbook": return logbookView();
        case "compare": return compareView();
        case "evidence": return evidenceView();
        case "diagnostics": return diagnosticsView();
        case "settings": return settingsView();
        case "help": return helpView();
    }
}
function section(title, subtitle, body, actions = "") {
    return `<section class="view"><div class="view-head"><div><h2>${e(title)}</h2><p>${e(subtitle)}</p></div><div class="head-actions">${actions}</div></div>${body}</section>`;
}
function card(label, value, detail = "", cls = "") { return `<div class="metric-card ${cls}"><span>${e(label)}</span><strong>${e(value ?? "—")}</strong><small>${e(detail)}</small></div>`; }
function nodeName(num) { if (num === undefined)
    return "—"; const n = project.nodes.find(x => x.num === num); return n ? `${n.shortName} · ${n.longName}` : nodeId(num); }
function pct(v) { return typeof v === "number" ? `${v.toFixed(0)}%` : "—"; }
function fixed(v, d = 1, s = "") { return typeof v === "number" ? `${v.toFixed(d)}${s}` : "—"; }
const BROADCAST_NUM = 0xffffffff;
function conversationKeyForMessage(message) {
    if (message.type === "direct") {
        const peer = message.direction === "TX" ? message.to : message.from;
        return `direct:${peer}`;
    }
    return `channel:${message.channel}`;
}
function parseConversation(key) {
    const [kind, raw] = key.split(":", 2);
    const value = Number(raw);
    return kind === "direct" && Number.isFinite(value) ? { kind: "direct", peer: value } : { kind: "channel", channel: Number.isFinite(value) ? value : 0 };
}
function channelName(index) { return project.channels.find(c => c.index === index)?.name || (index === 0 ? "Primary" : `Channel ${index}`); }
function conversationLabel(key) {
    const conv = parseConversation(key);
    return conv.kind === "channel" ? `# ${channelName(conv.channel)}` : nodeName(conv.peer);
}
function conversationMessages(key) { return project.messages.filter(m => conversationKeyForMessage(m) === key); }
function unreadCount(key) {
    const readAt = project.messaging.readAt[key] ? new Date(project.messaging.readAt[key]).getTime() : 0;
    return conversationMessages(key).filter(m => m.direction === "RX" && new Date(m.time).getTime() > readAt).length;
}
function markConversationRead(key) {
    project.messaging.readAt[key] = now();
    project.messaging.lastConversation = key;
}
function setConversation(key, markRead = true) {
    runtime.selectedConversation = key;
    runtime.selectedMessage = undefined;
    project.messaging.lastConversation = key;
    const conv = parseConversation(key);
    if (conv.kind === "channel") {
        runtime.messageDestination = "broadcast";
        runtime.messageChannel = conv.channel;
    }
    else {
        runtime.messageDestination = conv.peer;
        const recent = [...conversationMessages(key)].reverse().find(m => Number.isFinite(m.channel));
        if (recent)
            runtime.messageChannel = recent.channel;
    }
    if (markRead)
        markConversationRead(key);
    scheduleSave();
}
function messagePacket(message) {
    return message.packetRecordId ? project.packets.find(p => p.id === message.packetRecordId) :
        message.packetId !== undefined ? project.packets.find(p => p.packetId === message.packetId) : undefined;
}
function linkPacketToMessage(packetRecordId, packetId) {
    if (packetId === undefined)
        return;
    const message = project.messages.find(m => m.packetId === packetId);
    if (message)
        message.packetRecordId = packetRecordId;
}
function applyMessageState(message, state, reason) {
    message.state = state;
    if (state === "ACKNOWLEDGED") {
        message.acknowledgedAt = now();
        message.failureReason = undefined;
        message.failedAt = undefined;
    }
    if (state === "FAILED") {
        message.failedAt = now();
        message.failureReason = reason || message.failureReason || "Message send failed.";
    }
}
function draftForConversation(key = runtime.selectedConversation) { return project.messaging.drafts[key] || ""; }
function setDraftForConversation(text, key = runtime.selectedConversation) {
    project.messaging.drafts[key] = text;
    scheduleSave();
}
function messageStateClass(state) { return state.toLowerCase(); }
function messageStateText(message) {
    if (message.state === "ACKNOWLEDGED")
        return "ACKNOWLEDGED";
    if (message.state === "SENDING")
        return "SENDING / AWAITING ACK";
    if (message.state === "FAILED")
        return `FAILED${message.failureReason ? ` · ${message.failureReason}` : ""}`;
    if (message.state === "RECEIVED")
        return "RECEIVED";
    return "STATE UNKNOWN";
}
function connectionProgressPanel() {
    if (!["CONNECTING", "SERIAL_OPEN", "SYNCHRONIZING", "RECOVERING", "RECONNECTING"].includes(runtime.connection))
        return "";
    const steps = [
        ["CONNECTING", "Select / reopen USB"], ["SERIAL_OPEN", "Serial transport open"], ["SYNCHRONIZING", "Synchronize Meshtastic state"], ["CONNECTED", "Ready"]
    ];
    const rank = { CONNECTING: 0, RECONNECTING: 0, RECOVERING: 0, SERIAL_OPEN: 1, SYNCHRONIZING: 2, CONNECTED: 3 };
    const current = rank[runtime.connection] ?? 0;
    return `<div class="connection-progress"><div class="progress-head"><b>${e(runtime.connection)}</b><span>${e(runtime.connectionReason || runtime.sdkState)}</span></div><div class="progress-steps">${steps.map(([state, label], i) => `<div class="progress-step ${i < current ? "done" : i === current ? "current" : ""}"><span>${i < current ? "✓" : i + 1}</span><b>${e(label)}</b></div>`).join("")}</div>${runtime.connection === "SYNCHRONIZING" ? `<div class="sync-counters"><span>NODES <b>${runtime.sync.nodes}</b></span><span>CHANNELS <b>${runtime.sync.channels}</b></span><span>CONFIG <b>${runtime.sync.config}</b></span><span>MODULES <b>${runtime.sync.modules}</b></span><span>MY INFO <b>${runtime.sync.myInfo ? "✓" : "—"}</b></span><span>METADATA <b>${runtime.sync.metadata ? "✓" : "—"}</b></span></div>` : ""}</div>`;
}
function homeView() {
    if (runtime.connection === "DISCONNECTED" && !project.demo && !project.nodes.length && !project.packets.length) {
        return section("FIELD CONSOLE", "CONNECT → DISCOVER → COMMUNICATE → OBSERVE → ANALYZE → DIAGNOSE → DOCUMENT", `
      <div class="welcome">
        <div class="welcome-copy"><div class="eyebrow">LOCAL-FIRST / USB WEB SERIAL</div><h3>The radio handles the mesh.<br>The browser makes the mesh understandable.</h3>
        <p>Connect a stock Meshtastic radio over USB. MESHBOARD will synchronize the node database, messages, configuration, telemetry, positions, and live packet observations without requiring an application server.</p>
        <div class="welcome-actions"><button class="primary large" data-action="connect">CONNECT RADIO</button><button class="large" data-action="load-demo">LOAD DEMO PROJECT</button><button class="large" data-action="import-project">IMPORT PROJECT</button></div>
        <div class="local-grid"><div><b>NO ACCOUNT</b><span>No sign-in or cloud database.</span></div><div><b>LOCAL STORAGE</b><span>Projects persist in this browser.</span></div><div><b>STOCK FIRMWARE</b><span>Uses Meshtastic's client API.</span></div></div></div>
        <div class="signal-panel"><div class="scope-grid"></div><div class="signal-line s1"></div><div class="signal-line s2"></div><div class="signal-line s3"></div><div class="scope-label">AWAITING RADIO</div></div>
      </div>`);
    }
    const active = project.nodes.filter(n => ["ACTIVE", "RECENT"].includes(statusForNode(n, settings))).length;
    const stale = project.nodes.filter(n => ["STALE", "LOST"].includes(statusForNode(n, settings))).length;
    const rx = project.packets.filter(p => p.direction === "RX");
    const snrs = rx.map(p => p.snr).filter((v) => typeof v === "number");
    const recentMessages = [...project.messages].slice(-6).reverse();
    const recentNodes = [...project.nodes].sort((a, b) => new Date(b.lastHeard || 0).getTime() - new Date(a.lastHeard || 0).getTime()).slice(0, 7);
    return section("HOME", "Live mesh state and recent engineering observations", `
    ${project.demo ? '<div class="banner demo"><b>DEMO PROJECT.</b> Every radio, packet, position, message, and metric in this workspace is synthetic.</div>' : ""}
    ${connectionProgressPanel()}
    <div class="metric-grid">
      ${card("RADIO", runtime.connection, project.radio.hardware || "No hardware identity", runtime.connection === "CONNECTED" ? "good" : "")}
      ${card("KNOWN NODES", project.nodes.length, `${active} active/recent · ${stale} stale/lost`)}
      ${card("PACKETS", project.packets.length, `${project.packets.filter(p => p.direction === "RX").length} RX · ${project.packets.filter(p => p.direction === "TX").length} TX`)}
      ${card("MESSAGES", project.messages.length, `${project.messages.filter(m => m.type === "direct").length} direct`)}
      ${card("MEDIAN SNR", snrs.length ? `${median(snrs)?.toFixed(1)} dB` : "—", snrs.length ? `${snrs.length} observed RX packets` : "No RX SNR data")}
      ${card("OPEN FINDINGS", project.findings.filter(f => f.status === "OPEN").length, `${project.findings.filter(f => f.severity === "HIGH" || f.severity === "CRITICAL").length} high/critical`)}
    </div>
    <div class="two-col">
      <div class="panel"><div class="panel-title">RECENT MESSAGES</div>${recentMessages.length ? recentMessages.map(m => `<div class="message-line"><span>${e(nodeName(m.from))}</span><p>${e(m.text)}</p><time>${e(fmtTime(m.time))}</time></div>`).join("") : '<div class="empty">No messages recorded.</div>'}</div>
      <div class="panel"><div class="panel-title">RECENTLY HEARD NODES</div>${recentNodes.length ? recentNodes.map(n => `<button class="node-line" data-node="${n.num}"><span class="status-pill ${statusForNode(n, settings).toLowerCase()}">${statusForNode(n, settings)}</span><b>${e(n.shortName)}</b><span>${e(n.longName)}</span><em>${e(fmtAge(n.lastHeard))}</em><small>${fixed(n.snr, 1, " dB")}</small></button>`).join("") : '<div class="empty">No nodes recorded.</div>'}</div>
    </div>
    <div class="panel findings-panel"><div class="panel-title">FINDINGS</div>${findingsTable(project.findings.slice(0, 8))}</div>`);
}
function messagesView() {
    const configuredChannels = project.channels.length ? project.channels : [{ index: 0, name: "Primary", role: "PRIMARY" }];
    const channelIndexes = [...new Set([...configuredChannels.map(c => c.index), ...project.messages.filter(m => m.type === "broadcast").map(m => m.channel)])].sort((a, b) => a - b);
    const directPeers = [...new Set([
            ...project.messages.filter(m => m.type === "direct").map(m => m.direction === "TX" ? m.to : m.from),
            ...project.nodes.filter(n => n.num !== project.radio.nodeNum).map(n => n.num)
        ])].sort((a, b) => {
        const ac = conversationMessages(`direct:${a}`).length, bc = conversationMessages(`direct:${b}`).length;
        if (ac !== bc)
            return bc - ac;
        return nodeName(a).localeCompare(nodeName(b));
    });
    if (!runtime.selectedConversation)
        runtime.selectedConversation = project.messaging.lastConversation || "channel:0";
    const selectedConv = parseConversation(runtime.selectedConversation);
    const allMessages = [...conversationMessages(runtime.selectedConversation)].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    const query = runtime.messageSearch.trim().toLowerCase();
    const visible = allMessages.filter(m => {
        const stateOk = runtime.messageStateFilter === "all" || m.state.toLowerCase() === runtime.messageStateFilter;
        const packet = messagePacket(m);
        const hay = `${m.text} ${nodeName(m.from)} ${nodeName(m.to)} ${m.packetId ?? ""} ${m.state} ${packet?.rssi ?? ""} ${packet?.snr ?? ""}`.toLowerCase();
        return stateOk && (!query || hay.includes(query));
    }).slice(-500);
    const selected = runtime.selectedMessage ? project.messages.find(m => m.id === runtime.selectedMessage) : undefined;
    const selectedPacket = selected ? messagePacket(selected) : undefined;
    const draft = draftForConversation();
    const bytes = new TextEncoder().encode(draft).length;
    const channels = configuredChannels;
    const destOptions = [`<option value="broadcast" ${runtime.messageDestination === "broadcast" ? "selected" : ""}>Broadcast / channel conversation</option>`, ...project.nodes.filter(n => n.num !== project.radio.nodeNum).map(n => `<option value="${n.num}" ${runtime.messageDestination === n.num ? "selected" : ""}>${e(n.shortName)} · ${e(n.longName)}</option>`)].join("");
    const channelButtons = channelIndexes.map(index => {
        const key = `channel:${index}`, unread = unreadCount(key), count = conversationMessages(key).length;
        return `<button class="conversation ${runtime.selectedConversation === key ? "active" : ""}" data-conversation="${e(key)}"><span class="conversation-icon">#</span><div><b>${e(channelName(index))}</b><small>Channel ${index} · ${count} msgs</small></div>${unread ? `<em>${unread}</em>` : ""}</button>`;
    }).join("");
    const directButtons = directPeers.map(peer => {
        const key = `direct:${peer}`, unread = unreadCount(key), msgs = conversationMessages(key), last = msgs.at(-1);
        return `<button class="conversation ${runtime.selectedConversation === key ? "active" : ""}" data-conversation="${e(key)}"><span class="conversation-icon direct">↔</span><div><b>${e(nodeName(peer))}</b><small>${last ? e(last.text.slice(0, 42)) : "No messages yet"}</small></div>${unread ? `<em>${unread}</em>` : ""}</button>`;
    }).join("");
    const stream = visible.length ? visible.map(m => {
        const packet = messagePacket(m);
        const meta = [m.type.toUpperCase(), `CH ${m.channel}`, fmtTime(m.time), m.packetId !== undefined ? `PKT ${m.packetId}` : ""].filter(Boolean).join(" · ");
        const signal = packet && m.direction === "RX" ? `<span>${fixed(packet.rssi, 0, " dBm")} · ${fixed(packet.snr, 1, " dB")}</span>` : "";
        return `<div class="bubble-row ${m.direction.toLowerCase()} ${runtime.selectedMessage === m.id ? "selected" : ""}"><button class="bubble" data-message="${e(m.id)}"><div class="bubble-meta"><b>${e(m.direction === "TX" ? "YOU" : nodeName(m.from))}</b><span>${e(meta)}</span></div><p>${e(m.text)}</p><div class="message-foot"><span class="message-state ${messageStateClass(m.state)}">${e(messageStateText(m))}</span>${signal}</div></button></div>`;
    }).join("") : '<div class="empty large-empty"><b>NO MATCHING MESSAGES</b><span>Choose another conversation or clear the current filters.</span></div>';
    const inspector = selected ? `<aside class="message-inspector"><div class="inspector-head"><span>MESSAGE INSPECTOR</span><button data-action="close-message-inspector">×</button></div><h3>${e(selected.direction === "TX" ? "Outbound message" : "Inbound message")}</h3><p class="message-inspector-text">${e(selected.text)}</p>${kv({
        "State": messageStateText(selected), "Direction": selected.direction, "Conversation": conversationLabel(conversationKeyForMessage(selected)), "Sender": nodeName(selected.from), "Destination": selected.to === BROADCAST_NUM ? "Broadcast" : nodeName(selected.to), "Channel": `${selected.channel} · ${channelName(selected.channel)}`, "Time": fmtTime(selected.time), "Packet ID": selected.packetId, "Attempts": selected.attempts, "Acknowledged": fmtTime(selected.acknowledgedAt), "Failed": fmtTime(selected.failedAt), "Failure reason": selected.failureReason
    })}${selectedPacket ? `<div class="panel-title">PACKET EVIDENCE</div>${kv({ "Packet record": selectedPacket.id, "RSSI": fixed(selectedPacket.rssi, 0, " dBm"), "SNR": fixed(selectedPacket.snr, 1, " dB"), "Hop limit": selectedPacket.hopLimit, "Hop start": selectedPacket.hopStart, "PortNum": selectedPacket.portNum })}<button data-action="open-message-packet">VIEW PACKET RECORD</button>` : '<div class="banner info"><b>NO PACKET RECORD LINKED.</b>The message is preserved, but no matching raw packet is currently retained.</div>'}${selected.state === "FAILED" && selected.direction === "TX" ? '<button class="primary" data-action="retry-message">RETRY MESSAGE</button>' : ""}</aside>` : "";
    const summary = `${allMessages.length} messages · ${allMessages.filter(m => m.state === "FAILED").length} failed · ${allMessages.filter(m => m.state === "SENDING").length} awaiting ACK`;
    return section("MESSAGES", "Persistent channel/direct conversations with firmware ACK state and packet evidence", `
    <div class="messaging-workbench">
      <aside class="conversation-list"><div class="conversation-head"><b>CONVERSATIONS</b><small>${e(summary)}</small></div><div class="conversation-section"><span>CHANNELS</span>${channelButtons || '<div class="empty">No channels recorded.</div>'}</div><div class="conversation-section"><span>DIRECT</span>${directButtons || '<div class="empty">No nodes available.</div>'}</div></aside>
      <div class="message-workspace"><div class="message-toolbar"><div><b>${e(conversationLabel(runtime.selectedConversation))}</b><small>${selectedConv.kind === "channel" ? `Broadcast conversation on channel ${selectedConv.channel}` : `Direct conversation with ${nodeName(selectedConv.peer)}`}</small></div><input id="message-search" placeholder="Search this conversation…" value="${e(runtime.messageSearch)}"><select id="message-state-filter"><option value="all" ${runtime.messageStateFilter === "all" ? "selected" : ""}>All states</option><option value="sending" ${runtime.messageStateFilter === "sending" ? "selected" : ""}>Sending</option><option value="acknowledged" ${runtime.messageStateFilter === "acknowledged" ? "selected" : ""}>Acknowledged</option><option value="failed" ${runtime.messageStateFilter === "failed" ? "selected" : ""}>Failed</option><option value="received" ${runtime.messageStateFilter === "received" ? "selected" : ""}>Received</option></select><button data-action="export-messages">EXPORT CSV</button></div>
        <div class="chat-stream">${stream}</div>
        <div class="composer"><textarea id="composer-text" maxlength="228" placeholder="Type message… Ctrl/⌘+Enter to send">${e(draft)}</textarea><div class="composer-controls"><label>CHANNEL<select id="message-channel">${channels.map(c => `<option value="${c.index}" ${runtime.messageChannel === c.index ? "selected" : ""}>${e(c.name)} (${c.index})</option>`).join("")}</select></label><label>DESTINATION<select id="message-destination">${destOptions}</select></label><span class="draft-state">DRAFT AUTOSAVED</span><span class="byte-count ${bytes > 228 ? "over" : ""}">${bytes}/228 bytes</span><button class="primary" data-action="send-message" ${runtime.connection !== "CONNECTED" || bytes === 0 || bytes > 228 ? "disabled" : ""}>SEND</button></div></div>
      </div>${inspector}
    </div>`);
}
function nodeMetadata(nodeNum) { return project.nodeMetadata.find(x => x.nodeNum === nodeNum); }
function nodeHasFieldData(nodeNum) { const m = nodeMetadata(nodeNum); return !!m && Object.entries(m).some(([k, v]) => k !== "nodeNum" && k !== "updatedAt" && v !== undefined && v !== ""); }
function nodeColumnWidth(id) { return project.nodeTable.columnWidths[id] ?? NODE_COLUMNS.find(c => c.id === id)?.defaultWidth ?? 100; }
function nodeCell(id, n) {
    const meta = nodeMetadata(n.num);
    switch (id) {
        case "status": return `<span class="status-pill ${statusForNode(n, settings).toLowerCase()}">${statusForNode(n, settings)}</span>`;
        case "node": return `<b>${e(n.shortName)}</b><small>${e(n.longName)}</small>`;
        case "id": return `<span class="mono">${e(n.id)}</span>`;
        case "hardware": return e(n.hardware || "—");
        case "role": return e(n.role || "—");
        case "firmware": return e(n.firmware || "—");
        case "lastHeard": return `${e(fmtAge(n.lastHeard))}<small>${e(fmtTime(n.lastHeard))}</small>`;
        case "battery": return pct(n.battery);
        case "voltage": return fixed(n.voltage, 2, " V");
        case "rssi": return fixed(n.rssi, 0, " dBm");
        case "snr": return fixed(n.snr, 1, " dB");
        case "hops": return e(n.hops ?? "—");
        case "position": return typeof n.latitude === "number" ? `<span class="mono">${n.latitude.toFixed(5)}, ${n.longitude?.toFixed(5)}</span>` : "—";
        case "favorite": return n.favorite ? '<span class="favorite-mark" title="Favorite reported by radio">★</span>' : "—";
        case "field": return nodeHasFieldData(n.num) ? `<span class="field-data-mark">LOCAL</span><small>${e(meta?.purpose || meta?.location || meta?.antenna || "")}</small>` : "—";
    }
}
function nodeHistoryCard(nodeNum, metric, label, unit, decimals) {
    const series = nodeMetricSeries(project, nodeNum, metric);
    const stats = metricStats(series);
    const statText = stats.samples ? `${stats.samples} samples · median ${fixed(stats.median, decimals, unit)} · min ${fixed(stats.min, decimals, unit)} · max ${fixed(stats.max, decimals, unit)}` : "No samples";
    return `<div class="history-card"><div class="history-card-head"><b>${e(label)}</b><span>${e(statText)}</span></div>${svgSparkline(series.slice(-160), label, unit, decimals)}</div>`;
}
function nodeInspector(selected) {
    const meta = nodeMetadata(selected.num) || { nodeNum: selected.num };
    const observations = project.nodeObservations.filter(x => x.nodeNum === selected.num).sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    const packetSamples = observations.filter(x => x.kind === "PACKET").length, telemetrySamples = observations.filter(x => x.kind === "TELEMETRY").length;
    return `<aside class="inspector node-inspector"><div class="inspector-head"><span>NODE INSPECTOR</span><button data-action="close-inspector">×</button></div>
    <div class="node-inspector-title"><div><h3>${e(selected.longName)}</h3><div class="big-short">${e(selected.shortName)}</div></div><span class="status-pill ${statusForNode(selected, settings).toLowerCase()}">${statusForNode(selected, settings)}</span></div>
    <div class="panel-title">CURRENT OBSERVED STATE</div>${kv({ "Node ID": selected.id, "Node number": selected.num, "Hardware": selected.hardware, "Role": selected.role, "Firmware": selected.firmware, "Favorite": selected.favorite ? "YES" : "NO", "Last heard": fmtTime(selected.lastHeard), "Age": fmtAge(selected.lastHeard), "Battery": pct(selected.battery), "Voltage": fixed(selected.voltage, 2, " V"), "RSSI": fixed(selected.rssi, 0, " dBm"), "SNR": fixed(selected.snr, 1, " dB"), "Hops": selected.hops, "Latitude": selected.latitude, "Longitude": selected.longitude, "Altitude": selected.altitude })}
    <div class="history-summary"><span>${observations.length}<b>OBSERVATIONS</b></span><span>${packetSamples}<b>RF SAMPLES</b></span><span>${telemetrySamples}<b>TELEMETRY</b></span></div>
    <div class="node-inspector-actions"><button data-action="message-node">MESSAGE NODE</button><button data-action="node-packets">VIEW PACKETS</button><button data-action="evidence-from-node">ADD STATE TO EVIDENCE</button></div>
    <div class="panel-title">HISTORY</div><div class="node-history-grid">${nodeHistoryCard(selected.num, "rssi", "RSSI", " dBm", 0)}${nodeHistoryCard(selected.num, "snr", "SNR", " dB", 1)}${nodeHistoryCard(selected.num, "battery", "BATTERY", "%", 0)}${nodeHistoryCard(selected.num, "voltage", "VOLTAGE", " V", 2)}</div>
    <details class="observation-details"><summary>RECENT OBSERVATIONS (${Math.min(40, observations.length)} shown)</summary><div class="table-wrap"><table class="compact-table"><thead><tr><th>TIME</th><th>SOURCE</th><th>RSSI</th><th>SNR</th><th>BATTERY</th><th>VOLTAGE</th><th>HOPS</th></tr></thead><tbody>${observations.slice(0, 40).map(o => `<tr><td>${e(fmtTime(o.time))}</td><td>${e(o.kind)}</td><td>${fixed(o.rssi, 0, " dBm")}</td><td>${fixed(o.snr, 1, " dB")}</td><td>${pct(o.battery)}</td><td>${fixed(o.voltage, 2, " V")}</td><td>${e(o.hops ?? "—")}</td></tr>`).join("") || '<tr><td colspan="7">No historical observations yet.</td></tr>'}</tbody></table></div></details>
    <div class="panel-title">LOCAL FIELD DATA</div><div class="field-data-grid">
      <label>PURPOSE<input id="node-purpose" value="${e(meta.purpose || "")}" placeholder="Relay, handheld, sensor…"></label>
      <label>OWNER / TEAM<input id="node-owner" value="${e(meta.owner || "")}" placeholder="Team or custodian"></label>
      <label>FIELD LOCATION<input id="node-location" value="${e(meta.location || "")}" placeholder="Roof, ridge, vehicle…"></label>
      <label>ASSET TAG<input id="node-asset-tag" value="${e(meta.assetTag || "")}" placeholder="Local inventory ID"></label>
      <label>ANTENNA<input id="node-antenna" value="${e(meta.antenna || "")}" placeholder="Model / type"></label>
      <label>ANTENNA GAIN (dBi)<input id="node-antenna-gain" type="number" step="0.1" value="${meta.antennaGainDbi ?? ""}"></label>
      <label>ANTENNA HEIGHT (m)<input id="node-antenna-height" type="number" step="0.1" value="${meta.antennaHeightM ?? ""}"></label>
      <label class="wide">DEPLOYMENT NOTES<textarea id="node-deployment-notes" placeholder="Mounting, power, enclosure, test conditions…">${e(meta.deploymentNotes || "")}</textarea></label>
      <label class="wide">OPERATOR NOTES<textarea id="node-notes" placeholder="Local notes are never written to the radio.">${e(meta.notes || selected.notes || "")}</textarea></label>
    </div><button data-action="save-node-field-data" class="primary wide-button">SAVE LOCAL FIELD DATA</button>
    <div class="banner info compact-banner"><b>PROVENANCE.</b> Identity, role, firmware, favorites, and live measurements above are radio-observed. The FIELD DATA section is user-entered and remains local to this MESHBOARD project.</div>
  </aside>`;
}
function nodesView() {
    const filter = project.nodeTable.filter;
    const nodes = filteredSortedNodes(project, settings, filter);
    const selected = runtime.selectedNode ? project.nodes.find(n => n.num === runtime.selectedNode) : undefined;
    const roles = [...new Set(project.nodes.map(n => n.role).filter((x) => !!x))].sort();
    const hardware = [...new Set(project.nodes.map(n => n.hardware).filter((x) => !!x))].sort();
    const columns = project.nodeTable.visibleColumns.length ? project.nodeTable.visibleColumns : ["status", "node", "lastHeard", "battery", "rssi", "snr"];
    const header = columns.map(id => { const col = NODE_COLUMNS.find(c => c.id === id); const sorted = filter.sortBy === id; return `<th data-col-cell="${id}" style="width:${nodeColumnWidth(id)}px;min-width:${nodeColumnWidth(id)}px"><button class="node-sort" data-node-sort="${id}">${e(col.label)}${sorted ? ` <span>${filter.sortDir === "asc" ? "↑" : "↓"}</span>` : ""}</button><span class="col-resizer" data-col-resize="${id}" title="Drag to resize"></span></th>`; }).join("");
    const body = nodes.map(n => `<tr data-node="${n.num}" class="${runtime.selectedNode === n.num ? "selected" : ""}">${columns.map(id => `<td data-col-cell="${id}" style="width:${nodeColumnWidth(id)}px;min-width:${nodeColumnWidth(id)}px">${nodeCell(id, n)}</td>`).join("")}</tr>`).join("");
    const active = project.nodes.filter(n => statusForNode(n, settings) === "ACTIVE").length, recent = project.nodes.filter(n => statusForNode(n, settings) === "RECENT").length, attention = project.nodes.filter(n => ["STALE", "LOST"].includes(statusForNode(n, settings))).length;
    const currentView = project.nodeTable.savedViews.find(v => v.id === project.nodeTable.selectedViewId);
    const viewOptions = project.nodeTable.savedViews.map(v => `<option value="${e(v.id)}" ${v.id === project.nodeTable.selectedViewId ? "selected" : ""}>${e(v.name)}</option>`).join("");
    const columnChecks = NODE_COLUMNS.map(c => `<label><input type="checkbox" data-node-column="${c.id}" ${columns.includes(c.id) ? "checked" : ""}> ${e(c.label)}</label>`).join("");
    const table = `<div class="table-wrap node-table-wrap"><table class="node-table"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
    const inspector = selected ? nodeInspector(selected) : "";
    return section("NODES", "Engineering node inventory, history, saved views, and local deployment metadata", `
    <div class="node-metrics">${card("KNOWN NODES", project.nodes.length, `${active} active · ${recent} recent`)}${card("MATCHING VIEW", nodes.length, filter.status === "all" ? "all statuses" : filter.status)}${card("ATTENTION", attention, "stale + lost")}${card("HISTORY", project.nodeObservations.length, "retained node observations")}</div>
    <div class="node-filterbar">
      <input id="node-search" placeholder="Search identity, hardware, role, or field data…" value="${e(filter.search)}">
      <select id="node-status-filter"><option value="all" ${filter.status === "all" ? "selected" : ""}>All statuses</option>${["ACTIVE", "RECENT", "STALE", "LOST", "UNKNOWN"].map(x => `<option value="${x}" ${filter.status === x ? "selected" : ""}>${x}</option>`).join("")}</select>
      <select id="node-role-filter"><option value="">All roles</option>${roles.map(x => `<option value="${e(x)}" ${filter.role === x ? "selected" : ""}>${e(x)}</option>`).join("")}</select>
      <select id="node-hardware-filter"><option value="">All hardware</option>${hardware.map(x => `<option value="${e(x)}" ${filter.hardware === x ? "selected" : ""}>${e(x)}</option>`).join("")}</select>
      <label class="favorite-filter"><input id="node-favorites-filter" type="checkbox" ${filter.favoritesOnly ? "checked" : ""}> FAVORITES ONLY</label>
      <button data-action="clear-node-filters">CLEAR FILTERS</button><button data-action="export-nodes">EXPORT CSV</button>
    </div>
    <details class="node-view-manager"><summary>VIEWS & COLUMNS${currentView ? ` · ${e(currentView.name)}` : ""}</summary><div class="node-view-grid"><label>SAVED VIEW<select id="node-saved-view"><option value="">Custom / unsaved view</option>${viewOptions}</select></label><label>VIEW NAME<input id="node-view-name" value="${e(currentView?.name || "")}" placeholder="e.g. Field relays"></label><div class="view-actions"><button data-action="save-node-view">SAVE CURRENT VIEW</button><button data-action="delete-node-view" ${currentView ? "" : "disabled"}>DELETE VIEW</button></div><div class="column-picker"><b>VISIBLE COLUMNS</b>${columnChecks}</div><div class="view-note">Saved views retain filters, sort order, visible columns, and column widths. Drag a column divider in the table header to resize it.</div></div></details>
    <div class="with-inspector node-workbench"><div class="grow">${table}</div>${inspector}</div>`);
}
function mapView() {
    const nodes = project.nodes.filter(n => typeof n.latitude === "number" && typeof n.longitude === "number");
    if (!nodes.length)
        return section("MAP", "Privacy-preserving local position plot", `<div class="empty large-empty"><b>NO POSITION DATA</b><span>Positions received from Meshtastic nodes will appear here. This local map uses a local coordinate plot and never sends coordinates to a tile service.</span></div>`);
    const lats = nodes.map(n => n.latitude), lons = nodes.map(n => n.longitude);
    let minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
    if (minLat === maxLat) {
        minLat -= .001;
        maxLat += .001;
    }
    if (minLon === maxLon) {
        minLon -= .001;
        maxLon += .001;
    }
    const W = 1000, H = 620, pad = 60;
    const point = (n) => { const x = pad + ((n.longitude - minLon) / (maxLon - minLon)) * (W - 2 * pad); const y = H - pad - ((n.latitude - minLat) / (maxLat - minLat)) * (H - 2 * pad); return { x, y }; };
    const grid = Array.from({ length: 11 }, (_, i) => `<line x1="${pad + i * (W - 2 * pad) / 10}" y1="${pad}" x2="${pad + i * (W - 2 * pad) / 10}" y2="${H - pad}"/><line x1="${pad}" y1="${pad + i * (H - 2 * pad) / 10}" x2="${W - pad}" y2="${pad + i * (H - 2 * pad) / 10}"/>`).join("");
    const points = nodes.map(n => { const p = point(n); return `<g class="map-node" data-node="${n.num}"><circle cx="${p.x}" cy="${p.y}" r="12"/><text x="${p.x + 18}" y="${p.y + 4}">${e(n.shortName)}</text><title>${e(n.longName)} · ${n.latitude?.toFixed(5)}, ${n.longitude?.toFixed(5)}</title></g>`; }).join("");
    return section("MAP", "Local position plot — no external tile or geocoding requests", `<div class="map-banner"><b>LOCAL PLOT</b><span>This plot preserves relative geographic position but intentionally uses no third-party map tiles. North is up.</span></div><div class="local-map"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Node position plot"><g class="map-grid">${grid}</g>${points}<text x="${pad}" y="28" class="axis-label">N ${maxLat.toFixed(5)}°</text><text x="${pad}" y="${H - 18}" class="axis-label">S ${minLat.toFixed(5)}°</text><text x="${W - pad - 140}" y="${H - 18}" class="axis-label">E/W ${minLon.toFixed(3)}…${maxLon.toFixed(3)}°</text></svg></div><div class="map-node-list">${nodes.map(n => `<button data-node="${n.num}"><b>${e(n.shortName)}</b><span>${n.latitude?.toFixed(5)}, ${n.longitude?.toFixed(5)}</span><em>${e(fmtAge(n.lastHeard))}</em></button>`).join("")}</div>`);
}
function topologyView() {
    return section("TOPOLOGY", "Evidence-first relationship view", `<div class="banner info"><b>TOPOLOGY RULE:</b> An RX packet from node A does not by itself prove that A was the immediately adjacent RF transmitter. MESHBOARD will not draw a direct edge unless NeighborInfo, traceroute, or other explicit relationship evidence supports it.</div><div class="empty large-empty"><b>NO AUTHORITATIVE LINK EDGES YET</b><span>NeighborInfo and traceroute relationship ingestion is reserved for the network-analysis phase. Current node and packet data remain available without fabricated topology.</span></div>`);
}
function analyticsRangeOptions(selected) {
    return ["1h", "6h", "24h", "7d", "all"].map(v => `<option value="${v}" ${selected === v ? "selected" : ""}>${rangeLabel(v)}</option>`).join("");
}
function rfView() {
    const state = project.rfTelemetry, range = state.timeRange;
    const nodeFilter = state.rfNode === "all" ? undefined : Number(state.rfNode);
    const rssiPoints = rfPoints(project, "rssi", range, nodeFilter), snrPoints = rfPoints(project, "snr", range, nodeFilter);
    const rssi = analyticsStats(rssiPoints), snr = analyticsStats(snrPoints);
    const rows = rfNodeStats(project, range).sort((a, b) => (b.rssi.median ?? -Infinity) - (a.rssi.median ?? -Infinity));
    const rate = packetRateBins(project, range);
    const utilNode = project.radio.nodeNum;
    const util = telemetryPoints(project, "channelUtilization", range, "all", utilNode), airtime = telemetryPoints(project, "airUtilTx", range, "all", utilNode);
    const utilStats = analyticsStats(util), airStats = analyticsStats(airtime);
    const ranked = rows.filter(r => r.rssi.median !== undefined), strongest = ranked[0], weakest = ranked.at(-1);
    const nodeOptions = project.nodes.map(n => `<option value="${n.num}" ${state.rfNode === String(n.num) ? "selected" : ""}>${e(n.shortName)} · ${e(n.longName)}</option>`).join("");
    const selectedLabel = nodeFilter === undefined ? "ALL NODES" : nodeName(nodeFilter);
    const table = rows.map(r => { const n = project.nodes.find(x => x.num === r.nodeNum); return `<tr data-node="${r.nodeNum}"><td><b>${e(n?.shortName || nodeName(r.nodeNum))}</b><small>${e(n?.longName || "")}</small></td><td>${r.samples}</td><td>${fixed(r.rssi.min, 0, " dBm")}</td><td>${fixed(r.rssi.median, 0, " dBm")}</td><td>${fixed(r.rssi.max, 0, " dBm")}</td><td>${fixed(r.snr.min, 1, " dB")}</td><td>${fixed(r.snr.median, 1, " dB")}</td><td>${fixed(r.snr.max, 1, " dB")}</td><td>${e(fmtTime(r.latestTime))}</td><td><span class="prov calculated">CALCULATED</span></td></tr>`; }).join("");
    return section("RF", "Time-windowed received-signal and mesh-traffic analytics with packet-level provenance", `<div class="banner info"><b>MEASUREMENT CONTEXT.</b><span>RSSI and SNR are observations attached to packets received by the connected radio. Rankings and statistics summarize retained observations; they do not establish symmetric links, packet-delivery ratio, or path loss.</span></div>
    <div class="analytics-toolbar"><label>TIME WINDOW<select id="analytics-range">${analyticsRangeOptions(range)}</select></label><label>RF NODE<select id="rf-node-filter"><option value="all">All observed nodes</option>${nodeOptions}</select></label><span class="analytics-scope">${e(rangeLabel(range))} · ${e(selectedLabel)}</span><button data-action="export-rf-analytics">EXPORT RF CSV</button><button data-action="evidence-from-rf">ADD SUMMARY TO EVIDENCE</button></div>
    <div class="metric-grid analytics-metrics">${card("RSSI SAMPLES", rssi.samples)}${card("MEDIAN RSSI", fixed(rssi.median, 0, " dBm"), rssi.samples ? `${fixed(rssi.min, 0, " dBm")} min · ${fixed(rssi.max, 0, " dBm")} max` : "no observations")}${card("SNR SAMPLES", snr.samples)}${card("MEDIAN SNR", fixed(snr.median, 1, " dB"), snr.samples ? `${fixed(snr.min, 1, " dB")} min · ${fixed(snr.max, 1, " dB")} max` : "no observations")}${card("STRONGEST MED RSSI", strongest ? nodeName(strongest.nodeNum) : "—", strongest ? fixed(strongest.rssi.median, 0, " dBm") : "no samples")}${card("LOWEST MED RSSI", weakest ? nodeName(weakest.nodeNum) : "—", weakest ? fixed(weakest.rssi.median, 0, " dBm") : "no samples")}${card("CHANNEL UTIL", fixed(utilStats.latest, 1, "%"), `${utilStats.samples} local-radio samples`)}${card("TX AIRTIME", fixed(airStats.latest, 1, "%"), `${airStats.samples} local-radio samples`)}</div>
    <div class="analytics-grid"><div class="analytics-panel"><div class="panel-title">RSSI DISTRIBUTION · ${e(selectedLabel)}</div>${svgHistogram(rssiPoints.map(p => p.value), "RSSI", " dBm", 14, 0)}<div class="analytics-provenance">${rssi.samples} packet-associated measurements · <span class="prov observed">OBSERVED</span> → <span class="prov calculated">CALCULATED</span></div></div><div class="analytics-panel"><div class="panel-title">SNR DISTRIBUTION · ${e(selectedLabel)}</div>${svgHistogram(snrPoints.map(p => p.value), "SNR", " dB", 14, 1)}<div class="analytics-provenance">${snr.samples} packet-associated measurements · <span class="prov observed">OBSERVED</span> → <span class="prov calculated">CALCULATED</span></div></div></div>
    <div class="analytics-panel wide"><div class="panel-title">PACKET ACTIVITY · RX / TX</div>${svgPacketRate(rate)}<div class="chart-legend"><span class="rx-key">RX</span><span class="tx-key">TX</span><small>${project.packets.filter(p => p.direction === "RX").length} RX and ${project.packets.filter(p => p.direction === "TX").length} TX retained overall; chart uses selected window.</small></div></div>
    <div class="analytics-grid"><div class="analytics-panel"><div class="panel-title">CONNECTED-RADIO CHANNEL UTILIZATION TELEMETRY</div>${svgTimeSeries(util, "Channel utilization", "%", 1)}<div class="analytics-provenance">Latest ${fixed(utilStats.latest, 1, "%")} · mean ${fixed(utilStats.mean, 1, "%")} · ${utilStats.samples} samples</div></div><div class="analytics-panel"><div class="panel-title">CONNECTED-RADIO TX AIRTIME TELEMETRY</div>${svgTimeSeries(airtime, "TX airtime", "%", 1)}<div class="analytics-provenance">Latest ${fixed(airStats.latest, 1, "%")} · mean ${fixed(airStats.mean, 1, "%")} · ${airStats.samples} samples</div></div></div>
    <div class="panel-title analytics-table-title">NODE RF RANKING BY MEDIAN RSSI · SAMPLE-SUPPORTED, NOT A QUALITY SCORE</div><div class="table-wrap"><table><thead><tr><th>NODE</th><th>SAMPLES</th><th>RSSI MIN</th><th>RSSI MED</th><th>RSSI MAX</th><th>SNR MIN</th><th>SNR MED</th><th>SNR MAX</th><th>LATEST</th><th>PROVENANCE</th></tr></thead><tbody>${table || '<tr><td colspan="10"><div class="empty">No RF packet measurements in this window.</div></td></tr>'}</tbody></table></div>`);
}
function packetsView() {
    const filter = project.packetLab.filter;
    filter.search = runtime.packetSearch;
    const allFiltered = filteredPackets(project.packets, filter, runtime.packetLivePaused ? runtime.packetPauseAt : undefined, nodeName);
    const packets = allFiltered.slice(0, settings.livePacketLimit);
    const selected = runtime.selectedPacket ? project.packets.find(p => p.id === runtime.selectedPacket) : undefined;
    const ports = portNumStats(allFiltered);
    const rx = allFiltered.filter(p => p.direction === "RX").length, tx = allFiltered.length - rx;
    const encrypted = allFiltered.filter(p => p.encrypted === true).length, ack = allFiltered.filter(p => p.wantAck === true).length;
    const portOptions = [...new Set(project.packets.map(p => p.portNum).filter((x) => !!x))].sort().map(x => `<option value="${e(x)}" ${filter.portNum === x ? "selected" : ""}>${e(x)}</option>`).join("");
    const channelOptions = [...new Set(project.packets.map(p => p.channel).filter((x) => typeof x === "number"))].sort((a, b) => a - b).map(x => `<option value="${x}" ${filter.channel === String(x) ? "selected" : ""}>${x} · ${e(channelName(x))}</option>`).join("");
    const liveLabel = runtime.packetLivePaused ? `RESUME LIVE${runtime.packetNewWhilePaused ? ` (${runtime.packetNewWhilePaused} NEW)` : ""}` : "PAUSE LIVE";
    const filterBar = `<div class="packet-filterbar">
    <input id="packet-search" placeholder="Search packet ID, node, PortNum, transport, hex…" value="${e(runtime.packetSearch)}">
    <select id="packet-direction"><option value="all">All directions</option><option value="RX" ${filter.direction === "RX" ? "selected" : ""}>RX only</option><option value="TX" ${filter.direction === "TX" ? "selected" : ""}>TX only</option></select>
    <select id="packet-portnum"><option value="">All PortNums</option>${portOptions}</select>
    <select id="packet-channel"><option value="">All channels</option>${channelOptions}</select>
    <input id="packet-source" placeholder="Source node / ID" value="${e(filter.source)}">
    <input id="packet-destination" placeholder="Destination node / ID" value="${e(filter.destination)}">
    <select id="packet-ack"><option value="all">ACK: any</option><option value="yes" ${filter.wantAck === "yes" ? "selected" : ""}>ACK requested</option><option value="no" ${filter.wantAck === "no" ? "selected" : ""}>No ACK request</option></select>
    <select id="packet-encryption"><option value="all">Encryption: any</option><option value="decrypted" ${filter.encryption === "decrypted" ? "selected" : ""}>Decoded/decrypted</option><option value="encrypted" ${filter.encryption === "encrypted" ? "selected" : ""}>Encrypted payload</option><option value="pki" ${filter.encryption === "pki" ? "selected" : ""}>PKI encrypted</option></select>
    <select id="packet-time"><option value="all">All retained time</option><option value="5m" ${filter.timeRange === "5m" ? "selected" : ""}>Last 5 min</option><option value="1h" ${filter.timeRange === "1h" ? "selected" : ""}>Last hour</option><option value="24h" ${filter.timeRange === "24h" ? "selected" : ""}>Last 24 hours</option></select>
    <button data-action="clear-packet-filters">CLEAR FILTERS</button>
  </div>`;
    const portSummary = ports.length ? `<div class="packet-port-summary">${ports.slice(0, 8).map(stat => `<button data-port-filter="${e(stat.portNum)}"><b>${e(stat.portNum)}</b><span>${stat.total} packets</span><small>${stat.rx} RX · ${stat.tx} TX · ${stat.bytes} B</small></button>`).join("")}</div>` : "";
    const table = `<div class="table-wrap packet-table"><table><thead><tr><th>TIME</th><th>DIR</th><th>SOURCE</th><th>DESTINATION</th><th>PORTNUM</th><th>CH</th><th>ID</th><th>ACK</th><th>ENC</th><th>HOPS</th><th>RSSI</th><th>SNR</th><th>SIZE</th><th>TRANSPORT</th></tr></thead><tbody>${packets.map(p => `<tr data-packet="${p.id}" class="${runtime.selectedPacket === p.id ? "selected" : ""}"><td>${e(new Date(p.time).toLocaleTimeString())}</td><td><span class="dir ${p.direction.toLowerCase()}">${p.direction}</span></td><td>${e(nodeName(p.source))}</td><td>${p.destination === 0xffffffff ? "BROADCAST" : e(nodeName(p.destination))}</td><td class="mono">${e(p.portNum || "—")}</td><td>${e(p.channel ?? "—")}</td><td class="mono">${e(p.packetId ?? "—")}</td><td>${p.wantAck ? '<span class="packet-flag">ACK</span>' : "—"}</td><td>${p.pkiEncrypted ? '<span class="packet-flag">PKI</span>' : p.encrypted ? '<span class="packet-flag muted">ENC</span>' : "—"}</td><td>${e(p.hopLimit ?? "—")}/${e(p.hopStart ?? "—")}</td><td>${fixed(p.rssi, 0, " dBm")}</td><td>${fixed(p.snr, 1, " dB")}</td><td>${e(p.size ?? "—")}</td><td>${e(p.transport || (p.viaMqtt ? "MQTT" : "—"))}</td></tr>`).join("")}</tbody></table></div>`;
    const inspector = selected ? packetInspector(selected) : "";
    const pauseBanner = runtime.packetLivePaused ? `<div class="banner warning packet-pause"><b>LIVE DISPLAY PAUSED.</b> Recording continues in IndexedDB/project memory. ${runtime.packetNewWhilePaused} newer packet${runtime.packetNewWhilePaused === 1 ? "" : "s"} captured since ${e(fmtTime(runtime.packetPauseAt))}.</div>` : "";
    return section("PACKET LABORATORY", "Structured Meshtastic packet inspection with filtering, raw payload evidence, and provenance", `${pauseBanner}<div class="metric-grid packet-metrics">${card("VISIBLE", allFiltered.length, `displaying ${packets.length}`)}${card("RX / TX", `${rx} / ${tx}`)}${card("ACK REQUESTED", ack)}${card("ENCRYPTED", encrypted)}</div>${filterBar}<div class="packet-toolbar"><span>${packets.length} shown · ${project.packets.length} retained</span><button data-action="packet-live-toggle" class="${runtime.packetLivePaused ? "primary" : ""}">${e(liveLabel)}</button><button data-action="export-filtered-packets">EXPORT FILTERED CSV</button><button data-action="export-packets">EXPORT ALL CSV</button></div>${portSummary}<div class="with-inspector packet-workbench"><div class="grow">${table}</div>${inspector}</div>`);
}
function packetInspector(selected) {
    const tab = project.packetLab.inspectorTab;
    const tabs = ['summary', 'decoded', 'raw', 'provenance', 'related'].map(id => `<button data-packet-tab="${id}" class="${tab === id ? "active" : ""}">${id.toUpperCase()}</button>`).join("");
    let body = "";
    if (tab === "summary")
        body = `${kv({ "Record ID": selected.id, "Time": fmtTime(selected.time), "Direction": selected.direction, "Source": nodeName(selected.source), "Destination": selected.destination === BROADCAST_NUM ? "Broadcast" : nodeName(selected.destination), "PortNum": selected.portNum, "Channel": selected.channel, "Packet ID": selected.packetId, "Priority": selected.priority, "Hop limit": selected.hopLimit, "Hop start": selected.hopStart, "Want ACK": selected.wantAck, "Want response": selected.wantResponse, "Encrypted payload": selected.encrypted, "PKI encrypted": selected.pkiEncrypted, "Via MQTT": selected.viaMqtt, "Transport": selected.transport, "Delayed": selected.delayed, "Next hop": selected.nextHop === undefined ? undefined : nodeName(selected.nextHop), "Relay node": selected.relayNode === undefined ? undefined : nodeName(selected.relayNode), "Request ID": selected.requestId, "Reply ID": selected.replyId, "Emoji": selected.emoji, "RSSI": fixed(selected.rssi, 0, " dBm"), "SNR": fixed(selected.snr, 1, " dB"), "Payload size": selected.size })}`;
    if (tab === "decoded")
        body = selected.decoded ? `<div class="inspector-note"><b>DECODED DATA OBJECT</b><span>This is the decoded Meshtastic Data object exposed by the SDK, not an independently re-decoded wire frame.</span></div><pre>${e(JSON.stringify(selected.decoded, null, 2))}</pre>` : `<div class="empty large-empty packet-empty"><b>NO DECODED PAYLOAD RETAINED</b><span>The packet may have arrived encrypted or this project predates schema v4 packet-detail capture.</span></div>`;
    if (tab === "raw")
        body = `<div class="inspector-note"><b>PAYLOAD BYTES</b><span>Hex below represents the payload bytes exposed by the SDK. MESHBOARD does not claim this is the original Web Serial framing envelope.</span></div>${selected.rawHex ? `<pre class="hex-view">${e(hexLines(selected.rawHex))}</pre><button data-action="copy-packet-hex">COPY PAYLOAD HEX</button>` : '<div class="empty">No payload bytes retained for this record.</div>'}<div class="panel-title">SDK PACKET OBJECT</div><pre>${e(JSON.stringify(selected.raw ?? selected, null, 2))}</pre>`;
    if (tab === "provenance")
        body = `<div class="provenance-stack"><div><b>OBSERVATION CLASS</b><span class="prov observed">${e(selected.provenance)}</span></div><div><b>CAPTURE TIME</b><span>${e(fmtTime(selected.time))}</span></div><div><b>CAPTURE PATH</b><span>Meshtastic MeshClient → onMeshPacket → MESHBOARD PacketRecord</span></div><div><b>RF MEASUREMENTS</b><span>${selected.direction === "RX" ? "RSSI/SNR, when present, are observations reported for this received packet." : "TX records do not invent receive-side RSSI/SNR."}</span></div><div><b>TOPOLOGY LIMIT</b><span>Source/destination fields identify packet endpoints; they do not by themselves prove an immediately adjacent RF link.</span></div><div><b>RAW LIMIT</b><span>MESHBOARD retains the SDK packet object and payload bytes, not the original 0x94 C3 serial framing bytes.</span></div></div>`;
    if (tab === "related") {
        const related = relatedPackets(project.packets, selected).slice(0, 25);
        const messages = project.messages.filter(m => m.packetRecordId === selected.id || m.packetId === selected.packetId);
        body = `<div class="panel-title">RELATED MESSAGES</div>${messages.length ? messages.map(m => `<button class="related-record" data-related-message="${m.id}"><b>${e(m.direction)} · ${e(m.state)}</b><span>${e(m.text)}</span><small>${e(fmtTime(m.time))}</small></button>`).join("") : '<div class="empty">No message record linked to this packet.</div>'}<div class="panel-title">CORRELATED PACKETS</div>${related.length ? related.map(p => `<button class="related-record" data-related-packet="${p.id}"><b>${e(p.direction)} · ${e(p.portNum || "UNKNOWN")} · ${e(p.packetId ?? "—")}</b><span>${e(nodeName(p.source))} → ${p.destination === BROADCAST_NUM ? "Broadcast" : e(nodeName(p.destination))}</span><small>${e(fmtTime(p.time))}</small></button>`).join("") : '<div class="empty">No request/reply/packet-ID correlations found in retained history.</div>'}`;
    }
    return `<aside class="inspector packet-inspector"><div class="inspector-head"><span>PACKET INSPECTOR</span><button data-action="close-inspector">×</button></div><div class="packet-inspector-tabs">${tabs}</div>${body}<div class="packet-inspector-actions"><button data-action="export-selected-packet">EXPORT JSON</button><button data-action="evidence-from-packet" class="primary">ADD TO EVIDENCE</button></div></aside>`;
}
function telemetryView() {
    const state = project.rfTelemetry, range = state.timeRange;
    const selectedNode = state.telemetryNode === "all" ? undefined : Number(state.telemetryNode);
    const kinds = telemetryKinds(project);
    const kind = state.telemetryKind;
    let metrics = telemetryMetricKeys(project, range, kind, selectedNode);
    if (!metrics.some(m => m.key === state.telemetryMetric))
        state.telemetryMetric = metrics[0]?.key || "batteryLevel";
    const descriptor = metricDescriptor(state.telemetryMetric);
    const points = telemetryPoints(project, state.telemetryMetric, range, kind, selectedNode);
    const stats = analyticsStats(points);
    const readings = project.telemetry.filter(t => { if (selectedNode !== undefined && t.nodeNum !== selectedNode)
        return false; if (kind !== "all" && t.kind !== kind)
        return false; const start = range === "all" ? undefined : Date.now() - { "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000 }[range]; return start === undefined || new Date(t.time).getTime() >= start; });
    const reportingNodes = new Set(readings.map(t => t.nodeNum));
    const latestByKindNode = new Map();
    for (const t of readings)
        latestByKindNode.set(`${t.nodeNum}:${t.kind}`, t);
    const nodeOptions = project.nodes.map(n => `<option value="${n.num}" ${state.telemetryNode === String(n.num) ? "selected" : ""}>${e(n.shortName)} · ${e(n.longName)}</option>`).join("");
    const kindOptions = kinds.map(k => `<option value="${e(k)}" ${kind === k ? "selected" : ""}>${e(k)}</option>`).join("");
    const metricOptions = metrics.map(m => `<option value="${e(m.key)}" ${state.telemetryMetric === m.key ? "selected" : ""}>${e(m.group)} · ${e(m.label)}</option>`).join("");
    const sourceRows = [...latestByKindNode.values()].sort((a, b) => nodeName(a.nodeNum).localeCompare(nodeName(b.nodeNum)) || a.kind.localeCompare(b.kind));
    const catalogByKind = new Map();
    for (const t of readings) {
        const set = catalogByKind.get(t.kind) ?? new Set();
        for (const k of Object.keys(telemetryNumericValues(t)))
            set.add(k.split(".").at(-1) || k);
        catalogByKind.set(t.kind, set);
    }
    return section("TELEMETRY", "Time-series analysis of Meshtastic device, environment, air-quality, power, local-stat, health, host, and traffic-management telemetry", `<div class="banner info"><b>TELEMETRY PROVENANCE.</b><span>MESHBOARD stores the telemetry variant and numeric values reported by Meshtastic. Min/max/mean/median/trend displays are calculated locally from the selected retained records; missing values are not interpolated.</span></div>
    <div class="analytics-toolbar telemetry-toolbar"><label>TIME WINDOW<select id="analytics-range">${analyticsRangeOptions(range)}</select></label><label>NODE<select id="telemetry-node-filter"><option value="all">All reporting nodes</option>${nodeOptions}</select></label><label>TELEMETRY TYPE<select id="telemetry-kind-filter"><option value="all">All telemetry types</option>${kindOptions}</select></label><label>METRIC<select id="telemetry-metric">${metricOptions || '<option value="batteryLevel">No numeric metrics</option>'}</select></label><button data-action="export-telemetry-analytics">EXPORT ANALYTICS CSV</button><button data-action="evidence-from-telemetry">ADD SUMMARY TO EVIDENCE</button></div>
    <div class="metric-grid analytics-metrics">${card("READINGS", readings.length)}${card("REPORTING NODES", reportingNodes.size)}${card("METRIC SAMPLES", stats.samples)}${card("LATEST", stats.latest === undefined ? "—" : `${stats.latest.toFixed(descriptor.decimals)}${descriptor.unit}`)}${card("MEAN", stats.mean === undefined ? "—" : `${stats.mean.toFixed(descriptor.decimals)}${descriptor.unit}`)}${card("MEDIAN", stats.median === undefined ? "—" : `${stats.median.toFixed(descriptor.decimals)}${descriptor.unit}`)}</div>
    <div class="analytics-grid"><div class="analytics-panel"><div class="panel-title">${e(descriptor.label.toUpperCase())} OVER TIME</div>${svgTimeSeries(points, descriptor.label, descriptor.unit, descriptor.decimals)}<div class="analytics-provenance">${stats.samples} observations · ${stats.firstTime ? `${e(fmtTime(stats.firstTime))} → ${e(fmtTime(stats.lastTime))}` : "no selected observations"}</div></div><div class="analytics-panel"><div class="panel-title">${e(descriptor.label.toUpperCase())} DISTRIBUTION</div>${svgHistogram(points.map(p => p.value), descriptor.label, descriptor.unit, 14, descriptor.decimals)}<div class="analytics-stat-strip"><span>MIN <b>${stats.min === undefined ? "—" : `${stats.min.toFixed(descriptor.decimals)}${descriptor.unit}`}</b></span><span>MAX <b>${stats.max === undefined ? "—" : `${stats.max.toFixed(descriptor.decimals)}${descriptor.unit}`}</b></span><span>MEAN <b>${stats.mean === undefined ? "—" : `${stats.mean.toFixed(descriptor.decimals)}${descriptor.unit}`}</b></span></div></div></div>
    <div class="panel analytics-catalog"><div class="panel-title">OBSERVED TELEMETRY CATALOG</div>${[...catalogByKind.entries()].map(([k, keys]) => `<div class="catalog-row"><b>${e(k)}</b><span>${[...keys].map(x => e(metricDescriptor(x).label)).join(" · ")}</span><em>${readings.filter(t => t.kind === k).length} records</em></div>`).join("") || '<div class="empty">No telemetry in this window.</div>'}</div>
    <div class="panel-title analytics-table-title">LATEST RETAINED RECORD BY NODE + TYPE</div><div class="telemetry-grid">${sourceRows.map(t => `<div class="telemetry-card"><div class="panel-title">${e(nodeName(t.nodeNum))}</div><span class="prov observed">${e(t.provenance)}</span><time>${e(fmtTime(t.time))}</time><h4>${e(t.kind)}</h4>${objectGrid(t.values)}</div>`).join("") || '<div class="empty large-empty">No telemetry recorded in the selected window.</div>'}</div>`);
}
function radioView() {
    const observed = { "Node": project.radio.longName, "Short name": project.radio.shortName, "Node number": project.radio.nodeNum, "Hardware": project.radio.hardware, "Firmware": project.radio.firmware, "Battery": pct(project.radio.battery), "Voltage": fixed(project.radio.voltage, 2, " V"), "Channel utilization": fixed(project.radio.channelUtilization, 1, "%"), "Air utilization TX": fixed(project.radio.airUtilTx, 1, "%"), "Connected": fmtTime(project.radio.connectedAt), "Last RX": fmtTime(project.radio.lastRxAt), "Last TX": fmtTime(project.radio.lastTxAt) };
    const configured = { "Role": project.radio.role, "Region": project.radio.region, "Modem preset": project.radio.modemPreset, "TX power": project.radio.txPower, "Hop limit": project.radio.hopLimit };
    const actions = runtime.connection === "CONNECTED" ? '<button data-action="resync">RESYNC</button><button data-action="disconnect">DISCONNECT</button>' : '<button class="primary" data-action="connect">CONNECT RADIO</button>';
    return section("RADIO", "Physically connected Meshtastic device", `<div class="two-col"><div class="panel"><div class="panel-title">OBSERVED VALUES <span class="prov observed">OBSERVED</span></div>${kv(observed)}</div><div class="panel"><div class="panel-title">CONFIGURED VALUES <span class="prov configured">CONFIGURED</span></div>${kv(configured)}</div></div><div class="panel"><div class="panel-title">USB SERIAL</div>${kv({ "Web Serial": ("serial" in navigator) ? "Available" : "Unavailable", "USB vendor ID": project.radio.serialVendorId ? `0x${project.radio.serialVendorId.toString(16)}` : "—", "USB product ID": project.radio.serialProductId ? `0x${project.radio.serialProductId.toString(16)}` : "—", "SDK state": runtime.sdkState })}</div>`, actions);
}
function channelsView() {
    return section("CHANNELS", "Channel inventory synchronized from the connected radio", `<div class="banner info"><b>READ-ONLY IN v0.3.</b> Channel writes are intentionally deferred until staged configuration editing is implemented. PSK material is never rendered here.</div><div class="channel-grid">${project.channels.map(c => `<div class="channel-card"><span>CHANNEL ${c.index}</span><h3>${e(c.name)}</h3><b>${e(c.role)}</b>${kv({ "Uplink": c.uplinkEnabled ? "Enabled" : "Disabled", "Downlink": c.downlinkEnabled ? "Enabled" : "Disabled", "PSK": c.pskConfigured ? "Configured / masked" : "Not reported" })}</div>`).join("") || '<div class="empty large-empty">No channel configuration recorded.</div>'}</div>`);
}
function configView() {
    return section("CONFIGURATION", "Structured configuration snapshot — observation and configuration remain separate", `<div class="banner warning"><b>SAFE READ-ONLY MODE.</b> v0.3 synchronizes and records configuration but does not write settings. Future writes will be staged and require an explicit APPLY TO RADIO action.</div><div class="two-col"><div class="panel"><div class="panel-title">RADIO CONFIG <span class="prov configured">CONFIGURED</span></div><pre>${e(JSON.stringify(project.config.radio, null, 2))}</pre></div><div class="panel"><div class="panel-title">MODULE CONFIG <span class="prov configured">CONFIGURED</span></div><pre>${e(JSON.stringify(project.config.modules, null, 2))}</pre></div></div>`);
}
function timelineView() {
    const events = [...project.timeline].reverse().slice(0, 1000);
    return section("TIMELINE", "Chronological record of connection, traffic, findings, and operator events", `<div class="timeline">${events.map(ev => `<div class="timeline-item"><time>${e(fmtTime(ev.time))}</time><span class="sev ${ev.severity.toLowerCase()}">${ev.severity}</span><div><b>${e(ev.type.toUpperCase())}</b><p>${e(ev.text)}</p>${ev.nodeNum ? `<small>${e(nodeName(ev.nodeNum))}</small>` : ""}</div><span class="prov ${ev.provenance.toLowerCase().replace(" ", "-")}">${e(ev.provenance)}</span></div>`).join("") || '<div class="empty large-empty">No timeline events recorded.</div>'}</div>`);
}
function logbookView() {
    return section("LOGBOOK", "Timestamped field notes stored with the project", `<div class="log-compose"><textarea id="log-text" placeholder="Record a field observation, antenna change, movement, test condition, or operator note…"></textarea><select id="log-node"><option value="">No node reference</option>${project.nodes.map(n => `<option value="${n.num}">${e(n.shortName)} · ${e(n.longName)}</option>`).join("")}</select><button class="primary" data-action="add-log">ADD TIMESTAMPED NOTE</button></div><div class="log-list">${[...project.logbook].reverse().map(l => `<div class="log-entry"><time>${e(fmtTime(l.time))}</time>${l.nodeNum ? `<b>${e(nodeName(l.nodeNum))}</b>` : ""}<p>${e(l.text)}</p></div>`).join("") || '<div class="empty">No operator notes yet.</div>'}</div>`);
}
function compareView() {
    const snaps = project.snapshots;
    const a = snaps.at(-2), b = snaps.at(-1);
    let comparison = '<div class="empty large-empty"><b>CREATE TWO SNAPSHOTS</b><span>Snapshots freeze node state, radio state, counts, findings, and configuration for later comparison.</span></div>';
    if (a && b) {
        const am = new Map(a.nodes.map(n => [n.num, n])), bm = new Map(b.nodes.map(n => [n.num, n]));
        const added = b.nodes.filter(n => !am.has(n.num)), removed = a.nodes.filter(n => !bm.has(n.num));
        const changed = b.nodes.filter(n => { const old = am.get(n.num); return old && (old.battery !== n.battery || old.snr !== n.snr || old.lastHeard !== n.lastHeard); });
        comparison = `<div class="compare-head"><div><span>BEFORE</span><b>${e(a.name)}</b><small>${e(fmtTime(a.time))}</small></div><div>→</div><div><span>AFTER</span><b>${e(b.name)}</b><small>${e(fmtTime(b.time))}</small></div></div><div class="metric-grid">${card("NODES ADDED", added.length)}${card("NODES REMOVED", removed.length)}${card("NODES CHANGED", changed.length)}${card("PACKET Δ", b.packetCount - a.packetCount)}${card("MESSAGE Δ", b.messageCount - a.messageCount)}${card("FINDING Δ", b.findings.length - a.findings.length)}</div><div class="two-col"><div class="panel"><div class="panel-title">ADDED</div>${added.map(n => `<div class="simple-row"><b>${e(n.shortName)}</b><span>${e(n.longName)}</span></div>`).join("") || '<div class="empty">None</div>'}</div><div class="panel"><div class="panel-title">REMOVED</div>${removed.map(n => `<div class="simple-row"><b>${e(n.shortName)}</b><span>${e(n.longName)}</span></div>`).join("") || '<div class="empty">None</div>'}</div></div><div class="panel"><div class="panel-title">CHANGED NODES</div>${changed.map(n => { const old = am.get(n.num); return `<div class="change-row"><b>${e(n.shortName)}</b><span>Battery ${pct(old.battery)} → ${pct(n.battery)}</span><span>SNR ${fixed(old.snr, 1, " dB")} → ${fixed(n.snr, 1, " dB")}</span><span>Last heard ${e(fmtAge(n.lastHeard))}</span></div>`; }).join("") || '<div class="empty">None</div>'}</div>`;
    }
    return section("COMPARE", "Immutable mesh-state snapshots", `<div class="snapshot-bar"><button class="primary" data-action="snapshot">CREATE NETWORK SNAPSHOT</button><span>${snaps.length} snapshots</span></div>${comparison}<div class="snapshot-list">${[...snaps].reverse().map(s => `<div><b>${e(s.name)}</b><span>${e(fmtTime(s.time))}</span><small>${s.nodes.length} nodes · ${s.packetCount} packets</small></div>`).join("")}</div>`);
}
function evidenceView() {
    return section("EVIDENCE", "Traceable records that point back to underlying observations", `<div class="banner info"><b>TRACEABILITY.</b> Evidence records reference packet IDs or node state rather than copying unexplained values into a report.</div><div class="evidence-list">${[...project.evidence].reverse().map(x => `<article class="evidence"><div><span>${e(x.id)}</span><time>${e(fmtTime(x.time))}</time></div><h3>${e(x.title)}</h3>${x.nodeNum ? `<b>${e(nodeName(x.nodeNum))}</b>` : ""}<p>${e(x.observation)}</p><small>Supporting packets: ${e(x.packetIds.join(", ") || "none")}</small>${x.notes ? `<em>${e(x.notes)}</em>` : ""}</article>`).join("") || '<div class="empty large-empty">No evidence records. Select a packet in PACKETS and choose ADD TO EVIDENCE.</div>'}</div>`);
}
function diagnosticsView() {
    const sync = runtime.sync;
    return section("DIAGNOSTICS", "Transport, synchronization, recovery, storage, and application health", `
    ${connectionProgressPanel()}
    <div class="three-col diagnostics-grid">
      <div class="panel"><div class="panel-title">CONNECTION</div>${kv({
        "Web Serial support": ("serial" in navigator) ? "YES" : "NO", "Secure context": window.isSecureContext ? "YES" : "NO",
        "Connection state": runtime.connection, "Reason": runtime.connectionReason || "—", "SDK state": runtime.sdkState,
        "State changed": fmtTime(runtime.stateChangedAt), "Connected": fmtTime(runtime.connectedAt), "Disconnected": fmtTime(runtime.disconnectedAt),
        "Last disconnect cause": runtime.lastDisconnectCause || "—", "Reconnect attempt": runtime.reconnectAttempt || 0, "Next reconnect": fmtTime(runtime.nextReconnectAt)
    })}</div>
      <div class="panel"><div class="panel-title">SYNCHRONIZATION</div>${kv({
        "Phase": sync.phase.toUpperCase(), "Nodes received": sync.nodes, "Channels received": sync.channels, "Radio config packets": sync.config,
        "Module config packets": sync.modules, "My node info": sync.myInfo ? "YES" : "NO", "Device metadata": sync.metadata ? "YES" : "NO",
        "Last valid protocol data": fmtTime(runtime.lastValidProtocolAt), "Last transport event": fmtTime(runtime.lastTransportEventAt)
    })}</div>
      <div class="panel"><div class="panel-title">USB SERIAL</div>${kv({
        "Vendor ID": runtime.serialInfo?.usbVendorId !== undefined ? `0x${runtime.serialInfo.usbVendorId.toString(16).padStart(4, "0")}` : "—",
        "Product ID": runtime.serialInfo?.usbProductId !== undefined ? `0x${runtime.serialInfo.usbProductId.toString(16).padStart(4, "0")}` : "—",
        "Baud rate": runtime.serialInfo?.baudRate || "—", "Radio": project.radio.longName || "—", "Firmware": project.radio.firmware || "—",
        "Last RX": fmtTime(project.radio.lastRxAt), "Last TX": fmtTime(project.radio.lastTxAt)
    })}</div>
    </div>
    <div class="two-col"><div class="panel"><div class="panel-title">TRAFFIC / ERRORS</div>${kv({
        "Session RX events": runtime.rxCount, "Session TX events": runtime.txCount, "Recorded packets": project.packets.length, "Messages": project.messages.length,
        "Telemetry": project.telemetry.length, "Node observations": project.nodeObservations.length, "PortNums observed": portNumStats(project.packets).length, "Decode errors": runtime.decodeErrors, "Protocol/application errors": runtime.protocolErrors
    })}</div><div class="panel"><div class="panel-title">APPLICATION</div>${kv({
        "Application version": APP_VERSION, "Schema version": project.schemaVersion, "Storage": storageText, "Browser": navigator.userAgent
    })}</div></div>
    <div class="toolbar"><button data-action="export-diagnostics">EXPORT DIAGNOSTIC BUNDLE</button><button data-action="print-report">PRINT / SAVE PDF REPORT</button><button data-action="reconnect" ${runtime.connection === "CONNECTING" || runtime.connection === "SERIAL_OPEN" || runtime.connection === "SYNCHRONIZING" ? "disabled" : ""}>RECONNECT</button><button data-action="resync" ${runtime.connection !== "CONNECTED" ? "disabled" : ""}>RESYNC RADIO</button></div>`);
}
function settingsView() {
    return section("SETTINGS", "Local application preferences; these controls do not modify the radio", `<div class="settings-grid"><label>APPEARANCE<select id="setting-theme"><option value="system" ${settings.theme === "system" ? "selected" : ""}>System</option><option value="dark" ${settings.theme === "dark" ? "selected" : ""}>Dark</option><option value="light" ${settings.theme === "light" ? "selected" : ""}>Light</option></select></label><label>NODE ACTIVE THROUGH (MIN)<input id="setting-active" type="number" min="1" value="${settings.activeMinutes}"></label><label>NODE RECENT THROUGH (MIN)<input id="setting-stale" type="number" min="2" value="${settings.staleMinutes}"></label><label>NODE STALE THROUGH / LOST AFTER (MIN)<input id="setting-lost" type="number" min="3" value="${settings.lostMinutes}"></label><label>LIVE PACKET DISPLAY LIMIT<input id="setting-packets" type="number" min="100" max="10000" step="100" value="${settings.livePacketLimit}"></label><label>TELEMETRY RETENTION COUNT<input id="setting-telemetry" type="number" min="100" max="50000" step="100" value="${settings.telemetryLimit}"></label><label>NODE OBSERVATION RETENTION<input id="setting-node-history" type="number" min="1000" max="250000" step="1000" value="${settings.nodeHistoryLimit}"></label><label class="check"><input id="setting-sw" type="checkbox" ${settings.serviceWorker ? "checked" : ""}> Enable same-origin offline asset cache</label></div><div class="banner info"><b>NODE FRESHNESS.</b> ACTIVE is through ${settings.activeMinutes} minutes; RECENT is through ${settings.staleMinutes}; STALE is through ${settings.lostMinutes}; older nodes are LOST. These are operator-configurable inventory thresholds, not RF quality judgments.</div><div class="danger-zone"><h3>DATA SAFETY</h3><p>Project data is not automatically cleared after connection or startup errors.</p><button data-action="clear-session">CLEAR SESSION TRAFFIC</button><button data-action="fresh-start">CLEAR CURRENT PROJECT / FRESH START</button><button data-action="reset-ui">RESET UI PREFERENCES</button></div>`);
}
function helpView() {
    return section("HELP", "MESHBOARD v0.6.5 field guide", `<div class="help-grid"><article><h3>GETTING STARTED</h3><p>Use a Chromium-based desktop browser on HTTPS or localhost. Flash normal Meshtastic firmware, attach the node by USB, and press CONNECT RADIO. The browser will ask you to choose a serial port.</p></article><article><h3>MESSAGING</h3><p>Messages are organized into channel and direct conversations. Outbound messages are stored immediately as SENDING, then become ACKNOWLEDGED or FAILED when the Meshtastic send pipeline resolves. Drafts are persisted per conversation.</p></article><article><h3>PACKET LABORATORY</h3><p>Advanced Mode exposes filters, PortNum analysis, ACK/encryption metadata, decoded SDK Data, retained payload hex, provenance, and related records. PAUSE LIVE freezes the packet view while capture continues.</p></article><article><h3>NODE INTELLIGENCE</h3><p>The NODES workbench separates current radio-observed state from retained historical observations and local field metadata. Saved views preserve filters, sort order, columns, and widths. RSSI/SNR history remains packet-associated evidence, not a claim of symmetric link quality.</p></article><article><h3>RF & TELEMETRY ANALYTICS</h3><p>RF and telemetry views use selectable time windows and preserve sample counts, source records, and observed-versus-calculated labeling. Channel utilization and TX airtime come from Meshtastic telemetry when available; MESHBOARD does not invent missing samples or collapse RF behavior into one score.</p></article><article><h3>WHAT WEB SERIAL DOES</h3><p>MESHBOARD uses Meshtastic's official Web Serial transport and MeshClient. The SDK performs framing, protobuf decoding, synchronization, and feature-state updates.</p></article><article><h3>RSSI / SNR</h3><p>These are received-packet observations. More negative RSSI generally indicates less received power; SNR describes signal relative to noise. Neither is automatically a symmetric end-to-end link measurement.</p></article><article><h3>TOPOLOGY</h3><p>MESHBOARD does not turn packet source addresses into invented direct RF edges. Authoritative topology will use NeighborInfo and traceroute evidence.</p></article><article><h3>PRIVACY</h3><p>Core operation uses the connected radio and local browser storage. The current map is a local SVG plot and does not send coordinates to a map provider.</p></article><article><h3>CONFIGURATION</h3><p>Configuration is read-only in v0.6.5. A future staged editor will separate current values from modified values and require APPLY TO RADIO before writing.</p></article><article><h3>TROUBLESHOOTING</h3><p>If the port is busy, close the Meshtastic CLI, Arduino serial monitor, screen, picocom, another browser tab, or any process holding the serial device, then reconnect.</p></article><article><h3>DATA RECOVERY</h3><p>Connection errors do not erase projects. Import/export JSON provides an additional portable backup.</p></article></div>`);
}
function findingsTable(findings) {
    if (!findings.length)
        return '<div class="empty">No findings.</div>';
    return `<div class="table-wrap"><table><thead><tr><th>SEVERITY</th><th>FINDING</th><th>NODE</th><th>OBSERVED</th><th>THRESHOLD</th><th>CONFIDENCE</th><th>STATUS</th></tr></thead><tbody>${findings.map(f => `<tr><td><span class="sev ${f.severity.toLowerCase()}">${f.severity}</span></td><td><b>${e(f.title)}</b></td><td>${e(nodeName(f.nodeNum))}</td><td>${e(f.observedValue || "—")}</td><td>${e(f.threshold || "—")}</td><td>${e(f.confidence)}</td><td><button class="tiny" data-finding="${e(f.id)}">${e(f.status)}</button></td></tr>`).join("")}</tbody></table></div>`;
}
function kv(values) { return `<dl class="kv">${Object.entries(values).map(([k, v]) => `<div><dt>${e(k)}</dt><dd>${e(v ?? "—")}</dd></div>`).join("")}</dl>`; }
function objectGrid(value) { return `<div class="object-grid">${Object.entries(value).slice(0, 16).map(([k, v]) => `<div><span>${e(k)}</span><b>${e(typeof v === "object" ? JSON.stringify(v) : v)}</b></div>`).join("")}</div>`; }
function bindRenderedControls() {
    for (const el of app.querySelectorAll("[data-view]"))
        el.onclick = () => { runtime.view = el.dataset.view; render(); };
    for (const el of app.querySelectorAll("[data-node]"))
        el.onclick = () => { runtime.selectedNode = Number(el.dataset.node); runtime.view = "nodes"; render(); };
    for (const el of app.querySelectorAll("[data-packet]"))
        el.onclick = () => { runtime.selectedPacket = el.dataset.packet; render(); };
    for (const el of app.querySelectorAll("[data-conversation]"))
        el.onclick = () => { setConversation(el.dataset.conversation || "channel:0"); render(); };
    for (const el of app.querySelectorAll("[data-message]"))
        el.onclick = () => { runtime.selectedMessage = el.dataset.message; render(); };
    for (const el of app.querySelectorAll("[data-finding]"))
        el.onclick = () => { const f = project.findings.find(x => x.id === el.dataset.finding); if (f) {
            f.status = f.status === "OPEN" ? "ACKNOWLEDGED" : f.status === "ACKNOWLEDGED" ? "DISMISSED" : "OPEN";
            scheduleSave();
            render();
        } };
    for (const el of app.querySelectorAll("[data-action]"))
        el.onclick = () => void handleAction(el.dataset.action || "");
    const composer = app.querySelector("#composer-text");
    if (composer) {
        composer.oninput = () => { setDraftForConversation(composer.value); const c = app.querySelector(".byte-count"); const b = new TextEncoder().encode(composer.value).length; if (c) {
            c.textContent = `${b}/228 bytes`;
            c.classList.toggle("over", b > 228);
        } const send = app.querySelector('[data-action="send-message"]'); if (send)
            send.disabled = runtime.connection !== "CONNECTED" || b === 0 || b > 228; };
        composer.onkeydown = (ev) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            void sendMessage();
        } };
    }
    const channel = app.querySelector("#message-channel");
    if (channel)
        channel.onchange = () => { runtime.messageChannel = Number(channel.value); if (runtime.messageDestination === "broadcast")
            setConversation(`channel:${runtime.messageChannel}`); scheduleSave(); render(); };
    const dest = app.querySelector("#message-destination");
    if (dest)
        dest.onchange = () => { runtime.messageDestination = dest.value === "broadcast" ? "broadcast" : Number(dest.value); setConversation(runtime.messageDestination === "broadcast" ? `channel:${runtime.messageChannel}` : `direct:${runtime.messageDestination}`); render(); };
    const ms = app.querySelector("#message-search");
    if (ms)
        ms.oninput = () => { runtime.messageSearch = ms.value; setTimeout(() => render(), 120); };
    const mf = app.querySelector("#message-state-filter");
    if (mf)
        mf.onchange = () => { runtime.messageStateFilter = mf.value; render(); };
    const ns = app.querySelector("#node-search");
    if (ns)
        ns.oninput = () => { project.nodeTable.filter.search = ns.value; project.nodeTable.selectedViewId = undefined; scheduleSave(); setTimeout(() => render(), 150); };
    const status = app.querySelector("#node-status-filter");
    if (status)
        status.onchange = () => { project.nodeTable.filter.status = status.value; project.nodeTable.selectedViewId = undefined; scheduleSave(); render(); };
    const role = app.querySelector("#node-role-filter");
    if (role)
        role.onchange = () => { project.nodeTable.filter.role = role.value; project.nodeTable.selectedViewId = undefined; scheduleSave(); render(); };
    const hw = app.querySelector("#node-hardware-filter");
    if (hw)
        hw.onchange = () => { project.nodeTable.filter.hardware = hw.value; project.nodeTable.selectedViewId = undefined; scheduleSave(); render(); };
    const fav = app.querySelector("#node-favorites-filter");
    if (fav)
        fav.onchange = () => { project.nodeTable.filter.favoritesOnly = fav.checked; project.nodeTable.selectedViewId = undefined; scheduleSave(); render(); };
    const view = app.querySelector("#node-saved-view");
    if (view)
        view.onchange = () => { applySavedNodeView(view.value); render(); };
    for (const el of app.querySelectorAll("[data-node-column]"))
        el.onchange = () => { const id = el.dataset.nodeColumn; const set = new Set(project.nodeTable.visibleColumns); if (el.checked)
            set.add(id);
        else
            set.delete(id); project.nodeTable.visibleColumns = NODE_COLUMNS.map(c => c.id).filter(id => set.has(id)); if (!project.nodeTable.visibleColumns.length)
            project.nodeTable.visibleColumns = ["node"]; project.nodeTable.selectedViewId = undefined; scheduleSave(); render(); };
    for (const el of app.querySelectorAll("[data-node-sort]"))
        el.onclick = (ev) => { ev.stopPropagation(); const id = el.dataset.nodeSort; if (project.nodeTable.filter.sortBy === id)
            project.nodeTable.filter.sortDir = project.nodeTable.filter.sortDir === "asc" ? "desc" : "asc";
        else {
            project.nodeTable.filter.sortBy = id;
            project.nodeTable.filter.sortDir = id === "node" || id === "hardware" || id === "role" || id === "status" ? "asc" : "desc";
        } project.nodeTable.selectedViewId = undefined; scheduleSave(); render(); };
    for (const el of app.querySelectorAll("[data-col-resize]"))
        el.onpointerdown = (ev) => { ev.preventDefault(); ev.stopPropagation(); const id = el.dataset.colResize; const startX = ev.clientX, startWidth = nodeColumnWidth(id); const move = (moveEv) => { const width = Math.max(60, Math.min(520, startWidth + moveEv.clientX - startX)); project.nodeTable.columnWidths[id] = Math.round(width); project.nodeTable.selectedViewId = undefined; for (const cell of app.querySelectorAll(`[data-col-cell="${id}"]`)) {
            cell.style.width = `${width}px`;
            cell.style.minWidth = `${width}px`;
        } }; const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); scheduleSave(); }; document.addEventListener("pointermove", move); document.addEventListener("pointerup", up, { once: true }); };
    const ps = app.querySelector("#packet-search");
    if (ps)
        ps.oninput = () => { runtime.packetSearch = ps.value; project.packetLab.filter.search = ps.value; scheduleSave(); setTimeout(() => render(), 150); };
    const packetSelect = (id, key) => { const el = app.querySelector(`#${id}`); if (el)
        el.onchange = () => { project.packetLab.filter[key] = el.value; scheduleSave(); render(); }; };
    packetSelect("packet-direction", "direction");
    packetSelect("packet-portnum", "portNum");
    packetSelect("packet-channel", "channel");
    packetSelect("packet-ack", "wantAck");
    packetSelect("packet-encryption", "encryption");
    packetSelect("packet-time", "timeRange");
    const packetText = (id, key) => { const el = app.querySelector(`#${id}`); if (el)
        el.oninput = () => { project.packetLab.filter[key] = el.value; scheduleSave(); setTimeout(() => render(), 150); }; };
    packetText("packet-source", "source");
    packetText("packet-destination", "destination");
    for (const el of app.querySelectorAll("[data-port-filter]"))
        el.onclick = () => { project.packetLab.filter.portNum = el.dataset.portFilter || ""; scheduleSave(); render(); };
    for (const el of app.querySelectorAll("[data-packet-tab]"))
        el.onclick = () => { project.packetLab.inspectorTab = el.dataset.packetTab; scheduleSave(); render(); };
    for (const el of app.querySelectorAll("[data-related-packet]"))
        el.onclick = () => { runtime.selectedPacket = el.dataset.relatedPacket; render(); };
    for (const el of app.querySelectorAll("[data-related-message]"))
        el.onclick = () => { runtime.selectedMessage = el.dataset.relatedMessage; const m = project.messages.find(x => x.id === runtime.selectedMessage); if (m) {
            setConversation(conversationKeyForMessage(m), false);
            runtime.view = "messages";
        } render(); };
    const analyticsRange = app.querySelector("#analytics-range");
    if (analyticsRange)
        analyticsRange.onchange = () => { project.rfTelemetry.timeRange = analyticsRange.value; scheduleSave(); render(); };
    const rfNode = app.querySelector("#rf-node-filter");
    if (rfNode)
        rfNode.onchange = () => { project.rfTelemetry.rfNode = rfNode.value; scheduleSave(); render(); };
    const telemetryNode = app.querySelector("#telemetry-node-filter");
    if (telemetryNode)
        telemetryNode.onchange = () => { project.rfTelemetry.telemetryNode = telemetryNode.value; scheduleSave(); render(); };
    const telemetryKind = app.querySelector("#telemetry-kind-filter");
    if (telemetryKind)
        telemetryKind.onchange = () => { project.rfTelemetry.telemetryKind = telemetryKind.value; project.rfTelemetry.telemetryMetric = ""; scheduleSave(); render(); };
    const telemetryMetric = app.querySelector("#telemetry-metric");
    if (telemetryMetric)
        telemetryMetric.onchange = () => { project.rfTelemetry.telemetryMetric = telemetryMetric.value; scheduleSave(); render(); };
    bindSettings();
}
async function handleAction(action) {
    try {
        switch (action) {
            case "connection":
                if (["CONNECTED", "CONNECTING", "SERIAL_OPEN", "SYNCHRONIZING", "RECOVERING", "RECONNECTING"].includes(runtime.connection))
                    await adapter.disconnect();
                else
                    await adapter.connect();
                break;
            case "connect":
                await adapter.connect();
                break;
            case "disconnect":
                await adapter.disconnect();
                break;
            case "reconnect":
                await adapter.reconnect();
                break;
            case "resync":
                await adapter.resync();
                break;
            case "mode-easy":
                settings.mode = "easy";
                saveSettings(settings);
                render();
                break;
            case "mode-advanced":
                settings.mode = "advanced";
                saveSettings(settings);
                render();
                break;
            case "load-demo":
                if (adapter.active)
                    await adapter.disconnect();
                project = createDemoProject();
                runtime.rxCount = 0;
                runtime.txCount = 0;
                runtime.selectedNode = undefined;
                runtime.selectedPacket = undefined;
                runtime.selectedMessage = undefined;
                runtime.packetLivePaused = false;
                runtime.packetPauseAt = undefined;
                runtime.packetNewWhilePaused = 0;
                runtime.packetSearch = project.packetLab.filter.search;
                runtime.selectedConversation = project.messaging.lastConversation || "channel:0";
                setConversation(runtime.selectedConversation, false);
                evaluateFindings();
                await saveProject(project);
                render();
                break;
            case "fresh-start":
                await freshStart();
                break;
            case "import-project":
                app.querySelector("#import-file")?.click();
                break;
            case "export-project":
                exportProject();
                break;
            case "send-message":
                await sendMessage();
                break;
            case "retry-message":
                await retryMessage();
                break;
            case "close-message-inspector":
                runtime.selectedMessage = undefined;
                render();
                break;
            case "open-message-packet":
                openMessagePacket();
                break;
            case "export-messages":
                exportMessages();
                break;
            case "close-inspector":
                runtime.selectedNode = undefined;
                runtime.selectedPacket = undefined;
                render();
                break;
            case "save-node-notes":
                saveNodeFieldData();
                break;
            case "save-node-field-data":
                saveNodeFieldData();
                break;
            case "message-node":
                openSelectedNodeConversation();
                break;
            case "node-packets":
                openSelectedNodePackets();
                break;
            case "evidence-from-node":
                evidenceFromNode();
                break;
            case "clear-node-filters":
                project.nodeTable.filter = { search: "", status: "all", role: "", hardware: "", favoritesOnly: false, sortBy: "lastHeard", sortDir: "desc" };
                project.nodeTable.selectedViewId = undefined;
                scheduleSave();
                render();
                break;
            case "save-node-view":
                saveNodeView();
                break;
            case "delete-node-view":
                deleteNodeView();
                break;
            case "export-nodes":
                exportNodes();
                break;
            case "packet-live-toggle":
                if (runtime.packetLivePaused) {
                    runtime.packetLivePaused = false;
                    runtime.packetPauseAt = undefined;
                    runtime.packetNewWhilePaused = 0;
                }
                else {
                    runtime.packetLivePaused = true;
                    runtime.packetPauseAt = now();
                    runtime.packetNewWhilePaused = 0;
                }
                render();
                break;
            case "clear-packet-filters":
                project.packetLab.filter = { search: "", direction: "all", portNum: "", channel: "", source: "", destination: "", wantAck: "all", encryption: "all", timeRange: "all" };
                runtime.packetSearch = "";
                scheduleSave();
                render();
                break;
            case "export-filtered-packets":
                exportFilteredPackets();
                break;
            case "export-selected-packet":
                exportSelectedPacket();
                break;
            case "copy-packet-hex":
                await copySelectedPacketHex();
                break;
            case "export-packets":
                downloadBlob(`${slug(project.name)}-packets.csv`, "text/csv", csv(project.packets.map(p => safeObject({ ...p, raw: undefined, decoded: undefined }))));
                break;
            case "add-log":
                addLog();
                break;
            case "snapshot":
                createSnapshot();
                break;
            case "evidence-from-packet":
                evidenceFromPacket();
                break;
            case "export-rf-analytics":
                exportRfAnalytics();
                break;
            case "evidence-from-rf":
                evidenceFromRf();
                break;
            case "export-telemetry-analytics":
                exportTelemetryAnalytics();
                break;
            case "evidence-from-telemetry":
                evidenceFromTelemetry();
                break;
            case "export-diagnostics":
                await exportDiagnostics();
                break;
            case "print-report":
                printReport();
                break;
            case "clear-session":
                project.packets = [];
                project.messages = [];
                project.telemetry = [];
                project.positions = [];
                project.nodeObservations = [];
                runtime.selectedMessage = undefined;
                runtime.selectedPacket = undefined;
                runtime.packetLivePaused = false;
                runtime.packetPauseAt = undefined;
                runtime.packetNewWhilePaused = 0;
                runtime.rxCount = 0;
                runtime.txCount = 0;
                addTimeline("session cleared", "Operator cleared recorded traffic while preserving project identity and configuration.", "INFO", undefined, "USER ENTERED");
                scheduleSave();
                render();
                break;
            case "reset-ui":
                settings = { ...defaultSettings };
                saveSettings(settings);
                render();
                break;
        }
    }
    catch (error) {
        runtime.connection = adapter.connected ? runtime.connection : "ERROR";
        runtime.connectionReason = error instanceof Error ? error.message : String(error);
        addTimeline("application error", runtime.connectionReason, "MEDIUM");
        render();
    }
}
function bindSettings() {
    const theme = app.querySelector("#setting-theme");
    if (theme)
        theme.onchange = () => { settings.theme = theme.value; saveSettings(settings); render(); };
    const active = app.querySelector("#setting-active");
    if (active)
        active.onchange = () => { settings.activeMinutes = Math.max(1, Number(active.value) || 10); settings.staleMinutes = Math.max(settings.activeMinutes + 1, settings.staleMinutes); settings.lostMinutes = Math.max(settings.staleMinutes + 1, settings.lostMinutes); saveSettings(settings); evaluateFindings(); render(); };
    const stale = app.querySelector("#setting-stale");
    if (stale)
        stale.onchange = () => { settings.staleMinutes = Math.max(settings.activeMinutes + 1, Number(stale.value) || 30); settings.lostMinutes = Math.max(settings.staleMinutes + 1, settings.lostMinutes); saveSettings(settings); evaluateFindings(); render(); };
    const lost = app.querySelector("#setting-lost");
    if (lost)
        lost.onchange = () => { settings.lostMinutes = Math.max(settings.staleMinutes + 1, Number(lost.value) || 180); saveSettings(settings); evaluateFindings(); render(); };
    const packets = app.querySelector("#setting-packets");
    if (packets)
        packets.onchange = () => { settings.livePacketLimit = Math.max(100, Math.min(10000, Number(packets.value) || 2000)); saveSettings(settings); render(); };
    const tele = app.querySelector("#setting-telemetry");
    if (tele)
        tele.onchange = () => { settings.telemetryLimit = Math.max(100, Math.min(50000, Number(tele.value) || 5000)); saveSettings(settings); render(); };
    const history = app.querySelector("#setting-node-history");
    if (history)
        history.onchange = () => { settings.nodeHistoryLimit = Math.max(1000, Math.min(250000, Number(history.value) || 50000)); saveSettings(settings); if (project.nodeObservations.length > settings.nodeHistoryLimit)
            project.nodeObservations.splice(0, project.nodeObservations.length - settings.nodeHistoryLimit); scheduleSave(); render(); };
    const sw = app.querySelector("#setting-sw");
    if (sw)
        sw.onchange = () => { settings.serviceWorker = sw.checked; saveSettings(settings); void configureServiceWorker(); };
    const importFile = app.querySelector("#import-file");
    if (importFile)
        importFile.onchange = () => void importProject(importFile.files?.[0]);
}
async function sendMessage() {
    const key = runtime.selectedConversation;
    const text = draftForConversation(key).trim();
    if (!text)
        return;
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > 228)
        throw new Error(`Message is ${bytes} bytes; maximum safe text payload is 228 bytes.`);
    if (runtime.connection !== "CONNECTED")
        throw new Error("Connect and synchronize a radio before sending.");
    const my = project.radio.nodeNum ?? 0;
    const destination = runtime.messageDestination;
    const message = { id: crypto.randomUUID(), time: now(), sentAt: now(), from: my, to: destination === "broadcast" ? BROADCAST_NUM : destination, channel: runtime.messageChannel, type: destination === "broadcast" ? "broadcast" : "direct", text, state: "SENDING", direction: "TX", attempts: 1 };
    project.messages.push(message);
    project.messaging.drafts[key] = "";
    project.messaging.lastConversation = key;
    runtime.selectedMessage = message.id;
    addTimeline("message queued", text, "INFO", destination === "broadcast" ? undefined : destination, "USER ENTERED");
    scheduleSave();
    render();
    try {
        const packetId = await adapter.sendText(text, destination, runtime.messageChannel);
        message.packetId = packetId;
        const packet = project.packets.find(p => p.packetId === packetId);
        if (packet)
            message.packetRecordId = packet.id;
        applyMessageState(message, "ACKNOWLEDGED");
        addTimeline("message acknowledged", `Packet ${packetId} acknowledged by Meshtastic firmware.`, "INFO", destination === "broadcast" ? undefined : destination, "OBSERVED");
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        applyMessageState(message, "FAILED", reason);
        addTimeline("message failed", reason, "MEDIUM", destination === "broadcast" ? undefined : destination, "OBSERVED");
    }
    scheduleSave();
    render();
}
async function retryMessage() {
    const message = project.messages.find(m => m.id === runtime.selectedMessage);
    if (!message || message.direction !== "TX" || message.state !== "FAILED")
        return;
    if (runtime.connection !== "CONNECTED")
        throw new Error("Connect and synchronize a radio before retrying.");
    message.state = "SENDING";
    message.failureReason = undefined;
    message.failedAt = undefined;
    message.acknowledgedAt = undefined;
    message.sentAt = now();
    message.attempts = Math.max(1, message.attempts) + 1;
    scheduleSave();
    render();
    try {
        const destination = message.type === "broadcast" ? "broadcast" : message.to;
        const packetId = await adapter.sendText(message.text, destination, message.channel);
        message.packetId = packetId;
        const packet = project.packets.find(p => p.packetId === packetId);
        if (packet)
            message.packetRecordId = packet.id;
        applyMessageState(message, "ACKNOWLEDGED");
        addTimeline("message retry acknowledged", `Retry ${message.attempts} acknowledged as packet ${packetId}.`, "INFO", message.type === "direct" ? message.to : undefined, "OBSERVED");
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        applyMessageState(message, "FAILED", reason);
        addTimeline("message retry failed", reason, "MEDIUM", message.type === "direct" ? message.to : undefined, "OBSERVED");
    }
    scheduleSave();
    render();
}
function openMessagePacket() {
    const message = project.messages.find(m => m.id === runtime.selectedMessage);
    if (!message)
        return;
    const packet = messagePacket(message);
    if (!packet)
        return;
    runtime.selectedPacket = packet.id;
    runtime.view = "packets";
    render();
}
function exportMessages() {
    const rows = project.messages.map(m => { const p = messagePacket(m); return { time: m.time, direction: m.direction, state: m.state, type: m.type, from: nodeName(m.from), to: m.to === BROADCAST_NUM ? "Broadcast" : nodeName(m.to), channel: m.channel, packetId: m.packetId, attempts: m.attempts, text: m.text, rssi: p?.rssi, snr: p?.snr, hopLimit: p?.hopLimit, hopStart: p?.hopStart, failureReason: m.failureReason }; });
    downloadBlob(`${slug(project.name)}-messages.csv`, "text/csv", csv(rows));
}
function inputText(id) { return app.querySelector(`#${id}`)?.value.trim() || ""; }
function inputNumber(id) { const raw = app.querySelector(`#${id}`)?.value.trim(); if (!raw)
    return undefined; const value = Number(raw); return Number.isFinite(value) ? value : undefined; }
function saveNodeFieldData() {
    const node = project.nodes.find(x => x.num === runtime.selectedNode);
    if (!node)
        return;
    const meta = metadataFor(project, node.num);
    Object.assign(meta, { purpose: inputText("node-purpose") || undefined, owner: inputText("node-owner") || undefined, location: inputText("node-location") || undefined, assetTag: inputText("node-asset-tag") || undefined, antenna: inputText("node-antenna") || undefined, antennaGainDbi: inputNumber("node-antenna-gain"), antennaHeightM: inputNumber("node-antenna-height"), deploymentNotes: inputText("node-deployment-notes") || undefined, notes: inputText("node-notes") || undefined, updatedAt: now() });
    node.notes = meta.notes;
    addTimeline("node field data updated", `Local field data updated for ${node.shortName}.`, "INFO", node.num, "USER ENTERED");
    scheduleSave();
    render();
}
function applySavedNodeView(id) {
    const view = project.nodeTable.savedViews.find(v => v.id === id);
    if (!view) {
        project.nodeTable.selectedViewId = undefined;
        scheduleSave();
        return;
    }
    project.nodeTable.filter = safeObject(view.filter);
    project.nodeTable.visibleColumns = [...view.visibleColumns];
    project.nodeTable.columnWidths = { ...view.columnWidths };
    project.nodeTable.selectedViewId = view.id;
    scheduleSave();
}
function saveNodeView() {
    const requested = inputText("node-view-name");
    const current = project.nodeTable.savedViews.find(v => v.id === project.nodeTable.selectedViewId);
    const name = requested || current?.name || `Node View ${project.nodeTable.savedViews.length + 1}`;
    const stamp = now();
    if (current) {
        current.name = name;
        current.filter = safeObject(project.nodeTable.filter);
        current.visibleColumns = [...project.nodeTable.visibleColumns];
        current.columnWidths = { ...project.nodeTable.columnWidths };
        current.updatedAt = stamp;
    }
    else {
        const view = { id: crypto.randomUUID(), name, filter: safeObject(project.nodeTable.filter), visibleColumns: [...project.nodeTable.visibleColumns], columnWidths: { ...project.nodeTable.columnWidths }, createdAt: stamp, updatedAt: stamp };
        project.nodeTable.savedViews.push(view);
        project.nodeTable.selectedViewId = view.id;
    }
    addTimeline("node view saved", `Saved node inventory view: ${name}.`, "INFO", undefined, "USER ENTERED");
    scheduleSave();
    render();
}
function deleteNodeView() {
    const id = project.nodeTable.selectedViewId;
    if (!id)
        return;
    const view = project.nodeTable.savedViews.find(v => v.id === id);
    project.nodeTable.savedViews = project.nodeTable.savedViews.filter(v => v.id !== id);
    project.nodeTable.selectedViewId = undefined;
    if (view)
        addTimeline("node view deleted", `Deleted saved node view: ${view.name}.`, "INFO", undefined, "USER ENTERED");
    scheduleSave();
    render();
}
function exportNodes() {
    const rows = filteredSortedNodes(project, settings, project.nodeTable.filter).map(n => { const meta = nodeMetadata(n.num); const rssi = metricStats(nodeMetricSeries(project, n.num, "rssi")); const snr = metricStats(nodeMetricSeries(project, n.num, "snr")); return { status: statusForNode(n, settings), shortName: n.shortName, longName: n.longName, nodeId: n.id, nodeNum: n.num, hardware: n.hardware, role: n.role, firmware: n.firmware, lastHeard: n.lastHeard, age: fmtAge(n.lastHeard), battery: n.battery, voltage: n.voltage, currentRssi: n.rssi, currentSnr: n.snr, hops: n.hops, latitude: n.latitude, longitude: n.longitude, altitude: n.altitude, favorite: n.favorite, rxRssiSamples: rssi.samples, medianRssi: rssi.median, rxSnrSamples: snr.samples, medianSnr: snr.median, purpose: meta?.purpose, owner: meta?.owner, fieldLocation: meta?.location, assetTag: meta?.assetTag, antenna: meta?.antenna, antennaGainDbi: meta?.antennaGainDbi, antennaHeightM: meta?.antennaHeightM, deploymentNotes: meta?.deploymentNotes, notes: meta?.notes }; });
    downloadBlob(`${slug(project.name)}-nodes.csv`, "text/csv", csv(rows));
}
function openSelectedNodeConversation() { const node = project.nodes.find(n => n.num === runtime.selectedNode); if (!node)
    return; setConversation(`direct:${node.num}`); runtime.view = "messages"; render(); }
function openSelectedNodePackets() { const node = project.nodes.find(n => n.num === runtime.selectedNode); if (!node)
    return; runtime.packetSearch = ""; project.packetLab.filter.search = ""; project.packetLab.filter.source = String(node.num); project.packetLab.filter.destination = ""; project.packetLab.filter.portNum = ""; runtime.view = "packets"; scheduleSave(); render(); }
function evidenceFromNode() {
    const node = project.nodes.find(n => n.num === runtime.selectedNode);
    if (!node)
        return;
    const packets = project.packets.filter(p => p.direction === "RX" && p.source === node.num).slice(-20);
    const rssi = metricStats(nodeMetricSeries(project, node.num, "rssi"));
    const snr = metricStats(nodeMetricSeries(project, node.num, "snr"));
    const rec = { id: `EVID-${String(project.evidence.length + 1).padStart(4, "0")}`, title: `Node state — ${node.shortName}`, time: now(), observation: `${statusForNode(node, settings)}; last heard ${fmtTime(node.lastHeard)}; battery ${pct(node.battery)}; current RSSI ${fixed(node.rssi, 0, " dBm")}; current SNR ${fixed(node.snr, 1, " dB")}; retained RF samples ${Math.max(rssi.samples, snr.samples)}.`, nodeNum: node.num, packetIds: packets.map(p => p.id), notes: "Current node state captured from MESHBOARD; packet IDs reference the most recent retained received observations for this node.", provenance: "OBSERVED" };
    project.evidence.push(rec);
    addTimeline("evidence created", rec.title, "INFO", node.num, "USER ENTERED");
    scheduleSave();
    runtime.view = "evidence";
    render();
}
function addLog() { const t = app.querySelector("#log-text"), s = app.querySelector("#log-node"); const text = t?.value.trim(); if (!text)
    return; const nodeNum = s?.value ? Number(s.value) : undefined; project.logbook.push({ id: crypto.randomUUID(), time: now(), text, nodeNum }); addTimeline("operator log", text, "INFO", nodeNum, "USER ENTERED"); scheduleSave(); render(); }
function createSnapshot() { const s = { id: crypto.randomUUID(), name: `Snapshot ${project.snapshots.length + 1}`, time: now(), radio: safeObject(project.radio), nodes: safeObject(project.nodes), packetCount: project.packets.length, messageCount: project.messages.length, telemetryCount: project.telemetry.length, findings: safeObject(project.findings), config: safeObject(project.config) }; project.snapshots.push(s); addTimeline("snapshot created", `${s.name} captured ${s.nodes.length} nodes.`); scheduleSave(); render(); }
function currentFilteredPackets() {
    return filteredPackets(project.packets, project.packetLab.filter, runtime.packetLivePaused ? runtime.packetPauseAt : undefined, nodeName);
}
function exportFilteredPackets() {
    const rows = currentFilteredPackets().map(p => safeObject({ ...p, raw: undefined, decoded: undefined }));
    downloadBlob(`${slug(project.name)}-packets-filtered.csv`, "text/csv", csv(rows));
}
function exportSelectedPacket() {
    const packet = project.packets.find(p => p.id === runtime.selectedPacket);
    if (!packet)
        return;
    downloadBlob(`${slug(project.name)}-packet-${packet.packetId ?? packet.id}.json`, "application/json", JSON.stringify(packet, null, 2));
}
async function copySelectedPacketHex() {
    const packet = project.packets.find(p => p.id === runtime.selectedPacket);
    if (!packet?.rawHex)
        return;
    if (!navigator.clipboard)
        throw new Error("Clipboard API is unavailable in this browser context.");
    await navigator.clipboard.writeText(packet.rawHex);
    addTimeline("packet payload copied", `Copied payload hex for packet ${packet.packetId ?? packet.id}.`, "INFO", packet.source, "USER ENTERED");
}
function exportRfAnalytics() {
    const range = project.rfTelemetry.timeRange, node = project.rfTelemetry.rfNode === "all" ? undefined : Number(project.rfTelemetry.rfNode);
    const ids = new Set([...rfPoints(project, "rssi", range, node), ...rfPoints(project, "snr", range, node)].map(p => p.recordId).filter((x) => !!x));
    const rows = project.packets.filter(p => ids.has(p.id)).map(p => ({ time: p.time, node: nodeName(p.source), nodeNum: p.source, packetId: p.packetId, portNum: p.portNum, rssiDbm: p.rssi, snrDb: p.snr, channel: p.channel, hopLimit: p.hopLimit, hopStart: p.hopStart, provenance: p.provenance }));
    downloadBlob(`${slug(project.name)}-rf-${range}.csv`, "text/csv", csv(rows));
}
function evidenceFromRf() {
    const range = project.rfTelemetry.timeRange, node = project.rfTelemetry.rfNode === "all" ? undefined : Number(project.rfTelemetry.rfNode);
    const rp = rfPoints(project, "rssi", range, node), sp = rfPoints(project, "snr", range, node);
    const rs = analyticsStats(rp), ss = analyticsStats(sp);
    const packetIds = [...new Set([...rp, ...sp].map(p => p.recordId).filter((x) => !!x))].slice(-100);
    const scope = node === undefined ? "all observed nodes" : nodeName(node);
    const rec = { id: `EVID-${String(project.evidence.length + 1).padStart(4, "0")}`, title: `RF summary — ${scope}`, time: now(), observation: `${rangeLabel(range)}; RSSI median ${fixed(rs.median, 0, " dBm")} from ${rs.samples} samples; SNR median ${fixed(ss.median, 1, " dB")} from ${ss.samples} samples.`, nodeNum: node, packetIds, notes: "Calculated locally from retained packet-associated RSSI/SNR observations. This summary does not imply symmetric link quality or packet-delivery ratio.", provenance: "CALCULATED" };
    project.evidence.push(rec);
    addTimeline("evidence created", rec.title, "INFO", node, "USER ENTERED");
    scheduleSave();
    runtime.view = "evidence";
    render();
}
function exportTelemetryAnalytics() {
    const state = project.rfTelemetry, node = state.telemetryNode === "all" ? undefined : Number(state.telemetryNode), descriptor = metricDescriptor(state.telemetryMetric);
    const points = telemetryPoints(project, state.telemetryMetric, state.timeRange, state.telemetryKind, node);
    const rows = points.map(p => ({ time: p.time, node: nodeName(p.nodeNum), nodeNum: p.nodeNum, telemetryType: p.source, metric: descriptor.label, value: p.value, unit: descriptor.unit, recordId: p.recordId, provenance: "OBSERVED" }));
    downloadBlob(`${slug(project.name)}-telemetry-${descriptor.key}-${state.timeRange}.csv`, "text/csv", csv(rows));
}
function evidenceFromTelemetry() {
    const state = project.rfTelemetry, node = state.telemetryNode === "all" ? undefined : Number(state.telemetryNode), descriptor = metricDescriptor(state.telemetryMetric);
    const points = telemetryPoints(project, state.telemetryMetric, state.timeRange, state.telemetryKind, node);
    const stats = analyticsStats(points);
    const scope = node === undefined ? "all reporting nodes" : nodeName(node);
    const rec = { id: `EVID-${String(project.evidence.length + 1).padStart(4, "0")}`, title: `Telemetry summary — ${descriptor.label}`, time: now(), observation: `${rangeLabel(state.timeRange)}; ${scope}; ${descriptor.label}: latest ${stats.latest === undefined ? "—" : stats.latest.toFixed(descriptor.decimals) + descriptor.unit}, mean ${stats.mean === undefined ? "—" : stats.mean.toFixed(descriptor.decimals) + descriptor.unit}, median ${stats.median === undefined ? "—" : stats.median.toFixed(descriptor.decimals) + descriptor.unit}, ${stats.samples} samples.`, nodeNum: node, packetIds: [], notes: `Calculated from retained ${state.telemetryKind === "all" ? "telemetry" : state.telemetryKind} records. Missing samples are not interpolated. Source record IDs are preserved in project telemetry history.`, provenance: "CALCULATED" };
    project.evidence.push(rec);
    addTimeline("evidence created", rec.title, "INFO", node, "USER ENTERED");
    scheduleSave();
    runtime.view = "evidence";
    render();
}
function evidenceFromPacket() { const p = project.packets.find(x => x.id === runtime.selectedPacket); if (!p)
    return; const rec = { id: `EVID-${String(project.evidence.length + 1).padStart(4, "0")}`, title: `Packet observation ${p.packetId ?? p.id.slice(0, 8)}`, time: now(), observation: `${p.direction} ${p.portNum || "packet"}; RSSI ${fixed(p.rssi, 0, " dBm")}; SNR ${fixed(p.snr, 1, " dB")}; source ${nodeName(p.source)}.`, nodeNum: p.source, packetIds: [p.id], provenance: "OBSERVED" }; project.evidence.push(rec); addTimeline("evidence created", rec.title, "INFO", rec.nodeNum, "USER ENTERED"); scheduleSave(); runtime.view = "evidence"; render(); }
async function freshStart() { if (adapter.active)
    await adapter.disconnect(); const old = project.id; project = emptyProject(); runtime.connection = "DISCONNECTED"; runtime.selectedNode = undefined; runtime.selectedPacket = undefined; runtime.selectedMessage = undefined; runtime.selectedConversation = "channel:0"; runtime.messageDestination = "broadcast"; runtime.messageChannel = 0; runtime.rxCount = 0; runtime.txCount = 0; await deleteProject(old).catch(() => { }); await saveProject(project); render(); }
function exportProject() { downloadBlob(`${slug(project.name)}.meshboard.json`, "application/json", JSON.stringify(project, null, 2)); }
async function importProject(file) { if (!file)
    return; const value = JSON.parse(await file.text()); if (typeof value !== "object" || !value.id || !Array.isArray(value.nodes) || !Array.isArray(value.packets) || !Array.isArray(value.messages))
    throw new Error("This JSON file is not a valid MESHBOARD project."); if (adapter.active)
    await adapter.disconnect(); project = normalizeProject(value); project.updatedAt = now(); runtime.selectedConversation = project.messaging.lastConversation || "channel:0"; setConversation(runtime.selectedConversation, false); runtime.selectedMessage = undefined; await saveProject(project); evaluateFindings(); render(); }
async function exportDiagnostics() {
    const estimate = await estimateStorage();
    const bundle = { generatedAt: now(), application: { name: "MESHBOARD", version: APP_VERSION, schemaVersion: project.schemaVersion, userAgent: navigator.userAgent, secureContext: window.isSecureContext, webSerial: "serial" in navigator }, connection: { state: runtime.connection, reason: runtime.connectionReason, sdkState: runtime.sdkState, stateChangedAt: runtime.stateChangedAt, connectionStartedAt: runtime.connectionStartedAt, connectedAt: runtime.connectedAt, disconnectedAt: runtime.disconnectedAt, lastDisconnectCause: runtime.lastDisconnectCause, reconnectAttempt: runtime.reconnectAttempt, nextReconnectAt: runtime.nextReconnectAt, sync: runtime.sync, lastValidProtocolAt: runtime.lastValidProtocolAt, lastTransportEventAt: runtime.lastTransportEventAt, serialInfo: runtime.serialInfo, rxCount: runtime.rxCount, txCount: runtime.txCount, decodeErrors: runtime.decodeErrors, protocolErrors: runtime.protocolErrors }, radio: { ...project.radio }, storage: estimate, counts: { nodes: project.nodes.length, nodeObservations: project.nodeObservations.length, nodeMetadata: project.nodeMetadata.length, savedNodeViews: project.nodeTable.savedViews.length, packets: project.packets.length, messages: project.messages.length, telemetry: project.telemetry.length, positions: project.positions.length, findings: project.findings.length }, packetLab: { filter: project.packetLab.filter, livePaused: runtime.packetLivePaused, pauseAt: runtime.packetPauseAt, newWhilePaused: runtime.packetNewWhilePaused, portNums: portNumStats(project.packets) }, analytics: { ...project.rfTelemetry, telemetryKinds: telemetryKinds(project) }, note: "Channel key material is not intentionally included by MESHBOARD. Packet rawHex contains payload bytes exposed by the SDK, not original Web Serial framing." };
    downloadBlob(`${slug(project.name)}-diagnostics.json`, "application/json", JSON.stringify(bundle, null, 2));
}
function printReport() {
    const range = project.rfTelemetry.timeRange;
    const rfNode = project.rfTelemetry.rfNode === "all" ? undefined : Number(project.rfTelemetry.rfNode);
    const rssi = analyticsStats(rfPoints(project, "rssi", range, rfNode)), snr = analyticsStats(rfPoints(project, "snr", range, rfNode));
    const teleNode = project.rfTelemetry.telemetryNode === "all" ? undefined : Number(project.rfTelemetry.telemetryNode), descriptor = metricDescriptor(project.rfTelemetry.telemetryMetric), teleStats = analyticsStats(telemetryPoints(project, project.rfTelemetry.telemetryMetric, range, project.rfTelemetry.telemetryKind, teleNode));
    const w = window.open("", "_blank");
    if (!w)
        return;
    w.document.write(`<!doctype html><html><head><title>MESHBOARD Report</title><style>body{font:13px Arial,sans-serif;color:#111;margin:32px}h1{margin-bottom:2px}small{color:#555}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{border:1px solid #bbb;padding:6px;text-align:left}th{background:#eee}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.card{border:1px solid #bbb;padding:10px}.note{border-left:3px solid #777;padding:8px 10px;background:#f3f3f3}.page{page-break-before:always}</style></head><body><h1>MESHBOARD NETWORK REPORT</h1><small>${e(project.name)} · ${e(fmtTime(now()))}</small><h2>Executive Summary</h2><div class="grid"><div class="card"><b>Nodes</b><br>${project.nodes.length}</div><div class="card"><b>Packets</b><br>${project.packets.length}</div><div class="card"><b>Messages</b><br>${project.messages.length}</div><div class="card"><b>Findings</b><br>${project.findings.length}</div></div><h2>Connected Radio</h2>${kvPrint(project.radio)}<h2>Node Inventory</h2><table><tr><th>Status</th><th>Node</th><th>Role / Hardware</th><th>Last heard</th><th>Battery</th><th>RSSI</th><th>SNR</th><th>Field data</th></tr>${project.nodes.map(n => { const m = nodeMetadata(n.num); return `<tr><td>${e(statusForNode(n, settings))}</td><td>${e(n.shortName)} · ${e(n.longName)}</td><td>${e(n.role || "—")} / ${e(n.hardware || "—")}</td><td>${e(fmtTime(n.lastHeard))}</td><td>${pct(n.battery)}</td><td>${fixed(n.rssi, 0, " dBm")}</td><td>${fixed(n.snr, 1, " dB")}</td><td>${e(m?.purpose || m?.location || m?.antenna || "—")}</td></tr>`; }).join("")}</table><p><small>Node history retained: ${project.nodeObservations.length} observations. Local field metadata is user-entered; radio identity and measurements are observed from Meshtastic data.</small></p><h2>RF Analytics — ${e(rangeLabel(range))}</h2><table><tr><th>Scope</th><th>RSSI samples</th><th>Median RSSI</th><th>SNR samples</th><th>Median SNR</th></tr><tr><td>${e(rfNode === undefined ? "All observed nodes" : nodeName(rfNode))}</td><td>${rssi.samples}</td><td>${fixed(rssi.median, 0, " dBm")}</td><td>${snr.samples}</td><td>${fixed(snr.median, 1, " dB")}</td></tr></table><p class="note">RSSI/SNR are packet-associated receive observations at the connected radio. These statistics do not imply symmetric link quality or packet-delivery ratio.</p><h2>Telemetry Analytics — ${e(descriptor.label)}</h2><table><tr><th>Scope</th><th>Type</th><th>Samples</th><th>Latest</th><th>Mean</th><th>Median</th></tr><tr><td>${e(teleNode === undefined ? "All reporting nodes" : nodeName(teleNode))}</td><td>${e(project.rfTelemetry.telemetryKind)}</td><td>${teleStats.samples}</td><td>${teleStats.latest === undefined ? "—" : e(teleStats.latest.toFixed(descriptor.decimals) + descriptor.unit)}</td><td>${teleStats.mean === undefined ? "—" : e(teleStats.mean.toFixed(descriptor.decimals) + descriptor.unit)}</td><td>${teleStats.median === undefined ? "—" : e(teleStats.median.toFixed(descriptor.decimals) + descriptor.unit)}</td></tr></table><h2>Findings</h2><table><tr><th>Severity</th><th>Finding</th><th>Node</th><th>Observed</th></tr>${project.findings.map(f => `<tr><td>${f.severity}</td><td>${e(f.title)}</td><td>${e(nodeName(f.nodeNum))}</td><td>${e(f.observedValue || "")}</td></tr>`).join("")}</table><h2>Operator Notes</h2>${project.logbook.map(l => `<p><b>${e(fmtTime(l.time))}</b> ${e(l.text)}</p>`).join("") || "<p>None.</p>"}<hr><small>MESHBOARD v${APP_VERSION}. Meshtastic is a separate project; firmware behavior should be verified against authoritative Meshtastic documentation.</small><script>window.onload=()=>window.print()</script></body></html>`);
    w.document.close();
}
function kvPrint(obj) { return `<table>${Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`).join("")}</table>`; }
function slug(v) { return v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "meshboard-project"; }
function applyTheme() { let theme = settings.theme; if (theme === "system")
    theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; document.documentElement.dataset.theme = theme; }
async function configureServiceWorker() { if (!("serviceWorker" in navigator))
    return; if (settings.serviceWorker && location.protocol !== "file:") {
    try {
        await navigator.serviceWorker.register("./sw.js");
    }
    catch { }
}
else {
    for (const reg of await navigator.serviceWorker.getRegistrations())
        if (reg.active?.scriptURL.includes("sw.js"))
            await reg.unregister();
} }
async function init() {
    window.addEventListener("error", ev => { runtime.protocolErrors++; runtime.connectionReason = ev.error?.message || ev.message; queueRender(); });
    window.addEventListener("unhandledrejection", ev => { runtime.protocolErrors++; runtime.connectionReason = ev.reason instanceof Error ? ev.reason.message : String(ev.reason); queueRender(); });
    project = (await loadCurrentProject()) ?? emptyProject();
    runtime.packetSearch = project.packetLab.filter.search;
    runtime.selectedConversation = project.messaging.lastConversation || "channel:0";
    const initialConversation = parseConversation(runtime.selectedConversation);
    if (initialConversation.kind === "channel") {
        runtime.messageDestination = "broadcast";
        runtime.messageChannel = initialConversation.channel;
    }
    else {
        runtime.messageDestination = initialConversation.peer;
        const recent = [...conversationMessages(runtime.selectedConversation)].reverse()[0];
        if (recent)
            runtime.messageChannel = recent.channel;
    }
    evaluateFindings();
    const est = await estimateStorage().catch(() => undefined);
    storageText = est?.usage !== undefined ? `${(est.usage / 1024 / 1024).toFixed(1)} MB used${est.quota ? ` / ${(est.quota / 1024 / 1024).toFixed(0)} MB quota` : ""}` : "Available";
    runtime.sdkState = "Ready";
    await configureServiceWorker();
    render();
}
init().catch(error => {
    console.error(error);
    fallback?.remove();
    app.innerHTML = `<div class="fatal"><h1>MESHBOARD startup error</h1><p>The interface could not finish initializing.</p><p>Project data in browser storage has not been intentionally cleared.</p><pre>${e(error instanceof Error ? (error.stack || error.message) : String(error))}</pre><b>MESHBOARD v${APP_VERSION}</b></div>`;
});
