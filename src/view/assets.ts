/**
 * 官方素材加载 + 磁盘缓存（assets/view/cache/）
 *
 * - 卡框：Bestdori CDN PNG
 *     1星按属性分色: /res/image/card-1-<attribute>.png
 *     2-6星按稀有度: /res/image/card-<rarity>.png
 * - 属性图标：Bestdori CDN SVG → svg2img 转 PNG
 *     /res/icon/<attribute>.svg
 * - 星星：Bestdori CDN PNG
 *     /res/icon/star.png / star_trained.png
 *
 * 所有远端素材落盘缓存到 assets/view/cache/，二次运行命中缓存直接读取。
 * 网络失败降级：卡框 → 不叠加（返回 null，调用方跳过）；图标 → 属性色圆点（返回 null）。
 */
import { networkGet } from "../network.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadImage, type Image } from "skia-canvas";
import svg2imgDefault from "svg2img";

// svg2img 是 CJS（module.exports = fn），其 d.ts 却声明为 export default，
// NodeNext 下默认导入会落成命名空间对象；运行时拿到的就是函数本身，这里窄化类型。
const svg2img = svg2imgDefault as unknown as (
  svg: string,
  callback: (err: Error | null, png: Buffer) => void,
) => void;

const CDN = "https://bestdori.com/res/";
const UA = "Mozilla/5.0";
const CACHE_DIR = join("assets", "view", "cache");

/** 卡框缓存文件名（1星按属性，2-6星按稀有度） */
export function frameCacheName(rarity: number, attribute: string): string {
  if (rarity <= 1) return `card-1-${attribute}.png`;
  return `card-${Math.max(2, Math.min(rarity, 6))}.png`;
}

function frameUrl(rarity: number, attribute: string): string {
  if (rarity <= 1) return `${CDN}image/card-1-${attribute}.png`;
  return `${CDN}image/card-${Math.max(2, Math.min(rarity, 6))}.png`;
}

function iconCacheName(attribute: string): string {
  return `icon-${attribute}.png`;
}

function iconUrl(attribute: string): string {
  return `${CDN}icon/${attribute}.svg`;
}

type StarIconName = "star" | "star_trained";

function starUrl(name: StarIconName): string {
  return `${CDN}icon/${name}.png`;
}

function ensureCacheDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
}

/** 拉取字节（UA=Mozilla/5.0） */
async function fetchBytes(url: string): Promise<Buffer> {
  const res = await networkGet(url, {
    responseType: "arraybuffer",
    headers: { "User-Agent": UA },
    timeout: 20000,
  });
  return Buffer.from(res.data);
}

/**
 * 有缓存读缓存，否则执行 load()；先验证字节可解码为图片，成功后再落盘，
 * 避免 404 错误页等无效字节污染缓存。
 */
async function cachedLoad(
  file: string,
  label: string,
  load: () => Promise<Buffer>,
): Promise<Image> {
  if (existsSync(file)) {
    console.log(`  [素材] 缓存命中 ${label}`);
    return loadImage(readFileSync(file));
  }
  console.log(`  [素材] 下载 ${label}`);
  const buf = await load();
  const img = await loadImage(buf); // 校验：解码失败会抛错，不会写入缓存
  writeFileSync(file, buf);
  return img;
}

/** svg2img（回调式 → Promise） */
function svgToPng(svg: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    svg2img(svg, (err, png) => (err ? reject(err) : resolve(png)));
  });
}

/**
 * 获取官方卡框。下载失败时打印警告并返回 null（调用方不叠加卡框）。
 */
export async function getCardFrame(
  rarity: number,
  attribute: string,
): Promise<Image | null> {
  const name = frameCacheName(rarity, attribute);
  try {
    return await cachedLoad(join(CACHE_DIR, name), `卡框 ${name}`, () =>
      fetchBytes(frameUrl(rarity, attribute)),
    );
  } catch (err) {
    console.warn(
      `  [警告] 卡框 ${name} 下载失败: ${(err as Error).message}，本次不叠加卡框`,
    );
    return null;
  }
}

/**
 * 获取官方属性图标。下载 / SVG 转换失败时打印警告并返回 null
 * （调用方用属性色圆点降级）。
 */
export async function getAttributeIcon(attribute: string): Promise<Image | null> {
  const name = iconCacheName(attribute);
  try {
    return await cachedLoad(join(CACHE_DIR, name), `属性图标 ${name}`, async () => {
      const svg = await fetchBytes(iconUrl(attribute));
      return svgToPng(svg.toString("utf8"));
    });
  } catch (err) {
    console.warn(
      `  [警告] 属性图标 ${attribute} 获取失败: ${(err as Error).message}，用属性色圆点代替`,
    );
    return null;
  }
}

/** 获取普通或特训星星图标。下载失败时返回 null，由卡片渲染器跳过星级。 */
export async function getStarIcon(name: StarIconName): Promise<Image | null> {
  const fileName = `${name}.png`;
  try {
    return await cachedLoad(join(CACHE_DIR, fileName), `星星 ${fileName}`, () =>
      fetchBytes(starUrl(name)),
    );
  } catch (err) {
    console.warn(
      `  [警告] 星星 ${fileName} 下载失败: ${(err as Error).message}，本次不叠加星级`,
    );
    return null;
  }
}

export interface AssetCache {
  /** 卡框：key = frameCacheName()（card-5.png / card-1-happy.png），value 可能为 null（失败降级） */
  frames: Map<string, Image | null>;
  /** 属性图标：key = attribute */
  icons: Map<string, Image | null>;
  /** 普通 / 特训星星（Bestdori CDN 缓存；失败时为 null） */
  star: Image | null;
  starTrained: Image | null;
}

/**
 * 启动时一次性预取全部所需素材（按稀有度/属性集合去重后并行下载）。
 */
export async function prefetchAssets(
  rarities: number[],
  attributes: string[],
): Promise<AssetCache> {
  ensureCacheDir();

  // 卡框需求组合去重（1星按属性展开；2-6星只看稀有度）
  const combos: Array<{ rarity: number; attribute: string }> = [];
  const seen = new Set<string>();
  for (const r of rarities) {
    const list =
      r <= 1
        ? attributes.map((a) => ({ rarity: 1, attribute: a }))
        : [{ rarity: Math.max(2, Math.min(r, 6)), attribute: "" }];
    for (const c of list) {
      const n = frameCacheName(c.rarity, c.attribute);
      if (seen.has(n)) continue;
      seen.add(n);
      combos.push(c);
    }
  }

  const frames = new Map<string, Image | null>();
  const jobs: Promise<void>[] = combos.map(async (c) => {
    const img = await getCardFrame(c.rarity, c.attribute);
    frames.set(frameCacheName(c.rarity, c.attribute), img);
  });
  const icons = new Map<string, Image | null>();
  for (const attr of attributes) {
    jobs.push(
      getAttributeIcon(attr).then((img) => {
        icons.set(attr, img);
      }),
    );
  }
  let star: Image | null = null;
  let starTrained: Image | null = null;
  jobs.push(
    getStarIcon("star").then((img) => {
      star = img;
    }),
    getStarIcon("star_trained").then((img) => {
      starTrained = img;
    }),
  );
  await Promise.all(jobs);

  return { frames, icons, star, starTrained };
}
