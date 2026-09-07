// Small, generated binary fixtures: no game data or external downloads required.
export function silenceHca(sampleRate = 44100): Buffer {
    const data = Buffer.alloc(72);
    data.write('HCA\0'); data.writeUInt16BE(0x200, 4); data.writeUInt16BE(64, 6);
    data.write('fmt\0', 8); data[12] = 1; data.writeUIntBE(sampleRate, 13, 3); data.writeUInt32BE(1, 16);
    data.write('comp', 24); data.writeUInt16BE(8, 28);
    data[30] = 1; data[31] = 15; data[32] = 1; data[34] = 1; data[35] = 1;
    data.write('pad\0', 40);
    // One all-zero block has a zero CRC and decodes to 1024 silent samples.
    return data;
}

export function utfTable(columns: Array<[string, number]>, rows: unknown[][]): Buffer {
    const strings: Buffer[] = [Buffer.from('fixture\0')];
    const blobs: Buffer[] = [];
    const stringOffset = (value: string) => {
        const offset = Buffer.concat(strings).length;
        strings.push(Buffer.from(`${value}\0`));
        return offset;
    };
    const columnBytes = columns.map(([name, type]) => {
        const b = Buffer.alloc(5); b[0] = 0x50 | type; b.writeUInt32BE(stringOffset(name), 1); return b;
    });
    const rowSize = columns.reduce((size, [, type]) => size + ({ 0: 1, 2: 2, 4: 4, 10: 4, 11: 8 }[type]!), 0);
    const table = Buffer.concat(rows.map(row => {
        const b = Buffer.alloc(rowSize); let pos = 0;
        columns.forEach(([, type], i) => {
            const value = row[i];
            if (type === 0) { b.writeUInt8(value as number, pos); pos++; }
            else if (type === 2) { b.writeUInt16BE(value as number, pos); pos += 2; }
            else if (type === 4) { b.writeUInt32BE(value as number, pos); pos += 4; }
            else if (type === 10) { b.writeUInt32BE(stringOffset(value as string), pos); pos += 4; }
            else {
                const data = value as Buffer;
                b.writeUInt32BE(Buffer.concat(blobs).length, pos); b.writeUInt32BE(data.length, pos + 4);
                blobs.push(data); pos += 8;
            }
        });
        return b;
    }));
    const header = Buffer.alloc(32);
    const stringData = Buffer.concat(strings);
    const binary = Buffer.concat(blobs);
    const rowOffset = 24 + columns.length * 5;
    header.write('@UTF');
    header.writeUInt32BE(rowOffset + table.length + stringData.length + binary.length, 4);
    header.writeUInt16BE(rowOffset, 10);
    header.writeUInt32BE(rowOffset + table.length, 12);
    header.writeUInt32BE(rowOffset + table.length + stringData.length, 16);
    header.writeUInt16BE(columns.length, 24); header.writeUInt16BE(rowSize, 26); header.writeUInt32BE(rows.length, 28);
    return Buffer.concat([header, ...columnBytes, table, stringData, binary]);
}

export function audioArchive(tracks: Array<{ name: string; data: Buffer; codec?: number }>, external = false) {
    const awbHeader = Buffer.alloc(16 + tracks.length * 2 + (tracks.length + 1) * 4);
    awbHeader.write('AFS2'); awbHeader[4] = 1; awbHeader[5] = 4;
    awbHeader.writeUInt32LE(tracks.length, 8); awbHeader.writeUInt32LE(1, 12);
    let offset = awbHeader.length;
    tracks.forEach((track, i) => {
        awbHeader.writeUInt16LE(i, 16 + i * 2);
        awbHeader.writeUInt32LE(offset, 16 + tracks.length * 2 + i * 4);
        offset += track.data.length;
    });
    awbHeader.writeUInt32LE(offset, awbHeader.length - 4);
    const awb = Buffer.concat([awbHeader, ...tracks.map(t => t.data)]);
    const cue = utfTable([['CueId', 4], ['ReferenceType', 0], ['ReferenceIndex', 2]], tracks.map((_, i) => [i, 3, i]));
    const names = utfTable([['CueIndex', 2], ['CueName', 10]], tracks.map((t, i) => [i, t.name]));
    const waves = utfTable([['Id', 2], ['EncodeType', 0], ['Streaming', 0]], tracks.map((t, i) => [i, t.codec ?? 2, Number(external)]));
    const synth = utfTable([['ReferenceItems', 11]], tracks.map((_, i) => {
        const ref = Buffer.alloc(4); ref.writeUInt16BE(1); ref.writeUInt16BE(i, 2); return [ref];
    }));
    const acb = utfTable([['CueTable', 11], ['CueNameTable', 11], ['WaveformTable', 11], ['SynthTable', 11], ['AwbFile', 11]],
        [[cue, names, waves, synth, external ? Buffer.alloc(0) : awb]]);
    return { acb, awb };
}

/** Unity serialized-file v17 with TextAssets (49) or empty Shaders (48), no TypeTree. */
export function textAssets(entries: Record<string, string> | Array<[string, string]>, classID = 49): Buffer {
    const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    const objects = (Array.isArray(entries) ? entries : Object.entries(entries)).map(([name, value]) => {
        const nameBytes = Buffer.from(name), data = Buffer.from(value);
        return Buffer.concat([u32(nameBytes.length), nameBytes, Buffer.alloc((4 - nameBytes.length % 4) % 4), ...(classID === 48 ? [Buffer.alloc(256)] : [u32(data.length), data])]);
    });
    const type = Buffer.concat([u32(classID), Buffer.from([0, 255, 255]), Buffer.alloc(16)]);
    const prelude = Buffer.concat([Buffer.from('2022.3.62f1\0'), u32(13), Buffer.from([0]), u32(1), type, u32(objects.length)]);
    let offset = 0;
    const objectTable = objects.map((data, i) => {
        const b = Buffer.alloc(20); b.writeBigInt64LE(BigInt(i + 1)); b.writeUInt32LE(offset, 8); b.writeUInt32LE(data.length, 12);
        offset += data.length; return b;
    });
    const metadata = Buffer.concat([prelude, Buffer.alloc((4 - (20 + prelude.length) % 4) % 4), ...objectTable, u32(0), u32(0), Buffer.from([0])]);
    const header = Buffer.alloc(20);
    header.writeUInt32BE(metadata.length); header.writeUInt32BE(20 + metadata.length + offset, 4);
    header.writeUInt32BE(17, 8); header.writeUInt32BE(20 + metadata.length, 12);
    return Buffer.concat([header, metadata, ...objects]);
}
