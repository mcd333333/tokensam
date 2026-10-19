import { canonicalTokens } from "./canonical-tokens.ts";
import type { CoverageReason } from "./provider-coverage.ts";

/**
 * Curated Binance spot-symbol mappings, used for the *live* price and 24-hour
 * price change only (see src/lib/providers/binance.ts).
 *
 * Identity, as everywhere else in this project, is an explicit per-token
 * decision rather than anything derived from a ticker at runtime. That
 * matters more here than for any other provider, because a Binance symbol
 * *is* a ticker pair: Binance lists the fungible asset, not a chain-scoped
 * contract. Two consequences are deliberate:
 *
 * 1. Every entry below was generated against Binance's own
 *    GET /api/v3/exchangeInfo (permissions=SPOT) on 2026-10-06 and kept only
 *    when the symbol's `status` was `TRADING` and `isSpotTradingAllowed` was
 *    true -- never inferred by concatenating `symbol + "USDT"`. The canonical
 *    universe currently has no two tokens sharing a ticker, which is asserted
 *    in tests/binance.test.mjs so a future addition cannot silently make one
 *    canonical token adopt another's Binance price.
 * 2. For a canonical token that is one chain's deployment of a multi-chain
 *    asset (for example `ethereum-usdc`), Binance's price is the asset's
 *    venue price, not that specific deployment's. Prices are arbitraged across
 *    deployments, so this is acceptable for a live price and is recorded in
 *    the observation note; it is NOT acceptable for supply, market cap, or
 *    anything else, which is why this provider writes no such metric.
 *
 * All mapped symbols are USDT-quoted. USDT is a USD *proxy*, not USD: the
 * stored metric keeps the `price_usd` id so it is a drop-in for CoinGecko's,
 * but every Binance observation says so in its note, and no code treats the
 * two as having identical provenance.
 */
export const binanceSymbols: Record<string, string> = {
  "ethereum-eth": "ETHUSDT",
  "bitcoin-btc": "BTCUSDT",
  "solana-sol": "SOLUSDT",
  "bnb-bnb": "BNBUSDT",
  "xrp-xrp": "XRPUSDT",
  "avalanche-avax": "AVAXUSDT",
  "arbitrum-arb": "ARBUSDT",
  "optimism-op": "OPUSDT",
  "aave-aave": "AAVEUSDT",
  "uniswap-uni": "UNIUSDT",
  "lido-ldo": "LDOUSDT",
  "maker-mkr": "SKYUSDT",
  "chainlink-link": "LINKUSDT",
  "sui-sui": "SUIUSDT",
  "aptos-apt": "APTUSDT",
  "polygon-pol": "POLUSDT",
  "near-near": "NEARUSDT",
  "celestia-tia": "TIAUSDT",
  "render-render": "RENDERUSDT",
  "jupiter-jup": "JUPUSDT",
  "ethereum-usdc": "USDCUSDT",
  "ethereum-wbtc": "WBTCUSDT",
  "dogecoin-doge": "DOGEUSDT",
  "tron-trx": "TRXUSDT",
  "cardano-ada": "ADAUSDT",
  "polkadot-dot": "DOTUSDT",
  "cosmos-atom": "ATOMUSDT",
  "litecoin-ltc": "LTCUSDT",
  "stellar-xlm": "XLMUSDT",
  "internet-computer-icp": "ICPUSDT",
  "filecoin-fil": "FILUSDT",
  "ethereum-crv": "CRVUSDT",
  "ethereum-comp": "COMPUSDT",
  "ethereum-pendle": "PENDLEUSDT",
  "ethereum-ena": "ENAUSDT",
  "ethereum-ondo": "ONDOUSDT",
  "ethereum-shib": "SHIBUSDT",
  "ethereum-pepe": "PEPEUSDT",
  "solana-bonk": "BONKUSDT",
  "solana-ray": "RAYUSDT",
  "solana-jto": "JTOUSDT",
  "solana-pyth": "PYTHUSDT",
  "base-aero": "AEROUSDT",
  "ethereum-morpho": "MORPHOUSDT",
  "ethereum-grt": "GRTUSDT",
  "arweave-ar": "ARUSDT",
  "ton-gram": "GRAMUSDT",
  "hedera-hbar": "HBARUSDT",
  "algorand-algo": "ALGOUSDT",
  "sei-sei": "SEIUSDT",
  "injective-inj": "INJUSDT",
  "bitcoin-cash-bch": "BCHUSDT",
  "ethereum-classic-etc": "ETCUSDT",
  "vechain-vet": "VETUSDT",
  "sonic-s": "SUSDT",
  "hyperliquid-hype": "HYPEUSDT",
  "bittensor-tao": "TAOUSDT",
  "zcash-zec": "ZECUSDT",
  "dydx-dydx": "DYDXUSDT",
  "thorchain-rune": "RUNEUSDT",
  "stacks-stx": "STXUSDT",
  "tezos-xtz": "XTZUSDT",
  "theta-theta": "THETAUSDT",
  "ethereum-strk": "STRKUSDT",
  "zksync-zk": "ZKUSDT",
  "ethereum-imx": "IMXUSDT",
  "bnb-chain-cake": "CAKEUSDT",
  "solana-orca": "ORCAUSDT",
  "arbitrum-gmx": "GMXUSDT",
  "solana-kmno": "KMNOUSDT",
  "ethereum-syrup": "SYRUPUSDT",
  "ethereum-rpl": "RPLUSDT",
  "ethereum-eigen": "EIGENUSDT",
  "ethereum-ethfi": "ETHFIUSDT",
  "ethereum-cvx": "CVXUSDT",
  "ethereum-usde": "USDEUSDT",
  "ethereum-usds": "USDSUSDT",
  "ethereum-zro": "ZROUSDT",
  "solana-w": "WUSDT",
  "ethereum-qnt": "QNTUSDT",
  "ethereum-fet": "FETUSDT",
  "base-virtual": "VIRTUALUSDT",
  "ethereum-sand": "SANDUSDT",
  "solana-wif": "WIFUSDT",
  "ethereum-ens": "ENSUSDT",
  "ethereum-plume": "PLUMEUSDT",
  "ethereum-wld": "WLDUSDT",
  "iota-iota": "IOTAUSDT",
  "neo-neo": "NEOUSDT",
  "decred-dcr": "DCRUSDT",
  "nano-xno": "XNOUSDT",
  "harmony-one": "ONEUSDT",
  "kava-kava": "KAVAUSDT",
  "mina-mina": "MINAUSDT",
  "astar-astr": "ASTRUSDT",
  "osmosis-osmo": "OSMOUSDT",
  "celo-celo": "CELOUSDT",
  "zilliqa-zil": "ZILUSDT",
  "nervos-ckb": "CKBUSDT",
  "kaia-kaia": "KAIAUSDT",
  "conflux-cfx": "CFXUSDT",
  "berachain-bera": "BERAUSDT",
  "multiversx-egld": "EGLDUSDT",
  "ravencoin-rvn": "RVNUSDT",
  "kusama-ksm": "KSMUSDT",
  "dash-dash": "DASHUSDT",
  "oasis-rose": "ROSEUSDT",
  "digibyte-dgb": "DGBUSDT",
  "metis-metis": "METISUSDT",
  "axelar-axl": "AXLUSDT",
  "dymension-dym": "DYMUSDT",
  "iotex-iotx": "IOTXUSDT",
  "polymesh-polyx": "POLYXUSDT",
  "centrifuge-cfg": "CFGUSDT",
  "flow-flow": "FLOWUSDT",
  "qtum-qtum": "QTUMUSDT",
  "siacoin-sc": "SCUSDT",
  "ontology-ont": "ONTUSDT",
  "wax-waxp": "WAXPUSDT",
  "ecash-xec": "XECUSDT",
  "ethereum-snx": "SNXUSDT",
  "ethereum-yfi": "YFIUSDT",
  "ethereum-1inch": "1INCHUSDT",
  "ethereum-sushi": "SUSHIUSDT",
  "ethereum-t": "TUSDT",
  "ethereum-uma": "UMAUSDT",
  "ethereum-api3": "API3USDT",
  "ethereum-band": "BANDUSDT",
  "ethereum-rsr": "RSRUSDT",
  "ethereum-zrx": "ZRXUSDT",
  "ethereum-knc": "KNCUSDT",
  "ethereum-bat": "BATUSDT",
  "ethereum-mask": "MASKUSDT",
  "ethereum-ankr": "ANKRUSDT",
  "ethereum-woo": "WOOUSDT",
  "ethereum-celr": "CELRUSDT",
  "bnb-chain-xvs": "XVSUSDT",
  "ethereum-rez": "REZUSDT",
  "ethereum-lqty": "LQTYUSDT",
  "solana-tnsr": "TNSRUSDT",
  "bnb-chain-twt": "TWTUSDT",
  "ethereum-syn": "SYNUSDT",
  "ethereum-mana": "MANAUSDT",
  "ethereum-axs": "AXSUSDT",
  "ethereum-chz": "CHZUSDT",
  "ethereum-gala": "GALAUSDT",
  "ethereum-ilv": "ILVUSDT",
  "ethereum-ygg": "YGGUSDT",
  "ethereum-enj": "ENJUSDT",
  "arbitrum-magic": "MAGICUSDT",
  "bnb-chain-gmt": "GMTUSDT",
  "solana-io": "IOUSDT",
  "ethereum-arkm": "ARKMUSDT",
  "ethereum-nmr": "NMRUSDT",
  "ethereum-blur": "BLURUSDT",
  "ethereum-jasmy": "JASMYUSDT",
  "ethereum-glm": "GLMUSDT",
  "ethereum-lpt": "LPTUSDT",
  "ethereum-fdusd": "FDUSDUSDT",
  "ethereum-tusd": "TUSDUSDT",
  "ethereum-floki": "FLOKIUSDT",
  "solana-bome": "BOMEUSDT",
  "solana-pengu": "PENGUUSDT",
  "ethereum-turbo": "TURBOUSDT",
  "ton-not": "NOTUSDT",
  "manta-manta": "MANTAUSDT",
  "theta-tfuel": "TFUELUSDT",
  "ethereum-gno": "GNOUSDT",
  "ethereum-skl": "SKLUSDT",
  "ethereum-ctsi": "CTSIUSDT",
  "ethereum-ogn": "OGNUSDT",
  "ethereum-bnt": "BNTUSDT",
  "polygon-gns": "GNSUSDT",
  "dusk-dusk": "DUSKUSDT",
  "base-kaito": "KAITOUSDT",
  "base-bio": "BIOUSDT",
  "ethereum-alt": "ALTUSDT",
  "ethereum-eul": "EULUSDT",
  "ethereum-ssv": "SSVUSDT",
  "linea-linea": "LINEAUSDT",
  "solana-pump": "PUMPUSDT",
  "bnb-chain-aster": "ASTERUSDT",
  "ethereum-wlfi": "WLFIUSDT",
  "solana-trump": "TRUMPUSDT",
  "terra-classic-lunc": "LUNCUSDT",
  "ethereum-ape": "APEUSDT",
  "bitcoin-ordi": "ORDIUSDT",
  "ethereum-xaut": "XAUTUSDT",
  "ethereum-paxg": "PAXGUSDT",
  "ethereum-rlusd": "RLUSDUSDT",
  "ethereum-spk": "SPKUSDT",
  "bnb-chain-tko": "TKOUSDT",
};

/**
 * Canonical tokens deliberately left unmapped, with the reason the UI and the
 * AI layer are allowed to state. Each of these falls back to CoinGecko for
 * price, which is exactly what the fallback exists for.
 */
export const binanceUnmapped: Record<string, { reason: CoverageReason; detail: string }> = {
  "ethereum-usdt": {
    reason: "provider_does_not_support_token",
    detail: "USDT is the quote currency of every symbol used here, so Binance lists no USDTUSDT spot market to price it against.",
  },
  "ethereum-stg": {
    reason: "no_provider_data",
    detail: "STGUSDT exists on Binance but its status was BREAK (trading halted) when this mapping was verified on 2026-10-06, so its last price is stale and must not be served as live.",
  },
  "solana-hnt": {
    reason: "no_provider_data",
    detail: "HNTUSDT exists on Binance but its status was BREAK (trading halted) when this mapping was verified on 2026-10-19, so its last price is stale and must not be served as live.",
  },
  "cronos-cro": {
    reason: "provider_does_not_support_token",
    detail: "No CROUSDT (or any CRO) spot market exists on Binance, verified against /api/v3/exchangeInfo on 2026-10-17; an earlier mapping added without live verification was incorrect and broke the whole live-price batch.",
  },
  "ethereum-mnt": {
    reason: "provider_does_not_support_token",
    detail: "No MNTUSDT (or any MNT) spot market exists on Binance, verified against /api/v3/exchangeInfo on 2026-10-17; an earlier mapping added without live verification was incorrect and broke the whole live-price batch.",
  },
  "kaspa-kas": {
    reason: "provider_does_not_support_token",
    detail: "No KASUSDT (or any KAS) spot market exists on Binance, verified against /api/v3/exchangeInfo on 2026-10-17; an earlier mapping added without live verification was incorrect and broke the whole live-price batch.",
  },
  "flare-flr": {
    reason: "provider_does_not_support_token",
    detail: "No FLRUSDT (or any FLR) spot market exists on Binance, verified against /api/v3/exchangeInfo on 2026-10-17; an earlier mapping added without live verification was incorrect and broke the whole live-price batch.",
  },
  "akash-akt": {
    reason: "provider_does_not_support_token",
    detail: "No AKTUSDT (or any AKT) spot market exists on Binance, verified against /api/v3/exchangeInfo on 2026-10-17; an earlier mapping added without live verification was incorrect and broke the whole live-price batch.",
  },
  "ethereum-safe": {
    reason: "provider_does_not_support_token",
    detail: "No SAFEUSDT (or any SAFE) spot market exists on Binance, verified against /api/v3/exchangeInfo on 2026-10-17; an earlier mapping added without live verification was incorrect and broke the whole live-price batch.",
  },
};

/** Canonical token ids that have a Binance symbol, for collection and coverage. */
export const binanceMappedTokenIds: string[] = canonicalTokens
  .filter((token) => Boolean(binanceSymbols[token.id]))
  .map((token) => token.id);
