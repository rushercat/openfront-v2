import { translateText } from "../Utils";
import type {
  ChronicleEvent,
  ChronicleEventKind,
  ChroniclePlayer,
  NukeKind,
} from "./MatchChronicle";

/** The parts of a chronicle describing an event needs. */
export interface ChronicleNames {
  me(): number | null;
  player(id: number): ChroniclePlayer | undefined;
}

const NUKE_UNIT_KEYS: Record<NukeKind, string> = {
  atom: "unit_type.atom_bomb",
  hydro: "unit_type.hydrogen_bomb",
  mirv: "unit_type.mirv",
};

/** Icon shown next to an event in the log and on the graphs. */
export const EVENT_ICONS: Record<ChronicleEventKind, string> = {
  alliance: "🤝",
  alliance_expired: "⌛",
  betrayal: "🗡️",
  war: "⚔️",
  embargo: "🚫",
  embargo_end: "✅",
  eliminated: "💀",
  nuke: "☢️",
  win: "🏆",
};

/** Whether the event is about the player who recorded the chronicle. */
export function involvesMe(event: ChronicleEvent, me: number | null): boolean {
  return me !== null && (event.a === me || event.b === me);
}

/**
 * Whether the event is one of the moments worth marking on the graphs: the
 * ones that happened to the recording player, plus the win. Without a
 * player (spectator) every betrayal, elimination and the win.
 */
export function isKeyMoment(event: ChronicleEvent, me: number | null): boolean {
  if (event.kind === "win") return true;
  if (me === null) {
    return event.kind === "betrayal" || event.kind === "eliminated";
  }
  if (!involvesMe(event, me)) return false;
  return event.kind !== "embargo_end" && event.kind !== "alliance_expired";
}

/** One line telling what happened, from the recording player's view ("X betrayed you"). */
export function describeEvent(
  event: ChronicleEvent,
  names: ChronicleNames,
): string {
  const me = names.me();
  const name = (id: number | undefined) =>
    id === undefined ? "?" : (names.player(id)?.name ?? "?");
  const a = name(event.a);
  const b = name(event.b);
  const byMe = me !== null && event.a === me;
  const toMe = me !== null && event.b === me;
  switch (event.kind) {
    case "alliance":
      if (byMe) return translateText("match_log.alliance_you", { other: b });
      if (toMe) return translateText("match_log.alliance_you", { other: a });
      return translateText("match_log.alliance", { a, b });
    case "alliance_expired":
      if (byMe)
        return translateText("match_log.alliance_expired_you", { other: b });
      if (toMe)
        return translateText("match_log.alliance_expired_you", { other: a });
      return translateText("match_log.alliance_expired", { a, b });
    case "betrayal":
      if (byMe) return translateText("match_log.betrayal_by_you", { b });
      if (toMe) return translateText("match_log.betrayal_you", { a });
      return translateText("match_log.betrayal", { a, b });
    case "war":
      if (byMe) return translateText("match_log.war_by_you", { b });
      if (toMe) return translateText("match_log.war_you", { a });
      return translateText("match_log.war", { a, b });
    case "embargo":
      if (byMe) return translateText("match_log.embargo_by_you", { b });
      if (toMe) return translateText("match_log.embargo_you", { a });
      return translateText("match_log.embargo", { a, b });
    case "embargo_end":
      if (byMe) return translateText("match_log.embargo_end_by_you", { b });
      if (toMe) return translateText("match_log.embargo_end_you", { a });
      return translateText("match_log.embargo_end", { a, b });
    case "eliminated":
      if (me !== null && event.a === me) {
        return event.b === undefined
          ? translateText("match_log.eliminated_you_alone")
          : translateText("match_log.eliminated_you", { b });
      }
      if (toMe) return translateText("match_log.eliminated_by_you", { a });
      return event.b === undefined
        ? translateText("match_log.eliminated_alone", { a })
        : translateText("match_log.eliminated", { a, b });
    case "nuke": {
      const nuke = translateText(NUKE_UNIT_KEYS[event.nuke ?? "atom"]);
      if (byMe) return translateText("match_log.nuke_by_you", { nuke, b });
      if (toMe) return translateText("match_log.nuke_you", { a, nuke });
      return translateText("match_log.nuke", { a, nuke, b });
    }
    case "win":
      if (event.team !== undefined) {
        return translateText("match_log.win_team", { team: event.team });
      }
      if (byMe) return translateText("match_log.win_you");
      return translateText("match_log.win", { a });
  }
}

/** Game time of a tick as m:ss (h:mm:ss for long games), counted from the end of the spawn phase. */
export function formatMatchTime(
  tick: number,
  startTick: number | null,
): string {
  const total = Math.max(0, Math.floor((tick - (startTick ?? 0)) / 10));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
