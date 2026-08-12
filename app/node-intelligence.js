import { median } from "./utils";
export const NODE_COLUMNS = [
    { id: "status", label: "STATUS", defaultWidth: 92 },
    { id: "node", label: "NODE", defaultWidth: 180 },
    { id: "id", label: "ID", defaultWidth: 130 },
    { id: "hardware", label: "HARDWARE", defaultWidth: 120 },
    { id: "role", label: "ROLE", defaultWidth: 120 },
    { id: "firmware", label: "FIRMWARE", defaultWidth: 110 },
    { id: "lastHeard", label: "LAST HEARD", defaultWidth: 150 },
    { id: "battery", label: "BATTERY", defaultWidth: 90 },
    { id: "voltage", label: "VOLTAGE", defaultWidth: 90 },
    { id: "rssi", label: "RSSI", defaultWidth: 90 },
    { id: "snr", label: "SNR", defaultWidth: 90 },
    { id: "hops", label: "HOPS", defaultWidth: 72 },
    { id: "position", label: "POSITION", defaultWidth: 210 },
    { id: "favorite", label: "FAVORITE", defaultWidth: 88 },
    { id: "field", label: "FIELD DATA", defaultWidth: 120 }
];
export function statusForNode(node, settings, time = Date.now()) {
    if (!node.lastHeard)
        return "UNKNOWN";
    const stamp = new Date(node.lastHeard).getTime();
    if (!Number.isFinite(stamp))
        return "UNKNOWN";
    const minutes = Math.max(0, (time - stamp) / 60000);
    if (minutes <= settings.activeMinutes)
        return "ACTIVE";
    if (minutes <= settings.staleMinutes)
        return "RECENT";
    if (minutes <= settings.lostMinutes)
        return "STALE";
    return "LOST";
}
export function metadataFor(project, nodeNum) {
    let meta = project.nodeMetadata.find((x) => x.nodeNum === nodeNum);
    if (!meta) {
        meta = { nodeNum };
        project.nodeMetadata.push(meta);
    }
    return meta;
}
export function appendNodeObservation(project, observation, limit) {
    // Packet and position observations are already discrete evidence records; preserve them without a history scan.
    if (observation.kind === "NODEDB" || observation.kind === "TELEMETRY") {
        let previous;
        const floor = Math.max(0, project.nodeObservations.length - 1000);
        for (let i = project.nodeObservations.length - 1; i >= floor; i--) {
            const candidate = project.nodeObservations[i];
            if (candidate?.nodeNum === observation.nodeNum && candidate.kind === observation.kind) {
                previous = candidate;
                break;
            }
        }
        const comparable = (x) => x ? JSON.stringify({
            lastHeard: x.lastHeard, battery: x.battery, voltage: x.voltage, rssi: x.rssi, snr: x.snr, hops: x.hops,
            latitude: x.latitude, longitude: x.longitude, altitude: x.altitude, channelUtilization: x.channelUtilization, airUtilTx: x.airUtilTx
        }) : "";
        const ageMs = previous ? new Date(observation.time).getTime() - new Date(previous.time).getTime() : Number.POSITIVE_INFINITY;
        if (previous && comparable(previous) === comparable(observation) && ageMs < 60_000)
            return;
    }
    project.nodeObservations.push(observation);
    const cap = Math.max(1000, limit);
    if (project.nodeObservations.length > cap)
        project.nodeObservations.splice(0, project.nodeObservations.length - cap);
}
export function nodeMetricSeries(project, nodeNum, metric) {
    const points = [];
    for (const obs of project.nodeObservations) {
        if (obs.nodeNum !== nodeNum)
            continue;
        const value = obs[metric];
        if (typeof value === "number" && Number.isFinite(value))
            points.push({ time: obs.time, value });
    }
    points.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    return points;
}
export function metricStats(points) {
    if (!points.length)
        return { samples: 0 };
    const values = points.map((x) => x.value);
    return {
        samples: values.length,
        min: Math.min(...values), max: Math.max(...values), mean: values.reduce((a, b) => a + b, 0) / values.length,
        median: median(values), latest: values.at(-1), firstTime: points[0]?.time, lastTime: points.at(-1)?.time
    };
}
function textValue(node, meta, id, settings) {
    switch (id) {
        case "status": return statusForNode(node, settings);
        case "node": return `${node.shortName} ${node.longName}`;
        case "id": return node.id;
        case "hardware": return node.hardware || "";
        case "role": return node.role || "";
        case "firmware": return node.firmware || "";
        case "lastHeard": return node.lastHeard ? new Date(node.lastHeard).getTime() : 0;
        case "battery": return node.battery ?? -Infinity;
        case "voltage": return node.voltage ?? -Infinity;
        case "rssi": return node.rssi ?? -Infinity;
        case "snr": return node.snr ?? -Infinity;
        case "hops": return node.hops ?? Number.POSITIVE_INFINITY;
        case "position": return `${node.latitude ?? ""},${node.longitude ?? ""}`;
        case "favorite": return node.favorite ? 1 : 0;
        case "field": return `${meta?.purpose || ""} ${meta?.owner || ""} ${meta?.location || ""} ${meta?.antenna || ""} ${meta?.assetTag || ""}`;
    }
}
export function filteredSortedNodes(project, settings, filter) {
    const search = filter.search.trim().toLowerCase();
    const rows = project.nodes.filter((node) => {
        const meta = project.nodeMetadata.find((x) => x.nodeNum === node.num);
        if (search) {
            const haystack = [node.longName, node.shortName, node.id, node.hardware, node.role, node.firmware, meta?.purpose, meta?.owner, meta?.location, meta?.antenna, meta?.assetTag, meta?.notes, meta?.deploymentNotes].filter(Boolean).join(" ").toLowerCase();
            if (!haystack.includes(search))
                return false;
        }
        if (filter.status !== "all" && statusForNode(node, settings) !== filter.status)
            return false;
        if (filter.role && node.role !== filter.role)
            return false;
        if (filter.hardware && node.hardware !== filter.hardware)
            return false;
        if (filter.favoritesOnly && !node.favorite)
            return false;
        return true;
    });
    const direction = filter.sortDir === "asc" ? 1 : -1;
    return rows.sort((a, b) => {
        const am = project.nodeMetadata.find((x) => x.nodeNum === a.num);
        const bm = project.nodeMetadata.find((x) => x.nodeNum === b.num);
        const av = textValue(a, am, filter.sortBy, settings);
        const bv = textValue(b, bm, filter.sortBy, settings);
        if (typeof av === "number" && typeof bv === "number")
            return (av - bv) * direction;
        return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * direction;
    });
}
export function svgSparkline(points, label, unit, decimals = 1) {
    if (!points.length)
        return `<div class="history-empty">No ${label.toLowerCase()} observations recorded.</div>`;
    const W = 520, H = 130, padX = 32, padY = 20;
    const values = points.map((x) => x.value);
    let min = Math.min(...values), max = Math.max(...values);
    if (min === max) {
        min -= 1;
        max += 1;
    }
    const t0 = new Date(points[0].time).getTime(), t1 = new Date(points.at(-1).time).getTime();
    const span = Math.max(1, t1 - t0);
    const coords = points.map((p) => {
        const x = padX + ((new Date(p.time).getTime() - t0) / span) * (W - padX * 2);
        const y = H - padY - ((p.value - min) / (max - min)) * (H - padY * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const latest = points.at(-1).value;
    return `<svg class="node-sparkline" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label} history"><line x1="${padX}" y1="${padY}" x2="${padX}" y2="${H - padY}"/><line x1="${padX}" y1="${H - padY}" x2="${W - padX}" y2="${H - padY}"/><polyline points="${coords}"/><text x="4" y="${padY + 4}">${max.toFixed(decimals)}${unit}</text><text x="4" y="${H - padY + 4}">${min.toFixed(decimals)}${unit}</text><text x="${W - padX - 4}" y="14" text-anchor="end">latest ${latest.toFixed(decimals)}${unit}</text></svg>`;
}
