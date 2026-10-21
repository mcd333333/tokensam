/**
 * Curated project-to-protocol associations, not token-level DeFiLlama IDs.
 * DeFiLlama's endpoints identify protocol records. Their metrics describe the
 * protocol's activity and must never be presented as intrinsic token metrics.
 * Add a mapping only after a reviewer confirms the project relationship and
 * exact DeFiLlama slug; never infer one from a ticker.
 *
 * recordId is the DeFiLlama record the slug resolved to when verified
 * (2026-09-24, from the `id` of GET /protocol/{slug} and GET /summary/fees/{slug}).
 * The collector rejects any response for a different record. A "parent" record
 * aggregates every sub-protocol DeFiLlama lists under it, and a child record
 * is one sub-protocol only. Neither is ever substituted for the other.
 */
export const defillamaProtocolMappings = [
  {
    tokenId: "aave-aave",
    chainId: "ethereum",
    externalAssetId: "aave",
    recordId: "parent#aave",
    recordKind: "parent",
    protocolName: "Aave (parent record)",
    relationship: "AAVE governance token associated with the Aave protocol; DeFiLlama's parent record aggregates every Aave version it tracks (at verification: Aave V1-V4, Arc, Aptos, Horizon RWA), not a single deployment",
  },
  {
    tokenId: "uniswap-uni",
    chainId: "ethereum",
    externalAssetId: "uniswap",
    recordId: "parent#uniswap",
    recordKind: "parent",
    protocolName: "Uniswap (parent record)",
    relationship: "UNI governance token associated with the Uniswap protocol; DeFiLlama's parent record aggregates every Uniswap version it tracks (at verification: Uniswap V1-V4, Uniswap Auctions), not a single deployment",
  },
  {
    tokenId: "lido-ldo",
    chainId: "ethereum",
    externalAssetId: "lido",
    recordId: "182",
    recordKind: "standalone",
    protocolName: "Lido",
    relationship: "LDO governance token associated with the Lido protocol",
  },
  {
    tokenId: "ethereum-crv",
    chainId: "ethereum",
    externalAssetId: "curve-dex",
    recordId: "3",
    recordKind: "child",
    protocolName: "Curve DEX",
    relationship: "CRV governance token associated with the Curve DEX protocol; child record of Curve Finance that excludes crvUSD and LlamaLend; protocol-wide metrics, not CRV-token activity",
  },
  {
    tokenId: "ethereum-comp",
    chainId: "ethereum",
    externalAssetId: "compound-v3",
    recordId: "2088",
    recordKind: "child",
    protocolName: "Compound V3",
    relationship: "COMP governance token associated with the Compound V3 protocol record; does not include every Compound version",
  },
  {
    tokenId: "ethereum-pendle",
    chainId: "ethereum",
    externalAssetId: "pendle",
    recordId: "parent#pendle",
    recordKind: "parent",
    protocolName: "Pendle (parent record)",
    relationship: "PENDLE governance token associated with Pendle; DeFiLlama's parent record aggregates every Pendle sub-protocol (at verification: Pendle V2, Boros), not Pendle V2 alone",
  },
  {
    tokenId: "ethereum-ena",
    chainId: "ethereum",
    externalAssetId: "ethena",
    recordId: "parent#ethena",
    recordKind: "parent",
    protocolName: "Ethena (parent record)",
    relationship: "ENA governance token associated with Ethena; DeFiLlama's parent record aggregates every Ethena sub-protocol (at verification: Ethena USDe, Ethena USDtb, Ethena tsUSDe), not USDe alone",
  },
  {
    tokenId: "solana-ray",
    chainId: "solana",
    externalAssetId: "raydium",
    recordId: "parent#raydium",
    recordKind: "parent",
    protocolName: "Raydium (parent record)",
    relationship: "RAY token associated with Raydium; DeFiLlama's parent record aggregates every Raydium sub-protocol (at verification: Raydium AMM, Raydium Perps, LaunchLab); protocol-wide metrics, not RAY-token activity",
  },
  {
    tokenId: "solana-jto",
    chainId: "solana",
    externalAssetId: "jito",
    recordId: "parent#jito",
    recordKind: "parent",
    protocolName: "Jito (parent record)",
    relationship: "JTO governance token associated with Jito; DeFiLlama's parent record aggregates every Jito sub-protocol (at verification: Jito Liquid Staking, Jito Restaking, Jito MEV Tips, Jito DAO), not liquid staking alone",
  },
  {
    tokenId: "base-aero",
    chainId: "base",
    externalAssetId: "aero-protocol",
    recordId: "parent#aero-protocol",
    recordKind: "parent",
    protocolName: "Aerodrome (parent record)",
    // DeFiLlama renamed this parent record's slug and id from "aerodrome"/"parent#aerodrome"
    // to "aero-protocol"/"parent#aero-protocol" at some point after 2026-09-24 verification;
    // the old slug started returning HTTP 400 ("Protocol not found"), which aborted this
    // provider's entire collection run on every scheduled cycle starting 2026-10-14 (not just
    // this protocol's own row -- fetchSnapshots/fetchHistorySnapshots loop sequentially and a
    // thrown DefiLlamaApiError from one asset fails the whole batch). Re-verified 2026-10-21:
    // GET /tvl/aero-protocol and GET /summary/fees/aero-protocol both resolve to id
    // "parent#aero-protocol", aggregating the same sub-protocols as before (Aerodrome V1,
    // Aerodrome Slipstream, Aerodrome Ignition).
    relationship: "AERO governance token associated with Aerodrome; DeFiLlama's parent record aggregates every Aerodrome sub-protocol (at verification: Aerodrome V1, Aerodrome Slipstream, Aerodrome Ignition, Aero Lite), not V1 alone",
  },
  {
    tokenId: "ethereum-morpho",
    chainId: "ethereum",
    externalAssetId: "morpho-blue",
    recordId: "4025",
    recordKind: "child",
    protocolName: "Morpho Blue",
    relationship: "MORPHO governance token associated with the Morpho Blue protocol record; child record of Morpho, not all Morpho products",
  },
  // Phase 15 (verified 2026-09-25). Each record's own DeFiLlama `geckoId` equals the token's
  // curated CoinGecko ID, and /summary/fees/{slug} resolved to exactly the pinned record ID.
  // Protocol-level data only: never token TVL, and never chain TVL for native assets.
  {
    tokenId: "bnb-chain-cake",
    chainId: "bnb-chain",
    externalAssetId: "pancakeswap",
    recordId: "parent#pancakeswap",
    recordKind: "parent",
    protocolName: "PancakeSwap (parent record)",
    relationship: "CAKE governance token associated with PancakeSwap; DeFiLlama's parent record aggregates every PancakeSwap sub-protocol (at verification: AMM V1/V2/V3, StableSwap, Infinity, Prediction, Lottery) across all chains; protocol-wide metrics, not CAKE-token activity",
  },
  {
    tokenId: "solana-orca",
    chainId: "solana",
    externalAssetId: "orca",
    recordId: "parent#orca",
    recordKind: "parent",
    protocolName: "Orca (parent record)",
    relationship: "ORCA governance token associated with Orca; DeFiLlama's parent record aggregates every Orca sub-protocol (at verification: Orca DEX only); protocol-wide metrics, not ORCA-token activity",
  },
  {
    tokenId: "arbitrum-gmx",
    chainId: "arbitrum",
    externalAssetId: "gmx",
    recordId: "parent#gmx",
    recordKind: "parent",
    protocolName: "GMX (parent record)",
    relationship: "GMX governance token associated with GMX; DeFiLlama's parent record aggregates GMX V1 Perps, GMX V2 Perps, and GMX Solana across chains, not the Arbitrum deployment alone",
  },
  {
    tokenId: "solana-kmno",
    chainId: "solana",
    externalAssetId: "kamino",
    recordId: "parent#kamino-finance",
    recordKind: "parent",
    protocolName: "Kamino (parent record)",
    relationship: "KMNO governance token associated with Kamino; DeFiLlama's parent record aggregates Kamino Lend and Kamino Liquidity",
  },
  {
    tokenId: "ethereum-syrup",
    chainId: "ethereum",
    externalAssetId: "maple-finance",
    recordId: "parent#maple-finance",
    recordKind: "parent",
    protocolName: "Maple Finance (parent record)",
    relationship: "SYRUP token associated with Maple Finance; DeFiLlama's parent record aggregates every Maple sub-protocol (at verification: Maple only); protocol lending metrics, not SYRUP-token activity",
  },
  {
    tokenId: "ethereum-ethfi",
    chainId: "ethereum",
    externalAssetId: "ether.fi",
    recordId: "parent#ether-fi",
    recordKind: "parent",
    protocolName: "ether.fi (parent record)",
    relationship: "ETHFI governance token associated with ether.fi; DeFiLlama's parent record aggregates ether.fi Stake, ether.fi Liquid, EtherFi Borrowing Market, and EtherFi Cash Liquid",
  },
  {
    tokenId: "dydx-dydx",
    chainId: "dydx",
    externalAssetId: "dydx",
    recordId: "parent#dydx",
    recordKind: "parent",
    protocolName: "dYdX (parent record)",
    relationship: "Native DYDX (dYdX Chain) associated with the dYdX exchange protocol; DeFiLlama's parent record aggregates dYdX V4 and the legacy V3 exchange; exchange-protocol metrics, not dYdX Chain chain-level TVL",
  },
  {
    tokenId: "hyperliquid-hype",
    chainId: "hyperliquid",
    externalAssetId: "hyperliquid",
    recordId: "parent#hyperliquid",
    recordKind: "parent",
    protocolName: "Hyperliquid (parent record)",
    relationship: "Native HYPE associated with the Hyperliquid exchange protocol; DeFiLlama's parent record aggregates Hyperliquid HLP, Perps, and Spot Orderbook; exchange-protocol metrics, not Hyperliquid L1 chain-level TVL",
  },
  {
    tokenId: "ethereum-eigen",
    chainId: "ethereum",
    externalAssetId: "eigencloud",
    recordId: "3107",
    recordKind: "standalone",
    protocolName: "EigenCloud",
    relationship: "EIGEN token associated with the EigenCloud (prev. EigenLayer) restaking protocol record; restaked-asset TVL is protocol data, not EIGEN-token value",
  },
  {
    tokenId: "ethereum-rpl",
    chainId: "ethereum",
    externalAssetId: "rocket-pool",
    recordId: "900",
    recordKind: "standalone",
    protocolName: "Rocket Pool",
    relationship: "RPL governance token associated with the Rocket Pool liquid-staking protocol; staked-ETH TVL is protocol data, not RPL-token value",
  },
  {
    tokenId: "ethereum-cvx",
    chainId: "ethereum",
    externalAssetId: "convex-finance",
    recordId: "319",
    recordKind: "standalone",
    protocolName: "Convex Finance",
    relationship: "CVX governance token associated with the Convex Finance yield protocol; protocol-wide metrics, not CVX-token activity",
  },
  {
    tokenId: "thorchain-rune",
    chainId: "thorchain",
    externalAssetId: "thorchain-dex",
    recordId: "412",
    recordKind: "standalone",
    protocolName: "THORChain DEX",
    relationship: "Native RUNE associated with the THORChain DEX protocol record; cross-chain swap-pool metrics, not THORChain chain-level TVL",
  },
  {
    tokenId: "ethereum-zro",
    chainId: "ethereum",
    externalAssetId: "layerzero",
    recordId: "parent#layerzero",
    recordKind: "parent",
    protocolName: "LayerZero (parent record)",
    relationship: "ZRO governance token associated with LayerZero; DeFiLlama's parent record aggregates LayerZero V1 and V2 across chains; protocol-wide metrics, not ZRO-token activity",
  },
] as const;

export const DEFILLAMA_PROTOCOL_METRIC_NOTE =
  "Protocol-level DeFiLlama metric associated by explicit project mapping; it is not a token-level metric or a valuation of the token.";
