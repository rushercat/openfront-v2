import { AirTargets, UnitType } from "@openfront/engine-api/game/GameTypes";
import { zRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, isUnit, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { AAMissileExecution } from "./AAMissileExecution";
import { threatens } from "./AirMovement";

/**
 * An AA Defense: the SAM launcher's counterpart against aircraft. It holds
 * one missile per level, reloads each in aaDefenseCooldown ticks, and fires
 * at the nearest enemy aircraft in aaDefenseRange that threatens its owner
 * (see threatens(): over their land, or attacking one of their units), not
 * at a neighbor's aircraft minding its own side of the border.
 *
 * It does not spend more missiles on an aircraft than it takes to shoot it
 * down, counting every AA missile already on its way to it, whoever fired
 * it: two AA guns covering the same plane used to fire a full salvo each and
 * hit it with twice the damage it took to bring it down.
 */
export class AADefenseExecution implements Execution {
  private mg: Game;
  private active: boolean = true;

  constructor(private aa: Unit) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (!this.aa.isActive()) {
      this.active = false;
      return;
    }
    if (this.aa.isUnderConstruction()) {
      return;
    }

    const config = this.mg.config();
    const queue = this.aa.missileTimerQueue();
    while (
      queue.length > 0 &&
      this.mg.ticks() - queue[0] >= config.aaDefenseCooldown()
    ) {
      this.aa.reloadMissile();
    }

    if (this.aa.isInCooldown()) {
      return;
    }
    // A stacked gun fires its missiles one after another, not all at once.
    // The newest entry of the queue is its last launch (or an upgrade).
    if (
      queue.length > 0 &&
      this.mg.ticks() - queue[queue.length - 1] < config.aaDefenseSalvoSpacing()
    ) {
      return;
    }
    // No aircraft anywhere: skip the grid query (unitCount is memoised).
    if (
      this.mg.unitCount(UnitType.FighterJet) === 0 &&
      this.mg.unitCount(UnitType.Bomber) === 0 &&
      this.mg.unitCount(UnitType.TransportPlane) === 0
    ) {
      return;
    }

    const owner = this.aa.owner();
    const targets = this.mg
      .nearbyUnits(
        this.aa.tile(),
        config.aaDefenseRange(),
        AirTargets.types,
        ({ unit }) =>
          isUnit(unit) &&
          unit.owner() !== owner &&
          owner.canAttackPlayer(unit.owner(), true) &&
          threatens(this.mg, unit, owner),
      )
      .sort(
        (a, b) => a.distSquared - b.distSquared || a.unit.id() - b.unit.id(),
      );
    if (targets.length === 0) {
      return;
    }

    const damage = config.aaMissileDamage();
    const incoming = incomingAADamage(this.mg);
    for (const { unit } of targets) {
      const pending = incoming.get(unit) ?? 0;
      if (pending >= unit.health()) {
        continue;
      }
      this.aa.launch();
      // Built right away (not in the missile's init) so every other AA gun
      // ticking after this one already counts it.
      const missile = owner.buildUnit(UnitType.SAMMissile, this.aa.tile(), {
        targetUnit: unit,
      });
      incoming.set(unit, pending + damage);
      this.mg.addExecution(
        new AAMissileExecution(this.aa.tile(), owner, unit, missile),
      );
      // One missile per salvo step (aaDefenseSalvoSpacing).
      break;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AADefenseExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      aa: w.unit(this.aa),
    });
  }

  restoreSnapshot(s: AADefenseState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.aa = r.unit(s.aa);
  }
}

/**
 * Damage the AA missiles in the air will still deal, per aircraft. Read off
 * the missile units themselves (a SAM launcher's missiles chase nukes, which
 * are no air targets), so it needs no state of its own and holds across
 * every AA Defense and carrier.
 */
function incomingAADamage(mg: Game): Map<Unit, number> {
  const damage = mg.config().aaMissileDamage();
  const incoming = new Map<Unit, number>();
  for (const missile of mg.units(UnitType.SAMMissile)) {
    if (!missile.isActive() || missile.reachedTarget()) continue;
    const target = missile.targetUnit();
    if (
      target === undefined ||
      !target.isActive() ||
      !AirTargets.has(target.type())
    ) {
      continue;
    }
    incoming.set(target, (incoming.get(target) ?? 0) + damage);
  }
  return incoming;
}

const AADefenseStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  aa: zRef(),
});
type AADefenseState = z.infer<typeof AADefenseStateSchema>;

export const AADefenseExecutionSnapshot = execSnapshotType({
  name: "AADefense",
  version: 2,
  // Version 1 remembered its own recent shots; the missiles in the air now
  // tell every gun what is on its way.
  migrations: {
    1: (d) => ({ active: d.active, initialized: d.initialized, aa: d.aa }),
  },
  schema: AADefenseStateSchema,
  cls: () => AADefenseExecution,
});
