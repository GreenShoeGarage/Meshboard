export function safeObject<T = unknown>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Uint8Array) return { __type: "Uint8Array", hex: bytesToHex(v), length: v.length };
    return v;
  })) as T;
}

export function bytesToHex(bytes?: Uint8Array): string {
  if (!bytes) return "";
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(" ");
}

export function fmtTime(value?: string | Date): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function fmtAge(value?: string): string {
  if (!value) return "—";
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function nodeId(num: number): string { return `!${(num >>> 0).toString(16).padStart(8, "0")}`; }
export function clamp(n: number, min: number, max: number): number { return Math.max(min, Math.min(max, n)); }
export function num(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
export function text(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }

export function downloadBlob(filename: string, type: string, content: BlobPart): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c] ?? c));
}

export function csv(rows: object[]): string {
  if (!rows.length) return "";
  const records = rows as Record<string, unknown>[];
  const keys = Array.from(new Set(records.flatMap(r => Object.keys(r))));
  const cell = (v: unknown) => `"${String(v ?? "").replaceAll('"','""')}"`;
  return [keys.map(cell).join(","), ...records.map(r => keys.map(k => cell(r[k])).join(","))].join("\n");
}

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a,b)=>a-b); const m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : ((s[m-1] ?? 0)+(s[m] ?? 0))/2;
}
