import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ClientEnv } from "../ClientEnv";
import { translateText } from "../Utils";
import { formatMatchTime } from "./ChronicleText";
import {
  deleteMatch,
  listMatches,
  loadMatchData,
  MAX_UNSAVED_REPLAYS,
  pruneMatches,
  setMatchSaved,
  type MatchSummary,
} from "./LocalMatchStore";
import { MatchChronicle } from "./MatchChronicle";
import { openMatchStats } from "./MatchStatsModal";

/**
 * <match-history-modal>: "My games" on the home page. The games this
 * browser recorded (LocalMatchStore), newest first, each with its
 * statistics and, when it can still be replayed on this build, its replay
 * (the replay viewer with its timeline, opened by #replay-viewer=<id>).
 */
@customElement("match-history-modal")
export class MatchHistoryModal extends LitElement {
  @state() private open = false;
  @state() private loading = false;
  @state() private games: MatchSummary[] = [];

  createRenderRoot() {
    return this;
  }

  async show(): Promise<void> {
    this.open = true;
    this.loading = true;
    await pruneMatches();
    this.games = await listMatches();
    this.loading = false;
  }

  close(): void {
    this.open = false;
  }

  private canReplay(m: MatchSummary): boolean {
    const own = ClientEnv.gitCommit();
    return (
      m.hasReplay &&
      m.replayExpired !== true &&
      (own === "DEV" || m.gitCommit === own)
    );
  }

  /** Whether this unsaved game is beyond the newest MAX_UNSAVED_REPLAYS. */
  private isOlderReplay(m: MatchSummary): boolean {
    let newer = 0;
    for (const g of this.games) {
      if (g.gameID === m.gameID) break;
      if (g.saved !== true && g.hasReplay && g.replayExpired !== true) newer++;
    }
    return newer >= MAX_UNSAVED_REPLAYS;
  }

  private async toggleSaved(m: MatchSummary): Promise<void> {
    const saving = m.saved !== true;
    if (
      !saving &&
      this.isOlderReplay(m) &&
      !window.confirm(translateText("match_history.unsave_confirm"))
    ) {
      return;
    }
    await setMatchSaved(m.gameID, saving);
    // Unsaving can expire this or another replay: reload the list.
    this.games = await listMatches();
  }

  private watch(m: MatchSummary): void {
    this.close();
    window.location.hash = `#replay-viewer=${m.gameID}`;
  }

  private async stats(m: MatchSummary): Promise<void> {
    const data = await loadMatchData(m.gameID);
    if (data === null) return;
    openMatchStats(MatchChronicle.fromData(data.chronicle), this.label(m));
  }

  private async deleteGame(m: MatchSummary): Promise<void> {
    await deleteMatch(m.gameID);
    this.games = this.games.filter((x) => x.gameID !== m.gameID);
  }

  private label(m: MatchSummary): string {
    return `${m.map} · ${new Date(m.startedAt).toLocaleString()}`;
  }

  private resultBadge(m: MatchSummary) {
    const styles = {
      won: "bg-green-600/80",
      lost: "bg-red-700/80",
      played: "bg-white/15",
    } as const;
    return html`<span
      class="px-1.5 py-0.5 rounded text-[11px] ${styles[m.result]}"
      >${translateText(`match_history.result_${m.result}`)}</span
    >`;
  }

  render() {
    if (!this.open) return nothing;
    return html`
      <div
        class="fixed inset-0 z-[10020] bg-black/60 flex items-center justify-center p-3"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget) this.close();
        }}
      >
        <div
          class="bg-gray-800/95 text-white rounded-lg shadow-2xl w-[min(96vw,720px)] max-h-[90dvh] overflow-y-auto p-4"
          data-match-history
        >
          <div class="flex items-center justify-between mb-3">
            <h2 class="m-0 text-xl">${translateText("match_history.title")}</h2>
            <button
              type="button"
              class="text-white/70 hover:text-white text-2xl leading-none"
              aria-label=${translateText("match_history.close")}
              @click=${() => this.close()}
            >
              ×
            </button>
          </div>
          <p class="text-xs text-white/60 mt-0 mb-3">
            ${translateText("match_history.keep_hint", {
              count: MAX_UNSAVED_REPLAYS,
            })}
          </p>
          ${
            this.loading
              ? html`<p class="text-white/70">…</p>`
              : this.games.length === 0
                ? html`<p class="text-white/70">
                    ${translateText("match_history.empty")}
                  </p>`
                : html`<ul class="flex flex-col gap-2">
                    ${this.games.map(
                      (m) =>
                        html`<li
                          class="bg-white/5 rounded p-2 flex flex-wrap items-center gap-2"
                        >
                          <div class="flex-1 min-w-[12rem]">
                            <div class="flex items-center gap-2">
                              <span class="font-semibold">${m.map}</span>
                              ${this.resultBadge(m)}
                              ${
                                m.saved === true
                                  ? html`<span
                                      class="px-1.5 py-0.5 rounded text-[11px] bg-amber-500/80"
                                      >★
                                      ${translateText("match_history.saved")}</span
                                    >`
                                  : nothing
                              }
                            </div>
                            <div class="text-xs text-white/60">
                              ${new Date(m.startedAt).toLocaleString()} ·
                              ${formatMatchTime(m.durationTicks, 0)} ·
                              ${translateText("match_history.players", {
                                count: m.playerCount,
                              })}
                              ${
                                m.winnerName === null
                                  ? nothing
                                  : html` ·
                                    ${translateText("match_history.winner", {
                                      name: m.winnerName,
                                    })}`
                              }
                            </div>
                          </div>
                          <button
                            type="button"
                            class="px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-sm"
                            @click=${() => void this.stats(m)}
                          >
                            ${translateText("match_history.statistics")}
                          </button>
                          ${
                            this.canReplay(m)
                              ? html`<button
                                    type="button"
                                    class="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-sm"
                                    @click=${() => this.watch(m)}
                                  >
                                    ${translateText("match_history.watch_replay")}
                                  </button>
                                  <button
                                    type="button"
                                    class="px-3 py-1 rounded text-sm ${
                                      m.saved === true
                                        ? "bg-amber-500/80 hover:bg-amber-500"
                                        : "bg-white/10 hover:bg-white/20"
                                    }"
                                    title=${translateText(
                                      m.saved === true
                                        ? "match_history.unsave_hint"
                                        : "match_history.save_hint",
                                    )}
                                    @click=${() => void this.toggleSaved(m)}
                                  >
                                    ${
                                      m.saved === true
                                        ? translateText("match_history.unsave")
                                        : translateText("match_history.save")
                                    }
                                  </button>`
                              : html`<span
                                  class="text-xs text-white/50"
                                  title=${translateText(
                                    m.replayExpired === true
                                      ? "match_history.expired_hint"
                                      : m.hasReplay
                                        ? "match_history.other_build"
                                        : "match_history.no_replay",
                                  )}
                                  >${translateText(
                                    m.replayExpired === true
                                      ? "match_history.replay_expired"
                                      : "match_history.replay_unavailable",
                                  )}</span
                                >`
                          }
                          <button
                            type="button"
                            class="px-2 py-1 rounded text-white/60 hover:text-red-300 text-sm"
                            title=${translateText("match_history.delete")}
                            aria-label=${translateText("match_history.delete")}
                            @click=${() => void this.deleteGame(m)}
                          >
                            🗑
                          </button>
                        </li>`,
                    )}
                  </ul>`
          }
        </div>
      </div>
    `;
  }
}

/** Opens "My games", creating the modal on first use. */
export function openMatchHistory(): void {
  let modal = document.querySelector<MatchHistoryModal>("match-history-modal");
  if (modal === null) {
    modal = document.createElement("match-history-modal") as MatchHistoryModal;
    document.body.appendChild(modal);
  }
  void modal.show();
}
