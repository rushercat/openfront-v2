import { draftDeckOf, draftFactor } from "@openfront/engine-api/game/Draft";
import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  decreeEffect,
  DecreeType,
  PoliticsFactor,
} from "@openfront/engine-api/game/Politics";
import { renderNumber, renderTroops } from "@openfront/engine-lib/Format";
import { structureHealthFraction } from "@openfront/engine-lib/game/UnitHealth";
import { translateText } from "../Utils";
import type { GameView } from "../view/GameView";
import type { PlayerView } from "../view/PlayerView";

/**
 * openfront v2: "why is my income what it is?" Splits troop growth and gold
 * income into the factors the engine multiplies together (capital, unrest,
 * damaged cities, decrees, draft perks), for the tooltips on the control
 * panel and the savings estimate on the hotbar.
 */

export type Tone = "pos" | "neg" | "info";

export interface BreakdownLine {
  label: string;
  value: string;
  tone: Tone;
}

export interface Breakdown {
  lines: BreakdownLine[];
  /** Per second. */
  total: number;
}

/** A multiplier as "+25 %" / "−30 %". */
function pct(factor: number): string {
  const p = Math.round((factor - 1) * 100);
  return `${p >= 0 ? "+" : "−"}${Math.abs(p)} %`;
}

function factorLine(label: string, factor: number): BreakdownLine | null {
  if (Math.abs(factor - 1) < 0.005) return null;
  return { label, value: pct(factor), tone: factor > 1 ? "pos" : "neg" };
}

function decreeName(decree: DecreeType): string {
  return translateText(`politics.decree.${decree}`);
}

/** One line per decree in force that changes this kind for the player. */
function decreeLines(
  game: GameView,
  player: PlayerView,
  pick: (e: { gold: number; troops: number; trade: number }) => number,
): BreakdownLine[] {
  const politics = game.politics();
  if (politics === null) return [];
  const weak = new Set(politics.bottomThird ?? []).has(player.smallID());
  const out: BreakdownLine[] = [];
  for (const d of politics.active) {
    const hidden = d.secret && game.ticks() < d.revealTick;
    const e = decreeEffect(d.decree, d.target, player.smallID(), weak);
    const line = factorLine(
      `📜 ${
        hidden ? translateText("income.secret_decree") : decreeName(d.decree)
      }`,
      pick(e),
    );
    if (line !== null) out.push(line);
  }
  return out;
}

function draftLine(
  game: GameView,
  player: PlayerView,
  kind: PoliticsFactor,
): BreakdownLine | null {
  const deck = draftDeckOf(game.draft(), player.smallID());
  if (deck === null || deck.size === 0) return null;
  return factorLine(
    `🃏 ${translateText("income.draft")}`,
    draftFactor(deck, kind),
  );
}

function capitalUnrestLines(
  game: GameView,
  player: PlayerView,
  bonusPercent: number,
): BreakdownLine[] {
  const config = game.config();
  const out: BreakdownLine[] = [];
  if (config.hasCapital(player)) {
    out.push({
      label: `👑 ${translateText("income.capital")}`,
      value: `+${bonusPercent} %`,
      tone: "pos",
    });
  }
  const share = player.unrestShare();
  if (share > 0.005) {
    const line = factorLine(
      `🔥 ${translateText("income.unrest", {
        percent: Math.round(share * 100),
      })}`,
      1 - config.unrestMaxPenalty() * share,
    );
    if (line !== null) out.push(line);
  }
  return out;
}

/** Troop growth per second, split up like Config.troopIncreaseRate. */
export function troopBreakdown(game: GameView, player: PlayerView): Breakdown {
  const config = game.config();
  const troops = player.troops();
  const max = Math.max(1, config.maxTroops(player));
  const base = (10 + Math.pow(troops, 0.73) / 4) * 10;
  const lines: BreakdownLine[] = [
    {
      label: translateText("income.troop_base"),
      value: `+${renderTroops(base)}/s`,
      tone: "info",
    },
  ];
  const fill = troops / max;
  const fillLine = factorLine(
    translateText("income.troop_fill", { percent: Math.round(fill * 100) }),
    1 - fill,
  );
  if (fillLine !== null) lines.push(fillLine);
  const damaged = factorLine(
    `🏚️ ${translateText("income.damaged_cities")}`,
    config.damagedCityRegenFactor(player),
  );
  if (damaged !== null) lines.push(damaged);
  lines.push(
    ...capitalUnrestLines(game, player, config.capitalTroopBonusPercent()),
  );
  lines.push(...decreeLines(game, player, (e) => e.troops));
  const draft = draftLine(game, player, PoliticsFactor.TroopGrowth);
  if (draft !== null) lines.push(draft);
  return { lines, total: config.troopIncreaseRate(player) * 10 };
}

/**
 * Keeps the trade and train gold of the last minute, to show trade income
 * as a rate next to the fixed income. One per game, sampled every tick by
 * whoever asks first.
 */
export class TradeRateTracker {
  private samples: { tick: number; gold: number }[] = [];

  sample(tick: number, player: PlayerView): void {
    const last = this.samples[this.samples.length - 1];
    if (last !== undefined && last.tick === tick) return;
    const gold = player.tradeGold() + player.trainGold();
    this.samples.push({ tick, gold });
    // 60 s of history at 10 ticks a second.
    while (this.samples.length > 0 && tick - this.samples[0].tick > 600) {
      this.samples.shift();
    }
  }

  /** Trade and train gold per second over the kept window. */
  perSecond(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const seconds = (last.tick - first.tick) / 10;
    if (seconds <= 0) return 0;
    return Math.max(0, (last.gold - first.gold) / seconds);
  }
}

const trackers = new WeakMap<GameView, TradeRateTracker>();

export function tradeTracker(game: GameView): TradeRateTracker {
  let t = trackers.get(game);
  if (t === undefined) {
    t = new TradeRateTracker();
    trackers.set(game, t);
  }
  const me = game.myPlayer();
  if (me !== null) t.sample(game.ticks(), me);
  return t;
}

/** Gold per second, split up like EngineConfig.goldAdditionRate & co. */
export function goldBreakdown(game: GameView, player: PlayerView): Breakdown {
  const config = game.config();
  const multiplier = config.gameConfig().goldMultiplier ?? 1;
  const base = (player.type() === PlayerType.Bot ? 50 : 100) * 10 * multiplier;
  let factoryRate = 0;
  for (const f of player.units(UnitType.Factory)) {
    if (f.isUnderConstruction()) continue;
    factoryRate +=
      50 * 10 * f.level() * structureHealthFraction(f) * multiplier;
  }
  let factor = 1;
  if (config.hasCapital(player)) {
    factor *= 1 + config.capitalGoldBonusPercent() / 100;
  }
  factor *= 1 - config.unrestMaxPenalty() * player.unrestShare();
  factor *= player.politicsFactor(PoliticsFactor.GoldIncome);

  const lines: BreakdownLine[] = [
    {
      label: translateText("income.gold_base"),
      value: `+${renderNumber(BigInt(Math.round(base)))}/s`,
      tone: "info",
    },
  ];
  if (factoryRate > 0) {
    lines.push({
      label: `🏭 ${translateText("income.factories")}`,
      value: `+${renderNumber(BigInt(Math.round(factoryRate)))}/s`,
      tone: "info",
    });
  }
  lines.push(
    ...capitalUnrestLines(game, player, config.capitalGoldBonusPercent()),
  );
  lines.push(...decreeLines(game, player, (e) => e.gold));
  const draft = draftLine(game, player, PoliticsFactor.GoldIncome);
  if (draft !== null) lines.push(draft);

  const trade = tradeTracker(game).perSecond();
  if (trade > 0) {
    lines.push({
      label: `🚢 ${translateText("income.trade")}`,
      value: `+${renderNumber(BigInt(Math.round(trade)))}/s`,
      tone: "info",
    });
  }
  // Trade-only decrees (free trade, sanctions) matter once there is trade.
  for (const line of decreeLines(game, player, (e) => e.trade)) {
    lines.push({
      ...line,
      label: `${line.label} (${translateText("income.trade_only")})`,
    });
  }
  return { lines, total: (base + factoryRate) * factor + trade };
}
