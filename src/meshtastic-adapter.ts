import { MeshClient, ChannelNumber, DeviceStatusEnum, Protobuf } from "@meshtastic/sdk";
import { TransportWebSerial } from "@meshtastic/transport-web-serial";
import type {
  ChannelRecord, ConnectionState, MessageDeliveryState, MessageRecord, NodeRecord, PacketRecord,
  PositionRecord, RadioRecord, SyncProgress, TelemetryRecord, TimelineEvent
} from "./models";
import { bytesToHex, nodeId, safeObject } from "./utils";

const BAUD_RATE = 115200;
const CONNECT_ACK_TIMEOUT_MS = 15_000;
const SYNC_TIMEOUT_MS = 45_000;
const RESYNC_TIMEOUT_MS = 45_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 3_000, 5_000, 8_000, 12_000, 15_000] as const;

export interface AdapterDiagnosticsUpdate {
  stateChangedAt?: string;
  connectionStartedAt?: string;
  connectedAt?: string;
  disconnectedAt?: string;
  lastDisconnectCause?: string;
  reconnectAttempt?: number;
  nextReconnectAt?: string;
  lastValidProtocolAt?: string;
  lastTransportEventAt?: string;
  serialInfo?: { usbVendorId?: number; usbProductId?: number; baudRate?: number };
}

export interface AdapterHooks {
  connection(state: ConnectionState, reason?: string): void;
  progress(progress: SyncProgress): void;
  diagnostics(update: AdapterDiagnosticsUpdate): void;
  nodes(nodes: NodeRecord[]): void;
  channels(channels: ChannelRecord[]): void;
  radio(radio: Partial<RadioRecord>): void;
  packet(packet: PacketRecord): void;
  message(message: MessageRecord): void;
  messageState(packetId: number, state: MessageDeliveryState, reason?: string): void;
  telemetry(reading: TelemetryRecord): void;
  position(position: PositionRecord): void;
  config(config: { radio: unknown; modules: unknown }): void;
  timeline(event: TimelineEvent): void;
  activity(direction: "RX" | "TX"): void;
  sdkState(state: string): void;
  error(kind: "decode" | "protocol", error: unknown): void;
}

type Disposable = { unsubscribe?: () => void } | (() => void) | undefined;
type SerialFailure = Error & { kind?: string; userMessage?: string };

function enumName(group: any, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try { return typeof value === "number" ? String(group?.[value] ?? value) : String(value); }
  catch { return String(value); }
}
function latitude(position: any): number | undefined {
  if (typeof position?.latitude === "number") return position.latitude;
  if (typeof position?.latitudeI === "number") return position.latitudeI / 1e7;
  return undefined;
}
function longitude(position: any): number | undefined {
  if (typeof position?.longitude === "number") return position.longitude;
  if (typeof position?.longitudeI === "number") return position.longitudeI / 1e7;
  return undefined;
}
function isoFromSeconds(value: unknown): string | undefined {
  return typeof value === "number" && value > 0 ? new Date(value * 1000).toISOString() : undefined;
}
function now(): string { return new Date().toISOString(); }
function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
function errorMessage(error: unknown): string {
  const e = error as SerialFailure;
  return e?.userMessage || e?.message || String(error);
}
function isPortPickerCancel(error: unknown): boolean {
  const e = error as DOMException | Error;
  return e?.name === "NotFoundError" || /no port selected|serial port not selected|user cancelled|user canceled/i.test(e?.message || "");
}

export class MeshtasticAdapter {
  private client?: MeshClient;
  private port?: SerialPort;
  private portInfo?: SerialPortInfo;
  private disposables: Disposable[] = [];
  private hooks: AdapterHooks;
  private connecting = false;
  private operatorDisconnect = false;
  private reconnectTimer?: number;
  private reconnectAttempt = 0;
  private recovering = false;
  private generation = 0;
  private serialListenersInstalled = false;

  constructor(hooks: AdapterHooks) {
    this.hooks = hooks;
    this.installSerialListeners();
  }
  get connected(): boolean { return !!this.client && this.client.device.status.value === DeviceStatusEnum.DeviceConfigured; }
  get active(): boolean { return !!this.client || this.connecting || this.recovering || this.reconnectTimer !== undefined; }
  get meshClient(): MeshClient | undefined { return this.client; }

  async connect(reuseGrantedPort = false): Promise<void> {
    this.cancelReconnect();
    this.reconnectAttempt = 0;
    this.operatorDisconnect = false;
    await this.openConnection(reuseGrantedPort, false);
  }

  async reconnect(): Promise<void> {
    this.cancelReconnect();
    this.operatorDisconnect = true;
    await this.shutdownClient();
    this.operatorDisconnect = false;
    this.reconnectAttempt = 0;
    this.hooks.connection("RECONNECTING", "Operator requested reconnect");
    await this.openConnection(true, false);
  }

  async resync(): Promise<void> {
    if (!this.client) throw new Error("No radio is connected.");
    this.hooks.connection("SYNCHRONIZING", "Operator requested configuration resynchronization");
    this.hooks.sdkState("Resynchronizing device configuration");
    await timeout(this.client.configure(), CONNECT_ACK_TIMEOUT_MS, "The radio did not acknowledge the resynchronization request.");
    await this.waitUntilConfigured(this.client, RESYNC_TIMEOUT_MS);
  }

  async disconnect(userInitiated = true): Promise<void> {
    this.cancelReconnect();
    this.operatorDisconnect = true;
    this.recovering = false;
    await this.shutdownClient();
    const reason = userInitiated ? "Disconnected by operator" : "Connection closed";
    this.hooks.connection("DISCONNECTED", reason);
    this.hooks.sdkState("Disconnected");
    this.hooks.progress(this.emptyProgress("idle"));
    this.hooks.diagnostics({ disconnectedAt: now(), lastDisconnectCause: reason, reconnectAttempt: 0, nextReconnectAt: undefined });
  }

  async sendText(text: string, destination: "broadcast" | number, channel: number): Promise<number> {
    if (!this.connected || !this.client) throw new Error("Connect and synchronize a radio before sending.");
    const result = await this.client.chat.send({ text, destination, channel: channel as ChannelNumber, wantAck: true });
    if (result.status === "error") throw result.error;
    return result.value;
  }

  private async openConnection(reuseGrantedPort: boolean, recoveryAttempt: boolean): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    const generation = ++this.generation;
    const started = now();
    this.hooks.diagnostics({ connectionStartedAt: started, stateChangedAt: started, reconnectAttempt: this.reconnectAttempt, nextReconnectAt: undefined });
    this.hooks.connection(recoveryAttempt ? "RECONNECTING" : reuseGrantedPort ? "RECONNECTING" : "CONNECTING");
    this.hooks.sdkState(recoveryAttempt ? `Reconnect attempt ${this.reconnectAttempt}` : "Selecting serial device");

    try {
      if (!("serial" in navigator)) throw new Error("Web Serial API is not available in this browser.");
      const port = reuseGrantedPort ? await this.findGrantedPort() : await navigator.serial.requestPort();
      if (!port) throw new Error("The previously authorized Meshtastic serial device is not currently available.");
      if (generation !== this.generation) return;

      this.port = port;
      this.portInfo = port.getInfo?.() ?? {};
      const serialInfo = { ...this.portInfo, baudRate: BAUD_RATE };
      this.hooks.radio({ serialVendorId: this.portInfo.usbVendorId, serialProductId: this.portInfo.usbProductId });
      this.hooks.diagnostics({ serialInfo, lastTransportEventAt: now() });
      this.hooks.sdkState("Opening USB serial transport");

      const transportResult = await TransportWebSerial.createFromPort(port, BAUD_RATE);
      if (transportResult.status === "error") throw transportResult.error;
      if (generation !== this.generation) { await transportResult.value.disconnect().catch(() => {}); return; }

      this.hooks.connection("SERIAL_OPEN");
      this.hooks.sdkState("Serial transport open; starting Meshtastic client");
      const client = new MeshClient({ transport: transportResult.value });
      this.client = client;
      this.disposeSubscriptions();
      this.bindClient(client);
      this.hooks.connection("SYNCHRONIZING");
      this.hooks.progress(this.emptyProgress("configuring"));
      this.hooks.sdkState("Requesting Meshtastic configuration");

      await timeout(client.connect(), CONNECT_ACK_TIMEOUT_MS, "The radio did not acknowledge the initial configuration request.");
      await this.waitUntilConfigured(client, SYNC_TIMEOUT_MS);
      if (generation !== this.generation) return;

      this.recovering = false;
      this.reconnectAttempt = 0;
      this.hooks.connection("CONNECTED");
      this.hooks.sdkState("Device configured and ready");
      this.hooks.radio({ connectedAt: now() });
      this.hooks.diagnostics({ connectedAt: now(), reconnectAttempt: 0, nextReconnectAt: undefined, lastDisconnectCause: undefined });
      client.setHeartbeatInterval(300_000);
    } catch (error) {
      const message = errorMessage(error);
      await this.shutdownClient();
      if (!recoveryAttempt && !reuseGrantedPort && isPortPickerCancel(error)) {
        this.hooks.connection("DISCONNECTED", "Serial port selection canceled by operator.");
        this.hooks.sdkState("Ready — no serial port selected");
        this.hooks.progress(this.emptyProgress("idle"));
        return;
      }
      if (recoveryAttempt && !this.operatorDisconnect) {
        this.hooks.connection("RECOVERING", message);
        this.hooks.sdkState(`Reconnect failed: ${message}`);
        this.scheduleReconnect(message);
      } else {
        this.hooks.connection("ERROR", message);
        this.hooks.sdkState(`Connection failed: ${message}`);
      }
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  private bindClient(client: MeshClient): void {
    const sub = (source: any, fn: (value: any) => void) => {
      try { this.disposables.push(source.subscribe(fn)); }
      catch (error) { this.hooks.error("protocol", error); }
    };

    sub(client.device.status, (status: DeviceStatusEnum) => {
      const name = enumName(DeviceStatusEnum, status) ?? "Unknown";
      this.hooks.sdkState(name);
      this.hooks.diagnostics({ stateChangedAt: now(), lastTransportEventAt: now() });
      if (status === DeviceStatusEnum.DeviceConfigured) {
        this.hooks.connection("CONNECTED");
        this.hooks.radio({ connectedAt: now() });
      } else if (status === DeviceStatusEnum.DeviceConfiguring || status === DeviceStatusEnum.DeviceConnected || status === DeviceStatusEnum.DeviceConnecting) {
        this.hooks.connection(status === DeviceStatusEnum.DeviceConnected ? "SERIAL_OPEN" : "SYNCHRONIZING");
      } else if (status === DeviceStatusEnum.DeviceReconnecting) {
        this.hooks.connection("RECONNECTING");
      } else if (status === DeviceStatusEnum.DeviceDisconnected) {
        if (this.operatorDisconnect) this.hooks.connection("DISCONNECTED", "Disconnected by operator");
        else void this.beginRecovery("Meshtastic transport disconnected unexpectedly.");
      } else if (status === DeviceStatusEnum.DeviceError) {
        if (!this.operatorDisconnect) void this.beginRecovery("Meshtastic SDK reported a device error.");
      }
    });

    sub(client.progress, (progress: any) => {
      const r = progress?.received ?? {};
      const normalized: SyncProgress = {
        phase: progress?.phase === "configured" ? "configured" : progress?.phase === "configuring" ? "configuring" : "idle",
        config: Number(r.config ?? 0), modules: Number(r.modules ?? 0), channels: Number(r.channels ?? 0), nodes: Number(r.nodes ?? 0),
        myInfo: !!r.myInfo, metadata: !!r.metadata
      };
      this.hooks.progress(normalized);
      if (normalized.phase === "configuring") {
        this.hooks.connection("SYNCHRONIZING");
        this.hooks.sdkState(`Synchronizing — nodes ${normalized.nodes}, channels ${normalized.channels}, config ${normalized.config}, modules ${normalized.modules}`);
      }
      if (normalized.phase === "configured") this.hooks.connection("CONNECTED");
    });

    sub(client.device.myNodeInfo, () => this.publishRadio(client));
    sub(client.device.metadata, () => this.publishRadio(client));
    sub(client.config.radio, () => { this.publishRadio(client); this.publishConfig(client); });
    sub(client.config.modules, () => this.publishConfig(client));
    sub(client.nodes.list, (nodes: readonly any[]) => {
      if (nodes.length === 0 && client.device.status.value !== DeviceStatusEnum.DeviceConfigured) return;
      const normalized = nodes.map((node): NodeRecord => {
        const user = node.user; const dm = node.deviceMetrics;
        return {
          num: node.num, id: user?.id || nodeId(node.num), longName: user?.longName || user?.id || nodeId(node.num), shortName: user?.shortName || "????",
          hardware: enumName(Protobuf.Mesh.HardwareModel, user?.hwModel), lastHeard: isoFromSeconds(node.lastHeard),
          battery: typeof dm?.batteryLevel === "number" ? dm.batteryLevel : undefined, voltage: typeof dm?.voltage === "number" ? dm.voltage : undefined,
          snr: typeof node.snr === "number" ? node.snr : undefined, hops: typeof node.hopsAway === "number" ? node.hopsAway : undefined,
          latitude: latitude(node.position), longitude: longitude(node.position), altitude: node.position?.altitude,
          channelUtilization: dm?.channelUtilization, airUtilTx: dm?.airUtilTx, favorite: !!node.isFavorite, ignored: !!node.isIgnored, provenance: "OBSERVED"
        };
      });
      this.markValidProtocol();
      this.hooks.nodes(normalized); this.publishRadio(client);
    });
    sub(client.channels.list, (channels: readonly any[]) => {
      if (channels.length === 0 && client.device.status.value !== DeviceStatusEnum.DeviceConfigured) return;
      this.markValidProtocol();
      this.hooks.channels(channels.map(ch => ({
        index: ch.index, role: enumName(Protobuf.Channel.Channel_Role, ch.role) ?? String(ch.role), name: ch.settings?.name || (ch.index === 0 ? "Primary" : `Channel ${ch.index}`),
        uplinkEnabled: ch.settings?.uplinkEnabled, downlinkEnabled: ch.settings?.downlinkEnabled, pskConfigured: !!(ch.settings?.psk?.length), settings: safeObject(ch.settings)
      })));
    });

    this.disposables.push(client.events.onMeshPacket.subscribe((packet: any) => {
      try {
        const t = now(); const fromUs = packet.from === client.myNodeNum;
        const decoded = packet.payloadVariant?.case === "decoded" ? packet.payloadVariant.value : undefined;
        const encrypted = packet.payloadVariant?.case === "encrypted"; const payload = decoded?.payload ?? (encrypted ? packet.payloadVariant.value : undefined);
        const rec: PacketRecord = {
          id: crypto.randomUUID(), packetId: packet.id, time: packet.rxTime ? new Date(packet.rxTime * 1000).toISOString() : t,
          direction: fromUs ? "TX" : "RX", source: packet.from, destination: packet.to,
          portNum: decoded ? enumName(Protobuf.Portnums.PortNum, decoded.portnum) : encrypted ? "ENCRYPTED" : packet.payloadVariant?.case,
          channel: packet.channel, hopLimit: packet.hopLimit, hopStart: packet.hopStart, wantAck: packet.wantAck, encrypted,
          rssi: typeof packet.rxRssi === "number" ? packet.rxRssi : undefined, snr: typeof packet.rxSnr === "number" ? packet.rxSnr : undefined,
          size: payload?.length, payloadType: packet.payloadVariant?.case,
          priority: enumName(Protobuf.Mesh?.MeshPacket_Priority, packet.priority),
          viaMqtt: packet.viaMqtt === true || packet.viaMqtt === 1,
          pkiEncrypted: packet.pkiEncrypted === true,
          nextHop: typeof packet.nextHop === "number" ? packet.nextHop : undefined,
          relayNode: typeof packet.relayNode === "number" ? packet.relayNode : undefined,
          transport: enumName(Protobuf.Mesh?.MeshPacket_TransportMechanism, packet.transport),
          delayed: enumName(Protobuf.Mesh?.MeshPacket_Delayed, packet.delayed),
          wantResponse: decoded?.wantResponse,
          requestId: typeof decoded?.requestId === "number" ? decoded.requestId : undefined,
          replyId: typeof decoded?.replyId === "number" ? decoded.replyId : undefined,
          emoji: typeof decoded?.emoji === "number" ? decoded.emoji : undefined,
          rawHex: payload instanceof Uint8Array ? bytesToHex(payload) : undefined,
          decoded: decoded ? safeObject(decoded) : undefined,
          raw: safeObject(packet), provenance: "OBSERVED"
        };
        this.markValidProtocol(); this.hooks.packet(rec); this.hooks.activity(rec.direction);
        this.hooks.radio(rec.direction === "RX" ? { lastRxAt: t } : { lastTxAt: t });
      } catch (error) { this.hooks.error("decode", error); }
    }));

    this.disposables.push(client.events.onMessagePacket.subscribe((packet: any) => {
      const direction = packet.from === client.myNodeNum ? "TX" : "RX"; this.markValidProtocol();
      this.hooks.message({ id: crypto.randomUUID(), packetId: packet.id, time: packet.rxTime instanceof Date ? packet.rxTime.toISOString() : now(),
        from: packet.from, to: packet.to, channel: Number(packet.channel ?? 0), type: packet.type === "direct" ? "direct" : "broadcast", text: String(packet.data ?? ""),
        state: direction === "RX" ? "RECEIVED" : "UNKNOWN", direction, attempts: 1 });
      this.hooks.timeline({ id: crypto.randomUUID(), time: now(), type: `message ${direction === "RX" ? "received" : "sent"}`, severity: "INFO",
        nodeNum: direction === "RX" ? packet.from : packet.to, text: String(packet.data ?? ""), provenance: "OBSERVED" });
    }));

    this.disposables.push(client.events.onRoutingPacket.subscribe((packet: any) => {
      try {
        if (packet?.data?.variant?.case !== "errorReason") return;
        const code = Number(packet.data.variant.value ?? -1);
        const state: MessageDeliveryState = code === 0 ? "ACKNOWLEDGED" : "FAILED";
        const reason = code === 0 ? undefined : `Meshtastic routing error ${enumName(Protobuf.Routing?.Routing_Error, code) ?? code}`;
        this.markValidProtocol();
        this.hooks.messageState(Number(packet.id), state, reason);
      } catch (error) { this.hooks.error("decode", error); }
    }));

    this.disposables.push(client.events.onTelemetryPacket.subscribe((packet: any) => {
      try { const variant = packet.data?.variant; const kind = variant?.case ?? "unknown"; this.markValidProtocol();
        this.hooks.telemetry({ id: crypto.randomUUID(), nodeNum: packet.from, time: packet.rxTime instanceof Date ? packet.rxTime.toISOString() : now(),
          kind, values: safeObject(variant?.value ?? packet.data ?? {}), provenance: "OBSERVED" });
      } catch (error) { this.hooks.error("decode", error); }
    }));

    this.disposables.push(client.events.onPositionPacket.subscribe((packet: any) => {
      const pos = packet.data ?? {}; this.markValidProtocol();
      this.hooks.position({ id: crypto.randomUUID(), nodeNum: packet.from, time: packet.rxTime instanceof Date ? packet.rxTime.toISOString() : now(),
        latitude: latitude(pos), longitude: longitude(pos), altitude: pos.altitude, precisionBits: pos.precisionBits, provenance: "OBSERVED" });
    }));

    this.disposables.push(client.events.onDeviceDebugLog.subscribe((line: any) => {
      this.markValidProtocol();
      this.hooks.timeline({ id: crypto.randomUUID(), time: now(), type: "device debug", severity: "INFO", source: "RADIO", text: String(line), provenance: "OBSERVED" });
    }));

    this.disposables.push(client.events.onRebooted.subscribe(() => {
      this.hooks.connection("RECOVERING", "Radio reboot reported; Meshtastic SDK is requesting a fresh configuration bundle.");
      this.hooks.sdkState("Radio reboot reported; awaiting SDK resynchronization");
      this.hooks.timeline({ id: crypto.randomUUID(), time: now(), type: "radio rebooted", severity: "INFO", source: "RADIO", text: "Connected radio reported a reboot. The Meshtastic SDK automatically requested configuration resynchronization.", provenance: "OBSERVED" });
    }));
  }

  private async beginRecovery(cause: string): Promise<void> {
    if (this.operatorDisconnect || this.recovering) return;
    this.recovering = true;
    this.hooks.connection("RECOVERING", cause);
    this.hooks.sdkState(`Recovering: ${cause}`);
    this.hooks.diagnostics({ disconnectedAt: now(), lastDisconnectCause: cause, lastTransportEventAt: now() });
    await this.shutdownClient();
    if (!this.operatorDisconnect) this.scheduleReconnect(cause);
  }

  private scheduleReconnect(cause: string): void {
    if (this.operatorDisconnect || this.reconnectTimer) return;
    if (this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      this.recovering = false;
      this.hooks.connection("ERROR", `Automatic reconnect stopped after ${RECONNECT_DELAYS_MS.length} attempts. ${cause}`);
      this.hooks.sdkState("Automatic reconnect exhausted; use RECONNECT after checking USB.");
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt]!;
    this.reconnectAttempt += 1;
    const next = new Date(Date.now() + delay).toISOString();
    this.hooks.connection("RECOVERING", `${cause} Retrying in ${(delay / 1000).toFixed(delay < 1000 ? 1 : 0)}s.`);
    this.hooks.diagnostics({ reconnectAttempt: this.reconnectAttempt, nextReconnectAt: next, lastDisconnectCause: cause });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.operatorDisconnect) return;
      void this.openConnection(true, true).catch(() => { /* openConnection schedules the next attempt */ });
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.hooks.diagnostics({ nextReconnectAt: undefined });
  }

  private async findGrantedPort(): Promise<SerialPort | undefined> {
    const ports = await navigator.serial.getPorts();
    if (!ports.length) return undefined;
    if (this.port && ports.includes(this.port)) return this.port;
    if (this.portInfo?.usbVendorId !== undefined || this.portInfo?.usbProductId !== undefined) {
      const match = ports.find(port => {
        const info = port.getInfo?.() ?? {};
        return (this.portInfo?.usbVendorId === undefined || info.usbVendorId === this.portInfo.usbVendorId) &&
          (this.portInfo?.usbProductId === undefined || info.usbProductId === this.portInfo.usbProductId);
      });
      if (match) return match;
    }
    return ports.length === 1 ? ports[0] : undefined;
  }

  private waitUntilConfigured(client: MeshClient, ms: number): Promise<void> {
    if (client.device.status.value === DeviceStatusEnum.DeviceConfigured || client.progress.value?.phase === "configured") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let statusSub: Disposable; let progressSub: Disposable; let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        try { typeof statusSub === "function" ? statusSub() : statusSub?.unsubscribe?.(); } catch {}
        try { typeof progressSub === "function" ? progressSub() : progressSub?.unsubscribe?.(); } catch {}
      };
      const finish = (error?: Error) => {
        if (settled) return; settled = true; queueMicrotask(cleanup);
        if (error) reject(error); else resolve();
      };
      const timer = window.setTimeout(() => finish(new Error(`Meshtastic synchronization did not complete within ${Math.round(ms / 1000)} seconds.`)), ms);
      statusSub = client.device.status.subscribe((status: DeviceStatusEnum) => {
        if (status === DeviceStatusEnum.DeviceConfigured) finish();
        if (status === DeviceStatusEnum.DeviceDisconnected || status === DeviceStatusEnum.DeviceError) finish(new Error("Device connection lost during synchronization."));
      });
      progressSub = client.progress.subscribe((progress: any) => { if (progress?.phase === "configured") finish(); });
      if (settled) queueMicrotask(cleanup);
    });
  }

  private publishConfig(client: MeshClient): void {
    this.markValidProtocol();
    this.hooks.config({ radio: safeObject(client.config.radio.value), modules: safeObject(client.config.modules.value) });
  }

  private publishRadio(client: MeshClient): void {
    const myNum = client.device.myNodeNum.value; const me: any = myNum ? client.nodes.byNum(myNum) : undefined;
    const metadata: any = client.device.metadata.value; const cfg: any = client.config.radio.value; const dm = me?.deviceMetrics;
    const lora = cfg?.lora; const device = cfg?.device;
    this.hooks.radio({
      nodeNum: myNum, longName: me?.user?.longName, shortName: me?.user?.shortName,
      hardware: enumName(Protobuf.Mesh.HardwareModel, me?.user?.hwModel), firmware: metadata?.firmwareVersion,
      role: enumName(Protobuf.Config.Config_DeviceConfig_Role, device?.role), region: enumName(Protobuf.Config.Config_LoRaConfig_RegionCode, lora?.region),
      modemPreset: enumName(Protobuf.Config.Config_LoRaConfig_ModemPreset, lora?.modemPreset), txPower: lora?.txPower, hopLimit: lora?.hopLimit,
      battery: dm?.batteryLevel, voltage: dm?.voltage, channelUtilization: dm?.channelUtilization, airUtilTx: dm?.airUtilTx, pioEnv: metadata?.pioEnv
    });
  }

  private markValidProtocol(): void { this.hooks.diagnostics({ lastValidProtocolAt: now() }); }
  private emptyProgress(phase: SyncProgress["phase"]): SyncProgress {
    return { phase, config: 0, modules: 0, channels: 0, nodes: 0, myInfo: false, metadata: false };
  }

  private async shutdownClient(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.disposeSubscriptions();
    if (client) {
      try { await client.disconnect(); }
      catch { try { await client.transport.disconnect(); } catch {} }
    }
  }

  private disposeSubscriptions(): void {
    for (const item of this.disposables.splice(0)) {
      try { if (typeof item === "function") item(); else item?.unsubscribe?.(); }
      catch { /* cleanup must never erase or destabilize application state */ }
    }
  }

  private installSerialListeners(): void {
    if (this.serialListenersInstalled || !("serial" in navigator)) return;
    this.serialListenersInstalled = true;
    navigator.serial.addEventListener("disconnect", ((event: Event) => {
      const eventPort = (event as unknown as { port?: SerialPort }).port;
      if (this.operatorDisconnect) return;
      if (!eventPort || !this.port || eventPort === this.port) void this.beginRecovery("USB serial device disconnected from the operating system.");
    }) as EventListener);
    navigator.serial.addEventListener("connect", ((event: Event) => {
      if (!this.recovering || this.operatorDisconnect) return;
      const eventPort = (event as unknown as { port?: SerialPort }).port;
      if (eventPort && this.portMatches(eventPort)) {
        this.port = eventPort; this.cancelReconnect();
        this.hooks.connection("RECONNECTING", "USB device reappeared; reconnecting now.");
        void this.openConnection(true, true).catch(() => {});
      }
    }) as EventListener);
  }

  private portMatches(port: SerialPort): boolean {
    if (!this.portInfo || (this.portInfo.usbVendorId === undefined && this.portInfo.usbProductId === undefined)) return port === this.port;
    const info = port.getInfo?.() ?? {};
    return (this.portInfo.usbVendorId === undefined || info.usbVendorId === this.portInfo.usbVendorId) &&
      (this.portInfo.usbProductId === undefined || info.usbProductId === this.portInfo.usbProductId);
  }
}
