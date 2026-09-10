import { compareVersions, mainVersion } from "../garupa/assetBundleInfo.js";

/**
 * 自动推测下一个 dataVersion。
 * 末段先向下对齐十位再 +10；遇到整百时再 +10。
 */
export function incrementVersion(version: string): string {
    const parts = version.split(".");
    const lastPart = parts.pop();
    if (!lastPart || parts.length !== 3 || !parts.every(part => /^\d+$/.test(part)) || !/^\d+$/.test(lastPart)) {
        throw new Error(`Invalid version number: ${version}`);
    }
    let last = Number(lastPart);
    if (!Number.isSafeInteger(last)) throw new Error(`Invalid version number: ${version}`);
    last = Math.floor(last / 10) * 10 + 10;
    if (last % 100 === 0) last += 10;
    parts.push(String(last));
    return parts.join(".");
}

/** 已知 CDN 版本线领先时从 .100 探测，否则沿当前版本线递增。 */
export function predictedVersion(observed: string, knownLines: string[] = []): string {
    const next = incrementVersion(observed);
    const newest = knownLines
        .filter(line => /^\d+\.\d+\.\d+$/.test(line))
        .sort(compareVersions)[0];
    return newest && compareVersions(newest, mainVersion(observed)) < 0 ? `${newest}.100` : next;
}
