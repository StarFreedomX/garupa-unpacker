import { ITUNES_LOOKUP_URL, DEFAULT_CLIENT_VERSION } from "./config.js";
import { download, APPLE_UA } from "./http.js";

/** Cache successful lookups for 5 minutes; retry failed lookups after 1 minute. */
export function createClientVersionResolver(
    lookup: () => Promise<string> = async () => {
        const body = await download(`${ITUNES_LOOKUP_URL}&t=${Date.now()}`, { "User-Agent": APPLE_UA });
        const data = JSON.parse(body.toString("utf-8"));
        const version = data.results?.[0]?.version;
        if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
            throw new Error("iTunes lookup returned no valid version");
        }
        return version;
    },
    now: () => number = Date.now,
    env: NodeJS.ProcessEnv = process.env,
): () => Promise<string> {
    let lastKnown: string | undefined;
    let nextLookup = 0;
    let pending: Promise<string> | undefined;
    const fallback = () => lastKnown || env.GARUPA_CLIENT_VERSION_DEFAULT || DEFAULT_CLIENT_VERSION;
    return async () => {
        if (env.GARUPA_CLIENT_VERSION_FORCE) return env.GARUPA_CLIENT_VERSION_FORCE;
        if (pending) return pending;
        if (now() < nextLookup) return fallback();
        pending = (async () => {
            try {
                lastKnown = await lookup();
                nextLookup = now() + 5 * 60_000;
                console.log(`Client version (from App Store): ${lastKnown}`);
                return lastKnown;
            } catch (error) {
                nextLookup = now() + 60_000;
                console.warn(`Failed to fetch client version: ${(error as Error).message}; using ${fallback()}`);
                return fallback();
            }
        })();
        try { return await pending; }
        finally { pending = undefined; }
    };
}

/** Force override → App Store (cached) → last successful version → configured/built-in fallback. */
export const getClientVersion = createClientVersionResolver();
