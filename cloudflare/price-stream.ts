/**
 * Live-price WebSocket relay, as a Durable Object.
 *
 * EXPERIMENT: Binance's and Coinbase's public REST APIs throttle or block Cloudflare Workers' shared outbound
 * addresses (HTTP 403 / 429). A WebSocket is one long-lived connection instead of a request per poll, and every
 * viewer reads the same in-memory prices, so there is no per-viewer upstream traffic. This class opens one
 * connection per source ("binance" or "coinbase", one Durable Object instance each), keeps the latest price and
 * 24-hour change per symbol, and answers `/ws-prices/<source>` with them.
 *
 * Cost control: the upstream connection is opened lazily by a request and closed after IDLE_CLOSE_MS without one,
 * so an unwatched site holds no connection (a Durable Object with an open outbound WebSocket is billed for its
 * duration while it stays active).
 *
 * The test endpoints report the connection state and the last error, so a block shows up as data rather than silence.
 */
import { binanceSymbols } from "../src/data/binance-token-mappings.ts";
import { coinbaseProducts } from "../src/data/coinbase-token-mappings.ts";

type Source = "binance" | "coinbase";
type Price = { p: number; c: number; at: number };

const IDLE_CLOSE_MS = 120_000;
const ALARM_INTERVAL_MS = 30_000;
/** How long a request waits for the first frames after opening a connection. */
const FIRST_DATA_WAIT_MS = 4_000;

const BINANCE_URL = () =>
  `https://data-stream.binance.vision/stream?streams=${Object.values(binanceSymbols).map((symbol) => `${symbol.toLowerCase()}@miniTicker`).join("/")}`;
const COINBASE_URL = "https://advanced-trade-ws.coinbase.com";

function isSource(value: string): value is Source {
  return value === "binance" || value === "coinbase";
}

export class PriceStream {
  private readonly state: DurableObjectState;
  private source: Source | null = null;
  private socket: WebSocket | null = null;
  private readonly prices = new Map<string, Price>();
  private connectedAt: number | null = null;
  private lastMessageAt: number | null = null;
  private lastError: string | null = null;
  private lastClose: string | null = null;
  private lastRequestAt = 0;
  private messages = 0;
  private opening: Promise<void> | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const segment = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    if (!isSource(segment)) return Response.json({ error: "Unknown source." }, { status: 404 });
    this.source = segment;
    this.lastRequestAt = Date.now();
    await this.ensureAlarm();
    await this.ensureConnected();
    // A freshly opened connection has little or no data yet: give the first frames a moment to arrive
    // (until most of the subscribed symbols have reported, or the wait runs out).
    const expected = this.source === "binance" ? Object.keys(binanceSymbols).length : Object.keys(coinbaseProducts).length;
    const deadline = Date.now() + FIRST_DATA_WAIT_MS;
    while (this.socket && this.prices.size < expected * 0.9 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));

    const now = Date.now();
    const prices: Record<string, { p: number; c: number }> = {};
    let oldest = now;
    for (const [key, price] of this.prices) {
      prices[key] = { p: price.p, c: price.c };
      oldest = Math.min(oldest, price.at);
    }
    return Response.json({
      source: this.source,
      connected: this.socket !== null,
      connectedForMs: this.connectedAt ? now - this.connectedAt : null,
      lastMessageAgoMs: this.lastMessageAt ? now - this.lastMessageAt : null,
      messages: this.messages,
      lastError: this.lastError,
      lastClose: this.lastClose,
      count: this.prices.size,
      asOf: new Date(this.prices.size > 0 ? oldest : now).toISOString(),
      prices,
    }, { headers: { "cache-control": "no-store" } });
  }

  /** Alarm: keep the connection healthy while the site is being watched, close it when it is not. */
  async alarm(): Promise<void> {
    const idle = Date.now() - this.lastRequestAt > IDLE_CLOSE_MS;
    if (idle) {
      this.close("idle");
      return;
    }
    await this.ensureConnected();
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  private close(reason: string): void {
    try { this.socket?.close(1000, reason); } catch { /* already closed */ }
    this.socket = null;
    this.connectedAt = null;
    this.lastClose = reason;
  }

  private ensureConnected(): Promise<void> {
    if (this.socket) return Promise.resolve();
    this.opening ??= this.open().finally(() => { this.opening = null; });
    return this.opening;
  }

  private async open(): Promise<void> {
    if (!this.source) return;
    try {
      const response = await fetch(this.source === "binance" ? BINANCE_URL() : COINBASE_URL, { headers: { Upgrade: "websocket" } });
      const socket = response.webSocket;
      if (!socket) {
        this.lastError = `upgrade refused: HTTP ${response.status}`;
        return;
      }
      socket.accept();
      this.socket = socket;
      this.connectedAt = Date.now();
      this.lastError = null;
      socket.addEventListener("message", (event) => this.onMessage(typeof event.data === "string" ? event.data : ""));
      socket.addEventListener("close", (event) => {
        this.lastClose = `closed ${event.code} ${event.reason}`.trim();
        if (this.socket === socket) { this.socket = null; this.connectedAt = null; }
      });
      socket.addEventListener("error", () => {
        this.lastError = "socket error";
        if (this.socket === socket) { this.socket = null; this.connectedAt = null; }
      });
      if (this.source === "coinbase") {
        socket.send(JSON.stringify({ type: "subscribe", product_ids: Object.values(coinbaseProducts), channel: "ticker" }));
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "connect failed";
    }
  }

  private onMessage(raw: string): void {
    this.messages += 1;
    this.lastMessageAt = Date.now();
    let message: unknown;
    try { message = JSON.parse(raw); } catch { return; }
    if (this.source === "binance") this.onBinance(message);
    else this.onCoinbase(message);
  }

  /** Combined stream frame: {"stream":"btcusdt@miniTicker","data":{"s":"BTCUSDT","c":"last","o":"24h open"}}. */
  private onBinance(message: unknown): void {
    const data = (message as { data?: { s?: string; c?: string; o?: string } })?.data;
    if (!data?.s) return;
    const last = Number(data.c);
    const open = Number(data.o);
    if (!Number.isFinite(last) || last <= 0 || !Number.isFinite(open) || open <= 0) return;
    this.prices.set(data.s, { p: last, c: (last / open - 1) * 100, at: Date.now() });
  }

  /** Advanced Trade ticker: {"channel":"ticker","events":[{"tickers":[{"product_id","price","price_percent_chg_24_h"}]}]}. */
  private onCoinbase(message: unknown): void {
    const body = message as { channel?: string; events?: { tickers?: { product_id?: string; price?: string; price_percent_chg_24_h?: string }[] }[] };
    if (body?.channel !== "ticker") return;
    for (const event of body.events ?? []) {
      for (const ticker of event.tickers ?? []) {
        const price = Number(ticker.price);
        const change = Number(ticker.price_percent_chg_24_h);
        if (!ticker.product_id || !Number.isFinite(price) || price <= 0 || !Number.isFinite(change)) continue;
        this.prices.set(ticker.product_id, { p: price, c: change, at: Date.now() });
      }
    }
  }
}
