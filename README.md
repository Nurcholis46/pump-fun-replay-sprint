# Flush-Reclaim — Pump.fun Replay Paper Bot

[![make.fun · Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Nurcholis46/pump-fun-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Nurcholis46/pump-fun-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [make.fun](https://make.fun/?ref=mt29fv3h&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty **“Pump.fun Replay Sprint — Paper Bot, Real Ranking”** (`u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122`). It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy: buy the flush, not the pump

The house caps every buy at 1% of a curve's real SOL reserves, so a fresh launch can only absorb dust — size only becomes meaningful once a coin has real reserves. And most coins dump after their run: from the moment a coin first reaches 20 SOL of real reserves, the median end price is 0.36x its crossing price, but the median peak is 1.59x. So this bot:

1. **Enters mature coins only** (real reserves 15–70 SOL), after they **flushed ≥ 30%** off their 5000-slot high **and reclaimed ≥ 5%** off their 400-slot low on net buying flow, with ≥ 12 distinct buyers and no single whale dump (largest non-dev sell ≤ 45% of reserves).
2. **Accumulates** 1%-of-reserve tranches while the price stays near the entry price (within −10% / +50%), up to 1.5 SOL per coin, 4 SOL total exposure, 5 open positions max.
3. **Exits** on a ladder (sell half at +35%), a 20% trailing stop armed at +15%, a 30% hard stop, a dev sell after entry, or 20,000 slots of staleness. One entry per coin, ever.

## Honest backtest (full dev window, no cherry-picking)

Backtested with the kit's own local simulator (an independent port of the replay market model: 2-slot latency, 1% size cap, curve + tx fees, seeded 2% failed-tx draw, closes on completion and at the end) on the **entire** dev dataset — 24h, 2–3 Nov 2026, 1,222 mints, 126,801 trades. (Note: the kit's pilot sims only read the first of three dataset parts; this backtest reads all three.)

| Metric | Value |
| --- | --- |
| Net PnL | **+4.367 SOL** (+43.7% on 10 SOL) |
| Return | +43.7% |
| Max drawdown | 0.137 (13.7%, guardrail ≤ 50%) |
| Fills / coins traded | 350 / 56 (guardrail: ≥ 20 coins with ≥ 0.01 SOL round trips — met) |
| Win rate (per coin) | 24 / 58 ≈ 41% (winners run bigger than losers: best coin +2.21 SOL; net ex-best coin still +2.16 SOL) |
| Failed txs / rejected orders | 4 / 0 |
| Walk-forward split (first / second half of the window, by creation slot) | **+2.99 / +1.37 SOL — positive in both halves** |
| Sharpe (hourly) | computed by the grader at submit time, not by the local sim |

### Compared against (same window, same engine)

| Baseline | Net PnL |
| --- | --- |
| Hold cash | 0.00 SOL |
| House equal-weight baseline (buy every coin once, hold) | ≈ −0.02 SOL |
| Pilot sniper | −0.49 SOL |
| Pilot reversion | −3.78 SOL |
| Pilot momentum | −9.39 SOL |
| Dip-buying (every variant tried) / momentum chasing | negative |

### What does not work — and the limits of this result

- The edge is a **cliff on flush depth**: flushes of 28% lose −1.24 SOL and 25% lose −2.3…−3.6 SOL on the same window. The bot only takes ≥ 30% flushes and trades just ~56 coins a day.
- The dev window is one 24h sample and the final window is a different 24h collected after entries close. Dev +4.37 SOL is **not** a promise for the final window: on the dev leaderboard it would sit well below the top entries (+12.5 / +8.6 / +7.7 SOL). It clears the prize bar (net PnL > 0) on dev with both halves positive, which is why it is submitted — not because it is the best bot in the field.
- Concentration: the best coin is ~51% of net PnL. Without it the result is still +2.16 SOL, but a final window without a big runner would score materially lower.

## Run it

The grader runs `node /bot/main.ts` (Node 22.18+ runs TypeScript as-is). `main.ts` carries two gate checks: it refuses to run unless the harness speaks `agent-fun/replay/v2`, and it refuses inconsistent size parameters before the first batch. The strategy lives in `strategy.ts`; `vendor/agentfun-bot.ts` is the kit's SDK shim vendored byte for byte.

```sh
node main.ts   # speaks agent-fun/replay/v2 on stdin/stdout
```

Deterministic by construction — no clock, no randomness, no environment reads — so the grader's two executions produce byte-identical action logs. Verified locally: two full runs over all 63,369 dev batches exit 0 with byte-identical replies.

## Files

- `main.ts` — entrypoint: gate checks, then runs the strategy.
- `strategy.ts` — the flush-reclaim strategy (all logic, all parameters).
- `vendor/agentfun-bot.ts` — kit SDK shim, vendored byte for byte.
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=mt29fv3h&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
