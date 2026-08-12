import type { AnalyticsTimeRange, PacketRecord, Project, TelemetryRecord } from "./models";
import { median } from "./utils";

export interface NumericPoint { time: string; value: number; nodeNum?: number; recordId?: string; source?: string; }
export interface AnalyticsStats { samples: number; min?: number; max?: number; mean?: number; median?: number; latest?: number; firstTime?: string; lastTime?: string; }
export interface RfNodeStats { nodeNum: number; samples: number; rssi: AnalyticsStats; snr: AnalyticsStats; latestTime?: string; }
export interface PacketRateBin { start: string; end: string; rx: number; tx: number; total: number; }
export interface TelemetryMetricDescriptor { key: string; label: string; unit: string; decimals: number; group: string; }

const METRIC_META: Record<string, Omit<TelemetryMetricDescriptor,"key">> = {
  batteryLevel:{label:"Battery",unit:"%",decimals:0,group:"DEVICE"}, battery:{label:"Battery",unit:"%",decimals:0,group:"DEVICE"},
  voltage:{label:"Voltage",unit:" V",decimals:2,group:"DEVICE"}, channelUtilization:{label:"Channel utilization",unit:"%",decimals:1,group:"RADIO"},
  airUtilTx:{label:"TX airtime",unit:"%",decimals:1,group:"RADIO"}, uptimeSeconds:{label:"Uptime",unit:" s",decimals:0,group:"DEVICE"},
  temperature:{label:"Temperature",unit:" °C",decimals:1,group:"ENVIRONMENT"}, relativeHumidity:{label:"Relative humidity",unit:"%",decimals:1,group:"ENVIRONMENT"},
  barometricPressure:{label:"Barometric pressure",unit:" hPa",decimals:1,group:"ENVIRONMENT"}, gasResistance:{label:"Gas resistance",unit:" MΩ",decimals:2,group:"ENVIRONMENT"},
  iaq:{label:"IAQ",unit:"",decimals:0,group:"AIR QUALITY"}, distance:{label:"Distance",unit:" mm",decimals:1,group:"ENVIRONMENT"}, lux:{label:"Ambient light",unit:" lx",decimals:1,group:"ENVIRONMENT"},
  windDirection:{label:"Wind direction",unit:"°",decimals:0,group:"ENVIRONMENT"}, windSpeed:{label:"Wind speed",unit:" m/s",decimals:1,group:"ENVIRONMENT"}, windGust:{label:"Wind gust",unit:" m/s",decimals:1,group:"ENVIRONMENT"},
  rainfall1h:{label:"Rainfall 1 h",unit:" mm",decimals:1,group:"ENVIRONMENT"}, rainfall24h:{label:"Rainfall 24 h",unit:" mm",decimals:1,group:"ENVIRONMENT"}, soilMoisture:{label:"Soil moisture",unit:"%",decimals:0,group:"ENVIRONMENT"}, soilTemperature:{label:"Soil temperature",unit:" °C",decimals:1,group:"ENVIRONMENT"},
  pm10Standard:{label:"PM1.0 standard",unit:" µg/m³",decimals:0,group:"AIR QUALITY"}, pm25Standard:{label:"PM2.5 standard",unit:" µg/m³",decimals:0,group:"AIR QUALITY"}, pm100Standard:{label:"PM10 standard",unit:" µg/m³",decimals:0,group:"AIR QUALITY"},
  co2:{label:"CO₂",unit:" ppm",decimals:0,group:"AIR QUALITY"}, pmVocIdx:{label:"VOC index",unit:"",decimals:1,group:"AIR QUALITY"}, pmNoxIdx:{label:"NOx index",unit:"",decimals:1,group:"AIR QUALITY"},
  numPacketsTx:{label:"Packets TX",unit:"",decimals:0,group:"LOCAL STATS"}, numPacketsRx:{label:"Packets RX",unit:"",decimals:0,group:"LOCAL STATS"}, numPacketsRxBad:{label:"Bad RX packets",unit:"",decimals:0,group:"LOCAL STATS"},
  numOnlineNodes:{label:"Online nodes",unit:"",decimals:0,group:"LOCAL STATS"}, numTotalNodes:{label:"Total nodes",unit:"",decimals:0,group:"LOCAL STATS"}, numRxDupe:{label:"Duplicate RX",unit:"",decimals:0,group:"LOCAL STATS"},
  numTxRelay:{label:"Relay TX",unit:"",decimals:0,group:"LOCAL STATS"}, numTxRelayCanceled:{label:"Relay TX canceled",unit:"",decimals:0,group:"LOCAL STATS"}, numTxDropped:{label:"TX queue drops",unit:"",decimals:0,group:"LOCAL STATS"}, noiseFloor:{label:"Noise floor",unit:" dBm",decimals:0,group:"LOCAL STATS"},
  packetsInspected:{label:"Packets inspected",unit:"",decimals:0,group:"TRAFFIC MGMT"}, positionDedupDrops:{label:"Position dedup drops",unit:"",decimals:0,group:"TRAFFIC MGMT"}, nodeinfoCacheHits:{label:"NodeInfo cache hits",unit:"",decimals:0,group:"TRAFFIC MGMT"}, rateLimitDrops:{label:"Rate-limit drops",unit:"",decimals:0,group:"TRAFFIC MGMT"}, unknownPacketDrops:{label:"Unknown packet drops",unit:"",decimals:0,group:"TRAFFIC MGMT"}, hopExhaustedPackets:{label:"Hop-exhausted packets",unit:"",decimals:0,group:"TRAFFIC MGMT"}, routerHopsPreserved:{label:"Router hops preserved",unit:"",decimals:0,group:"TRAFFIC MGMT"},
  heartBpm:{label:"Heart rate",unit:" bpm",decimals:0,group:"HEALTH"}, spO2:{label:"SpO₂",unit:"%",decimals:0,group:"HEALTH"},
  freememBytes:{label:"Free memory",unit:" B",decimals:0,group:"HOST"}, diskfree1Bytes:{label:"Disk free /",unit:" B",decimals:0,group:"HOST"}, load1:{label:"Load 1 min ×100",unit:"",decimals:0,group:"HOST"}, load5:{label:"Load 5 min ×100",unit:"",decimals:0,group:"HOST"}, load15:{label:"Load 15 min ×100",unit:"",decimals:0,group:"HOST"}
};

function camelize(key:string):string { return key.replace(/_([a-z0-9])/g,(_,c)=>String(c).toUpperCase()); }
export function canonicalTelemetryKey(key:string):string { return camelize(key); }
export function metricDescriptor(key:string): TelemetryMetricDescriptor {
  const canonical=canonicalTelemetryKey(key); const meta=METRIC_META[canonical];
  if(meta)return {key:canonical,...meta};
  const label=canonical.replace(/([a-z0-9])([A-Z])/g,"$1 $2").replace(/^./,c=>c.toUpperCase());
  if(/voltage$/i.test(canonical))return {key:canonical,label,unit:" V",decimals:2,group:"POWER"};
  if(/current$/i.test(canonical))return {key:canonical,label,unit:" A",decimals:3,group:"POWER"};
  if(/temperature/i.test(canonical))return {key:canonical,label,unit:" °C",decimals:1,group:"ENVIRONMENT"};
  if(/humidity/i.test(canonical))return {key:canonical,label,unit:"%",decimals:1,group:"ENVIRONMENT"};
  if(/bytes$/i.test(canonical))return {key:canonical,label,unit:" B",decimals:0,group:"HOST"};
  return {key:canonical,label,unit:"",decimals:2,group:"OTHER"};
}

export function rangeStart(range:AnalyticsTimeRange, anchor=Date.now()):number|undefined {
  const ms = range==="1h"?3600000:range==="6h"?21600000:range==="24h"?86400000:range==="7d"?604800000:undefined;
  return ms===undefined?undefined:anchor-ms;
}
export function inRange(time:string, range:AnalyticsTimeRange, anchor=Date.now()):boolean { const start=rangeStart(range,anchor); if(start===undefined)return true; const t=new Date(time).getTime();return Number.isFinite(t)&&t>=start&&t<=anchor; }
export function rangeLabel(range:AnalyticsTimeRange):string { return ({"1h":"LAST HOUR","6h":"LAST 6 HOURS","24h":"LAST 24 HOURS","7d":"LAST 7 DAYS","all":"ALL RETAINED"} as const)[range]; }

export function analyticsStats(points:NumericPoint[]):AnalyticsStats {
  if(!points.length)return {samples:0}; const sorted=[...points].sort((a,b)=>new Date(a.time).getTime()-new Date(b.time).getTime()); const values=sorted.map(p=>p.value);
  return {samples:values.length,min:Math.min(...values),max:Math.max(...values),mean:values.reduce((a,b)=>a+b,0)/values.length,median:median(values),latest:values.at(-1),firstTime:sorted[0]?.time,lastTime:sorted.at(-1)?.time};
}

export function rfPoints(project:Project, metric:"rssi"|"snr", range:AnalyticsTimeRange, nodeNum?:number):NumericPoint[] {
  return project.packets.filter(p=>p.direction==="RX"&&p.source!==undefined&&typeof p[metric]==="number"&&inRange(p.time,range)).filter(p=>nodeNum===undefined||p.source===nodeNum).map(p=>({time:p.time,value:p[metric] as number,nodeNum:p.source,recordId:p.id,source:"PACKET"}));
}
export function rfNodeStats(project:Project, range:AnalyticsTimeRange):RfNodeStats[] {
  const map=new Map<number,{rssi:NumericPoint[];snr:NumericPoint[];times:string[]}>();
  for(const p of project.packets){if(p.direction!=="RX"||p.source===undefined||!inRange(p.time,range))continue;const row=map.get(p.source)??{rssi:[],snr:[],times:[]};if(typeof p.rssi==="number")row.rssi.push({time:p.time,value:p.rssi,nodeNum:p.source,recordId:p.id});if(typeof p.snr==="number")row.snr.push({time:p.time,value:p.snr,nodeNum:p.source,recordId:p.id});row.times.push(p.time);map.set(p.source,row);}
  return [...map.entries()].map(([nodeNum,v])=>({nodeNum,samples:Math.max(v.rssi.length,v.snr.length),rssi:analyticsStats(v.rssi),snr:analyticsStats(v.snr),latestTime:[...v.times].sort().at(-1)})).sort((a,b)=>(b.samples-a.samples));
}

export function packetRateBins(project:Project, range:AnalyticsTimeRange, maxBins=36):PacketRateBin[] {
  let packets=project.packets.filter(p=>inRange(p.time,range)); if(!packets.length)return [];
  const times=packets.map(p=>new Date(p.time).getTime()).filter(Number.isFinite); if(!times.length)return [];
  const end=Math.max(...times,Date.now()); const configuredStart=rangeStart(range,end); const start=configuredStart??Math.min(...times);
  const span=Math.max(60000,end-start); const natural=range==="1h"?5*60000:range==="6h"?30*60000:range==="24h"?2*3600000:range==="7d"?12*3600000:Math.max(60000,Math.ceil(span/maxBins/60000)*60000);
  const bucket=Math.max(60000,natural); const bins=Math.max(1,Math.min(maxBins,Math.ceil(span/bucket))); const actualStart=end-bins*bucket;
  const rows:Array<{start:number;end:number;rx:number;tx:number}>=Array.from({length:bins},(_,i)=>({start:actualStart+i*bucket,end:actualStart+(i+1)*bucket,rx:0,tx:0}));
  for(const p of packets){const t=new Date(p.time).getTime();if(t<actualStart||t>end)continue;const i=Math.min(rows.length-1,Math.floor((t-actualStart)/bucket));const row=rows[i];if(!row)continue;if(p.direction==="RX")row.rx++;else row.tx++;}
  return rows.map(r=>({start:new Date(r.start).toISOString(),end:new Date(r.end).toISOString(),rx:r.rx,tx:r.tx,total:r.rx+r.tx}));
}

function flattenNumeric(value:unknown, prefix="", out:Record<string,number>={}):Record<string,number>{
  if(!value||typeof value!=="object")return out;
  for(const [raw,v] of Object.entries(value as Record<string,unknown>)){
    const key=canonicalTelemetryKey(raw); const path=prefix?`${prefix}.${key}`:key;
    if(typeof v==="number"&&Number.isFinite(v))out[path]=v;
    else if(v&&typeof v==="object"&&!Array.isArray(v)&&!(v instanceof Uint8Array))flattenNumeric(v,path,out);
  } return out;
}
export function telemetryNumericValues(record:TelemetryRecord):Record<string,number>{ return flattenNumeric(record.values); }
export function telemetryMetricKeys(project:Project, range:AnalyticsTimeRange, kind="all", nodeNum?:number):TelemetryMetricDescriptor[]{
  const byKey=new Map<string,TelemetryMetricDescriptor>(); for(const t of project.telemetry){if(!inRange(t.time,range)||kind!=="all"&&t.kind!==kind||nodeNum!==undefined&&t.nodeNum!==nodeNum)continue;for(const path of Object.keys(telemetryNumericValues(t))){const descriptor=metricDescriptor(path.split(".").at(-1)??path);byKey.set(descriptor.key,descriptor);}}
  return [...byKey.values()].sort((a,b)=>a.group.localeCompare(b.group)||a.label.localeCompare(b.label));
}
export function telemetryPoints(project:Project, metricKey:string, range:AnalyticsTimeRange, kind="all", nodeNum?:number):NumericPoint[]{
  const canonical=canonicalTelemetryKey(metricKey); const rows:NumericPoint[]=[];
  for(const t of project.telemetry){if(!inRange(t.time,range)||kind!=="all"&&t.kind!==kind||nodeNum!==undefined&&t.nodeNum!==nodeNum)continue;const values=telemetryNumericValues(t);for(const [path,value] of Object.entries(values)){if(canonicalTelemetryKey(path.split(".").at(-1)??path)===canonical)rows.push({time:t.time,value,nodeNum:t.nodeNum,recordId:t.id,source:t.kind});}}
  return rows.sort((a,b)=>new Date(a.time).getTime()-new Date(b.time).getTime());
}
export function telemetryKinds(project:Project):string[]{return [...new Set(project.telemetry.map(t=>t.kind))].sort();}

export function svgTimeSeries(points:NumericPoint[], label:string, unit:string, decimals=1):string {
  if(!points.length)return `<div class="analytics-empty">No ${label.toLowerCase()} observations in this window.</div>`;
  const W=760,H=210,l=48,r=18,t=22,b=30; const values=points.map(p=>p.value);let min=Math.min(...values),max=Math.max(...values);if(min===max){min-=1;max+=1;}
  const times=points.map(p=>new Date(p.time).getTime());const t0=Math.min(...times),t1=Math.max(...times);const span=Math.max(1,t1-t0);
  const xy=points.map((p,i)=>`${(l+((times[i]!-t0)/span)*(W-l-r)).toFixed(1)},${(H-b-((p.value-min)/(max-min))*(H-t-b)).toFixed(1)}`).join(" ");
  return `<svg class="analytics-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label} over time"><line x1="${l}" y1="${t}" x2="${l}" y2="${H-b}"/><line x1="${l}" y1="${H-b}" x2="${W-r}" y2="${H-b}"/><polyline points="${xy}"/><text x="4" y="${t+4}">${max.toFixed(decimals)}${unit}</text><text x="4" y="${H-b+4}">${min.toFixed(decimals)}${unit}</text><text x="${l}" y="${H-7}">${new Date(t0).toLocaleString()}</text><text x="${W-r}" y="${H-7}" text-anchor="end">${new Date(t1).toLocaleString()}</text></svg>`;
}
export function svgHistogram(values:number[], label:string, unit:string, bins=14, decimals=1):string {
  if(!values.length)return `<div class="analytics-empty">No ${label.toLowerCase()} samples in this window.</div>`;let min=Math.min(...values),max=Math.max(...values);if(min===max){min-=1;max+=1;}const counts=Array.from({length:bins},()=>0);for(const v of values){const i=Math.min(bins-1,Math.floor(((v-min)/(max-min))*bins));counts[i]=(counts[i]??0)+1;}const peak=Math.max(...counts,1);const W=760,H=200,l=48,r=18,t=18,b=32;const bw=(W-l-r)/bins;const bars=counts.map((c,i)=>{const h=(c/peak)*(H-t-b);return `<rect x="${(l+i*bw+1).toFixed(1)}" y="${(H-b-h).toFixed(1)}" width="${Math.max(1,bw-2).toFixed(1)}" height="${h.toFixed(1)}"><title>${c} samples</title></rect>`;}).join("");return `<svg class="analytics-chart histogram" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label} distribution"><line x1="${l}" y1="${H-b}" x2="${W-r}" y2="${H-b}"/>${bars}<text x="${l}" y="${H-8}">${min.toFixed(decimals)}${unit}</text><text x="${W-r}" y="${H-8}" text-anchor="end">${max.toFixed(decimals)}${unit}</text><text x="${l}" y="12">peak bin ${peak}</text></svg>`;}
export function svgPacketRate(bins:PacketRateBin[]):string {if(!bins.length)return '<div class="analytics-empty">No packets in this window.</div>';const W=760,H=210,l=48,r=18,t=20,b=32;const peak=Math.max(...bins.map(x=>x.total),1);const bw=(W-l-r)/bins.length;const bars=bins.map((x,i)=>{const rxh=(x.rx/peak)*(H-t-b),txh=(x.tx/peak)*(H-t-b);return `<g><rect class="rx-bar" x="${(l+i*bw+1).toFixed(1)}" y="${(H-b-rxh).toFixed(1)}" width="${Math.max(1,(bw-3)/2).toFixed(1)}" height="${rxh.toFixed(1)}"><title>RX ${x.rx}</title></rect><rect class="tx-bar" x="${(l+i*bw+1+(bw-3)/2).toFixed(1)}" y="${(H-b-txh).toFixed(1)}" width="${Math.max(1,(bw-3)/2).toFixed(1)}" height="${txh.toFixed(1)}"><title>TX ${x.tx}</title></rect></g>`;}).join("");return `<svg class="analytics-chart packet-rate" viewBox="0 0 ${W} ${H}" role="img" aria-label="Packet activity over time"><line x1="${l}" y1="${H-b}" x2="${W-r}" y2="${H-b}"/>${bars}<text x="4" y="${t+4}">${peak}</text><text x="${l}" y="${H-8}">${new Date(bins[0]!.start).toLocaleString()}</text><text x="${W-r}" y="${H-8}" text-anchor="end">${new Date(bins.at(-1)!.end).toLocaleString()}</text></svg>`;}
