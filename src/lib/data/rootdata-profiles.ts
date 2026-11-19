import "server-only";

import cryptoRankProfiles from "@/data/cryptorank-token-profiles.json";
import investorLogos from "@/data/investor-logos.json";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type RootDataProfile = {
  token_id: string;
  rootdata_project_id: number | null;
  rootdata_project_name: string;
  token_symbol: string | null;
  rootdata_url: string | null;
  logo_url: string | null;
  establishment_date: string | null;
  tags: unknown;
  one_liner: string | null;
  description: string | null;
  website_url: string | null;
  social_media: unknown;
  total_funding: number | string | null;
  investors: unknown;
  static_collected_at: string | null;
  financial_collected_at: string | null;
  additionalFunding?: {
    label: string;
    investorLabel: string;
    lowerBound: boolean;
    note: string;
    profileUrl: string;
    amountUrl: string;
    investorUrl: string | null;
  };
};

const fundingLabels: Record<string, string> = {
  project_total: "total fundraising",
  company_total: "total fundraising",
  issuer_total_lower_bound: "reported fundraising",
  related_company_series_c: "Series C",
  public_token_sales: "public token sales",
};

function getCryptoRankProfile(tokenId: string): RootDataProfile | null {
  const profile = cryptoRankProfiles.entries.find((entry) => entry.token_id === tokenId);
  if (!profile) return null;
  const { funding } = profile;
  return {
    token_id: profile.token_id,
    rootdata_project_id: null,
    rootdata_project_name: profile.project_name,
    token_symbol: profile.token_symbol,
    rootdata_url: null,
    logo_url: profile.logo_url,
    establishment_date: profile.establishment_date,
    tags: profile.tags,
    one_liner: profile.one_liner,
    description: profile.description,
    website_url: profile.website_url,
    social_media: { ...profile.social_media, ...profile.other_project_links },
    total_funding: funding.amount_usd,
    // The CryptoRank/press data lists investors by name only; logos come from the matching RootData investor image.
    investors: funding.investors?.map((name) => ({ name, logo: investorLogos.logos[name as keyof typeof investorLogos.logos] ?? null })) ?? [],
    static_collected_at: cryptoRankProfiles.retrieved_on,
    financial_collected_at: null,
    additionalFunding: {
      label: funding.entity + " " + fundingLabels[funding.scope],
      investorLabel: funding.entity + (funding.scope === "related_company_series_c" ? " backers" : " investors"),
      lowerBound: funding.scope === "issuer_total_lower_bound",
      note: funding.note,
      profileUrl: profile.cryptorank_url,
      amountUrl: funding.amount_source,
      investorUrl: funding.investor_source,
    },
  };
}

export async function getRootDataProfile(tokenId: string): Promise<RootDataProfile | null> {
  try {
    const { data, error } = await createSupabaseAdminClient()
      .from("rootdata_project_profiles")
      .select("token_id,rootdata_project_id,rootdata_project_name,token_symbol,rootdata_url,logo_url,establishment_date,tags,one_liner,description,website_url,social_media,total_funding,investors,static_collected_at,financial_collected_at")
      .eq("token_id", tokenId)
      .maybeSingle();

    if (error) {
      // Keep the market-data profile available while the RootData migration is not yet applied.
      if (error.code !== "PGRST205" && error.code !== "42P01") {
        console.warn(`RootData profile read failed for ${tokenId}:`, error.message);
      }
      return getCryptoRankProfile(tokenId);
    }
    return (data as RootDataProfile | null) ?? getCryptoRankProfile(tokenId);
  } catch (error) {
    console.warn(`RootData profile read failed for ${tokenId}:`, error);
    return getCryptoRankProfile(tokenId);
  }
}
