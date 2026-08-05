/**
 * 通用 HTTP 下载工具（https.get 实现，60s 超时）。
 */
import * as https from "https";

/**
 * 下载 URL 返回原始 Buffer。
 * @param url 目标 URL
 * @param headers 请求头
 */
export function download(url: string, headers: Record<string, string>): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(60_000, () => {
            req.destroy();
            reject(new Error("Timeout"));
        });
    });
}

/** iTunes Lookup API 使用的浏览器 UA（避免被 App Store 接口拒绝） */
export const APPLE_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0";
