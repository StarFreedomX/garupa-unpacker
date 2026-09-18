/** Install a graceful SIGINT handler with a three-press emergency exit. */
export function installShutdownHandlers(controller: AbortController, name: string): void {
    let sigintCount = 0;

    process.on("SIGINT", () => {
        sigintCount += 1;
        if (sigintCount >= 3) {
            console.error(`[${name}] 连续收到 3 次 Ctrl+C，强制退出`);
            process.exit(130);
        }

        if (sigintCount === 1) {
            console.warn(`[${name}] 收到 Ctrl+C，正在停止当前任务；再次按 Ctrl+C 可继续强制退出（第 3 次强制）`);
            controller.abort();
        } else {
            console.warn(`[${name}] 已收到第 ${sigintCount} 次 Ctrl+C，再按 1 次将强制退出`);
        }
    });
    process.once("SIGTERM", () => controller.abort());
}
