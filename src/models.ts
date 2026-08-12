export const APP_VERSION = "0.6.0";
export const SCHEMA_VERSION = 5;

export type ViewId =
  | "home" | "messages" | "nodes" | "map" | "topology" | "rf" | "packets"
  | "telemetry" | "radio" | "channels" | "configuration" | "timeline"
  | "logbook" | "compare" | "evidence" | "diagnostics" | "settings" | "help";

export type SaveState = "saved" | "saving" | "unsaved" | "error";
export type ConnectionState = "DISCONNECTED" | "CONNECTING" | "SERIAL_OPEN" | "SYNCHRONIZING" | "CONNECTED" | "RECOVERING" | "ERROR" | "RECONNECTING";
export type Provenance = "OBSERVED" | "CALCULATED" | "INFERRED" | "USER ENTERED" | "CONFIGURED";
export type MessageDeliveryState = "SENDING" | "ACKNOWLEDGED" | "FAILED" | "RECEIVED" | "UNKNOWN";
export type NodeStatus = "ACTIVE" | "RECENT" | "STALE" | "LOST" | "UNKNOWN";
export type NodeObservationKind = "NODEDB" | "PACKET" | "TELEMETRY" | "POSITION";
export type PacketDirectionFilter = "all" | "RX" | "TX";
export type PacketAckFilter = "all" | "yes" | "no";
export type PacketEncryptionFilter = "all" | "decrypted" | "encrypted" | "pki";
export type PacketTimeFilter = "all" | "5m" | "1h" | "24h";
export type PacketInspectorTab = "summary" | "decoded" | "raw" | "provenance" | "related";
export type AnalyticsTimeRange = "1h" | "6h" | "24h" | "7d" | "all";
export type NodeColumnId =
  | "status" | "node" | "id" | "hardware" | "role" | "firmware" | "lastHeard"
  | "battery" | "voltage" | "rssi" | "snr" | "hops" | "position" | "favorite" | "field";

export interface AppSettings {
  theme: "system" | "light" | "dark";
  mode: "easy" | "advanced";
  activeMinutes: number;
  staleMinutes: number;
  lostMinutes: number;
  livePacketLimit: number;
  telemetryLimit: number;
  nodeHistoryLimit: number;
  serviceWorker: boolean;
}

export interface RadioRecord {
  nodeNum?: number;
  longName?: string;
  shortName?: string;
  hardware?: string;
  firmware?: string;
  role?: string;
  region?: string;
  modemPreset?: string;
  txPower?: number;
  hopLimit?: number;
  battery?: number;
  voltage?: number;
  channelUtilization?: number;
  airUtilTx?: number;
  pioEnv?: string;
  serialVendorId?: number;
  serialProductId?: number;
  connectedAt?: string;
  lastRxAt?: string;
  lastTxAt?: string;
}

export interface NodeRecord {
  num: number;
  id: string;
  longName: string;
  shortName: string;
  hardware?: string;
  role?: string;
  firmware?: string;
  lastHeard?: string;
  battery?: number;
  voltage?: number;
  rssi?: number;
  snr?: number;
  hops?: number;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  channelUtilization?: number;
  airUtilTx?: number;
  favorite?: boolean;
  ignored?: boolean;
  notes?: string;
  provenance: Provenance;
}

export interface NodeObservation {
  id: string;
  nodeNum: number;
  time: string;
  kind: NodeObservationKind;
  lastHeard?: string;
  battery?: number;
  voltage?: number;
  rssi?: number;
  snr?: number;
  hops?: number;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  channelUtilization?: number;
  airUtilTx?: number;
  packetRecordId?: string;
  telemetryRecordId?: string;
  positionRecordId?: string;
  provenance: Provenance;
}

export interface NodeMetadata {
  nodeNum: number;
  purpose?: string;
  owner?: string;
  location?: string;
  antenna?: string;
  antennaGainDbi?: number;
  antennaHeightM?: number;
  assetTag?: string;
  deploymentNotes?: string;
  notes?: string;
  updatedAt?: string;
}

export interface NodeFilterState {
  search: string;
  status: "all" | NodeStatus;
  role: string;
  hardware: string;
  favoritesOnly: boolean;
  sortBy: NodeColumnId;
  sortDir: "asc" | "desc";
}

export interface SavedNodeView {
  id: string;
  name: string;
  filter: NodeFilterState;
  visibleColumns: NodeColumnId[];
  columnWidths: Partial<Record<NodeColumnId, number>>;
  createdAt: string;
  updatedAt: string;
}

export interface NodeTableState {
  filter: NodeFilterState;
  visibleColumns: NodeColumnId[];
  columnWidths: Partial<Record<NodeColumnId, number>>;
  savedViews: SavedNodeView[];
  selectedViewId?: string;
}

export interface PacketFilterState {
  search: string;
  direction: PacketDirectionFilter;
  portNum: string;
  channel: string;
  source: string;
  destination: string;
  wantAck: PacketAckFilter;
  encryption: PacketEncryptionFilter;
  timeRange: PacketTimeFilter;
}

export interface PacketLabState {
  filter: PacketFilterState;
  inspectorTab: PacketInspectorTab;
}


export interface RfTelemetryState {
  timeRange: AnalyticsTimeRange;
  rfNode: string;
  telemetryNode: string;
  telemetryKind: string;
  telemetryMetric: string;
}

export interface PacketRecord {
  id: string;
  packetId?: number;
  time: string;
  direction: "RX" | "TX";
  source?: number;
  destination?: number;
  portNum?: string;
  channel?: number;
  hopLimit?: number;
  hopStart?: number;
  wantAck?: boolean;
  encrypted?: boolean;
  rssi?: number;
  snr?: number;
  size?: number;
  payloadType?: string;
  priority?: string;
  viaMqtt?: boolean;
  pkiEncrypted?: boolean;
  nextHop?: number;
  relayNode?: number;
  transport?: string;
  delayed?: string;
  wantResponse?: boolean;
  requestId?: number;
  replyId?: number;
  emoji?: number;
  rawHex?: string;
  decoded?: unknown;
  raw?: unknown;
  provenance: Provenance;
}

export interface MessageRecord {
  id: string;
  packetId?: number;
  packetRecordId?: string;
  time: string;
  from: number;
  to: number;
  channel: number;
  type: "broadcast" | "direct";
  text: string;
  state: MessageDeliveryState;
  direction: "RX" | "TX";
  attempts: number;
  sentAt?: string;
  acknowledgedAt?: string;
  failedAt?: string;
  failureReason?: string;
}

export interface MessagingState {
  drafts: Record<string, string>;
  readAt: Record<string, string>;
  lastConversation?: string;
}

export interface TelemetryRecord {
  id: string;
  nodeNum: number;
  time: string;
  kind: string;
  values: Record<string, unknown>;
  provenance: Provenance;
}

export interface PositionRecord {
  id: string;
  nodeNum: number;
  time: string;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  precisionBits?: number;
  provenance: Provenance;
}

export interface ChannelRecord {
  index: number;
  role: string;
  name: string;
  uplinkEnabled?: boolean;
  downlinkEnabled?: boolean;
  pskConfigured?: boolean;
  settings?: unknown;
}

export interface TimelineEvent {
  id: string;
  time: string;
  type: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  source?: string;
  nodeNum?: number;
  text: string;
  provenance: Provenance;
}

export interface LogEntry {
  id: string;
  time: string;
  text: string;
  nodeNum?: number;
}

export interface Finding {
  id: string;
  title: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  nodeNum?: number;
  observedValue?: string;
  threshold?: string;
  firstObserved: string;
  lastObserved: string;
  status: "OPEN" | "ACKNOWLEDGED" | "DISMISSED";
  notes?: string;
  evidence?: string[];
}

export interface EvidenceRecord {
  id: string;
  title: string;
  time: string;
  observation: string;
  nodeNum?: number;
  packetIds: string[];
  notes?: string;
  provenance: Provenance;
}

export interface NetworkSnapshot {
  id: string;
  name: string;
  time: string;
  radio: RadioRecord;
  nodes: NodeRecord[];
  packetCount: number;
  messageCount: number;
  telemetryCount: number;
  findings: Finding[];
  config: unknown;
}

export interface Project {
  schemaVersion: number;
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  demo: boolean;
  radio: RadioRecord;
  nodes: NodeRecord[];
  nodeObservations: NodeObservation[];
  nodeMetadata: NodeMetadata[];
  nodeTable: NodeTableState;
  packets: PacketRecord[];
  packetLab: PacketLabState;
  rfTelemetry: RfTelemetryState;
  messages: MessageRecord[];
  messaging: MessagingState;
  telemetry: TelemetryRecord[];
  positions: PositionRecord[];
  channels: ChannelRecord[];
  config: { radio: unknown; modules: unknown };
  timeline: TimelineEvent[];
  logbook: LogEntry[];
  findings: Finding[];
  evidence: EvidenceRecord[];
  snapshots: NetworkSnapshot[];
}

export interface SyncProgress {
  phase: "idle" | "configuring" | "configured";
  config: number;
  modules: number;
  channels: number;
  nodes: number;
  myInfo: boolean;
  metadata: boolean;
}

export interface RuntimeState {
  view: ViewId;
  connection: ConnectionState;
  connectionReason?: string;
  stateChangedAt?: string;
  connectionStartedAt?: string;
  connectedAt?: string;
  disconnectedAt?: string;
  lastDisconnectCause?: string;
  reconnectAttempt: number;
  nextReconnectAt?: string;
  saveState: SaveState;
  rxCount: number;
  txCount: number;
  decodeErrors: number;
  protocolErrors: number;
  sdkState: string;
  lastValidProtocolAt?: string;
  lastTransportEventAt?: string;
  sync: SyncProgress;
  selectedNode?: number;
  selectedPacket?: string;
  nodeSearch: string;
  packetSearch: string;
  packetLivePaused: boolean;
  packetPauseAt?: string;
  packetNewWhilePaused: number;
  messageSearch: string;
  messageStateFilter: "all" | "sending" | "acknowledged" | "failed" | "received";
  selectedConversation: string;
  selectedMessage?: string;
  messageDestination: "broadcast" | number;
  messageChannel: number;
  serialInfo?: { usbVendorId?: number; usbProductId?: number; baudRate?: number };
}

export function emptyProject(name = "Untitled Mesh Project"): Project {
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
      visibleColumns: ["status","node","id","hardware","role","lastHeard","battery","rssi","snr","hops","position"],
      columnWidths: {}, savedViews: []
    },
    packets: [],
    packetLab: { filter: { search:"", direction:"all", portNum:"", channel:"", source:"", destination:"", wantAck:"all", encryption:"all", timeRange:"all" }, inspectorTab:"summary" },
    rfTelemetry: { timeRange:"24h", rfNode:"all", telemetryNode:"all", telemetryKind:"all", telemetryMetric:"batteryLevel" },
    messages: [], messaging: { drafts: {}, readAt: {}, lastConversation: "channel:0" }, telemetry: [], positions: [], channels: [],
    config: { radio: {}, modules: {} }, timeline: [], logbook: [], findings: [], evidence: [], snapshots: []
  };
}

export function normalizeProject(value: Partial<Project> | undefined): Project {
  const base = emptyProject(value?.name || "Untitled Mesh Project");
  if (!value || typeof value !== "object") return base;
  const legacyMessages = Array.isArray(value.messages) ? value.messages : [];
  const messages = legacyMessages.map((m): MessageRecord => {
    const x = m as Partial<MessageRecord> & { state?: string };
    const legacy = String(x.state || "").toUpperCase();
    const state: MessageDeliveryState =
      legacy.includes("FAIL") ? "FAILED" :
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
  const legacyMetadata: NodeMetadata[] = legacyNodes
    .filter((n) => !!(n as NodeRecord).notes)
    .map((n) => ({ nodeNum: (n as NodeRecord).num, notes: (n as NodeRecord).notes, updatedAt: value.updatedAt || value.createdAt }));
  const explicitMetadata = Array.isArray(value.nodeMetadata) ? value.nodeMetadata : [];
  const metadataByNode = new Map<number, NodeMetadata>();
  for (const item of [...legacyMetadata, ...explicitMetadata]) {
    if (!item || typeof item.nodeNum !== "number") continue;
    metadataByNode.set(item.nodeNum, { ...(metadataByNode.get(item.nodeNum) || {}), ...item });
  }

  let nodeObservations: NodeObservation[] = Array.isArray(value.nodeObservations) ? value.nodeObservations : [];
  if (!nodeObservations.length) {
    const migrated: NodeObservation[] = [];
    for (const node of legacyNodes) migrated.push({ id:crypto.randomUUID(), nodeNum:node.num, time:node.lastHeard || value.updatedAt || value.createdAt || new Date().toISOString(), kind:"NODEDB", lastHeard:node.lastHeard, battery:node.battery, voltage:node.voltage, rssi:node.rssi, snr:node.snr, hops:node.hops, latitude:node.latitude, longitude:node.longitude, altitude:node.altitude, channelUtilization:node.channelUtilization, airUtilTx:node.airUtilTx, provenance:"OBSERVED" });
    for (const packet of Array.isArray(value.packets) ? value.packets : []) if (packet.direction === "RX" && packet.source !== undefined && (packet.rssi !== undefined || packet.snr !== undefined)) migrated.push({ id:crypto.randomUUID(), nodeNum:packet.source, time:packet.time, kind:"PACKET", rssi:packet.rssi, snr:packet.snr, packetRecordId:packet.id, provenance:"OBSERVED" });
    for (const reading of Array.isArray(value.telemetry) ? value.telemetry : []) {
      const battery = typeof reading.values?.batteryLevel === "number" ? reading.values.batteryLevel : typeof reading.values?.battery === "number" ? reading.values.battery : undefined;
      const voltage = typeof reading.values?.voltage === "number" ? reading.values.voltage : undefined;
      const channelUtilization = typeof reading.values?.channelUtilization === "number" ? reading.values.channelUtilization : undefined;
      const airUtilTx = typeof reading.values?.airUtilTx === "number" ? reading.values.airUtilTx : undefined;
      if ([battery,voltage,channelUtilization,airUtilTx].some(v=>v!==undefined)) migrated.push({ id:crypto.randomUUID(), nodeNum:reading.nodeNum, time:reading.time, kind:"TELEMETRY", battery, voltage, channelUtilization, airUtilTx, telemetryRecordId:reading.id, provenance:"OBSERVED" });
    }
    for (const position of Array.isArray(value.positions) ? value.positions : []) migrated.push({ id:crypto.randomUUID(), nodeNum:position.nodeNum, time:position.time, kind:"POSITION", latitude:position.latitude, longitude:position.longitude, altitude:position.altitude, positionRecordId:position.id, provenance:"OBSERVED" });
    nodeObservations = migrated.sort((a,b)=>new Date(a.time).getTime()-new Date(b.time).getTime());
  }

  const incomingTable = value.nodeTable && typeof value.nodeTable === "object" ? value.nodeTable : undefined;
  const validColumns = new Set<NodeColumnId>(["status","node","id","hardware","role","firmware","lastHeard","battery","voltage","rssi","snr","hops","position","favorite","field"]);
  const visibleColumns = Array.isArray(incomingTable?.visibleColumns)
    ? incomingTable!.visibleColumns.filter((x): x is NodeColumnId => validColumns.has(x as NodeColumnId))
    : base.nodeTable.visibleColumns;
  const filter: NodeFilterState = { ...base.nodeTable.filter, ...(incomingTable?.filter || {}) };
  if (!validColumns.has(filter.sortBy)) filter.sortBy = "lastHeard";
  const savedViews = Array.isArray(incomingTable?.savedViews)
    ? incomingTable!.savedViews.map((view) => ({
        ...view,
        filter: { ...base.nodeTable.filter, ...(view.filter || {}) },
        visibleColumns: Array.isArray(view.visibleColumns) ? view.visibleColumns.filter((x): x is NodeColumnId => validColumns.has(x as NodeColumnId)) : base.nodeTable.visibleColumns,
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
      inspectorTab: ["summary","decoded","raw","provenance","related"].includes(String(value.packetLab?.inspectorTab)) ? value.packetLab!.inspectorTab : "summary"
    },
    rfTelemetry: {
      ...base.rfTelemetry, ...(value.rfTelemetry || {}),
      timeRange: ["1h","6h","24h","7d","all"].includes(String(value.rfTelemetry?.timeRange)) ? value.rfTelemetry!.timeRange : base.rfTelemetry.timeRange
    },
    telemetry: Array.isArray(value.telemetry) ? value.telemetry : [], positions: Array.isArray(value.positions) ? value.positions : [],
    channels: Array.isArray(value.channels) ? value.channels : [], timeline: Array.isArray(value.timeline) ? value.timeline : [],
    logbook: Array.isArray(value.logbook) ? value.logbook : [], findings: Array.isArray(value.findings) ? value.findings : [],
    evidence: Array.isArray(value.evidence) ? value.evidence : [], snapshots: Array.isArray(value.snapshots) ? value.snapshots : []
  };
}

export const defaultSettings: AppSettings = {
  theme: "system", mode: "easy", activeMinutes: 10, staleMinutes: 30, lostMinutes: 180,
  livePacketLimit: 2000, telemetryLimit: 5000, nodeHistoryLimit: 50000, serviceWorker: true
};
