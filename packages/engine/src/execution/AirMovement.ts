import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { Game, Player, Unit } from "../game/Game";

/**
 * The tile `speed` tiles along the straight line from `from` to `to`, or `to`
 * itself once it is that close. Aircraft and AA missiles fly over everything,
 * so there is no path to find.
 *
 * Math.sqrt and the basic float operations are correctly rounded on every
 * engine (IEEE 754), so this is deterministic.
 */
export function flyToward(
  mg: Game,
  from: TileRef,
  to: TileRef,
  speed: number,
): TileRef {
  const x = mg.x(from);
  const y = mg.y(from);
  const dx = mg.x(to) - x;
  const dy = mg.y(to) - y;
  const distSquared = dx * dx + dy * dy;
  if (distSquared <= speed * speed) {
    return to;
  }
  const dist = Math.sqrt(distSquared);
  // Both coordinates end up between from and to, so always on the map.
  return mg.ref(
    x + Math.round((dx * speed) / dist),
    y + Math.round((dy * speed) / dist),
  );
}

/**
 * Whether `unit` is doing something to `player` (or to one of its friends)
 * that calls for a defense: it is over their land, it has one of their units
 * in its sights, or it is a boat on its way to their shore.
 *
 * AA Defenses and fighters on guard only engage such units. Without this,
 * neighbors whose aircraft merely patrol their own side of a border would
 * shoot each other down all game long.
 */
export function threatens(mg: Game, unit: Unit, player: Player): boolean {
  const concerns = (other: ReturnType<Game["owner"]> | undefined): boolean =>
    other !== undefined &&
    other.isPlayer() &&
    (other === player || player.isFriendly(other));
  if (concerns(mg.owner(unit.tile()))) {
    return true;
  }
  if (concerns(unit.targetUnit()?.owner())) {
    return true;
  }
  const destination = unit.targetTile();
  return (
    (unit.type() === UnitType.TransportShip ||
      unit.type() === UnitType.TransportPlane) &&
    destination !== undefined &&
    concerns(mg.owner(destination))
  );
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** A random tile of the map in the square of half-width `range` around `center`. */
export function randomTileAround(
  mg: Game,
  random: PseudoRandom,
  center: TileRef,
  range: number,
): TileRef {
  const x = mg.x(center) + random.nextInt(-range, range + 1);
  const y = mg.y(center) + random.nextInt(-range, range + 1);
  return mg.ref(clamp(x, 0, mg.width() - 1), clamp(y, 0, mg.height() - 1));
}

/**
 * A random tile of the map on the circle of `radius` around `center`. Flying
 * from one such tile to the next stays within `radius` of the center.
 */
export function randomTileOnRing(
  mg: Game,
  random: PseudoRandom,
  center: TileRef,
  radius: number,
): TileRef {
  const dx = random.nextInt(-radius, radius + 1);
  const dy =
    Math.floor(Math.sqrt(radius * radius - dx * dx)) *
    (random.nextInt(0, 2) === 0 ? -1 : 1);
  return mg.ref(
    clamp(mg.x(center) + dx, 0, mg.width() - 1),
    clamp(mg.y(center) + dy, 0, mg.height() - 1),
  );
}

/**
 * Where a player's aircraft may operate: within airfieldRange(level) of one
 * of its finished airfields. Built once per use from the airfields' current
 * levels, so stacking an airfield widens it at once.
 */
export class AirfieldCoverage {
  private readonly circles: { x: number; y: number; range: number }[];

  constructor(
    private readonly mg: Game,
    player: Player,
  ) {
    // Aircraft carriers are airfields at sea, with a shorter range.
    this.circles = player
      .units(UnitType.Airfield, UnitType.AircraftCarrier)
      .filter(
        (airfield) => airfield.isActive() && !airfield.isUnderConstruction(),
      )
      .map((airfield) => ({
        x: mg.x(airfield.tile()),
        y: mg.y(airfield.tile()),
        range:
          airfield.type() === UnitType.AircraftCarrier
            ? mg.config().carrierAirRange()
            : mg.config().airfieldRange(airfield.level()),
      }));
  }

  /** Whether the player has any finished airfield at all. */
  hasAirfield(): boolean {
    return this.circles.length > 0;
  }

  contains(tile: TileRef): boolean {
    const x = this.mg.x(tile);
    const y = this.mg.y(tile);
    for (const c of this.circles) {
      const dx = x - c.x;
      const dy = y - c.y;
      if (dx * dx + dy * dy <= c.range * c.range) {
        return true;
      }
    }
    return false;
  }

  /**
   * `tile` itself when covered, else the point of the nearest range circle
   * closest to it (an order beyond the range ends at its edge). Undefined
   * without any airfield.
   */
  clamp(tile: TileRef): TileRef | undefined {
    if (this.contains(tile)) {
      return tile;
    }
    const x = this.mg.x(tile);
    const y = this.mg.y(tile);
    let best: TileRef | undefined = undefined;
    let bestGap = 0;
    for (const c of this.circles) {
      const dx = x - c.x;
      const dy = y - c.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const gap = dist - c.range;
      if (best !== undefined && gap >= bestGap) {
        continue;
      }
      // One tile inside the edge, so rounding cannot put it outside.
      const scale = (c.range - 1) / dist;
      best = this.mg.ref(
        clamp(c.x + Math.round(dx * scale), 0, this.mg.width() - 1),
        clamp(c.y + Math.round(dy * scale), 0, this.mg.height() - 1),
      );
      bestGap = gap;
    }
    return best;
  }
}
