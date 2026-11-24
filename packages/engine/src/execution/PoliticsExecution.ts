import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerType,
  Structures,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  ActiveDecreeView,
  ALL_DECREES,
  DecreeOutcome,
  DecreeResultView,
  decreeFactor,
  DECREES,
  DecreeType,
  PoliticsFactor,
  PoliticsPhase,
  PoliticsViewState,
  ProposalView,
  VoteChoice,
} from "@openfront/engine-api/game/Politics";
import { GameID } from "@openfront/engine-api/Schemas";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { zInt, zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import {
  Execution,
  Game,
  MutableAlliance,
  Player,
  Politics,
} from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { isFixedScenarioAlliance } from "./HistoricalScenarioExecution";
import { decreeBenefit, PoliticsContext } from "./politics/PoliticsAI";
import { secede } from "./UnrestExecution";

/** Ticks between refreshes of the rankings decrees read (and keepalives). */
const REFRESH_INTERVAL = 50;
/** Wealth tax: how often it is levied, and the share the rich pay. */
const WEALTH_TAX_INTERVAL = 300;
const WEALTH_TAX_SHARE = 0.05;
/** Safe zone: players with less than this share of the land are safe. */
const SAFE_ZONE_SHARE = 0.03;
/** Bounty: gold per tile taken from the leader. */
const BOUNTY_GOLD_PER_TILE = 1_000n;
/** Natural disaster: troops the struck player loses. */
const DISASTER_TROOP_SHARE = 0.25;
/** Rebellion: land of the leader that breaks away. */
const REBELLION_LAND_SHARE = 0.1;
/** Alliance limit: alliances a player may have. */
const ALLIANCE_LIMIT = 2;
/** Secret decree: seconds until everyone learns what passed. */
const SECRET_REVEAL_TICKS = 600;
/** Decrees offered to each player per round. */
const OFFERS_PER_PLAYER = 3;
/** Chance a nation puts a decree forward, by difficulty. */
/** Proposals nations may make per round at most (humans get the rest). */
const NATION_MAX_PROPOSALS = 2;
const NATION_PROPOSE_CHANCE: Record<string, number> = {
  Easy: 0,
  Medium: 0.15,
  Hard: 0.3,
  Impossible: 0.4,
};

const ARMS_BOOM_TYPES: readonly UnitType[] = [
  UnitType.MissileSilo,
  UnitType.SAMLauncher,
  UnitType.DefensePost,
  UnitType.AADefense,
  UnitType.Airfield,
];
const NUKE_TYPES: readonly UnitType[] = [
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
];
const BLACK_MARKET_TYPES: readonly UnitType[] = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.DefensePost,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
  UnitType.AADefense,
  UnitType.Airfield,
  UnitType.Warship,
  UnitType.AtomBomb,
];

interface Proposal {
  id: number;
  decree: DecreeType;
  proposer: number;
  target: number | null;
  votes: Map<number, VoteChoice>;
}

interface ActiveDecree {
  id: number;
  decree: DecreeType;
  target: number | null;
  startTick: number;
  endTick: number;
  secret: boolean;
  revealTick: number;
  prices: [string, number][];
}

/**
 * The world congress (GameFeature.Politics, engine-api game/Politics).
 *
 * Runs the rounds: proposing (game running) → voting (game frozen, see
 * Game.isFrozen) → the passed decrees go into force. It is also the Politics
 * the rules ask what the decrees in force change.
 */
export class PoliticsExecution implements Execution, Politics {
  private mg: Game;
  private active = true;
  private seed = 0;

  private phase: PoliticsPhase = "idle";
  private phaseStart = 0;
  private phaseEnd = 0;
  private nextRoundTick = -1;
  private freezeStart: number | null = null;
  private freezeEnd: number | null = null;

  private offers = new Map<number, DecreeType[]>();
  private proposals: Proposal[] = [];
  private nextProposalId = 1;
  private weights = new Map<number, number>();

  private decrees: ActiveDecree[] = [];
  private nextDecreeId = 1;
  private results: DecreeResultView[] = [];
  private resultsTick = -1;
  private lastMalusTarget: number | null = null;

  /** Rankings decrees read, refreshed every REFRESH_INTERVAL ticks. */
  private bottomThird = new Set<number>();

  private dirty = true;

  constructor(private gameID: GameID) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.seed = simpleHash(this.gameID) + 7919;
    this.nextRoundTick = ticks + mg.config().politicsFirstRoundTicks();
    mg.setPolitics(this);
    this.refreshRankings();
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

  // ── The round ──────────────────────────────────────────────────────────

  tick(ticks: number): void {
    if (ticks % REFRESH_INTERVAL === 0) this.refreshRankings();
    this.expireDecrees(ticks);
    if (!this.isFrozenAt(ticks)) this.applyPeriodicEffects(ticks);

    switch (this.phase) {
      case "idle":
        if (
          ticks >= this.nextRoundTick &&
          this.freeSlots() > 0 &&
          this.voters().length >= 2
        ) {
          this.startProposing(ticks);
        }
        break;
      case "proposing":
        if (ticks >= this.phaseEnd || this.allHumansProposed()) {
          if (this.proposals.length === 0) {
            this.endRound(ticks);
          } else {
            this.startVoting(ticks);
          }
        }
        break;
      case "voting":
        if (
          this.freezeEnd !== null &&
          ticks >= this.freezeStart! &&
          (ticks + 1 >= this.freezeEnd || this.allHumansVoted())
        ) {
          this.freezeEnd = ticks + 1;
          this.phaseEnd = this.freezeEnd;
          this.resolve(ticks);
        }
        break;
    }

    if (this.dirty || ticks % REFRESH_INTERVAL === 0) {
      this.dirty = false;
      this.mg.addUpdate({
        type: GameUpdateType.Politics,
        state: this.viewState(),
      });
    }
  }

  private startProposing(ticks: number): void {
    const config = this.mg.config();
    this.phase = "proposing";
    this.phaseStart = ticks;
    this.phaseEnd = ticks + config.politicsProposalTicks();
    this.proposals = [];
    this.offers.clear();
    for (const player of this.voters()) {
      this.offers.set(player.smallID(), this.drawOffers(player, ticks));
    }
    this.nationsPropose(ticks);
    this.dirty = true;
  }

  private startVoting(ticks: number): void {
    const config = this.mg.config();
    this.phase = "voting";
    // Frozen from the next tick, so this tick runs normally everywhere.
    this.phaseStart = ticks + 1;
    this.phaseEnd = this.phaseStart + config.politicsVotingTicks();
    this.freezeStart = this.phaseStart;
    this.freezeEnd = this.phaseEnd;
    this.weights.clear();
    for (const player of this.voters()) {
      this.weights.set(
        player.smallID(),
        config.politicsVoteWeight(player, player.isTraitor()),
      );
    }
    this.nationsVote(ticks);
    this.dirty = true;
  }

  private endRound(ticks: number): void {
    this.phase = "idle";
    this.phaseStart = ticks;
    this.phaseEnd = ticks;
    this.offers.clear();
    this.proposals = [];
    this.nextRoundTick = ticks + this.mg.config().politicsIntervalTicks();
    this.dirty = true;
  }

  private resolve(ticks: number): void {
    const config = this.mg.config();
    let free = this.freeSlots();
    const tallies = this.proposals.map((p) => {
      let yes = 0;
      let no = 0;
      let total = 0;
      let vetoed = false;
      for (const [id, weight] of this.weights) {
        if (id === p.target) continue;
        total += weight;
        const vote = p.votes.get(id);
        if (vote === "yes") yes += weight;
        else if (vote === "no") no += weight;
        else if (vote === "veto") vetoed = true;
      }
      let outcome: DecreeOutcome = "passed";
      const target = p.target === null ? null : this.playerBySmallID(p.target);
      if (vetoed) outcome = "vetoed";
      else if (p.target !== null && (target === null || !target.isAlive()))
        outcome = "failed";
      else if (yes + no < config.politicsQuorum() * total)
        outcome = "no_quorum";
      else if (yes <= no) outcome = "failed";
      const tally: {
        p: Proposal;
        yes: number;
        no: number;
        total: number;
        outcome: DecreeOutcome;
      } = { p, yes, no, total, outcome };
      return tally;
    });
    // The clearest majorities take the free slots.
    const passing = tallies
      .filter((t) => t.outcome === "passed")
      .sort((a, b) => b.yes - b.no - (a.yes - a.no) || a.p.id - b.p.id);
    const enacted = new Set<DecreeType>();
    for (const t of passing) {
      if (
        free <= 0 ||
        enacted.has(t.p.decree) ||
        this.isDecreeActive(t.p.decree)
      ) {
        t.outcome = "no_slot";
        continue;
      }
      enacted.add(t.p.decree);
      free--;
      const struck = this.enact(t.p, ticks);
      if (struck !== undefined) t.p.target = struck;
    }
    this.results = tallies.map((t) => ({
      proposalId: t.p.id,
      decree: t.p.decree,
      proposer: t.p.proposer,
      target: t.p.target,
      outcome: t.outcome,
      yes: Math.round(t.yes * 100) / 100,
      no: Math.round(t.no * 100) / 100,
      total: Math.round(t.total * 100) / 100,
      votes: [...t.p.votes].sort((a, b) => a[0] - b[0]),
    }));
    this.resultsTick = ticks;
    this.endRound(ticks);
  }

  // ── Intents ────────────────────────────────────────────────────────────

  /** A player puts one of their offers forward. Returns whether it worked. */
  propose(
    player: Player,
    decree: DecreeType,
    targetID: string | null,
  ): boolean {
    if (this.phase !== "proposing") return false;
    const id = player.smallID();
    if (!this.isVoter(player)) return false;
    if (!(this.offers.get(id) ?? []).includes(decree)) return false;
    if (this.proposals.some((p) => p.proposer === id)) return false;
    // The same decree twice in one round would only split the vote.
    if (this.proposals.some((p) => p.decree === decree)) return false;
    if (this.proposals.length >= this.mg.config().politicsMaxProposals()) {
      return false;
    }
    // Nations propose the moment a round opens: without a cap they would
    // take every slot before a human could click.
    if (
      player.type() === PlayerType.Nation &&
      this.nationProposals() >= this.nationProposalCap()
    ) {
      return false;
    }
    const info = DECREES[decree];
    let target: number | null = null;
    if (info.targeting === "leader") {
      const leader = this.leader();
      if (leader === null || leader === player) return false;
      target = leader.smallID();
    } else if (info.targeting === "player") {
      if (targetID === null || !this.mg.hasPlayer(targetID)) return false;
      const t = this.mg.player(targetID);
      if (t === player || !this.isVoter(t)) return false;
      target = t.smallID();
    }
    if (target !== null && info.malus && this.isProtected(target)) return false;

    const cost = this.share(
      player.gold(),
      this.mg.config().politicsProposalCostPercent(),
    );
    player.removeGold(cost);
    this.proposals.push({
      id: this.nextProposalId++,
      decree,
      proposer: id,
      target,
      votes: new Map(),
    });
    this.dirty = true;
    return true;
  }

  /** A player votes on a proposal. A veto is final and costs gold. */
  vote(player: Player, proposalId: number, choice: VoteChoice): boolean {
    if (this.phase !== "voting") return false;
    const id = player.smallID();
    if (!this.weights.has(id)) return false;
    const proposal = this.proposals.find((p) => p.id === proposalId);
    if (proposal === undefined || proposal.target === id) return false;
    if (proposal.votes.get(id) === "veto") return false;
    if (choice === "veto") {
      const cost = this.share(
        player.gold(),
        this.mg.config().politicsVetoCostPercent(),
      );
      player.removeGold(cost);
    }
    proposal.votes.set(id, choice);
    this.dirty = true;
    return true;
  }

  // ── Effects of passing ─────────────────────────────────────────────────

  /**
   * Puts a passed decree into force. Returns the small id of the player a
   * chance decree struck, if any.
   */
  private enact(p: Proposal, ticks: number): number | undefined {
    const info = DECREES[p.decree];
    if (info.malus && p.target !== null) this.lastMalusTarget = p.target;
    const random = new PseudoRandom(this.seed + ticks * 31 + p.id * 101);

    switch (p.decree) {
      case DecreeType.SpyScandal:
        this.dissolveAlliances();
        return undefined;
      case DecreeType.NaturalDisaster: {
        const voters = this.voters();
        if (voters.length === 0) return undefined;
        const struck = voters[random.nextInt(0, voters.length)];
        struck.removeTroops(Math.floor(struck.troops() * DISASTER_TROOP_SHARE));
        return struck.smallID();
      }
      case DecreeType.Rebellion: {
        const leader =
          p.target === null ? null : this.playerBySmallID(p.target);
        if (leader !== null && leader.isAlive()) {
          secede(this.mg, this.gameID, leader, REBELLION_LAND_SHARE);
        }
        return undefined;
      }
      case DecreeType.Disarmament:
        for (const silo of this.mg.units(UnitType.MissileSilo)) {
          silo.delete(false);
        }
        break;
      case DecreeType.SecretDecree: {
        const pool = ALL_DECREES.filter(
          (d) =>
            d !== DecreeType.SecretDecree &&
            DECREES[d].targeting === "none" &&
            !DECREES[d].oneTime &&
            !this.isDecreeActive(d),
        );
        if (pool.length === 0) return undefined;
        const secret = pool[random.nextInt(0, pool.length)];
        this.addDecree(secret, null, ticks, true, random);
        return undefined;
      }
    }
    if (!info.oneTime) this.addDecree(p.decree, p.target, ticks, false, random);
    return undefined;
  }

  private addDecree(
    decree: DecreeType,
    target: number | null,
    ticks: number,
    secret: boolean,
    random: PseudoRandom,
  ): void {
    const prices: [string, number][] = [];
    if (decree === DecreeType.BlackMarket) {
      const pool = [...BLACK_MARKET_TYPES];
      for (let i = 0; i < 3 && pool.length > 0; i++) {
        const [type] = pool.splice(random.nextInt(0, pool.length), 1);
        prices.push([type, random.chance(2) ? 0.6 : 1.5]);
      }
    }
    this.decrees.push({
      id: this.nextDecreeId++,
      decree,
      target,
      startTick: ticks,
      endTick: ticks + DECREES[decree].durationSeconds * 10,
      secret,
      revealTick: secret ? ticks + SECRET_REVEAL_TICKS : ticks,
      prices,
    });
    this.dirty = true;
  }

  private dissolveAlliances(): void {
    const seen = new Set<number>();
    const toExpire: MutableAlliance[] = [];
    for (const player of this.mg.players()) {
      for (const alliance of player.alliances()) {
        if (seen.has(alliance.id())) continue;
        seen.add(alliance.id());
        if (
          isFixedScenarioAlliance(
            this.mg,
            alliance.requestor(),
            alliance.recipient(),
          )
        ) {
          continue;
        }
        toExpire.push(alliance);
      }
    }
    for (const alliance of toExpire) alliance.expire();
  }

  private expireDecrees(ticks: number): void {
    const before = this.decrees.length;
    this.decrees = this.decrees.filter((d) => d.endTick > ticks);
    if (this.decrees.length !== before) this.dirty = true;
  }

  private applyPeriodicEffects(ticks: number): void {
    if (
      ticks % WEALTH_TAX_INTERVAL === 0 &&
      this.isDecreeActive(DecreeType.WealthTax)
    ) {
      this.levyWealthTax();
    }
  }

  private levyWealthTax(): void {
    const voters = this.voters().sort(
      (a, b) =>
        (a.gold() < b.gold() ? 1 : a.gold() > b.gold() ? -1 : 0) ||
        a.smallID() - b.smallID(),
    );
    if (voters.length < 2) return;
    const rich = voters.slice(0, Math.ceil(voters.length / 4));
    const poor = voters.slice(voters.length - Math.floor(voters.length / 2));
    const poorOnly = poor.filter((p) => !rich.includes(p));
    if (poorOnly.length === 0) return;
    let pool = 0n;
    for (const p of rich) {
      pool += p.removeGold(this.share(p.gold(), WEALTH_TAX_SHARE * 100));
    }
    const each = pool / BigInt(poorOnly.length);
    if (each <= 0n) return;
    for (const p of poorOnly) p.addGold(each);
  }

  // ── Politics: what the decrees change ──────────────────────────────────

  isFrozenAt(tick: number): boolean {
    if (this.freezeStart === null || tick < this.freezeStart) return false;
    return this.freezeEnd === null || tick < this.freezeEnd;
  }

  isDecreeActive(decree: DecreeType): boolean {
    for (const d of this.decrees) if (d.decree === decree) return true;
    return false;
  }

  private targetOf(decree: DecreeType): number | null {
    for (const d of this.decrees) if (d.decree === decree) return d.target;
    return null;
  }

  factor(player: Player, kind: PoliticsFactor): number {
    if (this.decrees.length === 0) return 1;
    return decreeFactor(this.decrees, player.smallID(), this.bottomThird, kind);
  }

  costFactor(type: UnitType): number {
    if (this.decrees.length === 0) return 1;
    let factor = 1;
    for (const d of this.decrees) {
      switch (d.decree) {
        case DecreeType.Recession:
          if (Structures.has(type)) factor *= 1.25;
          break;
        case DecreeType.ArmsBoom:
          if (ARMS_BOOM_TYPES.includes(type)) factor *= 0.7;
          break;
        case DecreeType.NuclearEscalation:
          if (NUKE_TYPES.includes(type)) factor *= 0.5;
          break;
        case DecreeType.BlackMarket:
          for (const [t, f] of d.prices) if (t === type) factor *= f;
          break;
      }
    }
    return factor;
  }

  forbidsUnit(_player: Player, type: UnitType): boolean {
    for (const d of this.decrees) {
      switch (d.decree) {
        case DecreeType.NuclearPeace:
          if (NUKE_TYPES.includes(type)) return true;
          break;
        case DecreeType.MirvBan:
          if (type === UnitType.MIRV) return true;
          break;
        case DecreeType.Disarmament:
          if (type === UnitType.MissileSilo) return true;
          break;
        case DecreeType.AmphibiousMoratorium:
          if (type === UnitType.TransportShip) return true;
          break;
        case DecreeType.Ceasefire:
          if (
            NUKE_TYPES.includes(type) ||
            type === UnitType.CruiseMissile ||
            type === UnitType.TransportPlane
          ) {
            return true;
          }
          break;
      }
    }
    return false;
  }

  forbidsAttack(attacker: Player, target: Player): boolean {
    if (this.decrees.length === 0 || attacker === target) return false;
    // Tribes are fair game, and they don't take part.
    if (
      attacker.type() === PlayerType.Bot ||
      target.type() === PlayerType.Bot
    ) {
      return false;
    }
    for (const d of this.decrees) {
      switch (d.decree) {
        case DecreeType.Ceasefire:
          return true;
        case DecreeType.SafeZone:
          if (
            target.numTilesOwned() <
            SAFE_ZONE_SHARE * this.mg.totalLandTiles()
          ) {
            return true;
          }
          break;
        case DecreeType.Neutrality:
          if (
            attacker.alliances().length === 0 ||
            target.alliances().length === 0
          ) {
            return true;
          }
          break;
      }
    }
    return false;
  }

  attackLossFactor(attacker: Player, defender: Player | null): number {
    if (defender === null || this.decrees.length === 0) return 1;
    let factor = 1;
    for (const d of this.decrees) {
      switch (d.decree) {
        case DecreeType.WarWeariness:
          factor *= 1.3;
          break;
        case DecreeType.Blitzkrieg:
          factor *= 1.25;
          break;
        case DecreeType.CommonEnemy:
          if (d.target === defender.smallID() && attacker !== defender) {
            factor *= 0.75;
          }
          break;
        case DecreeType.DefensePact:
          if (defender.alliances().length > 0) factor *= 1.25;
          break;
      }
    }
    return factor;
  }

  attackSpeedFactor(): number {
    return this.isDecreeActive(DecreeType.Blitzkrieg) ? 1.5 : 1;
  }

  protectsTile(attacker: Player, tile: TileRef, range: number): boolean {
    if (!this.isDecreeActive(DecreeType.GenevaConvention)) return false;
    const owner = this.mg.owner(tile);
    if (!owner.isPlayer() || owner === attacker) return false;
    const id = owner.id();
    return (
      this.mg.hasUnitNearby(tile, range, UnitType.City, id) ||
      this.mg.hasUnitNearby(tile, range, UnitType.Port, id) ||
      this.mg.hasUnitNearby(tile, range, UnitType.Capital, id)
    );
  }

  onConquer(attacker: Player, previousOwner: Player): void {
    if (attacker === previousOwner) return;
    const target = this.targetOf(DecreeType.Bounty);
    if (target !== null && target === previousOwner.smallID()) {
      attacker.addGold(BOUNTY_GOLD_PER_TILE);
    }
  }

  tradeBlocked(a: Player, b: Player): boolean {
    const target = this.targetOf(DecreeType.TotalEmbargo);
    return (
      target !== null && (a.smallID() === target || b.smallID() === target)
    );
  }

  allianceBlocked(a: Player, b: Player): boolean {
    if (!this.isDecreeActive(DecreeType.AllianceLimit)) return false;
    return (
      a.alliances().length >= ALLIANCE_LIMIT ||
      b.alliances().length >= ALLIANCE_LIMIT
    );
  }

  navalDefenseOnly(): boolean {
    return this.isDecreeActive(DecreeType.NavalBan);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private share(gold: bigint, percent: number): bigint {
    if (gold <= 0n) return 0n;
    return BigInt(Math.floor(Number(gold) * (percent / 100)));
  }

  private playerBySmallID(id: number): Player | null {
    const p = this.mg.playerBySmallID(id);
    return p.isPlayer() ? (p as Player) : null;
  }

  private isVoter(player: Player): boolean {
    return (
      player.isAlive() &&
      player.hasSpawned() &&
      player.numTilesOwned() > 0 &&
      (player.type() === PlayerType.Human ||
        player.type() === PlayerType.Nation)
    );
  }

  /** Who takes part: humans and nations with land, in small id order. */
  private voters(): Player[] {
    return this.mg
      .players()
      .filter((p) => this.isVoter(p))
      .sort((a, b) => a.smallID() - b.smallID());
  }

  private leader(): Player | null {
    let best: Player | null = null;
    for (const p of this.voters()) {
      if (best === null || p.numTilesOwned() > best.numTilesOwned()) best = p;
    }
    return best;
  }

  private freeSlots(): number {
    return this.mg.config().politicsMaxActive() - this.decrees.length;
  }

  /** Anti-mobbing: never the same player twice in a row, never two at once. */
  private isProtected(target: number): boolean {
    if (this.lastMalusTarget === target) return true;
    for (const d of this.decrees) {
      if (DECREES[d.decree].malus && d.target === target) return true;
    }
    for (const p of this.proposals) {
      if (DECREES[p.decree].malus && p.target === target) return true;
    }
    return false;
  }

  private refreshRankings(): void {
    const voters = this.voters().sort(
      (a, b) =>
        a.numTilesOwned() - b.numTilesOwned() || a.smallID() - b.smallID(),
    );
    this.bottomThird = new Set(
      voters
        .slice(
          0,
          voters.length < 2 ? 0 : Math.max(1, Math.floor(voters.length / 3)),
        )
        .map((p) => p.smallID()),
    );
  }

  /** Three decrees for one player, from those that make sense right now. */
  private drawOffers(player: Player, ticks: number): DecreeType[] {
    const id = player.smallID();
    const leader = this.leader();
    const others = this.voters().filter((p) => p !== player);
    const pool = ALL_DECREES.filter((d) => {
      if (this.isDecreeActive(d)) return false;
      const info = DECREES[d];
      if (info.targeting === "leader") {
        return (
          leader !== null &&
          leader !== player &&
          !this.isProtected(leader.smallID())
        );
      }
      if (info.targeting === "player") {
        return others.some(
          (o) => !info.malus || !this.isProtected(o.smallID()),
        );
      }
      return true;
    });
    const random = new PseudoRandom(this.seed + ticks * 31 + id * 7919);
    const out: DecreeType[] = [];
    while (out.length < OFFERS_PER_PLAYER && pool.length > 0) {
      out.push(pool.splice(random.nextInt(0, pool.length), 1)[0]);
    }
    return out;
  }

  private nationProposals(): number {
    let n = 0;
    for (const p of this.proposals) {
      if (this.playerBySmallID(p.proposer)?.type() === PlayerType.Nation) n++;
    }
    return n;
  }

  /**
   * How many proposals nations may make in a round: the slots the humans
   * can't fill, at most NATION_MAX_PROPOSALS.
   */
  nationProposalCap(): number {
    const humans = this.voters().filter(
      (p) => p.type() === PlayerType.Human && !p.isDisconnected(),
    ).length;
    const free = this.mg.config().politicsMaxProposals() - humans;
    return Math.max(0, Math.min(NATION_MAX_PROPOSALS, free));
  }

  private allHumansProposed(): boolean {
    let any = false;
    for (const p of this.voters()) {
      if (p.type() !== PlayerType.Human || p.isDisconnected()) continue;
      any = true;
      if (!this.proposals.some((q) => q.proposer === p.smallID())) return false;
    }
    return any;
  }

  private allHumansVoted(): boolean {
    for (const [id] of this.weights) {
      const p = this.playerBySmallID(id);
      if (p === null || p.type() !== PlayerType.Human || p.isDisconnected()) {
        continue;
      }
      for (const proposal of this.proposals) {
        if (proposal.target === id) continue;
        if (!proposal.votes.has(id)) return false;
      }
    }
    return true;
  }

  // ── Nations ────────────────────────────────────────────────────────────

  private context(): PoliticsContext {
    const voters = this.voters();
    const tiles = voters.map((p) => p.numTilesOwned()).sort((a, b) => a - b);
    return {
      game: this.mg,
      leader: this.leader(),
      bottomThird: this.bottomThird,
      medianTiles: tiles.length === 0 ? 0 : tiles[Math.floor(tiles.length / 2)],
    };
  }

  private nationsPropose(ticks: number): void {
    const chance =
      NATION_PROPOSE_CHANCE[this.mg.config().gameConfig().difficulty] ?? 0;
    if (chance <= 0) return;
    const ctx = this.context();
    for (const nation of this.voters()) {
      if (nation.type() !== PlayerType.Nation) continue;
      const random = new PseudoRandom(
        this.seed + ticks * 17 + nation.smallID() * 131,
      );
      if (random.nextFloat(0, 1) >= chance) continue;
      let best: {
        decree: DecreeType;
        target: Player | null;
        score: number;
      } | null = null;
      for (const decree of this.offers.get(nation.smallID()) ?? []) {
        const target = this.nationTarget(nation, decree, ctx);
        if (DECREES[decree].targeting === "player" && target === null) continue;
        const t = DECREES[decree].targeting === "leader" ? ctx.leader : target;
        const score = decreeBenefit(ctx, nation, decree, t);
        if (best === null || score > best.score) {
          best = { decree, target, score };
        }
      }
      if (best === null || best.score < 0.3) continue;
      this.propose(nation, best.decree, best.target?.id() ?? null);
    }
  }

  /** Whom a nation aims a decree at: its worst enemy, or its best friend. */
  private nationTarget(
    nation: Player,
    decree: DecreeType,
    ctx: PoliticsContext,
  ): Player | null {
    const info = DECREES[decree];
    if (info.targeting !== "player") return null;
    const others = this.voters().filter((p) => p !== nation);
    let best: Player | null = null;
    let bestScore = -Infinity;
    for (const o of others) {
      if (info.malus && this.isProtected(o.smallID())) continue;
      const score = decreeBenefit(ctx, nation, decree, o);
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return best;
  }

  private nationsVote(ticks: number): void {
    const ctx = this.context();
    for (const nation of this.voters()) {
      if (nation.type() !== PlayerType.Nation) continue;
      for (const p of this.proposals) {
        if (p.target === nation.smallID()) continue;
        const target =
          p.target === null ? null : this.playerBySmallID(p.target);
        let score = decreeBenefit(ctx, nation, p.decree, target);
        if (p.proposer === nation.smallID()) score += 1;
        const random = new PseudoRandom(
          this.seed + ticks * 13 + nation.smallID() * 977 + p.id * 31,
        );
        score += random.nextFloat(-0.1, 0.1);
        const choice: VoteChoice =
          score > 0.15 ? "yes" : score < -0.15 ? "no" : "abstain";
        this.vote(nation, p.id, choice);
      }
    }
  }

  // ── View & snapshot ────────────────────────────────────────────────────

  private viewState(): PoliticsViewState {
    return {
      phase: this.phase,
      phaseStart: this.phaseStart,
      phaseEnd: this.phaseEnd,
      nextRoundTick: this.nextRoundTick,
      freezeStart: this.freezeStart,
      freezeEnd: this.freezeEnd,
      offers: [...this.offers].map(([id, d]) => [id, [...d]]),
      proposals: this.proposals.map((p): ProposalView => ({
        id: p.id,
        decree: p.decree,
        proposer: p.proposer,
        target: p.target,
        votes: [...p.votes],
      })),
      weights: [...this.weights],
      active: this.decrees.map((d): ActiveDecreeView => ({
        ...d,
        prices: d.prices.map((x) => [...x]),
      })),
      results: this.results,
      resultsTick: this.resultsTick,
      lastMalusTarget: this.lastMalusTarget,
      bottomThird: [...this.bottomThird],
    };
  }

  snapshot(_w: SnapshotWriter): ExecRecord {
    return PoliticsExecutionSnapshot.write({
      gameID: this.gameID,
      initialized: this.mg !== undefined,
      active: this.active,
      seed: this.seed,
      phase: this.phase,
      phaseStart: this.phaseStart,
      phaseEnd: this.phaseEnd,
      nextRoundTick: this.nextRoundTick,
      freezeStart: this.freezeStart,
      freezeEnd: this.freezeEnd,
      offers: [...this.offers].map(([id, d]) => [id, [...d]]),
      proposals: this.proposals.map((p) => ({
        id: p.id,
        decree: p.decree,
        proposer: p.proposer,
        target: p.target,
        votes: [...p.votes],
      })),
      nextProposalId: this.nextProposalId,
      weights: [...this.weights],
      decrees: this.decrees.map((d) => ({
        ...d,
        prices: d.prices.map((x) => [...x] as [string, number]),
      })),
      nextDecreeId: this.nextDecreeId,
      results: this.results,
      resultsTick: this.resultsTick,
      lastMalusTarget: this.lastMalusTarget,
      bottomThird: [...this.bottomThird],
      dirty: this.dirty,
    });
  }

  restoreSnapshot(s: PoliticsState, r: SnapshotReader): void {
    this.gameID = s.gameID;
    this.active = s.active;
    this.seed = s.seed;
    this.phase = s.phase;
    this.phaseStart = s.phaseStart;
    this.phaseEnd = s.phaseEnd;
    this.nextRoundTick = s.nextRoundTick;
    this.freezeStart = s.freezeStart;
    this.freezeEnd = s.freezeEnd;
    this.offers = new Map(s.offers.map(([id, d]) => [id, [...d]]));
    this.proposals = s.proposals.map((p) => ({
      id: p.id,
      decree: p.decree,
      proposer: p.proposer,
      target: p.target,
      votes: new Map(p.votes),
    }));
    this.nextProposalId = s.nextProposalId;
    this.weights = new Map(s.weights);
    this.decrees = s.decrees.map((d) => ({
      ...d,
      prices: d.prices.map((x) => [...x] as [string, number]),
    }));
    this.nextDecreeId = s.nextDecreeId;
    this.results = s.results.map((x) => ({ ...x, votes: [...x.votes] }));
    this.resultsTick = s.resultsTick;
    this.lastMalusTarget = s.lastMalusTarget;
    this.bottomThird = new Set(s.bottomThird);
    // A restored view gets the whole state with the next keepalive.
    this.dirty = s.dirty;
    if (s.initialized) {
      this.mg = r.game;
      r.game.setPolitics(this);
    }
  }
}

const zDecree = () => z.enum(DecreeType);
const zVote = () => z.enum(["yes", "no", "abstain", "veto"]);

const PoliticsStateSchema = z.object({
  gameID: z.string(),
  initialized: z.boolean(),
  active: z.boolean(),
  seed: zInt(),
  phase: z.enum(["idle", "proposing", "voting"]),
  phaseStart: zInt(),
  phaseEnd: zInt(),
  nextRoundTick: zInt(),
  freezeStart: zInt().nullable(),
  freezeEnd: zInt().nullable(),
  offers: z.array(z.tuple([zInt(), z.array(zDecree())])),
  proposals: z.array(
    z.object({
      id: zInt(),
      decree: zDecree(),
      proposer: zInt(),
      target: zInt().nullable(),
      votes: z.array(z.tuple([zInt(), zVote()])),
    }),
  ),
  nextProposalId: zInt(),
  weights: z.array(z.tuple([zInt(), z.number()])),
  decrees: z.array(
    z.object({
      id: zInt(),
      decree: zDecree(),
      target: zInt().nullable(),
      startTick: zInt(),
      endTick: zInt(),
      secret: z.boolean(),
      revealTick: zInt(),
      prices: z.array(z.tuple([z.string(), z.number()])),
    }),
  ),
  nextDecreeId: zInt(),
  results: z.array(
    z.object({
      proposalId: zInt(),
      decree: zDecree(),
      proposer: zInt(),
      target: zInt().nullable(),
      outcome: z.enum(["passed", "failed", "vetoed", "no_quorum", "no_slot"]),
      yes: z.number(),
      no: z.number(),
      total: z.number(),
      votes: z.array(z.tuple([zInt(), zVote()])),
    }),
  ),
  resultsTick: zInt(),
  lastMalusTarget: zInt().nullable(),
  bottomThird: z.array(zInt()),
  dirty: z.boolean(),
});
type PoliticsState = z.infer<typeof PoliticsStateSchema>;

export const PoliticsExecutionSnapshot = execSnapshotType({
  name: "Politics",
  version: 1,
  schema: PoliticsStateSchema,
  cls: () => PoliticsExecution,
});

/** The propose_decree intent. */
export class ProposeDecreeExecution implements Execution {
  constructor(
    private player: Player,
    private decree: DecreeType,
    private target: string | null,
  ) {}

  init(mg: Game, _ticks: number): void {
    const politics = mg.politics();
    if (politics instanceof PoliticsExecution) {
      politics.propose(this.player, this.decree, this.target);
    }
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
    return ProposeDecreeExecutionSnapshot.write({
      player: w.player(this.player),
      decree: this.decree,
      target: this.target,
    });
  }

  restoreSnapshot(s: ProposeDecreeState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.decree = s.decree;
    this.target = s.target;
  }
}

const ProposeDecreeStateSchema = z.object({
  player: zPlayerRef(),
  decree: zDecree(),
  target: z.string().nullable(),
});
type ProposeDecreeState = z.infer<typeof ProposeDecreeStateSchema>;

export const ProposeDecreeExecutionSnapshot = execSnapshotType({
  name: "ProposeDecree",
  version: 1,
  schema: ProposeDecreeStateSchema,
  cls: () => ProposeDecreeExecution,
});

/** The cast_vote intent. */
export class CastVoteExecution implements Execution {
  constructor(
    private player: Player,
    private proposalId: number,
    private choice: VoteChoice,
  ) {}

  init(mg: Game, _ticks: number): void {
    const politics = mg.politics();
    if (politics instanceof PoliticsExecution) {
      politics.vote(this.player, this.proposalId, this.choice);
    }
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
    return CastVoteExecutionSnapshot.write({
      player: w.player(this.player),
      proposalId: this.proposalId,
      choice: this.choice,
    });
  }

  restoreSnapshot(s: CastVoteState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.proposalId = s.proposalId;
    this.choice = s.choice;
  }
}

const CastVoteStateSchema = z.object({
  player: zPlayerRef(),
  proposalId: zInt(),
  choice: zVote(),
});
type CastVoteState = z.infer<typeof CastVoteStateSchema>;

export const CastVoteExecutionSnapshot = execSnapshotType({
  name: "CastVote",
  version: 1,
  schema: CastVoteStateSchema,
  cls: () => CastVoteExecution,
});
