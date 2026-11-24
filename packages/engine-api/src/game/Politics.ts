/**
 * openfront v2: the world congress (GameFeature.Politics).
 *
 * Every few minutes a congress round runs:
 * 1. Proposing (the game keeps running): every player who wants to is
 *    offered three random decrees and puts one of them forward, paying a
 *    share of their gold (Config.politicsProposalCostPercent).
 * 2. Voting (the game is frozen): everyone votes yes, no, abstain or veto on
 *    every proposal. A veto alone sinks a proposal but costs a share of the
 *    vetoing player's gold (Config.politicsVetoCostPercent).
 * 3. The proposals that pass go into force, at most politicsMaxActive decrees
 *    at a time.
 *
 * Voting weight = √(tiles) + politicsGoldWeight × √(gold / 1000), halved for
 * traitors, frozen when the vote starts.
 */

export enum DecreeType {
  // Military & war
  NuclearPeace = "nuclear_peace",
  MirvBan = "mirv_ban",
  Disarmament = "disarmament",
  GenevaConvention = "geneva_convention",
  WarWeariness = "war_weariness",
  Blitzkrieg = "blitzkrieg",
  NavalBan = "naval_ban",
  AmphibiousMoratorium = "amphibious_moratorium",
  SafeZone = "safe_zone",
  Ceasefire = "ceasefire",
  NuclearEscalation = "nuclear_escalation",
  // Economy
  WorldBoom = "world_boom",
  Recession = "recession",
  FreeTrade = "free_trade",
  Sanctions = "sanctions",
  DevelopmentAid = "development_aid",
  WealthTax = "wealth_tax",
  ArmsBoom = "arms_boom",
  // Leaders down, the weak up
  AntiHegemony = "anti_hegemony",
  MarshallPlan = "marshall_plan",
  CommonEnemy = "common_enemy",
  Bounty = "bounty",
  NobelPrize = "nobel_prize",
  Scapegoat = "scapegoat",
  // Diplomacy & alliances
  AllianceLimit = "alliance_limit",
  DefensePact = "defense_pact",
  Neutrality = "neutrality",
  TotalEmbargo = "total_embargo",
  SpyScandal = "spy_scandal",
  // Chaos & wildcards
  Pandemic = "pandemic",
  NaturalDisaster = "natural_disaster",
  Rebellion = "rebellion",
  BlackMarket = "black_market",
  SecretDecree = "secret_decree",
}

export enum DecreeCategory {
  Military = "military",
  Economy = "economy",
  Leaders = "leaders",
  Diplomacy = "diplomacy",
  Chaos = "chaos",
}

/**
 * Who a decree is aimed at: nobody, a player the proposer picks, or the
 * player with the most land when it is proposed.
 */
export type DecreeTargeting = "none" | "player" | "leader";

export interface DecreeInfo {
  category: DecreeCategory;
  targeting: DecreeTargeting;
  /** It hurts its target: the anti-mobbing rules apply (see Politics). */
  malus: boolean;
  /** It happens once when passed instead of staying in force. */
  oneTime: boolean;
  /** How long it stays in force, in seconds (ignored for oneTime). */
  durationSeconds: number;
}

const D = (
  category: DecreeCategory,
  targeting: DecreeTargeting = "none",
  malus = false,
  oneTime = false,
  durationSeconds = 180,
): DecreeInfo => ({ category, targeting, malus, oneTime, durationSeconds });

const M = DecreeCategory.Military;
const E = DecreeCategory.Economy;
const L = DecreeCategory.Leaders;
const P = DecreeCategory.Diplomacy;
const C = DecreeCategory.Chaos;

export const DECREES: Readonly<Record<DecreeType, DecreeInfo>> = {
  [DecreeType.NuclearPeace]: D(M),
  [DecreeType.MirvBan]: D(M),
  [DecreeType.Disarmament]: D(M),
  [DecreeType.GenevaConvention]: D(M),
  [DecreeType.WarWeariness]: D(M),
  [DecreeType.Blitzkrieg]: D(M),
  [DecreeType.NavalBan]: D(M),
  [DecreeType.AmphibiousMoratorium]: D(M),
  [DecreeType.SafeZone]: D(M),
  [DecreeType.Ceasefire]: D(M, "none", false, false, 120),
  [DecreeType.NuclearEscalation]: D(M),
  [DecreeType.WorldBoom]: D(E),
  [DecreeType.Recession]: D(E),
  [DecreeType.FreeTrade]: D(E),
  [DecreeType.Sanctions]: D(E, "player", true),
  [DecreeType.DevelopmentAid]: D(E),
  [DecreeType.WealthTax]: D(E),
  [DecreeType.ArmsBoom]: D(E),
  [DecreeType.AntiHegemony]: D(L, "leader", true),
  [DecreeType.MarshallPlan]: D(L),
  [DecreeType.CommonEnemy]: D(L, "leader", true),
  [DecreeType.Bounty]: D(L, "leader", true),
  [DecreeType.NobelPrize]: D(L, "player"),
  [DecreeType.Scapegoat]: D(L, "player", true),
  [DecreeType.AllianceLimit]: D(P),
  [DecreeType.DefensePact]: D(P),
  [DecreeType.Neutrality]: D(P),
  [DecreeType.TotalEmbargo]: D(P, "player", true),
  [DecreeType.SpyScandal]: D(P, "none", false, true),
  [DecreeType.Pandemic]: D(C),
  [DecreeType.NaturalDisaster]: D(C, "none", false, true),
  [DecreeType.Rebellion]: D(C, "leader", true, true),
  [DecreeType.BlackMarket]: D(C),
  [DecreeType.SecretDecree]: D(C),
};

export const ALL_DECREES: readonly DecreeType[] = Object.values(DecreeType);

/** What a decree can scale on a player (PlayerLike.politicsFactor). */
export enum PoliticsFactor {
  /** Passive gold and factory gold. */
  GoldIncome = "gold_income",
  /** Gold from trade ships and trains (includes GoldIncome). */
  TradeGold = "trade_gold",
  /** Troop growth. */
  TroopGrowth = "troop_growth",
}

export type VoteChoice = "yes" | "no" | "abstain" | "veto";

export type PoliticsPhase = "idle" | "proposing" | "voting";

export type DecreeOutcome =
  | "passed"
  | "failed"
  | "vetoed"
  | "no_quorum"
  | "no_slot";

/** Player references are small ids throughout. */
export interface ProposalView {
  id: number;
  decree: DecreeType;
  proposer: number;
  target: number | null;
  votes: [number, VoteChoice][];
}

export interface ActiveDecreeView {
  id: number;
  decree: DecreeType;
  target: number | null;
  startTick: number;
  endTick: number;
  /** Passed as a secret decree: shown as unknown until revealTick. */
  secret: boolean;
  revealTick: number;
  /** Black market: the unit types whose price changed and by how much. */
  prices: [string, number][];
}

export interface DecreeResultView {
  proposalId: number;
  decree: DecreeType;
  proposer: number;
  target: number | null;
  outcome: DecreeOutcome;
  yes: number;
  no: number;
  total: number;
  votes: [number, VoteChoice][];
}

export interface PoliticsViewState {
  phase: PoliticsPhase;
  /** First tick of the current phase, and the tick it ends (exclusive). */
  phaseStart: number;
  phaseEnd: number;
  /** When the next round may start (it waits for a free slot). */
  nextRoundTick: number;
  /** The game is frozen for ticks in [freezeStart, freezeEnd). */
  freezeStart: number | null;
  freezeEnd: number | null;
  /** The three decrees each player is offered this round. */
  offers: [number, DecreeType[]][];
  proposals: ProposalView[];
  /** Voting weights, fixed when the vote started. */
  weights: [number, number][];
  active: ActiveDecreeView[];
  results: DecreeResultView[];
  resultsTick: number;
  /** Small id of the last player a malus decree hit (not again next). */
  lastMalusTarget: number | null;
  /** Small ids of the smallest third (development aid, Marshall plan). */
  bottomThird?: number[];
}

/** What one decree in force does to one player's income and growth. */
export interface DecreeEffect {
  gold: number;
  troops: number;
  /** Extra factor on trade gold only (on top of gold). */
  trade: number;
}

/**
 * The effect of one decree on the player `id` (1 = unaffected). Shared by
 * the engine (PoliticsExecution.factor) and the client's income breakdown,
 * so both always agree.
 */
export function decreeEffect(
  decree: DecreeType,
  target: number | null,
  id: number,
  inBottomThird: boolean,
): DecreeEffect {
  const e: DecreeEffect = { gold: 1, troops: 1, trade: 1 };
  switch (decree) {
    case DecreeType.WorldBoom:
      e.gold = 1.25;
      break;
    case DecreeType.Recession:
      e.gold = 0.8;
      break;
    case DecreeType.DevelopmentAid:
      if (inBottomThird) e.gold = 1.5;
      break;
    case DecreeType.NobelPrize:
      if (target === id) {
        e.gold = 1.25;
        e.troops = 1.25;
      }
      break;
    case DecreeType.Scapegoat:
      if (target === id) {
        e.gold = 0.8;
        e.troops = 0.8;
      }
      break;
    case DecreeType.FreeTrade:
      e.trade = 1.5;
      break;
    case DecreeType.Sanctions:
      if (target === id) e.trade = 0;
      break;
    case DecreeType.AntiHegemony:
      if (target === id) e.troops = 0.7;
      break;
    case DecreeType.MarshallPlan:
      if (inBottomThird) e.troops = 1.3;
      break;
    case DecreeType.Pandemic:
      e.troops = 0.7;
      break;
  }
  return e;
}

/** The combined factor of all decrees in force for one player. */
export function decreeFactor(
  decrees: readonly { decree: DecreeType; target: number | null }[],
  id: number,
  bottomThird: { has(id: number): boolean },
  kind: PoliticsFactor,
): number {
  let gold = 1;
  let troops = 1;
  let trade = 1;
  const weak = bottomThird.has(id);
  for (const d of decrees) {
    const e = decreeEffect(d.decree, d.target, id, weak);
    gold *= e.gold;
    troops *= e.troops;
    trade *= e.trade;
  }
  switch (kind) {
    case PoliticsFactor.GoldIncome:
      return gold;
    case PoliticsFactor.TradeGold:
      return gold * trade;
    case PoliticsFactor.TroopGrowth:
      return troops;
  }
}

/** Whether a frozen-tick window covers `tick` (an executed tick). */
export function politicsFrozenAt(
  state: Pick<PoliticsViewState, "freezeStart" | "freezeEnd"> | null,
  tick: number,
): boolean {
  if (state === null || state.freezeStart === null) return false;
  if (tick < state.freezeStart) return false;
  return state.freezeEnd === null || tick < state.freezeEnd;
}
