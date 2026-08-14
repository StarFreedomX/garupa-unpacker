/**
 * 卡牌总览图 · 风格常量（源自 tsugu-bangdream-bot 视觉调研）
 * 布局：单行横排——N 张卡从左到右排成一行，绝不换行。
 * 单卡保持最初版的大尺寸/大字号/高清晰度（des-1 参数），仅排布从竖排变横排。
 * 色值 / 字号 / 间距全部在此收敛，便于统一调整。
 */

/* ---------- 画布 ---------- */
/** 标题栏最小宽度（卡片少时总图不低于此宽） */
export const MIN_W = 800;
/** 画布左右留白（也作为单元格与画布边缘的间距） */
export const CELL_MARGIN = 24;
/** 顶部 / 底部留白 */
export const TOP_PAD = 44;
export const BOTTOM_PAD = 44;

/* ---------- 背景 / 面板 ---------- */
export const BG_COLOR = "#fef3ef"; // 暖米色
export const PANEL_FILL = "rgba(255,255,255,0.9)"; // 白底半透明（tsugu 面板 opacity 0.9）
export const PANEL_STROKE = "#bbbbbb"; // 细描边
export const PANEL_RADIUS = 25;
export const SKILL_BG = "#f1f1f1"; // 技能浅灰横条
export const SKILL_RADIUS = 20;

/* ---------- 文字 ---------- */
export const TEXT_MAIN = "#505050"; // 正文
export const TEXT_SUB = "#a7a7a7"; // 次要说明 / 卡片 ID
export const LABEL_BG = "#5b5b5b"; // 白色标签胶囊底
export const DASH_COLOR = "#a8a8a8"; // 虚线分隔线

/* ---------- 字体（日文优先，中英回退） ---------- */
export const FONT_FAMILY = `"Yu Gothic", "Microsoft YaHei", sans-serif`;
export const FONT = {
  headerTitle: `700 44px ${FONT_FAMILY}`, // 总览标题栏：dataVersion 大字
  headerSub: `400 20px ${FONT_FAMILY}`, // 总览标题栏：时间 / 计数小字
  title: `700 36px ${FONT_FAMILY}`, // prefix 大字（格内）
  name: `500 22px ${FONT_FAMILY}`, // 角色名（格内）
  skillName: `700 24px ${FONT_FAMILY}`,
  body: `400 20px ${FONT_FAMILY}`, // 技能描述
  label: `700 16px ${FONT_FAMILY}`, // 特訓前/特訓後 胶囊
  statValue: `700 20px ${FONT_FAMILY}`,
  meta: `400 13px ${FONT_FAMILY}`, // 元信息小字
};

/* ---------- 行高 ---------- */
export const LH = {
  headerTitle: 56,
  headerSub: 28,
  title: 48,
  name: 30,
  skillName: 36,
  body: 30,
  meta: 18,
};

/* ---------- 总览标题栏 ---------- */
export const HEADER_CHIP_BG = "#c9a32a"; // 「全 N 张」金色胶囊
export const HEADER_BAR = ["#f0b84b", "#f7c631", "#e0a33a"]; // 面板底部装饰条渐变
export const HEADER_PAD_X = 30; // 标题栏左右内边距
export const HEADER_PAD_Y = 26; // 标题栏上下内边距
/** 标题栏面板高度 */
export const HEADER_H = HEADER_PAD_Y * 2 + LH.headerTitle + 8 + LH.headerSub;

/* ---------- 单卡格子（2 列网格 · des-1 大尺寸） ---------- */
export const CELL_W = 800; // 单格宽（= 最初版单卡画布宽）
export const CELL_GAP = 20; // 列间距（同排两卡之间）
export const ROW_GAP = 24; // 行间距（两行格子之间）
export const CELL_PANEL_GAP = 30; // 格内区块间隔（最初版 SECTION_GAP）
export const TITLE_STAR = 22; // 标题右上角星行单颗尺寸（最初版 22px）
export const AVATAR_SIZE = 180; // 头像尺寸（最初版 180，官方素材 k=1）
export const AVATAR_GAP = 24; // 双头像间距
export const AVATAR_LABEL_H = 30; // 特訓前/特訓後 胶囊高
export const AVATAR_LABEL_GAP = 12; // 头像与下方胶囊间距
export const MAX_DESC_LINES = 3; // 技能描述最多行数（超出省略号，保持等高）

/* ---------- 三围行高 ---------- */
export const STATS_ROW_H = 30; // 三围每行高
export const STATS_ROW_GAP = 18; // 三围行间距

/* ---------- 属性色表 ---------- */
export const ATTR_COLORS: Record<string, string> = {
  happy: "#ff6600",
  cool: "#4057e3",
  pure: "#44c527",
  powerful: "#ff345a",
};
export const ATTR_FALLBACK = "#8a8a8a";

/* ---------- 三围 ---------- */
export const PARAM_DEFS = [
  { key: "performance", label: "演出", color: "#f76da1" },
  { key: "technique", label: "技巧", color: "#4fb9eb" },
  { key: "visual", label: "形象", color: "#fbc74f" },
] as const;

/* ---------- 面板内边距（格内，最初版 24~30） ---------- */
export const PAD = {
  panelX: 30, // 标题 / 格内容左右
  panelY: 26,
  skillX: 26,
  skillY: 24,
  statsX: 26,
  statsY: 24,
};
