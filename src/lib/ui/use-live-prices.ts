"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { binanceDirectFeedSize, binanceStreamUrl, parseBinanceDirectFrame } from "./binance-direct-feed.ts";
import { COINBASE_WS_URL, directFeedSize, directFeedSubscribeMessage, parseDirectFeedFrame } from "./coinbase-direct-feed.ts";
import {
  DIRECT_FEED_RESTAMP_MS,
  LIVE_PRICE_POLL_ALL_FEEDS_MS,
  LIVE_PRICE_POLL_MS,
  mergeLivePrices,
  restampEntries,
  type LivePriceEntry,
  type LivePriceResponse,
} from "./live-prices.ts";

/** How long a new connection may stay silent before it counts as failed (blocked, geo-fenced, or dead). */
const FEED_FIRST_DATA_MS = 10_000;
/** A feed counts as healthy while its newest frame is younger than this. */
const FEED_HEALTHY_MS = 20_000;
/** Direct-feed prices are pushed into React state at most this often, however fast frames arrive. */
const FEED_FLUSH_MS = 1_000;
const FEED_RECONNECT_BASE_MS = 2_000;
const FEED_RECONNECT_MAX_MS = 30_000;
/** Consecutive failed connection attempts before a feed gives up until the tab is shown again. */
const FEED_MAX_FAILURES = 4;

/** One exchange's WebSocket: where to connect, what (if anything) to send, and how to read a frame. */
type FeedSpec = {
  name: "coinbase" | "binance";
  url: () => string;
  subscribe?: () => string;
  parse: (raw: string, at: number) => Record<string, LivePriceEntry>;
};

/**
 * Every feed is configured the same way and runs through the same connection logic below. Coinbase covers the
 * tokens it lists; Binance covers the rest (a feed with nothing to cover is not opened). With `tokenIds` (a token
 * profile page) each feed subscribes only to what those tokens need, so a profile opens one tiny connection.
 */
function activeFeeds(tokenIds?: string[]): FeedSpec[] {
  const feeds: FeedSpec[] = [];
  if (directFeedSize(tokenIds) > 0) {
    feeds.push({ name: "coinbase", url: () => COINBASE_WS_URL, subscribe: () => directFeedSubscribeMessage(tokenIds), parse: parseDirectFeedFrame });
  }
  if (binanceDirectFeedSize(tokenIds) > 0) {
    feeds.push({ name: "binance", url: () => binanceStreamUrl(tokenIds), parse: parseBinanceDirectFrame });
  }
  return feeds;
}

type Connection = {
  spec: FeedSpec;
  socket: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  silenceTimer: ReturnType<typeof setTimeout> | undefined;
  failures: number;
  lastFrameAt: number;
};

/**
 * Live prices for the dashboard: polls the app's /api/live-prices route while the tab is visible and also
 * streams prices straight from Coinbase's and Binance's public WebSockets.
 *
 * Deliberate behaviours:
 *
 * - Polling stops when the tab is hidden and resumes (with an immediate fetch) on
 *   return. A dashboard left open on a second monitor is the worst case for
 *   request count, and this removes it: background tabs cost nothing. The direct
 *   connections are closed while hidden for the same reason.
 * - The direct feeds are only ever an addition. While every feed is delivering frames the poll slows to
 *   LIVE_PRICE_POLL_ALL_FEEDS_MS (it still supplies last-known prices for pairs that have not traded since the
 *   connection opened); the moment any feed is blocked, silent or drops, the poll returns to LIVE_PRICE_POLL_MS,
 *   so a viewer where an exchange is geo-blocked sees what they saw before.
 * - A failed poll keeps the last good payload rather than clearing it, so a blip
 *   leaves the displayed price slightly stale instead of making it disappear. If
 *   failures persist the payload ages out of LIVE_PRICE_MAX_AGE_MS and
 *   applyLivePrices falls back to the server-rendered value on its own.
 * - Consecutive failures back the interval off (doubling, capped) so a broken
 *   endpoint is not hammered every 7 seconds by every open tab.
 * - The in-flight request is aborted on unmount and before each new poll, so a
 *   slow response cannot land after the component is gone or overwrite a newer one.
 * - Frames are accumulated outside React and flushed once a second, so a busy market cannot
 *   re-render the dashboard dozens of times a second. A feed only sends a price when it changes, so while a
 *   feed is healthy its entries are re-confirmed every DIRECT_FEED_RESTAMP_MS rather than aging out when a
 *   token is quiet.
 *
 * Returns null until the first successful poll or frame, which is the signal to keep using
 * the server-rendered values.
 */
export function useLivePrices(
  url: string | null,
  intervalMs: number = LIVE_PRICE_POLL_MS,
  options: { directFeed?: boolean; tokenIds?: string[] } = {},
): LivePriceResponse | null {
  const directFeed = options.directFeed ?? true;
  // A stable key rather than the array itself: callers pass a fresh array every render, which must not reconnect.
  const tokenKey = options.tokenIds ? options.tokenIds.join(",") : null;
  const [polled, setPolled] = useState<LivePriceResponse | null>(null);
  const [direct, setDirect] = useState<Record<string, LivePriceEntry> | null>(null);
  const allFeedsHealthyRef = useRef(false);
  const pollNowRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!url) return;
    if (typeof window === "undefined") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let failures = 0;

    const schedule = () => {
      if (cancelled) return;
      // Back off on repeated failure: 1x, 2x, 4x, capped at 8x the base interval. While every direct feed is
      // healthy the poll only fills in pairs that have not traded yet, so its base interval is longer.
      const base = allFeedsHealthyRef.current ? Math.max(intervalMs, LIVE_PRICE_POLL_ALL_FEEDS_MS) : intervalMs;
      const delay = base * Math.min(2 ** failures, 8);
      timer = setTimeout(poll, delay);
    };

    const poll = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        // Not an error: just wait for the tab to come back (see the listener below).
        return;
      }
      controller?.abort();
      controller = new AbortController();
      try {
        const result = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!result.ok) throw new Error(`HTTP ${result.status}`);
        const payload = (await result.json()) as LivePriceResponse;
        if (cancelled) return;
        // Ignore a malformed body rather than feeding it to the overlay.
        if (payload && typeof payload.asOf === "string" && payload.prices && typeof payload.prices === "object") {
          failures = 0;
          setPolled(payload);
        } else {
          failures += 1;
        }
      } catch {
        // Includes the abort on unmount, which schedule() below never sees because
        // cancelled is already true by then.
        if (!cancelled) failures += 1;
      }
      schedule();
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible" || cancelled) return;
      clearTimeout(timer);
      void poll();
    };

    // Lets the feed effect pull the next poll forward the moment the feeds stop all being healthy.
    pollNowRef.current = () => {
      if (cancelled) return;
      clearTimeout(timer);
      void poll();
    };

    void poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      pollNowRef.current = null;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, intervalMs]);

  useEffect(() => {
    if (!url || !directFeed) return;
    if (typeof window === "undefined" || typeof WebSocket === "undefined") return;

    let cancelled = false;
    // Tokens are split between the feeds (Coinbase-listed vs the rest), so one record can hold them all.
    let latest: Record<string, LivePriceEntry> = {};
    let dirty = false;
    let lastRestampAt = 0;
    const connections: Connection[] = activeFeeds(tokenKey === null ? undefined : tokenKey.split(",")).map((spec) => ({
      spec, socket: null, reconnectTimer: undefined, silenceTimer: undefined, failures: 0, lastFrameAt: 0,
    }));

    const closeSocket = (conn: Connection) => {
      clearTimeout(conn.silenceTimer);
      const current = conn.socket;
      conn.socket = null;
      if (!current) return;
      // Detach first: closing on purpose (tab hidden, unmount) is not a failure to retry.
      current.onopen = current.onmessage = current.onerror = current.onclose = null;
      try { current.close(); } catch { /* already closed */ }
    };

    const failed = (conn: Connection) => {
      closeSocket(conn);
      if (cancelled) return;
      conn.failures += 1;
      if (conn.failures >= FEED_MAX_FAILURES) return; // give up until the tab is shown again
      const delay = Math.min(FEED_RECONNECT_BASE_MS * 2 ** (conn.failures - 1), FEED_RECONNECT_MAX_MS);
      conn.reconnectTimer = setTimeout(() => open(conn), delay);
    };

    const open = (conn: Connection) => {
      if (cancelled || document.visibilityState === "hidden") return;
      closeSocket(conn);
      let opened: WebSocket;
      try {
        opened = new WebSocket(conn.spec.url());
      } catch {
        failed(conn);
        return;
      }
      conn.socket = opened;
      let gotData = false;
      // A blocked or geo-fenced connection often never errors; it just never speaks.
      conn.silenceTimer = setTimeout(() => { if (!gotData) failed(conn); }, FEED_FIRST_DATA_MS);
      opened.onopen = () => { if (conn.spec.subscribe) opened.send(conn.spec.subscribe()); };
      opened.onmessage = (event) => {
        const now = Date.now();
        const entries = conn.spec.parse(typeof event.data === "string" ? event.data : "", now);
        if (Object.keys(entries).length === 0) return;
        if (!gotData) {
          gotData = true;
          conn.failures = 0;
          clearTimeout(conn.silenceTimer);
        }
        conn.lastFrameAt = now;
        Object.assign(latest, entries);
        dirty = true;
      };
      opened.onerror = () => { /* onclose follows */ };
      opened.onclose = () => { if (conn.socket === opened) failed(conn); };
    };

    const isHealthy = (conn: Connection, now: number) => conn.lastFrameAt > 0 && now - conn.lastFrameAt < FEED_HEALTHY_MS;

    // One timer flushes frames into React state, re-confirms quiet prices, and tracks feed health.
    const tick = setInterval(() => {
      const now = Date.now();
      const healthy = connections.length > 0 && connections.every((conn) => isHealthy(conn, now));
      let changed = dirty;
      // Re-confirm only while at least one feed is delivering: silence from a live connection means "unchanged",
      // silence from a dead one means "unknown" and must be allowed to age out.
      if (connections.some((conn) => isHealthy(conn, now)) && now - lastRestampAt >= DIRECT_FEED_RESTAMP_MS) {
        lastRestampAt = now;
        latest = restampEntriesForHealthyFeeds(latest, connections, now, isHealthy);
        changed = true;
      }
      if (changed) {
        dirty = false;
        setDirect({ ...latest });
      }
      if (allFeedsHealthyRef.current && !healthy) {
        allFeedsHealthyRef.current = false;
        pollNowRef.current?.(); // fall back to the fast poll immediately
      } else if (!allFeedsHealthyRef.current && healthy) {
        allFeedsHealthyRef.current = true;
      }
    }, FEED_FLUSH_MS);

    const onVisibility = () => {
      if (cancelled) return;
      for (const conn of connections) {
        clearTimeout(conn.reconnectTimer);
        if (document.visibilityState === "hidden") {
          closeSocket(conn);
        } else {
          conn.failures = 0;
          open(conn);
        }
      }
    };

    for (const conn of connections) open(conn);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(tick);
      for (const conn of connections) {
        clearTimeout(conn.reconnectTimer);
        closeSocket(conn);
      }
      allFeedsHealthyRef.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [url, directFeed, tokenKey]);

  return useMemo(() => mergeLivePrices(polled, direct), [polled, direct]);
}

/**
 * Re-stamps the entries that belong to feeds that are currently healthy. An entry's `s` says which exchange quoted
 * it, so a stalled feed's entries are left to age out instead of being falsely re-confirmed.
 */
function restampEntriesForHealthyFeeds(
  latest: Record<string, LivePriceEntry>,
  connections: Connection[],
  now: number,
  isHealthy: (conn: Connection, now: number) => boolean,
): Record<string, LivePriceEntry> {
  const healthySources = new Set(connections.filter((conn) => isHealthy(conn, now)).map((conn) => conn.spec.name));
  const stamp: Record<string, LivePriceEntry> = {};
  const rest: Record<string, LivePriceEntry> = {};
  for (const [id, entry] of Object.entries(latest)) {
    if (entry.s && healthySources.has(entry.s)) stamp[id] = entry;
    else rest[id] = entry;
  }
  return { ...rest, ...restampEntries(stamp, now) };
}
