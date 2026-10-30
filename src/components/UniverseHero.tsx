import Image from "next/image";
import type { ReactNode } from "react";
import type { RefreshStatusView } from "@/lib/refresh/freshness";
import { datasetLabel } from "@/lib/ui/data-language";

/**
 * Homepage hero, built from real text and components. The backdrop is the
 * artwork-only illustration (decorative, empty alt); every word and number
 * above it is live HTML. Every number comes from live data passed in by the
 * page; a missing value is shown as unavailable.
 */

function utcTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
}

function utcDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Mon-inspired line art: a treasury coin, linked clan crests, a research scroll,
// and a Japanese timepiece. Each symbol follows the metric it represents.
const ICONS: Record<"assets" | "chains" | "metrics" | "updated", ReactNode> = {
  assets: (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <circle cx="24" cy="24" r="17" /><circle cx="24" cy="24" r="13" />
      <path className="icon-accent" d="M20 20h8v8h-8z" />
      <path d="M24 11v5M24 32v5M11 24h5M32 24h5M12 12l3 3M33 33l3 3" />
    </svg>
  ),
  chains: (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path d="m20 18-7 13M28 18l7 13M18 37h12" />
      <circle cx="24" cy="12" r="8" /><circle cx="11" cy="36" r="8" /><circle cx="37" cy="36" r="8" />
      <path className="icon-accent" d="m24 8 4 4-4 4-4-4ZM11 32l4 4-4 4-4-4ZM37 32l4 4-4 4-4-4Z" />
    </svg>
  ),
  metrics: (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path d="M12 8h24v32H12M12 8a3 3 0 1 0-6 0v29a3 3 0 0 0 6 0ZM36 8a3 3 0 1 1 6 0v29a3 3 0 0 1-6 0ZM12 13h24M12 35h24" />
      <path className="icon-accent" d="M18 29v-6M24 29V18M30 29v-9" />
    </svg>
  ),
  updated: (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path d="m24 4 5 5h8l2 8 5 7-5 7-2 8h-8l-5 5-5-5h-8l-2-8-5-7 5-7 2-8h8Z" />
      <circle cx="24" cy="24" r="12" />
      <path d="M24 14v2M34 24h-2M24 34v-2M14 24h2" />
      <path className="icon-accent" d="M24 18v6l5 3" />
    </svg>
  ),
};

/**
 * One metric card: a real <dt>/<dd> pair. The label is a kicker above the
 * value (Last updated) or a caption below it; CSS order handles placement.
 */
function StatCard({ kind, value, label, detail, labelFirst = false, status }: {
  kind: keyof typeof ICONS;
  value: string;
  label: string;
  detail?: string | null;
  labelFirst?: boolean;
  status?: ReactNode;
}) {
  return (
    <div className={`hero-card hero-card-${kind}`}>
      <span className="hero-card-icon">{ICONS[kind]}</span>
      <dl className="hero-card-copy">
        <dt className={labelFirst ? "hero-card-kicker" : "hero-card-label"}>{label}{status}</dt>
        <dd className="hero-card-value">{value}</dd>
        {detail ? <dd className="hero-card-detail">{detail}</dd> : null}
      </dl>
    </div>
  );
}

export function UniverseHero({ assets, chains, metricsPerAsset, updatedAt, refreshStatus, error }: {
  assets: number;
  chains: number;
  metricsPerAsset: number;
  updatedAt: string | null;
  refreshStatus: RefreshStatusView | null;
  error: string | null;
}) {
  const live = !error;
  const stale = refreshStatus?.providers.filter((provider) => provider.state === "stale") ?? [];
  const staleNote = stale.length > 0
    ? `${stale.length} dataset${stale.length === 1 ? "" : "s"} stale: ${stale.map((provider) => datasetLabel(provider.id, provider.label)).join(", ")}`
    : "All datasets current";
  const status = updatedAt ? (
    <span className={`hero-card-status${stale.length > 0 ? " stale" : ""}`} title={staleNote}>
      <span className="visually-hidden">{staleNote}</span>
    </span>
  ) : null;

  return (
    <section className="samurai-hero" aria-labelledby="page-title">
      <div className="hero-art" aria-hidden="true">
        <Image src="/brand/token-samurai-hero.png" alt="" fill priority sizes="(max-width: 1280px) 100vw, 1900px" quality={90} />
      </div>
      <div className="hero-veil" aria-hidden="true" />
      <div className="hero-copy">
        <p className="eyebrow hero-eyebrow">AI-powered crypto market intelligence</p>
        <h1 id="page-title" className="hero-title">
          <span>Enter the crypto</span> <span className="hero-title-accent">Samuraiverse</span>
        </h1>
        <p className="hero-lede">
          Go beyond the price. Explore token fundamentals, market activity, and on-chain signals in one research workspace.
        </p>
        <a className="hero-explore" href="#research-universe">Explore the universe <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 15 15 5M5 5h10v10" /></svg></a>
        {error ? <p className="error-banner" role="alert">{error}</p> : null}
      </div>
      <div className="hero-stats" aria-label="Research universe at a glance">
        <StatCard kind="assets" value={live ? String(assets) : "—"} label="Assets tracked" />
        <StatCard kind="chains" value={live ? String(chains) : "—"} label="Chains covered" />
        <StatCard kind="metrics" value={String(metricsPerAsset)} label="Metrics per asset" />
        <StatCard
          kind="updated"
          labelFirst
          status={status}
          label="Last updated"
          value={updatedAt ? `${utcTime(updatedAt)} UTC` : "Awaiting data"}
          detail={updatedAt ? utcDate(updatedAt) : null}
        />
      </div>
    </section>
  );
}
