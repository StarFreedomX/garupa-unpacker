/**
 * 版本获取：客户端版本（App Store 拉取 / 兜底）与数据版本（游戏 /application 接口）。
 */
import { ITUNES_LOOKUP_URL, DEFAULT_CLIENT_VERSION } from "./config.js";
import { download, APPLE_UA } from "./http.js";
import { fetchApplication } from "./api/application.js";

/**
 * 获取客户端版本号（X-ClientVersion）：
 * 1. GARUPA_CLIENT_VERSION_FORCE 设置则强制使用（跳过自动拉取）
 * 2. 否则从 Apple iTunes Lookup API 拉取 App Store 最新版本
 * 3. 拉取失败则回退 GARUPA_CLIENT_VERSION_DEFAULT，再回退内置默认值
 */
export async function getClientVersion(): Promise<string> {
    const forced = process.env.GARUPA_CLIENT_VERSION_FORCE;
    if (forced) {
        console.log(`Client version (forced): ${forced}`);
        return forced;
    }

    try {
        const body = await download(`${ITUNES_LOOKUP_URL}&t=${Date.now()}`, {
            "User-Agent": APPLE_UA,
        });
        const data = JSON.parse(body.toString("utf-8")) as { results?: Array<{ version?: string }> };
        const version = data.results?.[0]?.version;
        if (version) {
            console.log(`Client version (from App Store): ${version}`);
            return version;
        }
        console.warn("iTunes lookup returned no version, falling back to default");
    } catch (err) {
        console.warn(`Failed to fetch client version: ${(err as Error).message}`);
    }
    const fallback = process.env.GARUPA_CLIENT_VERSION_DEFAULT || DEFAULT_CLIENT_VERSION;
    console.log(`Client version (default): ${fallback}`);
    return fallback;
}

/**
 * 获取数据版本（游戏 /application 接口的 dataVersion 字段）。
 */
export async function getDataVersion(): Promise<string> {
    const app = await fetchApplication();
    return app.dataVersion;
}
