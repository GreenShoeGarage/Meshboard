# Changelog

## v0.6.0 — RF & Telemetry Analytics

- added selectable RF/telemetry analysis windows
- added RSSI/SNR distributions and provenance-backed statistics
- added median-RSSI node ranking with sample counts
- added RX/TX packet activity timeline
- added connected-radio channel utilization and TX airtime trends
- added dynamic multi-variant telemetry analytics
- added telemetry catalog, time series, distributions, and statistics
- added RF and telemetry CSV exports
- added RF and telemetry Evidence summary capture
- expanded printable report and diagnostic bundle
- expanded demo telemetry across device/environment/air-quality/power/local-stats/traffic-management variants
- migrated project schema to v5
- bumped app/package/service-worker version to 0.6.0

## v0.5.0 — Packet Laboratory

- moved project schema to v4 with persistent Packet Laboratory filters and inspector tab
- expanded PacketRecord with priority, MQTT, PKI, relay/next-hop, transport, delayed, request/reply, reaction, decoded Data, and payload-hex fields
- added RX/TX, PortNum, channel, source, destination, ACK-request, payload-state, PKI, and time-window filters
- added PortNum counts and retained-byte summaries
- added live-display pause without stopping packet capture/autosave
- added new-packet counter while paused
- added SUMMARY / DECODED / RAW / PROVENANCE / RELATED packet inspector tabs
- added offset-based payload hex view and copy action
- explicitly separated SDK payload bytes from original Web Serial framing
- added message and request/reply packet correlation
- added selected-packet JSON export and filtered packet CSV export
- updated node-to-packet navigation to use a structured source filter
- expanded demo data to cover decoded, encrypted, PKI, MQTT, relay, transport, ACK-request, and request/reply paths
- expanded diagnostics with Packet Laboratory state and PortNum counts
- retained v0.2 radio reliability, v0.3 messaging, and v0.4 Node Intelligence
- bumped app/package/service-worker version to 0.5.0

## v0.4.0 — Node Intelligence

- added schema-v3 node observation history and migration/backfill from retained v0.1-v0.3 data
- added configurable ACTIVE / RECENT / STALE / LOST node freshness thresholds
- added node search across observed identity and local field metadata
- added status, role, hardware, and favorite filters
- added sortable/resizable node columns with persistent visibility and widths
- added named saved node views
- added structured purpose/owner/location/asset/antenna/deployment/operator metadata
- added RSSI, SNR, battery, and voltage history plots
- added recent node observation inspector with provenance source
- added engineering node CSV export with historical statistics and field metadata
- added node-state evidence capture and node-to-message/packet navigation
- added configurable node-history retention and session clearing integration
- expanded demo mode with history, field metadata, and saved views
- updated print report and diagnostics with Node Intelligence data
- retained v0.2 radio reliability and v0.3 messaging behavior
- bumped app/package/service-worker version to 0.4.0

## v0.3.0 — Messaging Workbench

- replaced the flat message stream with channel/direct conversation navigation
- added persistent per-conversation drafts and unread markers
- added message search and delivery-state filtering
- added SENDING / ACKNOWLEDGED / FAILED / RECEIVED / UNKNOWN state model
- added optimistic outbound message records before awaiting the SDK send result
- added failure reasons, attempt counts, and retry action
- added message inspector with packet-evidence linking
- added RSSI/SNR/hop display when a matching packet observation exists
- added message CSV export
- added Ctrl/Command+Enter send shortcut
- moved project schema to v2 with backward normalization
- added demo unread state, saved draft, failed send, and packet-linked messages
- removed duplicate TX activity increment after `chat.send()`
- retained v0.2 radio reliability and reconnect behavior
- bumped app/package/service-worker version to 0.3.0

# MESHBOARD Changelog

## v0.2.0 — Radio Reliability

### Added

- `SERIAL_OPEN`, `RECOVERING`, and `RECONNECTING` connection states
- visible synchronization steps and counters
- connect/synchronization timeouts
- OS-level USB disconnect handling
- automatic reconnect with bounded backoff
- USB returning-device matching by VID/PID when available
- immediate recovery trigger when a matching serial device reappears
- reboot recovery coordinated with the SDK’s built-in resynchronization
- manual RECONNECT control
- richer diagnostics and diagnostic export fields
- last valid protocol activity tracking
- disconnect cause and reconnect-attempt tracking

### Changed

- operator disconnect now explicitly cancels pending automatic recovery
- project-changing operations close any active/configuring client, not only fully configured clients
- connection timeline avoids duplicate CONNECTED/DISCONNECTED entries from repeated SDK emissions
- help/read-only labels updated to v0.2.0
- service-worker cache key bumped to v0.2.0

### Fixed

- cleanup paths now dispose SDK subscriptions before replacing the live client
- sync-wait subscriptions are cleaned on success, error, and timeout
- UI connection toggle now treats connecting/synchronizing/recovering states as active sessions that can be stopped
- duplicate HOME return introduced in the prior source was removed

### Not included

- messaging-workbench expansion (v0.3 roadmap)
- node history/advanced inventory (v0.4 roadmap)
- packet laboratory expansion (v0.5 roadmap)
- configuration writes
- inferred/observed topology graph
