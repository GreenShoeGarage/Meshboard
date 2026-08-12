import type { PacketFilterState, PacketRecord } from "./models";

export interface PortNumStat {
  portNum: string;
  total: number;
  rx: number;
  tx: number;
  bytes: number;
}

function cutoffMs(range: PacketFilterState["timeRange"], referenceMs = Date.now()): number | undefined {
  if (range === "5m") return referenceMs - 5 * 60_000;
  if (range === "1h") return referenceMs - 60 * 60_000;
  if (range === "24h") return referenceMs - 24 * 60 * 60_000;
  return undefined;
}

export function filteredPackets(
  packets: PacketRecord[],
  filter: PacketFilterState,
  pauseAt: string | undefined,
  nodeLabel: (num?: number) => string,
): PacketRecord[] {
  const q = filter.search.trim().toLowerCase();
  const sourceQ = filter.source.trim().toLowerCase();
  const destinationQ = filter.destination.trim().toLowerCase();
  const pauseMs = pauseAt ? new Date(pauseAt).getTime() : undefined;
  const cutoff = cutoffMs(filter.timeRange, pauseMs ?? Date.now());

  return packets.filter((packet) => {
    const timeMs = new Date(packet.time).getTime();
    if (pauseMs !== undefined && Number.isFinite(timeMs) && timeMs > pauseMs) return false;
    if (cutoff !== undefined && Number.isFinite(timeMs) && timeMs < cutoff) return false;
    if (filter.direction !== "all" && packet.direction !== filter.direction) return false;
    if (filter.portNum && packet.portNum !== filter.portNum) return false;
    if (filter.channel && String(packet.channel ?? "") !== filter.channel) return false;
    if (filter.wantAck === "yes" && packet.wantAck !== true) return false;
    if (filter.wantAck === "no" && packet.wantAck === true) return false;
    if (filter.encryption === "encrypted" && packet.encrypted !== true) return false;
    if (filter.encryption === "decrypted" && packet.encrypted === true) return false;
    if (filter.encryption === "pki" && packet.pkiEncrypted !== true) return false;

    if (sourceQ) {
      const hay = `${packet.source ?? ""} ${nodeLabel(packet.source)}`.toLowerCase();
      if (!hay.includes(sourceQ)) return false;
    }
    if (destinationQ) {
      const hay = `${packet.destination ?? ""} ${nodeLabel(packet.destination)}`.toLowerCase();
      if (!hay.includes(destinationQ)) return false;
    }
    if (q) {
      const hay = [
        packet.packetId, packet.direction, nodeLabel(packet.source), nodeLabel(packet.destination), packet.source, packet.destination,
        packet.portNum, packet.channel, packet.priority, packet.transport, packet.delayed, packet.requestId, packet.replyId,
        packet.wantAck, packet.encrypted, packet.pkiEncrypted, packet.viaMqtt, packet.rawHex,
      ].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
}

export function portNumStats(packets: PacketRecord[]): PortNumStat[] {
  const map = new Map<string, PortNumStat>();
  for (const packet of packets) {
    const key = packet.portNum || "UNKNOWN";
    const row = map.get(key) ?? { portNum: key, total: 0, rx: 0, tx: 0, bytes: 0 };
    row.total += 1;
    if (packet.direction === "RX") row.rx += 1; else row.tx += 1;
    row.bytes += packet.size ?? 0;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.total - a.total || a.portNum.localeCompare(b.portNum));
}

export function relatedPackets(packets: PacketRecord[], selected: PacketRecord): PacketRecord[] {
  const ids = new Set<number>();
  if (selected.packetId !== undefined) ids.add(selected.packetId);
  if (selected.requestId) ids.add(selected.requestId);
  if (selected.replyId) ids.add(selected.replyId);
  return packets.filter((packet) => {
    if (packet.id === selected.id) return false;
    if (packet.packetId !== undefined && ids.has(packet.packetId)) return true;
    if (packet.requestId !== undefined && selected.packetId !== undefined && packet.requestId === selected.packetId) return true;
    if (packet.replyId !== undefined && selected.packetId !== undefined && packet.replyId === selected.packetId) return true;
    if (selected.requestId !== undefined && packet.packetId === selected.requestId) return true;
    if (selected.replyId !== undefined && packet.packetId === selected.replyId) return true;
    return false;
  }).sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
}

export function hexLines(hex?: string, bytesPerLine = 16): string {
  if (!hex) return "";
  const bytes = hex.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += bytesPerLine) {
    const chunk = bytes.slice(offset, offset + bytesPerLine);
    lines.push(`${offset.toString(16).padStart(4, "0")}  ${chunk.join(" ")}`);
  }
  return lines.join("\n");
}
