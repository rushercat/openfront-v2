import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { Controller } from "../Controller";
import { GameView } from "../view";
import { MatchChronicle } from "./MatchChronicle";
import { currentMatchSession, setActiveChronicle } from "./MatchSession";

/**
 * Feeds the match chronicle from the game view every tick. While playing it
 * is the session's chronicle (saved with the game, see MatchSession); in a
 * replay a fresh one, so the event log and the statistics work there too.
 * On the win it saves the session.
 */
export class MatchChronicleController implements Controller {
  readonly chronicle: MatchChronicle;

  constructor(private readonly game: GameView) {
    const session = game.config().isReplay() ? null : currentMatchSession();
    this.chronicle = session?.chronicle ?? new MatchChronicle();
  }

  init(): void {
    setActiveChronicle(this.chronicle);
  }

  tick(): void {
    this.chronicle.observe(this.game);
    const wins = this.game.updatesSinceLastTick()?.[GameUpdateType.Win];
    if (wins !== undefined && wins.length > 0) {
      const win = wins[wins.length - 1];
      if (!this.game.config().isReplay()) {
        currentMatchSession()?.markWin(win.winner, win.allPlayersStats);
      }
    }
  }

  dispose(): void {
    setActiveChronicle(null);
  }
}
