export interface PreviewInfo {
    dataVersion: string;
    cards: any[];
    musics: any[];
}

export function suiteMusicIds(suite: Record<string, any>): Array<string | number> {
    const musics: any[] = suite.masterMusicList?.entries ?? [];
    return musics.map(music => music.musicId).filter((id): id is string | number => id != null);
}

function fillSkillDescription(
    template: string | undefined,
    skillId: number | null,
    onceEffects: any[],
    actEffects: any[],
): string {
    if (!template || skillId == null) return template ?? "";
    const effects: Array<Map<number, string>> = [];
    const onceByLevel = new Map<number, string>();
    for (const effect of onceEffects.filter(effect => effect.skillId === skillId)) {
        onceByLevel.set(effect.skillLevel, effect.colorDescription);
    }
    if (onceByLevel.size) effects.push(onceByLevel);
    const matching = actEffects
        .filter(effect => effect.skillId === skillId)
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.skillLevel - b.skillLevel);
    for (const seq of [...new Set(matching.map(effect => effect.seq))]) {
        const byLevel = new Map<number, string>();
        for (const effect of matching.filter(item => item.seq === seq)) {
            byLevel.set(effect.skillLevel, effect.colorDescription);
        }
        if (byLevel.size) effects.push(byLevel);
    }
    return template.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
        const effect = effects[Number(index)];
        return effect
            ? [...effect.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join("/")
            : placeholder;
    });
}

/** SuiteMaster 更新后生成三围技能图和新曲元数据共用的数据，不触发任何资源下载。 */
export function buildPreviewInfo(
    suite: Record<string, any>,
    version: string,
    resourceSets: Set<string>,
    previousMusicIds: Iterable<string | number>,
): PreviewInfo {
    const situations: Record<string, any> = suite.masterCharacterSituationMap?.entries ?? {};
    const characters: Record<string, any> = suite.masterCharacterInfoMap?.entries ?? {};
    const skillDefs: Record<string, any> = suite.masterSituationSkillMap?.entries ?? {};
    const skillList: any[] = suite.masterSkillList?.entries ?? [];
    const onceEffects: any[] = Object.values(suite.masterSkillOnceEffectList?.entries ?? {});
    const actEffects: any[] = Object.values(suite.masterSkillActivateEffectList?.entries ?? {});
    const musicList: any[] = suite.masterMusicList?.entries ?? [];
    const difficultyList: any[] = suite.masterMusicDifficultyList?.entries ?? [];
    const bands: Record<string, any> = suite.masterBandMap?.entries ?? {};
    const oldMusic = new Set([...previousMusicIds].map(String));

    const cards = Object.values(situations)
        .filter(situation => resourceSets.has(situation.resourceSetName))
        .sort((a, b) => Number(a.situationId) - Number(b.situationId))
        .map(situation => {
            const character = characters[String(situation.characterId)];
            const skillDef = skillDefs[String(situation.situationSkillId)];
            const skillRecord = skillList.find(
                entry => entry.skillId === skillDef?.skillId && entry.skillLevel === 1,
            );
            const parameters = Object.values(situation.parameterMap ?? {}).reduce<any>(
                (best, value: any) => !best || (value?.level ?? 0) > (best.level ?? 0) ? value : best,
                null,
            );
            return {
                situationId: situation.situationId,
                characterId: situation.characterId,
                characterName: character?.characterName ?? "",
                colorCode: character?.colorCode ?? "",
                rarity: situation.rarity,
                attribute: situation.attribute,
                prefix: situation.prefix,
                resourceSetName: situation.resourceSetName,
                maxLevel: parameters?.level ?? null,
                parameters: parameters ? {
                    performance: parameters.performance,
                    technique: parameters.technique,
                    visual: parameters.visual,
                } : null,
                skill: {
                    skillName: skillDef?.skillName ?? "",
                    skillId: skillDef?.skillId ?? null,
                    description: fillSkillDescription(
                        skillRecord?.description,
                        skillDef?.skillId ?? null,
                        onceEffects,
                        actEffects,
                    ),
                    simpleDescription: skillRecord?.simpleDescription,
                    duration: skillRecord?.duration,
                },
            };
        });

    // 没有旧 master 基线时不能把全量歌曲误报成“新增”；这种情况只生成卡牌信息。
    const musics = musicList
        .filter(music => oldMusic.size > 0 && music.musicId != null && !oldMusic.has(String(music.musicId)))
        .sort((a, b) => Number(a.musicId) - Number(b.musicId))
        .map(music => ({
            musicId: music.musicId,
            title: music.musicTitle ?? "",
            bandName: bands[String(music.bandId)]?.bandName ?? "",
            publishedAt: music.publishedAt
                ? new Date(Number(music.publishedAt)).toISOString().slice(0, 10)
                : null,
            howToGet: music.howToGet ?? "",
            levels: difficultyList
                .filter(entry => entry.musicId === music.musicId)
                .map(entry => ({ difficulty: entry.difficulty, playLevel: entry.playLevel }))
                .sort((a, b) => a.playLevel - b.playLevel),
        }));
    return { dataVersion: version, cards, musics };
}

function formatMusicDetail(music: any): string {
    const levels = (music.levels ?? []).map((entry: any) => `${entry.difficulty}:${entry.playLevel}`).join(" / ");
    return [
        `${music.title}${music.bandName ? ` / ${music.bandName}` : ""}`,
        levels || undefined,
        music.publishedAt ? `发布日期：${music.publishedAt}` : undefined,
        music.howToGet ? `获取方式：${music.howToGet}` : undefined,
    ].filter(Boolean).join("\n");
}

export function formatMusicNotices(version: string, musics: any[]): string {
    return [
        `【Garupa ${version}】新曲`,
        ...musics.map(formatMusicDetail),
    ].join("\n\n");
}
