/**
 * 游戏 /application 接口：获取 AppGetResponse（客户端/数据版本等）。
 */
import { GARUPA_API_BASE, createGarupaHeaders } from "../config.js";
import { getClientVersion } from "../clientVersion.js";
import { download } from "../http.js";
import { decryptAes, decodeAppGet } from "../parser/index.js";

/**
 * 拉取 /application 并解码为 AppGetResponse 明文对象。
 * @param clientVersion X-ClientVersion，不传时从 App Store 获取（带缓存）
 */
export async function fetchApplication(clientVersion?: string): Promise<any> {
    const encrypted = await download(GARUPA_API_BASE + "application", createGarupaHeaders(clientVersion ?? await getClientVersion()));
    return decodeAppGet(new Uint8Array(decryptAes(encrypted)));
}
