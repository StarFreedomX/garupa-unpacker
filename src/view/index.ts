/**
 * 卡牌总览图 CLI（单张总图 · 2 列网格）
 * 用法:
 *   npx tsx src/view/index.ts            # 自动扫描 assets/*-preview/ 里最新的一个
 *   npx tsx src/view/index.ts <版本>      # 指定 preview 目录（可带/不带 -preview 后缀）
 *
 * 流程: 读取 info.json + thumbnail/，把全部卡片按 2 列网格渲染到
 *       <版本>/view/overview.png（覆盖写）。
 * 总图结构:
 *   标题栏（dataVersion + 渲染时间 + 「全 N 张」胶囊 + 底部装饰条）横跨顶部
 *   N 个单格（标题→头像→技能→三围→元信息）每行 2 张、行内左→右、行间换行
 *   最后一行奇数卡水平居中；所有格子等高（取最大 cellH）
 *   上下留白
 * 总宽固定 = 2×800 + 列距 + 边距（约 1668，不随卡数变宽）；
 * 总高 = 留白 + 标题栏 + 行数×单格高 + (行数-1)×行距 + 留白。
 */
import {
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas } from "skia-canvas";
import {
  computeCellLayout,
  drawCardCell,
  resolveAvatarBlocks,
  type AvatarBlock,
  type CardInfo,
  type Layout,
} from "./card.js";
import { roundRectPath, fillRR } from "./draw.js";
import { prefetchAssets, type AssetCache } from "./assets.js";
import * as S from "./style.js";

const ROOT = "assets";

/** 列出全部 *-preview 目录（按版本号数字从新到旧排序） */
function listPreviewDirs(): string[] {
  const dirs = readdirSync(ROOT).filter((d) => d.endsWith("-preview"));
  if (dirs.length === 0) {
    throw new Error(`在 ${ROOT}/ 下没有找到任何 *-preview 目录`);
  }
  const toNums = (d: string): number[] =>
    d.replace(/-preview$/, "").split(".").map((s) => Number(s) || 0);
  dirs.sort((a, b) => {
    const va = toNums(a);
    const vb = toNums(b);
    const len = Math.max(va.length, vb.length);
    for (let i = 0; i < len; i++) {
      const x = va[i] ?? 0;
      const y = vb[i] ?? 0;
      if (x !== y) return y - x; // 从新到旧
    }
    return 0;
  });
  return dirs.map((d) => join(ROOT, d));
}

/* ---------- 标题栏 ---------- */

/**
 * 绘制总览标题栏（白色圆角面板，横跨整幅宽）：
 *   主行 = dataVersion 大字 + 右上「全 N 张」金色胶囊
 *   副行 = 渲染日期时间
 *   底部 = 暖金渐变装饰条
 */
function drawHeader(
  ctx: import("skia-canvas").CanvasRenderingContext2D,
  width: number,
  dataVersion: string,
  count: number,
  y: number,
): number {
  const h = S.HEADER_H;
  const px = S.HEADER_PAD_X;
  const pw = width - S.HEADER_PAD_X * 2;

  // 面板
  const path = roundRectPath(ctx, px, y, pw, h, S.PANEL_RADIUS);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.12)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 5;
  ctx.fillStyle = S.PANEL_FILL;
  ctx.fill(path);
  ctx.restore();
  ctx.strokeStyle = S.PANEL_STROKE;
  ctx.lineWidth = 1.5;
  ctx.stroke(path);

  const innerX = px + S.HEADER_PAD_X;
  const innerTop = y + S.HEADER_PAD_Y;

  // 右上：全 N 张 金色胶囊
  const chipText = `全 ${count} 张`;
  ctx.font = S.FONT.headerSub;
  const chipW = ctx.measureText(chipText).width + 40;
  const chipH = 42;
  const chipX = px + pw - S.HEADER_PAD_X - chipW;
  const chipY = innerTop + Math.max(0, (S.LH.headerTitle - chipH) / 2);
  fillRR(ctx, chipX, chipY, chipW, chipH, chipH / 2, S.HEADER_CHIP_BG);
  ctx.save();
  ctx.font = S.FONT.headerSub;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(chipText, chipX + chipW / 2, chipY + chipH / 2 + 1);
  ctx.restore();

  // 主行：dataVersion
  ctx.font = S.FONT.headerTitle;
  ctx.fillStyle = S.TEXT_MAIN;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(dataVersion || "unknown", innerX, innerTop);

  // 副行：渲染时间
  const now = new Date();
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}/${p2(now.getMonth() + 1)}/${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
  ctx.font = S.FONT.headerSub;
  ctx.fillStyle = S.TEXT_SUB;
  ctx.fillText(`渲染于 ${ts}`, innerX, innerTop + S.LH.headerTitle + 8);

  // 底部装饰条（暖金渐变）
  const bar = ctx.createLinearGradient(
    px + S.HEADER_PAD_X,
    0,
    px + pw - S.HEADER_PAD_X,
    0,
  );
  bar.addColorStop(0, S.HEADER_BAR[0]);
  bar.addColorStop(0.5, S.HEADER_BAR[1]);
  bar.addColorStop(1, S.HEADER_BAR[2]);
  fillRR(ctx, px + S.HEADER_PAD_X, y + h - 10, pw - S.HEADER_PAD_X * 2, 4, 2, bar);

  return h;
}

/** 整图背景：暖米色 + 极浅点阵纹理 */
function drawBackground(
  ctx: import("skia-canvas").CanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  ctx.fillStyle = S.BG_COLOR;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.fillStyle = "rgba(180,120,90,0.05)";
  for (let gx = 20; gx < w; gx += 36) {
    for (let gy = 20; gy < h; gy += 36) {
      ctx.beginPath();
      ctx.arc(gx, gy, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

async function resolvePreviewDirectory(): Promise<string | null> {
  const arg = process.argv[2];
  const candidates: string[] = [];
  if (arg) {
    const name = arg.endsWith("-preview") ? arg : `${arg}-preview`;
    const full = join(ROOT, name);
    if (!existsSync(full)) throw new Error(`未找到 preview 目录: ${full}`);
    candidates.push(full);
  } else {
    candidates.push(...listPreviewDirs());
  }

  for (const cand of candidates) {
    const infoPath = join(cand, "info.json");
    if (!existsSync(infoPath)) continue;
    const parsed = JSON.parse(readFileSync(infoPath, "utf8")) as {
      dataVersion?: string;
      cards?: CardInfo[];
    };
    if ((parsed.cards ?? []).length === 0) {
      console.log(`[提示] ${cand} 的 info.json 中没有卡片，跳过`);
      continue;
    }
    return cand;
  }
  return null;
}

/**
 * 从已解包目录直接渲染总览图。常驻服务调用本函数，不会执行 quick 解包或再次下载 bundle。
 * @returns 生成的 overview.png 路径；没有可渲染卡片时返回 null。
 */
export async function renderOverviewDirectory(dir: string): Promise<string | null> {
  const infoPath = join(dir, "info.json");
  if (!existsSync(infoPath)) throw new Error(`未找到 ${infoPath}`);
  const info = JSON.parse(readFileSync(infoPath, "utf8")) as {
    dataVersion?: string;
    cards?: CardInfo[];
  };
  if ((info.cards ?? []).length === 0) {
    console.log("没有找到包含卡片的 preview 目录，退出。");
    return null;
  }
  console.log(`→ 使用 preview 目录: ${dir}`);

  const allCards = info.cards ?? [];

  const thumbDir = join(dir, "thumbnail");
  const viewDir = join(dir, "view");
  const images = new Map<string, import("skia-canvas").Image>();

  // 1) 加载头像（缺头像的卡跳过，不中断全图）
  const entries: Array<{
    card: CardInfo;
    blocks: AvatarBlock[];
    layout: Layout;
  }> = [];
  for (let i = 0; i < allCards.length; i++) {
    const card = allCards[i];
    process.stdout.write(`加载 ${i + 1}/${allCards.length} ${card.resourceSetName} `);
    const blocks = await resolveAvatarBlocks(card, { thumbDir, images });
    if (!blocks) {
      console.log("→ 跳过（无可用头像）");
      continue;
    }
    entries.push({
      card,
      blocks,
      layout: computeCellLayout(card),
    });
    console.log("✓");
  }
  if (entries.length === 0) {
    console.log("没有任何可渲染的卡，退出。");
    return null;
  }

  // 三围条基准：取全卡最大值，保证跨卡可比较
  const globalMax = Math.max(
    ...entries.flatMap((e) => [
      e.card.parameters?.performance ?? 0,
      e.card.parameters?.technique ?? 0,
      e.card.parameters?.visual ?? 0,
    ]),
  );

  // 1.5) 预取官方素材（卡框 / 属性图标 / 星星），一次并行下载后磁盘缓存
  const rarities = [...new Set(entries.map((e) => e.card.rarity))];
  const attributes = [...new Set(entries.map((e) => e.card.attribute))];
  console.log(
    `[素材] 预取需求：稀有度 ${rarities.join(",")} / 属性 ${attributes.join(",")}`,
  );
  const assets: AssetCache = await prefetchAssets(rarities, attributes);

  // 2) 2 列网格布局：宽固定 = 2×800 + 列距 + 边距（不随卡数变宽）；所有格子等高
  const n = entries.length;
  const COLS = 2;
  const rows = Math.ceil(n / COLS);
  const canvasW =
    COLS * S.CELL_W + (COLS - 1) * S.CELL_GAP + S.CELL_MARGIN * 2;
  const cellH = Math.max(...entries.map((e) => e.layout.blockH));
  const headerH = S.HEADER_H;
  const totalH =
    S.TOP_PAD +
    headerH +
    S.CELL_GAP +
    rows * cellH +
    (rows - 1) * S.ROW_GAP +
    S.BOTTOM_PAD;

  // 3) 一次性渲染整图
  const canvas = new Canvas(canvasW, totalH);
  const ctx = canvas.getContext("2d");
  drawBackground(ctx, canvasW, totalH);

  // 标题栏（横跨顶部）
  drawHeader(ctx, canvasW, info.dataVersion ?? "", n, S.TOP_PAD);
  const cellTop = S.TOP_PAD + headerH + S.CELL_GAP;

  // 卡片格子（2 列网格：行 r = floor(i/2)，列 c = i%2）
  const lastRowCount = n - (rows - 1) * COLS; // 最后一行卡片数
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const { card, blocks } = entries[i];
    const r = Math.floor(i / COLS);
    const c = i % COLS;
    let cx = S.CELL_MARGIN + c * (S.CELL_W + S.CELL_GAP);
    // 最后一行只有 1 张（奇数总数）时水平居中
    if (r === rows - 1 && lastRowCount === 1) {
      cx = (canvasW - S.CELL_W) / 2;
    }
    const cy = cellTop + r * (cellH + S.ROW_GAP);
    process.stdout.write(`渲染 ${i + 1}/${n} ${card.resourceSetName} `);
    try {
      drawCardCell(ctx, card, blocks, cx, cy, globalMax, assets);
      console.log("✓");
      ok++;
    } catch (err) {
      console.log(`→ 失败: ${(err as Error).message}`);
    }
  }

  // 4) 清理历史逐卡 PNG，输出单张总图（覆盖）
  mkdirSync(viewDir, { recursive: true });
  if (existsSync(viewDir)) {
    for (const f of readdirSync(viewDir)) {
      if (f.endsWith(".png") && f !== "overview.png") {
        rmSync(join(viewDir, f), { force: true });
        console.log(`清理旧单卡图: ${f}`);
      }
    }
  }
  const outPath = join(viewDir, "overview.png");
  writeFileSync(outPath, await canvas.toBuffer("png"));

  console.log(
    `\n完成：总图 ${canvasW}×${totalH}px（2 列 × ${rows} 行，每格 ${S.CELL_W}×${cellH}），渲染 ${ok}/${n} 张卡 → ${outPath}`,
  );
  return outPath;
}

async function main(): Promise<void> {
  const dir = await resolvePreviewDirectory();
  if (!dir) {
    console.log("没有找到包含卡片的 preview 目录，退出。");
    return;
  }
  await renderOverviewDirectory(dir);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[view] ${(err as Error).message}`);
    process.exit(1);
  });
}
