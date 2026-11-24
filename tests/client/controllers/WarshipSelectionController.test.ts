import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { WarshipSelectionController } from "../../../src/client/controllers/WarshipSelectionController";
import {
  LandClickEvent,
  UnitSelectionEvent,
} from "../../../src/client/InputHandler";
import { MoveWarshipIntentEvent } from "../../../src/client/Transport";

describe("WarshipSelectionController", () => {
  let game: any;
  let eventBus: any;
  let transformHandler: any;
  let view: any;

  beforeEach(() => {
    game = {
      width: () => 100,
      height: () => 100,
      config: () => ({
        theme: () => ({
          territoryColor: () => ({
            lighten: () => ({ alpha: () => ({ toRgbString: () => "#fff" }) }),
          }),
        }),
      }),
      x: () => 10,
      y: () => 10,
      unitInfo: () => ({ maxHealth: 10, constructionDuration: 5 }),
      myPlayer: () => ({ id: () => 1 }),
      ticks: () => 1,
      updatesSinceLastTick: () => undefined,
    };
    eventBus = { on: vi.fn() };
    transformHandler = {};
    view = { setSelectedUnits: vi.fn() };
  });

  it("tracks the selected unit on single-unit selection (rendering is WebGL)", () => {
    const ui = new WarshipSelectionController(
      game,
      eventBus,
      transformHandler,
      view,
    );
    const unit = {
      id: () => 1,
      type: () => "Warship",
      isActive: () => true,
      tile: () => ({}),
      owner: () => ({}),
    };
    const event = { isSelected: true, unit };
    ui["onUnitSelection"](event as UnitSelectionEvent);
    // selectedUnit is held for game-logic callers (the click handlers). The
    // visual selection box is drawn by WebGL SelectionBoxPass — wired from
    // ClientGameRunner via view.setSelectedUnits([unit.id()]).
    expect(ui["selectedUnit"]).toBe(unit);
  });

  it("clears selection on deselect", () => {
    const ui = new WarshipSelectionController(
      game,
      eventBus,
      transformHandler,
      view,
    );
    const unit = {
      id: () => 1,
      type: () => "Warship",
      isActive: () => true,
      tile: () => ({}),
      owner: () => ({}),
    };
    ui["onUnitSelection"]({ isSelected: true, unit } as UnitSelectionEvent);
    ui["onUnitSelection"]({
      isSelected: false,
      unit: null,
    } as unknown as UnitSelectionEvent);
    expect(ui["selectedUnit"]).toBeNull();
  });

  it("tracks multi-selection list", () => {
    const ui = new WarshipSelectionController(
      game,
      eventBus,
      transformHandler,
      view,
    );
    const units = [
      { id: () => 1, isActive: () => true },
      { id: () => 2, isActive: () => true },
    ];
    ui["onUnitSelection"]({
      isSelected: true,
      unit: null,
      units,
    } as unknown as UnitSelectionEvent);
    expect(ui["multiSelectedWarships"]).toEqual(units);
    expect(ui["selectedUnit"]).toBeNull();
  });
});

// Aircraft fly over land, where a click is normally an attack.
// ClientGameRunner offers every land click as a LandClickEvent first and
// attacks only if nobody marks it handled.
describe("WarshipSelectionController land clicks", () => {
  const me = { id: () => 1 };
  const LAND = 500;

  function unit(id: number, type: UnitType, tile: number, owner: object = me) {
    return {
      id: () => id,
      type: () => type,
      tile: () => tile,
      owner: () => owner,
      isActive: () => true,
    };
  }

  function setup(units: ReturnType<typeof unit>[]) {
    const bus = new EventBus();
    const game = {
      myPlayer: () => me,
      isWater: () => false,
      units: (...types: UnitType[]) =>
        units.filter((u) => types.includes(u.type())),
      manhattanDist: (a: number, b: number) => Math.abs(a - b),
    };
    const view = { setSelectedUnits: vi.fn() };
    const controller = new WarshipSelectionController(
      game as any,
      bus,
      {} as any,
      view as any,
    );
    controller.init();
    const moves: MoveWarshipIntentEvent[] = [];
    bus.on(MoveWarshipIntentEvent, (e) => moves.push(e));
    const click = (tile: number) => {
      const event = new LandClickEvent(tile);
      bus.emit(event);
      return event.handled;
    };
    return { bus, controller, view, moves, click };
  }

  it("selects one of the player's aircraft flying there, not a warship or a foreign aircraft", () => {
    const fighter = unit(1, UnitType.FighterJet, LAND + 6);
    const { controller, view, moves, click } = setup([
      unit(2, UnitType.Warship, LAND + 1),
      unit(3, UnitType.Bomber, LAND + 2, { id: () => 2 }),
      fighter,
    ]);

    expect(click(LAND)).toBe(true);
    expect(controller["selectedUnit"]).toBe(fighter);
    expect(view.setSelectedUnits).toHaveBeenLastCalledWith([1]);
    expect(moves).toEqual([]);
  });

  it("sends the selected aircraft to the clicked tile and clears the selection", () => {
    const bomber = unit(4, UnitType.Bomber, LAND + 3);
    const { bus, controller, moves, click } = setup([bomber]);
    bus.emit(new UnitSelectionEvent(bomber as any, true));

    expect(click(LAND + 300)).toBe(true);
    expect(moves).toHaveLength(1);
    expect(moves[0].unitIds).toEqual([4]);
    expect(moves[0].tile).toBe(LAND + 300);
    expect(controller["selectedUnit"]).toBeNull();
  });

  it("sends only the aircraft of a mixed selection onto land", () => {
    const warship = unit(5, UnitType.Warship, 10);
    const fighter = unit(6, UnitType.FighterJet, 12);
    const { bus, moves, click } = setup([warship, fighter]);
    bus.emit(new UnitSelectionEvent(null, true, [warship, fighter] as any));

    expect(click(LAND)).toBe(true);
    expect(moves.map((m) => m.unitIds)).toEqual([[6]]);
  });

  it("leaves the click to the attack when only warships are selected", () => {
    const warship = unit(7, UnitType.Warship, 10);
    const { bus, controller, moves, click } = setup([warship]);
    bus.emit(new UnitSelectionEvent(warship as any, true));

    expect(click(LAND)).toBe(false);
    expect(moves).toEqual([]);
    expect(controller["selectedUnit"]).toBe(warship);
  });

  it("leaves the click to the attack when no aircraft is near", () => {
    const { controller, click } = setup([
      unit(8, UnitType.FighterJet, LAND + 200),
    ]);

    expect(click(LAND)).toBe(false);
    expect(controller["selectedUnit"]).toBeNull();
  });
});
