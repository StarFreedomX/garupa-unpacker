/**
 * 游戏 /application 接口：获取 AppGetResponse（客户端/数据版本等）。
 */
import { GARUPA_API_BASE, createGarupaHeaders, DEFAULT_CLIENT_VERSION } from "../config.js";
import { download } from "../http.js";
import { decryptAes, decodeAppGet } from "../parser/index.js";

/**
 * 拉取 /application 并解码为 AppGetResponse 明文对象。
 * @param clientVersion X-ClientVersion，默认内置兜底版本
 */
export async function fetchApplication(clientVersion: string = DEFAULT_CLIENT_VERSION): Promise<any> {
    const encrypted = await download(GARUPA_API_BASE + "application", createGarupaHeaders(clientVersion));
    return decodeAppGet(new Uint8Array(decryptAes(encrypted)));
}
