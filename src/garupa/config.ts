/**
 * Garupa 游戏 API 通用配置：.env 加载、AES 密钥（懒加载）、常量与请求头构建。
 */
import dotenv from "dotenv";

dotenv.config();

/** 游戏 API 基地址 */
export const GARUPA_API_BASE = "https://api.garupa.jp/api/";

/** 客户端版本默认值（拉取 App Store 失败时兜底） */
export const DEFAULT_CLIENT_VERSION = "10.1.4";

/** JP 服 App Store 包查询（iTunes Lookup API），返回最新客户端版本 */
export const ITUNES_LOOKUP_URL = "https://itunes.apple.com/jp/lookup?bundleId=jp.co.craftegg.band";

/**
 * 懒加载 AES 密钥（.env GARUPA_AES_KEY）。
 * 未设置时抛错（由上层 catch 处理，不直接 process.exit）。
 */
export function getAesKey(): Buffer {
    const key = process.env.GARUPA_AES_KEY;
    if (!key) {
        throw new Error("错误：未设置 GARUPA_AES_KEY / GARUPA_AES_IV。请在 .env 中配置");
    }
    return Buffer.from(key);
}

/**
 * 懒加载 AES IV（.env GARUPA_AES_IV）。
 * 未设置时抛错（由上层 catch 处理，不直接 process.exit）。
 */
export function getAesIv(): Buffer {
    const iv = process.env.GARUPA_AES_IV;
    if (!iv) {
        throw new Error("错误：未设置 GARUPA_AES_KEY / GARUPA_AES_IV。请在 .env 中配置");
    }
    return Buffer.from(iv);
}

/**
 * 构建 Garupa 游戏 API 请求头。
 * 注意：X-Signature 经验证非必需，无需携带。
 */
export function createGarupaHeaders(clientVersion: string): Record<string, string> {
    return {
        "User-Agent": "UnityPlayer/2021.3.45f2 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)",
        "X-Unity-Version": "2021.3.45f2",
        "X-ClientPlatform": "Android",
        "X-ClientVersion": clientVersion,
        Accept: "application/octet-stream",
        "Content-Type": "application/octet-stream",
    };
}
