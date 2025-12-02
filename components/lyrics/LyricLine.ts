import { LyricLine as LyricLineType } from "../../types";
import { ILyricLine } from "./ILyricLine";

const GLOW_CONFIG = {
  // Primary glow blur radius
  blur: 12,
  // Glow intensity multiplier
  intensity: 0.5,
  // Scale boost at peak glow - increased for magnification effect
  scaleBoost: 1.03,
};

// Wave propagation for character activation

const WAVE_PHYSICS = {
  speed: 3.5, // Characters per second equivalent
  decay: 0.85, // Wave amplitude decay per character
  wavelength: 3.0, // Characters width of the wave
};

export interface WordLayout {
  text: string;
  x: number;
  y: number; // Relative Y offset within the line block
  width: number;
  startTime: number;
  endTime: number;
  isVerbatim: boolean; // To distinguish between timed words and wrapped segments
  charWidths?: number[];
  charOffsets?: number[];
  renderProgress?: number;
}

const WRAPPED_LINE_GAP_RATIO = 0.25; // Extra spacing between auto-wrapped lyric lines

export interface LineLayout {
  y: number; 
  height: number;
  words: WordLayout[];
  fullText: string;
  translation?: string;
  translationLines?: string[];
  textWidth: number; 
  translationWidth?: number;
}

const detectLanguage = (text: string) => {
  const cjkRegex = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/;
  return cjkRegex.test(text) ? "zh" : "en";
};

// Font configuration

const getFonts = (isMobile: boolean) => {
  const baseSize = isMobile ? 32 : 40;
  const transSize = isMobile ? 18 : 22;
  return {
    main: `800 ${baseSize}px "PingFang SC", "Inter", sans-serif`,
    trans: `500 ${transSize}px "PingFang SC", "Inter", sans-serif`,
    mainHeight: baseSize,
    transHeight: transSize * 1.3,
  };
};

export class LyricLine implements ILyricLine {
  private canvas: OffscreenCanvas | HTMLCanvasElement;
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private layout: LineLayout | null = null;
  private lyricLine: LyricLineType;
  private isMobile: boolean;
  private _height: number = 0;
  private lastIsActive: boolean = false;
  private lastIsHovered: boolean = false;
  private isDirty: boolean = true;
  private pixelRatio: number;
  private logicalWidth: number = 0;
  private logicalHeight: number = 0;
  private wordCacheCanvas: OffscreenCanvas | HTMLCanvasElement;
  private wordCacheCtx:
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D;
  private cachedWordKey: string = "";

  constructor(line: LyricLineType, index: number, isMobile: boolean) {
    this.lyricLine = line;
    this.isMobile = isMobile;
    this.pixelRatio =
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    this.canvas = document.createElement("canvas");
    this.wordCacheCanvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d");
    const cacheCtx = this.wordCacheCanvas.getContext("2d");
    if (!ctx || !cacheCtx) throw new Error("Could not get canvas context");
    this.ctx = ctx as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D;
    this.wordCacheCtx = cacheCtx as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D;
  }

  private drawFullLine({
    currentTime,
    isActive,
    isHovered,
    hasTimedWords,
    mainFont,
    transFont,
    mainHeight,
    transHeight,
    paddingX,
  }: {
    currentTime: number;
    isActive: boolean;
    isHovered: boolean;
    hasTimedWords: boolean;
    mainFont: string;
    transFont: string;
    mainHeight: number;
    transHeight: number;
    paddingX: number;
  }) {
    if (!this.layout) return;

    this.ctx.clearRect(0, 0, this.logicalWidth, this.logicalHeight);
    this.ctx.save();

    this.ctx.font = mainFont;
    this.ctx.textBaseline = "top";
    this.ctx.translate(paddingX, 0);

    // 1. Draw Background (Hover)
    if (isHovered) {
      this.ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
      const bgWidth = Math.max(this.layout.textWidth + 32, 200);
      this.roundRect(-16, 0, bgWidth, this.layout.height, 16);
      this.ctx.fill();
    }

    // 2. Determine Active Line Context
    let activeLineY: number | null = null;
    let cursorX = 0;
    let activeWords: WordLayout[] = [];

    if (isActive && hasTimedWords) {
      const activeIdx = this.layout.words.findIndex(
        (w) => currentTime >= w.startTime && currentTime < w.endTime
      );
      
      let currentWord: WordLayout | null = null;
      if (activeIdx !== -1) {
          currentWord = this.layout.words[activeIdx];
      } else {
           const nextWordIdx = this.layout.words.findIndex(w => w.startTime > currentTime);
           if (nextWordIdx > 0) currentWord = this.layout.words[nextWordIdx - 1];
           else if (nextWordIdx === -1) currentWord = this.layout.words[this.layout.words.length - 1];
           else currentWord = this.layout.words[0];
      }

      if (currentWord) {
          activeLineY = currentWord.y;
          activeWords = this.layout.words.filter(w => Math.abs(w.y - activeLineY!) < 5);
           // Cursor calculation
          if (activeIdx !== -1) {
              const w = this.layout.words[activeIdx];
              const p = (currentTime - w.startTime) / (w.endTime - w.startTime);
              cursorX = w.x + w.width * p;
          } else {
              // Simplified gap logic
              const nextIdx = this.layout.words.findIndex(w => w.startTime > currentTime);
              if (nextIdx > 0) cursorX = this.layout.words[nextIdx - 1].x + this.layout.words[nextIdx - 1].width;
              else if (nextIdx === -1) {
                  const last = this.layout.words[this.layout.words.length - 1];
                  cursorX = last.x + last.width;
              }
              else cursorX = 0;
          }
      }
    }

    // 3. Rendering Strategy
    if (isActive && !hasTimedWords) {
        // CASE: Active but standard text (no timing) -> Pure White
        this.ctx.fillStyle = "#FFFFFF";
        this.layout.words.forEach(w => this.ctx.fillText(w.text, w.x, w.y));
    } 
    else if (isActive && activeLineY !== null && activeWords.length > 0) {
        // CASE: Active with Timing -> Fluid Animation
        
        // Render static inactive lines first
        this.ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
        this.layout.words.forEach(w => {
            if (Math.abs(w.y - activeLineY!) >= 5) {
                 // Past lines white, Future dim
                 if (w.y < activeLineY!) {
                     this.ctx.fillStyle = "#FFFFFF";
                     this.ctx.fillText(w.text, w.x, w.y - 4.0); // Static Lift for past lines
                 } else {
                     this.ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
                     this.ctx.fillText(w.text, w.x, w.y);
                 }
            }
        });

        // Render Active Line with Fluid Effect
        this.renderActiveFluidLine(activeWords, activeLineY, cursorX, mainFont, mainHeight);

        // Extra Glow Animation for specific words
        activeWords.forEach(w => {
             const duration = w.endTime - w.startTime;
             // Apply glow only to short words (length <= 7) that are currently playing
             if (w.text.length <= 7 && duration > 1.5) {
                 this.ctx.save();
                 this.ctx.translate(w.x, w.y);
                 
                 const elapsed = currentTime - w.startTime;
                 const isWordActive = elapsed >= 0 && elapsed < duration;
                 
                 if (isWordActive) {
                      // Calculate decay for the glow effect
                      // For simplicity, we can use the progress to determine if we are in the tail end
                      // or pass a decay factor based on word completion
                      const progress = Math.max(0, Math.min(1, elapsed / duration));
                      // Simple decay logic: fade out near the very end if needed, 
                      // but drawGlowAnimation handles "wave" decay internally via wave physics.
                      // We pass 0 as decayFactor for active words (standard state), 
                      // or calculate it if we want a fade-out.
                      // The original code passed 'decay' from breath envelope? 
                      // Let's use breath envelope for attack.
                      const decay = this.computeBreathEnvelope(progress, false, 0);
                      
                      this.drawGlowAnimation(w, elapsed, duration, decay);
                 }
                 this.ctx.restore();
             }
        });

    } else {
        // CASE: Completely Inactive Line -> Dim
        this.ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
        this.layout.words.forEach(w => this.ctx.fillText(w.text, w.x, w.y));
    }

    // 4. Translation
    if (this.layout.translationLines && this.layout.translationLines.length > 0) {
      this.ctx.font = transFont;
      this.ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
      const lastWordY = this.layout.words.length > 0
          ? this.layout.words[this.layout.words.length - 1].y
          : 0;
      let transY = lastWordY + mainHeight * 1.2;
      this.layout.translationLines.forEach((lineText) => {
        this.ctx.fillText(lineText, 0, transY);
        transY += transHeight;
      });
    }

    this.ctx.restore();
  }

  private renderActiveFluidLine(
      words: WordLayout[], 
      lineY: number, 
      cursorX: number, 
      font: string,
      mainHeight: number
  ) {
      const MAX_LIFT = -4.0;
      const SLOPE_STEEPNESS = 0.025;
      const LOOKAHEAD_PX = 40;
      const WAVE_EXTENT = 250;
      const effectiveCursor = cursorX + LOOKAHEAD_PX;
      
      const lineW = this.layout!.textWidth + 50;
      const lineH = mainHeight * 1.5;
      const pixelRatio = this.pixelRatio;
      const requiredWidth = Math.ceil(lineW * pixelRatio);
      const requiredHeight = Math.ceil(lineH * pixelRatio);

      // Invalidate cache key because we are about to overwrite the buffer with the full line
      this.cachedWordKey = "";

      // Ensure buffer size
      if (this.wordCacheCanvas.width < requiredWidth || this.wordCacheCanvas.height < requiredHeight) {
          this.wordCacheCanvas.width = Math.max(requiredWidth, this.wordCacheCanvas.width);
          this.wordCacheCanvas.height = Math.max(requiredHeight, this.wordCacheCanvas.height);
      }
      
      // Draw clean text to buffer
      this.wordCacheCtx.clearRect(0, 0, this.wordCacheCanvas.width, this.wordCacheCanvas.height);
      this.wordCacheCtx.save();
      this.wordCacheCtx.scale(pixelRatio, pixelRatio);
      this.wordCacheCtx.font = font;
      this.wordCacheCtx.textBaseline = "top";
      this.wordCacheCtx.fillStyle = "#FFFFFF";
      words.forEach(w => this.wordCacheCtx.fillText(w.text, w.x, 0));
      this.wordCacheCtx.restore();

      const waveStart = effectiveCursor - WAVE_EXTENT;
      const waveEnd = effectiveCursor + WAVE_EXTENT;
      const srcLineHeight = lineH * pixelRatio;

      // A. Past Chunk (Fully Lifted)
      if (waveStart > 0) {
          const w = Math.min(waveStart, lineW);
          this.ctx.save();
          this.ctx.drawImage(
              this.wordCacheCanvas,
              0, 0, w * pixelRatio, srcLineHeight,
              0, lineY + MAX_LIFT, w, lineH
          );
          this.ctx.restore();
      }

      // B. Wave Chunk (Sliced & Distorted)
      const startX = Math.max(0, waveStart);
      const endX = Math.min(lineW, waveEnd);
      
      if (endX > startX) {
          const SLICE_W = 2;
          let sliceStart = startX;

          while (sliceStart < endX) {
              const sliceEnd = Math.min(endX, sliceStart + SLICE_W);
              const drawW = sliceEnd - sliceStart;

              if (drawW <= 0) break;

              // Lift Calculation
              const midPoint = sliceStart + drawW / 2;
              const charDist = midPoint - effectiveCursor;
              const sigmoid = 1 / (1 + Math.exp(SLOPE_STEEPNESS * charDist));
              const lift = MAX_LIFT * sigmoid;

              // Alpha/Gradient Calculation
              const gradDist = midPoint - cursorX;
              let alpha = 1.0;
              if (gradDist >= 60) {
                  alpha = 0.5;
              } else if (gradDist > 0) {
                  alpha = 1.0 - (gradDist / 60) * 0.5;
              }

              this.ctx.globalAlpha = alpha;
              this.ctx.drawImage(
                  this.wordCacheCanvas,
                  sliceStart * pixelRatio,
                  0,
                  drawW * pixelRatio,
                  srcLineHeight,
                  sliceStart,
                  lineY + lift,
                  drawW,
                  lineH
              );

              sliceStart = sliceEnd;
          }

          this.ctx.globalAlpha = 1.0;
      }

      // C. Future Chunk (Flat, Dim)
      if (waveEnd < lineW) {
          const start = Math.max(0, waveEnd);
          const w = lineW - start;
          if (w > 0) {
              this.ctx.save();
              this.ctx.globalAlpha = 0.5;
              this.ctx.drawImage(
                  this.wordCacheCanvas,
                  start * pixelRatio, 0, w * pixelRatio, srcLineHeight,
                  start, lineY, w, lineH
              );
              this.ctx.restore();
          }
      }
  }

  private easeProgress(word: WordLayout, target: number) {
    if (word.renderProgress === undefined) {
      word.renderProgress = target;
    } else {
      // Use exponential smoothing with adaptive rate
      // Faster response when far from target, slower when close (spring-like behavior)
      const delta = target - word.renderProgress;
      const adaptiveRate = 0.15 + Math.abs(delta) * 0.2;
      word.renderProgress += delta * Math.min(adaptiveRate, 0.4);
    }
    return Math.max(0, Math.min(1, word.renderProgress));
  }

  /**
   * Compute spring-based breathing envelope using critically damped spring physics.
   */
  private computeBreathEnvelope(
    progress: number,
    isTransitioning: boolean,
    transitionProgress: number
  ): number {
    // Envelope mostly handles the "Attack" phase of the word.
    // Sustain and Release are handled by the wave and decay logic in drawGlowAnimation.
    const attackEnd = 0.2;
    if (progress < attackEnd) {
      const t = progress / attackEnd;
      // Ease out cubic for smooth entry
      return 1 - Math.pow(1 - t, 3);
    }
    return 1;
  }

  /**
   * Compute wave-based character activation using physics wave propagation.
   */
  private computeWaveActivation(
    charIndex: number,
    charCount: number,
    progress: number
  ): { activation: number; waveIntensity: number } {
    const { wavelength } = WAVE_PHYSICS;

    // Wave front position
    const waveFront =
      progress * (charCount + wavelength * 1.5) - wavelength * 0.5;

    const distFromFront = charIndex - waveFront;

    // Gaussian wave packet for intensity (flash)
    const sigma = wavelength / 2.5;
    const waveIntensity = Math.exp(
      -(distFromFront * distFromFront) / (2 * sigma * sigma)
    );

    // Activation: 1 if wave has passed (swept area)
    let activation = 0;
    if (distFromFront < -wavelength * 0.5) {
      activation = 1;
    } else if (distFromFront > wavelength) {
      activation = 0;
    } else {
      // Smooth hermite interpolation
      const t = (-distFromFront + wavelength) / (1.5 * wavelength);
      activation = Math.max(0, Math.min(1, t * t * (3 - 2 * t)));
    }

    return { activation, waveIntensity };
  }

  /**
   * Draw glow effect - single layer
   */
  private applyGlow(intensity: number, color: string = "white") {
    if (intensity < 0.01) {
      this.ctx.shadowBlur = 0;
      this.ctx.shadowColor = "transparent";
      return;
    }

    // Non-linear blur for "fluid" feel
    const blur = GLOW_CONFIG.blur * (0.4 + 0.6 * Math.pow(intensity, 0.8));
    const alpha = GLOW_CONFIG.intensity * intensity;
    this.ctx.shadowColor = `rgba(255, 255, 255, ${alpha})`;
    this.ctx.shadowBlur = blur;
  }

  private drawGlowAnimation(
    word: WordLayout,
    elapsed: number,
    duration: number,
    decayFactor: number
  ) {
    const chars = word.text.split("");

    if (chars.length === 0) return;
    const charCount = chars.length;
    const progress = Math.max(0, Math.min(1, elapsed / duration));
    const { main, mainHeight } = getFonts(this.isMobile);

    // Prepare character metrics
    if (!word.charWidths || !word.charOffsets) {
      const { charWidths, charOffsets } = this.computeCharMetrics(
        word.text,
        mainHeight
      );

      word.charWidths = charWidths;
      word.charOffsets = charOffsets;
    }

    // --- CACHING LOGIC ---
    // Render the full word once to an offscreen canvas if not already cached
    if (this.cachedWordKey !== word.text) {
      const padding = 20;
      const requiredWidth = Math.ceil(word.width * this.pixelRatio) + padding;
      const requiredHeight = Math.ceil(mainHeight * 1.5 * this.pixelRatio);

      if (
        this.wordCacheCanvas.width < requiredWidth ||
        this.wordCacheCanvas.height < requiredHeight
      ) {
        this.wordCacheCanvas.width = requiredWidth;
        this.wordCacheCanvas.height = requiredHeight;
      }

      this.wordCacheCtx.clearRect(
        0,
        0,
        this.wordCacheCanvas.width,
        this.wordCacheCanvas.height
      );
      this.wordCacheCtx.save();
      this.wordCacheCtx.scale(this.pixelRatio, this.pixelRatio);
      this.wordCacheCtx.font = main;
      this.wordCacheCtx.textBaseline = "top";
      this.wordCacheCtx.fillStyle = "#FFFFFF";
      this.wordCacheCtx.fillText(word.text, 0, 0);
      this.wordCacheCtx.restore();

      this.cachedWordKey = word.text;
    }

    // --- FLUID GRID CALCULATION ---

    const charScales: number[] = [];
    const charOpacities: number[] = [];

    let totalDynamicWidth = 0;

    // 1. Compute scales and dynamics for all characters
    chars.forEach((char, charIndex) => {
      const { activation, waveIntensity } = this.computeWaveActivation(
        charIndex,
        charCount,
        progress
      );

      // Scale Logic:
      // Base Scale = 1.0 (Both sung and unsung)
      // Peak Scale = GLOW_CONFIG.scaleBoost (At the wave front)
      const BASE_SCALE = 1.0;
      const PEAK_SCALE = GLOW_CONFIG.scaleBoost;

      // Only boost at the wave peak
      const waveBoost = (PEAK_SCALE - BASE_SCALE) * waveIntensity;
      
      const targetScale = BASE_SCALE + waveBoost;
      
      // Apply decay factor (fade out entire effect at end of word)
      // For scale, we decay back to 1.0
      const scale = 1 + (targetScale - 1) * decayFactor;

      charScales.push(scale);

      const originalWidth = word.charWidths?.[charIndex] ?? 0;
      totalDynamicWidth += originalWidth * scale;

      const opacity = 0.5 + 0.5 * activation;

      charOpacities.push(opacity);
    });

    // 2. Calculate centering offset with dynamic bias
    // The "anchor" shifts from left (0.3) to right (0.7) as progress increases
    // This makes the expansion feel like it follows the reading cursor
    const anchor = 0.5 + (progress - 0.5) * 0.5;
    const originalWordWidth = word.width;
    const widthDiff = totalDynamicWidth - originalWordWidth;
    const startXOffset = -widthDiff * anchor;

    // 3. Draw characters using cached slices

    this.ctx.clearRect(0, -mainHeight * 0.5, word.width, mainHeight * 2);

    let currentX = startXOffset;

    this.applyGlow(decayFactor);

    chars.forEach((char, charIndex) => {
      const scale = charScales[charIndex];
      const originalWidth = word.charWidths?.[charIndex] ?? 0;
      const originalOffset = word.charOffsets?.[charIndex] ?? 0;
      const dynamicWidth = originalWidth * scale;
      const opacity = charOpacities[charIndex];

      if (opacity > 0.01) {
        this.ctx.save();

        // Calculate vertical lift based on activation (float effect)
        // We re-calculate activation here or store it? Storing is better but re-calc is cheap.
        const { activation } = this.computeWaveActivation(
          charIndex,
          charCount,
          progress
        );
        const lift = -mainHeight * 0.12 * activation * decayFactor;

        // Apply opacity
        this.ctx.globalAlpha = opacity;

        // Position: Center of the dynamic slot
        const charCenterX = currentX + dynamicWidth / 2;
        const charCenterY = mainHeight / 2 + lift;

        // Translate to center, scale, translate back
        this.ctx.translate(charCenterX, charCenterY);
        this.ctx.scale(scale, scale);
        this.ctx.translate(-charCenterX, -charCenterY);

        // Draw slice from cache
        const sx = originalOffset * this.pixelRatio;
        const sy = 0;
        const sWidth = originalWidth * this.pixelRatio;
        const sHeight = this.wordCacheCanvas.height;

        if (sWidth > 0) {
          this.ctx.drawImage(
            this.wordCacheCanvas,
            sx,
            sy,
            sWidth,
            sHeight,
            currentX,
            lift, // Apply lift to Y position as well
            originalWidth,
            sHeight / this.pixelRatio
          );
        }

        this.ctx.restore();
      }

      currentX += dynamicWidth;
    });
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    this.ctx.beginPath();
    this.ctx.moveTo(x + r, y);
    this.ctx.arcTo(x + w, y, x + w, y + h, r);
    this.ctx.arcTo(x + w, y + h, x, y + h, r);
    this.ctx.arcTo(x, y + h, x, y, r);
    this.ctx.arcTo(x, y, x + w, y, r);
    this.ctx.closePath();
  }

  public measure(containerWidth: number, suggestedTranslationWidth?: number) {
    const { main, trans, mainHeight, transHeight } = getFonts(
      this.isMobile
    );

    const baseSize = this.isMobile ? 32 : 40;
    const paddingY = 18;
    const paddingX = this.isMobile ? 24 : 56;
    const maxWidth = containerWidth - paddingX * 2;

    // Reset context font for measurement
    this.ctx.font = main;
    this.ctx.textBaseline = "top";
    const lang = detectLanguage(this.lyricLine.text);

    // @ts-ignore: Intl.Segmenter

    const segmenter =
      typeof Intl !== "undefined" && Intl.Segmenter
        ? new Intl.Segmenter(lang, { granularity: "word" })
        : null;

    // Measure main text
    const {
      words,
      textWidth,
      height: lineHeight,
    } = this.measureLineText({
      line: this.lyricLine,
      segmenter,
      lang,
      maxWidth,
      baseSize,
      mainHeight,
      paddingY,
      mainFont: main,
      wrapLineGap: mainHeight * WRAPPED_LINE_GAP_RATIO,
    });

    let blockHeight = lineHeight;
    let translationLines: string[] | undefined = undefined;
    let effectiveTextWidth = textWidth;
    let translationWidth = 0;

    if (this.lyricLine.translation) {
      // Use suggested width if provided and larger than current text width, but not exceeding maxWidth
      // Otherwise use textWidth (if > 0) or maxWidth
      let translationWrapWidth = textWidth > 0 ? textWidth : maxWidth;

      if (
        suggestedTranslationWidth &&
        suggestedTranslationWidth > translationWrapWidth
      ) {
        translationWrapWidth = Math.min(
          suggestedTranslationWidth,
          maxWidth
        );
      }

      const translationResult = this.measureTranslationLines({
        translation: this.lyricLine.translation,
        maxWidth: translationWrapWidth,
        transHeight,
        transFont: trans,
      });
      translationLines = translationResult.lines;
      blockHeight += translationResult.height;
      translationWidth = Math.min(translationResult.width ?? 0, maxWidth);
      effectiveTextWidth = Math.max(effectiveTextWidth, translationWidth);
    }

    blockHeight += paddingY;
    this._height = blockHeight;

    this.layout = {
      y: 0, // Relative to this canvas
      height: blockHeight,
      words,
      fullText: this.lyricLine.text,
      translation: this.lyricLine.translation,
      translationLines,
      textWidth: Math.max(effectiveTextWidth, textWidth),
      translationWidth,
    };

    // Store logical dimensions

    this.logicalWidth = containerWidth;
    this.logicalHeight = blockHeight;

    // Set canvas physical resolution for HiDPI displays

    this.canvas.width = containerWidth * this.pixelRatio;
    this.canvas.height = blockHeight * this.pixelRatio;

    // Reset transform and scale context to match physical resolution
    this.ctx.resetTransform();
    if (this.pixelRatio !== 1) {
      this.ctx.scale(this.pixelRatio, this.pixelRatio);
    }

    this.isDirty = true;
  }

  public getTextWidth() {
    return this.layout?.textWidth || 0;
  }

  public draw(currentTime: number, isActive: boolean, isHovered: boolean) {
    if (!this.layout) return;

    const stateUnchanged =
      !isActive &&
      !this.isDirty &&
      !this.lastIsActive &&
      this.lastIsHovered === isHovered;
    if (stateUnchanged) return;

    const { main, trans, mainHeight, transHeight } = getFonts(
      this.isMobile
    );

    const paddingX = this.isMobile ? 24 : 56;
    const hasTimedWords = this.layout.words.some((w) => w.isVerbatim);

    const stateChanged =
      this.lastIsActive !== isActive || this.lastIsHovered !== isHovered;

    // Interludes need continuous redraw when active for smooth animation

    if (isActive && !hasTimedWords && !this.isDirty && !stateChanged) {
      return;
    }

    this.drawFullLine({
      currentTime,
      isActive,
      isHovered,
      hasTimedWords,
      mainFont: main,
      transFont: trans,
      mainHeight,
      transHeight,
      paddingX,
    });

    this.lastIsActive = isActive;
    this.lastIsHovered = isHovered;
    this.isDirty = false;
  }

  public getCanvas() {
    return this.canvas;
  }

  public getHeight() {
    return this._height;
  }

  public getCurrentHeight() {
    return this._height;
  }

  public getLogicalWidth() {
    return this.logicalWidth;
  }

  public getLogicalHeight() {
    return this.logicalHeight;
  }

  public isInterlude() {
    return false;
  }

  // --- Helpers ---

  private measureLineText({
    line,
    segmenter,
    lang,
    maxWidth,
    baseSize,
    mainHeight,
    paddingY,
    mainFont,
    wrapLineGap,
  }: any) {
    this.ctx.font = mainFont;

    const words: WordLayout[] = [];
    let currentLineX = 0;
    let currentLineY = paddingY;
    let maxLineWidth = 0;

    const addWord = (
      text: string,
      start: number,
      end: number,
      isVerbatim: boolean
    ) => {
      const metrics = this.ctx.measureText(text);
      let width = metrics.width;
      if (width === 0 && text.trim().length > 0) {
        width = text.length * (baseSize * 0.5);
      }

      if (currentLineX + width > maxWidth && currentLineX > 0) {
        currentLineX = 0;
        currentLineY += mainHeight + wrapLineGap;
      }

      const { charWidths, charOffsets } = this.computeCharMetrics(
        text,
        baseSize
      );

      words.push({
        text,
        x: currentLineX,
        y: currentLineY,
        width,
        startTime: start,
        endTime: end,
        isVerbatim,
        charWidths,
        charOffsets,
      });

      currentLineX += width;
      maxLineWidth = Math.max(maxLineWidth, currentLineX);
    };

    if (line.words && line.words.length > 0) {
      line.words.forEach((w: any) => {
        addWord(w.text, w.startTime, w.endTime, true);
      });
    } else if (segmenter) {
      const segments = segmenter.segment(line.text);
      for (const seg of segments) {
        addWord(seg.segment, line.time, 999999, false);
      }
    } else if (lang === "zh") {
      line.text.split("").forEach((c: string) => {
        addWord(c, line.time, 999999, false);
      });
    } else {
      const wordsArr = line.text.split(" ");
      wordsArr.forEach((word: string, index: number) => {
        addWord(word, line.time, 999999, false);
        if (index < wordsArr.length - 1) {
          addWord(" ", line.time, 999999, false);
        }
      });
    }

    return {
      words,
      textWidth: maxLineWidth,
      height: currentLineY + mainHeight,
    };
  }

  private measureTranslationLines({
    translation,
    maxWidth,
    transHeight,
    transFont,
  }: any) {
    this.ctx.font = transFont;
    const isEn = detectLanguage(translation) === "en";
    const atoms = isEn ? translation.split(" ") : translation.split("");
    const lines: string[] = [];

    let currentTransLine = "";
    let currentTransWidth = 0;
    let maxLineWidth = 0;

    atoms.forEach((atom: string, index: number) => {
      const atomText =
        isEn && index < atoms.length - 1 ? atom + " " : atom;

      const width = this.ctx.measureText(atomText).width;

      if (currentTransWidth + width > maxWidth && currentTransWidth > 0) {
        lines.push(currentTransLine);
        maxLineWidth = Math.max(maxLineWidth, currentTransWidth);
        currentTransLine = atomText;
        currentTransWidth = width;
      } else {
        currentTransLine += atomText;
        currentTransWidth += width;
      }
    });

    if (currentTransLine) {
      lines.push(currentTransLine);
      maxLineWidth = Math.max(maxLineWidth, currentTransWidth);
    }

    return {
      lines,
      height: lines.length ? lines.length * transHeight + 4 : 0,
      width: maxLineWidth,
    };
  }

  private computeCharMetrics(text: string, baseSize: number) {
    const chars = text.split("");
    const charWidths: number[] = [];
    const charOffsets: number[] = [];
    let offset = 0;

    chars.forEach((char) => {
      const width =
        this.ctx.measureText(char).width || char.length * (baseSize * 0.5);
      charWidths.push(width);
      charOffsets.push(offset);
      offset += width;
    });

    return { charWidths, charOffsets };
  }
}
