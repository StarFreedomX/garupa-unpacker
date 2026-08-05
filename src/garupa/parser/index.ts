/**
 * 公共解析器：AES 解密 / BZip2 解压 / protobuf 解码（基于 proto/gen/CE.js 编译结构）。
 */
import * as crypto from "crypto";
import { getAesKey, getAesIv } from "../config.js";
import { CE } from "../../../proto/gen/CE.js";
import seekBzip from "seek-bzip";

/**
 * AES-128-CBC 解密（无自动填充）。
 * @param data 加密原始数据
 */
export function decryptAes(data: Buffer): Buffer {
    const decipher = crypto.createDecipheriv("aes-128-cbc", getAesKey(), getAesIv());
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * BZip2 解压。
 * @param data 压缩数据
 */
export function decompressBzip2(data: Buffer): Buffer {
    return seekBzip.decode(data);
}

/**
 * 严格 protobuf 解码：decode + toObject（longs → 字符串，enums → 数字，bytes → base64，省略未设置字段）。
 */
function decodeStrict(type: any, data: Uint8Array): any {
    const message = type.decode(data);
    return type.toObject(message, {
        longs: String,
        enums: Number,
        bytes: String,
        defaults: false,
    });
}

/**
 * 解码 SuiteMasterGetResponse。
 */
export function decodeSuiteMaster(data: Uint8Array): Record<string, any> {
    return decodeStrict(CE.SuiteMasterGetResponse, data);
}

/**
 * 解码 AppGetResponse。
 * 响应为 AES-128-CBC 解密（无自动去填充）后，尾部带 ISO 10126 填充：
 * 最后一位字节 = 填充长度（如 0x02），其余填充字节随机。
 * 直接按末尾字节裁剪；若填充长度非法或裁剪后解码失败，回退逐字节试错（0..16）。
 */
export function decodeAppGet(data: Uint8Array): any {
    const padLen = data.length > 0 ? data[data.length - 1] : 0;
    if (padLen >= 1 && padLen <= 16) {
        try {
            return decodeStrict(CE.AppGetResponse, data.subarray(0, data.length - padLen));
        } catch { /* 填充长度异常，回退试错 */ }
    }

    let lastError: unknown;
    for (let trim = 0; trim <= 16; trim++) {
        try {
            return decodeStrict(CE.AppGetResponse, data.subarray(0, data.length - trim));
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}
