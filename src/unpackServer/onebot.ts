import axios from "axios";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { UnpackServerConfig } from "./config.js";

export type NoticeKind =
    | "card" | "card-pool" | "stamp" | "voice-stamp" | "event"
    | "music" | "event-badge" | "card-overview";

export interface ResourceNotice {
    kind: NoticeKind;
    version: string;
    bundle?: string;
    name: string;
    file: string;
}

const LABELS: Record<NoticeKind, string> = {
    card: "新卡面",
    "card-pool": "当期卡牌角色及颜色",
    stamp: "新增表情",
    "voice-stamp": "新增语音表情",
    event: "活动介绍图",
    music: "新曲资源",
    "event-badge": "当期活动牌子",
    "card-overview": "新卡三围技能图",
};

function mimeType(file: string): string {
    switch (path.extname(file).toLowerCase()) {
        case ".png": return "image/png";
        case ".jpg": case ".jpeg": return "image/jpeg";
        case ".gif": return "image/gif";
        case ".webp": return "image/webp";
        case ".wav": return "audio/wav";
        case ".mp3": return "audio/mpeg";
        case ".ogg": return "audio/ogg";
        default: return "application/octet-stream";
    }
}

export function isImage(file: string): boolean {
    return /\.(png|jpe?g|gif|webp)$/i.test(file);
}

export class OneBotNotifier {
    constructor(private readonly config: UnpackServerConfig) {}

    get destinations(): string[] {
        return this.config.dryRun ? ["dry-run"] : this.config.oneBotGroupIds;
    }

    private async post(
        action: string,
        body: Record<string, unknown>,
        options: { timeout?: number; acceptNapCatSendTimeout?: boolean } = {},
    ): Promise<any> {
        const response = await axios.post(`${this.config.oneBotBaseUrl}/${action}`, body, {
            timeout: options.timeout ?? 30_000,
            headers: {
                "Content-Type": "application/json",
                ...(this.config.oneBotAccessToken
                    ? { Authorization: `Bearer ${this.config.oneBotAccessToken}` }
                    : {}),
            },
        });
        const data = response.data as { status?: string; retcode?: number; message?: string; wording?: string };
        if (data?.status === "failed" || (typeof data?.retcode === "number" && data.retcode !== 0)) {
            const detail = data.message || data.wording || "";
            if (options.acceptNapCatSendTimeout
                && (data.retcode === 1200 || data.retcode === 200)
                && /^Timeout:\s*NTEvent\b/i.test(detail)) {
                console.warn(`[OneBot] NapCat 等待回执超时，按已提交处理（retcode=${data.retcode}）`);
                return response.data;
            }
            throw new Error(data.message || data.wording || `OneBot retcode=${data.retcode}`);
        }
        return response.data;
    }

    private async sendGroupMessage(
        groupId: string,
        message: string | Array<Record<string, unknown>>,
    ): Promise<void> {
        await this.post("send_group_msg", { group_id: groupId, message }, {
            timeout: 120_000,
            acceptNapCatSendTimeout: true,
        });
    }

    private async uploadGroupFile(groupId: string, file: string): Promise<void> {
        await this.post("upload_group_file", {
            group_id: groupId,
            file: await this.fileReference(file),
            name: path.basename(file),
        }, { timeout: 120_000, acceptNapCatSendTimeout: true });
    }

    private async fileReference(file: string): Promise<string> {
        if (!this.config.oneBotFileBaseUrl) {
            return `base64://${(await fs.readFile(file)).toString("base64")}`;
        }
        const relative = path.relative(this.config.outputRoot, file).split(path.sep).map(encodeURIComponent).join("/");
        if (relative.startsWith("..")) throw new Error(`文件不在服务输出目录内: ${file}`);
        return `${this.config.oneBotFileBaseUrl}/${relative}`;
    }

    async sendResource(groupId: string, notice: ResourceNotice): Promise<void> {
        const title = `【Garupa ${notice.version}】${LABELS[notice.kind]}`;
        if (this.config.dryRun) {
            console.log(`[通知:dry-run] ${title} ${notice.name} → ${notice.file}`);
            return;
        }
        if (isImage(notice.file)) {
            const bytes = await fs.readFile(notice.file);
            await this.sendGroupMessage(groupId, [
                { type: "text", data: { text: `${title}\n` } },
                { type: "image", data: { file: `base64://${bytes.toString("base64")}`, mime: mimeType(notice.file) } },
            ]);
            return;
        }
        await this.sendGroupMessage(groupId, title);
        await this.uploadGroupFile(groupId, notice.file);
    }

    /** 同一 bundle 已完成的多张图片合并为一条 OneBot 消息。 */
    async sendImageBatch(groupId: string, notices: ResourceNotice[]): Promise<void> {
        if (notices.length === 0) return;
        const first = notices[0];
        if (notices.some(notice => !isImage(notice.file)
            || notice.version !== first.version || notice.kind !== first.kind || notice.bundle !== first.bundle)) {
            throw new Error("图片合并消息必须来自同一版本、类型和 bundle");
        }
        const title = `【Garupa ${first.version}】${LABELS[first.kind]}`;
        if (this.config.dryRun) {
            console.log(`[通知:dry-run:图片合并] ${title}: ${notices.map(notice => notice.name).join(", ")}`);
            return;
        }
        const images = await Promise.all(notices.map(async notice => ({
            notice,
            bytes: await fs.readFile(notice.file),
        })));
        const text = `${title}（${notices.length}张）\n`;
        await this.sendGroupMessage(groupId, [
            { type: "text", data: { text } },
            ...images.map(({ notice, bytes }) => ({
                type: "image",
                data: { file: `base64://${bytes.toString("base64")}`, mime: mimeType(notice.file) },
            })),
        ]);
    }

    async sendText(groupId: string, text: string): Promise<void> {
        if (this.config.dryRun) {
            console.log(`[通知:dry-run] ${text}`);
            return;
        }
        await this.sendGroupMessage(groupId, text);
    }
}
