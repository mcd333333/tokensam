import Link from "next/link";
import Image from "next/image";
import type { ReactNode } from "react";
import { TokenLogo } from "@/components/TokenLogo";
import { SidebarMovers } from "@/components/SidebarMovers";
import type { Movers } from "@/lib/ui/movers";

export const EMBLEM = { src: "/brand/token-samurai-emblem.png", width: 1536, height: 1024 } as const;
export const TAGLINE = "Cut through the noise. Uncover intelligent signal with AI.";

type CurrentToken = { id: string; name: string; symbol: string; logoUrl: string | null };

function UniverseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="nav-icon">
      <path d="M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z" />
    </svg>
  );
}

/**
 * Shared frame: the official emblem (scaled, never recreated) in the sidebar,
 * collapsing to a slim top bar on tablet and mobile so research pages stay
 * data-first.
 */
export function AppShell({ active, current, movers, children }: { active: "universe" | "token" | "none"; current?: CurrentToken; movers?: Movers | null; children: ReactNode }) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="sidebar" aria-label="Token Samurai">
        <Link className="sidebar-brand" href="/" aria-label="Token Samurai — Research Universe">
          <Image src={EMBLEM.src} alt="Token Samurai" width={EMBLEM.width} height={EMBLEM.height} sizes="(max-width: 1024px) 72px, 256px" quality={90} preload />
          <span className="mobile-wordmark" aria-hidden="true">Token <b>Samurai</b></span>
        </Link>
        <nav className="sidebar-nav" aria-label="Main navigation">
          <span className="nav-label">Research</span>
          <Link className={`nav-link${active === "universe" ? " active" : ""}`} href="/" aria-label="Research Universe" aria-current={active === "universe" ? "page" : undefined}>
            <UniverseIcon /><span className="nav-full-label">Research Universe</span><span className="nav-short-label" aria-hidden="true">Universe</span>
          </Link>
          {current ? (
            <Link className={`nav-link nav-sub${active === "token" ? " active" : ""}`} href={`/tokens/${current.id}`} aria-current={active === "token" ? "page" : undefined}>
              <TokenLogo src={current.logoUrl} symbol={current.symbol} size={18} /><span>{current.name}</span>
            </Link>
          ) : null}
        </nav>
        {movers ? <SidebarMovers movers={movers} /> : null}
        <div className="sidebar-foot">
          <p className="sidebar-tagline">{TAGLINE}</p>
          <p>Research data only. Not investment advice.</p>
        </div>
      </aside>
      <main className="main-area" id="main-content" tabIndex={-1}>
        <header className="workspace-bar">
          <div className="workspace-location"><span className="workspace-mark" aria-hidden="true">TS</span><span>Research workspace</span><span className="workspace-divider" aria-hidden="true">/</span><strong>{current?.name ?? "Overview"}</strong></div>
          <span className="workspace-caption">Clarity in a world of noise.</span>
        </header>
        {children}
      </main>
    </div>
  );
}

export function PageFooter() {
  return (
    <footer className="page-footer">
      <span className="footer-brand">Token Samurai <b aria-hidden="true">/</b> AI-powered crypto market intelligence</span>
      <span>Aggregated market, protocol, and on-chain data with deterministic calculations. Not investment advice.</span>
    </footer>
  );
}
