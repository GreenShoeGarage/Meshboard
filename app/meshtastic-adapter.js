import { bytesToHex, nodeId, safeObject } from "./utils.js";
const BAUD_RATE = 115200;
const CONNECT_ACK_TIMEOUT_MS = 15_000;
const SYNC_TIMEOUT_MS = 45_000;
const RESYNC_TIMEOUT_MS = 45_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 3_000, 5_000, 8_000, 12_000, 15_000];
const PORT_OPEN_RETRY_DELAYS_MS = [250, 500, 750];
const POST_CLOSE_DELAY_MS = 200;
// Stable published Meshtastic browser API status values from @meshtastic/core 2.6.7.
const STATUS = {
    DeviceRestarting: 1,
    DeviceDisconnected: 2,
    DeviceConnecting: 3,
    DeviceReconnecting: 4,
    DeviceConnected: 5,
    DeviceConfiguring: 6,
    DeviceConfigured: 7
};
let sdkPromise;
async function loadSdk() {
    if (!sdkPromise) {
        sdkPromise = Promise.all([
            import("@meshtastic/core"),
            import("@meshtastic/transport-web-serial")
        ]).then(([core, serial]) => ({ core, serial })).catch(error => {
            sdkPromise = undefined;
            throw new Error(`Meshtastic browser libraries could not be loaded from the pinned browser ESM runtime: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    return sdkPromise;
}
function enumName(group, value) {
    if (value === undefined || value === null)
        return undefined;
    try {
        return typeof value === "number" ? String(group?.[value] ?? value) : String(value);
    }
    catch {
        return String(value);
    }
}
function latitude(position) {
    if (typeof position?.latitude === "number")
        return position.latitude;
    if (typeof position?.latitudeI === "number")
        return position.latitudeI / 1e7;
    return undefined;
}
function longitude(position) {
    if (typeof position?.longitude === "number")
        return position.longitude;
    if (typeof position?.longitudeI === "number")
        return position.longitudeI / 1e7;
    return undefined;
}
function isoFromSeconds(value) {
    return typeof value === "number" && value > 0 ? new Date(value * 1000).toISOString() : undefined;
}
function packetTime(value) {
    if (value instanceof Date)
        return value.toISOString();
    if (typeof value === "number" && value > 0)
        return new Date(value * 1000).toISOString();
    return now();
}
function now() { return new Date().toISOString(); }
function timeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(message)), ms);
        promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
}
function errorMessage(error) {
    const e = error;
    return e?.userMessage || e?.message || String(error);
}
function sleep(ms) { return new Promise(resolve => window.setTimeout(resolve, ms)); }
function isPortBusyError(error) {
    const e = error;
    return e?.name === "InvalidStateError" || e?.name === "NetworkError" || /already open|failed to open serial port|access is denied|resource busy|device or resource busy/i.test(e?.message || "");
}
function serialFailure(kind, userMessage, cause) {
    const failure = new Error(userMessage);
    failure.name = "SerialConnectError";
    failure.kind = kind;
    failure.userMessage = userMessage;
    if (cause !== undefined)
        failure.cause = cause;
    return failure;
}
async function prepareSerialPort(port, onAttempt) {
    if (port.readable || port.writable) {
        try {
            await port.close();
        }
        catch (cause) {
            throw serialFailure("in-use", "Serial port is open and could not be released. Close any other Meshtastic tab, flasher, Arduino Serial Monitor, terminal, esptool, or Meshtastic CLI using this radio, then try again.", cause);
        }
        await sleep(POST_CLOSE_DELAY_MS);
    }
    let lastError;
    const total = PORT_OPEN_RETRY_DELAYS_MS.length + 1;
    for (let attempt = 0; attempt < total; attempt += 1) {
        onAttempt?.(attempt + 1, total);
        try {
            await port.open({ baudRate: BAUD_RATE });
            return;
        }
        catch (error) {
            lastError = error;
            if (!isPortBusyError(error) || attempt >= PORT_OPEN_RETRY_DELAYS_MS.length)
                break;
            await sleep(PORT_OPEN_RETRY_DELAYS_MS[attempt]);
        }
    }
    if (isPortBusyError(lastError)) {
        throw serialFailure("in-use", "Serial port is busy or still settling. Close any other tab or app using the radio (Meshtastic Web/Flasher, Arduino Serial Monitor, terminal, esptool, Meshtastic CLI), then unplug/replug the radio and press CONNECT RADIO again.", lastError);
    }
    throw serialFailure("unavailable", `Could not open the serial port${lastError instanceof Error && lastError.message ? `: ${lastError.message}` : "."} Re-plug the radio and try again.`, lastError);
}
function isPortPickerCancel(error) {
    const e = error;
    return e?.name === "NotFoundError" || /no port selected|serial port not selected|user cancelled|user canceled/i.test(e?.message || "");
}
function oneofCase(value) {
    return value?.payloadVariant?.case ?? value?.variant?.case ?? value?.config?.case ?? value?.moduleConfig?.case;
}
function oneofValue(value) {
    return value?.payloadVariant?.value ?? value?.variant?.value ?? value?.config?.value ?? value?.moduleConfig?.value ?? value;
}
function dataPayload(packet) {
    return packet?.decoded ?? (packet?.payloadVariant?.case === "decoded" ? packet.payloadVariant.value : undefined);
}
function encryptedPayload(packet) {
    if (packet?.encrypted instanceof Uint8Array)
        return packet.encrypted;
    if (packet?.payloadVariant?.case === "encrypted" && packet.payloadVariant.value instanceof Uint8Array)
        return packet.payloadVariant.value;
    return undefined;
}
export class MeshtasticAdapter {
    device;
    transport;
    core;
    port;
    portInfo;
    disposables = [];
    hooks;
    connecting = false;
    configured = false;
    operatorDisconnect = false;
    reconnectTimer;
    reconnectAttempt = 0;
    recovering = false;
    generation = 0;
    serialListenersInstalled = false;
    myNodeNum;
    metadata;
    nodeMap = new Map();
    channelMap = new Map();
    radioConfig = {};
    moduleConfig = {};
    sync = this.emptyProgress("idle");
    constructor(hooks) {
        this.hooks = hooks;
        this.installSerialListeners();
    }
    get connected() { return !!this.device && this.configured; }
    get active() { return !!this.device || this.connecting || this.recovering || this.reconnectTimer !== undefined; }
    async connect(reuseGrantedPort = false) {
        this.cancelReconnect();
        this.reconnectAttempt = 0;
        this.operatorDisconnect = false;
        await this.openConnection(reuseGrantedPort, false);
    }
    async reconnect() {
        this.cancelReconnect();
        this.operatorDisconnect = true;
        await this.shutdownClient();
        this.operatorDisconnect = false;
        this.reconnectAttempt = 0;
        this.hooks.connection("RECONNECTING", "Operator requested reconnect");
        await this.openConnection(true, false);
    }
    async resync() {
        if (!this.device)
            throw new Error("No radio is connected.");
        this.configured = false;
        this.resetSync();
        this.hooks.connection("SYNCHRONIZING", "Operator requested configuration resynchronization");
        this.hooks.sdkState("Resynchronizing device configuration");
        await timeout(Promise.resolve(this.device.configure()), CONNECT_ACK_TIMEOUT_MS, "The radio did not acknowledge the resynchronization request.");
        await this.waitUntilConfigured(RESYNC_TIMEOUT_MS);
    }
    async disconnect(userInitiated = true) {
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
    async sendText(text, destination, channel) {
        if (!this.connected || !this.device)
            throw new Error("Connect and synchronize a radio before sending.");
        return this.device.sendText(text, destination, true, channel);
    }
    async openConnection(reuseGrantedPort, recoveryAttempt) {
        if (this.connecting)
            return;
        this.connecting = true;
        const generation = ++this.generation;
        const started = now();
        this.hooks.diagnostics({ connectionStartedAt: started, stateChangedAt: started, reconnectAttempt: this.reconnectAttempt, nextReconnectAt: undefined });
        this.hooks.connection(recoveryAttempt || reuseGrantedPort ? "RECONNECTING" : "CONNECTING");
        this.hooks.sdkState(recoveryAttempt ? `Reconnect attempt ${this.reconnectAttempt}` : "Preparing Meshtastic browser libraries");
        try {
            if (!("serial" in navigator))
                throw new Error("Web Serial API is not available in this browser.");
            const { core, serial } = await loadSdk();
            this.core = core;
            this.hooks.sdkState(recoveryAttempt ? `Reconnect attempt ${this.reconnectAttempt}` : "Selecting serial device");
            const port = reuseGrantedPort ? await this.findGrantedPort() : await navigator.serial.requestPort();
            if (!port)
                throw new Error("The previously authorized Meshtastic serial device is not currently available.");
            if (generation !== this.generation)
                return;
            this.port = port;
            this.portInfo = port.getInfo?.() ?? {};
            const serialInfo = { ...this.portInfo, baudRate: BAUD_RATE };
            this.hooks.radio({ serialVendorId: this.portInfo.usbVendorId, serialProductId: this.portInfo.usbProductId });
            this.hooks.diagnostics({ serialInfo, lastTransportEventAt: now() });
            this.hooks.sdkState("Preparing USB serial port");
            await prepareSerialPort(port, (attempt, total) => {
                this.hooks.sdkState(`Opening USB serial port — attempt ${attempt}/${total}`);
                this.hooks.diagnostics({ lastTransportEventAt: now() });
            });
            this.hooks.sdkState("USB serial port open; creating Meshtastic transport");
            const transport = await serial.TransportWebSerial.createFromPort(port, BAUD_RATE);
            if (generation !== this.generation) {
                await transport.disconnect().catch(() => { });
                return;
            }
            this.transport = transport;
            this.hooks.connection("SERIAL_OPEN");
            this.hooks.sdkState("Serial transport open; starting Meshtastic device client");
            const device = new core.MeshDevice(transport);
            this.device = device;
            this.configured = false;
            this.resetSync();
            this.disposeSubscriptions();
            this.bindClient(device);
            this.hooks.connection("SYNCHRONIZING");
            this.hooks.sdkState("Requesting Meshtastic configuration");
            await timeout(Promise.resolve(device.configure()), CONNECT_ACK_TIMEOUT_MS, "The radio did not acknowledge the initial configuration request.");
            await this.waitUntilConfigured(SYNC_TIMEOUT_MS);
            if (generation !== this.generation)
                return;
            this.recovering = false;
            this.reconnectAttempt = 0;
            this.configured = true;
            this.sync.phase = "configured";
            this.publishProgress();
            this.hooks.connection("CONNECTED");
            this.hooks.sdkState("Device configured and ready");
            this.hooks.radio({ connectedAt: now() });
            this.hooks.diagnostics({ connectedAt: now(), reconnectAttempt: 0, nextReconnectAt: undefined, lastDisconnectCause: undefined });
            device.setHeartbeatInterval?.(300_000);
        }
        catch (error) {
            const message = errorMessage(error);
            await this.shutdownClient();
            if (!this.transport && this.port && (this.port.readable || this.port.writable)) {
                try {
                    await this.port.close();
                }
                catch { }
            }
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
            }
            else {
                this.hooks.connection("ERROR", message);
                this.hooks.sdkState(`Connection failed: ${message}`);
            }
            throw error;
        }
        finally {
            this.connecting = false;
        }
    }
    bindClient(device) {
        const events = device.events;
        const sub = (source, fn) => {
            if (!source?.subscribe)
                return;
            try {
                this.disposables.push(source.subscribe(fn));
            }
            catch (error) {
                this.hooks.error("protocol", error);
            }
        };
        sub(events.onDeviceStatus, (status) => {
            const label = Object.entries(STATUS).find(([, value]) => value === status)?.[0] ?? `DeviceStatus ${status}`;
            this.hooks.sdkState(label);
            this.hooks.diagnostics({ stateChangedAt: now(), lastTransportEventAt: now() });
            if (status === STATUS.DeviceConfigured) {
                this.configured = true;
                this.sync.phase = "configured";
                this.publishProgress();
                this.hooks.connection("CONNECTED");
                this.hooks.radio({ connectedAt: now() });
            }
            else if (status === STATUS.DeviceConfiguring || status === STATUS.DeviceConnecting) {
                this.sync.phase = "configuring";
                this.publishProgress();
                this.hooks.connection("SYNCHRONIZING");
            }
            else if (status === STATUS.DeviceConnected) {
                this.hooks.connection("SERIAL_OPEN");
            }
            else if (status === STATUS.DeviceReconnecting) {
                this.hooks.connection("RECONNECTING");
            }
            else if (status === STATUS.DeviceRestarting) {
                this.configured = false;
                this.hooks.connection("RECOVERING", "Radio reported a restart; waiting for reconnection.");
                this.hooks.timeline({ id: crypto.randomUUID(), time: now(), type: "radio restarting", severity: "INFO", source: "RADIO", text: "Connected radio reported a restart.", provenance: "OBSERVED" });
            }
            else if (status === STATUS.DeviceDisconnected) {
                this.configured = false;
                if (this.operatorDisconnect)
                    this.hooks.connection("DISCONNECTED", "Disconnected by operator");
                else
                    void this.beginRecovery("Meshtastic transport disconnected unexpectedly.");
            }
        });
        sub(events.onMyNodeInfo, (info) => {
            const n = Number(info?.myNodeNum ?? info?.nodeNum ?? info?.num);
            if (Number.isFinite(n) && n > 0)
                this.myNodeNum = n;
            this.sync.myInfo = true;
            this.markValidProtocol();
            this.publishProgress();
            this.publishRadio();
        });
        sub(events.onDeviceMetadataPacket, (packet) => {
            this.metadata = packet?.data ?? packet;
            this.sync.metadata = true;
            this.markValidProtocol();
            this.publishProgress();
            this.publishRadio();
        });
        sub(events.onNodeInfoPacket, (node) => {
            if (typeof node?.num !== "number")
                return;
            this.nodeMap.set(node.num, node);
            this.sync.nodes = this.nodeMap.size;
            this.markValidProtocol();
            this.publishProgress();
            this.publishNodes();
            this.publishRadio();
        });
        sub(events.onChannelPacket, (channel) => {
            if (typeof channel?.index !== "number")
                return;
            this.channelMap.set(channel.index, channel);
            this.sync.channels = this.channelMap.size;
            this.markValidProtocol();
            this.publishProgress();
            this.publishChannels();
        });
        sub(events.onConfigPacket, (config) => {
            const key = oneofCase(config) ?? `config${this.sync.config + 1}`;
            this.radioConfig[key] = safeObject(oneofValue(config));
            this.sync.config += 1;
            this.markValidProtocol();
            this.publishProgress();
            this.publishConfig();
            this.publishRadio();
        });
        sub(events.onModuleConfigPacket, (config) => {
            const key = oneofCase(config) ?? `module${this.sync.modules + 1}`;
            this.moduleConfig[key] = safeObject(oneofValue(config));
            this.sync.modules += 1;
            this.markValidProtocol();
            this.publishProgress();
            this.publishConfig();
        });
        sub(events.onMeshPacket, (packet) => {
            try {
                const t = packetTime(packet?.rxTime);
                const decoded = dataPayload(packet);
                const encryptedBytes = encryptedPayload(packet);
                const encrypted = !!encryptedBytes?.length;
                const payload = decoded?.payload instanceof Uint8Array ? decoded.payload : encryptedBytes;
                const fromUs = this.myNodeNum !== undefined && packet?.from === this.myNodeNum;
                const protobuf = this.core?.Protobuf;
                const rec = {
                    id: crypto.randomUUID(), packetId: packet?.id, time: t,
                    direction: fromUs ? "TX" : "RX", source: packet?.from, destination: packet?.to,
                    portNum: decoded ? enumName(protobuf?.Portnums?.PortNum, decoded?.portnum) : encrypted ? "ENCRYPTED" : undefined,
                    channel: packet?.channel, hopLimit: packet?.hopLimit, hopStart: packet?.hopStart, wantAck: packet?.wantAck, encrypted,
                    rssi: typeof packet?.rxRssi === "number" ? packet.rxRssi : undefined, snr: typeof packet?.rxSnr === "number" ? packet.rxSnr : undefined,
                    size: payload?.length, payloadType: decoded ? "decoded" : encrypted ? "encrypted" : undefined,
                    priority: enumName(protobuf?.Mesh?.MeshPacket_Priority, packet?.priority),
                    viaMqtt: packet?.viaMqtt === true || packet?.viaMqtt === 1,
                    pkiEncrypted: packet?.pkiEncrypted === true,
                    nextHop: typeof packet?.nextHop === "number" ? packet.nextHop : undefined,
                    relayNode: typeof packet?.relayNode === "number" ? packet.relayNode : undefined,
                    transport: enumName(protobuf?.Mesh?.MeshPacket_TransportMechanism, packet?.transport),
                    delayed: enumName(protobuf?.Mesh?.MeshPacket_Delayed, packet?.delayed),
                    wantResponse: decoded?.wantResponse,
                    requestId: typeof decoded?.requestId === "number" ? decoded.requestId : undefined,
                    replyId: typeof decoded?.replyId === "number" ? decoded.replyId : undefined,
                    emoji: typeof decoded?.emoji === "number" ? decoded.emoji : undefined,
                    rawHex: payload instanceof Uint8Array ? bytesToHex(payload) : undefined,
                    decoded: decoded ? safeObject(decoded) : undefined,
                    raw: safeObject(packet), provenance: "OBSERVED"
                };
                this.markValidProtocol();
                this.hooks.packet(rec);
                this.hooks.activity(rec.direction);
                this.hooks.radio(rec.direction === "RX" ? { lastRxAt: t } : { lastTxAt: t });
            }
            catch (error) {
                this.hooks.error("decode", error);
            }
        });
        sub(events.onMessagePacket, (packet) => {
            try {
                const direction = packet?.from === this.myNodeNum ? "TX" : "RX";
                const t = packetTime(packet?.rxTime);
                this.markValidProtocol();
                this.hooks.message({ id: crypto.randomUUID(), packetId: packet?.id, time: t,
                    from: Number(packet?.from ?? 0), to: Number(packet?.to ?? 0), channel: Number(packet?.channel ?? 0), type: packet?.type === "direct" ? "direct" : "broadcast",
                    text: String(packet?.data ?? ""), state: direction === "RX" ? "RECEIVED" : "UNKNOWN", direction, attempts: 1 });
                this.hooks.timeline({ id: crypto.randomUUID(), time: t, type: `message ${direction === "RX" ? "received" : "sent"}`, severity: "INFO",
                    nodeNum: direction === "RX" ? packet?.from : packet?.to, text: String(packet?.data ?? ""), provenance: "OBSERVED" });
            }
            catch (error) {
                this.hooks.error("decode", error);
            }
        });
        sub(events.onRoutingPacket, (packet) => {
            try {
                const routing = packet?.data ?? {};
                const variantCode = routing?.variant?.case === "errorReason" ? routing.variant.value : undefined;
                const rawCode = routing?.errorReason ?? variantCode;
                if (rawCode === undefined)
                    return;
                const code = Number(rawCode);
                const state = code === 0 ? "ACKNOWLEDGED" : "FAILED";
                const reason = code === 0 ? undefined : `Meshtastic routing error ${enumName(this.core?.Protobuf?.Mesh?.Routing_Error, code) ?? code}`;
                this.markValidProtocol();
                this.hooks.messageState(Number(packet?.id), state, reason);
            }
            catch (error) {
                this.hooks.error("decode", error);
            }
        });
        sub(events.onTelemetryPacket, (packet) => {
            try {
                const telemetry = packet?.data ?? {};
                const variant = telemetry?.variant;
                const kind = variant?.case ?? "telemetry";
                const values = variant?.value ?? telemetry;
                this.markValidProtocol();
                this.hooks.telemetry({ id: crypto.randomUUID(), nodeNum: Number(packet?.from ?? 0), time: packetTime(packet?.rxTime),
                    kind, values: safeObject(values), provenance: "OBSERVED" });
            }
            catch (error) {
                this.hooks.error("decode", error);
            }
        });
        sub(events.onPositionPacket, (packet) => {
            try {
                const pos = packet?.data ?? {};
                this.markValidProtocol();
                this.hooks.position({ id: crypto.randomUUID(), nodeNum: Number(packet?.from ?? 0), time: packetTime(packet?.rxTime),
                    latitude: latitude(pos), longitude: longitude(pos), altitude: pos?.altitude, precisionBits: pos?.precisionBits, provenance: "OBSERVED" });
            }
            catch (error) {
                this.hooks.error("decode", error);
            }
        });
        sub(events.onDeviceDebugLog, (line) => {
            this.markValidProtocol();
            let text;
            try {
                text = line instanceof Uint8Array ? new TextDecoder().decode(line) : String(line);
            }
            catch {
                text = String(line);
            }
            this.hooks.timeline({ id: crypto.randomUUID(), time: now(), type: "device debug", severity: "INFO", source: "RADIO", text, provenance: "OBSERVED" });
        });
    }
    resetSync() {
        this.sync = this.emptyProgress("configuring");
        this.nodeMap.clear();
        this.channelMap.clear();
        this.radioConfig = {};
        this.moduleConfig = {};
        this.metadata = undefined;
        this.publishProgress();
    }
    publishProgress() { this.hooks.progress({ ...this.sync }); }
    publishNodes() {
        const protobuf = this.core?.Protobuf;
        const normalized = [...this.nodeMap.values()].map((node) => {
            const user = node?.user;
            const dm = node?.deviceMetrics;
            return {
                num: node.num,
                id: user?.id || nodeId(node.num),
                longName: user?.longName || user?.id || nodeId(node.num),
                shortName: user?.shortName || "????",
                hardware: enumName(protobuf?.Mesh?.HardwareModel, user?.hwModel),
                role: enumName(protobuf?.Config?.Config_DeviceConfig_Role, user?.role),
                lastHeard: isoFromSeconds(node?.lastHeard),
                battery: typeof dm?.batteryLevel === "number" ? dm.batteryLevel : undefined,
                voltage: typeof dm?.voltage === "number" ? dm.voltage : undefined,
                snr: typeof node?.snr === "number" ? node.snr : undefined,
                hops: typeof node?.hopsAway === "number" ? node.hopsAway : undefined,
                latitude: latitude(node?.position), longitude: longitude(node?.position), altitude: node?.position?.altitude,
                channelUtilization: dm?.channelUtilization, airUtilTx: dm?.airUtilTx,
                favorite: !!node?.isFavorite, ignored: !!node?.isIgnored, provenance: "OBSERVED"
            };
        }).sort((a, b) => a.num - b.num);
        this.hooks.nodes(normalized);
    }
    publishChannels() {
        const protobuf = this.core?.Protobuf;
        const channels = [...this.channelMap.values()].sort((a, b) => a.index - b.index).map((ch) => {
            const settings = ch?.settings ?? {};
            return {
                index: ch.index,
                role: enumName(protobuf?.Channel?.Channel_Role, ch?.role) ?? String(ch?.role ?? "UNKNOWN"),
                name: settings?.name || (ch.index === 0 ? "Primary" : `Channel ${ch.index}`),
                uplinkEnabled: settings?.uplinkEnabled,
                downlinkEnabled: settings?.downlinkEnabled,
                pskConfigured: !!settings?.psk?.length,
                settings: safeObject(settings)
            };
        });
        this.hooks.channels(channels);
    }
    publishConfig() {
        this.hooks.config({ radio: safeObject(this.radioConfig), modules: safeObject(this.moduleConfig) });
    }
    publishRadio() {
        const me = this.myNodeNum !== undefined ? this.nodeMap.get(this.myNodeNum) : undefined;
        const user = me?.user;
        const dm = me?.deviceMetrics;
        const protobuf = this.core?.Protobuf;
        const lora = this.radioConfig.lora ?? this.radioConfig.loRa ?? this.radioConfig.loraConfig;
        const device = this.radioConfig.device ?? this.radioConfig.deviceConfig;
        this.hooks.radio({
            nodeNum: this.myNodeNum,
            longName: user?.longName,
            shortName: user?.shortName,
            hardware: enumName(protobuf?.Mesh?.HardwareModel, user?.hwModel),
            firmware: this.metadata?.firmwareVersion,
            role: enumName(protobuf?.Config?.Config_DeviceConfig_Role, device?.role),
            region: enumName(protobuf?.Config?.Config_LoRaConfig_RegionCode, lora?.region),
            modemPreset: enumName(protobuf?.Config?.Config_LoRaConfig_ModemPreset, lora?.modemPreset),
            txPower: lora?.txPower,
            hopLimit: lora?.hopLimit,
            battery: dm?.batteryLevel,
            voltage: dm?.voltage,
            channelUtilization: dm?.channelUtilization,
            airUtilTx: dm?.airUtilTx,
            pioEnv: this.metadata?.pioEnv
        });
    }
    async beginRecovery(cause) {
        if (this.operatorDisconnect || this.recovering)
            return;
        this.recovering = true;
        this.configured = false;
        this.hooks.connection("RECOVERING", cause);
        this.hooks.sdkState(`Recovering: ${cause}`);
        this.hooks.diagnostics({ disconnectedAt: now(), lastDisconnectCause: cause, lastTransportEventAt: now() });
        await this.shutdownClient();
        if (!this.operatorDisconnect)
            this.scheduleReconnect(cause);
    }
    scheduleReconnect(cause) {
        if (this.operatorDisconnect || this.reconnectTimer)
            return;
        if (this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
            this.recovering = false;
            this.hooks.connection("ERROR", `Automatic reconnect stopped after ${RECONNECT_DELAYS_MS.length} attempts. ${cause}`);
            this.hooks.sdkState("Automatic reconnect exhausted; use RECONNECT after checking USB.");
            return;
        }
        const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt];
        this.reconnectAttempt += 1;
        const next = new Date(Date.now() + delay).toISOString();
        this.hooks.connection("RECOVERING", `${cause} Retrying in ${(delay / 1000).toFixed(delay < 1000 ? 1 : 0)}s.`);
        this.hooks.diagnostics({ reconnectAttempt: this.reconnectAttempt, nextReconnectAt: next, lastDisconnectCause: cause });
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = undefined;
            if (this.operatorDisconnect)
                return;
            void this.openConnection(true, true).catch(() => { });
        }, delay);
    }
    cancelReconnect() {
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.hooks.diagnostics({ nextReconnectAt: undefined });
    }
    async findGrantedPort() {
        const ports = await navigator.serial.getPorts();
        if (!ports.length)
            return undefined;
        if (this.port && ports.includes(this.port))
            return this.port;
        if (this.portInfo?.usbVendorId !== undefined || this.portInfo?.usbProductId !== undefined) {
            const match = ports.find(port => {
                const info = port.getInfo?.() ?? {};
                return (this.portInfo?.usbVendorId === undefined || info.usbVendorId === this.portInfo.usbVendorId) &&
                    (this.portInfo?.usbProductId === undefined || info.usbProductId === this.portInfo.usbProductId);
            });
            if (match)
                return match;
        }
        return ports.length === 1 ? ports[0] : undefined;
    }
    waitUntilConfigured(ms) {
        if (this.configured)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const started = Date.now();
            const timer = window.setInterval(() => {
                if (this.configured) {
                    clearInterval(timer);
                    resolve();
                }
                else if (!this.device) {
                    clearInterval(timer);
                    reject(new Error("Device connection lost during synchronization."));
                }
                else if (Date.now() - started >= ms) {
                    clearInterval(timer);
                    reject(new Error(`Meshtastic synchronization did not complete within ${Math.round(ms / 1000)} seconds.`));
                }
            }, 100);
        });
    }
    markValidProtocol() { this.hooks.diagnostics({ lastValidProtocolAt: now() }); }
    emptyProgress(phase) {
        return { phase, config: 0, modules: 0, channels: 0, nodes: 0, myInfo: false, metadata: false };
    }
    async shutdownClient() {
        const device = this.device;
        const transport = this.transport;
        this.device = undefined;
        this.transport = undefined;
        this.configured = false;
        this.disposeSubscriptions();
        if (device) {
            try {
                await device.disconnect();
            }
            catch {
                try {
                    await transport?.disconnect?.();
                }
                catch { }
            }
        }
        else if (transport) {
            try {
                await transport.disconnect?.();
            }
            catch { }
        }
    }
    disposeSubscriptions() {
        for (const item of this.disposables.splice(0)) {
            try {
                if (typeof item === "function")
                    item();
                else
                    item?.unsubscribe?.();
            }
            catch { /* cleanup must never erase or destabilize application state */ }
        }
    }
    installSerialListeners() {
        if (this.serialListenersInstalled || !("serial" in navigator))
            return;
        this.serialListenersInstalled = true;
        navigator.serial.addEventListener("disconnect", ((event) => {
            const eventPort = event.port;
            if (this.operatorDisconnect)
                return;
            if (!eventPort || !this.port || eventPort === this.port)
                void this.beginRecovery("USB serial device disconnected from the operating system.");
        }));
        navigator.serial.addEventListener("connect", ((event) => {
            if (!this.recovering || this.operatorDisconnect)
                return;
            const eventPort = event.port;
            if (eventPort && this.portMatches(eventPort)) {
                this.port = eventPort;
                this.cancelReconnect();
                this.hooks.connection("RECONNECTING", "USB device reappeared; reconnecting now.");
                void this.openConnection(true, true).catch(() => { });
            }
        }));
    }
    portMatches(port) {
        if (!this.portInfo || (this.portInfo.usbVendorId === undefined && this.portInfo.usbProductId === undefined))
            return port === this.port;
        const info = port.getInfo?.() ?? {};
        return (this.portInfo.usbVendorId === undefined || info.usbVendorId === this.portInfo.usbVendorId) &&
            (this.portInfo.usbProductId === undefined || info.usbProductId === this.portInfo.usbProductId);
    }
}
