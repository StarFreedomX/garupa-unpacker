/**
 * Decode SuiteMasterGetResponse protobuf payload using the compiled
 * schema generated from proto/CE.proto (protobufjs static module).
 */
import { CE } from "../proto/gen/CE.js";

const SuiteMasterGetResponse = CE.SuiteMasterGetResponse;

export function decode(data: Uint8Array): Record<string, any> {
    const message = SuiteMasterGetResponse.decode(data);
    return SuiteMasterGetResponse.toObject(message, {
        longs: String,     // int64/uint64 → decimal string
        enums: Number,     // enum → number
        bytes: String,     // bytes → base64 string
        defaults: false,   // omit unset fields
        arrays: false,
        objects: false,
    }) as Record<string, any>;
}
