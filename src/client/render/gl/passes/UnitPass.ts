/**
 * UnitPass — GPU-rendered mobile unit sprites.
 *
 * Renders all mobile (non-structure) units: boats, nukes, shells, SAM
 * missiles, MIRV warheads and aircraft. All unit types but the aircraft are
 * rotationally symmetric — no rotation needed; an aircraft's sprite points
 * north and the vertex shader turns it to its heading (a per-instance
 * byte). Sprites are tiny grayscale PNGs colorized on the
 * GPU using the standard 3-band gray replacement (180/130/70). MIRV
 * Warhead uses a programmatic 3×3 white square (colorized to border
 * color); Shell is a single white pixel.
 *
 * Two instanced draw calls per frame — ground units and missiles are
 * split into separate buffers for correct layer ordering:
 *   Ground/sea (boats, trains) → rendered below structures
 *   Missiles (nukes, shells, SAM, MIRV warheads) and aircraft → rendered
 *   above structures
 *
 * Atlas layout (14 columns × 13px cells, pre-built by generate-sprite-atlases.mjs):
 *   Col 0: Transport (5×5)
 *   Col 1: Trade Ship (5×5)
 *   Col 2: Warship (11×11)
 *   Col 3: Atom Bomb (7×7)
 *   Col 4: Hydrogen Bomb (9×9)
 *   Col 5: MIRV (13×13, grayscale colorized)
 *   Col 6: SAM Missile (3×3)
 *   Col 7: Shell (1×1 white pixel)
 *   Col 8: MIRV Warhead (3×3 white square)
 *   Col 9: Train Engine (5×5)
 *   Col 10: Train Carriage (5×5)
 *   Col 11: Train Carriage Loaded (5×5)
 *   Col 12: Fighter Jet (9×12, pointing north)
 *   Col 13: Bomber (13×12, pointing north)
 *   Col 14: Tank (7×9, pointing north)
 *   Col 15: Nuclear Submarine (11×5)
 *   Col 16: Land Mine (5×5)
 *   Col 17: Sea Mine (5×5)
 *
 * Data flow:
 *   FrameSnapshot.units → filter by typeToAtlasIdx → instance VBO → GPU
 *   Shells emit 2 instances (pos + lastPos) to match live game's 2-pixel trail.
 */

import type { Config } from "@openfront/engine-lib/configuration/Config";
import { assetUrl } from "@openfront/shared/AssetUrls";
import type { RendererConfig, UnitState } from "../../types";
import {
  HEADING_TYPES,
  UT_AIRCRAFT_CARRIER,
  UT_CRUISE_MISSILE,
  UT_TRANSPORT_PLANE,
  SMOOTHED_NUKE_TYPES,
  TrainType,
  UT_ATOM_BOMB,
  UT_BOMBER,
  UT_FIGHTER_JET,
  UT_HYDROGEN_BOMB,
  UT_LAND_MINE,
  UT_MIRV,
  UT_MIRV_WARHEAD,
  UT_NUCLEAR_SUBMARINE,
  UT_SAM_MISSILE,
  UT_SEA_MINE,
  UT_SHELL,
  UT_TANK,
  UT_TRADE_SHIP,
  UT_TRAIN,
  UT_TRANSPORT,
  UT_WARSHIP,
} from "../../types";
import { DynamicInstanceBuffer } from "../DynamicBuffer";
import type { RenderSettings } from "../RenderSettings";
import unitFragSrc from "../shaders/unit/unit.frag.glsl?raw";
import unitVertSrc from "../shaders/unit/unit.vert.glsl?raw";
import {
  getPaletteSize,
  MAX_TRAIL_COLORS,
  TRAIN_EFFECT_BLOCK,
  WARSHIP_EFFECT_BLOCK,
} from "../utils/ColorUtils";
import { createProgram, shaderSrc } from "../utils/GlUtils";
import { glides, UnitGlide } from "../utils/UnitGlide";

const unitAtlasUrl = assetUrl("atlases/unit-atlas.png");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Unit types in atlas column order. Index = atlas column.
 *  TrainEngine/TrainCarriage/TrainCarriageLoaded are synthetic names —
 *  they don't match header.unitTypes directly. Train resolution is
 *  handled specially in updateUnits() via trainType + loaded fields.
 */
const UNIT_ORDER = [
  UT_TRANSPORT,
  UT_TRADE_SHIP,
  UT_WARSHIP,
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_SAM_MISSILE,
  UT_SHELL,
  UT_MIRV_WARHEAD,
  "TrainEngine",
  "TrainCarriage",
  "TrainCarriageLoaded",
  UT_FIGHTER_JET,
  UT_BOMBER,
  UT_TANK,
  UT_NUCLEAR_SUBMARINE,
  UT_LAND_MINE,
  UT_SEA_MINE,
  UT_AIRCRAFT_CARRIER,
  UT_CRUISE_MISSILE,
  UT_TRANSPORT_PLANE,
] as const;

const ATLAS_COLS = UNIT_ORDER.length;

/** Atlas column of the hydrogen bomb — drives the GPU glow halo. */
const HYDROGEN_BOMB_COL = UNIT_ORDER.indexOf(UT_HYDROGEN_BOMB);

/** Atlas column of the warship — gates the warship cosmetic effect. */
const WARSHIP_COL = UNIT_ORDER.indexOf(UT_WARSHIP);

/** First atlas column of the train sprites (engine, carriage, loaded
 *  carriage are contiguous) — gates the train cosmetic effect. */
const TRAIN_FIRST_COL = UNIT_ORDER.indexOf("TrainEngine");

/** First atlas column of the aircraft sprites, right after the trains —
 *  where the train cosmetic effect ends. */
const AIRCRAFT_FIRST_COL = UNIT_ORDER.indexOf(UT_FIGHTER_JET);

// ---------------------------------------------------------------------------
// Instance data layout
// ---------------------------------------------------------------------------

/**
 * Per-instance data (16 bytes):
 *   float x, y, ownerID   — 12 bytes (3 floats)
 *   uint8 atlasIdx         —  1 byte  (atlas column 0–11)
 *   uint8 flags            —  1 byte  (0 = normal, 1 = flicker, 2 = angry, 3 = trade-friendly, 4 = retreating, 5 = flicker-untargetable)
 *   uint8 flickerHash      —  1 byte  (per-instance flicker phase offset)
 *   uint8 heading          —  1 byte  (clockwise from north in 1/256 turns;
 *                                      0 for everything but aircraft)
 */
const FLOATS_PER_INSTANCE = 4;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

/** Flag values — passed as uint8, received as float in shader via normalized attribute */
const FLAG_NORMAL = 0;
const FLAG_FLICKER = 1;
const FLAG_ANGRY = 2;
const FLAG_TRADE_FRIENDLY = 3;
const FLAG_RETREATING = 4;
const FLAG_FLICKER_UNTARGETABLE = 5;
const FLAG_TRADE_SELF = 6;
/** A nuclear submarine coming up: blinks bright until it can fire. */
const FLAG_SUB_SURFACING = 7;
/** A surfaced nuclear submarine ready to launch nukes: glows red. */
const FLAG_SUB_READY = 8;

/** Atlas column indices for train sub-types (resolved from trainType + loaded) */
const TRAIN_ENGINE_COL = UNIT_ORDER.indexOf("TrainEngine");
const TRAIN_CARRIAGE_COL = UNIT_ORDER.indexOf("TrainCarriage");
const TRAIN_CARRIAGE_LOADED_COL = UNIT_ORDER.indexOf("TrainCarriageLoaded");

/** Nuke + warhead types — rendered with flickering hot colors */
const FLICKER_TYPES: ReadonlySet<string> = new Set([
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_MIRV_WARHEAD,
  UT_SAM_MISSILE,
  UT_SHELL,
]);

/** Missile/projectile types — rendered on top of structures in the layer order.
 *  Ground/sea units (boats, trains) render below structures. */
const MISSILE_TYPES: ReadonlySet<string> = new Set([
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_SAM_MISSILE,
  UT_SHELL,
  UT_MIRV_WARHEAD,
  UT_FIGHTER_JET,
  UT_BOMBER,
  // Tanks drive among structures; draw them on top so they stay visible.
  UT_TANK,
  UT_CRUISE_MISSILE,
  UT_TRANSPORT_PLANE,
]);

/** Where an aircraft (or tank) faces, and the move it was worked out from. */
interface AircraftHeading {
  pos: number;
  lastPos: number;
  /** Smoothed direction (unit vector, y southwards). */
  dx: number;
  dy: number;
  byte: number;
}

/** Weight of the new tick's move in the smoothed direction. Moves snap to
 *  whole tiles, so a single tick's direction wobbles by up to ~25° on a
 *  straight course; blending with the last one keeps the sprite steady. */
const HEADING_BLEND = 0.6;

/** The facing of an aircraft that moved from (lx, ly) to (x, y), blended
 *  with where it faced before. */
export function nextAircraftHeading(
  prev: AircraftHeading | undefined,
  pos: number,
  lastPos: number,
  x: number,
  y: number,
  lx: number,
  ly: number,
): AircraftHeading {
  if (prev !== undefined && prev.pos === pos && prev.lastPos === lastPos) {
    return prev;
  }
  const mx = x - lx;
  const my = y - ly;
  const mlen = Math.hypot(mx, my);
  let dx = mx / mlen;
  let dy = my / mlen;
  if (prev !== undefined) {
    const bx = prev.dx * (1 - HEADING_BLEND) + dx * HEADING_BLEND;
    const by = prev.dy * (1 - HEADING_BLEND) + dy * HEADING_BLEND;
    const blen = Math.hypot(bx, by);
    // A sharp reversal cancels out: then just face the new way.
    if (blen > 0.3) {
      dx = bx / blen;
      dy = by / blen;
    }
  }
  return { pos, lastPos, dx, dy, byte: headingByte(dx, dy) };
}

/** Heading byte for a unit that moved (dx, dy) tiles this tick: clockwise
 *  from north in 1/256 turns (y grows southwards). */
export function headingByte(dx: number, dy: number): number {
  return Math.round((Math.atan2(dx, -dy) / (2 * Math.PI)) * 256) & 255;
}

/** Values per smoothing segment in the flat `smoothSegs` array:
 *  (instanceIdx, lastX, lastY, x, y). The push site and the read loop must
 *  agree on this width — it's the record size, not a tunable. */
const SMOOTH_SEG_STRIDE = 5;

/** Per-instance flicker phase offset, hashed from the tick position. Computed
 *  CPU-side (not from the shader's instance position) so per-frame position
 *  smoothing doesn't re-roll the flicker every frame. Matches the formula the
 *  vertex shader previously applied to its rendered position. */
export function flickerHashByte(x: number, y: number): number {
  const f = x * 0.1731 + y * 0.3179;
  return ((f - Math.floor(f)) * 255) | 0;
}

// ---------------------------------------------------------------------------
// Helper: create a VAO for instanced unit rendering
// ---------------------------------------------------------------------------

function createUnitVao(
  gl: WebGL2RenderingContext,
  quadBuf: WebGLBuffer,
  instanceBuf: WebGLBuffer,
): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);

  // Attribute 0: unit quad [0,0]->[1,1]
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // Attribute 1: per-instance vec3 (x, y, ownerID) — 3 floats at offset 0
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuf);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, BYTES_PER_INSTANCE, 0);
  gl.vertexAttribDivisor(1, 1);

  // Attribute 2: per-instance (atlasIdx, flags, flickerHash, heading) — 4 uint8s at offset 12, converted to float
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, false, BYTES_PER_INSTANCE, 12);
  gl.vertexAttribDivisor(2, 1);

  gl.bindVertexArray(null);
  return vao;
}

// ---------------------------------------------------------------------------
// UnitPass
// ---------------------------------------------------------------------------

export class UnitPass {
  private gl: WebGL2RenderingContext;
  private settings: RenderSettings;
  private program: WebGLProgram;

  private uCamera: WebGLUniformLocation;
  private uTick: WebGLUniformLocation;
  private uTime: WebGLUniformLocation;
  private uUnitSize: WebGLUniformLocation;
  private uFlickerSpeed: WebGLUniformLocation;
  private uAngryColor: WebGLUniformLocation;
  private uAltView: WebGLUniformLocation;
  private uSelfColor: WebGLUniformLocation;
  private uAllyColor: WebGLUniformLocation;
  private uHBombGlowScale: WebGLUniformLocation;
  private uHBombGlowColor: WebGLUniformLocation;
  private uHBombGlowStrength: WebGLUniformLocation;
  private uHBombGlowInner: WebGLUniformLocation;
  private uUntargetableAlpha: WebGLUniformLocation;

  private affiliationTex: WebGLTexture | null = null;
  private altView = false;

  // Ground/sea units (boats, trains) — render below structures
  private groundVao: WebGLVertexArrayObject;
  private groundBuf: DynamicInstanceBuffer;
  private groundCount = 0;

  // Missiles/projectiles (nukes, shells, SAM) — render above structures
  private missileVao: WebGLVertexArrayObject;
  private missileBuf: DynamicInstanceBuffer;
  private missileCount = 0;

  // Per-frame nuke smoothing: flat SMOOTH_SEG_STRIDE-wide tuples
  // (instanceIdx, lastX, lastY, x, y) recorded each tick, lerped into the
  // missile buffer in drawMissiles.
  private smoothSegs: number[] = [];
  /** Same tuples for ground units (ships, trains, boats): they glide
   *  between ticks too (UnitGlide), lerped into the ground buffer. */
  private groundSegs: number[] = [];
  /** Unit id → its tile at the previous game tick / at this one. Swapped
   *  each new tick. Ships, trains, aircraft and tanks glide from these rather
   *  than from UnitState.lastPos, which goes stale once a unit stops (no
   *  update arrives to reset it): a parked tank would replay its last step
   *  every tick. Nukes keep lastPos — they never stop, and it also covers
   *  their first tick. */
  private prevTickPos = new Map<number, number>();
  private tickPos = new Map<number, number>();
  /** Which units glide this tick and how far along they are; shared with the
   *  passes that draw on units (bars, lights, selection box). */
  readonly glide: UnitGlide;
  /** The buffer already holds the tick's end positions (alpha reached 1). */
  private groundSettled = false;
  private missilesSettled = false;
  /** Aircraft id → where it faces, kept so an aircraft that did not move
   *  this tick keeps facing the way it flew. Rebuilt every update. */
  private aircraftHeadings = new Map<number, AircraftHeading>();

  private quadBuf: WebGLBuffer;
  private paletteTex: WebGLTexture;
  private effectTex: WebGLTexture;
  private atlasTex: WebGLTexture;

  /** Render frame counter received from renderer — drives uTick shader uniform and flicker effects */
  private frameTick = 0;
  /** Last game engine tick received for smoothing calculation resets */
  private lastGameTick = -1;
  /** Wall-clock start, for uTime (seconds) — matches StructurePass so the
   *  warship/train effects animate at the same pace as the structures effect. */
  private startTime = performance.now();

  /** unitType string → atlas column (0-11) */
  private typeToAtlasCol = new Map<string, number>();
  private mapW: number;

  // Trade-friendly detection: enemy trade ships heading to a self/allied port
  private localPlayerID = 0;
  private friendlyOwners = new Set<number>();
  private structures: Map<number, UnitState> = new Map();

  constructor(
    gl: WebGL2RenderingContext,
    header: RendererConfig,
    paletteTex: WebGLTexture,
    effectTex: WebGLTexture,
    settings: RenderSettings,
    config: Config,
  ) {
    this.gl = gl;
    this.settings = settings;
    this.mapW = header.mapWidth;
    this.paletteTex = paletteTex;
    this.effectTex = effectTex;
    this.glide = new UnitGlide(config.msPerTick(), this.mapW);

    // Build unitType string → atlas column mapping
    for (let i = 0; i < header.unitTypes.length; i++) {
      const col = UNIT_ORDER.indexOf(
        header.unitTypes[i] as (typeof UNIT_ORDER)[number],
      );
      if (col >= 0) {
        this.typeToAtlasCol.set(header.unitTypes[i], col);
      }
    }

    // Compile shaders
    this.program = createProgram(
      gl,
      shaderSrc(unitVertSrc, { ATLAS_COLS, HYDROGEN_BOMB_COL }),
      shaderSrc(unitFragSrc, {
        PALETTE_SIZE: getPaletteSize(),
        ATLAS_COLS,
        WARSHIP_COL,
        WARSHIP_EFFECT_ROW_BASE: WARSHIP_EFFECT_BLOCK * MAX_TRAIL_COLORS,
        TRAIN_FIRST_COL,
        AIRCRAFT_FIRST_COL,
        TRAIN_EFFECT_ROW_BASE: TRAIN_EFFECT_BLOCK * MAX_TRAIL_COLORS,
      }),
      "UnitPass",
    );
    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uTick = gl.getUniformLocation(this.program, "uTick")!;
    this.uTime = gl.getUniformLocation(this.program, "uTime")!;
    this.uUnitSize = gl.getUniformLocation(this.program, "uUnitSize")!;
    this.uFlickerSpeed = gl.getUniformLocation(this.program, "uFlickerSpeed")!;
    this.uAngryColor = gl.getUniformLocation(this.program, "uAngryColor")!;

    this.uAltView = gl.getUniformLocation(this.program, "uAltView")!;
    this.uSelfColor = gl.getUniformLocation(this.program, "uSelfColor")!;
    this.uAllyColor = gl.getUniformLocation(this.program, "uAllyColor")!;
    this.uHBombGlowScale = gl.getUniformLocation(
      this.program,
      "uHBombGlowScale",
    )!;
    this.uHBombGlowColor = gl.getUniformLocation(
      this.program,
      "uHBombGlowColor",
    )!;
    this.uHBombGlowStrength = gl.getUniformLocation(
      this.program,
      "uHBombGlowStrength",
    )!;
    this.uHBombGlowInner = gl.getUniformLocation(
      this.program,
      "uHBombGlowInner",
    )!;
    this.uUntargetableAlpha = gl.getUniformLocation(
      this.program,
      "uUntargetableAlpha",
    )!;

    // Texture unit bindings
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uPalette"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uAtlas"), 1);
    gl.uniform1i(gl.getUniformLocation(this.program, "uAffiliation"), 2);
    gl.uniform1i(gl.getUniformLocation(this.program, "uEffect"), 3);

    // Create placeholder atlas texture (1x1 gray pixel)
    this.atlasTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([128, 128, 128, 255]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Start async atlas build
    void this.loadAtlas();

    // --- Shared quad buffer ---
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );

    // --- Ground instance buffer + VAO ---
    const groundGlBuf = gl.createBuffer()!;
    this.groundBuf = new DynamicInstanceBuffer(
      gl,
      groundGlBuf,
      1024,
      FLOATS_PER_INSTANCE,
    );
    this.groundVao = createUnitVao(gl, this.quadBuf, groundGlBuf);

    // --- Missile instance buffer + VAO ---
    const missileGlBuf = gl.createBuffer()!;
    this.missileBuf = new DynamicInstanceBuffer(
      gl,
      missileGlBuf,
      512,
      FLOATS_PER_INSTANCE,
    );
    this.missileVao = createUnitVao(gl, this.quadBuf, missileGlBuf);
  }

  private async loadAtlas(): Promise<void> {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = unitAtlasUrl;
    await img.decode();
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  private emitGround(
    x: number,
    y: number,
    ownerID: number,
    atlasIdx: number,
    flags: number,
  ): void {
    this.groundBuf.ensureCapacity(this.groundCount + 1);
    const off = this.groundCount * FLOATS_PER_INSTANCE;
    this.groundBuf.float32[off + 0] = x;
    this.groundBuf.float32[off + 1] = y;
    this.groundBuf.float32[off + 2] = ownerID;
    const byteOff = this.groundCount * BYTES_PER_INSTANCE;
    this.groundBuf.uint8[byteOff + 12] = atlasIdx;
    this.groundBuf.uint8[byteOff + 13] = flags;
    this.groundBuf.uint8[byteOff + 14] = flickerHashByte(x, y);
    this.groundBuf.uint8[byteOff + 15] = 0;
    this.groundCount++;
  }

  private emitMissile(
    x: number,
    y: number,
    ownerID: number,
    atlasIdx: number,
    flags: number,
    heading = 0,
  ): void {
    this.missileBuf.ensureCapacity(this.missileCount + 1);
    const off = this.missileCount * FLOATS_PER_INSTANCE;
    this.missileBuf.float32[off + 0] = x;
    this.missileBuf.float32[off + 1] = y;
    this.missileBuf.float32[off + 2] = ownerID;
    const byteOff = this.missileCount * BYTES_PER_INSTANCE;
    this.missileBuf.uint8[byteOff + 12] = atlasIdx;
    this.missileBuf.uint8[byteOff + 13] = flags;
    this.missileBuf.uint8[byteOff + 14] = flickerHashByte(x, y);
    this.missileBuf.uint8[byteOff + 15] = heading;
    this.missileCount++;
  }

  setFrameTick(frameTick: number): void {
    this.frameTick = frameTick;
  }

  updateUnits(units: Map<number, UnitState>, gameTick: number): void {
    if (gameTick !== this.lastGameTick) {
      this.lastGameTick = gameTick;
      this.glide.startTick(performance.now());
      // This tick's positions become the previous tick's.
      const prev = this.prevTickPos;
      this.prevTickPos = this.tickPos;
      this.tickPos = prev;
    }
    // Rebuilt from scratch on every call, also a repeated one within a tick.
    this.tickPos.clear();
    this.glide.from.clear();
    this.groundCount = 0;
    this.missileCount = 0;
    this.smoothSegs.length = 0;
    this.groundSegs.length = 0;
    this.groundSettled = false;
    this.missilesSettled = false;
    const lastHeadings = this.aircraftHeadings;
    const headings = new Map<number, AircraftHeading>();
    this.aircraftHeadings = headings;

    for (const unit of units.values()) {
      if (!unit.isActive || unit.waitTicks > 0) continue;

      let atlasIdx = this.typeToAtlasCol.get(unit.unitType);

      // Train sub-type resolution: "Train" isn't in UNIT_ORDER.
      // Resolve to engine/carriage/loaded carriage based on trainType + loaded fields.
      if (atlasIdx === undefined && unit.unitType === UT_TRAIN) {
        const tt = unit.trainType;
        if (tt === TrainType.Engine || tt === TrainType.TailEngine) {
          atlasIdx = TRAIN_ENGINE_COL;
        } else {
          atlasIdx = unit.loaded
            ? TRAIN_CARRIAGE_LOADED_COL
            : TRAIN_CARRIAGE_COL;
        }
      }

      if (atlasIdx === undefined) continue;

      const isRetreatingWarship =
        unit.unitType === UT_WARSHIP && unit.retreating;
      // Aircraft and tanks face where they go and glide between ticks.
      const isAircraft = HEADING_TYPES.has(unit.unitType);
      // An aircraft or tank with a target (something to shoot or bomb)
      // turns red like an attacking warship.
      const isAngryWarship =
        (unit.unitType === UT_WARSHIP ||
          unit.unitType === UT_AIRCRAFT_CARRIER ||
          unit.unitType === UT_NUCLEAR_SUBMARINE ||
          isAircraft) &&
        unit.targetUnitId !== null;
      const isFlicker = FLICKER_TYPES.has(unit.unitType);

      // Alt-view trade ship color from owner + destination port owner:
      //   self involved on either end        -> green  (FLAG_TRADE_SELF)
      //   ally/teammate involved on either end -> yellow (FLAG_TRADE_FRIENDLY)
      //   otherwise                          -> red    (owner affiliation)
      let tradeFlag = FLAG_NORMAL;
      if (
        unit.unitType === UT_TRADE_SHIP &&
        unit.targetUnitId !== null &&
        this.localPlayerID > 0
      ) {
        const targetPort = this.structures.get(unit.targetUnitId);
        if (targetPort) {
          const portOwner = targetPort.ownerID;
          if (
            unit.ownerID === this.localPlayerID ||
            portOwner === this.localPlayerID
          ) {
            tradeFlag = FLAG_TRADE_SELF;
          } else if (
            this.friendlyOwners.has(unit.ownerID) ||
            this.friendlyOwners.has(portOwner)
          ) {
            tradeFlag = FLAG_TRADE_FRIENDLY;
          }
        }
      }

      let flags = FLAG_NORMAL;
      if (tradeFlag !== FLAG_NORMAL) {
        flags = tradeFlag;
      } else if (
        unit.unitType === UT_NUCLEAR_SUBMARINE &&
        unit.submarineMode === 1
      ) {
        flags = FLAG_SUB_SURFACING;
      } else if (
        unit.unitType === UT_NUCLEAR_SUBMARINE &&
        unit.submarineMode === 2
      ) {
        flags = FLAG_SUB_READY;
      } else if (isRetreatingWarship) {
        flags = FLAG_RETREATING;
      } else if (isAngryWarship) {
        flags = FLAG_ANGRY;
      } else if (isFlicker) {
        // Untargetable nukes render dimmed so players can tell SAMs can't hit them
        flags = unit.targetable ? FLAG_FLICKER : FLAG_FLICKER_UNTARGETABLE;
      }
      const isMissile = MISSILE_TYPES.has(unit.unitType);

      const x = unit.pos % this.mapW;
      const y = (unit.pos - x) / this.mapW;

      if (isMissile) {
        let facing = isAircraft ? lastHeadings.get(unit.id) : undefined;
        let from: number | undefined;
        if (SMOOTHED_NUKE_TYPES.has(unit.unitType)) {
          if (unit.lastPos !== unit.pos) from = unit.lastPos;
        } else if (isAircraft) {
          this.tickPos.set(unit.id, unit.pos);
          const prev = this.prevTickPos.get(unit.id);
          if (prev !== undefined && glides(prev, unit.pos, this.mapW)) {
            from = prev;
          }
        }
        if (from !== undefined) {
          const fx = from % this.mapW;
          const fy = (from - fx) / this.mapW;
          this.smoothSegs.push(this.missileCount, fx, fy, x, y);
          this.glide.from.set(unit.id, from);
        }
        // The last move decides where it faces, also once it stopped.
        if (isAircraft && unit.lastPos !== unit.pos) {
          const lx = unit.lastPos % this.mapW;
          const ly = (unit.lastPos - lx) / this.mapW;
          facing = nextAircraftHeading(
            facing,
            unit.pos,
            unit.lastPos,
            x,
            y,
            lx,
            ly,
          );
        }
        const heading = facing?.byte ?? 0;
        if (facing !== undefined) {
          headings.set(unit.id, facing);
        }
        this.emitMissile(x, y, unit.ownerID, atlasIdx, flags, heading);

        // Shells emit a second instance at lastPos (2-pixel trail effect)
        if (unit.unitType === UT_SHELL && unit.lastPos !== unit.pos) {
          const lx = unit.lastPos % this.mapW;
          const ly = (unit.lastPos - lx) / this.mapW;
          this.emitMissile(lx, ly, unit.ownerID, atlasIdx, flags);
        }
      } else {
        this.tickPos.set(unit.id, unit.pos);
        const from = this.prevTickPos.get(unit.id);
        if (from !== undefined && glides(from, unit.pos, this.mapW)) {
          const lx = from % this.mapW;
          const ly = (from - lx) / this.mapW;
          this.groundSegs.push(this.groundCount, lx, ly, x, y);
          this.glide.from.set(unit.id, from);
        }
        this.emitGround(x, y, unit.ownerID, atlasIdx, flags);
      }
    }

    const gl = this.gl;
    if (this.groundCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.groundBuf.buffer);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        this.groundBuf.float32,
        0,
        this.groundCount * FLOATS_PER_INSTANCE,
      );
    }
    if (this.missileCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.missileBuf.buffer);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        this.missileBuf.float32,
        0,
        this.missileCount * FLOATS_PER_INSTANCE,
      );
    }
  }

  setAltView(active: boolean): void {
    this.altView = active;
  }
  setAffiliationTex(tex: WebGLTexture): void {
    this.affiliationTex = tex;
  }
  setLocalPlayer(id: number): void {
    this.localPlayerID = id;
  }
  setAllies(allies: Set<number>): void {
    this.friendlyOwners = allies;
  }
  setStructures(structs: Map<number, UnitState>): void {
    this.structures = structs;
  }

  /** Bind shared program state + uniforms (call before drawGround/drawMissiles). */
  private bindProgram(cameraMatrix: Float32Array): void {
    const gl = this.gl;
    gl.useProgram(this.program);

    const us = this.settings.unit;
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1f(this.uTick, this.frameTick);
    gl.uniform1f(this.uTime, (performance.now() - this.startTime) / 1000);
    gl.uniform1f(this.uUnitSize, us.unitSize);
    gl.uniform1f(this.uFlickerSpeed, us.flickerSpeed);
    gl.uniform3f(this.uAngryColor, us.angryR, us.angryG, us.angryB);
    gl.uniform1i(this.uAltView, this.altView ? 1 : 0);
    const af = this.settings.affiliation;
    gl.uniform3f(this.uSelfColor, af.selfR, af.selfG, af.selfB);
    gl.uniform3f(this.uAllyColor, af.allyR, af.allyG, af.allyB);
    gl.uniform1f(this.uHBombGlowScale, us.hBombGlowScale);
    gl.uniform3f(
      this.uHBombGlowColor,
      us.hBombGlowR,
      us.hBombGlowG,
      us.hBombGlowB,
    );
    gl.uniform1f(this.uHBombGlowStrength, us.hBombGlowStrength);
    gl.uniform1f(this.uHBombGlowInner, us.hBombGlowInner);
    gl.uniform1f(this.uUntargetableAlpha, us.untargetableAlpha);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);

    if (this.affiliationTex) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.affiliationTex);
    }

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.effectTex);
  }

  /** Draw ground/sea units (boats, trains). Render below structures. */
  drawGround(cameraMatrix: Float32Array): void {
    if (this.groundCount === 0) return;
    this.applyGroundSmoothing();
    this.bindProgram(cameraMatrix);
    const gl = this.gl;
    gl.bindVertexArray(this.groundVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.groundCount);
  }

  /** Draw missiles/projectiles (nukes, shells, SAM, MIRV warheads). Render above structures. */
  drawMissiles(cameraMatrix: Float32Array): void {
    if (this.missileCount === 0) return;
    this.applyMissileSmoothing();
    this.bindProgram(cameraMatrix);
    const gl = this.gl;
    gl.bindVertexArray(this.missileVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.missileCount);
  }

  /** Lerp smoothed nukes and aircraft lastPos→pos (see applySmoothing). */
  private applyMissileSmoothing(): void {
    if (this.missilesSettled) return;
    this.missilesSettled = this.applySmoothing(
      this.smoothSegs,
      this.missileBuf,
      this.missileCount,
    );
  }

  /** Lerp ships, boats and trains from last tick's tile (see applySmoothing). */
  private applyGroundSmoothing(): void {
    if (this.groundSettled) return;
    this.groundSettled = this.applySmoothing(
      this.groundSegs,
      this.groundBuf,
      this.groundCount,
    );
  }

  /** Lerp the gliding instances of `buf` from their previous to their current
   *  tile by wall-clock progress through the current tick (UnitGlide), and
   *  re-upload the buffer. Returns true once the tick is over (alpha 1): the
   *  buffer then holds the end positions and needs no more uploads until the
   *  next tick brings new segments. */
  private applySmoothing(
    segs: number[],
    buf: DynamicInstanceBuffer,
    count: number,
  ): boolean {
    if (segs.length === 0) return false;
    const alpha = this.glide.alpha(performance.now());
    const f32 = buf.float32;
    for (let i = 0; i < segs.length; i += SMOOTH_SEG_STRIDE) {
      const off = segs[i] * FLOATS_PER_INSTANCE;
      f32[off + 0] = segs[i + 1] + (segs[i + 3] - segs[i + 1]) * alpha;
      f32[off + 1] = segs[i + 2] + (segs[i + 4] - segs[i + 2]) * alpha;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, f32, 0, count * FLOATS_PER_INSTANCE);
    return alpha >= 1;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    this.groundBuf.dispose();
    this.missileBuf.dispose();
    gl.deleteBuffer(this.quadBuf);
    gl.deleteVertexArray(this.groundVao);
    gl.deleteVertexArray(this.missileVao);
    gl.deleteTexture(this.atlasTex);
  }
}
