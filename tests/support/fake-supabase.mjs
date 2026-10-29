// Minimal in-memory stand-in for the Supabase query builder calls used by the
// collectors, persistence, metrics runner, and refresh store. Not a general
// PostgREST emulator: it implements only what this codebase calls.

const IDENTITY_TABLES = new Set([
  "raw_provider_records", "token_metric_observations", "calculated_metric_observations",
  "data_refresh_runs", "data_refresh_steps", "token_ai_analyses", "geckoterminal_sync_runs",
]);
/** Tables with a partial unique index permitting only one 'running' row (a lease-based single-run lock). */
const SINGLE_RUNNING_ROW_TABLES = new Set(["data_refresh_runs", "geckoterminal_sync_runs"]);
const VIEWS = {
  token_metric_observations_resolved: { source: "token_metric_observations" },
  latest_token_metric_observations: { source: "token_metric_observations", key: ["token_id", "provider_id", "metric_id"], order: ["observed_at", "collected_at", "id"] },
  latest_raw_provider_records: { source: "raw_provider_records", key: ["provider_id", "token_id", "chain_id"], order: ["collected_at", "id"] },
};

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "string" && typeof b === "string") {
    const da = Date.parse(a);
    const db = Date.parse(b);
    if (Number.isFinite(da) && Number.isFinite(db) && /\d{4}-\d{2}-\d{2}/.test(a) && /\d{4}-\d{2}-\d{2}/.test(b)) return da - db;
    return a < b ? -1 : 1;
  }
  return a < b ? -1 : 1;
}

export function createFakeSupabase({ seed = {}, views = true, missingTables = [] } = {}) {
  const tables = new Map(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
  const nextId = new Map();
  const calls = [];
  for (const [name, rows] of tables) nextId.set(name, rows.reduce((max, row) => Math.max(max, row.id ?? 0), 0) + 1);

  const rowsOf = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };

  function viewRows(name) {
    const view = VIEWS[name];
    if (name === "token_metric_observations_resolved") {
      const metadata = new Map(rowsOf("observation_metadata").map((row) => [row.id, row]));
      return rowsOf(view.source).map((row) => row.metadata_id == null ? { ...row } : {
        ...row,
        ...Object.fromEntries(["note", "source_field", "scope", "provider_asset_id"]
          .map((field) => [field, metadata.get(row.metadata_id)?.[field] ?? null])),
      });
    }
    const latest = new Map();
    const sorted = [...rowsOf(view.source)].filter((row) => !row.excluded_reason).sort((a, b) => {
      for (const column of view.order) {
        const result = compare(b[column], a[column]);
        if (result) return result;
      }
      return 0;
    });
    for (const row of sorted) {
      const key = view.key.map((column) => row[column]).join("|");
      if (!latest.has(key)) latest.set(key, { ...row });
    }
    return [...latest.values()];
  }

  class Query {
    constructor(table) {
      this.table = table;
      this.op = "select";
      this.filters = [];
      this.orders = [];
      this.returning = false;
      this.mode = "many";
      this.from = null;
      this.to = null;
      this.limitCount = null;
      this.head = false;
    }
    select(_columns, options = {}) {
      if (this.op === "select") this.head = Boolean(options.head);
      else this.returning = true;
      return this;
    }
    insert(rows) { this.op = "insert"; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
    upsert(rows, options = {}) { this.op = "upsert"; this.payload = Array.isArray(rows) ? rows : [rows]; this.conflict = options.onConflict?.split(","); return this; }
    update(values) { this.op = "update"; this.values = values; return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
    gt(column, value) { this.filters.push((row) => compare(row[column], value) > 0); return this; }
    gte(column, value) { this.filters.push((row) => compare(row[column], value) >= 0); return this; }
    lte(column, value) { this.filters.push((row) => compare(row[column], value) <= 0); return this; }
    lt(column, value) { this.filters.push((row) => compare(row[column], value) < 0); return this; }
    is(column, value) { this.filters.push((row) => (row[column] ?? null) === value); return this; }
    order(column, options = {}) { this.orders.push({ column, ascending: options.ascending !== false }); return this; }
    range(from, to) { this.from = from; this.to = to; return this; }
    limit(count) { this.limitCount = count; return this; }
    single() { this.mode = "single"; return this; }
    maybeSingle() { this.mode = "maybe"; return this; }
    then(resolve, reject) { return Promise.resolve().then(() => this.execute()).then(resolve, reject); }

    execute() {
      calls.push({ table: this.table, op: this.op });
      if (missingTables.includes(this.table)) return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${this.table}'` } };
      if (VIEWS[this.table]) {
        if (!views) return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${this.table}'` } };
        return this.finish(viewRows(this.table).filter((row) => this.filters.every((filter) => filter(row))));
      }
      const rows = rowsOf(this.table);
      if (this.op === "insert") {
        if (SINGLE_RUNNING_ROW_TABLES.has(this.table) && this.payload.some((row) => row.status === "running")
          && rows.some((row) => row.status === "running")) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        const inserted = this.payload.map((row) => this.withId(row));
        rows.push(...inserted);
        return this.finish(inserted.map((row) => ({ ...row })), true);
      }
      if (this.op === "upsert") {
        for (const row of this.payload) {
          const existing = this.conflict ? rows.find((candidate) => this.conflict.every((column) => candidate[column] === row[column])) : undefined;
          if (existing) Object.assign(existing, row);
          else rows.push(this.withId(row));
        }
        return { data: null, error: null };
      }
      if (this.op === "update") {
        const matched = rows.filter((candidate) => this.filters.every((filter) => filter(candidate)));
        for (const row of matched) Object.assign(row, this.values);
        if (this.returning) return this.finish(matched.map((row) => ({ ...row })));
        return { data: null, error: null };
      }
      return this.finish(rows.filter((row) => this.filters.every((filter) => filter(row))).map((row) => ({ ...row })));
    }
    withId(row) {
      const copy = { ...row };
      if (IDENTITY_TABLES.has(this.table) && copy.id === undefined) {
        copy.id = nextId.get(this.table) ?? 1;
        nextId.set(this.table, copy.id + 1);
      }
      return copy;
    }
    finish(rows, mutation = false) {
      if (mutation && !this.returning) return { data: null, error: null };
      let result = [...rows];
      if (this.orders.length) {
        result.sort((a, b) => {
          for (const { column, ascending } of this.orders) {
            const value = compare(a[column], b[column]);
            if (value) return ascending ? value : -value;
          }
          return 0;
        });
      }
      if (this.from !== null) result = result.slice(this.from, this.to + 1);
      if (this.limitCount !== null) result = result.slice(0, this.limitCount);
      if (this.head) return { data: null, error: null, count: result.length };
      if (this.mode === "single") return result.length === 1 ? { data: result[0], error: null } : { data: null, error: { code: "PGRST116", message: "Expected one row" } };
      if (this.mode === "maybe") return { data: result[0] ?? null, error: null };
      return { data: result, error: null };
    }
  }

  // Picks the "newest wins" row per group, mirroring `order by observed_at desc, id desc`.
  function isNewer(a, b) {
    const byTime = compare(a.observed_at, b.observed_at);
    if (byTime !== 0) return byTime > 0;
    return (a.id ?? 0) > (b.id ?? 0);
  }

  // Mirrors the SQL function of the same name (20261007160000): one row per
  // (token_id, provider_id, metric_id) within [p_since, ) -- the newest observation wins.
  function latestObservationsBounded({ p_token_ids, p_provider_ids, p_since }) {
    const sinceMs = Date.parse(p_since);
    const groups = new Map();
    for (const row of viewRows("token_metric_observations_resolved")) {
      if (row.excluded_reason) continue;
      if (!p_token_ids.includes(row.token_id)) continue;
      if (!p_provider_ids.includes(row.provider_id)) continue;
      if (Date.parse(row.observed_at) < sinceMs) continue;
      const key = `${row.token_id}|${row.provider_id}|${row.metric_id}`;
      const current = groups.get(key);
      if (!current || isNewer(row, current)) groups.set(key, row);
    }
    return [...groups.values()].map((row) => ({ ...row }));
  }

  // Mirrors the SQL function of the same name (20261007160000): per (token_id, provider,
  // metric) pair, the two most recent distinct observations within p_max_lookback_days of
  // p_now, plus the observation nearest p_horizon_hours before the series' own latest
  // point, within p_tolerance_hours.
  function metricsSeriesRecentPoints(params) {
    const { p_token_ids, p_providers, p_metrics, p_now, p_horizon_hours = 24, p_tolerance_hours = 6, p_max_lookback_days = 30 } = params;
    const nowMs = Date.parse(p_now);
    const lookbackMs = p_max_lookback_days * 24 * 60 * 60 * 1000;
    const pairs = p_providers.map((providerId, index) => [providerId, p_metrics[index]]);
    const result = [];
    for (const tokenId of p_token_ids) {
      for (const [providerId, metricId] of pairs) {
        const candidates = viewRows("token_metric_observations_resolved")
          .filter((row) => row.token_id === tokenId && row.provider_id === providerId && row.metric_id === metricId
            && !row.excluded_reason && nowMs - Date.parse(row.observed_at) <= lookbackMs)
          .sort((a, b) => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0));
        const recent2 = candidates.slice(0, 2);
        if (recent2.length === 0) continue;
        result.push(...recent2);
        const latestAtMs = Date.parse(recent2[0].observed_at);
        const targetMs = latestAtMs - p_horizon_hours * 60 * 60 * 1000;
        const toleranceMs = p_tolerance_hours * 60 * 60 * 1000;
        let best = null;
        let bestDiff = Infinity;
        for (const row of candidates) {
          const diff = Math.abs(Date.parse(row.observed_at) - targetMs);
          if (diff <= toleranceMs && diff < bestDiff) { best = row; bestDiff = diff; }
        }
        if (best) result.push(best);
      }
    }
    const byId = new Map();
    for (const row of result) byId.set(row.id, row);
    return [...byId.values()].map((row) => ({ ...row }));
  }

  const RPCS = {
    latest_observations_bounded: latestObservationsBounded,
    metrics_series_recent_points: metricsSeriesRecentPoints,
    record_quota_usage: () => null,
    touch_calculated_metric_observations: ({ p_ids, p_calculated_at }) => {
      let touched = 0;
      for (const row of rowsOf("calculated_metric_observations")) {
        if (p_ids.includes(row.id)) { row.calculated_at = p_calculated_at; touched += 1; }
      }
      return touched;
    },
  };

  function rpc(name, params = {}) {
    calls.push({ table: name, op: "rpc" });
    const handler = RPCS[name];
    if (!handler) return Promise.resolve({ data: null, error: { message: `rpc '${name}' not implemented in the fake Supabase client` } });
    const data = handler(params);
    const response = Promise.resolve({ data, error: null });
    // Real PostgREST RPC builders are awaitable and also support .range() pagination.
    response.range = (from, to) => Promise.resolve({ data: Array.isArray(data) ? data.slice(from, to + 1) : data, error: null });
    return response;
  }

  return {
    client: { from: (table) => new Query(table), rpc },
    rows: (table) => rowsOf(table),
    calls,
  };
}
