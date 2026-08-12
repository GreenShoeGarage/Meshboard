export const APP_VERSION = "0.6.8";
export const SCHEMA_VERSION = 5;
export function emptyProject(name = "Untitled Mesh Project") {
    const now = new Date().toISOString();
    return {
        schemaVersion: SCHEMA_VERSION,
        id: crypto.randomUUID(),
        name,
        description: "",
        createdAt: now,
        updatedAt: now,
        demo: false,
        radio: {}, nodes: [], nodeObservations: [], nodeMetadata: [],
        nodeTable: {
            filter: { search: "", status: "all", role: "", hardware: "", favoritesOnly: false, sortBy: "lastHeard", sortDir: "desc" },
            visibleColumns: ["status", "node", "id", "hardware", "role", "lastHeard", "battery", "rssi", "snr", "hops", "position"],
            columnWidths: {}, savedViews: []
        },
        packets: [],
        packetLab: { filter: { search: "", direction: "all", portNum: "", channel: "", source: "", destination: "", wantAck: "all", encryption: "all", timeRange: "all" }, inspectorTab: "summary" },
        rfTelemetry: { timeRange: "24h", rfNode: "all", telemetryNode: "all", telemetryKind: "all", telemetryMetric: "batteryLevel" },
        messages: [], messaging: { drafts: {}, readAt: {}, lastConversation: "channel:0" }, telemetry: [], positions: [], channels: [],
        config: { radio: {}, modules: {} }, timeline: [], logbook: [], findings: [], evidence: [], snapshots: []
    };
}
export function normalizeProject(value) {
    const base = emptyProject(value?.name || "Untitled Mesh Project");
    if (!value || typeof value !== "object")
        return base;
    const legacyMessages = Array.isArray(value.messages) ? value.messages : [];
    const messages = legacyMessages.map((m) => {
        const x = m;
        const legacy = String(x.state || "").toUpperCase();
        const state = legacy.includes("FAIL") ? "FAILED" :
            legacy.includes("ACK") ? "ACKNOWLEDGED" :
                legacy.includes("PENDING") || legacy.includes("SEND") ? "SENDING" :
                    x.direction === "RX" ? "RECEIVED" : "UNKNOWN";
        return {
            id: x.id || crypto.randomUUID(), packetId: x.packetId, packetRecordId: x.packetRecordId,
            time: x.time || new Date().toISOString(), from: Number(x.from ?? 0), to: Number(x.to ?? 0xffffffff),
            channel: Number(x.channel ?? 0), type: x.type === "direct" ? "direct" : "broadcast", text: String(x.text ?? ""),
            state, direction: x.direction === "TX" ? "TX" : "RX", attempts: Math.max(1, Number(x.attempts ?? 1)),
            sentAt: x.sentAt, acknowledgedAt: x.acknowledgedAt, failedAt: x.failedAt, failureReason: x.failureReason
        };
    });
    const messaging = value.messaging && typeof value.messaging === "object"
        ? { drafts: { ...(value.messaging.drafts || {}) }, readAt: { ...(value.messaging.readAt || {}) }, lastConversation: value.messaging.lastConversation || "channel:0" }
        : { drafts: {}, readAt: {}, lastConversation: "channel:0" };
    const legacyNodes = Array.isArray(value.nodes) ? value.nodes : [];
    const legacyMetadata = legacyNodes
        .filter((n) => !!n.notes)
        .map((n) => ({ nodeNum: n.num, notes: n.notes, updatedAt: value.updatedAt || value.createdAt }));
    const explicitMetadata = Array.isArray(value.nodeMetadata) ? value.nodeMetadata : [];
    const metadataByNode = new Map();
    for (const item of [...legacyMetadata, ...explicitMetadata]) {
        if (!item || typeof item.nodeNum !== "number")
            continue;
        metadataByNode.set(item.nodeNum, { ...(metadataByNode.get(item.nodeNum) || {}), ...item });
    }
    let nodeObservations = Array.isArray(value.nodeObservations) ? value.nodeObservations : [];
    if (!nodeObservations.length) {
        const migrated = [];
        for (const node of legacyNodes)
            migrated.push({ id: crypto.randomUUID(), nodeNum: node.num, time: node.lastHeard || value.updatedAt || value.createdAt || new Date().toISOString(), kind: "NODEDB", lastHeard: node.lastHeard, battery: node.battery, voltage: node.voltage, rssi: node.rssi, snr: node.snr, hops: node.hops, latitude: node.latitude, longitude: node.longitude, altitude: node.altitude, channelUtilization: node.channelUtilization, airUtilTx: node.airUtilTx, provenance: "OBSERVED" });
        for (const packet of Array.isArray(value.packets) ? value.packets : [])
            if (packet.direction === "RX" && packet.source !== undefined && (packet.rssi !== undefined || packet.snr !== undefined))
                migrated.push({ id: crypto.randomUUID(), nodeNum: packet.source, time: packet.time, kind: "PACKET", rssi: packet.rssi, snr: packet.snr, packetRecordId: packet.id, provenance: "OBSERVED" });
        for (const reading of Array.isArray(value.telemetry) ? value.telemetry : []) {
            const battery = typeof reading.values?.batteryLevel === "number" ? reading.values.batteryLevel : typeof reading.values?.battery === "number" ? reading.values.battery : undefined;
            const voltage = typeof reading.values?.voltage === "number" ? reading.values.voltage : undefined;
            const channelUtilization = typeof reading.values?.channelUtilization === "number" ? reading.values.channelUtilization : undefined;
            const airUtilTx = typeof reading.values?.airUtilTx === "number" ? reading.values.airUtilTx : undefined;
            if ([battery, voltage, channelUtilization, airUtilTx].some(v => v !== undefined))
                migrated.push({ id: crypto.randomUUID(), nodeNum: reading.nodeNum, time: reading.time, kind: "TELEMETRY", battery, voltage, channelUtilization, airUtilTx, telemetryRecordId: reading.id, provenance: "OBSERVED" });
        }
        for (const position of Array.isArray(value.positions) ? value.positions : [])
            migrated.push({ id: crypto.randomUUID(), nodeNum: position.nodeNum, time: position.time, kind: "POSITION", latitude: position.latitude, longitude: position.longitude, altitude: position.altitude, positionRecordId: position.id, provenance: "OBSERVED" });
        nodeObservations = migrated.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    }
    const incomingTable = value.nodeTable && typeof value.nodeTable === "object" ? value.nodeTable : undefined;
    const validColumns = new Set(["status", "node", "id", "hardware", "role", "firmware", "lastHeard", "battery", "voltage", "rssi", "snr", "hops", "position", "favorite", "field"]);
    const visibleColumns = Array.isArray(incomingTable?.visibleColumns)
        ? incomingTable.visibleColumns.filter((x) => validColumns.has(x))
        : base.nodeTable.visibleColumns;
    const filter = { ...base.nodeTable.filter, ...(incomingTable?.filter || {}) };
    if (!validColumns.has(filter.sortBy))
        filter.sortBy = "lastHeard";
    const savedViews = Array.isArray(incomingTable?.savedViews)
        ? incomingTable.savedViews.map((view) => ({
            ...view,
            filter: { ...base.nodeTable.filter, ...(view.filter || {}) },
            visibleColumns: Array.isArray(view.visibleColumns) ? view.visibleColumns.filter((x) => validColumns.has(x)) : base.nodeTable.visibleColumns,
            columnWidths: { ...(view.columnWidths || {}) }
        }))
        : [];
    return {
        ...base, ...value, schemaVersion: SCHEMA_VERSION, messages, messaging,
        radio: { ...base.radio, ...(value.radio || {}) },
        config: { radio: value.config?.radio ?? {}, modules: value.config?.modules ?? {} },
        nodes: legacyNodes,
        nodeObservations,
        nodeMetadata: [...metadataByNode.values()],
        nodeTable: {
            filter,
            visibleColumns: visibleColumns.length ? visibleColumns : base.nodeTable.visibleColumns,
            columnWidths: { ...(incomingTable?.columnWidths || {}) },
            savedViews,
            selectedViewId: incomingTable?.selectedViewId
        },
        packets: Array.isArray(value.packets) ? value.packets.map((packet) => ({ ...packet, provenance: packet.provenance || "OBSERVED" })) : [],
        packetLab: {
            filter: { ...base.packetLab.filter, ...(value.packetLab?.filter || {}) },
            inspectorTab: ["summary", "decoded", "raw", "provenance", "related"].includes(String(value.packetLab?.inspectorTab)) ? value.packetLab.inspectorTab : "summary"
        },
        rfTelemetry: {
            ...base.rfTelemetry, ...(value.rfTelemetry || {}),
            timeRange: ["1h", "6h", "24h", "7d", "all"].includes(String(value.rfTelemetry?.timeRange)) ? value.rfTelemetry.timeRange : base.rfTelemetry.timeRange
        },
        telemetry: Array.isArray(value.telemetry) ? value.telemetry : [], positions: Array.isArray(value.positions) ? value.positions : [],
        channels: Array.isArray(value.channels) ? value.channels : [], timeline: Array.isArray(value.timeline) ? value.timeline : [],
        logbook: Array.isArray(value.logbook) ? value.logbook : [], findings: Array.isArray(value.findings) ? value.findings : [],
        evidence: Array.isArray(value.evidence) ? value.evidence : [], snapshots: Array.isArray(value.snapshots) ? value.snapshots : []
    };
}
export const defaultSettings = {
    theme: "system", mode: "easy", activeMinutes: 10, staleMinutes: 30, lostMinutes: 180,
    livePacketLimit: 2000, telemetryLimit: 5000, nodeHistoryLimit: 50000, serviceWorker: true
};
