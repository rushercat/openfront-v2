import {
  BuildableUnit,
  BuildMenus,
  Gold,
  PlayerBuildableUnitType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { renderNumber } from "@openfront/engine-lib/Format";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { Controller } from "../../Controller";
import {
  ConfirmGhostStructureEvent,
  InputHandler,
  ToggleStructureEvent,
  TouchGhostPlacementMoveEvent,
  TouchGhostPlacementSelectEvent,
  highlightTypesForUnit,
  isForwardedTouchClick,
} from "../../InputHandler";
import { KeyboardLayoutController } from "../../KeyboardLayout";
import { KEYBOARD_DETECTED_EVENT, Platform } from "../../Platform";
import { UIState } from "../../UIState";
import { UserSettings } from "../../UserSettings";
import { resolveKeybindLabel, translateText } from "../../Utils";
import { GameView } from "../../view";
import {
  aaDefenseIcon,
  aircraftCarrierIcon,
  airfieldIcon,
  capitalIcon,
  cruiseMissileIcon,
  transportPlaneIcon,
  atomBombIcon,
  bomberIcon,
  cityIcon,
  defensePostIcon,
  factoryIcon,
  fighterJetIcon,
  goldCoinIcon,
  hydrogenBombIcon,
  landMineIcon,
  mirvIcon,
  missileSiloIcon,
  nuclearSubmarineIcon,
  portIcon,
  railDepotIcon,
  samLauncherIcon,
  seaMineIcon,
  repairStationIcon,
  tankIcon,
  warshipIcon,
} from "../HotbarIcons";
import { goldBreakdown } from "../IncomeBreakdown";
import { TutorialHighlight, TutorialHighlightEvent } from "../Tutorial";

/**
 * openfront v2: what a unit needs before it can be built (any one of the
 * listed buildings). The hotbar shows a lock and names them, so players see
 * what to build or save for first.
 */
const PREREQUISITES: Partial<Record<UnitType, UnitType[]>> = {
  [UnitType.AtomBomb]: [UnitType.MissileSilo],
  [UnitType.HydrogenBomb]: [UnitType.MissileSilo],
  [UnitType.MIRV]: [UnitType.MissileSilo],
  [UnitType.CruiseMissile]: [UnitType.MissileSilo],
  [UnitType.Warship]: [UnitType.Port],
  [UnitType.NuclearSubmarine]: [UnitType.Port],
  [UnitType.AircraftCarrier]: [UnitType.Port],
  [UnitType.Tank]: [UnitType.Factory],
  [UnitType.FighterJet]: [UnitType.Airfield, UnitType.AircraftCarrier],
  [UnitType.Bomber]: [UnitType.Airfield, UnitType.AircraftCarrier],
  [UnitType.TransportPlane]: [UnitType.Airfield, UnitType.AircraftCarrier],
};

/** Translation key (unit_type.*) of a unit type, for the lock hint. */
const UNIT_KEYS: Partial<Record<UnitType, string>> = {
  [UnitType.MissileSilo]: "missile_silo",
  [UnitType.Port]: "port",
  [UnitType.Factory]: "factory",
  [UnitType.Airfield]: "airfield",
  [UnitType.AircraftCarrier]: "aircraft_carrier",
};

/** The units on each hotbar row (0 plain, 1 Shift, 2 Alt). */
const ROW_TYPES: PlayerBuildableUnitType[][] = [
  [
    UnitType.City,
    UnitType.Factory,
    UnitType.Port,
    UnitType.DefensePost,
    UnitType.MissileSilo,
    UnitType.SAMLauncher,
    UnitType.Warship,
    UnitType.AtomBomb,
    UnitType.HydrogenBomb,
    UnitType.MIRV,
  ],
  [
    UnitType.AADefense,
    UnitType.Airfield,
    UnitType.FighterJet,
    UnitType.Bomber,
    UnitType.RailDepot,
    UnitType.Tank,
    UnitType.NuclearSubmarine,
    UnitType.LandMine,
    UnitType.SeaMine,
    UnitType.RepairStation,
  ],
  [
    UnitType.AircraftCarrier,
    UnitType.CruiseMissile,
    UnitType.TransportPlane,
    UnitType.Capital,
  ],
];

/** How long a build button has to be held before it shows its details (cost etc.) */
const PEEK_HOLD_MS = 450;
/** How long the details stay up after the browser cancels the touch itself. */
const PEEK_GRACE_MS = 1200;

// A unit dragged from the bar sits this far above the finger (about 7mm on a
// phone), so the finger doesn't hide where it will be built.
const DRAG_GHOST_LIFT_PX = 44;

@customElement("unit-display")
export class UnitDisplay extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;
  public uiState: UIState;
  public inputHandler: InputHandler;
  private playerBuildables: BuildableUnit[] | null = null;
  private keybinds: Record<string, { value: string; key: string }> = {};
  private keyboardLayout = new KeyboardLayoutController(this);
  private _cities = 0;
  private _warships = 0;
  private _aaDefense = 0;
  private _airfields = 0;
  private _fighterJets = 0;
  private _bombers = 0;
  private _railDepots = 0;
  private _tanks = 0;
  private _nuclearSubmarines = 0;
  private _landMines = 0;
  private _seaMines = 0;
  private _repairStations = 0;
  private _carriers = 0;
  private _cruiseMissiles = 0;
  private _transportPlanes = 0;
  private _capitals = 0;
  // The second row of the bar shows while Shift is held, the third while
  // Alt is; the toggle at the end pins one (0, 1 or 2).
  private shiftHeld = false;
  private altHeld = false;
  private pinnedRow = 0;
  /** openfront v2: the unit the player saves for (right-click on the bar). */
  private savingsGoal: PlayerBuildableUnitType | null = null;
  private _factories = 0;
  private _missileSilo = 0;
  private _port = 0;
  private _defensePost = 0;
  private _samLauncher = 0;
  private allDisabled = false;
  private enabledUnitCount = 0;
  private tutorialMode = false;
  private _hoveredUnitTooltip: {
    unitType: PlayerBuildableUnitType;
    structureKey: string;
    hotkey: string;
    element: HTMLElement;
  } | null = null;
  /**
   * The unit the player is holding down. A touch device has no hover, so a
   * press-and-hold is how the cost and description are read before the unit
   * is picked.
   */
  private _peekedUnitTooltip: {
    unitType: PlayerBuildableUnitType;
    structureKey: string;
    hotkey: string; //touch device may still have a keyboard
    element: HTMLElement;
  } | null = null;
  private peekTimer: ReturnType<typeof setTimeout> | null = null;
  private peekGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressNextClick = false;
  // Keep the hold's release click suppressed, but not a later physical click.
  private suppressReleaseClick = false;
  private lastTouchClickItem: HTMLElement | null = null;
  private peekPointerId: number | null = null;
  private peekTouchIdentifier: number | null = null;
  private activeTouchIdentifiers = new Set<number>();
  // Where the tooltip is centred along the bar, in the bar's own coordinates:
  // x for the bottom row, y for the side column. Kept for the clamp after the
  // render, since the tooltip cannot be measured before it exists.
  private _tooltipCenter: number | null = null;
  private tutorialHighlight: PlayerBuildableUnitType | null = null;
  // Whether the build bar has actions hidden off either edge. The fade on that
  // edge tells the player there is more to scroll to.
  private moreActionsStart = false;
  private moreActionsEnd = false;
  private observedScroller: HTMLElement | null = null;
  private windowListenersAttached = false;
  /**
   * A touch on a build button that may become a drag onto the map. It
   * becomes active once the finger leaves the bar: the unit is picked and
   * its ghost follows the finger. Letting go on the map builds there; letting
   * go back over the bar cancels.
   */
  private placeDrag: {
    pointerId: number;
    unitType: PlayerBuildableUnitType;
    active: boolean;
  } | null = null;

  createRenderRoot() {
    return this;
  }

  init() {
    const config = this.game.config();
    const userSettings = new UserSettings();

    this.keybinds = userSettings.parsedUserKeybinds();

    this.tutorialMode = config.gameConfig().tutorial ?? false;
    // The bar is hidden on small screens, where the radial menu builds, but
    // the onboarding tutorial fires its atom bomb from here on every screen.
    if (this.tutorialMode) this.classList.remove("hidden");

    this.enabledUnitCount = BuildMenus.types.filter((unitType) =>
      this.isUnitDisplayed(unitType),
    ).length;
    this.allDisabled = this.enabledUnitCount === 0;

    const highlightUnits: Partial<
      Record<TutorialHighlight, PlayerBuildableUnitType>
    > = {
      city: UnitType.City,
      port: UnitType.Port,
      defense_post: UnitType.DefensePost,
      factory: UnitType.Factory,
      warship: UnitType.Warship,
      silo: UnitType.MissileSilo,
      atom: UnitType.AtomBomb,
      hydrogen: UnitType.HydrogenBomb,
      mirv: UnitType.MIRV,
      sam: UnitType.SAMLauncher,
    };
    this.eventBus.on(TutorialHighlightEvent, (e) => {
      this.tutorialHighlight = (e.target && highlightUnits[e.target]) ?? null;
      this.requestUpdate();
    });
    this.requestUpdate();
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.windowListenersAttached) return;
    window.addEventListener("resize", this.onLayoutChange);
    window.addEventListener(
      KEYBOARD_DETECTED_EVENT,
      this.handleKeyboardDetected,
    );
    document.addEventListener("pointerdown", this.handleDocumentPointerDown);
    document.addEventListener("pointermove", this.handleDocumentPointerMove);
    document.addEventListener("pointerup", this.handleDocumentPointerUp);
    document.addEventListener(
      "pointercancel",
      this.handleDocumentPointerCancel,
    );
    document.addEventListener("touchstart", this.handlePeekTouchEvent, true);
    document.addEventListener("touchend", this.handlePeekTouchEvent, true);
    document.addEventListener("touchcancel", this.handlePeekTouchEvent, true);
    window.addEventListener("keydown", this.onShiftKey);
    window.addEventListener("keyup", this.onShiftKey);
    window.addEventListener("blur", this.onWindowBlur);
    this.windowListenersAttached = true;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("resize", this.onLayoutChange);
    window.removeEventListener(
      KEYBOARD_DETECTED_EVENT,
      this.handleKeyboardDetected,
    );
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown);
    document.removeEventListener("pointermove", this.handleDocumentPointerMove);
    document.removeEventListener("pointerup", this.handleDocumentPointerUp);
    document.removeEventListener(
      "pointercancel",
      this.handleDocumentPointerCancel,
    );
    document.removeEventListener("touchstart", this.handlePeekTouchEvent, true);
    document.removeEventListener("touchend", this.handlePeekTouchEvent, true);
    document.removeEventListener(
      "touchcancel",
      this.handlePeekTouchEvent,
      true,
    );
    this.dismissPeek();
    this.placeDrag = null;
    this.activeTouchIdentifiers.clear();
    this.suppressNextClick = false;
    this.suppressReleaseClick = false;
    this.clearTouchClickTarget();
    window.removeEventListener("keydown", this.onShiftKey);
    window.removeEventListener("keyup", this.onShiftKey);
    window.removeEventListener("blur", this.onWindowBlur);
    this.shiftHeld = false;
    this.altHeld = false;
    this.windowListenersAttached = false;
  }

  /** The bar moved or resized: the tooltip and the edge fades have to follow. */
  private onLayoutChange = () => {
    this.requestUpdate();
  };

  /**
   * A keyboard can show up after the page loaded (a tablet with a Bluetooth
   * keyboard, a desktop user who only now typed). Show the hotkeys from then on.
   */
  private handleKeyboardDetected = () => {
    this.requestUpdate();
  };

  /**
   * Holding a build button shows its cost and description. Touch devices have
   * no hover, and a tap selects the unit right away, so the details need a
   * press of their own.
   */
  private startPeek = (
    event: PointerEvent,
    unitType: PlayerBuildableUnitType,
    structureKey: string,
    hotkey: string,
  ) => {
    if (event.pointerType !== "touch") return;
    // A new press replaces the peek of the previous one.
    this.dismissPeek();
    this.peekPointerId = event.pointerId;
    // The press that follows is a new gesture: it may select the unit.
    this.suppressNextClick = false;
    const element = event.currentTarget as HTMLElement;
    this.peekTimer = setTimeout(() => {
      this.peekTimer = null;
      // The hold becomes a peek: releasing it must not select the unit.
      this.suppressNextClick = true;
      this._peekedUnitTooltip = { unitType, structureKey, hotkey, element };
      this.requestUpdate();
    }, PEEK_HOLD_MS);
  };

  private cancelPeekTimer() {
    if (this.peekTimer === null) return;
    clearTimeout(this.peekTimer);
    this.peekTimer = null;
  }

  private dismissPeek() {
    this.cancelPeekTimer();
    this.peekPointerId = null;
    this.peekTouchIdentifier = null;
    if (this.peekGraceTimer !== null) {
      clearTimeout(this.peekGraceTimer);
      this.peekGraceTimer = null;
    }
    if (this._peekedUnitTooltip === null) return;
    this._peekedUnitTooltip = null;
    this.requestUpdate();
  }

  /** A press outside the bar dismisses the peek it opened. */
  private handleDocumentPointerDown = (event: PointerEvent) => {
    this.suppressReleaseClick = false;
    if (event.pointerType !== "touch") this.clearTouchClickTarget();
    if (this._peekedUnitTooltip === null) return;
    const root = this.querySelector(".unit-display-root");
    if (root && event.target instanceof Node && root.contains(event.target)) {
      return;
    }
    this.dismissPeek();
  };

  private armPlaceDrag(event: PointerEvent, unitType: PlayerBuildableUnitType) {
    if (event.pointerType !== "touch") return;
    this.placeDrag = { pointerId: event.pointerId, unitType, active: false };
  }

  private isOverBar(x: number, y: number): boolean {
    const bounds =
      this.querySelector(".unit-display-root")?.getBoundingClientRect();
    return (
      bounds !== undefined &&
      x >= bounds.left &&
      x <= bounds.right &&
      y >= bounds.top &&
      y <= bounds.bottom
    );
  }

  /**
   * The touch keeps its button as target (implicit pointer capture), so its
   * moves arrive here even over the map, and the map's input never sees it.
   */
  private handleDocumentPointerMove = (event: PointerEvent) => {
    const drag = this.placeDrag;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      if (this.isOverBar(event.clientX, event.clientY)) return;
      if (!this.canBuild(drag.unitType)) {
        this.placeDrag = null;
        return;
      }
      drag.active = true;
      // A drag is not a hold: no details, and no selection on release.
      this.dismissPeek();
      // Picking the unit that's already held would raise its upgrade
      // multiplier, as a second click does.
      if (this.uiState.ghostStructure !== drag.unitType) {
        this.inputHandler.setGhostStructure(drag.unitType, "GUIclick");
      }
      this.eventBus?.emit(new TouchGhostPlacementSelectEvent());
      this.eventBus?.emit(
        new ToggleStructureEvent(highlightTypesForUnit(drag.unitType)),
      );
      this.requestUpdate();
    }
    this.eventBus?.emit(
      new TouchGhostPlacementMoveEvent(
        event.clientX,
        event.clientY - DRAG_GHOST_LIFT_PX,
      ),
    );
  };

  /**
   * Ends a drag from the bar: a release on the map builds where the ghost
   * is, just above the finger. Either way the unit is dropped afterwards.
   * Returns whether the pointer was dragging, so the hold logic skips it.
   */
  private finishPlaceDrag(event: PointerEvent): boolean {
    const drag = this.placeDrag;
    if (drag === null || drag.pointerId !== event.pointerId) return false;
    this.placeDrag = null;
    if (!drag.active) return false;
    this.suppressReleaseClick = true;
    if (
      event.type === "pointerup" &&
      !this.isOverBar(event.clientX, event.clientY)
    ) {
      this.eventBus?.emit(
        new TouchGhostPlacementMoveEvent(
          event.clientX,
          event.clientY - DRAG_GHOST_LIFT_PX,
        ),
      );
      // Letting go ends the placement: the unit is dropped whether it builds
      // there or not, nukes included.
      this.eventBus?.emit(new ConfirmGhostStructureEvent(true));
    } else {
      this.inputHandler.setGhostStructure(null, "GUIclick");
    }
    this.requestUpdate();
    return true;
  }

  /** Releasing anywhere ends the hold, wherever the finger ended up. */
  private handleDocumentPointerUp = (event: PointerEvent) => {
    if (this.finishPlaceDrag(event)) return;
    if (this.peekPointerId !== event.pointerId) return;
    this.suppressReleaseClick = this.suppressNextClick;
    this.suppressNextClick = false;
    this.cancelPeekTimer();
    this.peekPointerId = null;
    this.peekTouchIdentifier = null;
    // The details are only useful while the button is held down.
    if (this._peekedUnitTooltip !== null) this.dismissPeek();
  };

  /** Pointer cancellation can precede touchend; the touch event ends the peek. */
  private handleDocumentPointerCancel = (event: PointerEvent) => {
    if (this.finishPlaceDrag(event)) return;
    if (this.peekPointerId !== event.pointerId) return;
    this.cancelPeekTimer();
    if (
      this._peekedUnitTooltip !== null &&
      this.activeTouchIdentifiers.size > 1
    ) {
      this.startPeekGraceTimer();
    }
  };

  private handlePeekTouchEvent = (event: TouchEvent) => {
    const root = this.querySelector(".unit-display-root");
    const isInBuildBar =
      event.target instanceof Node && root?.contains(event.target);
    const changedTouches = Array.from(event.changedTouches);

    if (event.type === "touchstart") {
      this.clearTouchClickTarget();
      for (const touch of changedTouches) {
        this.activeTouchIdentifiers.add(touch.identifier);
      }
      if (isInBuildBar && this.peekTouchIdentifier === null) {
        this.peekTouchIdentifier = changedTouches[0]?.identifier ?? null;
      }
    } else {
      if (event.type === "touchend" && isInBuildBar) {
        this.lastTouchClickItem =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>(".unit-display-grid > div")
            : null;
      }
      const trackedTouchEnded = changedTouches.some(
        (touch) => touch.identifier === this.peekTouchIdentifier,
      );
      for (const touch of changedTouches) {
        this.activeTouchIdentifiers.delete(touch.identifier);
      }

      if (!trackedTouchEnded) return;
      this.peekTouchIdentifier = null;
      this.peekPointerId = null;
      this.cancelPeekTimer();
      if (event.type === "touchend") {
        this.suppressReleaseClick ||= this.suppressNextClick;
        this.suppressNextClick = false;
        if (this._peekedUnitTooltip !== null) this.dismissPeek();
      } else {
        this.clearTouchClickTarget();
        this.suppressNextClick = false;
        this.suppressReleaseClick = false;
        if (this._peekedUnitTooltip !== null) {
          this.startPeekGraceTimer();
        }
      }
    }
  };

  private clearTouchClickTarget() {
    this.lastTouchClickItem = null;
  }

  private isTouchClick(event: Event, item: Element | null): boolean {
    const isTouch =
      (event instanceof PointerEvent && event.pointerType === "touch") ||
      isForwardedTouchClick(event) ||
      (event instanceof MouseEvent &&
        event.detail > 0 &&
        item === this.lastTouchClickItem);
    this.clearTouchClickTarget();
    return isTouch;
  }

  private startPeekGraceTimer() {
    if (this.peekGraceTimer !== null) clearTimeout(this.peekGraceTimer);
    this.peekGraceTimer = setTimeout(() => {
      this.peekGraceTimer = null;
      if (this._peekedUnitTooltip !== null) this.dismissPeek();
    }, PEEK_GRACE_MS);
  }

  private onScroll = () => {
    this.requestUpdate();
  };

  /**
   * Below lg in portrait the bar is a column on the right edge of the
   * screen, scrolling up and down; everywhere else it is a row in the bottom
   * panel. Matches the `side-bar:` variant (styles.css) used by the bar and
   * its host in index.html.
   */
  private isSideBar(): boolean {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(width < 64rem) and (orientation: portrait)").matches
    );
  }

  /**
   * Track which end of the build bar still hides actions, so the fade can
   * point at it. The bar only scrolls where it does not fit, so on a big
   * screen neither end is marked.
   */
  private measureScrollState() {
    const scroller = this.getScroller();
    if (!scroller) return;
    const [scrolled, visible, total] = this.isSideBar()
      ? [scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight]
      : [scroller.scrollLeft, scroller.clientWidth, scroller.scrollWidth];
    this.moreActionsStart = scrolled > 1;
    this.moreActionsEnd = scrolled + visible < total - 1;
  }

  private getScroller(): HTMLElement | null {
    return this.querySelector<HTMLElement>(".unit-display-scroll");
  }

  willUpdate() {
    this.measureScrollState();
  }

  updated() {
    const scroller = this.getScroller();
    if (scroller !== this.observedScroller) {
      this.observedScroller?.removeEventListener("scroll", this.onScroll);
      this.observedScroller = scroller;
      scroller?.addEventListener("scroll", this.onScroll);
    }
    this.clampTooltipToViewport();
  }

  /**
   * Keep the tooltip on the mobile screen: next to an edge it would
   * otherwise hang off. The bottom row clamps it sideways, the side column
   * up and down.
   */
  private clampTooltipToViewport() {
    const tooltip = this.querySelector<HTMLElement>(".unit-display-tooltip");
    const root = this.querySelector<HTMLElement>(".unit-display-root");
    if (!tooltip || !root || this._tooltipCenter === null) return;
    const rootBounds = root.getBoundingClientRect();
    const tooltipBounds = tooltip.getBoundingClientRect();
    const margin = 8;
    if (this.isSideBar()) {
      let top = rootBounds.top + this._tooltipCenter - tooltipBounds.height / 2;
      const maxTop = window.innerHeight - margin - tooltipBounds.height;
      if (top > maxTop) top = maxTop;
      if (top < margin) top = margin;
      tooltip.style.top = `${top - rootBounds.top + tooltipBounds.height / 2}px`;
      return;
    }
    // The tooltip is centred on the item, so its left edge sits half its
    // width to the left of that centre.
    let left = rootBounds.left + this._tooltipCenter - tooltipBounds.width / 2;
    const max = window.innerWidth - margin - tooltipBounds.width;
    if (left < margin) left = margin;
    else if (left > max) left = max;
    // The tooltip is pulled left by half its width with the transform, so the
    // style has to put that half back, or the box ends up twice shifted.
    tooltip.style.left = `${left - rootBounds.left + tooltipBounds.width / 2}px`;
  }

  private cost(item: UnitType): Gold {
    for (const bu of this.playerBuildables ?? []) {
      if (bu.type === item) {
        return bu.cost;
      }
    }
    return 0n;
  }

  /** The buildings a unit still needs (none owned), or null. */
  private missingPrereq(item: UnitType): UnitType[] | null {
    const needs = PREREQUISITES[item];
    if (needs === undefined) return null;
    const player = this.game?.myPlayer();
    if (needs.some((t) => (player?.units(t).length ?? 0) > 0)) return null;
    // Only name what the lobby lets the player build at all.
    const possible = needs.filter(
      (t) =>
        !this.game.config().isUnitDisabled(t) &&
        this.game.isDraftLocked?.(t) !== true,
    );
    return possible.length > 0 ? possible : needs;
  }

  private canBuild(item: UnitType): boolean {
    if (this.game?.config().isUnitDisabled(item)) return false;
    if (this.game?.isDraftLocked?.(item) === true) return false;
    if (this.missingPrereq(item) !== null) return false;
    const player = this.game?.myPlayer();
    return this.cost(item) <= (player?.gold() ?? 0n);
  }

  private isUnitDisplayed(unitType: PlayerBuildableUnitType): boolean {
    return (
      !this.game.config().isUnitDisabled(unitType) &&
      // Draft mode: the hotbar shows only the deck.
      this.game.isDraftLocked?.(unitType) !== true &&
      (!this.tutorialMode || unitType === UnitType.AtomBomb)
    );
  }

  tick() {
    const player = this.game?.myPlayer();
    if (!player) return;
    player
      .buildables(undefined, BuildMenus.types)
      .then((buildables) => {
        this.playerBuildables = buildables;
      })
      .catch((error) => console.warn("Failed to refresh unit costs", error));
    this._cities = player.totalUnitLevels(UnitType.City);
    this._missileSilo = player.totalUnitLevels(UnitType.MissileSilo);
    this._port = player.totalUnitLevels(UnitType.Port);
    this._defensePost = player.totalUnitLevels(UnitType.DefensePost);
    this._samLauncher = player.totalUnitLevels(UnitType.SAMLauncher);
    this._factories = player.totalUnitLevels(UnitType.Factory);
    this._warships = player.totalUnitLevels(UnitType.Warship);
    this._aaDefense = player.totalUnitLevels(UnitType.AADefense);
    this._airfields = player.totalUnitLevels(UnitType.Airfield);
    this._fighterJets = player.totalUnitLevels(UnitType.FighterJet);
    this._bombers = player.totalUnitLevels(UnitType.Bomber);
    this._railDepots = player.totalUnitLevels(UnitType.RailDepot);
    this._tanks = player.totalUnitLevels(UnitType.Tank);
    this._nuclearSubmarines = player.totalUnitLevels(UnitType.NuclearSubmarine);
    this._landMines = player.totalUnitLevels(UnitType.LandMine);
    this._seaMines = player.totalUnitLevels(UnitType.SeaMine);
    this._repairStations = player.totalUnitLevels(UnitType.RepairStation);
    this._carriers = player.totalUnitLevels(UnitType.AircraftCarrier);
    this._cruiseMissiles = player.totalUnitLevels(UnitType.CruiseMissile);
    this._transportPlanes = player.totalUnitLevels(UnitType.TransportPlane);
    this._capitals = player.totalUnitLevels(UnitType.Capital);
    this.requestUpdate();
  }

  render() {
    const myPlayer = this.game?.myPlayer();
    if (
      !this.game ||
      !myPlayer ||
      this.game.inSpawnPhase() ||
      !myPlayer.isAlive()
    ) {
      return null;
    }
    if (this.allDisabled) {
      return null;
    }
    // The onboarding tutorial's one build is the atom bomb, fired from the
    // nation's silo once captured.
    if (
      this.tutorialMode &&
      myPlayer.units(UnitType.MissileSilo).length === 0
    ) {
      return null;
    }
    // A row in the bottom panel: below the control panel from lg up, above
    // it on landscape phones (index.html orders it), spread over the panel's
    // width there. Below lg in portrait (side-bar) it is a column on the
    // right edge of the screen, where index.html fixes the host.
    return html`
      <div
        class="unit-display-root relative p-0.5 border-white/10 w-full lg:border-t max-lg:landscape:border-b side-bar:w-auto side-bar:border side-bar:border-r-0 side-bar:rounded-l-lg side-bar:bg-gray-800/92 side-bar:shadow-lg
          ${this.moreActionsStart ? "unit-display-more-start" : ""}
          ${this.moreActionsEnd ? "unit-display-more-end" : ""}"
        data-radial-click-through
        @contextmenu=${(event: Event) => event.preventDefault()}
      >
        <div
          class="unit-display-scroll overflow-x-auto overflow-y-hidden overscroll-x-contain touch-none lg:overflow-visible side-bar:overflow-x-hidden side-bar:overflow-y-auto side-bar:overscroll-y-contain side-bar:max-h-[calc(100dvh-5.5rem)]"
          @scroll=${this.onScroll}
        >
          <div
            class="unit-display-grid grid gap-0.5 grid-rows-1 grid-flow-col auto-cols-fr lg:auto-cols-max lg:w-fit lg:mx-auto side-bar:grid-rows-none side-bar:grid-flow-row side-bar:grid-cols-1"
          >
            ${this.renderUnitRows()} ${this.renderRowToggle()}
            ${this.renderSavingsGoalChip()}
          </div>
        </div>
        ${this.renderUnitTooltip()}
      </div>
    `;
  }

  /**
   * The bar holds two rows of units. The second (air, ground and naval
   * units, mines) shows while Shift is held, matching its Shift + number
   * hotkeys, or while the toggle at the end of the bar pins it.
   */
  private renderUnitRows() {
    const row = this.currentRow();
    if (row === 2) {
      return html`
        ${this.renderUnitItem(
          aircraftCarrierIcon,
          this._carriers,
          UnitType.AircraftCarrier,
          "aircraft_carrier",
          this.getHotkey("buildAircraftCarrier", "Alt+Digit1"),
        )}
        ${this.renderUnitItem(
          cruiseMissileIcon,
          this._cruiseMissiles,
          UnitType.CruiseMissile,
          "cruise_missile",
          this.getHotkey("buildCruiseMissile", "Alt+Digit2"),
        )}
        ${this.renderUnitItem(
          transportPlaneIcon,
          this._transportPlanes,
          UnitType.TransportPlane,
          "transport_plane",
          this.getHotkey("buildTransportPlane", "Alt+Digit3"),
        )}
        ${this.renderUnitItem(
          capitalIcon,
          this._capitals,
          UnitType.Capital,
          "capital",
          this.getHotkey("buildCapital", "Alt+Digit4"),
        )}
      `;
    }
    if (row === 0) {
      return html`
        ${this.renderUnitItem(
          cityIcon,
          this._cities,
          UnitType.City,
          "city",
          this.getHotkey("buildCity", "Digit1"),
        )}
        ${this.renderUnitItem(
          factoryIcon,
          this._factories,
          UnitType.Factory,
          "factory",
          this.getHotkey("buildFactory", "Digit2"),
        )}
        ${this.renderUnitItem(
          portIcon,
          this._port,
          UnitType.Port,
          "port",
          this.getHotkey("buildPort", "Digit3"),
        )}
        ${this.renderUnitItem(
          defensePostIcon,
          this._defensePost,
          UnitType.DefensePost,
          "defense_post",
          this.getHotkey("buildDefensePost", "Digit4"),
        )}
        ${this.renderUnitItem(
          missileSiloIcon,
          this._missileSilo,
          UnitType.MissileSilo,
          "missile_silo",
          this.getHotkey("buildMissileSilo", "Digit5"),
        )}
        ${this.renderUnitItem(
          samLauncherIcon,
          this._samLauncher,
          UnitType.SAMLauncher,
          "sam_launcher",
          this.getHotkey("buildSamLauncher", "Digit6"),
        )}
        ${this.renderUnitItem(
          warshipIcon,
          this._warships,
          UnitType.Warship,
          "warship",
          this.getHotkey("buildWarship", "Digit7"),
        )}
        ${this.renderUnitItem(
          atomBombIcon,
          null,
          UnitType.AtomBomb,
          "atom_bomb",
          this.getHotkey("buildAtomBomb", "Digit8"),
        )}
        ${this.renderUnitItem(
          hydrogenBombIcon,
          null,
          UnitType.HydrogenBomb,
          "hydrogen_bomb",
          this.getHotkey("buildHydrogenBomb", "Digit9"),
        )}
        ${this.renderUnitItem(
          mirvIcon,
          null,
          UnitType.MIRV,
          "mirv",
          this.getHotkey("buildMIRV", "Digit0"),
        )}
      `;
    }
    return html`
      ${this.renderUnitItem(
        aaDefenseIcon,
        this._aaDefense,
        UnitType.AADefense,
        "aa_defense",
        this.getHotkey("buildAADefense", "Shift+Digit1"),
      )}
      ${this.renderUnitItem(
        airfieldIcon,
        this._airfields,
        UnitType.Airfield,
        "airfield",
        this.getHotkey("buildAirfield", "Shift+Digit2"),
      )}
      ${this.renderUnitItem(
        fighterJetIcon,
        this._fighterJets,
        UnitType.FighterJet,
        "fighter_jet",
        this.getHotkey("buildFighterJet", "Shift+Digit3"),
      )}
      ${this.renderUnitItem(
        bomberIcon,
        this._bombers,
        UnitType.Bomber,
        "bomber",
        this.getHotkey("buildBomber", "Shift+Digit4"),
      )}
      ${this.renderUnitItem(
        railDepotIcon,
        this._railDepots,
        UnitType.RailDepot,
        "rail_depot",
        this.getHotkey("buildRailDepot", "Shift+Digit5"),
      )}
      ${this.renderUnitItem(
        tankIcon,
        this._tanks,
        UnitType.Tank,
        "tank",
        this.getHotkey("buildTank", "Shift+Digit6"),
      )}
      ${this.renderUnitItem(
        nuclearSubmarineIcon,
        this._nuclearSubmarines,
        UnitType.NuclearSubmarine,
        "nuclear_submarine",
        this.getHotkey("buildNuclearSubmarine", "Shift+Digit7"),
      )}
      ${this.renderMineItem()}
      ${this.renderUnitItem(
        repairStationIcon,
        this._repairStations,
        UnitType.RepairStation,
        "repair_station",
        this.getHotkey("buildRepairStation", "Shift+Digit0"),
      )}
    `;
  }

  /** The row on show: 0 (structures, nukes), 1 (Shift) or 2 (Alt). */
  private currentRow(): number {
    // Rows without a single unit (e.g. "Classic" lobbies) are skipped.
    if (this.altHeld && this.rowHasUnits(2)) return 2;
    if (this.shiftHeld && this.rowHasUnits(1)) {
      return this.pinnedRow === 1 ? 0 : 1;
    }
    return this.rowHasUnits(this.pinnedRow) ? this.pinnedRow : 0;
  }

  private rowHasUnits(row: number): boolean {
    return ROW_TYPES[row].some((t) => this.isUnitDisplayed(t));
  }

  /** The next row the toggle pins, skipping empty ones. */
  private nextRow(): number {
    for (let i = 1; i <= 2; i++) {
      const row = (this.pinnedRow + i) % 3;
      if (row === 0 || this.rowHasUnits(row)) return row;
    }
    return 0;
  }

  private renderRowToggle() {
    // The onboarding tutorial only ever shows its atom bomb.
    if (this.tutorialMode) {
      return nothing;
    }
    // Nothing to switch to: no toggle at all.
    if (!this.rowHasUnits(1) && !this.rowHasUnits(2)) return nothing;
    const row = this.currentRow();
    return html`
      <div class="flex flex-col items-center relative">
        <button
          class="border border-slate-500 rounded-sm max-lg:landscape:h-7.5 side-bar:h-12 side-bar:min-w-6.5 w-full h-full px-1 flex items-center justify-center cursor-pointer text-white pointer-fine:hover:bg-gray-800 ${
            row !== 0 ? "bg-slate-400/20" : ""
          }"
          title=${translateText("build_menu.switch_row")}
          @click=${() => {
            this.pinnedRow = this.nextRow();
            this.requestUpdate();
          }}
        >
          <span class="text-xs font-bold"
            >${row === 0 ? "⇧" : row === 1 ? "Alt" : "1"}</span
          >
        </button>
      </div>
    `;
  }

  private onShiftKey = (event: KeyboardEvent) => {
    const held = event.type === "keydown";
    if (event.key === "Shift") {
      if (held !== this.shiftHeld) {
        this.shiftHeld = held;
        this.requestUpdate();
      }
      return;
    }
    // Left Alt only: Right Alt is AltGr on many layouts.
    if (event.code === "AltLeft" && held !== this.altHeld) {
      this.altHeld = held;
      this.requestUpdate();
    }
  };

  private onWindowBlur = () => {
    if (this.shiftHeld || this.altHeld) {
      this.shiftHeld = false;
      this.altHeld = false;
      this.requestUpdate();
    }
  };

  private getHotkey(action: string, defaultCode: string): string {
    // Without a keyboard the hotkeys cannot be used, so don't resolve them
    // (or the keyboard layout behind them) and don't show them.
    if (!Platform.hasKeyboard) return "";
    return resolveKeybindLabel(
      this.keybinds[action],
      defaultCode,
      this.keyboardLayout.map,
    );
  }

  /**
   * openfront v2: one slot for both mines. The placement picks the right
   * one for the tile under the cursor (BuildPreviewController.autoMine):
   * a land mine on land, a sea mine on water.
   */
  private renderMineItem() {
    const land = this.isUnitDisplayed(UnitType.LandMine);
    const sea = this.isUnitDisplayed(UnitType.SeaMine);
    if (!land && !sea) return html``;
    if (!land || !sea) {
      return land
        ? this.renderUnitItem(
            landMineIcon,
            this._landMines,
            UnitType.LandMine,
            "land_mine",
            this.getHotkey("buildLandMine", "Shift+Digit8"),
          )
        : this.renderUnitItem(
            seaMineIcon,
            this._seaMines,
            UnitType.SeaMine,
            "sea_mine",
            this.getHotkey("buildSeaMine", "Shift+Digit9"),
          );
    }
    const ghost = this.uiState.ghostStructure;
    return this.renderUnitItem(
      ghost === UnitType.SeaMine ? seaMineIcon : landMineIcon,
      this._landMines + this._seaMines,
      ghost === UnitType.SeaMine ? UnitType.SeaMine : UnitType.LandMine,
      "mine",
      this.getHotkey("buildLandMine", "Shift+Digit8"),
    );
  }

  private renderUnitItem(
    icon: string,
    number: number | null,
    unitType: PlayerBuildableUnitType,
    structureKey: string,
    hotkey: string,
  ) {
    if (!this.isUnitDisplayed(unitType)) {
      return html``;
    }
    const ghost = this.uiState.ghostStructure;
    const selected =
      ghost === unitType ||
      (structureKey === "mine" &&
        (ghost === UnitType.LandMine || ghost === UnitType.SeaMine));
    const displayHotkey = hotkey
      .replace(/^Shift\+/i, "⇧")
      .replace("Digit", "")
      .replace("Key", "")
      .toUpperCase();

    return html`
      <div
        class="flex flex-col items-center relative"
        @mouseenter=${(event: MouseEvent) => {
          const item = event.currentTarget as HTMLElement;
          this._hoveredUnitTooltip = {
            unitType,
            structureKey,
            hotkey,
            element: item,
          };
          this.requestUpdate();
        }}
        @mouseleave=${() => {
          this._hoveredUnitTooltip = null;
          this.requestUpdate();
        }}
        @pointerdown=${(event: PointerEvent) => {
          if (event.button === 2) return;
          this.startPeek(event, unitType, structureKey, hotkey);
          this.armPlaceDrag(event, unitType);
        }}
        @contextmenu=${(event: Event) => {
          event.preventDefault();
          this.toggleSavingsGoal(unitType);
        }}
      >
        <div
          class="${
            this.canBuild(unitType) ? "" : "opacity-40"
          } border border-slate-500 rounded-sm max-lg:landscape:h-7.5 side-bar:h-12 side-bar:min-w-6.5 w-full px-0.5 side-bar:px-0 pb-0.5 flex items-center justify-center gap-0.5 cursor-pointer lg:justify-start
             ${
            selected
              ? "pointer-fine:hover:bg-gray-400/10"
              : "pointer-fine:hover:bg-gray-800"
          }
             rounded-sm text-white relative ${selected ? "bg-slate-400/20" : ""}
             ${this.savingsGoal === unitType ? "ring-1 ring-yellow-400" : ""}
             ${this.tutorialHighlight === unitType ? "tutorial-highlight" : ""}"
          @click=${(event: Event) => {
            const item = (event.currentTarget as HTMLElement).closest(
              ".unit-display-grid > div",
            );
            const fromTouch = this.isTouchClick(event, item);
            // A press that turned into a peek shows the details instead of
            // selecting the unit
            if (this.suppressNextClick || this.suppressReleaseClick) {
              this.suppressNextClick = false;
              this.suppressReleaseClick = false;
              return;
            }
            if (selected) {
              this.inputHandler.setGhostStructure(null, "GUIclick");
            } else if (this.canBuild(unitType)) {
              this.inputHandler.setGhostStructure(unitType, "GUIclick");
              if (fromTouch) {
                this.eventBus?.emit(new TouchGhostPlacementSelectEvent());
                this.eventBus?.emit(
                  new ToggleStructureEvent(highlightTypesForUnit(unitType)),
                );
              }
            } else {
              const selectedGhost = this.uiState.ghostStructure;
              this.eventBus?.emit(
                new ToggleStructureEvent(
                  selectedGhost === null
                    ? null
                    : highlightTypesForUnit(selectedGhost),
                ),
              );
            }
            this.requestUpdate();
          }}
          @pointerenter=${(event: PointerEvent) => {
            if (event.pointerType === "touch") return;
            this.eventBus?.emit(
              new ToggleStructureEvent(highlightTypesForUnit(unitType)),
            );
          }}
          @pointerleave=${(event: PointerEvent) => {
            if (event.pointerType === "touch") return;
            const selectedGhost = this.uiState.ghostStructure;
            this.eventBus?.emit(
              new ToggleStructureEvent(
                selectedGhost === null
                  ? null
                  : highlightTypesForUnit(selectedGhost),
              ),
            );
          }}
        >
          ${
            hotkey
              ? html`<div
                  class="unit-display-hotkey ml-0.5 text-[10px] relative -top-1 text-gray-400"
                >
                  ${displayHotkey}
                </div>`
              : nothing
          }
          <div
            class="flex flex-col items-center gap-0 pt-0.5 lg:flex-row lg:gap-0.5"
          >
            <img
              src=${icon}
              alt=${translateText("unit_type." + structureKey)}
              class="align-middle size-6 lg:size-5 max-lg:landscape:size-5"
            />
            ${
              number !== null
                ? html`<span class="hidden lg:inline text-xs leading-none"
                    >${renderNumber(number)}</span
                  >`
                : null
            }
          </div>
          ${this.renderAffordance(unitType)}
        </div>
      </div>
    `;
  }

  // ── openfront v2: what to save for ─────────────────────────────────────

  private toggleSavingsGoal(unitType: PlayerBuildableUnitType) {
    this.savingsGoal = this.savingsGoal === unitType ? null : unitType;
    this.requestUpdate();
  }

  /** Estimated gold per second (fixed income plus recent trade). */
  private goldPerSecond(): number {
    const me = this.game?.myPlayer();
    if (!me) return 0;
    return goldBreakdown(this.game, me).total;
  }

  /** "~40 s" / "~3 min" until `missing` gold is in, or "" if unknown. */
  private etaText(missing: bigint): string {
    const rate = this.goldPerSecond();
    if (rate <= 0) return "";
    const seconds = Math.ceil(Number(missing) / rate);
    if (seconds < 90) return `~${seconds} s`;
    return `~${Math.round(seconds / 60)} min`;
  }

  /** Lock (missing building) or a gold bar (how close it is to affordable). */
  private renderAffordance(unitType: PlayerBuildableUnitType) {
    if (this.missingPrereq(unitType) !== null) {
      return html`<span
        class="absolute -top-1.5 -right-1 text-[9px] leading-none pointer-events-none"
        >🔒</span
      >`;
    }
    const cost = this.cost(unitType);
    const gold = this.game?.myPlayer()?.gold() ?? 0n;
    if (cost <= 0n || gold >= cost) return nothing;
    const percent = Number((gold * 100n) / cost);
    return html`<div
      class="absolute left-0 bottom-0 h-0.5 rounded-sm bg-yellow-400/80 pointer-events-none"
      style="width: ${percent}%"
    ></div>`;
  }

  /** The savings goal as a small chip at the end of the bar. */
  private renderSavingsGoalChip() {
    const goal = this.savingsGoal;
    if (goal === null || !this.isUnitDisplayed(goal)) return nothing;
    const cost = this.cost(goal);
    const gold = this.game?.myPlayer()?.gold() ?? 0n;
    const prereq = this.missingPrereq(goal);
    const ready = prereq === null && gold >= cost;
    const percent =
      cost > 0n ? Math.min(100, Number((gold * 100n) / cost)) : 100;
    const label = ready
      ? translateText("savings.ready")
      : prereq !== null
        ? `🔒 ${prereq.map((t) => translateText("unit_type." + (UNIT_KEYS[t] ?? ""))).join(" / ")}`
        : `${percent}% ${this.etaText(cost - gold)}`;
    return html`
      <div class="flex flex-col items-center relative">
        <button
          class="border rounded-sm h-full w-full px-1 flex items-center gap-1 text-[10px] font-bold whitespace-nowrap cursor-pointer max-lg:landscape:h-7.5 side-bar:h-12 ${
            ready
              ? "border-green-400 text-green-300 bg-green-500/15 animate-pulse"
              : "border-yellow-400/70 text-yellow-200"
          }"
          title=${translateText("savings.clear_hint")}
          @click=${() => this.toggleSavingsGoal(goal)}
        >
          🎯 ${translateText("unit_type." + this.structureKeyOf(goal))}
          <span class="font-normal">${label}</span>
        </button>
      </div>
    `;
  }

  private structureKeyOf(type: PlayerBuildableUnitType): string {
    return (
      (
        {
          [UnitType.City]: "city",
          [UnitType.Factory]: "factory",
          [UnitType.Port]: "port",
          [UnitType.DefensePost]: "defense_post",
          [UnitType.MissileSilo]: "missile_silo",
          [UnitType.SAMLauncher]: "sam_launcher",
          [UnitType.Warship]: "warship",
          [UnitType.AtomBomb]: "atom_bomb",
          [UnitType.HydrogenBomb]: "hydrogen_bomb",
          [UnitType.MIRV]: "mirv",
          [UnitType.AADefense]: "aa_defense",
          [UnitType.Airfield]: "airfield",
          [UnitType.FighterJet]: "fighter_jet",
          [UnitType.Bomber]: "bomber",
          [UnitType.RailDepot]: "rail_depot",
          [UnitType.Tank]: "tank",
          [UnitType.NuclearSubmarine]: "nuclear_submarine",
          [UnitType.LandMine]: "land_mine",
          [UnitType.SeaMine]: "sea_mine",
          [UnitType.RepairStation]: "repair_station",
          [UnitType.AircraftCarrier]: "aircraft_carrier",
          [UnitType.CruiseMissile]: "cruise_missile",
          [UnitType.TransportPlane]: "transport_plane",
          [UnitType.Capital]: "capital",
        } as Partial<Record<UnitType, string>>
      )[type] ?? ""
    );
  }

  /** Lock reason, missing gold and the goal hint for the tooltip. */
  private renderSavingsTooltip(unitType: PlayerBuildableUnitType) {
    const prereq = this.missingPrereq(unitType);
    const cost = this.cost(unitType);
    const gold = this.game?.myPlayer()?.gold() ?? 0n;
    return html`
      ${
        prereq !== null
          ? html`<div class="px-2 text-orange-300">
              🔒
              ${translateText("savings.needs", {
                units: prereq
                  .map((t) =>
                    translateText("unit_type." + (UNIT_KEYS[t] ?? "")),
                  )
                  .join(translateText("savings.or")),
              })}
            </div>`
          : nothing
      }
      ${
        cost > gold
          ? html`<div class="px-2 text-yellow-200/80">
              ${translateText("savings.missing", {
                gold: renderNumber(cost - gold),
                eta: this.etaText(cost - gold),
              })}
            </div>`
          : nothing
      }
      ${
        Platform.hasKeyboard
          ? html`<div class="px-2 text-[10px] text-white/50">
              ${translateText(
                this.savingsGoal === unitType
                  ? "savings.clear_hint"
                  : "savings.set_hint",
              )}
            </div>`
          : nothing
      }
    `;
  }

  private renderUnitTooltip() {
    // A peek wins over a hover: it is the one the player asked for by
    // holding the button.
    const peek = this._peekedUnitTooltip;
    const tooltip = peek ?? this._hoveredUnitTooltip;
    if (!tooltip) return nothing;
    // The item can go away (a unit gets disabled) while it is hovered.
    if (!tooltip.element.isConnected) return nothing;
    const displayHotkey = tooltip.hotkey
      .replace("Digit", "")
      .replace("Key", "")
      .toUpperCase();
    // Measured at render time so the tooltip follows the item when the bar
    // scrolls or the layout changes, instead of staying where it was hovered.
    const root = this.querySelector<HTMLElement>(".unit-display-root");
    const itemBounds = tooltip.element.getBoundingClientRect();
    const rootBounds = root?.getBoundingClientRect();
    const sideBar = this.isSideBar();
    let left: number;
    let top: number;
    let placement: string;
    if (sideBar) {
      // Left of the item, centred on it, so it doesn't cover the bar.
      left = itemBounds.left - (rootBounds?.left ?? 0) - 6;
      top = itemBounds.top + itemBounds.height / 2 - (rootBounds?.top ?? 0);
      placement =
        "-translate-x-full -translate-y-1/2 max-w-[min(16rem,100vw_-_5rem)]";
      this._tooltipCenter = top;
    } else {
      left = itemBounds.left + itemBounds.width / 2 - (rootBounds?.left ?? 0);
      top = itemBounds.top - (rootBounds?.top ?? 0) - 4;
      placement =
        "-translate-x-1/2 -translate-y-full max-w-[min(100%_-_1rem,100vw_-_1rem)]";
      this._tooltipCenter = left;
    }

    return html`
      <div
        class="unit-display-tooltip ${peek ? "block" : "hidden pointer-fine:block"} absolute ${placement} text-gray-200 text-center w-max break-words text-xs bg-gray-800/90 backdrop-blur-xs rounded-sm p-1 z-[100] shadow-lg pointer-events-none"
        style=${`left: ${left}px; top: ${top}px;`}
      >
        <div class="font-bold text-sm mb-1">
          ${translateText("unit_type." + tooltip.structureKey)}${
            tooltip.hotkey ? ` [${displayHotkey}]` : ""
          }
        </div>
        <div class="p-2">
          ${translateText("build_menu.desc." + tooltip.structureKey)}
        </div>
        ${
          tooltip.unitType === UnitType.Warship && Platform.hasKeyboard
            ? html`<div
                class="mt-1 px-2 py-1 text-[10px] text-cyan-300 border-t border-white/10"
              >
                ⇧ ${translateText("build_menu.warship_shift_hint")}
              </div>`
            : null
        }
        <div class="flex items-center justify-center gap-1">
          <img src=${goldCoinIcon} width="13" height="13" />
          <span class="text-yellow-300"
            >${renderNumber(this.cost(tooltip.unitType))}</span
          >
        </div>
        ${this.renderSavingsTooltip(tooltip.unitType)}
      </div>
    `;
  }
}
