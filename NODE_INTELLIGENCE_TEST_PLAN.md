# MESHBOARD v0.4.0 — Node Intelligence Acceptance Test Plan

Use a stock Meshtastic radio when possible. The built-in demo project can exercise UI-only tests.

| ID | Test | Expected result |
|---|---|---|
| N-01 | Load demo project | 14 synthetic nodes appear and HISTORY count is nonzero |
| N-02 | Search node identity | Inventory filters immediately by long/short name or node ID |
| N-03 | Search field data | Search for a demo antenna/location/purpose and matching node remains |
| N-04 | Status filter | ACTIVE/RECENT/STALE/LOST filters show only matching node ages |
| N-05 | Role filter | Role selector limits inventory to that radio-reported role |
| N-06 | Hardware filter | Hardware selector limits inventory correctly |
| N-07 | Favorite filter | Favorite-only uses radio-reported favorite state and does not mutate the radio |
| N-08 | Sort columns | Clicking a header sorts; second click reverses direction |
| N-09 | Hide/show columns | Column picker updates table and survives reload |
| N-10 | Resize column | Drag header divider; width persists after reload |
| N-11 | Save view | Filters/sort/columns/widths persist as a named saved view |
| N-12 | Restore view | Change table state, reselect saved view, and verify saved state returns |
| N-13 | Delete view | Saved view disappears without changing node records |
| N-14 | Edit field metadata | Purpose/owner/location/antenna/notes persist after reload |
| N-15 | Provenance boundary | Local field data is visually distinguished from observed radio data |
| N-16 | RSSI history | Selected node shows packet-associated RSSI history when samples exist |
| N-17 | SNR history | Selected node shows packet-associated SNR history when samples exist |
| N-18 | Battery history | Telemetry-capable node shows battery history |
| N-19 | Voltage history | Telemetry-capable node shows voltage history |
| N-20 | Recent observations | Inspector lists time/source and available metrics in descending time order |
| N-21 | Message node | Node inspector opens that peer's direct conversation |
| N-22 | View packets | Node inspector opens PACKETS filtered to that node number |
| N-23 | Capture evidence | Node-state evidence record is created with recent packet references |
| N-24 | Node CSV | Export contains status, current metrics, history statistics, and field metadata |
| N-25 | Threshold settings | Changing active/recent/lost thresholds immediately changes freshness states |
| N-26 | Retention setting | Lowering observation retention trims oldest history without deleting current nodes/metadata |
| N-27 | Schema v2 migration | Import/load a v0.3 project; messages survive and node history is backfilled where source data exists |
| N-28 | Legacy note migration | v0.3 `NodeRecord.notes` appears in v0.4 operator notes |
| N-29 | Reconnect | Disconnect/reconnect radio; local field metadata and saved views remain intact |
| N-30 | Long session | Accumulate substantial packet history and verify node table/inspector remain usable |

## Engineering interpretation checks

Confirm the UI never describes node freshness as RF health and never describes packet-associated RSSI/SNR as a symmetric link measurement.
