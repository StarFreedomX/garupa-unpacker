/**
 * 卡牌信息图 · 绘制原语
 * 圆角矩形 / 星形 / 虚线 / 文字自动换行等公共工具。
 */
import type { CanvasRenderingContext2D } from "skia-canvas";
import { Path2D } from "skia-canvas";

/** 构造圆角矩形路径（radius 自动收敛到不超过边长一半） */
export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): Path2D {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const p = new Path2D();
  p.moveTo(x + rr, y);
  p.lineTo(x + w - rr, y);
  p.arcTo(x + w, y, x + w, y + rr, rr);
  p.lineTo(x + w, y + h - rr);
  p.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  p.lineTo(x + rr, y + h);
  p.arcTo(x, y + h, x, y + h - rr, rr);
  p.lineTo(x, y + rr);
  p.arcTo(x, y, x + rr, y, rr);
  p.closePath();
  return p;
}

/** 填充圆角矩形 */
export function fillRR(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string | CanvasGradient,
): void {
  ctx.fillStyle = fill;
  ctx.fill(roundRectPath(ctx, x, y, w, h, r));
}

/** 描边圆角矩形 */
export function strokeRR(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  stroke: string,
  lineWidth = 1.5,
): void {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.stroke(roundRectPath(ctx, x, y, w, h, r));
}

/** 五角星（尖朝上）。fill 主色，stroke 可选描边用于从图片上分离。 */
export function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  fill: string,
  stroke?: string,
  strokeWidth = 1.2,
): void {
  const inner = r * 0.45;
  ctx.beginPath();
  for (let k = 0; k < 5; k++) {
    const outer = -Math.PI / 2 + (k * 2 * Math.PI) / 5;
    const innerA = outer + Math.PI / 5;
    const ox = cx + r * Math.cos(outer);
    const oy = cy + r * Math.sin(outer);
    const ix = cx + inner * Math.cos(innerA);
    const iy = cy + inner * Math.sin(innerA);
    if (k === 0) ctx.moveTo(ox, oy);
    else ctx.lineTo(ox, oy);
    ctx.lineTo(ix, iy);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;
    ctx.stroke();
  }
}

/** 竖排星星（从底边向上叠放），模拟 tsugu 左下角竖排星。 */
export function drawStarColumn(
  ctx: CanvasRenderingContext2D,
  bx: number,
  by: number,
  count: number,
  size: number,
  opts: { fill: string; stroke?: string; strokeWidth?: number; gap?: number },
): void {
  const n = Math.max(1, Math.min(count, 6));
  const gap = opts.gap ?? 2;
  for (let k = 0; k < n; k++) {
    const cx = bx + size / 2;
    const cy = by - size / 2 - k * (size + gap);
    drawStar(ctx, cx, cy, size / 2, opts.fill, opts.stroke, opts.strokeWidth);
  }
}

/** 横排星星（标题右上角稀有度标识用） */
export function drawStarRow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  count: number,
  size: number,
  opts: { fill: string; stroke?: string; strokeWidth?: number; gap?: number },
): number {
  const n = Math.max(1, Math.min(count, 6));
  const gap = opts.gap ?? 4;
  for (let k = 0; k < n; k++) {
    const cx = x + size / 2 + k * (size + gap);
    const cy = y + size / 2;
    drawStar(ctx, cx, cy, size / 2, opts.fill, opts.stroke, opts.strokeWidth);
  }
  return n * size + (n - 1) * gap;
}

/** 虚线分隔线 */
export function drawDashedLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width = 2,
  dash: number[] = [12, 10],
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

/**
 * 文本自动换行：先按 \n 拆行，再按 maxWidth 贪心断行。
 * 日文/中文按字符断；英文单词尽量在空格处断。
 * 调用前需先设置 ctx.font。
 */
export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  const sources = text.split("\n");
  for (const raw of sources) {
    if (raw.length === 0) {
      out.push("");
      continue;
    }
    let cur = "";
    for (const ch of raw) {
      const next = cur + ch;
      if (ctx.measureText(next).width <= maxWidth) {
        cur = next;
        continue;
      }
      // 超宽：优先在最近空格处断（利于英文），否则按字符断
      const sp = cur.lastIndexOf(" ");
      if (sp > 0) {
        out.push(cur.slice(0, sp));
        cur = cur.slice(sp + 1) + ch;
      } else {
        out.push(cur);
        cur = ch;
      }
    }
    if (cur.length > 0) out.push(cur);
  }
  return out;
}
