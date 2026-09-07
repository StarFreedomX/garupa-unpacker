import { networkGet } from '../network.js';

/** Download API bytes through the same proxy and request budget as asset downloads. */
export async function download(url: string, headers: Record<string, string>): Promise<Buffer> {
    const response = await networkGet(url, { headers, timeout: 60_000 });
    return Buffer.from(response.data);
}

/** iTunes Lookup API 使用的浏览器 UA（避免被 App Store 接口拒绝） */
export const APPLE_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0";
