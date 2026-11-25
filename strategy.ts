// Flush-Reclaim: a pump.fun bonding-curve replay bot (agent-fun/replay/v2).
//
// The idea, earned from honest backtests on the kit's full dev window
// (2-3 Nov 2026, 24h, 1222 mints, 126801 trades):
//
//   - The house caps every buy at 1% of a curve's real SOL reserves, so a fresh
//     launch can only absorb dust. Size only becomes meaningful once a coin has
//     real reserves (rq >= ~15 SOL). Chasing fresh launches loses; so does
//     buying momentum highs (pilot momentum: -9.39 SOL) and buying dips without
//     confirmation (every dip variant backtested net negative).
//   - Most coins dump after their run: from the moment a coin first reaches
//     rq 20 SOL, the median end price is 0.36x its crossing price, but the
//     median PEAK is 1.59x. The money is in the bounce after the sellers are
//     done, not in holding to the end.
//   - So: enter a MATURE coin (rq 15-70 SOL) only after it flushed >= 30% off
//     its 5000-slot high AND reclaimed >= 5% off its 400-slot low on net buying
//     flow, with dispersed holders and no single whale dump. Then ACCUMULATE
//     1%-of-rq tranches while the price stays near the entry price, up to
//     1.5 SOL per coin. Exit on a ladder (sell half at +35%), a 20% trailing
//     stop armed at +15%, a 30% hard stop, a dev sell after entry, or staleness.
//     One entry per coin, ever.
//
// What does NOT work here (all measured on the same window, same engine):
//   - pilot momentum -9.39 SOL, pilot reversion -3.78 SOL, pilot sniper -0.49 SOL
//   - hold cash 0.00 SOL; house equal-weight baseline about -0.02 SOL
//   - flushes shallower than 30% (0.28 -> -1.24 SOL, 0.25 -> -2.3..-3.6 SOL):
//     the 30% depth is the edge, and it is a cliff, so the bot takes only deep
//     flushes and accepts trading just ~56 coins a day.
//
// Deterministic by construction: no clock, no randomness, no environment reads;
// iteration only over insertion-ordered maps fed by the batch stream. The two
// executions the grader runs must produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Minimum / maximum real SOL reserves at first entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Entry only after the price fell at least this much from its flush-window high. */
  flushDrop: number;
  /** Lookback in slots for the flush high; 0 = all-time high since creation. */
  flushWindowSlots: number;
  /** ...and then reclaimed at least this much off the window low. */
  reclaimUp: number;
  /** Lookback window in slots for the reclaim low and the net-flow signal. */
  windowSlots: number;
  /** Distinct non-dev buyers seen so far. */
  minBuyers: number;
  /** Net SOL flow (buys minus sells) over the window must be >= this (SOL). */
  minFlowSol: number;
  /** Skip coins whose dev already sold before entry. */
  skipDevSold: boolean;
  /** Exit a held coin if its dev sells after we entered. */
  exitOnDevSell: boolean;
  /** Largest single non-dev sell (bps of real reserves before it) that still allows entry. */
  maxBigSellBps: number;
  /** Total SOL cost budget per coin. */
  budgetSol: number;
  /** Smallest buy worth sending (SOL). */
  minBuySol: number;
  /** Slots to wait between adds on the same coin. */
  addDelay: number;
  /** Adds only while price <= first-buy price * (1 + addCeiling). */
  addCeiling: number;
  /** Adds only while price >= first-buy price * (1 + addFloor). */
  addFloor: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Sell this share of the position when value first reaches cost * (1 + tp1). */
  tp1: number;
  tp1Part: number;
  /** Hard stop: sell all when value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop: sell all when value falls this much below its best (fraction). */
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit after this many slots held (0 = no time exit). */
  maxHold: number;
  /** Exit if no trade on the coin for this many slots. */
  staleSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again (0 = never). */
  cooldown: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
}

// Settings chosen on the dev window with the kit's grid sweeps, preferring the
// middle of flat regions over single best cells (see README.md for the numbers).
export const DEFAULT_PARAMS: Params = {
  minRqSol: 15,
  maxRqSol: 70,
  flushDrop: 0.3,
  flushWindowSlots: 5000,
  reclaimUp: 0.05,
  windowSlots: 400,
  minBuyers: 12,
  minFlowSol: 0,
  skipDevSold: false,
  exitOnDevSell: true,
  maxBigSellBps: 4500,
  budgetSol: 1.5,
  minBuySol: 0.01,
  addDelay: 5,
  addCeiling: 0.5,
  addFloor: -0.1,
  buySlipBps: 10_000,
  tp1: 0.35,
  tp1Part: 0.5,
  stopLoss: 0.3,
  trail: 0.2,
  trailArm: 0.15,
  maxHold: 20000,
  staleSlots: 20000,
  cooldown: 0,
  maxExposureSol: 4,
};

const BPS = 10_000n;
const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
  vq: bigint;
  vt: bigint;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  /** Running high (vq/vt) since creation, as a ratio pair. */
  highVq: bigint;
  highVt: bigint;
  spent: bigint;
  buysSent: number;
  lastBuySlot: number;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  firstBuyVq: bigint;
  firstBuyVt: bigint;
  done: boolean;
  complete: boolean;
  coolUntil: number;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  tookTp1: boolean;
  devSoldAtOpen: boolean;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Bot {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  const budget = BigInt(Math.round(P.budgetSol * 1e9));
  const minBuy = BigInt(Math.round(P.minBuySol * 1e9));
  const maxExposure = BigInt(Math.round(P.maxExposureSol * 1e9));

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          highVq: BigInt(e.virtual_quote_reserves),
          highVt: BigInt(e.virtual_token_reserves),
          spent: 0n,
          buysSent: 0,
          lastBuySlot: 0,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          firstBuyVq: 0n,
          firstBuyVt: 1n,
          done: false,
          complete: false,
          coolUntil: -1,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        const vq = BigInt(e.virtual_sol_reserves);
        const vt = BigInt(e.virtual_token_reserves);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user, vq, vt });
        // Marginal price vq/vt: track the running high by cross-multiplication.
        if (vq * c.highVt > c.highVq * vt) { c.highVq = vq; c.highVt = vt; }
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev) c.devBuy += sol;
          else c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net flow and window high/low over the last windowSlots slots, plus the high
   *  over the (longer) flush lookback. Ticks are retained for the longer window. */
  function windowStats(c: Coin, slot: number): {
    net: bigint; highVq: bigint; highVt: bigint; lowVq: bigint; lowVt: bigint;
    flushHighVq: bigint; flushHighVt: bigint;
  } {
    const keep = Math.max(P.windowSlots, P.flushWindowSlots);
    const from = slot - keep;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    const shortFrom = slot - P.windowSlots;
    const flushFrom = P.flushWindowSlots > 0 ? slot - P.flushWindowSlots : -1;
    let net = 0n;
    let highVq = 0n;
    let highVt = 1n;
    let lowVq = 0n;
    let lowVt = 1n;
    let fhVq = 0n;
    let fhVt = 1n;
    for (const t of c.recent) {
      if (t.slot > shortFrom) {
        net += t.isBuy ? t.sol : -t.sol;
        if (highVq === 0n || t.vq * highVt > highVq * t.vt) { highVq = t.vq; highVt = t.vt; }
        if (lowVq === 0n || t.vq * lowVt < lowVq * t.vt) { lowVq = t.vq; lowVt = t.vt; }
      }
      if (flushFrom < 0 || t.slot > flushFrom) {
        if (fhVq === 0n || t.vq * fhVt > fhVq * t.vt) { fhVq = t.vq; fhVt = t.vt; }
      }
    }
    if (flushFrom < 0) { fhVq = c.highVq; fhVt = c.highVt; }
    return { net, highVq, highVt, lowVq, lowVt, flushHighVq: fhVq, flushHighVt: fhVt };
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  function sellOrders(mint: Pubkey, tokens: bigint, k: number, room: number): OrderInput[] {
    const n = BigInt(Math.max(1, Math.min(k, room)));
    const out: OrderInput[] = [];
    const piece = tokens / n;
    if (piece === 0n) return [{ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 }];
    for (let i = 0n; i < n; i++) {
      const amt = i === n - 1n ? tokens - piece * (n - 1n) : piece;
      out.push({ side: 'sell', mint, token_amount: amt, max_slippage_bps: 10_000 });
    }
    return out;
  }

  function buyOrders(mint: Pubkey, amount: bigint, k: number, room: number): OrderInput[] {
    let n = BigInt(Math.max(1, Math.min(k, room)));
    const minPiece = 2_000_000n;
    while (n > 1n && amount / n < minPiece) n -= 1n;
    const piece = amount / n;
    const out: OrderInput[] = [];
    for (let i = 0n; i < n; i++) {
      const amt = i === n - 1n ? amount - piece * (n - 1n) : piece;
      out.push({ side: 'buy', mint, quote_lamports: amt, max_slippage_bps: P.buySlipBps });
    }
    return out;
  }

  // price >= low * (1 + x)  <=>  vq/vt >= lowVq/lowVt * (10000 + xBps)/10000
  const aboveLow = (vq: bigint, vt: bigint, lowVq: bigint, lowVt: bigint, xBps: number) =>
    vq * lowVt * 10_000n >= lowVq * vt * BigInt(10_000 + xBps);

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n, tookTp1: false, devSoldAtOpen: coins.get(f.mint)?.devSold ?? false });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }
      const k = 1;

      // ---- Exits first. ----
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, tookTp1: false, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          // Take-profit ladder: sell tp1Part at +tp1, then trail the rest.
          if (!h.tookTp1 && value * 10_000n >= basis * BigInt(Math.round((1 + P.tp1) * 10_000))) {
            const part = (pos.token_amount * BigInt(Math.round(P.tp1Part * 10_000))) / 10_000n;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0n;
              continue;
            }
          }
          if (value * 10_000n <= basis * BigInt(Math.round((1 - P.stopLoss) * 10_000))) exit = true;
          if (h.best * 10_000n >= basis * BigInt(Math.round((1 + P.trailArm) * 10_000)) &&
              value * 10_000n <= h.best * BigInt(Math.round((1 - P.trail) * 10_000))) exit = true;
        }
        if (P.maxHold > 0 && state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push(...sellOrders(mint, pos.token_amount, k, cap - orders.length));
        selling.add(mint);
        if (c !== undefined) {
          c.done = P.cooldown === 0;
          c.coolUntil = P.cooldown === 0 ? -1 : state.slot + P.cooldown;
        }
      }

      // ---- Entries and adds. ----
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      let exposure = 0n;
      for (const [, pos] of state.positions) exposure += pos.cost_lamports;

      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        if (state.slot < c.coolUntil) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const rq = curve.real_quote_reserves;
        const isAdd = c.buysSent > 0;
        if (isAdd) {
          if (!state.positions.has(c.mint) || selling.has(c.mint) || hasPendingBuy(state, c.mint)) continue;
          if (state.slot - c.lastBuySlot < P.addDelay) continue;
          // Accumulate only while the price is still near the entry price:
          // never chase a run that already left, never add into a dump.
          if (c.firstBuyVq > 0n) {
            if (!aboveLow(vq, vt, c.firstBuyVq, c.firstBuyVt, Math.round(P.addFloor * 10_000))) continue;
            if (vq * c.firstBuyVt * 10_000n > c.firstBuyVq * vt * BigInt(Math.round((1 + P.addCeiling) * 10_000))) continue;
          }
          const room = budget - c.spent;
          if (room < minBuy) continue;
          const maxBuy = state.maxBuyLamports(c.mint);
          const amount = room < maxBuy ? room : maxBuy;
          if (amount < minBuy || free < amount + tx * 6n) continue;
          if (exposure + amount > maxExposure) continue;
          const add = buyOrders(c.mint, amount, k, cap - orders.length);
          orders.push(...add);
          free -= amount + tx * BigInt(add.length);
          exposure += amount;
          c.buysSent += 1;
          c.spent += amount;
          c.lastBuyVq = vq;
          c.lastBuyVt = vt;
          c.lastBuySlot = state.slot;
          continue;
        }
        // First entry: a mature coin whose sellers are exhausted (flushed from
        // its high, dispersed holders, net buying flow) and whose price just
        // reclaimed off the window low.
        if (open >= state.hello.caps.max_open_positions) continue;
        if (rq < BigInt(Math.round(P.minRqSol * 1e9)) || rq > BigInt(Math.round(P.maxRqSol * 1e9))) continue;
        if (c.buyers.size < P.minBuyers) continue;
        if (c.bigSellBps > BigInt(P.maxBigSellBps)) continue;
        if (c.devSold && P.skipDevSold) { c.done = true; continue; }
        const ws = windowStats(c, state.slot);
        if (ws.net < BigInt(Math.round(P.minFlowSol * 1e9))) continue;
        // Flushed: price now at least flushDrop below its flush-window high.
        if (vq * ws.flushHighVt * 10_000n > ws.flushHighVq * vt * BigInt(Math.round((1 - P.flushDrop) * 10_000))) continue;
        // Reclaimed: price now at least reclaimUp above the window low.
        if (!aboveLow(vq, vt, ws.lowVq, ws.lowVt, Math.round(P.reclaimUp * 10_000))) continue;
        const room = budget - c.spent;
        if (room < minBuy) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx * 6n) continue;
        if (exposure + amount > maxExposure) continue;
        const buys = buyOrders(c.mint, amount, k, cap - orders.length);
        orders.push(...buys);
        free -= amount + tx * BigInt(buys.length);
        exposure += amount;
        c.buysSent += 1;
        c.spent += amount;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        c.lastBuySlot = state.slot;
        if (c.firstBuyVq === 0n) { c.firstBuyVq = vq; c.firstBuyVt = vt; }
        open += 1;
      }
      return orders;
    },
  };
}
