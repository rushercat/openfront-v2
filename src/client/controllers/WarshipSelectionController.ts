import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Aircraft,
  Cell,
  PatrolUnits,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { Controller } from "../Controller";
import {
  CloseViewEvent,
  ContextMenuEvent,
  LandClickEvent,
  MouseUpEvent,
  SelectAllWarshipsEvent,
  SurfaceSubmarinesEvent,
  TouchEvent,
  UnitSelectionEvent,
  WarshipSelectionBoxCancelEvent,
  WarshipSelectionBoxCompleteEvent,
  WarshipSelectionBoxUpdateEvent,
} from "../InputHandler";
import { MapRenderer } from "../render/gl";
import { OWNER_MASK } from "../render/gl/utils/TileCodec";
import { TransformHandler } from "../TransformHandler";
import {
  MoveWarshipIntentEvent,
  SurfaceSubmarineIntentEvent,
} from "../Transport";
import { GameView, UnitView } from "../view";

const WARSHIP_SELECTION_RADIUS = 10;

/**
 * Controller for warship and aircraft selection state + click handling.
 *
 * Aircraft are selected and sent around like warships (the engine keeps
 * their patrol tile in warshipState). The difference is where: a warship is
 * picked and sent on water only, an aircraft anywhere. A click on land is an
 * attack unless it is meant for an aircraft, so it arrives here as a
 * LandClickEvent from ClientGameRunner, which attacks only if this
 * controller leaves the event unhandled.
 *
 * Drawing for selection boxes (single + multi) lives in the WebGL
 * SelectionBoxPass (forwarded via UnitSelectionEvent from ClientGameRunner).
 * The drag-rectangle preview is a screen-space DOM overlay (dragRectEl) we
 * own here.
 *
 * This class does not render anything to canvas2D — it's purely a state +
 * click controller. The "Controller" pattern: main-thread analog of the
 * worker's Execution (init + tick + event subscriptions).
 */
export class WarshipSelectionController implements Controller {
  // Currently selected single warship (game-logic readers use this; the
  // visual is drawn by WebGL SelectionBoxPass).
  private selectedUnit: UnitView | null = null;
  // Currently multi-selected warships (shift+drag box select).
  private multiSelectedWarships: UnitView[] = [];

  // Drag rectangle (shift+drag warship selection box) — a screen-space DOM
  // overlay positioned via inline style.
  private dragRectEl: HTMLDivElement | null = null;

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private transformHandler: TransformHandler,
    private view: MapRenderer,
  ) {}

  tick() {
    // Prune any destroyed warships from the multi-selection so callers
    // (move-warship intent) don't try to act on dead units. The WebGL
    // SelectionBoxPass also drops them automatically.
    this.multiSelectedWarships = this.multiSelectedWarships.filter((u) =>
      u.isActive(),
    );
    this.refreshTankBuffer();
  }

  // --- Tank border buffer ---

  private tankBufferShown = false;
  private tankBufferTicks = 0;
  private tankBufferPending = false;

  /**
   * While a tank of the player is selected, outline how far past the
   * border it may drive unharmed (Config.tankBorderBuffer): the union of
   * circles of that radius around the border, sampled on a coarse grid.
   * Refreshed every second, as the border moves.
   */
  private refreshTankBuffer(): void {
    const myPlayer = this.game.myPlayer();
    const selected =
      this.selectedUnit !== null
        ? [this.selectedUnit]
        : this.multiSelectedWarships;
    const tankSelected =
      myPlayer !== null &&
      selected.some(
        (u) =>
          u.isActive() && u.type() === UnitType.Tank && u.owner() === myPlayer,
      );
    if (!tankSelected) {
      if (this.tankBufferShown) {
        this.tankBufferShown = false;
        this.view.setTankBuffer(null);
      }
      this.tankBufferTicks = 0;
      return;
    }
    if (
      this.tankBufferPending ||
      (this.tankBufferShown && ++this.tankBufferTicks < 10)
    ) {
      return;
    }
    this.tankBufferTicks = 0;
    this.tankBufferPending = true;
    const radius = this.game.config().tankBorderBuffer();
    // Dense enough that the outline follows the border closely (it can be off
    // by about half a cell).
    const cell = Math.max(3, Math.floor(radius / 6));
    const mySmallID = myPlayer!.smallID();
    // The circles reach into the player's own land as far as out of it; own
    // land is always safe, so only the outline beyond the border is drawn.
    const keepAt = (x: number, y: number): boolean => {
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      if (!this.game.isValidCoord(tx, ty)) return true;
      const ref = this.game.ref(tx, ty);
      return (this.game.tileState(ref) & OWNER_MASK) !== mySmallID;
    };
    myPlayer!
      .borderTiles()
      .then(({ borderTiles }) => {
        const seen = new Set<number>();
        const circles: { x: number; y: number; radius: number }[] = [];
        const w = this.game.width();
        for (const tile of borderTiles) {
          const x = tile % w;
          const y = (tile - x) / w;
          const key = Math.floor(x / cell) * 65536 + Math.floor(y / cell);
          if (seen.has(key)) continue;
          seen.add(key);
          circles.push({ x, y, radius });
        }
        this.tankBufferShown = true;
        this.view.setTankBuffer(circles, keepAt);
      })
      .catch((error) => console.warn("Failed to get border tiles", error))
      .finally(() => {
        this.tankBufferPending = false;
      });
  }

  init() {
    this.eventBus.on(UnitSelectionEvent, (e) => this.onUnitSelection(e));

    this.ensureDragRectEl();
    this.eventBus.on(WarshipSelectionBoxUpdateEvent, (e) => {
      this.updateDragRect(e.startX, e.startY, e.endX, e.endY);
    });
    const clearBox = () => this.hideDragRect();
    this.eventBus.on(WarshipSelectionBoxCompleteEvent, clearBox);
    this.eventBus.on(WarshipSelectionBoxCancelEvent, clearBox);
    this.eventBus.on(CloseViewEvent, clearBox);

    // Warship select/move click flow (previously in the deleted UnitLayer).
    this.eventBus.on(MouseUpEvent, (e) => this.onMouseUp(e));
    this.eventBus.on(LandClickEvent, (e) => {
      if (this.onLandClick(e.tile)) e.handled = true;
    });
    this.eventBus.on(TouchEvent, (e) => this.onTouch(e));
    this.eventBus.on(WarshipSelectionBoxCompleteEvent, (e) =>
      this.onSelectionBoxComplete(e),
    );
    this.eventBus.on(SelectAllWarshipsEvent, () => this.onSelectAllWarships());
    this.eventBus.on(SurfaceSubmarinesEvent, () => this.onSurfaceSubmarines());
  }

  /**
   * Lazily create the shift+drag rectangle overlay. Screen-space DOM element,
   * pointer-events: none so it doesn't intercept the drag itself. z-index
   * sits above the WebGL/canvas2D map canvases but below HUD modals.
   */
  private ensureDragRectEl(): void {
    if (this.dragRectEl !== null) return;
    const el = document.createElement("div");
    el.id = "warship-drag-rect";
    el.style.position = "fixed";
    el.style.pointerEvents = "none";
    el.style.display = "none";
    el.style.zIndex = "30";
    el.style.borderStyle = "dashed";
    el.style.borderWidth = "1px";
    el.style.boxSizing = "border-box";
    document.body.appendChild(el);
    this.dragRectEl = el;
  }

  private updateDragRect(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ): void {
    const el = this.dragRectEl;
    if (el === null) return;
    const x1 = Math.min(startX, endX);
    const y1 = Math.min(startY, endY);
    const w = Math.abs(endX - startX);
    const h = Math.abs(endY - startY);

    // Color from the local player's territory tint (matches the canvas2D look).
    const myPlayer = this.game.myPlayer();
    const base = myPlayer ? myPlayer.territoryColor().lighten(0.2) : null;
    const border = base
      ? base.alpha(0.85).toRgbString()
      : "rgba(100, 200, 255, 0.85)";
    const fill = base
      ? base.alpha(0.06).toRgbString()
      : "rgba(100, 200, 255, 0.06)";

    el.style.left = `${x1}px`;
    el.style.top = `${y1}px`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.borderColor = border;
    el.style.backgroundColor = fill;
    el.style.display = "block";
  }

  private hideDragRect(): void {
    if (this.dragRectEl !== null) this.dragRectEl.style.display = "none";
  }

  /**
   * Find player-owned warships and aircraft near the given cell, sorted by
   * distance. On land only aircraft can be there.
   */
  private findWarshipsNearCell(clickRef: TileRef): UnitView[] {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return [];
    const types = this.game.isWater(clickRef)
      ? PatrolUnits.types
      : [...Aircraft.types, UnitType.Tank];
    return this.game
      .units(...types)
      .filter(
        (unit) =>
          unit.isActive() &&
          unit.owner() === myPlayer &&
          this.game.manhattanDist(unit.tile(), clickRef) <=
            WARSHIP_SELECTION_RADIUS,
      )
      .sort(
        (a, b) =>
          this.game.manhattanDist(a.tile(), clickRef) -
          this.game.manhattanDist(b.tile(), clickRef),
      );
  }

  /**
   * Resolve a left-click in the world:
   *  - multi-selected warships present + clicked water → move them all
   *  - single selected warship + clicked water → move it, then deselect
   *  - otherwise → if there's a nearby warship, select the closest one
   */
  private onMouseUp(
    event: MouseUpEvent,
    clickRef?: TileRef,
    nearbyWarships?: UnitView[],
  ) {
    if (clickRef === undefined) {
      const cell = this.transformHandler.screenToWorldCoordinates(
        event.x,
        event.y,
      );
      if (!this.game.isValidCoord(cell.x, cell.y)) return;
      clickRef = this.game.ref(cell.x, cell.y);
    }
    if (!this.game.isWater(clickRef)) return;

    if (this.multiSelectedWarships.length > 0) {
      const myPlayer = this.game.myPlayer();
      const activeIds = this.multiSelectedWarships
        .filter((u) => u.isActive() && u.owner() === myPlayer)
        .map((u) => u.id());

      if (activeIds.length > 0) {
        this.eventBus.emit(new MoveWarshipIntentEvent(activeIds, clickRef));
      }
      this.eventBus.emit(new UnitSelectionEvent(null, false));
      return;
    }

    if (this.selectedUnit) {
      this.eventBus.emit(
        new MoveWarshipIntentEvent([this.selectedUnit.id()], clickRef),
      );
      this.eventBus.emit(new UnitSelectionEvent(this.selectedUnit, false));
      return;
    }

    nearbyWarships ??= this.findWarshipsNearCell(clickRef);
    if (nearbyWarships.length > 0) {
      this.eventBus.emit(new UnitSelectionEvent(nearbyWarships[0], true));
    }
  }

  /**
   * A click on land (LandClickEvent). Returns true if it was meant for an
   * aircraft, so that it must not attack:
   *  - aircraft selected → send them there (selected warships stay put)
   *  - nothing selected + one of the player's aircraft is flying there →
   *    select it
   */
  private onLandClick(clickRef: TileRef): boolean {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return false;
    const selected =
      this.selectedUnit !== null
        ? [this.selectedUnit]
        : this.multiSelectedWarships;
    // Aircraft and tanks go on land.
    const aircraftIds = selected
      .filter(
        (u) =>
          u.isActive() &&
          u.owner() === myPlayer &&
          (Aircraft.has(u.type()) || u.type() === UnitType.Tank),
      )
      .map((u) => u.id());
    if (aircraftIds.length > 0) {
      this.eventBus.emit(new MoveWarshipIntentEvent(aircraftIds, clickRef));
      this.eventBus.emit(new UnitSelectionEvent(null, false));
      return true;
    }
    if (selected.length > 0) {
      // Only warships selected: they cannot go on land, the click attacks.
      return false;
    }
    const nearbyAircraft = this.findWarshipsNearCell(clickRef);
    if (nearbyAircraft.length > 0) {
      this.eventBus.emit(new UnitSelectionEvent(nearbyAircraft[0], true));
      return true;
    }
    return false;
  }

  /**
   * Touch handler mirroring mouse-up. On dry land with no selection, falls
   * back to opening the radial menu.
   */
  private onTouch(event: TouchEvent) {
    const cell = this.transformHandler.screenToWorldCoordinates(
      event.x,
      event.y,
    );
    if (!this.game.isValidCoord(cell.x, cell.y)) return;

    const clickRef = this.game.ref(cell.x, cell.y);
    // The onboarding tutorial teaches one tap: on land it spawns, attacks
    // or sends a boat directly, without the radial menu.
    if (
      this.game.inSpawnPhase() ||
      this.game.config().gameConfig().tutorial === true
    ) {
      if (!this.game.isWater(clickRef)) {
        this.eventBus.emit(new MouseUpEvent(event.x, event.y));
      }
      return;
    }
    if (!this.game.isWater(clickRef)) {
      // A tap on land sends the selected aircraft there or picks one up;
      // otherwise it opens the radial menu.
      if (!this.onLandClick(clickRef)) {
        this.eventBus.emit(new ContextMenuEvent(event.x, event.y));
      }
      return;
    }
    if (this.selectedUnit || this.multiSelectedWarships.length > 0) {
      this.onMouseUp(new MouseUpEvent(event.x, event.y), clickRef);
      return;
    }
    const nearbyWarships = this.findWarshipsNearCell(clickRef);
    if (nearbyWarships.length > 0) {
      this.onMouseUp(
        new MouseUpEvent(event.x, event.y),
        clickRef,
        nearbyWarships,
      );
    } else {
      this.eventBus.emit(new ContextMenuEvent(event.x, event.y));
    }
  }

  /**
   * Resolve a shift+drag selection box: gather all player-owned warships
   * whose screen position falls inside the rectangle.
   */
  private onSelectionBoxComplete(event: WarshipSelectionBoxCompleteEvent) {
    const x1 = Math.min(event.startX, event.endX);
    const y1 = Math.min(event.startY, event.endY);
    const x2 = Math.max(event.startX, event.endX);
    const y2 = Math.max(event.startY, event.endY);

    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;

    // The box picks up aircraft as well: a mixed selection sent to water goes
    // there together, sent to land only the aircraft go.
    const selected = this.game.units(...PatrolUnits.types).filter((unit) => {
      if (!unit.isActive() || unit.owner() !== myPlayer) return false;
      const screen = this.transformHandler.worldToScreenCoordinates(
        new Cell(this.game.x(unit.tile()), this.game.y(unit.tile())),
      );
      return (
        screen.x >= x1 && screen.x <= x2 && screen.y >= y1 && screen.y <= y2
      );
    });

    // Clear single selection if we got a box selection
    if (selected.length > 0 && this.selectedUnit) {
      this.eventBus.emit(new UnitSelectionEvent(this.selectedUnit, false));
    }
    this.eventBus.emit(new UnitSelectionEvent(null, true, selected));
  }

  private getAllWarships(): UnitView[] {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return [];
    return this.game
      .units(UnitType.Warship)
      .filter((u) => u.isActive() && u.owner() === myPlayer);
  }

  public selectedAllWarships(): boolean {
    const allWarships = this.getAllWarships();
    return (
      allWarships.length > 0 &&
      this.multiSelectedWarships.length === allWarships.length
    );
  }

  /**
   * Surfaces the selected submerged submarines; with none of them selected,
   * every submerged submarine of the player.
   */
  private onSurfaceSubmarines() {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;
    const selected =
      this.selectedUnit !== null
        ? [this.selectedUnit]
        : this.multiSelectedWarships;
    const isMySubmergedSub = (u: UnitView) =>
      u.isActive() &&
      u.owner() === myPlayer &&
      u.type() === UnitType.NuclearSubmarine &&
      u.state.submerged;
    let subs = selected.filter(isMySubmergedSub);
    if (subs.length === 0) {
      subs = this.game
        .units(UnitType.NuclearSubmarine)
        .filter(isMySubmergedSub);
    }
    for (const sub of subs) {
      this.eventBus.emit(new SurfaceSubmarineIntentEvent(sub.id()));
    }
  }

  private onSelectAllWarships() {
    const allWarships = this.getAllWarships();
    if (allWarships.length === 0) return;

    if (this.selectedUnit) {
      this.eventBus.emit(new UnitSelectionEvent(this.selectedUnit, false));
    }
    this.eventBus.emit(
      new UnitSelectionEvent(null, !this.selectedAllWarships(), allWarships),
    );
  }

  /**
   * Handle the unit selection event (single or multi).
   * When event.units.length > 0 it's a multi-selection from box/select-all.
   * When event.unit is set it's a single warship selection.
   * When event.isSelected is false it clears all selection state.
   */
  private onUnitSelection(event: UnitSelectionEvent) {
    this.multiSelectedWarships = [];
    this.selectedUnit = null;

    if (!event.isSelected) {
      this.view.setSelectedUnits([]);
      return;
    }

    if ((event.units ?? []).length > 0) {
      this.multiSelectedWarships = event.units;
      this.view.setSelectedUnits(event.units.map((u) => u.id()));
    } else {
      this.selectedUnit = event.unit;
      this.view.setSelectedUnits(event.unit ? [event.unit.id()] : []);
    }
  }
}
