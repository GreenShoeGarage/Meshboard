# MESHBOARD v0.6.0 — Release Notes

## Batch 5: RF & Telemetry Analytics

MESHBOARD v0.6.0 turns retained packet and telemetry observations into time-windowed engineering analytics while preserving the evidence-first rules established in earlier releases.

### RF analytics

- selectable 1 hour / 6 hour / 24 hour / 7 day / all-retained windows
- optional per-node RF scope
- RSSI distribution histogram
- SNR distribution histogram
- min / max / mean / median / latest statistics
- median-RSSI node ranking with sample counts
- strongest and lowest median-RSSI summaries
- RX/TX packet-activity timeline
- connected-radio channel-utilization timeline
- connected-radio TX-airtime timeline
- RF analytics CSV export
- RF summary → Evidence record

RSSI and SNR remain packet-associated receive observations. MESHBOARD does not convert them into claims of symmetric link quality, packet-delivery ratio, path loss, or a universal RF health score.

### Telemetry analytics

The TELEMETRY workspace now dynamically analyzes numeric fields reported by retained Meshtastic telemetry variants rather than assuming only battery/voltage telemetry.

Supported dynamically when present:

- DeviceMetrics
- EnvironmentMetrics
- AirQualityMetrics
- PowerMetrics
- LocalStats
- HealthMetrics
- HostMetrics
- TrafficManagementStats

Features include:

- time-window selector
- node selector
- telemetry-variant selector
- numeric-metric selector
- latest / mean / median / min / max
- time-series plot
- distribution histogram
- observed telemetry catalog
- latest record by node + telemetry type
- analytics CSV export
- telemetry summary → Evidence record

Missing observations are never interpolated.

### Data model

Project schema advances from v4 to **v5** and adds persistent RF/telemetry analysis state. Older projects normalize forward automatically.

### Demo project

Demo mode now includes synthetic:

- extended device metrics
- environmental telemetry
- air-quality telemetry
- power telemetry
- local mesh statistics
- traffic-management statistics
- longer packet/RF histories

All demo values remain explicitly synthetic.

### Reporting / diagnostics

- printable report now includes selected RF analytics
- printable report now includes selected telemetry metric analytics
- diagnostic bundle records current analytics selections and observed telemetry types

### Validation

`npm run check` passes the local version-consistency and TypeScript checks.

The production Vite bundle cannot be completed in the current build environment because Vite dependencies are not installed locally. On a networked development machine run:

```bash
pnpm install
pnpm build
```
