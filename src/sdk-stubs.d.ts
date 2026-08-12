declare module "@meshtastic/sdk" {
  export enum DeviceStatusEnum { DeviceRestarting=1, DeviceDisconnected=2, DeviceConnecting=3, DeviceReconnecting=4, DeviceConnected=5, DeviceConfiguring=6, DeviceConfigured=7, DeviceError=8 }
  export enum ChannelNumber { Primary=0, Channel1=1, Channel2=2, Channel3=3, Channel4=4, Channel5=5, Channel6=6, Admin=7 }
  type Signal<T=any> = { value:T; subscribe(fn:(value:T)=>void): any };
  type Dispatcher<T=any> = { subscribe(fn:(value:T)=>void): any };
  export class MeshClient {
    constructor(options:{transport:any});
    transport:{disconnect():Promise<void>};
    myNodeNum:number;
    connect():Promise<void>; configure():Promise<any>; disconnect():Promise<void>; setHeartbeatInterval(ms:number):void;
    device:{status:Signal<DeviceStatusEnum>;myNodeNum:Signal<number|undefined>;myNodeInfo:Signal<any>;metadata:Signal<any>};
    progress:Signal<any>;
    nodes:{list:Signal<readonly any[]>;byNum(n:number):any};
    channels:{list:Signal<readonly any[]>};
    config:{radio:Signal<any>;modules:Signal<any>};
    chat:{send(input:any):Promise<{status:"ok";value:number}|{status:"error";error:Error}>};
    events:{onMeshPacket:Dispatcher;onMessagePacket:Dispatcher;onRoutingPacket:Dispatcher;onTelemetryPacket:Dispatcher;onPositionPacket:Dispatcher;onDeviceDebugLog:Dispatcher;onRebooted:Dispatcher};
  }
  export const Protobuf:any;
}
declare module "@meshtastic/transport-web-serial" {
  export class TransportWebSerial {
    static createFromPort(port:SerialPort, baudRate?:number):Promise<{status:"ok";value:{disconnect():Promise<void>}}|{status:"error";error:Error}>;
  }
}
