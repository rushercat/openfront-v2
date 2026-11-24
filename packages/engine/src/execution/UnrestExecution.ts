import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  GameFeature,
  GameMode,
  MessageType,
  Nation,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameID } from "@openfront/engine-api/Schemas";
import { pow } from "@openfront/engine-lib/DetMath";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { zInt } from "@openfront/engine-lib/snapshot/SnapshotType";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { generateNationName } from "../game/NationCreation";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { capitalAnchor } from "./CapitalExecution";
import { NationExecution } from "./NationExecution";
import { PlayerExecution } from "./PlayerExecution";

/** How often unrest is updated, in ticks. */
const UNREST_INTERVAL = 10;

/**
 * Unrest: land a player takes from others stays restless for a while. The
 * restless share of their land costs troop growth and gold (Config
 * capitalUnrestFactor) and fades by half every unrestHalfLifeTicks.
 *
 * Secession (free-for-all only, after secessionEarliestTick): an empire of
 * at least secessionMinTiles whose land is secessionUnrestShare or more
 * restless gets a warning; still
 * that restless secessionWarningTicks later, a quarter of it, the part
 * farthest from its capital, breaks away as a new AI nation.
 */
export class UnrestExecution implements Execution {
  private mg: Game;
  private active = true;
  private decay = 1;
  /** Players warned of a secession, by small id: the tick of the warning. */
  private warnedAt = new Map<number, number>();
  /** Players who lost land to a secession, by small id: the tick. */
  private secededAt = new Map<number, number>();

  constructor(private gameID: GameID) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
    if (mg.config().isFeatureDisabled(GameFeature.Unrest)) {
      this.active = false;
      return;
    }
    this.decay = pow(0.5, UNREST_INTERVAL / mg.config().unrestHalfLifeTicks());
  }

  private secessionEnabled(): boolean {
    return (
      !this.mg.config().isFeatureDisabled(GameFeature.Secession) &&
      this.mg.config().gameConfig().gameMode === GameMode.FFA
    );
  }

  tick(ticks: number): void {
    if (ticks % UNREST_INTERVAL !== 0) return;
    const secession = this.secessionEnabled();
    for (const player of this.mg.players()) {
      const unrest = player.unrest();
      if (unrest > 0) {
        const decayed = Math.min(unrest, player.numTilesOwned()) * this.decay;
        player.setUnrest(decayed < 1 ? 0 : decayed);
      }
      if (secession) this.checkSecession(player, ticks);
    }
  }

  private checkSecession(player: Player, ticks: number): void {
    const config = this.mg.config();
    const id = player.smallID();
    const restless =
      ticks >= config.secessionEarliestTick() &&
      player.type() !== PlayerType.Bot &&
      player.numTilesOwned() >= config.secessionMinTiles() &&
      player.unrestShare() >= config.secessionUnrestShare() &&
      ticks - (this.secededAt.get(id) ?? -Infinity) >=
        config.secessionCooldownTicks();
    if (!restless) {
      this.warnedAt.delete(id);
      return;
    }
    const warned = this.warnedAt.get(id);
    if (warned === undefined) {
      this.warnedAt.set(id, ticks);
      this.mg.displayMessage(
        "events_display.secession_warning",
        MessageType.UNIT_DESTROYED,
        player.id(),
        undefined,
        {
          seconds: Math.round(config.secessionWarningTicks() / 10),
        },
      );
      return;
    }
    if (ticks - warned < config.secessionWarningTicks()) return;
    this.warnedAt.delete(id);
    this.secededAt.set(id, ticks);
    secede(this.mg, this.gameID, player);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(_w: SnapshotWriter): ExecRecord {
    return UnrestExecutionSnapshot.write({
      gameID: this.gameID,
      initialized: this.mg !== undefined,
      active: this.active,
      decay: this.decay,
      warnedAt: [...this.warnedAt],
      secededAt: [...this.secededAt],
    });
  }

  restoreSnapshot(s: UnrestState, r: SnapshotReader): void {
    this.gameID = s.gameID;
    if (s.initialized) this.mg = r.game;
    this.active = s.active;
    this.decay = s.decay;
    this.warnedAt = new Map(s.warnedAt);
    this.secededAt = new Map(s.secededAt);
  }
}

/**
 * Breaks secessionLandShare of the player's land away as a new AI nation:
 * a connected region grown from the tile farthest from the capital (or the
 * spawn). It takes its share of the troops along. Returns the new nation.
 */
export function secede(
  mg: Game,
  gameID: GameID,
  player: Player,
  share: number = mg.config().secessionLandShare(),
): Player | null {
  const anchor = capitalAnchor(mg, player);
  if (anchor === null) return null;
  const total = player.numTilesOwned();
  const wanted = Math.floor(total * share);
  if (wanted < 1) return null;

  let start: TileRef | null = null;
  let startDist = -1;
  for (const tile of player.tiles()) {
    const dist = mg.euclideanDistSquared(tile, anchor);
    if (
      dist > startDist ||
      (dist === startDist && start !== null && tile < start)
    ) {
      startDist = dist;
      start = tile;
    }
  }
  if (start === null) return null;

  // Grow a connected region from there, never through the anchor.
  const region: TileRef[] = [start];
  const seen = new Set<TileRef>([start, anchor]);
  for (let i = 0; i < region.length && region.length < wanted; i++) {
    for (const n of mg.neighbors(region[i])) {
      if (seen.has(n)) continue;
      seen.add(n);
      if (mg.owner(n) !== player) continue;
      region.push(n);
      if (region.length >= wanted) break;
    }
  }

  const random = new PseudoRandom(
    simpleHash(gameID) + mg.ticks() * 31 + player.smallID(),
  );
  let id = random.nextID();
  while (mg.hasPlayer(id)) id = random.nextID();
  const name = generateNationName(random);
  const info = new PlayerInfo(name, PlayerType.Nation, null, id);
  const rebel = mg.addNation(info);

  for (const tile of region) rebel.conquer(tile);
  rebel.setUnrest(0);
  rebel.setSpawnTile(start);
  const troops = Math.floor((player.troops() * region.length) / total);
  player.removeTroops(troops);
  rebel.setTroops(troops);
  player.setUnrest(player.unrest() / 2);

  mg.addExecution(
    new PlayerExecution(rebel),
    new NationExecution(gameID, new Nation(undefined, info)),
  );
  mg.displayMessage(
    "events_display.secession",
    MessageType.UNIT_DESTROYED,
    player.id(),
    undefined,
    { name },
  );
  return rebel;
}

const UnrestStateSchema = z.object({
  gameID: z.string(),
  initialized: z.boolean(),
  active: z.boolean(),
  decay: z.number(),
  warnedAt: z.array(z.tuple([zInt(), zInt()])),
  secededAt: z.array(z.tuple([zInt(), zInt()])),
});
type UnrestState = z.infer<typeof UnrestStateSchema>;

export const UnrestExecutionSnapshot = execSnapshotType({
  name: "Unrest",
  version: 1,
  schema: UnrestStateSchema,
  cls: () => UnrestExecution,
});
