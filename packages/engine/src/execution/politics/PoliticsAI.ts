import {
  PlayerType,
  Relation,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { DECREES, DecreeType } from "@openfront/engine-api/game/Politics";
import { Game, Player } from "../../game/Game";

/** What a nation looks at when it weighs a decree. */
export interface PoliticsContext {
  game: Game;
  /** The player with the most land (taking part in the congress). */
  leader: Player | null;
  /** Small ids of the smallest third. */
  bottomThird: ReadonlySet<number>;
  medianTiles: number;
}

/** How the nation stands towards another player, −1 (enemy) to +1 (ally). */
function stance(nation: Player, other: Player): number {
  if (nation === other) return 1;
  if (nation.isFriendly(other)) return 0.8;
  const attacking = (p: Player, q: Player) =>
    p.outgoingAttacks().some((a) => a.target() === q);
  if (attacking(other, nation)) return -1;
  if (attacking(nation, other)) return -0.7;
  switch (nation.relation(other)) {
    case Relation.Hostile:
      return -0.6;
    case Relation.Distrustful:
      return -0.3;
    case Relation.Friendly:
      return 0.4;
    default:
      return 0;
  }
}

function isAttackingPlayers(p: Player): boolean {
  return p
    .outgoingAttacks()
    .some(
      (a) =>
        a.target().isPlayer() &&
        (a.target() as Player).type() !== PlayerType.Bot,
    );
}

function isUnderAttack(p: Player): boolean {
  return p
    .incomingAttacks()
    .some((a) => a.attacker().type() !== PlayerType.Bot);
}

function has(p: Player, type: UnitType): boolean {
  return p.units(type).length > 0;
}

/**
 * How good a decree is for a nation, about −1 (very bad) to +1 (very good).
 * Nations vote yes above 0.15 and no below −0.15, and put forward their best
 * offer when it scores 0.3 or more. `target` is the decree's target (for
 * leader decrees, the leader).
 */
export function decreeBenefit(
  ctx: PoliticsContext,
  nation: Player,
  decree: DecreeType,
  target: Player | null,
): number {
  const small = nation.numTilesOwned() < ctx.medianTiles;
  const isLeader = ctx.leader === nation;
  const weak = ctx.bottomThird.has(nation.smallID());
  const attacking = isAttackingPlayers(nation);
  const attacked = isUnderAttack(nation);
  const allied = nation.alliances().length > 0;
  const info = DECREES[decree];

  // Decrees aimed at one player: how the nation feels about them decides.
  if (info.targeting !== "none" && target !== null) {
    if (target === nation) return info.malus ? -1 : 1;
    const s = stance(nation, target);
    if (info.malus) {
      // Against the leader everyone else gains a little anyway.
      const leaderBonus = info.targeting === "leader" ? 0.3 : 0;
      return Math.max(-1, Math.min(1, -s * 0.8 + leaderBonus));
    }
    // Nobel prize: good for friends, bad for enemies.
    return s * 0.6 - 0.1;
  }

  switch (decree) {
    case DecreeType.NuclearPeace:
    case DecreeType.MirvBan:
      return has(nation, UnitType.MissileSilo) ? -0.3 : small ? 0.5 : 0.2;
    case DecreeType.Disarmament:
      return has(nation, UnitType.MissileSilo) ? -0.6 : 0.4;
    case DecreeType.NuclearEscalation:
      return has(nation, UnitType.MissileSilo) ? 0.3 : -0.4;
    case DecreeType.GenevaConvention:
    case DecreeType.WarWeariness:
    case DecreeType.SafeZone:
    case DecreeType.Ceasefire:
      if (attacked) return 0.6;
      if (attacking) return -0.5;
      return small ? 0.3 : -0.2;
    case DecreeType.Blitzkrieg:
      if (attacking) return 0.4;
      return attacked ? -0.6 : -0.1;
    case DecreeType.NavalBan:
      return has(nation, UnitType.Warship) ? -0.4 : 0.2;
    case DecreeType.AmphibiousMoratorium:
      return has(nation, UnitType.TransportShip) ? -0.4 : small ? 0.2 : 0;
    case DecreeType.WorldBoom:
      return 0.3;
    case DecreeType.Recession:
      return -0.4;
    case DecreeType.FreeTrade:
      return has(nation, UnitType.Port) ? 0.4 : -0.1;
    case DecreeType.DevelopmentAid:
    case DecreeType.MarshallPlan:
      return weak ? 0.6 : isLeader ? -0.4 : -0.1;
    case DecreeType.WealthTax: {
      const rich = ctx.game
        .players()
        .filter((p) => p.gold() > nation.gold()).length;
      return rich === 0 ? -0.7 : weak ? 0.5 : 0;
    }
    case DecreeType.ArmsBoom:
      return attacked || attacking ? 0.3 : 0.1;
    case DecreeType.AllianceLimit:
      return nation.alliances().length > 2 ? -0.5 : small ? -0.2 : 0.1;
    case DecreeType.DefensePact:
      return allied ? 0.4 : -0.3;
    case DecreeType.Neutrality:
      return allied ? -0.3 : attacked ? 0.5 : 0.1;
    case DecreeType.SpyScandal:
      return allied ? -0.5 : 0.3;
    case DecreeType.Pandemic:
      return isLeader ? -0.3 : small ? 0.1 : -0.2;
    case DecreeType.NaturalDisaster:
      return -0.2;
    case DecreeType.BlackMarket:
      return 0;
    case DecreeType.SecretDecree:
      return -0.1;
    default:
      return 0;
  }
}
