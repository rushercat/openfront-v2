import {
  DRAFT_CARDS,
  DRAFT_DEFENSE_CARDS,
  DRAFT_MAX_LEVEL,
  DRAFT_RARITY_WEIGHT,
  DRAFT_WAR_CHEST_GOLD,
  DraftCardId,
  DraftCategory,
  draftCostFactor,
  draftFactor,
  draftGovernedUnits,
  DraftPerk,
  draftPerkLevel,
  DraftPhase,
  draftPool,
  draftResearchCost,
  DraftSettings,
  draftSettings,
  draftUnlockedUnits,
  DraftViewState,
  epochOffers,
} from "@openfront/engine-api/game/Draft";
import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { PoliticsFactor } from "@openfront/engine-api/game/Politics";
import { GameID } from "@openfront/engine-api/Schemas";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { zInt, zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Draft, Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/** Ticks between keepalive view updates. */
const REFRESH_INTERVAL = 50;

/** What nations like to build their deck around, by archetype. */
const NATION_ARCHETYPES: readonly DraftCategory[] = [
  DraftCategory.Economy,
  DraftCategory.Defense,
  DraftCategory.Air,
  DraftCategory.Navy,
  DraftCategory.Army,
  DraftCategory.Nuclear,
];

const RARITY_SCORE = { common: 1, rare: 2, epic: 3, legendary: 4 } as const;

interface Research {
  card: DraftCardId;
  startTick: number;
  endTick: number;
}

/**
 * The draft mode (GameConfig.draft, engine-api game/Draft).
 *
 * Runs the rounds: every human and nation is offered two cards and keeps
 * one (timing "before": all rounds right after the spawn phase with the game
 * frozen; "during": one round every intervalSeconds while the game runs).
 * Keeps the decks and the research, and is the Draft the rules ask which
 * units a player may build and what their perks change.
 */
export class DraftExecution implements Execution, Draft {
  private mg: Game;
  private active = true;
  private seed = 0;
  private settings: DraftSettings;
  private governed = new Set<UnitType>();

  private phase: DraftPhase = "waiting";
  private round = 0;
  private roundStart = 0;
  private roundEnd = 0;
  private nextRoundTick = 0;
  private freezeStart: number | null = null;
  private freezeEnd: number | null = null;

  private offers = new Map<number, DraftCardId[]>();
  private picked = new Map<number, DraftCardId>();
  private decks = new Map<number, Map<DraftCardId, number>>();
  private research = new Map<number, Research>();
  private received: [number, DraftCardId, number][] = [];
  /** Mirrored offers: cards already shown, so no pair repeats. */
  private shown: DraftCardId[] = [];

  /** Unlocked units per player, rebuilt when a deck changes. */
  private unlockedCache = new Map<number, Set<UnitType>>();
  private dirty = true;

  constructor(private gameID: GameID) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.seed = simpleHash(this.gameID) + 104729;
    this.setup(mg);
    this.nextRoundTick = ticks;
    for (const p of this.drafters()) {
      this.decks.set(p.smallID(), new Map());
    }
  }

  private setup(mg: Game): void {
    this.mg = mg;
    const s = draftSettings(mg.config().gameConfig().draft);
    // Only added when enabled; a restored game keeps its config.
    this.settings = s ?? draftSettings({ enabled: true })!;
    this.governed = draftGovernedUnits(this.settings);
    mg.setDraft(this);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  activeDuringFreeze(): boolean {
    return true;
  }

  // ── Rounds ─────────────────────────────────────────────────────────────

  tick(ticks: number): void {
    this.finishResearch(ticks);
    if (!this.isFrozenAt(ticks)) this.nationsResearch(ticks);

    switch (this.phase) {
      case "waiting":
        if (ticks >= this.nextRoundTick) {
          if (this.round >= this.settings.picks) {
            this.phase = "done";
            this.dirty = true;
          } else {
            this.startRound(ticks);
          }
        }
        break;
      case "picking":
        if (ticks >= this.roundEnd || this.allHumansPicked()) {
          this.resolveRound(ticks);
        }
        break;
      case "done":
        break;
    }

    if (this.dirty || ticks % REFRESH_INTERVAL === 0) {
      this.dirty = false;
      this.mg.addUpdate({
        type: GameUpdateType.Draft,
        state: this.viewState(),
      });
    }
  }

  private pickTicks(): number {
    return this.settings.pickSeconds * 10;
  }

  private startRound(ticks: number): void {
    this.phase = "picking";
    this.roundStart = ticks;
    if (this.epochs()) {
      // Every epoch's choice freezes the game, from the next tick on.
      this.freezeStart = ticks + 1;
      this.freezeEnd = null;
      this.roundEnd = ticks + 1 + this.pickTicks();
    } else if (this.settings.timing === "before") {
      // Frozen from the next tick on, until the last round is over.
      if (this.freezeStart === null) {
        this.freezeStart = ticks + 1;
        this.freezeEnd = null;
      }
      this.roundEnd = ticks + 1 + this.pickTicks();
    } else {
      this.roundEnd = ticks + this.pickTicks();
    }
    this.offers.clear();
    this.picked.clear();
    // Fixed once per round for everyone in mirrored mode.
    const mirrored =
      this.settings.offers === "mirrored" ? this.drawMirrored() : null;
    for (const p of this.drafters()) {
      const offer = this.epochs()
        ? epochOffers(this.round, this.deckOf(p), (c) => this.usable(c))
        : (mirrored ?? this.drawOffers(p));
      if (offer.length > 0) this.offers.set(p.smallID(), offer);
    }
    this.nationsPick();
    this.dirty = true;
  }

  private resolveRound(ticks: number): void {
    const ring = this.drafters();
    const gifts: [Player, DraftCardId, number][] = [];
    for (const p of ring) {
      const id = p.smallID();
      const offer = this.offers.get(id);
      if (offer === undefined || offer.length === 0) continue;
      let choice = this.picked.get(id);
      if (choice === undefined) {
        // Out of time: a random one of the two.
        const random = new PseudoRandom(
          this.seed + this.round * 7907 + id * 131,
        );
        choice = offer[random.nextInt(0, offer.length)];
      }
      this.grant(p, choice);
      if (this.settings.declinedToOpponent) {
        const declined = offer.find((c) => c !== choice);
        const receiver = this.receiverOf(p, ring);
        if (declined !== undefined && receiver !== null) {
          gifts.push([receiver, declined, id]);
        }
      }
    }
    this.received = [];
    for (const [receiver, card, from] of gifts) {
      this.grant(receiver, card);
      this.received.push([receiver.smallID(), card, from]);
    }
    this.round++;
    this.offers.clear();
    this.picked.clear();
    if (this.round >= this.settings.picks) {
      this.phase = "done";
      if (this.freezeStart !== null && this.freezeEnd === null) {
        this.freezeEnd = ticks + 1;
      }
    } else if (this.settings.timing === "before") {
      // Straight on to the next round, still frozen.
      this.startRound(ticks);
    } else {
      if (this.epochs()) this.freezeEnd = ticks + 1;
      this.phase = "waiting";
      this.nextRoundTick = ticks + this.settings.intervalSeconds * 10;
    }
    this.dirty = true;
  }

  /** Who gets the card a player passed on: the next opponent in the ring. */
  private receiverOf(p: Player, ring: Player[]): Player | null {
    const i = ring.indexOf(p);
    for (let k = 1; k < ring.length; k++) {
      const q = ring[(i + k) % ring.length];
      if (q === p) continue;
      const team = p.team();
      if (team !== null && q.team() === team) continue;
      return q;
    }
    return null;
  }

  // ── Intents ────────────────────────────────────────────────────────────

  pick(player: Player, card: DraftCardId): boolean {
    if (this.phase !== "picking") return false;
    const id = player.smallID();
    const offer = this.offers.get(id);
    if (offer === undefined || !offer.includes(card)) return false;
    if (this.picked.has(id)) return false;
    this.picked.set(id, card);
    this.dirty = true;
    return true;
  }

  /** The epochs mode: the epochs are the tech tree, no research. */
  private epochs(): boolean {
    return this.settings.tech === "epochs";
  }

  startResearch(player: Player, card: DraftCardId): boolean {
    if (this.settings.tech === "none" || this.epochs()) return false;
    const id = player.smallID();
    const deck = this.decks.get(id);
    if (deck === undefined || this.research.has(id)) return false;
    const level = deck.get(card);
    if (level === undefined || level >= DRAFT_MAX_LEVEL) return false;
    const cost = draftResearchCost(this.settings, level + 1);
    const gold = BigInt(cost.gold);
    if (player.gold() < gold) return false;
    player.removeGold(gold);
    const ticks = this.mg.ticks();
    this.research.set(id, {
      card,
      startTick: ticks,
      endTick: ticks + cost.ticks,
    });
    this.dirty = true;
    return true;
  }

  private finishResearch(ticks: number): void {
    for (const [id, r] of [...this.research]) {
      if (ticks < r.endTick) continue;
      this.research.delete(id);
      const p = this.playerBySmallID(id);
      if (p !== null && p.isAlive()) this.levelUp(p, r.card);
      this.dirty = true;
    }
  }

  // ── Decks ──────────────────────────────────────────────────────────────

  private inPool(card: DraftCardId): boolean {
    return draftPool(this.settings).includes(card);
  }

  /** Puts a card in the deck (with any missing prerequisite), or levels it. */
  private grant(p: Player, card: DraftCardId): void {
    const deck = this.deckOf(p);
    for (const req of DRAFT_CARDS[card].requires) {
      if (this.inPool(req) && !deck.has(req)) this.grant(p, req);
    }
    if (deck.has(card)) {
      if (this.settings.tech !== "none") this.levelUp(p, card);
      return;
    }
    deck.set(card, 1);
    this.onLevelGained(p, card);
    this.unlockedCache.delete(p.smallID());
    this.dirty = true;
  }

  private levelUp(p: Player, card: DraftCardId): void {
    const deck = this.deckOf(p);
    const level = deck.get(card) ?? 0;
    if (level >= DRAFT_MAX_LEVEL) return;
    deck.set(card, level + 1);
    this.onLevelGained(p, card);
    this.unlockedCache.delete(p.smallID());
    this.dirty = true;
  }

  private onLevelGained(p: Player, card: DraftCardId): void {
    if (DRAFT_CARDS[card].perk === DraftPerk.WarChest) {
      p.addGold(BigInt(DRAFT_WAR_CHEST_GOLD));
    }
  }

  private deckOf(p: Player): Map<DraftCardId, number> {
    let deck = this.decks.get(p.smallID());
    if (deck === undefined) {
      deck = new Map();
      this.decks.set(p.smallID(), deck);
    }
    return deck;
  }

  // ── Offers ─────────────────────────────────────────────────────────────

  private usable(card: DraftCardId): boolean {
    const info = DRAFT_CARDS[card];
    if (info.units.length === 0 || info.units.every((t) => t.length === 0)) {
      return true;
    }
    const config = this.mg.config();
    // A card whose units the host switched off would be dead.
    return info.units.flat().some((u) => !config.isUnitDisabled(u));
  }

  private weightOf(card: DraftCardId, owned: boolean): number {
    const w = DRAFT_RARITY_WEIGHT[DRAFT_CARDS[card].rarity];
    return owned ? w / 2 : w;
  }

  private weighted(
    random: PseudoRandom,
    cards: DraftCardId[],
    weight: (c: DraftCardId) => number,
  ): DraftCardId | null {
    let total = 0;
    for (const c of cards) total += weight(c);
    if (cards.length === 0 || total <= 0) return null;
    let roll = random.nextFloat(0, total);
    for (const c of cards) {
      roll -= weight(c);
      if (roll < 0) return c;
    }
    return cards[cards.length - 1];
  }

  /** The round in which a defense card is guaranteed. */
  private defenseRound(): number {
    return Math.max(0, Math.ceil(this.settings.picks / 2) - 1);
  }

  /** Two cards for a player, from different categories if possible. */
  private drawOffers(p: Player): DraftCardId[] {
    const deck = this.deckOf(p);
    const leveling = this.settings.tech !== "none";
    const pool = draftPool(this.settings).filter((c) => {
      if (!this.usable(c)) return false;
      const level = deck.get(c);
      if (level !== undefined && (!leveling || level >= DRAFT_MAX_LEVEL)) {
        return false;
      }
      // Only cards whose prerequisites are already in the deck.
      return DRAFT_CARDS[c].requires.every(
        (r) => !this.inPool(r) || deck.has(r),
      );
    });
    const random = new PseudoRandom(
      this.seed + this.round * 7919 + p.smallID() * 104_651,
    );
    const weight = (c: DraftCardId) => this.weightOf(c, deck.has(c));
    let first: DraftCardId | null = null;
    if (
      this.round === this.defenseRound() &&
      !DRAFT_DEFENSE_CARDS.some((c) => deck.has(c))
    ) {
      first = this.weighted(
        random,
        pool.filter((c) => DRAFT_DEFENSE_CARDS.includes(c)),
        weight,
      );
    }
    first ??= this.weighted(random, pool, weight);
    if (first === null) return [];
    return this.withSecond(random, pool, first, weight);
  }

  /** One pair for everyone (offers "mirrored"); prerequisites come free. */
  private drawMirrored(): DraftCardId[] {
    let pool = draftPool(this.settings).filter(
      (c) => this.usable(c) && !this.shown.includes(c),
    );
    if (pool.length < 2) {
      // Everything has been shown once: start over.
      this.shown = [];
      pool = draftPool(this.settings).filter((c) => this.usable(c));
    }
    const random = new PseudoRandom(this.seed + this.round * 7919);
    const weight = (c: DraftCardId) => this.weightOf(c, false);
    let first: DraftCardId | null = null;
    if (this.round === this.defenseRound()) {
      first = this.weighted(
        random,
        pool.filter((c) => DRAFT_DEFENSE_CARDS.includes(c)),
        weight,
      );
    }
    first ??= this.weighted(random, pool, weight);
    if (first === null) return [];
    const pair = this.withSecond(random, pool, first, weight);
    this.shown.push(...pair);
    return pair;
  }

  private withSecond(
    random: PseudoRandom,
    pool: DraftCardId[],
    first: DraftCardId,
    weight: (c: DraftCardId) => number,
  ): DraftCardId[] {
    const category = DRAFT_CARDS[first].category;
    const other =
      this.weighted(
        random,
        pool.filter((c) => c !== first && DRAFT_CARDS[c].category !== category),
        weight,
      ) ??
      this.weighted(
        random,
        pool.filter((c) => c !== first),
        weight,
      );
    return other === null ? [first] : [first, other];
  }

  // ── Nations ────────────────────────────────────────────────────────────

  private archetypeOf(p: Player): DraftCategory {
    const n = NATION_ARCHETYPES.length;
    const i = Math.abs(simpleHash(p.id()) + this.seed) % n;
    return NATION_ARCHETYPES[i];
  }

  private nationsPick(): void {
    for (const p of this.drafters()) {
      if (p.type() !== PlayerType.Nation) continue;
      const offer = this.offers.get(p.smallID());
      if (offer === undefined || offer.length === 0) continue;
      const deck = this.deckOf(p);
      const archetype = this.archetypeOf(p);
      const hasDefense = DRAFT_DEFENSE_CARDS.some((c) => deck.has(c));
      const random = new PseudoRandom(
        this.seed + this.round * 613 + p.smallID() * 31,
      );
      if (this.epochs()) {
        this.pick(p, this.nationEpochChoice(p, offer, random));
        continue;
      }
      let best = offer[0];
      let bestScore = -Infinity;
      for (const c of offer) {
        const info = DRAFT_CARDS[c];
        let score = RARITY_SCORE[info.rarity] * 0.5;
        if (info.category === archetype) score += 3;
        if (!hasDefense && DRAFT_DEFENSE_CARDS.includes(c)) score += 2;
        if (info.base) score += 4;
        score += random.nextFloat(0, 1);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      this.pick(p, best);
    }
  }

  /**
   * Epochs mode: how a nation picks its doctrine. It sticks to its branch
   * (raising it is worth most), follows its archetype (or the arm closest
   * to it in epoch I, which only offers army, navy and air), skips the navy
   * without a coast, and takes air defense once rivals can nuke or bomb.
   */
  private nationEpochChoice(
    p: Player,
    offer: DraftCardId[],
    random: PseudoRandom,
  ): DraftCardId {
    const deck = this.deckOf(p);
    const archetype = this.archetypeOf(p);
    // Epoch I has no economy, defense or nuclear branch: the closest arm.
    const fallback: Partial<Record<DraftCategory, DraftCategory>> = {
      [DraftCategory.Economy]: DraftCategory.Army,
      [DraftCategory.Defense]: DraftCategory.Army,
      [DraftCategory.Nuclear]: DraftCategory.Air,
    };
    const coastal = this.hasCoast(p);
    const threat = [...this.decks].some(
      ([id, d]) =>
        id !== p.smallID() &&
        (d.has(DraftCardId.DocNuclear) ||
          (d.get(DraftCardId.DocAir) ?? 0) >= 2),
    );
    let best = offer[0];
    let bestScore = -Infinity;
    for (const c of offer) {
      const info = DRAFT_CARDS[c];
      let score = random.nextFloat(0, 1);
      if (deck.has(c)) score += 2.5;
      if (info.category === archetype) score += 3.5;
      // Only in epoch I: later the real branch is on offer and must win.
      else if (this.round === 0 && fallback[archetype] === info.category) {
        score += 1.5;
      }
      if (c === DraftCardId.DocNavy && !coastal) score -= 5;
      if (c === DraftCardId.DocDefense && threat && !deck.has(c)) score += 2.5;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  /** Whether a player has a shore on the ocean (for ships). */
  private hasCoast(p: Player): boolean {
    for (const t of p.borderTiles()) {
      if (this.mg.isOceanShore(t)) return true;
    }
    return false;
  }

  /** Nations research when rich: the card of their archetype first. */
  private nationsResearch(ticks: number): void {
    if (this.settings.tech === "none" || this.epochs() || ticks % 100 !== 0) {
      return;
    }
    for (const p of this.drafters()) {
      if (p.type() !== PlayerType.Nation) continue;
      if (this.research.has(p.smallID())) continue;
      const deck = this.deckOf(p);
      const archetype = this.archetypeOf(p);
      const candidates = [...deck]
        .filter(([, level]) => level < DRAFT_MAX_LEVEL)
        .sort(
          (a, b) =>
            Number(DRAFT_CARDS[b[0]].category === archetype) -
              Number(DRAFT_CARDS[a[0]].category === archetype) ||
            a[1] - b[1] ||
            (a[0] < b[0] ? -1 : 1),
        );
      if (candidates.length === 0) continue;
      const [card, level] = candidates[0];
      const cost = draftResearchCost(this.settings, level + 1);
      // Only with plenty to spare, like their other purchases.
      if (p.gold() < BigInt(cost.gold) * 3n) continue;
      this.startResearch(p, card);
    }
  }

  // ── Draft: what the decks change ───────────────────────────────────────

  isFrozenAt(tick: number): boolean {
    if (this.freezeStart === null || tick < this.freezeStart) return false;
    return this.freezeEnd === null || tick < this.freezeEnd;
  }

  allowsUnit(player: Player, type: UnitType): boolean {
    if (!this.governed.has(type)) return true;
    const id = player.smallID();
    const deck = this.decks.get(id);
    if (deck === undefined) return true;
    let unlocked = this.unlockedCache.get(id);
    if (unlocked === undefined) {
      unlocked = draftUnlockedUnits(deck);
      this.unlockedCache.set(id, unlocked);
    }
    return unlocked.has(type);
  }

  costFactor(player: Player, type: UnitType): number {
    const deck = this.decks.get(player.smallID());
    if (deck === undefined || deck.size === 0) return 1;
    return draftCostFactor(this.settings, deck, type);
  }

  factor(player: Player, kind: PoliticsFactor): number {
    const deck = this.decks.get(player.smallID());
    if (deck === undefined || deck.size === 0) return 1;
    return draftFactor(deck, kind);
  }

  attackLossFactor(attacker: Player, defender: Player | null): number {
    let factor = 1;
    const own = this.decks.get(attacker.smallID());
    if (own !== undefined) {
      factor *= Math.max(0.5, 1 - 0.08 * draftPerkLevel(own, DraftPerk.Elite));
    }
    if (defender !== null && defender !== attacker) {
      const theirs = this.decks.get(defender.smallID());
      if (theirs !== undefined) {
        factor *= 1 + 0.1 * draftPerkLevel(theirs, DraftPerk.Fortress);
      }
    }
    return factor;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private playerBySmallID(id: number): Player | null {
    const p = this.mg.playerBySmallID(id);
    return p.isPlayer() ? (p as Player) : null;
  }

  /** Humans and nations in the game, in small id order. */
  private drafters(): Player[] {
    return this.mg
      .players()
      .filter(
        (p) =>
          p.isAlive() &&
          (p.type() === PlayerType.Human || p.type() === PlayerType.Nation) &&
          // Once the draft started, only those who got a deck take part.
          (this.decks.size === 0 || this.decks.has(p.smallID())),
      )
      .sort((a, b) => a.smallID() - b.smallID());
  }

  private allHumansPicked(): boolean {
    let any = false;
    for (const p of this.drafters()) {
      if (p.type() !== PlayerType.Human || p.isDisconnected()) continue;
      if (!this.offers.has(p.smallID())) continue;
      any = true;
      if (!this.picked.has(p.smallID())) return false;
    }
    // Without connected humans the round still waits for its timer only in
    // "during" games; a nations-only "before" draft would stall the start.
    return any || this.settings.timing === "before" || this.epochs();
  }

  // ── View & snapshot ────────────────────────────────────────────────────

  private viewState(): DraftViewState {
    return {
      phase: this.phase,
      round: this.round,
      rounds: this.settings.picks,
      roundStart: this.roundStart,
      roundEnd: this.roundEnd,
      nextRoundTick: this.nextRoundTick,
      freezeStart: this.freezeStart,
      freezeEnd: this.freezeEnd,
      offers: [...this.offers].map(([id, o]) => [id, [...o]]),
      picked: [...this.picked],
      decks: [...this.decks].map(([id, d]) => [id, [...d]]),
      research: [...this.research].map(([player, r]) => ({ player, ...r })),
      received: this.received.map((r) => [...r]),
    };
  }

  snapshot(_w: SnapshotWriter): ExecRecord {
    return DraftExecutionSnapshot.write({
      gameID: this.gameID,
      initialized: this.mg !== undefined,
      active: this.active,
      seed: this.seed,
      phase: this.phase,
      round: this.round,
      roundStart: this.roundStart,
      roundEnd: this.roundEnd,
      nextRoundTick: this.nextRoundTick,
      freezeStart: this.freezeStart,
      freezeEnd: this.freezeEnd,
      offers: [...this.offers].map(([id, o]) => [id, [...o]]),
      picked: [...this.picked],
      decks: [...this.decks].map(([id, d]) => [id, [...d]]),
      research: [...this.research].map(([player, r]) => ({ player, ...r })),
      received: this.received.map((r) => [...r]),
      shown: [...this.shown],
      dirty: this.dirty,
    });
  }

  restoreSnapshot(s: DraftState, r: SnapshotReader): void {
    this.gameID = s.gameID;
    this.active = s.active;
    this.seed = s.seed;
    this.phase = s.phase;
    this.round = s.round;
    this.roundStart = s.roundStart;
    this.roundEnd = s.roundEnd;
    this.nextRoundTick = s.nextRoundTick;
    this.freezeStart = s.freezeStart;
    this.freezeEnd = s.freezeEnd;
    this.offers = new Map(s.offers.map(([id, o]) => [id, [...o]]));
    this.picked = new Map(s.picked);
    this.decks = new Map(s.decks.map(([id, d]) => [id, new Map(d)]));
    this.research = new Map(
      s.research.map((x) => [
        x.player,
        { card: x.card, startTick: x.startTick, endTick: x.endTick },
      ]),
    );
    this.received = s.received.map((x) => [...x]);
    this.shown = [...s.shown];
    // Restored through the prototype: field initializers did not run.
    this.unlockedCache = new Map();
    this.governed = new Set();
    this.dirty = s.dirty;
    if (s.initialized) this.setup(r.game);
  }
}

const zCard = () => z.enum(DraftCardId);

const DraftStateSchema = z.object({
  gameID: z.string(),
  initialized: z.boolean(),
  active: z.boolean(),
  seed: zInt(),
  phase: z.enum(["waiting", "picking", "done"]),
  round: zInt(),
  roundStart: zInt(),
  roundEnd: zInt(),
  nextRoundTick: zInt(),
  freezeStart: zInt().nullable(),
  freezeEnd: zInt().nullable(),
  offers: z.array(z.tuple([zInt(), z.array(zCard())])),
  picked: z.array(z.tuple([zInt(), zCard()])),
  decks: z.array(z.tuple([zInt(), z.array(z.tuple([zCard(), zInt()]))])),
  research: z.array(
    z.object({
      player: zInt(),
      card: zCard(),
      startTick: zInt(),
      endTick: zInt(),
    }),
  ),
  received: z.array(z.tuple([zInt(), zCard(), zInt()])),
  shown: z.array(zCard()),
  dirty: z.boolean(),
});
type DraftState = z.infer<typeof DraftStateSchema>;

export const DraftExecutionSnapshot = execSnapshotType({
  name: "Draft",
  version: 1,
  schema: DraftStateSchema,
  cls: () => DraftExecution,
});

/** The draft_pick intent. */
export class DraftPickExecution implements Execution {
  constructor(
    private player: Player,
    private card: DraftCardId,
  ) {}

  init(mg: Game, _ticks: number): void {
    const draft = mg.draft();
    if (draft instanceof DraftExecution) draft.pick(this.player, this.card);
  }

  tick(_ticks: number): void {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  activeDuringFreeze(): boolean {
    return true;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return DraftPickExecutionSnapshot.write({
      player: w.player(this.player),
      card: this.card,
    });
  }

  restoreSnapshot(s: DraftCardIntentState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.card = s.card;
  }
}

/** The draft_research intent. */
export class DraftResearchExecution implements Execution {
  constructor(
    private player: Player,
    private card: DraftCardId,
  ) {}

  init(mg: Game, _ticks: number): void {
    const draft = mg.draft();
    if (draft instanceof DraftExecution) {
      draft.startResearch(this.player, this.card);
    }
  }

  tick(_ticks: number): void {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return DraftResearchExecutionSnapshot.write({
      player: w.player(this.player),
      card: this.card,
    });
  }

  restoreSnapshot(s: DraftCardIntentState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.card = s.card;
  }
}

const DraftCardIntentStateSchema = z.object({
  player: zPlayerRef(),
  card: zCard(),
});
type DraftCardIntentState = z.infer<typeof DraftCardIntentStateSchema>;

export const DraftPickExecutionSnapshot = execSnapshotType({
  name: "DraftPick",
  version: 1,
  schema: DraftCardIntentStateSchema,
  cls: () => DraftPickExecution,
});

export const DraftResearchExecutionSnapshot = execSnapshotType({
  name: "DraftResearch",
  version: 1,
  schema: DraftCardIntentStateSchema,
  cls: () => DraftResearchExecution,
});
