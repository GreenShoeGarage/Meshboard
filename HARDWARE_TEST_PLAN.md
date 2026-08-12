# MESHBOARD v0.6.0 — Hardware Reliability Regression Test Plan

Use a stock Meshtastic radio and Chromium browser over HTTPS/localhost.

| ID | Test | Expected result |
|---|---|---|
| R-01 | Normal USB connect | CONNECTING → SERIAL_OPEN → SYNCHRONIZING → CONNECTED |
| R-02 | Observe sync | Node/channel/config/module counters increase and phase reaches configured |
| R-03 | UI disconnect | State becomes DISCONNECTED; no automatic reconnect; project remains intact |
| R-04 | Manual reconnect | Already granted radio reopens without project loss and re-synchronizes |
| R-05 | USB unplug while connected | State becomes RECOVERING; disconnect cause is recorded |
| R-06 | USB replug | Matching device is reopened automatically and returns to CONNECTED |
| R-07 | ESP32 reset/reboot | MESHBOARD records reboot and resynchronizes; if transport drops, reconnect path recovers |
| R-08 | Busy port | User receives actionable in-use/busy error; project data remains intact |
| R-09 | Failed sync | After timeout MESHBOARD enters ERROR or recovery path without blank UI/data loss |
| R-10 | Reconnect exhaustion | After eight attempts, retries stop and an actionable ERROR remains |
| R-11 | Stop recovery | Clicking connection control during RECOVERING cancels retries and enters DISCONNECTED |
| R-12 | Browser refresh | Saved project reloads; stale connection state is not treated as live |
| R-13 | Diagnostic export | JSON includes state, reason, VID/PID, sync counters, retry data, error counts |
| R-14 | Repeated cycles | Ten connect/disconnect cycles do not duplicate handlers or multiply packet events |
| R-15 | Long session | ≥2 hour connection remains stable; heartbeat/reception continue without UI failure |

Record radio model, firmware version, browser version, OS, USB bridge chipset if known, and results for every test.


## v0.4 Node Intelligence regression

During R-15, also verify that node-observation history grows without duplicate event multiplication and that local node metadata/saved views survive reconnect cycles.


## v0.5 Packet Laboratory regression

During reconnect/reboot testing, keep PACKETS open and verify that packet capture resumes without duplicate SDK subscriptions. Test PAUSE LIVE across an unplug/replug: the displayed pause boundary should remain stable until the operator resumes, while newly captured packets accumulate after recovery.
