/**
 * On-chain identities for tokens that the DEX Screener mapping (dexscreener-token-mappings.ts) never curated, so
 * they can have DEX pool data from DexPaprika.
 *
 * Identity is an explicit per-token decision, never a ticker lookup at runtime. Each address is CoinGecko's own
 * platform address (GET /coins/list?include_platform=true, 2026-11-12) for the token's explicit CoinGecko id, on the
 * token's own chain, and each was confirmed to return pools from DexPaprika's pool search for that exact token
 * address the same day. Native assets (BTC, ETH, SOL, ...) are deliberately absent: DEX markets trade a wrapped
 * representation, which this project never substitutes for the native asset.
 */
export type ExtraOnchainMapping = { tokenId: string; canonicalChainId: string; network: string; tokenAddress: string };

export const extraOnchainMappings: ExtraOnchainMapping[] = [
  { tokenId: "base-kaito", canonicalChainId: "base", network: "base", tokenAddress: "0x98d0baa52b2d063e780de12f615f963fe8537553" },
  { tokenId: "bnb-chain-aster", canonicalChainId: "bnb-chain", network: "bsc", tokenAddress: "0x000ae314e2a2172a039b26378814c252734f556a" },
  { tokenId: "bnb-chain-tko", canonicalChainId: "bnb-chain", network: "bsc", tokenAddress: "0x9f589e3eabe42ebc94a44727b3f3531c0c877809" },
  { tokenId: "bnb-chain-twt", canonicalChainId: "bnb-chain", network: "bsc", tokenAddress: "0x4b0f1812e5df2a09796481ff14017e6005508003" },
  { tokenId: "bnb-chain-xvs", canonicalChainId: "bnb-chain", network: "bsc", tokenAddress: "0xcf6bb5389c92bdda8a3747ddb454cb7a64626c63" },
  { tokenId: "ethereum-1inch", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x111111111117dc0aa78b770fa6a738034120c302" },
  { tokenId: "ethereum-alt", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x8457ca5040ad67fdebbcc8edce889a335bc0fbfb" },
  { tokenId: "ethereum-ape", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x4d224452801aced8b2f0aebe155379bb5d594381" },
  { tokenId: "ethereum-arkm", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x6e2a43be0b1d33b726f0ca3b8de60b3482b8b050" },
  { tokenId: "ethereum-axs", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0xbb0e17ef65f82ab018d8edd776e8dd940327b28b" },
  { tokenId: "ethereum-bat", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x0d8775f648430679a709e98d2b0cb6250d2887ef" },
  { tokenId: "ethereum-chz", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x3506424f91fd33084466f402d5d97f05f8e3b4af" },
  { tokenId: "ethereum-enj", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0xf629cbd94d3791c9250152bd8dfbdf380e2a3b9c" },
  { tokenId: "ethereum-fdusd", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409" },
  { tokenId: "ethereum-ff", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0xfa1c09fc8b491b6a4d3ff53a10cad29381b3f949" },
  { tokenId: "ethereum-floki", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0xcf0c122c6b73ff809c693db761e7baebe62b6a2e" },
  { tokenId: "ethereum-gala", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0xd1d2eb1b1e90b638588728b4130137d262c87cae" },
  { tokenId: "ethereum-glm", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x7dd9c5cba05e151c895fde1cf355c9a1d5da6429" },
  { tokenId: "ethereum-gno", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x6810e776880c02933d47db1b9fc05908e5386b96" },
  { tokenId: "ethereum-ilv", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x767fe9edc9e0df98e07454847909b5e959d7ca0e" },
  { tokenId: "ethereum-jasmy", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x7420b4b9a0110cdc71fb720908340c03f9bc03ec" },
  { tokenId: "ethereum-lpt", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x58b6a8a3302369daec383334672404ee733ab239" },
  { tokenId: "ethereum-mana", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x0f5d2fb29fb7d3cfee444a200298f468908cc942" },
  { tokenId: "ethereum-nmr", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x1776e1f26f98b1a5df9cd347953a26dd3cb46671" },
  { tokenId: "ethereum-paxg", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x45804880de22913dafe09f4980848ece6ecbaf78" },
  { tokenId: "ethereum-rlusd", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x8292bb45bf1ee4d140127049757c2e0ff06317ed" },
  { tokenId: "ethereum-snx", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f" },
  { tokenId: "ethereum-spk", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0xc20059e0317de91738d13af027dfc4a50781b066" },
  { tokenId: "ethereum-sushi", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x6b3595068778dd592e39a122f4f5a5cf09c90fe2" },
  { tokenId: "ethereum-t", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0xcdf7028ceab81fa0c6971208e83fa7872994bee5" },
  { tokenId: "ethereum-turbo", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0xa35923162c49cf95e6bf26623385eb431ad920d3" },
  { tokenId: "ethereum-wlfi", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0xda5e1988097297dcdc1f90d4dfe7909e847cbef6" },
  { tokenId: "ethereum-xaut", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x68749665ff8d2d112fa859aa293f07a622782f38" },
  { tokenId: "ethereum-yfi", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0x0bc529c00c6401aef6d220be8c6ea1667f6ad93e" },
  { tokenId: "ethereum-zrx", canonicalChainId: "ethereum", network: "ethereum", tokenAddress: "0xe41d2489571d322189246dafa5ebde1f4699f498" },
  { tokenId: "linea-linea", canonicalChainId: "linea", network: "linea", tokenAddress: "0x1789e0043623282d5dcc7f213d703c6d8bafbb04" },
  { tokenId: "solana-io", canonicalChainId: "solana", network: "solana", tokenAddress: "BZLbGTNCSFfoth2GYDtwr7e4imWzpR5jqcUuGEwr646K" },
  { tokenId: "solana-pengu", canonicalChainId: "solana", network: "solana", tokenAddress: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv" },
  { tokenId: "solana-pump", canonicalChainId: "solana", network: "solana", tokenAddress: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn" },
  { tokenId: "solana-trump", canonicalChainId: "solana", network: "solana", tokenAddress: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN" },
  { tokenId: "tron-jst", canonicalChainId: "tron", network: "tron", tokenAddress: "TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9" },
];
