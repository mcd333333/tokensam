"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { DashboardToken } from "@/types/token";
import type { RefreshStatusView } from "@/lib/refresh/freshness";
import {
  DEFAULT_SORT_KEY, EMPTY_FILTERS, PAGE_SIZE, SCOPE_NOTE, filterRows, missingReason, paginateRows, researchColumns, sortRows, toRow, universeSummary,
  type Column, type Filters, type Row, type SortKey,
} from "@/lib/ui/dashboard-model";
import { formatChange, formatRatio, formatShare, formatUsd } from "@/lib/ui/format";
import { TokenLogo } from "@/components/TokenLogo";
import { PageFooter } from "@/components/AppShell";
import { UniverseHero } from "@/components/UniverseHero";
import { applyLivePrices, livePricesUrl } from "@/lib/ui/live-prices";
import { useLivePrices } from "@/lib/ui/use-live-prices";
import { usePriceFlashes } from "@/lib/ui/use-price-flash";
import type { FlashDirection } from "@/lib/ui/price-flash";

type SortState = { key: SortKey; direction: "asc" | "desc" };

function SearchIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" className="search-icon"><circle cx="8.8" cy="8.8" r="5.7" /><path d="m13 13 4 4" /></svg>;
}

function Cell({ row, column, flash }: { row: Row; column: Column; flash?: FlashDirection }) {
  const value = row[column.key];
  if (value === null) {
    const reason = missingReason(column, row.token);
    return <span className="cell-missing" title={`Data unavailable: ${reason}`} aria-label={`Data unavailable: ${reason}`}>—</span>;
  }
  if (column.format === "change") {
    const change = formatChange(value)!;
    return <span className={`tone-${change.tone}`}>{change.text}</span>;
  }
  if (column.format === "ratio") return <>{formatRatio(value)}</>;
  if (column.format === "share") return <>{formatShare(value)}</>;
  const text = formatUsd(value, column.format === "usd-compact");
  // Only the price column flashes. Market cap and FDV also move with the live price, but
  // lighting every one of them at once would wash the row rather than draw the eye.
  if (column.key === "priceUsd" && flash) {
    return <span className={`price-flash price-flash-${flash}`}>{text}</span>;
  }
  return <>{text}</>;
}

function AssetCell({ token }: { token: DashboardToken }) {
  return (
    <Link href={`/tokens/${token.id}`} prefetch={false} className="asset-link" aria-label={`Open ${token.name} profile`}>
      <TokenLogo src={token.logoUrl} symbol={token.symbol} size={28} />
      <span className="asset-copy">
        <span className="asset-name">{token.name}</span>
        <span className="asset-meta"><b>{token.symbol}</b> · {token.chain} <span className="chip chip-quiet">{token.category}</span></span>
      </span>
    </Link>
  );
}

export default function Dashboard({ tokens, error, dataUpdatedAt, refreshStatus, metricsPerAsset }: {
  tokens: DashboardToken[];
  error: string | null;
  dataUpdatedAt: string | null;
  refreshStatus: RefreshStatusView | null;
  /** Size of the standardized calculated-metric set evaluated for every asset. */
  metricsPerAsset: number;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SortState>({ key: DEFAULT_SORT_KEY, direction: "desc" });
  const [page, setPage] = useState(1);

  // Live price and 24h change, polled from the Worker while the tab is visible. Everything
  // else on the row stays as server-rendered; applyLivePrices returns `tokens` unchanged
  // when there is nothing to apply, so a poll that moved no price re-renders nothing.
  const live = useLivePrices(livePricesUrl(process.env.NEXT_PUBLIC_LIVE_PRICES_URL));
  const liveTokens = useMemo(() => applyLivePrices(tokens, live), [tokens, live]);

  const priceFlashes = usePriceFlashes(liveTokens);

  const rows = useMemo(() => liveTokens.map(toRow), [liveTokens]);
  const summary = useMemo(() => universeSummary(liveTokens), [liveTokens]);
  const chains = useMemo(() => [...new Set(tokens.map((token) => token.chain))].sort(), [tokens]);
  const categories = useMemo(() => [...new Set(tokens.map((token) => token.category))].sort(), [tokens]);
  const filtered = useMemo(() => filterRows(rows, filters), [rows, filters]);
  // Recomputed after every filter change: hide a column only when no displayed row has valid data.
  const { visible: columns, hidden } = useMemo(() => researchColumns(filtered), [filtered]);
  const sortKey: SortKey = sort.key === "name" || columns.some((column) => column.key === sort.key) ? sort.key : "name";
  const direction = sortKey === sort.key ? sort.direction : "asc";
  const displayed = useMemo(() => sortRows(filtered, sortKey, direction), [filtered, sortKey, direction]);
  // Filtering and sorting happen first; pagination only slices the resulting list. `page` is clamped
  // (never just bounds-checked), so a page left over from a larger result set self-corrects.
  const pagination = useMemo(() => paginateRows(displayed, page, PAGE_SIZE), [displayed, page]);
  const hasFilters = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  const update = (patch: Partial<Filters>) => { setFilters((current) => ({ ...current, ...patch })); setPage(1); };
  const handleSort = (key: SortKey) => { setSort((current) => current.key === key
    ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
    : { key, direction: key === "name" ? "asc" : "desc" }); setPage(1); };
  const sortOptions: { key: SortKey; label: string }[] = [{ key: "name", label: "Asset" }, ...columns.map((column) => ({ key: column.key, label: column.label }))];
  const breadthTotal = summary.withChange;
  const momentum = formatChange(summary.medianChange24hPct);
  // Tooltip only when some tracked tokens lack the value (they are excluded, not counted as zero).
  const partial = (count: number, what: string) => count < summary.assets ? `${count} of ${summary.assets} tracked assets ${what}; the rest are excluded.` : undefined;

  return (
    <div className="page universe-page">
      <UniverseHero
        assets={summary.assets}
        chains={summary.chains}
        metricsPerAsset={metricsPerAsset}
        updatedAt={dataUpdatedAt}
        refreshStatus={refreshStatus}
        error={error}
      />

      {/* Current market overview of the tracked universe. Missing values are skipped (never zero); partial coverage is in the tooltip. */}
      <section className="summary-strip" aria-label="Market overview">
        <div className="stat" title={partial(summary.marketCapCount, "report a market cap")}>
          <span className="stat-label">Tracked market cap</span>
          <strong>{formatUsd(summary.marketCapUsd, true) ?? "—"}</strong>
          <span className="stat-note">Combined market cap</span>
        </div>
        <div className="stat" title={partial(summary.volumeCount, "report 24H volume")}>
          <span className="stat-label">24H trading volume</span>
          <strong>{formatUsd(summary.volume24hUsd, true) ?? "—"}</strong>
          <span className="stat-note">Across tracked assets</span>
        </div>
        <div className="stat" title={partial(summary.withChange, "report a 24H price change")}>
          <span className="stat-label">24H market breadth</span>
          <strong>
            <span className="tone-positive">{summary.up} ↑</span> <small>·</small> <span className="tone-negative">{summary.down} ↓</span>
            {summary.flat > 0 ? <> <small>· {summary.flat} unchanged</small></> : null}
          </strong>
          <span className="stat-note">of tracked assets</span>
          {breadthTotal > 0 ? (
            <span className="breadth-bar" role="img" aria-label={`${summary.up} advancing, ${summary.down} declining${summary.flat > 0 ? `, ${summary.flat} unchanged` : ""} over 24 hours${summary.assets > summary.withChange ? `; ${summary.assets - summary.withChange} without 24H data` : ""}`}>
              <span className="breadth-up" style={{ width: `${(summary.up / breadthTotal) * 100}%` }} />
              <span className="breadth-down" style={{ width: `${(summary.down / breadthTotal) * 100}%` }} />
            </span>
          ) : null}
        </div>
        <div className="stat" title={partial(summary.withChange, "report a 24H price change")}>
          <span className="stat-label">24H market momentum</span>
          <strong>{momentum ? <span className={`tone-${momentum.tone}`}>{momentum.text}</span> : "—"}</strong>
          <span className="stat-note">Median 24H change</span>
        </div>
      </section>

      <section className="universe" id="research-universe" aria-labelledby="universe-title">
        <div className="universe-head">
          <div>
            <p className="section-kicker">Discover & compare</p>
            <h2 id="universe-title">Research Universe <span className="asset-count">{summary.assets} assets</span></h2>
            <p className="scope-line">{SCOPE_NOTE}</p>
          </div>
          <span className="universe-hint">Select an asset to explore its fundamentals</span>
        </div>

        <div className="filters" aria-label="Search and filters">
          <label className="search-field">
            <SearchIcon />
            <input type="search" placeholder="Search name, symbol, chain…" value={filters.query} onChange={(event) => update({ query: event.target.value })} aria-label="Search tokens by name, symbol, chain, or category" data-testid="token-search" />
          </label>
          <select value={filters.chain} onChange={(event) => update({ chain: event.target.value })} aria-label="Filter by chain" data-testid="chain-filter">
            <option value="all">All chains</option>
            {chains.map((chain) => <option value={chain} key={chain}>{chain}</option>)}
          </select>
          <select value={filters.category} onChange={(event) => update({ category: event.target.value })} aria-label="Filter by category" data-testid="category-filter">
            <option value="all">All categories</option>
            {categories.map((category) => <option value={category} key={category}>{category}</option>)}
          </select>
          <select value={filters.move} onChange={(event) => update({ move: event.target.value as Filters["move"] })} aria-label="Filter by 24-hour move" data-testid="move-filter">
            <option value="all">Any 24h move</option>
            <option value="positive">Up over 24h</option>
            <option value="negative">Down over 24h</option>
          </select>
          <select value={filters.coverage} onChange={(event) => update({ coverage: event.target.value as Filters["coverage"] })} aria-label="Filter by data coverage" data-testid="coverage-filter">
            <option value="all">Any coverage</option>
            <option value="protocol">Has protocol data</option>
            <option value="dex">Has DEX data</option>
          </select>
          <select className="mobile-sort" value={`${sortKey}:${direction}`} onChange={(event) => { const [key, dir] = event.target.value.split(":"); setSort({ key: key as SortKey, direction: dir as "asc" | "desc" }); setPage(1); }} aria-label="Sort tokens">
            {sortOptions.flatMap((option) => [
              <option key={`${option.key}:desc`} value={`${option.key}:desc`}>{option.label} {option.key === "name" ? "Z–A" : "high → low"}</option>,
              <option key={`${option.key}:asc`} value={`${option.key}:asc`}>{option.label} {option.key === "name" ? "A–Z" : "low → high"}</option>,
            ])}
          </select>
          {hasFilters ? <button className="text-button reset" type="button" onClick={() => { setFilters(EMPTY_FILTERS); setPage(1); }}>Reset</button> : null}
        </div>

        <div className="table-meta">
          <span role="status" aria-live="polite" aria-atomic="true">
            {displayed.length > 0
              ? <><b>{(pagination.page - 1) * PAGE_SIZE + 1}–{(pagination.page - 1) * PAGE_SIZE + pagination.items.length}</b> of <b>{displayed.length}</b> assets</>
              : <><b>0</b> assets</>}
          </span>
          <span className="muted-copy"><span className="cell-missing" aria-hidden="true">—</span> Unavailable data · Hover for details</span>
          {hidden.length > 0 && displayed.length > 0 ? <span className="muted-copy">Hidden, no data for these assets: {hidden.map((column) => column.label).join(", ")}</span> : null}
        </div>

        <div className="table-frame">
          <table className="token-table">
            <caption className="visually-hidden">Research Universe: token-level market data for each tracked token. A dash marks data that is unavailable.</caption>
            <thead>
              <tr>
                <th scope="col" className="asset-col" aria-sort={sortKey === "name" ? (direction === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" className="sort-button" onClick={() => handleSort("name")}>Asset<span className={`sort-mark${sortKey === "name" ? " active" : ""}`} aria-hidden="true">{sortKey === "name" ? (direction === "asc" ? "↑" : "↓") : "↕"}</span></button>
                </th>
                {columns.map((column) => {
                  const active = sortKey === column.key;
                  return (
                    <th key={column.key} scope="col" aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"} title={column.hint}>
                      <button type="button" className="sort-button" onClick={() => handleSort(column.key)}>
                        <span className="th-label">{column.label}</span>
                        <span className={`sort-mark${active ? " active" : ""}`} aria-hidden="true">{active ? (direction === "asc" ? "↑" : "↓") : "↕"}</span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {pagination.items.map((row) => (
                <tr key={row.token.id} data-testid="token-row">
                  <td className="asset-col"><AssetCell token={row.token} /></td>
                  {columns.map((column) => (
                    <td key={column.key} data-label={column.label}>
                      <Cell row={row} column={column} flash={priceFlashes[row.token.id]} />
                    </td>
                  ))}
                </tr>
              ))}
              {displayed.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 1} className="empty-state">
                    <strong>{error ? "Live data could not be loaded" : "No assets match these filters"}</strong>
                    <span>{error ? "No demonstration values are shown." : "Try a different search or reset the filters."}</span>
                    {hasFilters ? <button type="button" className="text-button" onClick={() => { setFilters(EMPTY_FILTERS); setPage(1); }}>Clear filters</button> : null}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {displayed.length > 0 ? (
          <nav className="pagination" aria-label="Research Universe pages">
            <button type="button" className="pagination-button" onClick={() => setPage(pagination.page - 1)} disabled={pagination.page <= 1} data-testid="pagination-prev">
              Previous
            </button>
            <span className="pagination-status" aria-live="polite" data-testid="pagination-status">Page {pagination.page} of {pagination.pageCount}</span>
            <button type="button" className="pagination-button" onClick={() => setPage(pagination.page + 1)} disabled={pagination.page >= pagination.pageCount} data-testid="pagination-next">
              Next
            </button>
          </nav>
        ) : null}
        <p className="table-foot">
          Market: token-level data <i aria-hidden="true" /> Protocol: associated-protocol data, not token data <i aria-hidden="true" /> DEX: on-chain markets for the exact token address <i aria-hidden="true" /> Ratios: Token Samurai calculations
        </p>
      </section>

      <PageFooter />
    </div>
  );
}
