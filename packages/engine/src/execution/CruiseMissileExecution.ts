import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  Structures,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  zInt,
  zPlayerRef,
  zRef,
  zTile,
  zTiles,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { recordNukeLaunch } from "./NukeLaunch";

/** Units a cruise missile's blast hurts besides structures. */
const DAMAGED_UNITS: readonly UnitType[] = [
  UnitType.Warship,
  UnitType.AircraftCarrier,
  UnitType.NuclearSubmarine,
  UnitType.Tank,
];

/**
 * The straight line from `from` to `to` in steps of `speed` tiles: the
 * missile's flight, one entry per tick. Ends at `to`.
 */
export function cruiseTrajectory(
  mg: Game,
  from: TileRef,
  to: TileRef,
  speed: number,
): TileRef[] {
  const x0 = mg.x(from);
  const y0 = mg.y(from);
  const dx = mg.x(to) - x0;
  const dy = mg.y(to) - y0;
  const steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / speed));
  const tiles: TileRef[] = [from];
  for (let i = 1; i <= steps; i++) {
    tiles.push(
      mg.ref(
        x0 + Math.round((dx * i) / steps),
        y0 + Math.round((dy * i) / steps),
      ),
    );
  }
  return tiles;
}

/**
 * A cruise missile: a conventional missile a missile silo fires at a tile
 * (it uses one of the silo's missiles, like a nuke). It flies low and
 * straight, cruiseMissileSpeed tiles a tick, and SAMs can shoot it down
 * near its launch and target like a nuke. Where it lands it wears down
 * structures instead of destroying land: cruiseMissileDamage to the
 * structure nearest the impact, half that to the other structures and to
 * warships, carriers, surfaced submarines and tanks in its blast. No
 * fallout, no troops killed.
 */
export class CruiseMissileExecution implements Execution {
  private mg: Game;
  private missile: Unit | null = null;
  private index = 0;
  private active = true;

  constructor(
    private player: Player,
    private target: TileRef,
  ) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
    if (!mg.isValidRef(this.target)) {
      this.active = false;
      return;
    }
    const spawn = this.player.canBuild(UnitType.CruiseMissile, this.target);
    if (spawn === false) {
      console.warn(
        `cannot launch cruise missile for ${this.player.name()} at ${this.target}`,
      );
      this.active = false;
      return;
    }
    const trajectory = cruiseTrajectory(
      mg,
      spawn,
      this.target,
      mg.config().cruiseMissileSpeed(),
    );
    this.missile = this.player.buildUnit(UnitType.CruiseMissile, spawn, {
      targetTile: this.target,
      trajectory,
    });
    recordNukeLaunch(mg, this.player, spawn, UnitType.CruiseMissile);
  }

  tick(_ticks: number): void {
    const missile = this.missile;
    if (missile === null || !missile.isActive()) {
      // Shot down.
      this.active = false;
      return;
    }
    const trajectory = missile.trajectory();
    this.index = Math.min(this.index + 1, trajectory.length - 1);
    missile.move(trajectory[this.index]);
    missile.setTrajectoryIndex(this.index);
    if (this.index >= trajectory.length - 1) {
      this.detonate();
      missile.delete(false);
      this.active = false;
    }
  }

  private detonate(): void {
    const mg = this.mg;
    const config = mg.config();
    const owner = this.player;
    const damage = config.cruiseMissileDamage();
    const hits = mg
      .nearbyUnits(
        this.target,
        config.cruiseMissileBlastRadius(),
        [...Structures.types, ...DAMAGED_UNITS],
        ({ unit }) => {
          const unitOwner = unit.owner();
          return (
            unitOwner !== owner &&
            !(unitOwner.isPlayer() && owner.isFriendly(unitOwner as Player))
          );
        },
      )
      .filter(({ unit }) => !unit.isSubmerged())
      .sort(
        (a, b) => a.distSquared - b.distSquared || a.unit.id() - b.unit.id(),
      );
    let direct = true;
    for (const { unit } of hits) {
      const isStructure = Structures.has(unit.type());
      // The structure nearest the impact takes the full hit.
      const amount = isStructure && direct ? damage : Math.floor(damage / 2);
      if (isStructure) direct = false;
      if (!unit.isActive()) continue;
      unit.modifyHealth(-amount, owner);
    }
    let hitCount = 0;
    for (const { unit } of hits) {
      if (Structures.has(unit.type())) hitCount++;
    }
    const targetOwner = mg.owner(this.target);
    if (targetOwner.isPlayer() && hitCount > 0) {
      mg.displayMessage(
        "events_display.cruise_missile_hit",
        MessageType.UNIT_DESTROYED,
        targetOwner.id(),
        undefined,
        { count: hitCount },
      );
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return CruiseMissileExecutionSnapshot.write({
      player: w.player(this.player),
      target: this.target,
      initialized: this.mg !== undefined,
      missile: this.missile === null ? null : w.unit(this.missile),
      index: this.index,
      active: this.active,
      trajectory: w.tiles(this.missile?.trajectory() ?? []),
    });
  }

  restoreSnapshot(s: CruiseMissileState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.target = s.target;
    if (s.initialized) this.mg = r.game;
    this.missile = s.missile === null ? null : r.unit(s.missile);
    this.index = s.index;
    this.active = s.active;
  }
}

const CruiseMissileStateSchema = z.object({
  player: zPlayerRef(),
  target: zTile(),
  initialized: z.boolean(),
  missile: zRef().nullable(),
  index: zInt(),
  active: z.boolean(),
  // Kept for debugging restored games; the unit carries its own trajectory.
  trajectory: zTiles(),
});
type CruiseMissileState = z.infer<typeof CruiseMissileStateSchema>;

export const CruiseMissileExecutionSnapshot = execSnapshotType({
  name: "CruiseMissile",
  version: 1,
  schema: CruiseMissileStateSchema,
  cls: () => CruiseMissileExecution,
});
