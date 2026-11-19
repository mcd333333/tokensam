import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TokenProfile } from "@/components/TokenProfile";
import { LiveDataUnavailable } from "@/components/LiveDataUnavailable";
import { AppShell } from "@/components/AppShell";
import { canonicalTokens } from "@/data/canonical-tokens";
import { getLiveTokenProfile, getSidebarMovers } from "@/lib/data/live-data";
import { getRootDataProfile } from "@/lib/data/rootdata-profiles";

export const dynamic = "force-dynamic";
// Generous ceiling for the "Generate AI Report" Server Action invoked from this page. The
// deterministic Deep Analysis Engine has no external calls and typically finishes in well under a
// second; this only guards against a slow database round trip loading the token profile.
export const maxDuration = 300;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const token = canonicalTokens.find((candidate) => candidate.id === id);
  return token ? { title: `${token.name} (${token.symbol})`, description: `${token.name} market data, fundamentals, and market structure on Token Samurai.` } : { title: "Page not found" };
}

export default async function TokenProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Sidebar movers never throw (null hides the section), so they load alongside the profile.
  const moversRead = getSidebarMovers();
  const rootdataRead = getRootDataProfile(id);
  let data;
  try {
    data = await getLiveTokenProfile(id);
  } catch (error) {
    console.error(`Live token profile load failed for ${id}:`, error);
    return <AppShell active="none" movers={await moversRead}><LiveDataUnavailable /></AppShell>;
  }
  if (!data) notFound();
  const [movers, rootdataProfile] = await Promise.all([moversRead, rootdataRead]);
  const current = { id: data.token.id, name: data.token.name, symbol: data.token.symbol, logoUrl: data.logoUrl };
  return (
    <AppShell active="token" current={current} movers={movers}>
      <TokenProfile data={data} rootdataProfile={rootdataProfile} />
    </AppShell>
  );
}
