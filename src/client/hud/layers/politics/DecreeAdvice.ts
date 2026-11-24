import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  DECREES,
  DecreeType,
  PoliticsViewState,
  ProposalView,
} from "@openfront/engine-api/game/Politics";
import type { GameView, PlayerView } from "../../../view";

/**
 * openfront v2: help for reading the world congress at a glance.
 * - An icon per decree.
 * - "Good / bad for you" with a one-line reason, worked out like the nations
 *   weigh decrees (engine: politics/PoliticsAI.decreeBenefit), but from the
 *   client's view of the game.
 * - A forecast of the vote: the nations' likely votes plus the votes cast.
 */

export const DECREE_ICONS: Record<DecreeType, string> = {
  [DecreeType.NuclearPeace]: "☮️",
  [DecreeType.MirvBan]: "🚫",
  [DecreeType.Disarmament]: "🧨",
  [DecreeType.GenevaConvention]: "🏥",
  [DecreeType.WarWeariness]: "😮‍💨",
  [DecreeType.Blitzkrieg]: "⚡",
  [DecreeType.NavalBan]: "⚓",
  [DecreeType.AmphibiousMoratorium]: "⛵",
  [DecreeType.SafeZone]: "🛡️",
  [DecreeType.Ceasefire]: "🕊️",
  [DecreeType.NuclearEscalation]: "☢️",
  [DecreeType.WorldBoom]: "📈",
  [DecreeType.Recession]: "📉",
  [DecreeType.FreeTrade]: "🚢",
  [DecreeType.Sanctions]: "⛔",
  [DecreeType.DevelopmentAid]: "🤝",
  [DecreeType.WealthTax]: "💸",
  [DecreeType.ArmsBoom]: "🏭",
  [DecreeType.AntiHegemony]: "⚖️",
  [DecreeType.MarshallPlan]: "🏗️",
  [DecreeType.CommonEnemy]: "🎯",
  [DecreeType.Bounty]: "💰",
  [DecreeType.NobelPrize]: "🏅",
  [DecreeType.Scapegoat]: "🐐",
  [DecreeType.AllianceLimit]: "✋",
  [DecreeType.DefensePact]: "🤜",
  [DecreeType.Neutrality]: "🏳️",
  [DecreeType.TotalEmbargo]: "🚷",
  [DecreeType.SpyScandal]: "🕵️",
  [DecreeType.Pandemic]: "🦠",
  [DecreeType.NaturalDisaster]: "🌋",
  [DecreeType.Rebellion]: "✊",
  [DecreeType.BlackMarket]: "🃏",
  [DecreeType.SecretDecree]: "❓",
};

export interface Advice {
  /** About −1 (very bad) to +1 (very good) for this player. */
  score: number;
  /** Translation key under politics_advice.* explaining why. */
  reason: string;
}

interface Context {
  leader: PlayerView | null;
  bottomThird: Set<number>;
  medianTiles: number;
  players: PlayerView[];
}

/** Humans and nations that take part in the congress. */
function voters(game: GameView): PlayerView[] {
  return game
    .players()
    .filter(
      (p) =>
        p.isAlive() &&
        p.numTilesOwned() > 0 &&
        (p.type() === PlayerType.Human || p.type() === PlayerType.Nation),
    );
}

function context(game: GameView, s: PoliticsViewState): Context {
  const players = voters(game);
  let leader: PlayerView | null = null;
  for (const p of players) {
    if (leader === null || p.numTilesOwned() > leader.numTilesOwned()) {
      leader = p;
    }
  }
  const tiles = players.map((p) => p.numTilesOwned()).sort((a, b) => a - b);
  return {
    leader,
    bottomThird: new Set(s.bottomThird ?? []),
    medianTiles: tiles.length === 0 ? 0 : tiles[Math.floor(tiles.length / 2)],
    players,
  };
}

function attacks(p: PlayerView, q: PlayerView): boolean {
  return p.outgoingAttacks().some((a) => a.targetID === q.smallID());
}

/** −1 (enemy) to +1 (ally), like the engine's stance, without relations. */
function stance(me: PlayerView, other: PlayerView): number {
  if (me === other) return 1;
  if (me.isFriendly(other)) return 0.8;
  if (attacks(other, me)) return -1;
  if (attacks(me, other)) return -0.7;
  return 0;
}

function isAttackingPlayers(game: GameView, p: PlayerView): boolean {
  return p.outgoingAttacks().some((a) => {
    if (a.targetID === 0) return false;
    const t = game.playerBySmallID(a.targetID);
    return t.isPlayer() && (t as PlayerView).type() !== PlayerType.Bot;
  });
}

function isUnderAttack(game: GameView, p: PlayerView): boolean {
  return p.incomingAttacks().some((a) => {
    const t = game.playerBySmallID(a.attackerID);
    return t.isPlayer() && (t as PlayerView).type() !== PlayerType.Bot;
  });
}

function has(p: PlayerView, type: UnitType): boolean {
  return p.units(type).length > 0;
}

function weigh(
  game: GameView,
  ctx: Context,
  me: PlayerView,
  decree: DecreeType,
  target: PlayerView | null,
): Advice {
  const small = me.numTilesOwned() < ctx.medianTiles;
  const isLeader = ctx.leader === me;
  const weak = ctx.bottomThird.has(me.smallID());
  const attacking = isAttackingPlayers(game, me);
  const attacked = isUnderAttack(game, me);
  const allied = me.alliances().length > 0;
  const info = DECREES[decree];
  const A = (score: number, reason: string): Advice => ({ score, reason });

  if (info.targeting !== "none" && target !== null) {
    if (target === me) {
      return info.malus ? A(-1, "aimed_at_you") : A(1, "for_you");
    }
    const s = stance(me, target);
    if (info.malus) {
      const leaderBonus = info.targeting === "leader" ? 0.3 : 0;
      const score = Math.max(-1, Math.min(1, -s * 0.8 + leaderBonus));
      return A(
        score,
        s > 0.5 ? "hurts_friend" : s < -0.5 ? "hurts_enemy" : "hurts_other",
      );
    }
    return A(
      s * 0.6 - 0.1,
      s > 0.5 ? "helps_friend" : s < -0.5 ? "helps_enemy" : "helps_other",
    );
  }

  // Aimed at a player nobody picked yet: it all depends on whom.
  if (info.targeting === "player") return A(0, "depends_on_target");

  const silo = has(me, UnitType.MissileSilo);
  switch (decree) {
    case DecreeType.NuclearPeace:
    case DecreeType.MirvBan:
      return silo
        ? A(-0.3, "you_have_silos")
        : A(small ? 0.5 : 0.2, "no_silos");
    case DecreeType.Disarmament:
      return silo ? A(-0.6, "you_have_silos") : A(0.4, "no_silos");
    case DecreeType.NuclearEscalation:
      return silo ? A(0.3, "you_have_silos") : A(-0.4, "no_silos");
    case DecreeType.GenevaConvention:
    case DecreeType.WarWeariness:
    case DecreeType.SafeZone:
    case DecreeType.Ceasefire:
      if (attacked) return A(0.6, "you_are_attacked");
      if (attacking) return A(-0.5, "you_are_attacking");
      return small ? A(0.3, "you_are_small") : A(-0.2, "you_are_big");
    case DecreeType.Blitzkrieg:
      if (attacking) return A(0.4, "you_are_attacking");
      return attacked ? A(-0.6, "you_are_attacked") : A(-0.1, "peace");
    case DecreeType.NavalBan:
      return has(me, UnitType.Warship)
        ? A(-0.4, "you_have_fleet")
        : A(0.2, "no_fleet");
    case DecreeType.AmphibiousMoratorium:
      return has(me, UnitType.TransportShip)
        ? A(-0.4, "you_have_boats")
        : A(small ? 0.2 : 0, "no_boats");
    case DecreeType.WorldBoom:
      return A(0.3, "more_gold");
    case DecreeType.Recession:
      return A(-0.4, "less_gold");
    case DecreeType.FreeTrade:
      return has(me, UnitType.Port)
        ? A(0.4, "you_have_ports")
        : A(-0.1, "no_ports");
    case DecreeType.DevelopmentAid:
    case DecreeType.MarshallPlan:
      return weak
        ? A(0.6, "you_are_weak")
        : isLeader
          ? A(-0.4, "you_lead")
          : A(-0.1, "helps_weak");
    case DecreeType.WealthTax: {
      const richer = ctx.players.filter((p) => p.gold() > me.gold()).length;
      return richer === 0
        ? A(-0.7, "you_are_richest")
        : weak
          ? A(0.5, "you_are_weak")
          : A(0, "neutral");
    }
    case DecreeType.ArmsBoom:
      return attacked || attacking ? A(0.3, "at_war") : A(0.1, "peace");
    case DecreeType.AllianceLimit:
      return me.alliances().length > 2
        ? A(-0.5, "many_alliances")
        : small
          ? A(-0.2, "you_are_small")
          : A(0.1, "neutral");
    case DecreeType.DefensePact:
      return allied ? A(0.4, "you_have_allies") : A(-0.3, "no_allies");
    case DecreeType.Neutrality:
      return allied
        ? A(-0.3, "you_have_allies")
        : attacked
          ? A(0.5, "you_are_attacked")
          : A(0.1, "no_allies");
    case DecreeType.SpyScandal:
      return allied ? A(-0.5, "you_have_allies") : A(0.3, "no_allies");
    case DecreeType.Pandemic:
      return isLeader
        ? A(-0.3, "you_lead")
        : small
          ? A(0.1, "you_are_small")
          : A(-0.2, "less_troops");
    case DecreeType.NaturalDisaster:
      return A(-0.2, "random_risk");
    case DecreeType.BlackMarket:
      return A(0, "random_risk");
    case DecreeType.SecretDecree:
      return A(-0.1, "random_risk");
    default:
      return A(0, "neutral");
  }
}

/** For decrees aimed at the leader the target is decided automatically. */
function targetOf(
  game: GameView,
  ctx: Context,
  decree: DecreeType,
  target: number | null,
): PlayerView | null {
  if (target !== null) {
    const p = game.playerBySmallID(target);
    return p.isPlayer() ? (p as PlayerView) : null;
  }
  return DECREES[decree].targeting === "leader" ? ctx.leader : null;
}

/** How good a decree would be for me (offers and ballots). */
export function adviceFor(
  game: GameView,
  s: PoliticsViewState,
  decree: DecreeType,
  target: number | null,
): Advice | null {
  const me = game.myPlayer();
  if (me === null) return null;
  const ctx = context(game, s);
  return weigh(game, ctx, me, decree, targetOf(game, ctx, decree, target));
}

export interface Forecast {
  yes: number;
  no: number;
  total: number;
  /** "likely" passes, "unlikely", or "open" (too close / no quorum yet). */
  verdict: "likely" | "unlikely" | "open";
  vetoed: boolean;
}

/**
 * The vote as it looks now: votes already cast count as they are; nations
 * that have not voted yet are assumed to vote like the congress AI (yes
 * above 0.15, no below −0.15); humans that have not voted abstain.
 */
export function forecast(
  game: GameView,
  s: PoliticsViewState,
  p: ProposalView,
): Forecast {
  const ctx = context(game, s);
  const target = targetOf(game, ctx, p.decree, p.target);
  const cast = new Map(p.votes);
  let yes = 0;
  let no = 0;
  let total = 0;
  let vetoed = false;
  for (const [id, weight] of s.weights) {
    total += weight;
    if (id === p.target) continue;
    const vote = cast.get(id);
    if (vote === "veto") vetoed = true;
    if (vote === "yes") yes += weight;
    else if (vote === "no") no += weight;
    else if (vote === undefined) {
      const voter = game.playerBySmallID(id);
      if (!voter.isPlayer()) continue;
      const pv = voter as PlayerView;
      if (pv.type() !== PlayerType.Nation) continue;
      const score = weigh(game, ctx, pv, p.decree, target).score;
      if (score > 0.15) yes += weight;
      else if (score < -0.15) no += weight;
    }
  }
  const quorum = total > 0 && (yes + no) / total >= 0.3;
  let verdict: Forecast["verdict"] = "open";
  if (vetoed) verdict = "unlikely";
  else if (quorum && yes > no * 1.15) verdict = "likely";
  else if (quorum && no >= yes) verdict = "unlikely";
  return { yes, no, total, verdict, vetoed };
}
