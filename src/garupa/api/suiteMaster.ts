/**
 * 游戏 /suite/master 接口：完整下载管线 → 明文 JSON 对象。
 * 下载 → AES 解密 → BZip2 解压 → protobuf 解码。
 */
import { GARUPA_API_BASE, createGarupaHeaders, DEFAULT_CLIENT_VERSION } from "../config.js";
import { download } from "../http.js";
import { decryptAes, decompressBzip2, decodeSuiteMaster } from "../parser/index.js";

/**
 * 拉取并解析 SuiteMasterGetResponse。
 * @param clientVersion X-ClientVersion，默认内置兜底版本
 */
export async function fetchSuiteMaster(clientVersion: string = DEFAULT_CLIENT_VERSION): Promise<Record<string, any>> {
    console.log("Downloading SuiteMaster from game API...");
    const encrypted = await download(GARUPA_API_BASE + "suite/master", createGarupaHeaders(clientVersion));

    console.log(`Encrypted: ${(encrypted.length / 1024 / 1024).toFixed(1)} MB`);
    const decrypted = decryptAes(encrypted);

    console.log(`Decompressing BZip2: ${(decrypted.length / 1024 / 1024).toFixed(1)} MB`);
    const decompressed = decompressBzip2(decrypted);

    console.log(`Decompressed: ${(decompressed.length / 1024 / 1024).toFixed(1)} MB`);
    console.log("Parsing protobuf with schema...");

    return decodeSuiteMaster(new Uint8Array(decompressed));
}
