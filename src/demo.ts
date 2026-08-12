import type { Project, NodeRecord, PacketRecord, MessageRecord, TelemetryRecord, PositionRecord, Finding, TimelineEvent, ChannelRecord, NodeObservation, NodeMetadata, SavedNodeView } from "./models";
import { emptyProject } from "./models";
import { nodeId } from "./utils";

function ago(minutes: number): string { return new Date(Date.now() - minutes * 60_000).toISOString(); }
function n(num: number, longName: string, shortName: string, lat: number, lon: number, opts: Partial<NodeRecord> = {}): NodeRecord {
  return {
    num, id: nodeId(num), longName, shortName, latitude: lat, longitude: lon,
    hardware: "HELTEC_V3", role: "CLIENT", lastHeard: ago(4), battery: 82, voltage: 4.02,
    snr: 5.2, rssi: -92, hops: 1, provenance: "OBSERVED", ...opts
  };
}

export function createDemoProject(): Project {
  const p = emptyProject("MESHBOARD Demo — Ridge Exercise");
  p.demo = true;
  p.description = "Synthetic Meshtastic field exercise data. No values on this project came from a real radio.";
  const base = 0x93ab1201;
  p.nodes = [
    n(base, "BASE CAMP", "BASE", 39.6505, -78.7621, { hardware: "TBEAM", battery: 91, snr: 9.1, rssi: -71, hops: 0 }),
    n(0x93ab1202, "HILLTOP", "HILL", 39.6691, -78.7442, { battery: 64, snr: -8.8, rssi: -116, hops: 2 }),
    n(0x93ab1203, "VEHICLE ONE", "V1", 39.6415, -78.7295, { battery: 76, snr: 2.4, rssi: -101, hops: 1 }),
    n(0x93ab1204, "WEATHER", "WX", 39.6822, -78.7828, { hardware: "RAK4631", battery: 48, snr: 6.7, rssi: -88, role: "SENSOR" }),
    n(0x93ab1205, "TRAIL NORTH", "TN", 39.6993, -78.7512, { battery: 29, snr: -2.1, rssi: -109, hops: 2 }),
    n(0x93ab1206, "RELAY WEST", "RW", 39.6594, -78.8151, { hardware: "TBEAM", role: "ROUTER_CLIENT", battery: 88, snr: 7.5, rssi: -84 }),
    n(0x93ab1207, "TEAM ALPHA", "A", 39.6278, -78.7574, { battery: 55, snr: 1.1, rssi: -104 }),
    n(0x93ab1208, "TEAM BRAVO", "B", 39.6152, -78.7861, { battery: 67, snr: 4.5, rssi: -95 }),
    n(0x93ab1209, "CHECKPOINT", "CP", 39.6753, -78.7068, { battery: 18, snr: -5.3, rssi: -113 }),
    n(0x93ab120a, "PORTABLE 2", "P2", 39.6339, -78.8133, { battery: 72, snr: 3.9, rssi: -98 }),
    n(0x93ab120b, "RIDGE EAST", "RE", 39.6881, -78.6942, { battery: 83, snr: -1.2, rssi: -106, hops: 3 }),
    n(0x93ab120c, "CABIN", "CAB", 39.6208, -78.7214, { battery: 36, snr: 5.9, rssi: -91 }),
    n(0x93ab120d, "OLD NODE", "OLD", 39.6572, -78.7934, { battery: 44, lastHeard: ago(245), snr: -9.6, rssi: -119, hops: 2 }),
    n(0x93ab120e, "SCOUT", "SCT", 39.7035, -78.7992, { battery: 59, lastHeard: ago(41), snr: 0.4, rssi: -108, hops: 2 })
  ];
  p.radio = {
    nodeNum: base, longName: "BASE CAMP", shortName: "BASE", hardware: "TBEAM", firmware: "2.7.x-demo",
    role: "CLIENT", region: "US", modemPreset: "LONG_FAST", txPower: 30, hopLimit: 3, battery: 91,
    voltage: 4.12, channelUtilization: 7.4, airUtilTx: 1.2, connectedAt: ago(83), lastRxAt: ago(1)
  };
  p.channels = [
    { index: 0, role: "PRIMARY", name: "LongFast", uplinkEnabled: false, downlinkEnabled: false, pskConfigured: true },
    { index: 1, role: "SECONDARY", name: "Ops", uplinkEnabled: false, downlinkEnabled: false, pskConfigured: true }
  ] as ChannelRecord[];

  const messages: Array<[number, number, number, string, number]> = [
    [0x93ab1203, 0xffffffff, 0, "Vehicle One checking in.", 71],
    [base, 0xffffffff, 0, "Copy V1. Continue east route.", 65],
    [0x93ab1204, 0xffffffff, 1, "WX: temperature falling, pressure steady.", 58],
    [0x93ab1202, base, 0, "Weak but readable from hilltop.", 45],
    [0x93ab1207, 0xffffffff, 0, "Alpha at checkpoint south.", 29],
    [base, 0xffffffff, 0, "All stations send battery state.", 20],
    [0x93ab1209, base, 0, "CP battery low, 18 percent.", 12],
    [0x93ab1208, 0xffffffff, 0, "Bravo battery 67 percent.", 7]
  ];
  p.messages = messages.map((m, i): MessageRecord => ({
    id: crypto.randomUUID(), packetId: 9000+i, time: ago(m[4]), from: m[0], to: m[1], channel: m[2],
    type: m[1] === 0xffffffff ? "broadcast" : "direct", text: m[3], direction: m[0] === base ? "TX" : "RX",
    state: m[0] === base ? "ACKNOWLEDGED" : "RECEIVED", attempts: 1, acknowledgedAt: m[0] === base ? ago(Math.max(0,m[4]-0.1)) : undefined
  }));
  p.messages.push({ id: crypto.randomUUID(), packetId: 9017, time: ago(5), from: base, to: 0x93ab1202, channel: 0, type: "direct", text: "Hilltop, confirm copy of the route change.", direction: "TX", state: "FAILED", attempts: 2, sentAt: ago(5), failedAt: ago(4.9), failureReason: "Demo routing timeout — synthetic failure for Messaging Workbench testing." });
  p.messaging.lastConversation = "channel:0";
  p.messaging.readAt = { "channel:0": ago(15), "channel:1": ago(120), [`direct:${0x93ab1202}`]: ago(120) };
  p.messaging.drafts = { [`direct:${0x93ab1203}`]: "Copy your current position when able." };

  p.packets = p.messages.filter(m=>m.packetId!==undefined).map((m): PacketRecord => {
    const sourceNode=p.nodes.find(n=>n.num===m.from);
    const bytes=new TextEncoder().encode(m.text);
    return { id: crypto.randomUUID(), packetId:m.packetId, time:m.time, direction:m.direction, source:m.from, destination:m.to, portNum:"TEXT_MESSAGE_APP", channel:m.channel, hopLimit:3, hopStart:3, wantAck:m.direction==="TX", encrypted:false, pkiEncrypted:false, priority:m.direction==="TX"?"RELIABLE":"DEFAULT", transport:"LORA", viaMqtt:false, rssi:m.direction==="RX"?sourceNode?.rssi:undefined, snr:m.direction==="RX"?sourceNode?.snr:undefined, size:bytes.length, payloadType:"decoded", rawHex:Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join(" "), decoded:{portnum:"TEXT_MESSAGE_APP",wantResponse:false,requestId:0,replyId:0,emoji:0,payload:{__type:"Uint8Array",length:bytes.length}}, provenance:"OBSERVED" };
  });
  for (const m of p.messages) { const packet=p.packets.find(x=>x.packetId===m.packetId); if(packet)m.packetRecordId=packet.id; }
  for (let i=0;i<96;i++) {
    const node = p.nodes[1 + (i % (p.nodes.length-1))]!;
    const time = ago(96-i);
    const isEncrypted=i%17===0;
    const portNum=isEncrypted?"ENCRYPTED":i%6===0?"TELEMETRY_APP":i%11===0?"POSITION_APP":"TEXT_MESSAGE_APP";
    const payloadBytes=new TextEncoder().encode(`demo-payload-${i}`);
    p.packets.push({
      id: crypto.randomUUID(), packetId: 12000+i, time, direction: i % 9 === 0 ? "TX" : "RX",
      source: i % 9 === 0 ? base : node.num, destination: 0xffffffff, portNum,
      channel: i % 4 === 0 ? 1 : 0, hopLimit: 3-(i%3), hopStart: 3, wantAck: i % 5 === 0, encrypted: isEncrypted, pkiEncrypted:isEncrypted&&i%34===0,
      viaMqtt:i%23===0, priority:i%5===0?"RELIABLE":"DEFAULT", transport:i%23===0?"MQTT":"LORA", delayed:i%29===0?"DELAYED_BROADCAST":"NO_DELAY",
      wantResponse:!isEncrypted&&i%13===0, requestId:!isEncrypted&&i%19===0?12000+Math.max(0,i-1):undefined, replyId:!isEncrypted&&i%21===0?12000+Math.max(0,i-2):undefined,
      relayNode:i%8===0?0x93ab1206:undefined,
      rssi: i%9===0?undefined:Math.round((node.rssi ?? -100) + Math.sin(i)*4), snr: i%9===0?undefined:Number(((node.snr ?? 0)+Math.cos(i)*1.8).toFixed(1)),
      size: payloadBytes.length, payloadType: isEncrypted?"encrypted":"decoded", rawHex:Array.from(payloadBytes,b=>b.toString(16).padStart(2,"0")).join(" "),
      decoded:isEncrypted?undefined:{portnum:portNum,wantResponse:i%13===0,requestId:i%19===0?12000+Math.max(0,i-1):0,replyId:i%21===0?12000+Math.max(0,i-2):0,payload:{__type:"Uint8Array",length:payloadBytes.length}}, provenance: "OBSERVED"
    } as PacketRecord);
  }

  p.telemetry = [];
  for (const [idx,node] of p.nodes.entries()) {
    for (let k=0;k<8;k++) {
      const battery = Math.max(4, (node.battery ?? 75) - (7-k)*0.35);
      p.telemetry.push({ id: crypto.randomUUID(), nodeNum: node.num, time: ago((7-k)*28 + idx), kind: "deviceMetrics",
        values: { batteryLevel: battery, voltage: (node.voltage ?? 3.9) - (7-k)*0.005, channelUtilization: 3.5+((idx+k)%10)*0.9, airUtilTx: 0.5+((idx+k)%5)*0.35, uptimeSeconds: 21800+k*1680 }, provenance: "OBSERVED" } as TelemetryRecord);
    }
  }
  const weather=0x93ab1204;
  for(let k=0;k<12;k++) p.telemetry.push({id:crypto.randomUUID(),nodeNum:weather,time:ago((11-k)*32+5),kind:"environmentMetrics",values:{temperature:16.8-k*0.08+Math.sin(k)*0.4,relativeHumidity:61+k*0.6,barometricPressure:1014.2-k*0.18,gasResistance:128.5+k*1.3,lux:Math.max(4,680-k*48),windDirection:(235+k*7)%360,windSpeed:2.1+(k%4)*0.35,windGust:3.5+(k%3)*0.6,rainfall1h:k>8?0.4:0,rainfall24h:1.8},provenance:"OBSERVED"} as TelemetryRecord);
  for(let k=0;k<8;k++) p.telemetry.push({id:crypto.randomUUID(),nodeNum:weather,time:ago((7-k)*45+8),kind:"airQualityMetrics",values:{pm10Standard:7+(k%3),pm25Standard:12+(k%5),pm100Standard:18+(k%6),co2:468+k*5,pmVocIdx:72+k*1.8,pmNoxIdx:18+k*0.7,pmTemperature:17.1+k*0.04,pmHumidity:62+k*0.5},provenance:"OBSERVED"} as TelemetryRecord);
  for(let k=0;k<10;k++) p.telemetry.push({id:crypto.randomUUID(),nodeNum:base,time:ago((9-k)*20+3),kind:"localStats",values:{uptimeSeconds:18400+k*1200,channelUtilization:5.2+k*0.45,airUtilTx:0.8+k*0.09,numPacketsTx:410+k*28,numPacketsRx:1220+k*74,numPacketsRxBad:12+k,numOnlineNodes:10+(k%4),numTotalNodes:14,numRxDupe:65+k*7,numTxRelay:18+k*2,numTxRelayCanceled:24+k*3,heapTotalBytes:327680,heapFreeBytes:171000-k*1150,numTxDropped:k>7?k-7:0,noiseFloor:-116+(k%3)},provenance:"OBSERVED"} as TelemetryRecord);
  for(let k=0;k<7;k++) p.telemetry.push({id:crypto.randomUUID(),nodeNum:base,time:ago((6-k)*35+6),kind:"powerMetrics",values:{ch1Voltage:5.05-k*0.006,ch1Current:0.31+k*0.012,ch2Voltage:4.12-k*0.008,ch2Current:0.18+k*0.009},provenance:"OBSERVED"} as TelemetryRecord);
  for(let k=0;k<6;k++) p.telemetry.push({id:crypto.randomUUID(),nodeNum:0x93ab1206,time:ago((5-k)*40+4),kind:"trafficManagementStats",values:{packetsInspected:730+k*96,positionDedupDrops:22+k*3,nodeinfoCacheHits:80+k*5,rateLimitDrops:k>3?k-3:0,unknownPacketDrops:4+k,hopExhaustedPackets:2+k,routerHopsPreserved:40+k*6},provenance:"OBSERVED"} as TelemetryRecord);
  p.positions = p.nodes.filter(x=>x.latitude && x.longitude).map((node, i): PositionRecord => ({
    id: crypto.randomUUID(), nodeNum: node.num, time: ago(i*3+2), latitude: node.latitude, longitude: node.longitude, altitude: 220+i*17, provenance: "OBSERVED"
  }));

  p.findings = [
    { id:"FIND-0001", title:"LOW BATTERY", severity:"HIGH", confidence:"HIGH", nodeNum:0x93ab1209, observedValue:"18%", threshold:"< 20%", firstObserved:ago(35), lastObserved:ago(2), status:"OPEN" },
    { id:"FIND-0002", title:"STALE NODE", severity:"MEDIUM", confidence:"HIGH", nodeNum:0x93ab120d, observedValue:"245 minutes", threshold:"> 180 minutes", firstObserved:ago(70), lastObserved:ago(2), status:"OPEN" },
    { id:"FIND-0003", title:"WEAK RECEIVED SIGNAL", severity:"MEDIUM", confidence:"MEDIUM", nodeNum:0x93ab1202, observedValue:"Median SNR about -8.8 dB", threshold:"< -8 dB", firstObserved:ago(51), lastObserved:ago(3), status:"OPEN" }
  ] as Finding[];
  p.timeline = [
    {id:crypto.randomUUID(),time:ago(83),type:"radio connected",severity:"INFO",source:"DEMO",text:"Demo BASE radio connected.",provenance:"OBSERVED"},
    {id:crypto.randomUUID(),time:ago(71),type:"message received",severity:"INFO",nodeNum:0x93ab1203,text:"Vehicle One checked in.",provenance:"OBSERVED"},
    {id:crypto.randomUUID(),time:ago(35),type:"finding opened",severity:"HIGH",nodeNum:0x93ab1209,text:"Checkpoint battery crossed low-battery threshold.",provenance:"CALCULATED"},
    {id:crypto.randomUUID(),time:ago(18),type:"node stale",severity:"MEDIUM",nodeNum:0x93ab120d,text:"OLD NODE exceeded stale threshold.",provenance:"CALCULATED"}
  ] as TimelineEvent[];
  p.config = { radio: { lora: { region: "US", modemPreset: "LONG_FAST", txPower: 30, hopLimit: 3 }, device: { role: "CLIENT" } }, modules: { telemetry: { deviceUpdateInterval: 900 } } };

  p.nodeMetadata = [
    { nodeNum:base, purpose:"Primary field base", owner:"Operations", location:"Base camp mast", antenna:"915 MHz fiberglass vertical", antennaGainDbi:5.8, antennaHeightM:4.5, assetTag:"MB-BASE-01", deploymentNotes:"Synthetic demo: mast beside operations shelter; USB powered during exercise.", notes:"Reference station for the demo dataset.", updatedAt:ago(2) },
    { nodeNum:0x93ab1202, purpose:"High-ground relay / observer", owner:"Team Hill", location:"Hilltop overlook", antenna:"Compact whip", antennaGainDbi:2.5, antennaHeightM:1.8, assetTag:"MB-HILL-02", deploymentNotes:"Synthetic demo: partially terrain-obstructed from base.", notes:"Weak packet-associated SNR in this demo is intentional for UI testing.", updatedAt:ago(3) },
    { nodeNum:0x93ab1206, purpose:"West relay", owner:"Infrastructure", location:"West ridge", antenna:"915 MHz collinear", antennaGainDbi:5.0, antennaHeightM:3.0, assetTag:"MB-RW-06", updatedAt:ago(10) }
  ] as NodeMetadata[];

  const nodeDbObs: NodeObservation[] = p.nodes.map(node=>({id:crypto.randomUUID(),nodeNum:node.num,time:node.lastHeard||ago(1),kind:"NODEDB",lastHeard:node.lastHeard,battery:node.battery,voltage:node.voltage,rssi:node.rssi,snr:node.snr,hops:node.hops,latitude:node.latitude,longitude:node.longitude,altitude:node.altitude,channelUtilization:node.channelUtilization,airUtilTx:node.airUtilTx,provenance:"OBSERVED"}));
  const packetObs: NodeObservation[] = p.packets.filter(packet=>packet.direction==="RX"&&packet.source!==undefined&&(packet.rssi!==undefined||packet.snr!==undefined)).map(packet=>({id:crypto.randomUUID(),nodeNum:packet.source!,time:packet.time,kind:"PACKET",rssi:packet.rssi,snr:packet.snr,packetRecordId:packet.id,provenance:"OBSERVED"}));
  const telemetryObs: NodeObservation[] = p.telemetry.map(reading=>({id:crypto.randomUUID(),nodeNum:reading.nodeNum,time:reading.time,kind:"TELEMETRY" as const,battery:typeof reading.values.batteryLevel==="number"?reading.values.batteryLevel:undefined,voltage:typeof reading.values.voltage==="number"?reading.values.voltage:undefined,channelUtilization:typeof reading.values.channelUtilization==="number"?reading.values.channelUtilization:undefined,airUtilTx:typeof reading.values.airUtilTx==="number"?reading.values.airUtilTx:undefined,telemetryRecordId:reading.id,provenance:"OBSERVED" as const})).filter(obs=>[obs.battery,obs.voltage,obs.channelUtilization,obs.airUtilTx].some(v=>v!==undefined));
  const positionObs: NodeObservation[] = p.positions.map(position=>({id:crypto.randomUUID(),nodeNum:position.nodeNum,time:position.time,kind:"POSITION",latitude:position.latitude,longitude:position.longitude,altitude:position.altitude,positionRecordId:position.id,provenance:"OBSERVED"}));
  p.nodeObservations=[...nodeDbObs,...packetObs,...telemetryObs,...positionObs].sort((a,b)=>new Date(a.time).getTime()-new Date(b.time).getTime());

  const attentionView: SavedNodeView={id:crypto.randomUUID(),name:"Stale nodes",filter:{search:"",status:"STALE",role:"",hardware:"",favoritesOnly:false,sortBy:"lastHeard",sortDir:"asc"},visibleColumns:["status","node","role","lastHeard","battery","rssi","snr","field"],columnWidths:{node:190,lastHeard:155,field:160},createdAt:ago(1),updatedAt:ago(1)};
  const relayView: SavedNodeView={id:crypto.randomUUID(),name:"Relays / infrastructure",filter:{search:"",status:"all",role:"ROUTER_CLIENT",hardware:"",favoritesOnly:false,sortBy:"node",sortDir:"asc"},visibleColumns:["status","node","hardware","role","lastHeard","battery","rssi","snr","position","field"],columnWidths:{node:190,position:210,field:170},createdAt:ago(1),updatedAt:ago(1)};
  p.nodeTable.savedViews=[attentionView,relayView];
  return p;
}
