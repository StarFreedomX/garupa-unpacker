/**
 * 自动推测下一个 dataVersion。
 * 末段尾数为 90 时跨百位，因此 +20；其余版本步进 +10。
 */
export function incrementVersion(version: string): string {
    const parts = version.split(".");
    const lastPart = parts.pop();
    if (!lastPart || parts.length === 0 || !parts.every(part => /^\d+$/.test(part)) || !/^\d+$/.test(lastPart)) {
        throw new Error(`Invalid version number: ${version}`);
    }
    let last = Number(lastPart);
    if (!Number.isSafeInteger(last)) throw new Error(`Invalid version number: ${version}`);
    last += last % 100 === 90 ? 20 : 10;
    parts.push(String(last));
    return parts.join(".");
}
