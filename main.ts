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
if (
  DEFAULT_PARAMS.budgetSol <= DEFAULT_PARAMS.minBuySol ||
  DEFAULT_PARAMS.maxExposureSol < DEFAULT_PARAMS.budgetSol ||
  DEFAULT_PARAMS.flushDrop <= 0 ||
  DEFAULT_PARAMS.flushDrop >= 1
) {
  console.error('gate: DEFAULT_PARAMS are inconsistent, refusing to run');
  process.exit(1);
}

console.error(
  `flush-reclaim starting: budget ${DEFAULT_PARAMS.budgetSol} SOL/coin, ` +
  `flush >= ${(DEFAULT_PARAMS.flushDrop * 100).toFixed(0)}%, ` +
  `TP +${(DEFAULT_PARAMS.tp1 * 100).toFixed(0)}% / trail ${(DEFAULT_PARAMS.trail * 100).toFixed(0)}% / SL -${(DEFAULT_PARAMS.stopLoss * 100).toFixed(0)}%`,
);

await runBot(createStrategy(DEFAULT_PARAMS));
