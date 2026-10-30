export class VideoRTC extends HTMLElement {
  mode: string;
  media: string;
  background: boolean;
  visibilityCheck: boolean;
  CODECS: string[];
  video: HTMLVideoElement;
  ws: WebSocket | null;
  wsURL: string;
  wsState: number;
  connectTS: number;
  reconnectTID: number;
  disconnectTID: number;
  src: string;
  onmessage: Record<string, (message: { type: string; value: string }) => void>;
  ondata: ((data: ArrayBuffer) => void) | null;
  oninit(): void;
  onmse(): void;
  onconnect(): boolean;
  ondisconnect(): void;
  onopen(): string[];
  onclose(): boolean;
}
