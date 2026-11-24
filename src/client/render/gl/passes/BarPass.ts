/**
 * BarPass — instanced health/progress bars and warship veterancy pips.
 *
 * Three draw calls per frame (all share one program + instance buffer):
 *   1. Health bars (11x3 tiles, above warships and aircraft)
 *   2. Progress bars (14x3 tiles, below structures — construction + missile readiness)
 *   3. Veterancy pips (solid gold rank bars stacked at a warship's bottom-right)
 *   4. Structure health bars (14x3 tiles, above a damaged structure)
 *
 * Data flow:
 *   UnitState.health / .missileTimerQueue / .constructionStartTick → CPU progress
 *   → instance VBO (x, y, progress) → GPU colored rectangle
 *   UnitState.veterancy → one instance per level (x, y, slot) → solid gold rect
 */

import { UnitType } from "@openfront/engine-api/game/GameTypes";
import type { Config } from "@openfront/engine-lib/configuration/Config";
import { maxHealthAtLevel } from "@openfront/engine-lib/game/UnitHealth";
import { maxHealthWithVeterancy } from "@openfront/engine-lib/game/Veterancy";
import type { RendererConfig, UnitState } from "../../types";
import {
  STRUCTURE_TYPES,
  UT_AA_DEFENSE,
  UT_MISSILE_SILO,
  UT_SAM_LAUNCHER,
  UT_WARSHIP,
} from "../../types";
import type { RenderSettings } from "../RenderSettings";
import { createProgram } from "../utils/GlUtils";
import type { UnitGlide } from "../utils/UnitGlide";

import barFragSrc from "../shaders/bar/bar.frag.glsl?raw";
import barVertSrc from "../shaders/bar/bar.vert.glsl?raw";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLOATS_PER_INSTANCE = 3; // x, y, progress
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

/** Values per glide record: (instance, fromX, fromY, toX, toY). */
const SEG_STRIDE = 5;

/** Moves the gliding bars in `data` to `alpha` of the way along their step. */
function lerpSegs(segs: number[], data: Float32Array, alpha: number): void {
  for (let i = 0; i < segs.length; i += SEG_STRIDE) {
    const off = segs[i] * FLOATS_PER_INSTANCE;
    data[off] = segs[i + 1] + (segs[i + 3] - segs[i + 1]) * alpha;
    data[off + 1] = segs[i + 2] + (segs[i + 4] - segs[i + 2]) * alpha;
  }
}

// ---------------------------------------------------------------------------
// BarPass
// ---------------------------------------------------------------------------

export class BarPass {
  private gl: WebGL2RenderingContext;
  private settings: RenderSettings;
  private program: WebGLProgram;
  private maxBars = 2048;

  private uCamera: WebGLUniformLocation;
  private uBarSize: WebGLUniformLocation;
  private uBarOffset: WebGLUniformLocation;
  private uBorderWidth: WebGLUniformLocation;
  private uThresholds: WebGLUniformLocation;
  private uColorRed: WebGLUniformLocation;
  private uColorOrange: WebGLUniformLocation;
  private uColorYellow: WebGLUniformLocation;
  private uColorGreen: WebGLUniformLocation;
  private uSolid: WebGLUniformLocation;
  private uSolidColor: WebGLUniformLocation;
  private uPipStride: WebGLUniformLocation;

  private vao: WebGLVertexArrayObject;
  private instanceBuf: WebGLBuffer;

  private healthData: Float32Array;
  private healthCount = 0;
  private progressData: Float32Array;
  private progressCount = 0;
  private veterancyData: Float32Array;
  private veterancyCount = 0;
  private structureHealthData: Float32Array;
  private structureHealthCount = 0;

  /** Gliding units' bars: (instance, fromX, fromY, toX, toY) per bar, so a
   *  bar follows its ship between ticks (UnitGlide) instead of hopping. */
  private healthSegs: number[] = [];
  private progressSegs: number[] = [];
  private veterancySegs: number[] = [];
  private glide: UnitGlide | null = null;

  private mapW: number;
  private veterancyHealthBonus: number;
  /** unitType string → level 1 max health (0 = the type has no health). */
  private baseMaxHealth = new Map<string, number>();

  constructor(
    gl: WebGL2RenderingContext,
    header: RendererConfig,
    settings: RenderSettings,
    private config: Config,
  ) {
    this.gl = gl;
    this.settings = settings;
    this.mapW = header.mapWidth;
    this.veterancyHealthBonus = config.warshipVeterancyHealthBonus();

    // --- Shader program ---
    this.program = createProgram(gl, barVertSrc, barFragSrc, "BarPass");
    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uBarSize = gl.getUniformLocation(this.program, "uBarSize")!;
    this.uBarOffset = gl.getUniformLocation(this.program, "uBarOffset")!;
    this.uBorderWidth = gl.getUniformLocation(this.program, "uBorderWidth")!;
    this.uThresholds = gl.getUniformLocation(this.program, "uThresholds")!;
    this.uColorRed = gl.getUniformLocation(this.program, "uColorRed")!;
    this.uColorOrange = gl.getUniformLocation(this.program, "uColorOrange")!;
    this.uColorYellow = gl.getUniformLocation(this.program, "uColorYellow")!;
    this.uColorGreen = gl.getUniformLocation(this.program, "uColorGreen")!;
    this.uSolid = gl.getUniformLocation(this.program, "uSolid")!;
    this.uSolidColor = gl.getUniformLocation(this.program, "uSolidColor")!;
    this.uPipStride = gl.getUniformLocation(this.program, "uPipStride")!;

    // --- Instance data buffers (CPU-side) ---
    this.healthData = new Float32Array(this.maxBars * FLOATS_PER_INSTANCE);
    this.progressData = new Float32Array(this.maxBars * FLOATS_PER_INSTANCE);
    this.veterancyData = new Float32Array(this.maxBars * FLOATS_PER_INSTANCE);
    this.structureHealthData = new Float32Array(
      this.maxBars * FLOATS_PER_INSTANCE,
    );

    // --- VAO: unit quad + instanced data ---
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // Quad vertices (2 triangles)
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Instance buffer (dynamic)
    this.instanceBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.maxBars * BYTES_PER_INSTANCE,
      gl.DYNAMIC_DRAW,
    );
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, BYTES_PER_INSTANCE, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.bindVertexArray(null);
  }

  /** The units' glide between ticks (UnitPass), so bars move with them. */
  setGlide(glide: UnitGlide): void {
    this.glide = glide;
  }

  /** Rebuild bar instance data from current unit state. */
  updateBars(
    mobileUnits: Map<number, UnitState>,
    structures: Map<number, UnitState>,
    gameTick: number,
  ): void {
    this.healthCount = 0;
    this.progressCount = 0;
    this.veterancyCount = 0;
    this.structureHealthCount = 0;
    this.healthSegs.length = 0;
    this.progressSegs.length = 0;
    this.veterancySegs.length = 0;

    // --- Health bars (warships, aircraft) + veterancy pips (warships) ---
    for (const unit of mobileUnits.values()) {
      // A surfacing nuclear submarine: how far until it can fire.
      if (unit.submarineMode === 1 && unit.submarineReadyTick !== undefined) {
        const total = this.config.submarineSurfaceTicks();
        const left = unit.submarineReadyTick - gameTick;
        if (total > 0) {
          this.pushProgress(unit, Math.min(1, Math.max(0, 1 - left / total)));
        }
      }
      if (unit.health === null || unit.health <= 0) continue;
      const base = this.baseMaxHealthOf(unit.unitType);
      if (base <= 0) continue;
      // Veteran warships have a higher effective max health, so a full veteran
      // ship reads as full. Shared with the engine's UnitImpl.maxHealth().
      // Only warships have veterancy.
      const maxHealth =
        unit.unitType === UT_WARSHIP
          ? maxHealthWithVeterancy(
              base,
              unit.veterancy,
              this.veterancyHealthBonus,
            )
          : base;
      if (unit.health < maxHealth) {
        this.pushHealth(unit, unit.health / maxHealth);
      }
      if (unit.veterancy > 0) {
        this.pushVeterancy(unit);
      }
    }

    // --- Progress bars + health bars (structures) ---
    for (const unit of structures.values()) {
      if (!unit.isActive) continue;
      // The renderer hands over every unit here (Upload.updateStructures);
      // ships, aircraft and tanks already have their bar above, so a damaged
      // one would otherwise get a second one underneath.
      if (!STRUCTURE_TYPES.has(unit.unitType)) continue;
      const progress = this.computeStructureProgress(unit, gameTick);
      if (progress !== null) this.pushProgress(unit, progress);

      // A structure aircraft have damaged. An upgraded one has more health
      // (shared with the engine's UnitImpl.maxHealth()).
      if (unit.health === null || unit.health <= 0) continue;
      const base = this.baseMaxHealthOf(unit.unitType);
      if (base <= 0) continue;
      const maxHealth = maxHealthAtLevel(base, unit.level);
      if (unit.health < maxHealth) {
        this.pushStructureHealth(unit, unit.health / maxHealth);
      }
    }
  }

  private baseMaxHealthOf(unitType: string): number {
    let base = this.baseMaxHealth.get(unitType);
    if (base === undefined) {
      base = this.config.unitInfo(unitType as UnitType).maxHealth ?? 0;
      this.baseMaxHealth.set(unitType, base);
    }
    return base;
  }

  /** Render bars. Call once per frame after FX, before names. */
  draw(cameraMat: Float32Array): void {
    if (
      this.healthCount === 0 &&
      this.progressCount === 0 &&
      this.veterancyCount === 0 &&
      this.structureHealthCount === 0
    )
      return;

    const gl = this.gl;
    const b = this.settings.bar;

    if (this.glide !== null) {
      const alpha = this.glide.alpha(performance.now());
      lerpSegs(this.healthSegs, this.healthData, alpha);
      lerpSegs(this.progressSegs, this.progressData, alpha);
      lerpSegs(this.veterancySegs, this.veterancyData, alpha);
    }

    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMat);
    gl.uniform1f(this.uSolid, 0); // health/progress bars use the colored path
    gl.uniform1f(this.uBorderWidth, b.borderWidth);
    gl.uniform3f(this.uThresholds, b.threshold1, b.threshold2, b.threshold3);
    gl.uniform3f(this.uColorRed, b.colorRedR, b.colorRedG, b.colorRedB);
    gl.uniform3f(
      this.uColorOrange,
      b.colorOrangeR,
      b.colorOrangeG,
      b.colorOrangeB,
    );
    gl.uniform3f(
      this.uColorYellow,
      b.colorYellowR,
      b.colorYellowG,
      b.colorYellowB,
    );
    gl.uniform3f(this.uColorGreen, b.colorGreenR, b.colorGreenG, b.colorGreenB);
    gl.bindVertexArray(this.vao);

    // Health bars
    if (this.healthCount > 0) {
      gl.uniform2f(this.uBarSize, b.healthBarW, b.healthBarH);
      gl.uniform2f(this.uBarOffset, -b.healthBarW / 2, b.healthBarOffsetY);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        this.healthData.subarray(0, this.healthCount * FLOATS_PER_INSTANCE),
      );
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.healthCount);
    }

    // Progress bars
    if (this.progressCount > 0) {
      gl.uniform2f(this.uBarSize, b.progressBarW, b.progressBarH);
      gl.uniform2f(this.uBarOffset, -b.progressBarW / 2, b.progressBarOffsetY);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        this.progressData.subarray(0, this.progressCount * FLOATS_PER_INSTANCE),
      );
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.progressCount);
    }

    // Structure health bars (the progress bar's size, under the icon)
    if (this.structureHealthCount > 0) {
      gl.uniform2f(this.uBarSize, b.progressBarW, b.progressBarH);
      gl.uniform2f(
        this.uBarOffset,
        -b.progressBarW / 2,
        b.structureHealthBarOffsetY,
      );
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        this.structureHealthData.subarray(
          0,
          this.structureHealthCount * FLOATS_PER_INSTANCE,
        ),
      );
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.structureHealthCount);
    }

    // Veterancy pips (solid gold rank bars, bottom-right of warship sprites)
    if (this.veterancyCount > 0) {
      gl.uniform1f(this.uSolid, 1);
      gl.uniform3f(this.uSolidColor, b.veterancyR, b.veterancyG, b.veterancyB);
      gl.uniform1f(this.uPipStride, b.veterancyPipH + b.veterancyPipGap);
      gl.uniform2f(this.uBarSize, b.veterancyPipW, b.veterancyPipH);
      gl.uniform2f(
        this.uBarOffset,
        b.veterancyPipOffsetX,
        b.veterancyPipOffsetY,
      );
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        this.veterancyData.subarray(
          0,
          this.veterancyCount * FLOATS_PER_INSTANCE,
        ),
      );
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.veterancyCount);
    }

    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.gl.deleteBuffer(this.instanceBuf);
    this.gl.deleteVertexArray(this.vao);
  }

  // ---- Private ----

  private pushHealth(unit: UnitState, progress: number): void {
    if (this.healthCount >= this.maxBars) return;
    const off = this.healthCount * FLOATS_PER_INSTANCE;
    this.healthData[off] = unit.pos % this.mapW;
    this.healthData[off + 1] = (unit.pos - this.healthData[off]) / this.mapW;
    this.healthData[off + 2] = progress;
    this.pushGlide(this.healthSegs, this.healthCount, unit);
    this.healthCount++;
  }

  /** Emit one gold pip instance per veterancy level, stacked by slot index. */
  private pushVeterancy(unit: UnitState): void {
    const x = unit.pos % this.mapW;
    const y = (unit.pos - x) / this.mapW;
    for (let slot = 0; slot < unit.veterancy; slot++) {
      if (this.veterancyCount >= this.maxBars) return;
      const off = this.veterancyCount * FLOATS_PER_INSTANCE;
      this.veterancyData[off] = x;
      this.veterancyData[off + 1] = y;
      this.veterancyData[off + 2] = slot; // vertical stack slot, read by the shader
      this.pushGlide(this.veterancySegs, this.veterancyCount, unit);
      this.veterancyCount++;
    }
  }

  /** Records that bar `index` belongs to a unit gliding this tick. */
  private pushGlide(segs: number[], index: number, unit: UnitState): void {
    const from = this.glide?.from.get(unit.id);
    if (from === undefined) return;
    const fx = from % this.mapW;
    const tx = unit.pos % this.mapW;
    segs.push(
      index,
      fx,
      (from - fx) / this.mapW,
      tx,
      (unit.pos - tx) / this.mapW,
    );
  }

  private pushStructureHealth(unit: UnitState, progress: number): void {
    if (this.structureHealthCount >= this.maxBars) return;
    const off = this.structureHealthCount * FLOATS_PER_INSTANCE;
    const x = unit.pos % this.mapW;
    this.structureHealthData[off] = x;
    this.structureHealthData[off + 1] = (unit.pos - x) / this.mapW;
    this.structureHealthData[off + 2] = progress;
    this.structureHealthCount++;
  }

  private pushProgress(unit: UnitState, progress: number): void {
    if (this.progressCount >= this.maxBars) return;
    const off = this.progressCount * FLOATS_PER_INSTANCE;
    const x = unit.pos % this.mapW;
    this.progressData[off] = x;
    this.progressData[off + 1] = (unit.pos - x) / this.mapW;
    this.progressData[off + 2] = progress;
    this.pushGlide(this.progressSegs, this.progressCount, unit);
    this.progressCount++;
  }

  private computeStructureProgress(
    unit: UnitState,
    gameTick: number,
  ): number | null {
    // Deletion progress (reverse countdown — takes priority over other bars)
    if (unit.markedForDeletion !== false) {
      const remaining = unit.markedForDeletion - gameTick;
      return Math.max(
        0,
        Math.min(1, remaining / this.config.deletionMarkDuration()),
      );
    }

    // Construction progress
    if (unit.underConstruction && unit.constructionStartTick !== null) {
      const duration =
        this.config.unitInfo(unit.unitType as UnitType).constructionDuration ??
        50;
      const elapsed = gameTick - unit.constructionStartTick;
      return Math.min(1, Math.max(0, elapsed / duration));
    }

    // Missile readiness (Silo / SAM / AA Defense)
    if (
      unit.unitType === UT_MISSILE_SILO ||
      unit.unitType === UT_SAM_LAUNCHER ||
      unit.unitType === UT_AA_DEFENSE
    ) {
      const readiness = this.missileReadiness(unit, gameTick);
      if (readiness < 1) return readiness;
    }

    return null;
  }

  private missileReadiness(unit: UnitState, gameTick: number): number {
    const maxMissiles = unit.level;
    const reloading = unit.missileTimerQueue.length;
    if (reloading === 0) return 1;

    const ready = maxMissiles - reloading;

    const cooldown =
      unit.unitType === UT_SAM_LAUNCHER
        ? this.config.SAMCooldown()
        : unit.unitType === UT_AA_DEFENSE
          ? this.config.aaDefenseCooldown()
          : this.config.SiloCooldown();

    let readiness = ready / maxMissiles;
    for (const timer of unit.missileTimerQueue) {
      const progress = gameTick - timer;
      readiness += progress / cooldown / maxMissiles;
    }
    return Math.max(0, Math.min(1, readiness));
  }
}
