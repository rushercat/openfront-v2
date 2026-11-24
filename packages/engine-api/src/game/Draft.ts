/**
 * openfront v2: the draft mode (GameConfig.draft).
 *
 * Before (or during) the game every human and nation builds a deck: each
 * round they are offered two cards and keep one. Only what is in the deck can
 * be built; the base set (cities, ports, defense posts, boats) is free unless
 * the host turns it off. Cards are units, packages of units or perks.
 *
 * Tech (DraftSettings.tech):
 * - none: a card is owned or not.
 * - levels: cards have levels 1–3, raised by drafting a card again or by
 *   researching it in game for gold. Unit cards get cheaper, perks stronger.
 * - doctrines: the draft offers doctrines (whole branches) instead; level 1
 *   unlocks the first tier, research unlocks tiers 2 and 3.
 *
 * Everything here is pure, so the engine and the client agree on the rules.
 */
import { Structures, UnitType } from "./GameTypes";
import { PoliticsFactor } from "./Politics";

export enum DraftCardId {
  // The base set: in the pool only when the host turns it off.
  City = "city",
  Port = "port",
  DefensePost = "defense_post",
  Boats = "boats",
  // Economy
  Factory = "factory",
  StateBank = "state_bank",
  TradeLeague = "trade_league",
  WarChest = "war_chest",
  MasterBuilders = "master_builders",
  // Defense
  Sam = "sam",
  Flak = "flak",
  LandMines = "land_mines",
  RepairStation = "repair_station",
  Fortress = "fortress",
  // Air
  AirForce = "air_force",
  Bombers = "bombers",
  Paratroopers = "paratroopers",
  // Navy
  Navy = "navy",
  SeaMines = "sea_mines",
  Submarine = "submarine",
  Carrier = "carrier",
  // Army
  Armor = "armor",
  EliteTroops = "elite_troops",
  Conscription = "conscription",
  // Nuclear
  Nukes = "nukes",
  HydrogenBomb = "hydrogen_bomb",
  Mirv = "mirv",
  CruiseMissile = "cruise_missile",
  // Doctrines (tech "doctrines"): a whole branch with three tiers.
  DocEconomy = "doc_economy",
  DocDefense = "doc_defense",
  DocAir = "doc_air",
  DocNavy = "doc_navy",
  DocArmy = "doc_army",
  DocNuclear = "doc_nuclear",
  DocPopulation = "doc_population",
}

export enum DraftCategory {
  Base = "base",
  Economy = "economy",
  Defense = "defense",
  Air = "air",
  Navy = "navy",
  Army = "army",
  Nuclear = "nuclear",
}

export enum DraftRarity {
  Common = "common",
  Rare = "rare",
  Epic = "epic",
  Legendary = "legendary",
}

export enum DraftPerk {
  /** +10 % gold income per level. */
  Gold = "gold",
  /** +25 % trade gold per level. */
  Trade = "trade",
  /** +10 % troop growth per level. */
  Troops = "troops",
  /** 1M gold for every level gained. */
  WarChest = "war_chest",
  /** Structures −10 % per level. */
  Builders = "builders",
  /** Attacks on you cost +10 % troops per level. */
  Fortress = "fortress",
  /** Your attacks lose 8 % fewer troops per level. */
  Elite = "elite",
}

export interface DraftCardInfo {
  category: DraftCategory;
  rarity: DraftRarity;
  /** Units unlocked per level (index 0 = level 1); cumulative. */
  units: UnitType[][];
  /** Cards that must be owned first (when they are in the pool). */
  requires: DraftCardId[];
  perk: DraftPerk | null;
  /** A doctrine (tech "doctrines") rather than a normal card. */
  doctrine: boolean;
  /** Part of the base set. */
  base: boolean;
}

export const DRAFT_MAX_LEVEL = 3;

const C = DraftRarity.Common;
const R = DraftRarity.Rare;
const E = DraftRarity.Epic;
const L = DraftRarity.Legendary;

function card(
  category: DraftCategory,
  rarity: DraftRarity,
  units: UnitType[][],
  requires: DraftCardId[] = [],
  perk: DraftPerk | null = null,
): DraftCardInfo {
  return {
    category,
    rarity,
    units,
    requires,
    perk,
    doctrine: false,
    base: category === DraftCategory.Base,
  };
}

function doctrine(
  category: DraftCategory,
  units: UnitType[][],
  perk: DraftPerk | null = null,
): DraftCardInfo {
  return {
    category,
    rarity: DraftRarity.Rare,
    units,
    requires: [],
    perk,
    doctrine: true,
    base: false,
  };
}

const U = UnitType;
const Cat = DraftCategory;

export const DRAFT_CARDS: Readonly<Record<DraftCardId, DraftCardInfo>> = {
  [DraftCardId.City]: card(Cat.Base, C, [[U.City]]),
  [DraftCardId.Port]: card(Cat.Base, C, [[U.Port]]),
  [DraftCardId.DefensePost]: card(Cat.Base, C, [[U.DefensePost]]),
  [DraftCardId.Boats]: card(Cat.Base, C, [[U.TransportShip]]),

  [DraftCardId.Factory]: card(Cat.Economy, C, [[U.Factory]]),
  [DraftCardId.StateBank]: card(Cat.Economy, R, [], [], DraftPerk.Gold),
  [DraftCardId.TradeLeague]: card(Cat.Economy, C, [], [], DraftPerk.Trade),
  [DraftCardId.WarChest]: card(Cat.Economy, C, [], [], DraftPerk.WarChest),
  [DraftCardId.MasterBuilders]: card(
    Cat.Economy,
    R,
    [],
    [],
    DraftPerk.Builders,
  ),

  [DraftCardId.Sam]: card(Cat.Defense, C, [[U.SAMLauncher]]),
  [DraftCardId.Flak]: card(Cat.Defense, C, [[U.AADefense]]),
  [DraftCardId.LandMines]: card(Cat.Defense, C, [[U.LandMine]]),
  [DraftCardId.RepairStation]: card(Cat.Defense, C, [[U.RepairStation]]),
  [DraftCardId.Fortress]: card(Cat.Defense, R, [], [], DraftPerk.Fortress),

  [DraftCardId.AirForce]: card(Cat.Air, R, [[U.Airfield, U.FighterJet]]),
  [DraftCardId.Bombers]: card(Cat.Air, E, [[U.Bomber]], [DraftCardId.AirForce]),
  [DraftCardId.Paratroopers]: card(
    Cat.Air,
    E,
    [[U.TransportPlane]],
    [DraftCardId.AirForce],
  ),

  [DraftCardId.Navy]: card(Cat.Navy, C, [[U.Warship]], [DraftCardId.Port]),
  [DraftCardId.SeaMines]: card(Cat.Navy, C, [[U.SeaMine]]),
  [DraftCardId.Submarine]: card(
    Cat.Navy,
    E,
    [[U.NuclearSubmarine]],
    [DraftCardId.Port, DraftCardId.Nukes],
  ),
  [DraftCardId.Carrier]: card(
    Cat.Navy,
    L,
    [[U.AircraftCarrier]],
    [DraftCardId.Port, DraftCardId.AirForce],
  ),

  [DraftCardId.Armor]: card(
    Cat.Army,
    R,
    [[U.RailDepot, U.Tank]],
    [DraftCardId.Factory],
  ),
  [DraftCardId.EliteTroops]: card(Cat.Army, R, [], [], DraftPerk.Elite),
  [DraftCardId.Conscription]: card(Cat.Army, R, [], [], DraftPerk.Troops),

  [DraftCardId.Nukes]: card(Cat.Nuclear, R, [[U.MissileSilo, U.AtomBomb]]),
  [DraftCardId.HydrogenBomb]: card(
    Cat.Nuclear,
    E,
    [[U.HydrogenBomb]],
    [DraftCardId.Nukes],
  ),
  [DraftCardId.Mirv]: card(Cat.Nuclear, L, [[U.MIRV]], [DraftCardId.Nukes]),
  [DraftCardId.CruiseMissile]: card(
    Cat.Nuclear,
    R,
    [[U.CruiseMissile]],
    [DraftCardId.Nukes],
  ),

  [DraftCardId.DocEconomy]: doctrine(
    Cat.Economy,
    [[U.Factory], [U.RepairStation], []],
    DraftPerk.Gold,
  ),
  [DraftCardId.DocDefense]: doctrine(
    Cat.Defense,
    [[U.SAMLauncher, U.AADefense], [U.LandMine], [U.RepairStation]],
    DraftPerk.Fortress,
  ),
  [DraftCardId.DocAir]: doctrine(Cat.Air, [
    [U.Airfield, U.FighterJet],
    [U.Bomber],
    [U.TransportPlane],
  ]),
  [DraftCardId.DocNavy]: doctrine(
    Cat.Navy,
    [[U.Warship], [U.SeaMine], [U.AircraftCarrier]],
    DraftPerk.Trade,
  ),
  [DraftCardId.DocArmy]: doctrine(
    Cat.Army,
    [[U.Factory, U.RailDepot, U.Tank], [], []],
    DraftPerk.Elite,
  ),
  [DraftCardId.DocNuclear]: doctrine(Cat.Nuclear, [
    [U.MissileSilo, U.AtomBomb],
    [U.CruiseMissile, U.HydrogenBomb],
    [U.MIRV, U.NuclearSubmarine],
  ]),
  [DraftCardId.DocPopulation]: doctrine(
    Cat.Economy,
    [[], [], []],
    DraftPerk.Troops,
  ),
};

export const ALL_DRAFT_CARDS: readonly DraftCardId[] =
  Object.values(DraftCardId);

/** Cards that count as anti-air / anti-nuke defense (guaranteed offer). */
export const DRAFT_DEFENSE_CARDS: readonly DraftCardId[] = [
  DraftCardId.Sam,
  DraftCardId.Flak,
  DraftCardId.DocDefense,
];

export const DRAFT_RARITY_WEIGHT: Readonly<Record<DraftRarity, number>> = {
  [DraftRarity.Common]: 10,
  [DraftRarity.Rare]: 6,
  [DraftRarity.Epic]: 3,
  [DraftRarity.Legendary]: 1,
};

// ── Settings ──────────────────────────────────────────────────────────────

export type DraftTiming = "before" | "during";
export type DraftOffers = "random" | "mirrored";
/**
 * none / levels / doctrines: see the draft mode. "epochs" (openfront v2
 * test mode, a candidate for the standard game): three epochs; at the
 * start of each, everyone picks one of three doctrines (picking one you
 * already have raises it a level), with the game frozen meanwhile. No
 * research: the epochs are the tech tree.
 */
export type DraftTech = "none" | "levels" | "doctrines" | "epochs";

/** Epochs mode: how many there are. */
export const DRAFT_EPOCHS = 3;

/** Epochs mode: default time from one epoch's choice to the next. */
export const DRAFT_EPOCH_SECONDS = 420;

/**
 * Epochs mode: the new doctrines each epoch offers, in order of preference
 * (an epoch shows three choices in all, see epochOffers):
 * I the three arms (land, sea, air), II nuclear arms and air defense,
 * III whatever is still missing.
 */
export const DRAFT_EPOCH_THEMES: readonly (readonly DraftCardId[])[] = [
  [DraftCardId.DocArmy, DraftCardId.DocNavy, DraftCardId.DocAir],
  [DraftCardId.DocNuclear, DraftCardId.DocDefense],
  [
    DraftCardId.DocNuclear,
    DraftCardId.DocDefense,
    DraftCardId.DocEconomy,
    DraftCardId.DocPopulation,
    DraftCardId.DocArmy,
    DraftCardId.DocNavy,
    DraftCardId.DocAir,
  ],
];

/**
 * Epochs mode: a player's three choices in an epoch (0-based). From the
 * second epoch on, the first choice raises their main doctrine (the
 * highest), in the third also their second one; the rest are new
 * doctrines of the epoch's theme. `usable` drops doctrines whose units
 * the lobby switched off.
 */
export function epochOffers(
  epoch: number,
  deck: DraftDeck,
  usable: (card: DraftCardId) => boolean = () => true,
): DraftCardId[] {
  const out: DraftCardId[] = [];
  const order = ALL_DRAFT_CARDS.filter((c) => DRAFT_CARDS[c].doctrine);
  if (epoch > 0) {
    const raisable = [...deck]
      .filter(
        ([c, level]) =>
          DRAFT_CARDS[c].doctrine && level < DRAFT_MAX_LEVEL && usable(c),
      )
      .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]));
    for (const [c] of raisable.slice(0, epoch === 1 ? 1 : 2)) out.push(c);
  }
  const theme =
    DRAFT_EPOCH_THEMES[Math.min(epoch, DRAFT_EPOCH_THEMES.length - 1)];
  for (const c of [...theme, ...order]) {
    if (out.length >= 3) break;
    if (!out.includes(c) && !deck.has(c) && usable(c)) out.push(c);
  }
  return out;
}

/** GameConfig.draft as it arrives (all but enabled optional). */
export interface DraftConfigLike {
  enabled: boolean;
  picks?: number;
  timing?: DraftTiming;
  offers?: DraftOffers;
  declinedToOpponent?: boolean;
  visibleDecks?: boolean;
  baseSet?: boolean;
  pickSeconds?: number;
  intervalSeconds?: number;
  tech?: DraftTech;
}

export interface DraftSettings {
  picks: number;
  timing: DraftTiming;
  offers: DraftOffers;
  declinedToOpponent: boolean;
  visibleDecks: boolean;
  baseSet: boolean;
  pickSeconds: number;
  intervalSeconds: number;
  tech: DraftTech;
}

/** The settings with defaults filled in, or null when the draft is off. */
export function draftSettings(
  cfg: DraftConfigLike | undefined | null,
): DraftSettings | null {
  if (cfg === undefined || cfg === null || !cfg.enabled) return null;
  const tech = cfg.tech ?? "none";
  if (tech === "epochs") {
    return {
      picks: DRAFT_EPOCHS,
      timing: "during",
      offers: "random",
      declinedToOpponent: false,
      visibleDecks: cfg.visibleDecks ?? true,
      baseSet: true,
      pickSeconds: cfg.pickSeconds ?? 20,
      intervalSeconds: cfg.intervalSeconds ?? DRAFT_EPOCH_SECONDS,
      tech,
    };
  }
  return {
    picks: cfg.picks ?? (tech === "doctrines" ? 3 : 6),
    timing: cfg.timing ?? "before",
    offers: cfg.offers ?? "random",
    declinedToOpponent: cfg.declinedToOpponent ?? false,
    visibleDecks: cfg.visibleDecks ?? true,
    baseSet: cfg.baseSet ?? true,
    pickSeconds: cfg.pickSeconds ?? 12,
    intervalSeconds: cfg.intervalSeconds ?? 120,
    tech,
  };
}

/** The cards that can be drafted with these settings. */
export function draftPool(s: DraftSettings): DraftCardId[] {
  return ALL_DRAFT_CARDS.filter((id) => {
    const info = DRAFT_CARDS[id];
    if (info.base) return !s.baseSet;
    return s.tech === "doctrines" || s.tech === "epochs"
      ? info.doctrine
      : !info.doctrine;
  });
}

/** Units the draft decides on: anything a card of the pool unlocks. */
export function draftGovernedUnits(s: DraftSettings): Set<UnitType> {
  const out = new Set<UnitType>();
  for (const id of draftPool(s)) {
    for (const tier of DRAFT_CARDS[id].units) {
      for (const u of tier) out.add(u);
    }
  }
  return out;
}

/** A deck: card → level. */
export type DraftDeck = ReadonlyMap<DraftCardId, number>;

export function draftUnlockedUnits(deck: DraftDeck): Set<UnitType> {
  const out = new Set<UnitType>();
  for (const [id, level] of deck) {
    const tiers = DRAFT_CARDS[id].units;
    for (let i = 0; i < Math.min(level, tiers.length); i++) {
      for (const u of tiers[i]) out.add(u);
    }
  }
  return out;
}

/** Summed level of the cards with this perk. */
export function draftPerkLevel(deck: DraftDeck, perk: DraftPerk): number {
  let level = 0;
  for (const [id, l] of deck) {
    if (DRAFT_CARDS[id].perk === perk) level += l;
  }
  return level;
}

/** Price multiplier of a unit type for a deck. */
export function draftCostFactor(
  s: DraftSettings,
  deck: DraftDeck,
  type: UnitType,
): number {
  let factor = 1;
  if (Structures.has(type)) {
    factor *= Math.max(0.5, 1 - 0.1 * draftPerkLevel(deck, DraftPerk.Builders));
  }
  if (s.tech === "levels") {
    for (const [id, level] of deck) {
      const info = DRAFT_CARDS[id];
      if (info.doctrine || info.units.length === 0) continue;
      if (info.units[0].includes(type)) {
        factor *= 1 - 0.15 * (Math.min(level, DRAFT_MAX_LEVEL) - 1);
        break;
      }
    }
  }
  return factor;
}

/** Multiplier on income / troop growth for a deck (like Politics.factor). */
export function draftFactor(deck: DraftDeck, kind: PoliticsFactor): number {
  const gold = 1 + 0.1 * draftPerkLevel(deck, DraftPerk.Gold);
  switch (kind) {
    case PoliticsFactor.GoldIncome:
      return gold;
    case PoliticsFactor.TradeGold:
      return gold * (1 + 0.25 * draftPerkLevel(deck, DraftPerk.Trade));
    case PoliticsFactor.TroopGrowth:
      return 1 + 0.1 * draftPerkLevel(deck, DraftPerk.Troops);
  }
}

/** Gold the war chest pays per level gained. */
export const DRAFT_WAR_CHEST_GOLD = 1_000_000;

/** What researching the next level costs: gold and ticks. */
export function draftResearchCost(
  s: DraftSettings,
  nextLevel: number,
): { gold: number; ticks: number } {
  if (s.tech === "doctrines") {
    return nextLevel <= 2
      ? { gold: 1_500_000, ticks: 300 }
      : { gold: 4_000_000, ticks: 600 };
  }
  return nextLevel <= 2
    ? { gold: 1_000_000, ticks: 200 }
    : { gold: 3_000_000, ticks: 400 };
}

// ── View ──────────────────────────────────────────────────────────────────

export type DraftPhase = "waiting" | "picking" | "done";

export interface DraftResearchView {
  player: number;
  card: DraftCardId;
  startTick: number;
  endTick: number;
}

export interface DraftViewState {
  phase: DraftPhase;
  /** Current round (0-based) and how many there are. */
  round: number;
  rounds: number;
  roundStart: number;
  roundEnd: number;
  /** When the next round starts (timing "during"). */
  nextRoundTick: number;
  /** The game is frozen for ticks in [freezeStart, freezeEnd). */
  freezeStart: number | null;
  freezeEnd: number | null;
  /** The two cards each player is offered this round. */
  offers: [number, DraftCardId[]][];
  /** Who has already picked what this round. */
  picked: [number, DraftCardId][];
  /** Every player's deck: card and level. */
  decks: [number, [DraftCardId, number][]][];
  research: DraftResearchView[];
  /** Cards given away last round: receiver, card, giver. */
  received: [number, DraftCardId, number][];
}

export function draftDeckOf(
  state: Pick<DraftViewState, "decks"> | null,
  smallID: number,
): Map<DraftCardId, number> | null {
  const entry = state?.decks.find(([id]) => id === smallID);
  return entry === undefined ? null : new Map(entry[1]);
}

/**
 * Whether a player may build a unit type. Players without a deck (tribes)
 * and units no card decides on are always allowed.
 */
export function draftAllowsUnit(
  s: DraftSettings,
  deck: DraftDeck | null,
  type: UnitType,
  governed: Set<UnitType> = draftGovernedUnits(s),
): boolean {
  if (deck === null || !governed.has(type)) return true;
  return draftUnlockedUnits(deck).has(type);
}
