import type {
  HostConnectOptions,
  HostConnection,
  HostEvent,
  HostRequest,
  HostResponse,
} from "./host-transport";

type GatewayMessage =
  | ({ type: "connected" } & HostConnection["info"])
  | { type: "connect_error"; message: string }
  | { type: "response"; id: number; result: { Ok: HostResponse | null } | { Err: unknown } }
  | HostEvent;

const HANDSHAKE_TIMEOUT_MS = 25_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export function connectWebHost(
  options: HostConnectOptions,
  onEvent: (event: HostEvent) => void
): Promise<HostConnection> {
  const url = new URL("/api/host", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  const pending = new Map<number, {
    resolve: (value: HostResponse | null) => void;
    reject: (error: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  let nextId = 1;
  let ready = false;
  let closed = false;

  return new Promise<HostConnection>((resolve, reject) => {
    const handshake = setTimeout(() => close("Web connection timed out"), HANDSHAKE_TIMEOUT_MS);

    function close(message: string, verifyLogin = false, requested = false): void {
      if (closed) return;
      closed = true;
      clearTimeout(handshake);
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.reject({ code: "disconnected", message, retryable: true });
      }
      pending.clear();
      socket.close();
      if (!ready) reject(new Error(message));
      else if (!requested) onEvent({ type: "disconnected", payload: { message } });
      if (verifyLogin) {
        void fetch("/api/session", { cache: "no-store" }).then((response) => {
          if (response.status === 401) window.location.reload();
        }).catch(() => {});
      }
    }

    function send(type: "request" | "notify", request: HostRequest): Promise<HostResponse | null> {
      return new Promise((resolveRequest, rejectRequest) => {
        if (socket.readyState !== WebSocket.OPEN || closed) {
          rejectRequest({ code: "disconnected", message: "Web connection closed", retryable: true });
          return;
        }
        if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
          close("Web connection send buffer full");
          rejectRequest({ code: "disconnected", message: "Web connection send buffer full", retryable: true });
          return;
        }
        const id = nextId++;
        socket.send(JSON.stringify({ type, id, request }));
        const timeout = setTimeout(() => close("Execution host request timed out"), REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
      });
    }

    socket.addEventListener("open", () => {
      const host = options.kind === "ssh"
        ? { kind: "ssh", target: options.sshTarget ?? "" }
        : { kind: "local" };
      socket.send(JSON.stringify({ type: "connect", host, name: options.name ?? "yterminal Web" }));
    });
    socket.addEventListener("message", (event) => {
      if (closed) return;
      let message: GatewayMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        close("Invalid response from the Web gateway");
        return;
      }
      switch (message.type) {
        case "connected":
          ready = true;
          clearTimeout(handshake);
          resolve({
            info: { connectionId: message.connectionId, hello: message.hello },
            request: async (request) => {
              const result = await send("request", request);
              if (!result) throw new Error("Missing execution host response");
              return result;
            },
            notify: async (request) => { await send("notify", request); },
            disconnect: async () => { close("disconnected", false, true); },
          });
          break;
        case "connect_error":
        case "disconnected":
          close(message.type === "connect_error" ? message.message : message.payload.message);
          break;
        case "response": {
          const request = pending.get(message.id);
          if (!request) break;
          pending.delete(message.id);
          clearTimeout(request.timeout);
          if ("Ok" in message.result) request.resolve(message.result.Ok);
          else request.reject(message.result.Err);
          break;
        }
        default:
          onEvent(message);
      }
    });
    socket.addEventListener("close", () => close("Web connection closed", !ready));
  });
}
