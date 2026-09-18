/**
 * 版本获取：客户端版本（App Store 拉取 / 兜底）与数据版本（游戏 /application 接口）。
 */
import { fetchApplication } from "./api/application.js";

export { getClientVersion } from "./clientVersion.js";

/**
 * 获取数据版本（游戏 /application 接口的 dataVersion 字段）。
 */
export async function getDataVersion(): Promise<string> {
    const app = await fetchApplication();
    return app.dataVersion;
}

/**
 * 获取游戏侧最新版本记录（/application 的 client/data/masterData 版本）。
 */
export async function getAppVersions(): Promise<{ clientVersion: string; dataVersion: string; masterDataVersion: string }> {
    const app = await fetchApplication();
    return {
        clientVersion: app.clientVersion,
        dataVersion: app.dataVersion,
        masterDataVersion: app.masterDataVersion,
    };
}
