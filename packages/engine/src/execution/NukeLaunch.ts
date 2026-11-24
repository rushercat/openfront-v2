import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { Game, Player } from "../game/Game";

/**
 * Books a nuke of `nukeType` launched from `launchTile` (where
 * Player.nukeSpawn sent it from): a silo there goes on cooldown, a surfaced
 * submarine there spends payload, and dives once nothing more fits.
 */
export function recordNukeLaunch(
  mg: Game,
  player: Player,
  launchTile: TileRef,
  nukeType: UnitType,
): void {
  const silo = player
    .units(UnitType.MissileSilo)
    .find((s) => s.tile() === launchTile);
  if (silo !== undefined) {
    silo.launch();
    return;
  }
  const cost = mg.config().nukePayloadCost(nukeType);
  const sub = player
    .units(UnitType.NuclearSubmarine)
    .find(
      (s) =>
        s.tile() === launchTile &&
        s.submarineState()?.mode === "surfaced" &&
        (s.submarineState()?.payloadLeft ?? 0) >= cost,
    );
  if (sub === undefined) {
    return;
  }
  const payloadLeft = (sub.submarineState()?.payloadLeft ?? 0) - cost;
  sub.updateSubmarineState({ payloadLeft });
}
