# MESHBOARD v0.6.0

**Meshtastic Network Field Instrument**

MESHBOARD is a local-first browser front end and engineering console for a stock Meshtastic radio connected over USB. v0.6.0 is the **RF & Telemetry Analytics** release. It retains the radio-reliability, Messaging Workbench, Node Intelligence, and Packet Laboratory layers while adding time-windowed, provenance-backed engineering analysis of retained RF and telemetry observations.

## Architecture

```text
Meshtastic radio
      │ USB
      ▼
Web Serial API
      │
@meshtastic/transport-web-serial
      │
@meshtastic/sdk MeshClient
      │ onMeshPacket
      ▼
MESHBOARD adapter
      │
      ├── PacketRecord history ──► Packet Laboratory
      ├── messages ──────────────► Messaging Workbench
      ├── node observations ─────► Node Intelligence
      └── telemetry / positions
                    │
                    ▼
             IndexedDB project
```

Core protocol handling remains isolated in `src/meshtastic-adapter.ts`. Packet filtering/correlation helpers live in `src/packet-lab.ts`.

## v0.6 RF & Telemetry Analytics

### RF workspace

The RF workspace analyzes retained packet-associated receive measurements over selectable 1 h, 6 h, 24 h, 7 d, or all-retained windows. It provides RSSI/SNR distributions, min/max/mean/median statistics, sample-supported node ranking, RX/TX packet activity, and connected-radio channel-utilization/TX-airtime trends. RF summaries can be exported to CSV or captured as CALCULATED Evidence records tied to their retained packet IDs.

### Telemetry workspace

The telemetry workspace dynamically discovers numeric values across observed Meshtastic telemetry variants and supports node, type, metric, and time-window filtering. It provides latest/min/max/mean/median values, time-series plots, distributions, an observed-field catalog, CSV export, and Evidence summary capture.

Current Meshtastic telemetry families that MESHBOARD can analyze when actually observed include DeviceMetrics, EnvironmentMetrics, AirQualityMetrics, PowerMetrics, LocalStats, HealthMetrics, HostMetrics, and TrafficManagementStats. Missing values are not interpolated or zero-filled.

### Analytics provenance

```text
OBSERVED packet / telemetry records
        ↓
selected time + node/type scope
        ↓
CALCULATED statistics / plots
        ↓
export / evidence / report
```

MESHBOARD deliberately does not generate one opaque RF or mesh-health score. Sample counts, time windows, and source records remain visible.

## v0.5 Packet Laboratory

### Packet capture model

Each packet record can retain, when supplied by the current SDK/protobuf model:

- direction
- source / destination
- channel
- packet ID
- PortNum
- hop limit / hop start
- ACK-request flag
- payload-variant state
- RSSI / SNR
- payload size
- priority
- MQTT-arrival flag
- PKI-encryption flag
- next-hop / relay-node hints
- transport mechanism
- delayed-packet state
- `want_response`
- request ID
- reply ID
- emoji/reaction value
- decoded Data object
- payload bytes as hexadecimal
- SDK packet object
- observation provenance

### Important raw-data boundary

`rawHex` is the payload exposed to MESHBOARD by the Meshtastic SDK. It is **not labeled as the original Web Serial frame**. The `onMeshPacket` event is above transport framing, so MESHBOARD does not claim to retain the serial `0x94 0xC3` frame header or the exact pre-decoding byte stream.

### Advanced filters

The Packet Laboratory supports:

- full-text packet search
- RX / TX
- PortNum
- channel
- source node / ID
- destination node / ID
- ACK requested / not requested
- decoded vs encrypted payload state
- PKI-encrypted packets
- retained-history / 5 minute / 1 hour / 24 hour windows

Filters are stored in the local project.

### PortNum analysis

The live packet set is grouped by PortNum with:

- total packet count
- RX count
- TX count
- retained payload bytes

Clicking a PortNum summary tile applies that filter.

### Live pause

`PAUSE LIVE` freezes the visible packet dataset at a timestamp while capture continues.

```text
PACKET VIEW       paused
PACKET CAPTURE    continues
PROJECT AUTOSAVE  continues
RX/TX COUNTERS    continue
```

The UI reports how many newer packets have arrived while paused. `RESUME LIVE` releases the frozen timestamp.

### Packet inspector

The inspector is divided into:

```text
SUMMARY
DECODED
RAW
PROVENANCE
RELATED
```

**SUMMARY** shows packet-level fields and routing metadata.

**DECODED** shows the SDK-decoded Meshtastic Data object when one was retained.

**RAW** shows retained payload bytes in offset-based hex lines plus the sanitized SDK packet object. It explicitly states the serial-framing limitation.

**PROVENANCE** explains capture path, RF-measurement semantics, topology limitations, and raw-data boundaries.

**RELATED** links messages and packet records that can be correlated through packet, request, or reply IDs.

### Packet evidence/export

From a selected packet:

- export the selected packet as JSON
- copy retained payload hex
- add packet to an Evidence Record
- navigate to linked messages
- navigate to correlated packet records

CSV export is available for either the filtered packet set or all retained packets.

## Project schema v5

v0.6 introduces project schema version 5.

New persistent state includes:

```text
rfTelemetry.timeRange
rfTelemetry.rfNode
rfTelemetry.telemetryNode
rfTelemetry.telemetryKind
rfTelemetry.telemetryMetric
```

The v0.5 Packet Laboratory state remains intact. Projects from v0.1-v0.5 normalize forward without fabricating missing observations.

## v0.4 Node Intelligence retained

- engineering node inventory
- configurable ACTIVE / RECENT / STALE / LOST states
- saved views
- persistent column widths
- node observation history
- RSSI/SNR/battery/voltage plots
- structured local deployment/antenna metadata
- node CSV export
- node-state evidence capture

## v0.3 Messaging Workbench retained

- channel/direct conversations
- unread markers
- persistent drafts
- SENDING / ACKNOWLEDGED / FAILED / RECEIVED states
- retry failed messages
- message search/state filters
- packet evidence links
- message CSV export

## v0.2 Radio Reliability retained

- explicit connection state machine
- synchronization progress
- USB disconnect/reconnect handling
- bounded automatic retry
- reconnect/resync controls
- SDK subscription cleanup
- transport diagnostics
- project preservation across errors

## Build

Prerequisites:

- current Node.js suitable for Vite 8
- pnpm preferred
- Chromium-based browser with Web Serial for live USB operation

```bash
pnpm install
pnpm build
```

Development:

```bash
pnpm dev
```

Serve over HTTPS or localhost for Web Serial.

## Local source check

The source includes lightweight Meshtastic declarations for offline TypeScript validation:

```bash
npm run check
```

A production build must compile against the official packages:

```bash
pnpm install
pnpm build
```

## Demo mode

The synthetic demo project now exercises Packet Laboratory behavior with:

- decoded packet records
- opaque encrypted examples
- PKI-encryption examples
- MQTT-arrival flags
- transport labels
- priority values
- relay-node hints
- ACK-requested packets
- request/reply correlations
- payload hex
- linked message packets
- telemetry and position PortNums

Demo data is explicitly synthetic and must not be interpreted as radio evidence.

## Data boundaries

- Radio identity/configuration/measurements are observed/configured data.
- Packet endpoint fields do not prove direct RF adjacency.
- RSSI/SNR are receive-side packet observations when present.
- `encrypted` describes the retained packet payload variant, not a blanket statement about channel security.
- Payload hex is SDK-exposed payload data, not the original serial frame.
- Local node field metadata is user-entered project data.
- Configuration remains read-only in v0.6.
- The map remains a local plot with no external coordinate upload.
- Core project data remains in browser-local storage unless explicitly exported.

## Acceptance testing

See:

- `RF_TELEMETRY_TEST_PLAN.md`
- `PACKET_LAB_TEST_PLAN.md`
- `NODE_INTELLIGENCE_TEST_PLAN.md`
- `MESSAGING_TEST_PLAN.md`
- `HARDWARE_TEST_PLAN.md`

## License

MESHBOARD v0.6.0 is GPL-3.0-only to remain compatible with the Meshtastic web/SDK packages used by the application.
