// agentfun-flush-reclaim: a pump.fun replay paper-trading bot.
// Run by the grader as `node /bot/main.ts` (Node 22.18+ runs TypeScript as-is).
// The strategy lives in strategy.ts; the SDK shim is the kit's agentfun-bot.ts,
// vendored byte for byte in vendor/.

import { PROTOCOL, runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// Gate check: this bot only speaks the replay protocol it was built and
// backtested against. If the harness ever speaks anything else, refuse loudly
// instead of trading on misunderstood data. The shim itself also throws on a
// protocol mismatch, so this is a second, explicit gate at our own front door.

if (PROTOCOL !== 'agent-fun/replay/v2') {
  console.error(`gate: unsupported replay protocol ${PROTOCOL}, want agent-fun/replay/v2`);
  process.exit(1);
}

// Gate check 2: the strategy's own size limits must be self-consistent, or the
// bot would either never trade (budget below the smallest buy) or silently
// exceed its exposure cap. Fail before the first batch rather than mid-run.
// Every numeric parameter must also be finite and inside the range the
// strategy's comparisons assume (fractions in (0, 1), windows positive), so a
// typo'd parameter fails loudly here instead of silently never trading.
const numericParams: Array<[string, number]> = [
  ['minRqSol', DEFAULT_PARAMS.minRqSol],
  ['maxRqSol', DEFAULT_PARAMS.maxRqSol],
  ['flushDrop', DEFAULT_PARAMS.flushDrop],
  ['reclaimUp', DEFAULT_PARAMS.reclaimUp],
  ['budgetSol', DEFAULT_PARAMS.budgetSol],
  ['minBuySol', DEFAULT_PARAMS.minBuySol],
  ['tp1', DEFAULT_PARAMS.tp1],
  ['stopLoss', DEFAULT_PARAMS.stopLoss],
  ['trail', DEFAULT_PARAMS.trail],
  ['trailArm', DEFAULT_PARAMS.trailArm],
  ['maxExposureSol', DEFAULT_PARAMS.maxExposureSol],
];
for (const [name, value] of numericParams) {
  if (!Number.isFinite(value)) {
    console.error(`gate: DEFAULT_PARAMS.${name} is not finite (${value}), refusing to run`);
    process.exit(1);
  }
}
if (
  DEFAULT_PARAMS.budgetSol <= DEFAULT_PARAMS.minBuySol ||
  DEFAULT_PARAMS.maxExposureSol < DEFAULT_PARAMS.budgetSol ||
  DEFAULT_PARAMS.flushDrop <= 0 ||
  DEFAULT_PARAMS.flushDrop >= 1 ||
  DEFAULT_PARAMS.reclaimUp <= 0 ||
  DEFAULT_PARAMS.reclaimUp >= 1 ||
  DEFAULT_PARAMS.minRqSol <= 0 ||
  DEFAULT_PARAMS.minRqSol >= DEFAULT_PARAMS.maxRqSol ||
  DEFAULT_PARAMS.tp1 <= 0 ||
  DEFAULT_PARAMS.tp1 >= 1 ||
  DEFAULT_PARAMS.stopLoss <= 0 ||
  DEFAULT_PARAMS.stopLoss >= 1 ||
  DEFAULT_PARAMS.trail <= 0 ||
  DEFAULT_PARAMS.trail >= 1 ||
  DEFAULT_PARAMS.trailArm < 0 ||
  DEFAULT_PARAMS.trailArm >= 1 ||
  DEFAULT_PARAMS.minBuyers <= 0 ||
  DEFAULT_PARAMS.windowSlots <= 0 ||
  DEFAULT_PARAMS.flushWindowSlots < 0
) {
  console.error('gate: DEFAULT_PARAMS are inconsistent, refusing to run');
  process.exit(1);
}

console.error(
  `flush-reclaim starting: budget ${DEFAULT_PARAMS.budgetSol} SOL/coin, ` +
  `flush >= ${(DEFAULT_PARAMS.flushDrop * 100).toFixed(0)}%, ` +
  `TP +${(DEFAULT_PARAMS.tp1 * 100).toFixed(0)}% / trail ${(DEFAULT_PARAMS.trail * 100).toFixed(0)}% / SL -${(DEFAULT_PARAMS.stopLoss * 100).toFixed(0)}%`,
);

// Read-back assert: build the strategy once and verify it exposes the batch
// handler the shim will call, and that the parameters read back from
// DEFAULT_PARAMS still satisfy the size invariants the gates checked. This
// catches a strategy constructor that silently drops its handler before the
// first hello/batch arrives, without changing any trading behaviour.
const strategy = createStrategy(DEFAULT_PARAMS);
if (typeof strategy.onBatch !== 'function') {
  console.error('gate: createStrategy did not return an onBatch handler, refusing to run');
  process.exit(1);
}
const readBackBudgetLamports = BigInt(Math.round(DEFAULT_PARAMS.budgetSol * 1e9));
const readBackMinBuyLamports = BigInt(Math.round(DEFAULT_PARAMS.minBuySol * 1e9));
if (readBackBudgetLamports <= readBackMinBuyLamports || readBackMinBuyLamports <= 0n) {
  console.error('gate: read-back budget/min-buy lamports are inconsistent, refusing to run');
  process.exit(1);
}
console.error(
  `flush-reclaim read-back ok: budget ${readBackBudgetLamports} lamports, ` +
  `min-buy ${readBackMinBuyLamports} lamports, protocol ${PROTOCOL}`,
);

await runBot(strategy);
