/**
 * Well-known quote tokens by network and address, used only to label a DEX pool's trading pair ("UNI/WETH"). DexPaprika's
 * pool search names a pool's tokens by address; an address not listed here is shown shortened instead of guessed.
 * Addresses are the canonical token contracts (EVM addresses lower-cased; Solana mints exact).
 */
const QUOTES: Record<string, Record<string, string>> = {
  ethereum: {
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
    "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
    "0x6b175474e89094c44da98b954eedeac495271d0f": "DAI",
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "WBTC",
  },
  base: {
    "0x4200000000000000000000000000000000000006": "WETH",
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": "DAI",
  },
  arbitrum: {
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": "WETH",
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": "USDC",
    "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": "USDC.e",
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": "USDT",
  },
  optimism: {
    "0x4200000000000000000000000000000000000006": "WETH",
    "0x0b2c639c533813f4aa9d7837caf62653d097ff85": "USDC",
    "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": "USDT",
  },
  bsc: {
    "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": "WBNB",
    "0x55d398326f99059ff775485246999027b3197955": "USDT",
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC",
    "0xe9e7cea3dedca5984780bafc599bd69add087d56": "BUSD",
  },
  solana: {
    So11111111111111111111111111111111111111112: "SOL",
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  },
};

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Symbol of a well-known quote token, else the shortened address. */
export function quoteLabel(network: string, address: string): string {
  const table = QUOTES[network] ?? {};
  return table[address.toLowerCase()] ?? table[address] ?? shortAddress(address);
}
