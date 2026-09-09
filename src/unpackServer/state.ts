import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ApplicationState {
    clientVersion: string;
    dataVersion: string;
    masterDataVersion: string;
}

export interface CycleState {
    baseVersion: string;
    targetVersion: string;
    confirmed: boolean;
    manifestReady: boolean;
    masterReady: boolean;
    createdAt: string;
    completedBundles: string[];
    sent: Record<string, string>;
    textSent: string[];
    lastErrors: Record<string, string>;
}

export interface ServerState {
    schemaVersion: 1;
    application?: ApplicationState;
    baselineMusicIds: Array<string | number>;
    cycles: Record<string, CycleState>;
}

export function emptyServerState(): ServerState {
    return { schemaVersion: 1, baselineMusicIds: [], cycles: {} };
}

export async function loadServerState(file: string): Promise<ServerState> {
    try {
        const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as Partial<ServerState>;
        if (parsed.schemaVersion !== 1) return emptyServerState();
        return {
            schemaVersion: 1,
            ...(parsed.application ? { application: parsed.application } : {}),
            baselineMusicIds: Array.isArray(parsed.baselineMusicIds) ? parsed.baselineMusicIds : [],
            cycles: parsed.cycles && typeof parsed.cycles === "object" ? parsed.cycles : {},
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            console.warn(`[状态] 无法读取 ${file}，使用空状态: ${(error as Error).message}`);
        }
        return emptyServerState();
    }
}

/** 临时文件 + rename，防止进程退出时留下半份 JSON。 */
export async function saveServerState(file: string, state: ServerState): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), "utf-8");
    await fs.rename(temporary, file);
}

export function ensureCycle(state: ServerState, baseVersion: string, targetVersion: string, confirmed: boolean): CycleState {
    const existing = state.cycles[targetVersion];
    if (existing) {
        existing.confirmed ||= confirmed;
        return existing;
    }
    const cycle: CycleState = {
        baseVersion,
        targetVersion,
        confirmed,
        manifestReady: false,
        masterReady: false,
        createdAt: new Date().toISOString(),
        completedBundles: [],
        sent: {},
        textSent: [],
        lastErrors: {},
    };
    state.cycles[targetVersion] = cycle;
    return cycle;
}
