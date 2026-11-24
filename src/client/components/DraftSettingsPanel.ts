import { DRAFT_EPOCH_SECONDS } from "@openfront/engine-api/game/Draft";
import type { DraftConfig } from "@openfront/engine-api/Schemas";
import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../Utils";

/** Ready-made combinations to try the variants quickly. */
const PRESETS: { key: string; config: DraftConfig }[] = [
  {
    key: "classic",
    config: {
      enabled: true,
      picks: 6,
      timing: "before",
      offers: "random",
      tech: "none",
    },
  },
  {
    key: "clash",
    config: {
      enabled: true,
      picks: 4,
      timing: "before",
      offers: "mirrored",
      declinedToOpponent: true,
      tech: "none",
    },
  },
  {
    key: "fair",
    config: {
      enabled: true,
      picks: 6,
      timing: "before",
      offers: "mirrored",
      visibleDecks: true,
      tech: "levels",
    },
  },
  {
    key: "roguelike",
    config: {
      enabled: true,
      picks: 8,
      timing: "during",
      intervalSeconds: 120,
      pickSeconds: 20,
      offers: "random",
      tech: "levels",
    },
  },
  {
    key: "doctrines",
    config: { enabled: true, picks: 3, timing: "before", tech: "doctrines" },
  },
  {
    key: "hardcore",
    config: {
      enabled: true,
      picks: 8,
      timing: "before",
      baseSet: false,
      visibleDecks: false,
      tech: "levels",
    },
  },
];

/**
 * The draft mode in the lobby (GameConfig.draft): on/off, presets and every
 * option. Emits `draft-config-changed` with the whole new config.
 */
@customElement("draft-settings-panel")
export class DraftSettingsPanel extends LitElement {
  @property({ attribute: false }) config: DraftConfig = { enabled: false };
  @property({ type: Boolean }) editable = true;

  createRenderRoot() {
    return this;
  }

  private emit(config: DraftConfig) {
    this.dispatchEvent(
      new CustomEvent("draft-config-changed", {
        detail: { config },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private set(patch: Partial<DraftConfig>) {
    this.emit({ ...this.config, ...patch });
  }

  private segmented<T extends string>(
    labelKey: string,
    value: T,
    options: [T, string][],
    onPick: (v: T) => void,
  ): TemplateResult {
    return html`
      <div class="flex flex-col gap-1">
        <span class="text-xs text-white/60">${translateText(labelKey)}</span>
        <div class="flex flex-wrap gap-1">
          ${options.map(
            ([o, label]) =>
              html`<button
                class="rounded-lg px-3 py-1.5 text-sm ${
                  value === o
                    ? "bg-indigo-600 text-white"
                    : "bg-white/10 text-white/80 hover:bg-white/20"
                }"
                ?disabled=${!this.editable}
                @click=${() => onPick(o)}
              >
                ${label}
              </button>`,
          )}
        </div>
      </div>
    `;
  }

  private slider(
    labelKey: string,
    value: number,
    min: number,
    max: number,
    step: number,
    unit: string,
    onChange: (v: number) => void,
  ): TemplateResult {
    return html`
      <label class="flex flex-col gap-1">
        <span class="text-xs text-white/60"
          >${translateText(labelKey)}:
          <b class="text-white">${value}${unit}</b></span
        >
        <input
          type="range"
          min=${min}
          max=${max}
          step=${step}
          .value=${String(value)}
          ?disabled=${!this.editable}
          @input=${(e: Event) =>
            onChange(Number((e.target as HTMLInputElement).value))}
        />
      </label>
    `;
  }

  private toggle(
    labelKey: string,
    descKey: string,
    checked: boolean,
    onChange: (v: boolean) => void,
  ): TemplateResult {
    return html`
      <label
        class="flex cursor-pointer items-start gap-2 text-sm text-white/90"
      >
        <input
          type="checkbox"
          class="mt-1"
          .checked=${checked}
          ?disabled=${!this.editable}
          @change=${(e: Event) =>
            onChange((e.target as HTMLInputElement).checked)}
        />
        <span>
          ${translateText(labelKey)}
          <span class="block text-xs text-white/50"
            >${translateText(descKey)}</span
          >
        </span>
      </label>
    `;
  }

  /**
   * openfront v2 test mode, its own switch: epochs with a doctrine choice
   * (DraftTech "epochs"). Shares GameConfig.draft with the draft mode, so
   * the two are exclusive.
   */
  private renderEpochs(): TemplateResult {
    const c = this.config;
    const on = c.enabled && c.tech === "epochs";
    const minutes = Math.round((c.intervalSeconds ?? DRAFT_EPOCH_SECONDS) / 60);
    return html`
      <div
        class="mt-6 rounded-xl border p-4 text-white ${
          on
            ? "border-amber-400/70 bg-amber-500/10"
            : "border-white/10 bg-white/5"
        }"
      >
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-lg font-bold">
              ⏳ ${translateText("draft_settings.epochs_title")}
              <span
                class="ml-1 rounded bg-amber-500/30 px-1.5 py-0.5 align-middle text-[10px] uppercase tracking-wide text-amber-200"
                >${translateText("draft_settings.epochs_test")}</span
              >
            </div>
            <div class="text-xs text-white/60">
              ${translateText("draft_settings.epochs_desc")}
            </div>
          </div>
          <button
            class="shrink-0 rounded-lg px-4 py-2 text-sm font-bold ${
              on
                ? "bg-amber-500 text-black hover:bg-amber-400"
                : "bg-white/10 hover:bg-white/20"
            }"
            ?disabled=${!this.editable}
            @click=${() =>
              this.emit(
                on
                  ? { enabled: false }
                  : {
                      enabled: true,
                      tech: "epochs",
                      pickSeconds: 20,
                      intervalSeconds: DRAFT_EPOCH_SECONDS,
                      visibleDecks: true,
                    },
              )}
          >
            ${
              on
                ? translateText("draft_settings.on")
                : translateText("draft_settings.off")
            }
          </button>
        </div>
        ${
          on
            ? html`<div class="mt-4 flex flex-col gap-3">
                <ol class="list-inside list-decimal text-xs text-white/80">
                  <li>${translateText("draft_settings.epochs_step1")}</li>
                  <li>${translateText("draft_settings.epochs_step2")}</li>
                  <li>${translateText("draft_settings.epochs_step3")}</li>
                </ol>
                <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
                  ${this.slider(
                    "draft_settings.epochs_length",
                    minutes,
                    3,
                    15,
                    1,
                    " min",
                    (v) => this.set({ intervalSeconds: v * 60 }),
                  )}
                  ${this.slider(
                    "draft_settings.pick_seconds",
                    c.pickSeconds ?? 20,
                    5,
                    30,
                    1,
                    " s",
                    (v) => this.set({ pickSeconds: v }),
                  )}
                </div>
                ${this.toggle(
                  "draft_settings.visible",
                  "draft_settings.epochs_visible_desc",
                  c.visibleDecks ?? true,
                  (v) => this.set({ visibleDecks: v }),
                )}
              </div>`
            : nothing
        }
      </div>
    `;
  }

  render() {
    const c = this.config;
    if (c.enabled && c.tech === "epochs") {
      // The draft box would only repeat the same config: show it off.
      return html`${this.renderEpochs()}${this.renderDraftBox({
        enabled: false,
      })}`;
    }
    return html`${this.renderEpochs()}${this.renderDraftBox(c)}`;
  }

  private renderDraftBox(c: DraftConfig) {
    const tech = (c.tech ?? "none") as "none" | "levels" | "doctrines";
    const picks = c.picks ?? (tech === "doctrines" ? 3 : 6);
    const timing = c.timing ?? "before";
    return html`
      <div
        class="mt-6 rounded-xl border border-white/10 bg-white/5 p-4 text-white"
      >
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-lg font-bold">
              🃏 ${translateText("draft_settings.title")}
            </div>
            <div class="text-xs text-white/60">
              ${translateText("draft_settings.desc")}
            </div>
          </div>
          <label class="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              class="h-5 w-5"
              .checked=${c.enabled}
              ?disabled=${!this.editable}
              @change=${(e: Event) => {
                const enabled = (e.target as HTMLInputElement).checked;
                // Switching the draft on ends the epochs mode.
                if (this.config.tech === "epochs") {
                  this.emit({ enabled, tech: "none" });
                } else {
                  this.set({ enabled });
                }
              }}
            />
            <span class="text-sm"
              >${
                c.enabled
                  ? translateText("draft_settings.on")
                  : translateText("draft_settings.off")
              }</span
            >
          </label>
        </div>
        ${c.enabled ? this.renderDraftOptions(c, tech, picks, timing) : nothing}
      </div>
    `;
  }

  private renderDraftOptions(
    c: DraftConfig,
    tech: "none" | "levels" | "doctrines",
    picks: number,
    timing: "before" | "during",
  ): TemplateResult {
    return html`
      <div class="mt-4 flex flex-col gap-4">
        <div class="flex flex-col gap-1">
          <span class="text-xs text-white/60"
            >${translateText("draft_settings.presets")}</span
          >
          <div class="flex flex-wrap gap-1">
            ${PRESETS.map(
              (p) =>
                html`<button
                  class="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
                  title=${translateText(`draft_settings.preset_${p.key}_desc`)}
                  ?disabled=${!this.editable}
                  @click=${() => this.emit({ ...p.config })}
                >
                  ${translateText(`draft_settings.preset_${p.key}`)}
                </button>`,
            )}
          </div>
        </div>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          ${this.slider("draft_settings.picks", picks, 1, 12, 1, "", (v) =>
            this.set({ picks: v }),
          )}
          ${this.slider(
            "draft_settings.pick_seconds",
            c.pickSeconds ?? 12,
            5,
            30,
            1,
            " s",
            (v) => this.set({ pickSeconds: v }),
          )}
          ${this.segmented(
            "draft_settings.timing",
            timing,
            [
              ["before", translateText("draft_settings.timing_before")],
              ["during", translateText("draft_settings.timing_during")],
            ],
            (v) => this.set({ timing: v }),
          )}
          ${
            timing === "during"
              ? this.slider(
                  "draft_settings.interval",
                  c.intervalSeconds ?? 120,
                  30,
                  600,
                  30,
                  " s",
                  (v) => this.set({ intervalSeconds: v }),
                )
              : html`<div></div>`
          }
          ${this.segmented(
            "draft_settings.offers",
            c.offers ?? "random",
            [
              ["random", translateText("draft_settings.offers_random")],
              ["mirrored", translateText("draft_settings.offers_mirrored")],
            ],
            (v) => this.set({ offers: v }),
          )}
          ${this.segmented(
            "draft_settings.tech",
            tech,
            [
              ["none", translateText("draft_settings.tech_none")],
              ["levels", translateText("draft_settings.tech_levels")],
              ["doctrines", translateText("draft_settings.tech_doctrines")],
            ],
            (v) => this.set({ tech: v }),
          )}
        </div>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
          ${this.toggle(
            "draft_settings.declined",
            "draft_settings.declined_desc",
            c.declinedToOpponent ?? false,
            (v) => this.set({ declinedToOpponent: v }),
          )}
          ${this.toggle(
            "draft_settings.visible",
            "draft_settings.visible_desc",
            c.visibleDecks ?? true,
            (v) => this.set({ visibleDecks: v }),
          )}
          ${this.toggle(
            "draft_settings.base_set",
            "draft_settings.base_set_desc",
            c.baseSet ?? true,
            (v) => this.set({ baseSet: v }),
          )}
        </div>
        <div class="text-xs text-white/50">
          ${translateText(`draft_settings.tech_${tech}_desc`)}
        </div>
      </div>
    `;
  }
}
