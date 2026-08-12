export function safeObject(value) {
    return JSON.parse(JSON.stringify(value, (_key, v) => {
        if (typeof v === "bigint")
            return v.toString();
        if (v instanceof Uint8Array)
            return { __type: "Uint8Array", hex: bytesToHex(v), length: v.length };
        return v;
    }));
}
export function bytesToHex(bytes) {
    if (!bytes)
        return "";
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(" ");
}
export function fmtTime(value) {
    if (!value)
        return "—";
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}
export function fmtAge(value) {
    if (!value)
        return "—";
    const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
    if (seconds < 60)
        return `${Math.floor(seconds)}s`;
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400)
        return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}
export function nodeId(num) { return `!${(num >>> 0).toString(16).padStart(8, "0")}`; }
export function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
export function num(value) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
export function text(value) { return typeof value === "string" && value.length ? value : undefined; }
export function downloadBlob(filename, type, content) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c] ?? c));
}
export function csv(rows) {
    if (!rows.length)
        return "";
    const records = rows;
    const keys = Array.from(new Set(records.flatMap(r => Object.keys(r))));
    const cell = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    return [keys.map(cell).join(","), ...records.map(r => keys.map(k => cell(r[k])).join(","))].join("\n");
}
export function median(values) {
    if (!values.length)
        return undefined;
    const s = [...values].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}
