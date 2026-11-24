/**
 * openfront v2: secret missions for historical scenarios
 * (GameConfig.scenarioMissions), in the spirit of Risk: every human player
 * gets one mission for the nation they play, chosen at random from several,
 * and whoever fulfils theirs (and holds it for a moment) wins at once.
 */

/** One part of a mission; all parts must hold at the same time. */
export type MissionGoal =
  /** Own the heartland of every listed scenario nation (by nation key). */
  | { kind: "conquer"; nations: string[] }
  /** That nation is gone from the map, and its heartland is yours. */
  | { kind: "eliminate"; nation: string }
  /** Own at least this share (0..1) of all land on the map. */
  | { kind: "land"; share: number }
  /** Own at least this many city levels. */
  | { kind: "cities"; levels: number };

/**
 * A mission as written in scenario data: just its goals (a "what if"
 * mission), or a historical one, modelled on what that nation really did
 * or aimed for. Every goal must hold at the same time.
 */
export type MissionSpec =
  | MissionGoal[]
  | { historical: true; goals: MissionGoal[] };

/** A mission ready to deal: goals plus where it comes from. */
export interface MissionDef {
  goals: MissionGoal[];
  /** Modelled on history (else a "what if"). */
  historical: boolean;
  /** en.json key of the historical background, or null. */
  noteKey: string | null;
}

/** How long a fulfilled mission must hold before it wins, in ticks. */
export const MISSION_HOLD_TICKS = 300;

/** A heartland: the land within this many tiles of a nation's capital. */
export const MISSION_CORE_RADIUS = 12;

/** Share of a heartland's land a player must own to hold it. */
export const MISSION_CORE_SHARE = 0.75;

export interface MissionGoalView {
  goal: MissionGoal;
  /** 0..1, how far along the player is. */
  progress: number;
  done: boolean;
}

export interface PlayerMissionView {
  /** Small id of the player. */
  player: number;
  /** Key of the scenario nation the player plays. */
  nation: string;
  /** Modelled on history (else a "what if"). */
  historical: boolean;
  /** en.json key of the historical background, or null. */
  noteKey: string | null;
  goals: MissionGoalView[];
  /** Tick since when every goal holds, or null. */
  heldSince: number | null;
}

export interface MissionsViewState {
  /** Ticks a fulfilled mission must hold to win. */
  holdTicks: number;
  missions: PlayerMissionView[];
  /** Small id of the player who won by mission, or null. */
  winner: number | null;
}
