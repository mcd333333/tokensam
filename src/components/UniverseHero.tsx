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

const ICONS: Record<"assets" | "chains" | "metrics" | "updated", ReactNode> = {
  assets: (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <ellipse cx="24" cy="13" rx="13" ry="5" />
      <path d="M11 13v7c0 2.8 5.8 5 13 5s13-2.2 13-5v-7M11 20v7c0 2.8 5.8 5 13 5s13-2.2 13-5v-7M11 27v7c0 2.8 5.8 5 13 5s13-2.2 13-5v-7" />
    </svg>
  ),
  chains: (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path d="M24 17 13 33M24 17l11 16M17 36h14" />
      <circle cx="24" cy="12" r="6" />
      <circle cx="11" cy="36" r="6" />
      <circle cx="37" cy="36" r="6" />
    </svg>
  ),
  metrics: (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path d="M12 8h26v32H12a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4ZM38 8a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4" />
      <path className="icon-accent" d="M17 32V24M23 32V18M29 32V21M35 32V14" />
    </svg>
  ),
  updated: (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path d="M13 6h22M13 42h22M15 6c0 9 6 12 9 18-3 6-9 9-9 18M33 6c0 9-6 12-9 18 3 6 9 9 9 18" />
      <path className="icon-accent" d="M19 14h10l-5 7ZM17 39c2-5 5-7 7-7s5 2 7 7Z" />
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
