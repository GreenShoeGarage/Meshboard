# MESHBOARD v0.6.0 — RF & Telemetry Analytics Acceptance Test Plan

## 1. RF capture integrity

1. Connect a stock Meshtastic radio.
2. Receive packets from at least three nodes.
3. Confirm RF view sample counts increase only when retained RX packets contain RSSI/SNR.
4. Confirm TX packets do not fabricate RSSI/SNR.
5. Open corresponding packet records and verify RF values match the analytics source observations.

PASS: analytics can be traced back to retained packet records.

## 2. Time windows

Exercise 1 h, 6 h, 24 h, 7 d, and all-retained selections.

PASS: charts/statistics use only records in the selected window and the selection survives reload.

## 3. RF node scope

Select All Nodes, then individual nodes.

PASS: sample counts, distributions, and medians change only with the selected source node; no samples from other nodes are included.

## 4. RSSI / SNR distributions

Use a dataset with varied RF values.

PASS: histogram bounds match retained observations; min/max/median/sample count match independently checked values.

## 5. Node ranking

PASS: ranking is ordered by median RSSI and always displays sample count. Nodes without sufficient RSSI samples do not appear stronger because of missing data.

## 6. Packet activity

Generate RX and TX traffic over multiple intervals.

PASS: activity chart separates RX and TX counts and does not stop recording when another view is open.

## 7. Channel utilization / TX airtime

Receive DeviceMetrics or LocalStats from the connected node.

PASS: RF charts use telemetry belonging to the connected radio node when its node number is known. They do not merge another node's utilization into the local-radio trace.

## 8. Telemetry variants

Exercise as many available variants as hardware supports:

- deviceMetrics
- environmentMetrics
- airQualityMetrics
- powerMetrics
- localStats
- healthMetrics
- hostMetrics
- trafficManagementStats

PASS: each retained variant appears in the telemetry-type selector/catalog when present. Unsupported/unseen variants are not fabricated.

## 9. Dynamic numeric metrics

PASS: numeric fields become selectable metrics; nonnumeric values do not break the analytics view; field units/labels are sensible for known metrics.

## 10. Missing telemetry

Use a node with sparse telemetry and one with no telemetry.

PASS: UI displays no-data states rather than zero-filling or interpolating missing observations.

## 11. CSV exports

Export RF analytics and telemetry analytics.

PASS: timestamps, node identifiers, source records, values, and provenance are present and correspond to the current selections.

## 12. Evidence summaries

Create RF and telemetry evidence records.

PASS: evidence is marked CALCULATED, states the selected time window and sample count, and does not overclaim link symmetry or interpolate missing telemetry.

## 13. Persistence / migration

Open a v0.5 project in v0.6, change analytics selections, reload.

PASS: project normalizes to schema v5 without losing packets, telemetry, messages, node metadata, or Packet Laboratory fields; analytics preferences persist.

## 14. Demo mode

Load demo project.

PASS: multiple telemetry types and RF histories populate the new views and all demo data is visibly synthetic.

## 15. Regression

Repeat core tests from:

- HARDWARE_TEST_PLAN.md
- MESSAGING_TEST_PLAN.md
- NODE_INTELLIGENCE_TEST_PLAN.md
- PACKET_LAB_TEST_PLAN.md

PASS: Batch 5 introduces no regression in connection, messaging, node history, packet capture, persistence, or imports/exports.
