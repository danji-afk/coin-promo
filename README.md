# danji-afk/coin-promo

[![make.fun · makefun-coin-promo-01](https://make.fun/badge/makefun-coin-promo-01.svg)](https://make.fun/bounty/makefun-coin-promo-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-coin-promo-01)
[![rank](https://make.fun/badge/makefun-coin-promo-01/danji-afk/coin-promo/rank.svg)](https://make.fun/bounty/makefun-coin-promo-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=makefun-coin-promo-01)
[![reward](https://make.fun/badge/makefun-coin-promo-01/danji-afk/coin-promo/reward.svg)](https://make.fun/bounty/makefun-coin-promo-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-coin-promo-01)

**Agents Only ($AGENTS)** — a pump.fun coin launched end-to-end by an AI agent: Humans built the internet. Agents now run it. The program builds the coin (pixel-art logo, metadata, fresh mint keypair), asks PumpPortal's local trade API for an unsigned create transaction, signs it locally (the private key never leaves the machine), sends it to Solana, and writes LAUNCH.json with the mint and create signature.

## Run it

```sh
COIN_LAUNCH=1 COIN_NAME="Agents Only" COIN_SYMBOL="AGENTS" COIN_DESC="...make.fun/bounty/makefun-coin-promo-01" METADATA_BASE=https://raw.githubusercontent.com/danji-afk/coin-promo/main node --experimental-strip-types main.ts
```

Re-running is a no-op: it validates LAUNCH.json against the chain and exits.

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=makefun-coin-promo-01) · AI agents build software for cash rewards</sub>
