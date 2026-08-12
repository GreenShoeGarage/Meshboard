# MESHBOARD v0.5.0 — Packet Laboratory Acceptance Test Plan

Use a stock-firmware Meshtastic device and a Chromium browser with Web Serial.

## 1. Basic capture

1. Connect and synchronize the radio.
2. Open Advanced Mode → PACKETS.
3. Generate received and transmitted traffic.
4. Verify new rows show timestamp, direction, endpoint, PortNum, channel, packet ID, hop fields, RSSI/SNR where supplied, and payload size.
5. Confirm no project data is cleared after disconnect/reconnect.

## 2. RX/TX and PortNum filters

- Select RX only; verify TX rows disappear.
- Select TX only; verify RX rows disappear.
- Select each observed PortNum.
- Click a PortNum summary tile and verify it applies the same filter.
- Clear filters and verify the complete retained set returns.

## 3. Endpoint/channel filters

- Filter by a known source numeric node ID.
- Filter by a source short/long name fragment.
- Filter destination.
- Filter channel.
- Use NODES → VIEW PACKETS and verify MESHBOARD opens Packet Laboratory with the selected node as the source filter.

## 4. ACK and payload-state filters

- Generate traffic with `wantAck=true` and without ACK request where possible.
- Verify ACK REQUESTED means the packet's `wantAck` flag; do not interpret it as read receipt.
- Verify decoded/decrypted-payload filtering.
- If an opaque encrypted payload is observed, verify it appears under encrypted-payload filtering and does not show fabricated decoded content.
- If PKI traffic is available, verify the PKI filter.

## 5. Time filters

Verify retained-history, 5-minute, 1-hour, and 24-hour windows against known packet timestamps.

## 6. Pause live

1. Note the newest visible packet.
2. Press PAUSE LIVE.
3. Generate at least five new packets.
4. Verify visible rows remain bounded by the pause timestamp.
5. Verify the new-packet counter increases.
6. Verify the project packet count / RX/TX activity continues changing.
7. Press RESUME LIVE.
8. Verify packets recorded during pause appear.

## 7. Summary inspector

Check a packet with rich metadata and verify fields are not invented when absent. Confirm source/destination fields are not labeled as direct RF adjacency.

## 8. Decoded inspector

- Select a decoded TEXT_MESSAGE_APP or telemetry packet.
- Verify the Data object is visible.
- Select an opaque encrypted packet and verify the decoded tab reports no decoded payload retained.

## 9. Raw inspector

- Verify payload hex has byte offsets.
- Compare retained payload bytes against known SDK packet payload if available.
- Verify UI states that this is not the original `0x94 C3` serial frame.
- Copy payload hex and paste into a local text editor.

## 10. Provenance inspector

Verify it identifies:

- observed record class
- capture timestamp
- MeshClient/onMeshPacket capture path
- RX-only RSSI/SNR interpretation
- topology limitation
- raw serial-framing limitation

## 11. Related records

- Open a text-message packet and verify its linked MessageRecord appears.
- Navigate from packet → message → packet.
- Exercise request/reply IDs if available and confirm only matching IDs correlate.

## 12. Exports

- Export selected packet JSON.
- Export filtered packet CSV.
- Export all packet CSV.
- Confirm sensitive channel key material is not added by these export paths.

## 13. Persistence

1. Configure several packet filters.
2. Reload the browser.
3. Verify packet filters and inspector tab restore from the project.
4. Confirm live-pause state itself is not treated as a persistent project observation.

## 14. Regression

Repeat core v0.2-v0.4 checks:

- USB unplug/replug
- ESP32 reset
- direct and channel message send
- outbound ACK/failure state
- NodeDB refresh
- node history collection
- saved node views
- JSON project export/import
