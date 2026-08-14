/**
 * 卡牌信息图 · 单格渲染（单行横排总图用）
 * 单格结构（自上而下，格内间隔 CELL_PANEL_GAP）：
 *   1. 标题块: prefix 大字 + 角色名 + 右上角官方★星行
 *   2. 头像块: thumbnail + 官方卡框 + 官方竖排★ + 官方属性图标 + 特訓前/特訓後 胶囊
 *   3. 技能条（#f1f1f1）: skillName + 换行描述（最多 MAX_DESC_LINES 行，超出省略）
 *   4. 三围块: 演出/技巧/形象 三行（标签胶囊 + 数值 + 比例色条）
 *   5. 元信息: 虚线 + ★N 属性 最大Lv res
 * 整格包在单个白圆角面板里（opacity 0.9, radius 25）。
 */
import {
  Canvas,
  type CanvasRenderingContext2D,
  type Image,
  loadImage,
} from "skia-canvas";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as S from "./style.js";
import { frameCacheName, type AssetCache } from "./assets.js";
import { roundRectPath, fillRR, drawDashedLine, wrapText } from "./draw.js";

export interface CardParameters {
  performance: number;
  technique: number;
  visual: number;
}
export interface CardSkill {
  skillName: string;
  description: string;
  simpleDescription?: string;
  duration?: number;
  skillId?: number;
}
export interface CardInfo {
  situationId: number;
  characterId: number;
  characterName?: string;
  colorCode?: string;
  rarity: number;
  attribute: string;
  prefix?: string;
  resourceSetName: string;
  maxLevel: number;
  parameters: CardParameters;
  skill: CardSkill;
}

export interface RenderOptions {
  /** thumbnail 目录路径 */
  thumbDir: string;
  /** 图片缓存（可选，批量渲染复用） */
  images?: Map<string, Image>;
}

export interface AvatarBlock {
  file: string;
  label: string;
  after: boolean;
  img: Image | null;
}

/** 单格内容布局（不含整图留白） */
export interface Layout {
  titleH: number;
  avatarH: number;
  skillH: number;
  statsH: number;
  metaH: number;
  /** 单格总高（含面板上下内边距，格间间距由外层用 CELL_GAP 拼接） */
  blockH: number;
}

/** 头像块固定高度（1 张或 2 张头像都占同样高度） */
export const AVATAR_H = S.AVATAR_SIZE + S.AVATAR_LABEL_GAP + S.AVATAR_LABEL_H;

/* ---------- 测量用 ctx（1×1 即可 measureText） ---------- */
const _mctx = new Canvas(1, 1).getContext("2d");

/** 格内容区宽度 */
const INNER_W = S.CELL_W - S.PAD.panelX * 2;

async function getImage(
  cache: Map<string, Image> | undefined,
  file: string,
): Promise<Image | null> {
  if (!existsSync(file)) return null;
  if (cache?.has(file)) return cache.get(file)!;
  const img = await loadImage(file);
  cache?.set(file, img);
  return img;
}

/* ---------- 通用小工具 ---------- */

function attrColor(attr: string): string {
  return S.ATTR_COLORS[attr] ?? S.ATTR_FALLBACK;
}

function starCount(rarity: number): number {
  return Math.max(1, Math.min(rarity || 1, 6));
}

/** 自动换行 + 行数上限（超出最后一行加省略号） */
function wrapCapped(text: string, maxWidth: number, maxLines: number): string[] {
  const lines = wrapText(_mctx, text, maxWidth);
  if (lines.length <= maxLines) return lines;
  const out = lines.slice(0, maxLines);
  let last = out[maxLines - 1];
  while (last.length > 0 && _mctx.measureText(last + "…").width > maxWidth) {
    last = last.slice(0, -1);
  }
  out[maxLines - 1] = last + "…";
  return out;
}

/* ---------- 布局计算 ---------- */

function measureTitle(card: CardInfo): {
  h: number;
  lines: string[];
  nameLines: string[];
  starRowW: number;
} {
  const n = starCount(card.rarity);
  const starRowW = n * S.TITLE_STAR + (n - 1) * 4;
  _mctx.font = S.FONT.title;
  const lines = wrapCapped(card.prefix ?? "", INNER_W - starRowW - 8, 2);
  _mctx.font = S.FONT.name;
  const nameLines = wrapCapped(card.characterName ?? "", INNER_W, 1);
  const h = lines.length * S.LH.title + 6 + nameLines.length * S.LH.name;
  return { h, lines, nameLines, starRowW };
}

function measureSkill(card: CardInfo): { h: number; skillLines: string[]; descLines: string[] } {
  const innerW = INNER_W - S.PAD.skillX * 2;
  _mctx.font = S.FONT.skillName;
  const skillLines = wrapCapped(card.skill.skillName ?? "", innerW, 2);
  _mctx.font = S.FONT.body;
  const descLines = wrapCapped(card.skill.description ?? "", innerW, S.MAX_DESC_LINES);
  const h =
    S.PAD.skillY * 2 +
    skillLines.length * S.LH.skillName +
    6 +
    descLines.length * S.LH.body;
  return { h, skillLines, descLines };
}

/** 计算单格总高（面板内上下内边距 + 各区块 + 格内间隔） */
export function computeCellLayout(card: CardInfo): Layout {
  const titleH = measureTitle(card).h;
  const avatarH = AVATAR_H;
  const skillH = measureSkill(card).h;
  const statsH = S.PAD.statsY * 2 + 3 * S.STATS_ROW_H + 2 * S.STATS_ROW_GAP;
  const metaH = 2 + 10 + S.LH.meta;
  const blockH =
    S.PAD.panelY * 2 +
    titleH +
    S.CELL_PANEL_GAP +
    avatarH +
    S.CELL_PANEL_GAP +
    skillH +
    S.CELL_PANEL_GAP +
    statsH +
    S.CELL_PANEL_GAP +
    metaH;
  return { titleH, avatarH, skillH, statsH, metaH, blockH };
}

/* ---------- 区块绘制 ---------- */

function panelShadow(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.10)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
}

/** 标题块：星行（右上）+ prefix + 角色名 */
function drawTitleBlock(
  ctx: CanvasRenderingContext2D,
  card: CardInfo,
  cx: number,
  y: number,
  assets: AssetCache,
): void {
  const { lines, nameLines, starRowW } = measureTitle(card);
  const innerX = cx + S.PAD.panelX;

  // 右上角官方★星行
  const n = starCount(card.rarity);
  if (assets.star) {
    const starX = cx + S.CELL_W - S.PAD.panelX - starRowW;
    for (let k = 0; k < n; k++) {
      ctx.drawImage(
        assets.star,
        starX + k * (S.TITLE_STAR + 4),
        y,
        S.TITLE_STAR,
        S.TITLE_STAR,
      );
    }
  }

  // prefix 大字
  ctx.font = S.FONT.title;
  ctx.fillStyle = S.TEXT_MAIN;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  lines.forEach((ln, i) => {
    ctx.fillText(ln, innerX, y + i * S.LH.title);
  });

  // 角色名
  ctx.font = S.FONT.name;
  ctx.fillStyle = S.TEXT_SUB;
  nameLines.forEach((ln, i) => {
    ctx.fillText(ln, innerX, y + lines.length * S.LH.title + 6 + i * S.LH.name);
  });
}

/** 头像块：居中排布，每张 = 立绘 + 官方卡框 + 官方星 + 官方属性图标 + 下方胶囊 */
function drawAvatarBlock(
  ctx: CanvasRenderingContext2D,
  card: CardInfo,
  cx: number,
  y: number,
  blocks: AvatarBlock[],
  assets: AssetCache,
): void {
  const innerW = blocks.length * S.AVATAR_SIZE + (blocks.length - 1) * S.AVATAR_GAP;
  const startX = cx + (S.CELL_W - innerW) / 2;
  blocks.forEach((blk, i) => {
    const ax = startX + i * (S.AVATAR_SIZE + S.AVATAR_GAP);
    drawAvatar(ctx, card, ax, y, blk, assets);
  });
}

/**
 * 单个头像（AVATAR_SIZE 见方），官方素材叠加（tsugu drawCardIcon 参数按比例缩放）：
 *   1. thumbnail 立绘
 *   2. 官方卡框（Bestdori PNG，全幅叠加）
 *   3. 官方星星（star.png / star_trained.png，自下而上竖排）
 *   4. 官方属性图标（右上角；失败降级为属性色圆点）
 */
function drawAvatar(
  ctx: CanvasRenderingContext2D,
  card: CardInfo,
  x: number,
  y: number,
  blk: AvatarBlock,
  assets: AssetCache,
): void {
  const k = S.AVATAR_SIZE / 180; // 官方素材坐标按 180 基准等比缩放

  // 1) thumbnail 立绘
  if (blk.img) {
    ctx.drawImage(blk.img, x, y, S.AVATAR_SIZE, S.AVATAR_SIZE);
  } else {
    ctx.fillStyle = "#e8e2da";
    ctx.fillRect(x, y, S.AVATAR_SIZE, S.AVATAR_SIZE);
  }

  // 2) 官方卡框
  const frame = assets.frames.get(frameCacheName(card.rarity, card.attribute));
  if (frame) {
    ctx.drawImage(frame, x, y, S.AVATAR_SIZE, S.AVATAR_SIZE);
  }

  // 3) 官方星星（tsugu: 每颗 26/180×S、x=4/180×S 起、第一颗 y=150/180×S 向上叠）
  const star = blk.after ? assets.starTrained : assets.star;
  if (star) {
    const starSize = 26 * k;
    const starX = 4 * k;
    const starY0 = 150 * k;
    const n = starCount(card.rarity);
    for (let s = 0; s < n; s++) {
      ctx.drawImage(star, x + starX, y + (starY0 - starSize * s), starSize, starSize);
    }
  }

  // 4) 官方属性图标（右上角；tsugu 位置 (132.5,3) 45×45 等比缩放）
  const icon = assets.icons.get(card.attribute);
  if (icon) {
    const iconSize = 45 * k;
    const iconX = 132.5 * k;
    const iconY = 3 * k;
    ctx.drawImage(icon, x + iconX, y + iconY, iconSize, iconSize);
  } else {
    const cx = x + 155 * k;
    const cy = y + 25.5 * k;
    ctx.save();
    ctx.fillStyle = attrColor(card.attribute);
    ctx.beginPath();
    ctx.arc(cx, cy, 18 * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 5) 下方 特訓前/特訓後 胶囊
  _mctx.font = S.FONT.label;
  const labelW = Math.max(76, _mctx.measureText(blk.label).width + 28);
  const lx = x + (S.AVATAR_SIZE - labelW) / 2;
  const ly = y + S.AVATAR_SIZE + S.AVATAR_LABEL_GAP;
  fillRR(ctx, lx, ly, labelW, S.AVATAR_LABEL_H, S.AVATAR_LABEL_H / 2, S.LABEL_BG);
  ctx.save();
  ctx.font = S.FONT.label;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(blk.label, lx + labelW / 2, ly + S.AVATAR_LABEL_H / 2 + 1);
  ctx.restore();
}

/** 技能条：#f1f1f1 横条 + skillName + 描述（最多 4 行） */
function drawSkillBar(
  ctx: CanvasRenderingContext2D,
  card: CardInfo,
  cx: number,
  y: number,
  skillH: number,
): void {
  const px = cx + S.PAD.panelX;
  const pw = S.CELL_W - S.PAD.panelX * 2;
  fillRR(ctx, px, y, pw, skillH, S.SKILL_RADIUS, S.SKILL_BG);

  const innerX = px + S.PAD.skillX;
  const innerTop = y + S.PAD.skillY;
  const innerW = pw - S.PAD.skillX * 2;

  _mctx.font = S.FONT.skillName;
  const skillLines = wrapCapped(card.skill.skillName ?? "", innerW, 2);
  ctx.font = S.FONT.skillName;
  ctx.fillStyle = S.TEXT_MAIN;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  skillLines.forEach((ln, i) => {
    ctx.fillText(ln, innerX, innerTop + i * S.LH.skillName);
  });

  _mctx.font = S.FONT.body;
  const descLines = wrapCapped(card.skill.description ?? "", innerW, S.MAX_DESC_LINES);
  ctx.font = S.FONT.body;
  ctx.fillStyle = S.TEXT_MAIN;
  descLines.forEach((ln, i) => {
    ctx.fillText(
      ln,
      innerX,
      innerTop + skillLines.length * S.LH.skillName + 10 + i * S.LH.body,
    );
  });
}

/** 三围块：三行（标签胶囊 92×30 + 数值 + 比例色条 16px） */
function drawStatsBlock(
  ctx: CanvasRenderingContext2D,
  card: CardInfo,
  cx: number,
  y: number,
  maxVal: number,
): void {
  const px = cx + S.PAD.statsX;
  const panelRight = cx + S.CELL_W - S.PAD.statsX;
  const rowTop = y + S.PAD.statsY;
  const rowStep = S.STATS_ROW_H + S.STATS_ROW_GAP;

  S.PARAM_DEFS.forEach((def, i) => {
    const ry = rowTop + i * rowStep;
    const value = card.parameters[def.key] ?? 0;
    const ratio = maxVal > 0 ? Math.min(1, value / maxVal) : 0;

    // 标签胶囊
    fillRR(ctx, px, ry, 92, S.STATS_ROW_H, S.STATS_ROW_H / 2, S.LABEL_BG);
    ctx.save();
    ctx.font = S.FONT.label;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(def.label, px + 46, ry + S.STATS_ROW_H / 2 + 1);
    ctx.restore();

    // 数值（右侧，三围色）
    const valueStr = value.toLocaleString("en-US");
    ctx.font = S.FONT.statValue;
    const valueW = ctx.measureText(valueStr).width;
    ctx.fillStyle = def.color;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(valueStr, panelRight, ry + S.STATS_ROW_H / 2 + 1);

    // 比例条（16px 高）
    const barX = px + 92 + 16;
    const barW = panelRight - valueW - 16 - barX;
    const barY = ry + (S.STATS_ROW_H - 16) / 2;
    fillRR(ctx, barX, barY, barW, 16, 8, "#ececea");
    if (ratio > 0) {
      fillRR(ctx, barX, barY, Math.max(8, barW * ratio), 16, 8, def.color);
    }
  });
}

/** 元信息行：虚线分隔 + ★N 属性 最大Lv res */
function drawMetaLine(
  ctx: CanvasRenderingContext2D,
  card: CardInfo,
  cx: number,
  y: number,
): void {
  drawDashedLine(
    ctx,
    cx + S.PAD.panelX,
    y,
    cx + S.CELL_W - S.PAD.panelX,
    y,
    S.DASH_COLOR,
    1.5,
  );

  const ty = y + 2 + 8;
  ctx.font = S.FONT.meta;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  const segments: Array<{ text: string; color: string }> = [
    { text: `★${card.rarity}`, color: "#c9a32a" },
    { text: `  ${card.attribute}  `, color: attrColor(card.attribute) },
    { text: `· 最大Lv${card.maxLevel}`, color: S.TEXT_SUB },
    { text: `  ·  ${card.resourceSetName}`, color: S.TEXT_SUB },
  ];

  let tcx = cx + S.PAD.panelX;
  for (const seg of segments) {
    ctx.fillStyle = seg.color;
    ctx.fillText(seg.text, tcx, ty);
    tcx += ctx.measureText(seg.text).width;
  }
}

/* ---------- 渲染入口 ---------- */

/**
 * 解析一张卡的头像块（normal / after_training）。
 * - 两张头像都缺失：打印警告并返回 null（调用方跳过该卡，不崩溃）
 * - 缺 after_training：仅绘制普通态并提示
 */
export async function resolveAvatarBlocks(
  card: CardInfo,
  opts: RenderOptions,
): Promise<AvatarBlock[] | null> {
  const base = join(opts.thumbDir, card.resourceSetName);
  const normalFile = `${base}_normal.png`;
  const afterFile = `${base}_after_training.png`;

  const normalImg = await getImage(opts.images, normalFile);
  const afterImg = await getImage(opts.images, afterFile);

  if (!normalImg && !afterImg) {
    console.warn(
      `  [警告] ${card.resourceSetName} 缺少 normal 与 after_training 头像，跳过整张卡`,
    );
    return null;
  }
  if (normalImg && !afterImg) {
    console.warn(
      `  [提示] ${card.resourceSetName} 缺少 after_training 头像，仅绘制普通态`,
    );
  }

  const blocks: AvatarBlock[] = [
    { file: normalFile, label: "特訓前", after: false, img: normalImg },
  ];
  if (afterImg) {
    blocks.push({ file: afterFile, label: "特訓後", after: true, img: afterImg });
  }
  return blocks;
}

/**
 * 绘制一个完整单格（白圆角面板 + 标题→头像→技能→三围→元信息）。
 * (cx, cy) 为格子左上角；返回单格高度（= computeCellLayout().blockH）。
 */
export function drawCardCell(
  ctx: CanvasRenderingContext2D,
  card: CardInfo,
  blocks: AvatarBlock[],
  cx: number,
  cy: number,
  maxVal: number,
  assets: AssetCache,
): number {
  const layout = computeCellLayout(card);

  // 白圆角面板
  const path = roundRectPath(ctx, cx, cy, S.CELL_W, layout.blockH, S.PANEL_RADIUS);
  panelShadow(ctx);
  ctx.fillStyle = S.PANEL_FILL;
  ctx.fill(path);
  ctx.restore();
  ctx.strokeStyle = S.PANEL_STROKE;
  ctx.lineWidth = 1.5;
  ctx.stroke(path);

  let y = cy + S.PAD.panelY;
  drawTitleBlock(ctx, card, cx, y, assets);
  y += layout.titleH + S.CELL_PANEL_GAP;
  drawAvatarBlock(ctx, card, cx, y, blocks, assets);
  y += layout.avatarH + S.CELL_PANEL_GAP;
  drawSkillBar(ctx, card, cx, y, layout.skillH);
  y += layout.skillH + S.CELL_PANEL_GAP;
  drawStatsBlock(ctx, card, cx, y, maxVal);
  y += layout.statsH + S.CELL_PANEL_GAP;
  drawMetaLine(ctx, card, cx, y);

  return layout.blockH;
}
