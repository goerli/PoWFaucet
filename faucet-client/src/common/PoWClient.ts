import { TypedEmitter } from 'tiny-typed-emitter';
import { PromiseDfd } from "../utils/PromiseDfd";
import { IFaucetConfig, IFaucetStatus } from './IFaucetConfig';
import { IPoWMinerVerification } from './PoWMiner';
import { PoWSession } from "./PoWSession";


export interface IPoWClientOptions {
  powApiUrl: string;
}

interface PoWClientEvents {
  'open': () => void;
  'close': () => void;
  'faucetStatus': (faucetStatus: IFaucetStatus) => void;
  'claimTx': (res: any) => void;
}

export class PoWClient extends TypedEmitter<PoWClientEvents> {
  private options: IPoWClientOptions;
  private clientSocket: WebSocket;
  private clientStatus: number = 0;
  private readyDfd: PromiseDfd<void>;
  private requestCounter: number = 1;
  private reconnectTimer: NodeJS.Timeout;
  private requestQueue: {[id: number]: PromiseDfd<any>} = {};
  private currentSession: PoWSession;
  private faucetConfig: IFaucetConfig;

  public constructor(options: IPoWClientOptions) {
    super();
    this.options = options;
    this.startClient();
  }

  public isReady(): boolean {
    return this.clientStatus == 1;
  }

  public getReadyPromise(): Promise<void> {
    if(this.clientStatus == 1)
      return Promise.resolve();
    if(!this.readyDfd)
      this.readyDfd = new PromiseDfd<void>();
    return this.readyDfd.promise;
  }

  public getFaucetConfig(): IFaucetConfig {
    return this.faucetConfig;
  }

  public setCurrentSession(session: PoWSession) {
    this.currentSession = session;
  }

  private startClient() {
    this.clientSocket = new WebSocket(this.options.powApiUrl);
    this.clientSocket.addEventListener("open", (evt) => {
      console.log("[PoWSock] websocket opened");
      
      this.sendRequest<IFaucetConfig>("getConfig").then((faucetConfig) => {
        this.faucetConfig = faucetConfig;
        this.clientStatus = 1;
        this.onClientReady();
      });
    });
    this.clientSocket.addEventListener("close", (evt) => {
      console.log("[PoWSock] websocket closed");
      this.onClientClose();
    });
    this.clientSocket.addEventListener("error", (evt) => {
      console.log("[PoWSock] websocket error", evt);
      this.onClientClose();
    });
    this.clientSocket.addEventListener("message", (evt) => this.onClientMessage(evt));
  }

  private reconnectClient() {
    if(this.reconnectTimer)
      return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startClient();
    }, (5 * 1000) + (1000 * 5 * Math.random()));
  }

  public sendRequest<T = any>(action: string, data?: any): Promise<T> {
    var requestId = this.requestCounter++;
    var reqDfd = this.requestQueue[requestId] = new PromiseDfd<T>();
    var message: any = {
      id: requestId,
      action: action
    };
    if(data !== undefined)
      message.data = data;

    this.clientSocket.send(JSON.stringify(message));

    return reqDfd.promise;
  }

  public sendMessage(action: string, data?: object) {
    var message: any = {
      action: action
    };
    if(data !== undefined)
      message.data = data;

    this.clientSocket.send(JSON.stringify(message));
  }

  private onClientMessage(evt: MessageEvent) {
    var message;
    try {
      message = JSON.parse(evt.data);
    } catch(ex) {
      console.error(ex);
      return;
    }

    if(message.hasOwnProperty("rsp")) {
      var rspId = message.rsp;
      var isOk = (message.action !== "error");
      if(this.requestQueue.hasOwnProperty(rspId)) {
        if(isOk)
          this.requestQueue[rspId].resolve(message.data);
        else
          this.requestQueue[rspId].reject(message.data);
        delete this.requestQueue[rspId];
      }
      return;
    }

    // parse message
    switch(message.action) {
      case "faucetStatus":
        this.emit("faucetStatus", {
          text: message.data.text,
          level: message.data.level,
        });
        break;
      case "sessionKill":
        if(this.currentSession) {
          this.currentSession.processSessionKill(message.data);
        }
        break;
      case "verify":
        if(this.currentSession) {
          this.currentSession.processVerification(message.data);
        }
        break;
      case "updateBalance":
        if(this.currentSession) {
          this.currentSession.updateBalance(message.data);
        }
        break;
      case "claimTx":
        this.emit("claimTx", message.data);
        break;
    }
  }

  private onClientReady() {
    if(this.readyDfd) {
      this.readyDfd.resolve();
      this.readyDfd = null;
    }
    if(this.currentSession) {
      this.currentSession.resumeSession();
    }
    this.emit("open");
  }

  private onClientClose() {
    this.clientSocket = null;
    this.clientStatus = 0;
    this.emit("close");
    this.reconnectClient();
  }
}
