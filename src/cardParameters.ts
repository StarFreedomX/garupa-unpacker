/** 满级、特训后、卡牌剧情全解锁，星光突破 0 次的三围。 */
export const CARD_STAT_BASIS = "满级·特训后·剧情全开·0星光突破";

export function fullCardParameters(situation: any): {
    maxLevel: number | null;
    parameters: { performance: number; technique: number; visual: number } | null;
} {
    const maxParam = Object.values(situation.parameterMap ?? {}).reduce<any>(
        (best, value: any) => !best || (value?.level ?? 0) > (best.level ?? 0) ? value : best,
        null,
    );
    if (!maxParam) return { maxLevel: null, parameters: null };

    const training = situation.training;
    const episodes: any[] = situation.episodes?.entries ?? [];
    const stat = (base: string, trained: string, episode: string): number =>
        (maxParam[base] ?? 0)
        + (training?.[trained] ?? 0)
        + episodes.reduce((sum, entry) => sum + (entry[episode] ?? 0), 0);

    return {
        maxLevel: maxParam.level ?? null,
        parameters: {
            performance: stat("performance", "trainingPerformance", "appendPerformance"),
            technique: stat("technique", "trainingTechnique", "appendTechnique"),
            visual: stat("visual", "trainingVisual", "appendVisual"),
        },
    };
}
