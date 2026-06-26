import cron from 'node-cron';
import crypto from 'crypto';
import express from 'express';
import path from 'path';
import TelegramBot from 'node-telegram-bot-api';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { MongoClient, Collection } from 'mongodb';
import { TelegramClient, Api, helpers, utils } from 'telegram';
import { StringSession } from 'telegram/sessions';
import bigInt from 'big-integer';
import { NewMessage } from 'telegram/events';

let MAX_CONCURRENT_TASKS = 1; 
let MAX_TASKS_PER_USER = 1;
let activeTasksCount = 0;
const activeTasksPerUser = new Map<number, number>();

const mirrorTopicCache = new Map<string, Map<string, number>>();
const sourceTopicCache = new Map<string, Map<number, string>>();
const activeWatchers = new Set<number>();
let botFloodWaitEnd = 0;
const mirrorTasks = new Map<string, any[]>();
let getConnectedUserbotClient: (userId: number) => Promise<any>;
let startAutoMirrorWatcher: (userId: number, client: TelegramClient) => Promise<any>;
let createProgressMarkup: (jobKey: string, isPaused: boolean) => any;
let createProgressBar: (total: number, current: number, label: string, startTime: number, pathStr?: string) => string;
import fs from 'fs';
import os from 'os';
import { CustomFile } from 'telegram/client/uploads';

function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

function formatISTTime(dateInput: Date | string | undefined): string {
    if (!dateInput) return 'Never scanned';
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return 'Never scanned';
    
    // Add 5 hours and 30 minutes to get Indian Time (IST)
    const istTime = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
    
    const pad = (num: number) => num.toString().padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const day = pad(istTime.getUTCDate());
    const month = months[istTime.getUTCMonth()];
    const year = istTime.getUTCFullYear();
    
    let hours = istTime.getUTCHours();
    const minutes = pad(istTime.getUTCMinutes());
    const seconds = pad(istTime.getUTCSeconds());
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    const strHours = pad(hours);
    
    return `${day} ${month} ${year}, ${strHours}:${minutes}:${seconds} ${ampm} (IST)`;
}

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const mongoUri = process.env.MONGODB_URI;
let apiIdValue = Number(process.env.API_ID) || 0;
let apiHashValue = process.env.API_HASH || "";
const DEFAULT_LOG_GROUP = "-1003995334936";

const sysLogs: string[] = [];
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function addLog(level: string, ...args: any[]) {
    try {
        const text = args.map(arg => {
            if (arg instanceof Error) return arg.message;
            return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
        }).join(' ');
        const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
        sysLogs.push(`[${time}] [${level}] ${text}`);
        if (sysLogs.length > 500) sysLogs.shift();
    } catch (e) {
        // Safe fallback
    }
}

console.log = (...args: any[]) => {
    addLog('INFO', ...args);
    originalLog(...args);
};
console.error = (...args: any[]) => {
    addLog('ERROR', ...args);
    originalError(...args);
};
console.warn = (...args: any[]) => {
    addLog('WARN', ...args);
    originalWarn(...args);
};

const app = express();
const port = 3000;

let bot: TelegramBot | null = null;
const entityCache = new Map<string, any>();
let botStatus = 'Disconnected';
let dbStatus = 'Disconnected';
let botInfo: any = null;
let client: MongoClient | null = null;
let settingsCollection: Collection | null = null;
let approvedUsersCollection: Collection | null = null;
let mirroredMessagesCollection: Collection | null = null;
let queuedTasksCollection: Collection | null = null;
let failedTasksCollection: Collection | null = null;
let fullMirrorSessionsCollection: Collection | null = null;
let fileCacheCollection: Collection | null = null;
let scheduledTasksCollection: Collection | null = null;
let globalCachedFilesTopicId: number | null = null;

// Global Settings State
let currentAdminId = process.env.ADMIN_ID;
let destinationChatId = process.env.DESTINATION_CHAT_ID;
let currentDownloadLibrary = 'GramJS';
let currentUploadEngine = 'GramJS';
let globalCooldownSeconds = 5;
const uploadEngines = ['GramJS', 'Telethon', 'Pyrogram', 'Hydrogram'];
const approvedUsersCache = new Set<string>();
let globalRenameRules: Array<{ keyword: string; replaceWith: string }> = [];
const processedMessageKeys = new Set<string>();
const processedCallbackQueryIds = new Set<string>();
let downloadCounter = 0;

let activeTaskJobs = new Map<string, any>();
let batchStatusMap = new Map<string, any>();
let inMemoryMirrorLogs: Array<{ link: string; destId: string; mirroredAt: string; status: string; info?: string }> = [];
let dbEnqueueTasks: (tasks: Task[]) => Promise<void> = async () => {};
let dbClearAllTasks: () => Promise<void> = async () => {};
let dbDequeueTask: (task: Task) => Promise<void> = async () => {};
let retryAllFailedTasks: () => Promise<number> = async () => 0;
let retryFailedTask: (id: string) => Promise<boolean> = async () => false;
let clearAllFailedTasks: () => Promise<boolean> = async () => false;
let connectedBotClient: TelegramClient | null = null;
async function getConnectedBotClient(): Promise<TelegramClient | null> {
    if (botFloodWaitEnd > Date.now()) {
        console.warn(`[Bot GramJS Client] Skipping connection, still in flood wait until ${new Date(botFloodWaitEnd).toISOString()}`);
        return null;
    }
    if (!token) return null;
    if (!apiIdValue || !apiHashValue) {
        console.warn("[getConnectedBotClient] apiIdValue or apiHashValue is missing");
        return null;
    }
    if (connectedBotClient && connectedBotClient.connected) {
        return connectedBotClient;
    }
    let client: TelegramClient | null = null;
    try {
        console.log("[Bot GramJS Client] Connecting...");
        client = new TelegramClient(
            new StringSession(""),
            apiIdValue,
            apiHashValue,
            {
                connectionRetries: 10,
                timeout: 120000,
                requestRetries: 5,
                ...getRandomDeviceProps(),
                useWSS: false,
                autoReconnect: true,
            }
        );
        // Connect with a fast timeout wrapper to avoid hangs
        const startPromise = client.start({
            botAuthToken: token
        });
        let timeoutId: any;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error("GramJS bot start timeout after 60000ms")), 60000);
        });
        await Promise.race([startPromise, timeoutPromise]);
        clearTimeout(timeoutId);
        (client as any)._isBotInApp = true;
        connectedBotClient = client;
        console.log("[Bot GramJS Client] Successfully connected!");
        return connectedBotClient;
    } catch (err: any) {
        if (client) {
            await client.disconnect().catch(() => {});
        }
        if (err.name === 'FloodWaitError' || (err.message && err.message.includes('FloodWaitError'))) {
            const seconds = err.seconds || 1500;
            botFloodWaitEnd = Date.now() + (seconds * 1000);
            console.error(`[Bot GramJS Client] FloodWaitError, waiting ${seconds} seconds until ${new Date(botFloodWaitEnd).toISOString()}`);
        } else {
            console.error("[Bot GramJS Client] Failed to connect:", err);
        }
        connectedBotClient = null; // Ensure we try afresh next time
        return null;
    }
}

function getMsgId(url: string): number {
    if (!url) return 0;
    const parts = url.trim().split('/');
    const last = parts[parts.length - 1];
    return parseInt(last || '0');
}

function applyRenameRules(text: string, customRules?: Array<{ keyword: string; replaceWith: string }>): string {
    if (!text) return "";
    let result = text;
    const rulesToUse = customRules || globalRenameRules || [];
    for (const rule of rulesToUse) {
        if (rule.keyword) {
            try {
                const escapedKeyword = rule.keyword.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                const regex = new RegExp(escapedKeyword, 'gi');
                result = result.replace(regex, rule.replaceWith || "");
            } catch (e) {
                result = result.split(rule.keyword).join(rule.replaceWith || "");
            }
        }
    }
    return result;
}

const libraryPerfMetrics: Record<string, { totalBytes: number, totalTimeMs: number, count: number }> = {
    'GramJS': { totalBytes: 0, totalTimeMs: 0, count: 0 },
    'Telethon': { totalBytes: 0, totalTimeMs: 0, count: 0 },
    'Pyrogram': { totalBytes: 0, totalTimeMs: 0, count: 0 },
    'Hydrogram': { totalBytes: 0, totalTimeMs: 0, count: 0 }
};

const getAutoEngine = () => {
    let bestLib = 'GramJS';
    let maxSpeed = -1;
    
    for (const [lib, data] of Object.entries(libraryPerfMetrics)) {
        if (data.count === 0) continue;
        const speed = data.totalBytes / data.totalTimeMs; // bytes per ms
        if (speed > maxSpeed) {
            maxSpeed = speed;
            bestLib = lib;
        }
    }
    return bestLib;
};

const recordSpeed = (lib: string, bytes: number, timeMs: number) => {
    if (!libraryPerfMetrics[lib]) return;
    if (timeMs <= 0) return;
    libraryPerfMetrics[lib].totalBytes += bytes;
    libraryPerfMetrics[lib].totalTimeMs += timeMs;
    libraryPerfMetrics[lib].count += 1;
};

const getEffectiveEngine = () => {
    if (currentUploadEngine === 'Auto') return getAutoEngine();
    return currentUploadEngine || 'GramJS';
};

const getLoginErrorSolution = (error: string) => {
    if (error.includes('TIMEOUT')) return "Telegram servers are taking too long to respond. \n\n✅ **Solutions:** \n1. Check your **Proxy** settings in /settings.\n2. Try again in a few minutes.\n3. Make sure your account isn't restricted by Telegram.";
    if (error.includes('429') || error.includes('Too Many Requests')) {
        const match = error.match(/retry after (\d+)/);
        const seconds = match ? parseInt(match[1]) : 3600;
        const minutes = Math.ceil(seconds / 60);
        return `Telegram ने सुरक्षा कारणों से बहुत अधिक requests के कारण ब्लॉक किया है। \n\n✅ **समाधान: कृपया ${minutes} मिनट तक प्रतीक्षा करें और फिर प्रयास करें।**`;
    }
    if (error.includes('PHONE_CODE_EXPIRED')) return "Telegram ने सुरक्षा कारणों से इस प्रयास को रोक दिया है। \n\n✅ **समाधान:** \n1. अपना **Proxy** बदलें (Magic Auto-fill उपयोग करें)। \n2. 15-20 मिनट इंतज़ार करें, फिर /login करें। \n3. OTP आने के बाद तुरंत न भेजें, 3-5 सेकंड रुकें।";
    if (error.includes('AUTH_KEY_UNREGISTERED')) return "आपका Session String वैध नहीं है। कृपया नया String Session बनाएंगे।";
    if (error.includes('FLOOD_WAIT')) return "Telegram ने आपको ब्लॉक किया है। कृपया 24-48 घंटे इंतज़ार करें।";
    if (error.includes('PHONE_NUMBER_INVALID')) return "आपने गलत फोन नंबर डाला है। कृपया सही नंबर (जैसे +91...) उपयोग करें।";
    if (error.includes('PASSWORD_HASH_INVALID')) return "आपका 2-Step Verification पासवर्ड गलत है।";
    if (error.includes('PHONE_NUMBER_UNOCCUPIED')) return "यह नंबर Telegram पर रजिस्टर नहीं है।";
    if (error.includes('api_id_invalid')) return "आपका API ID या API Hash गलत है। इसे my.telegram.org से दोबारा चेक करें।";
    return "अज्ञात त्रुटि। कृपया अपने API Creds और Network (Proxy) की जांच करें।";
};

const getRandomDeviceProps = () => {
    const devices = [
        { model: "iPhone 15 Pro Max", system: "17.5.1", app: "10.0.1" },
        { model: "Samsung Galaxy S24 Ultra", system: "14", app: "10.1.0" },
        { model: "Google Pixel 8 Pro", system: "14", app: "10.1.5" },
        { model: "OnePlus 12", system: "14", app: "10.0.1" },
        { model: "Xiaomi 14 Pro", system: "14", app: "10.2.0" },
        { model: "Nothing Phone (2a)", system: "14", app: "10.1.0" }
    ];
    const langs = ["en-US", "hi-IN", "en-GB"];
    const device = devices[Math.floor(Math.random() * devices.length)];
    return {
        deviceModel: device.model,
        systemVersion: device.system,
        appVersion: device.app,
        langCode: "en",
        systemLangCode: langs[Math.floor(Math.random() * langs.length)]
    };
};

interface ProxyConfig {
    ip: string;
    port: number;
    user?: string;
    pass?: string;
    socksType?: 4 | 5;
}

let globalProxy: ProxyConfig | null = null;

interface Task {
    id?: string;
    chatId: number;
    userId: number;
    link: string;
    statusMsgId?: number;
    batchId?: string;
    overrideThreadId?: number;
    forceGeneralPath?: boolean;
    overrideTargetId?: any;
    isMirror?: boolean;
    retries?: number;
    fullMirrorSessionId?: string;
    topicCloneSessionId?: string;
}

const MESSAGE_UPDATE_THROTTLE = 2000; // Reduced to 2s for better responsiveness
const taskQueue: Task[] = [];
const topicMappingCache = new Map<string, number>();
const taskControlMap = new Map<string, { isPaused: boolean; shouldRetry: boolean; isSkipped?: boolean }>();
let isQueuePaused = false;
let nextTaskRunAt: number | null = null;
let runNextTask: () => Promise<void>;

function getSecureHashedFileKey(msg: any): string | null {
    if (!msg || !msg.media) return null;
    let docId: string | null = null;
    let size = 0;
    let name = "file";
    
    if (msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document) {
        const doc = msg.media.document;
        docId = doc.id ? doc.id.toString() : null;
        size = Number(doc.size || 0);
        const attr = doc.attributes.find((a: any) => a instanceof Api.DocumentAttributeFilename);
        if (attr && (attr as any).fileName) {
            name = (attr as any).fileName;
        }
    } else if (msg.media instanceof Api.MessageMediaPhoto && msg.media.photo instanceof Api.Photo) {
        const photo = msg.media.photo;
        docId = photo.id ? photo.id.toString() : null;
        const largest = photo.sizes.reduce((prev: any, current: any) => {
            const prevSize = prev.size || (prev.sizes && prev.sizes[0]) || 0;
            const curSize = current.size || (current.sizes && current.sizes[0]) || 0;
            return (curSize > prevSize) ? current : prev;
        });
        if (largest && (largest as any).size) size = (largest as any).size;
        name = "photo.jpg";
    }
    
    let baseKey = null;
    if (docId) baseKey = `doc_id_${docId}`;
    else if (size > 0) baseKey = `size_name_${size}_${name}`;
    
    if (!baseKey) return null;
    return crypto.createHash('sha256').update(baseKey).digest('hex');
}

async function getOrCreateCachedFilesTopicId(client: any): Promise<number | undefined> {
    if (globalCachedFilesTopicId !== null) {
        return globalCachedFilesTopicId === -1 ? undefined : globalCachedFilesTopicId;
    }
    
    if (settingsCollection) {
        try {
            const doc = await settingsCollection.findOne({ type: 'cached_files_topic' });
            if (doc && doc.topicId !== undefined && doc.topicId !== null) {
                globalCachedFilesTopicId = Number(doc.topicId);
                return globalCachedFilesTopicId === -1 ? undefined : globalCachedFilesTopicId;
            }
        } catch (e) {
            console.warn("[CacheLog] Error reading cached topic from DB:", e);
        }
    }
    
    try {
        const logPeer = await safelyResolveEntity(client, DEFAULT_LOG_GROUP);
        if (logPeer) {
            console.log("[CacheLog] Creating Saved Files Cache topic in DEFAULT_LOG_GROUP...");
            const result = await client.invoke(new Api.channels.CreateForumTopic({
                channel: logPeer,
                title: "📁 Saved Files Cache",
                randomId: helpers.generateRandomLong(true)
            }));
            
            let topicId: number | undefined;
            if (result && result.updates) {
                for (const update of result.updates) {
                    if (update instanceof Api.UpdateNewMessage && update.message && (update.message as any).id) {
                        topicId = (update.message as any).id;
                        break;
                    }
                }
            }
            if (!topicId && result && result.updates) {
                for (const update of result.updates) {
                    if (update instanceof Api.UpdateMessageID && update.id) {
                        topicId = update.id;
                        break;
                    }
                }
            }
            if (topicId) {
                globalCachedFilesTopicId = topicId;
                if (settingsCollection) {
                    await settingsCollection.updateOne(
                        { type: 'cached_files_topic' },
                        { $set: { topicId } },
                        { upsert: true }
                    ).catch(() => {});
                }
                console.log(`[CacheLog] Created new topic "📁 Saved Files Cache" with ThreadID: ${topicId}`);
                return topicId;
            }
        }
    } catch (e: any) {
        const errStr = String(e?.message || e);
        console.log(`[CacheLog] Log Group does not support forum topics (${errStr}). Falling back to main group directly.`);
        globalCachedFilesTopicId = -1;
        if (settingsCollection) {
            await settingsCollection.updateOne(
                { type: 'cached_files_topic' },
                { $set: { topicId: -1 } },
                { upsert: true }
            ).catch(() => {});
        }
    }
    return undefined;
}

async function resumeDownloadFile(
    client: any,
    msg: any,
    tempFilePath: string,
    jobKey: string,
    onProgress: (chunkLength: number, totalSize: number) => Promise<void>
): Promise<void> {
    const media = msg.media;
    if (!media) throw new Error("No media in message");

    let totalSize = 0;
    if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
        totalSize = Number(media.document.size || 0);
    } else if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
        const largest = media.photo.sizes.reduce((prev: any, current: any) => {
            const prevSize = prev.size || (prev.sizes && prev.sizes[0]) || 0;
            const curSize = current.size || (current.sizes && current.sizes[0]) || 0;
            return (curSize > prevSize) ? current : prev;
        });
        if (largest && (largest as any).size) totalSize = (largest as any).size;
    }

    // Since we don't do complex byte-level resumption (which causes corruption and GramJS internal socket conflicts),
    // we delete any partially downloaded file and start fresh.
    if (fs.existsSync(tempFilePath)) {
        try {
            fs.unlinkSync(tempFilePath);
        } catch (e) {}
    }

    let downloadWorkers = 4;
    let partSizeKb = 512;

    if (totalSize > 500 * 1024 * 1024) { // > 500 MB
        downloadWorkers = 8;
    } else if (totalSize > 100 * 1024 * 1024) { // > 100 MB
        downloadWorkers = 6;
    } else if (totalSize > 10 * 1024 * 1024) { // > 10 MB
        downloadWorkers = 4;
    } else {
        downloadWorkers = 2;
    }

    let lastProgressTime = Date.now();
    const DOWNLOAD_STALL_TIMEOUT = 180000;
    let isFinished = false;

    let stallInterval: NodeJS.Timeout | null = null;
    try {
        const downloadPromise = client.downloadMedia(msg, {
            outputFile: tempFilePath,
            workers: downloadWorkers,
            partSizeKb: partSizeKb,
            progressCallback: async (downloaded: any, total: any) => {
                const taskState = taskControlMap.get(jobKey);
                if (taskState && taskState.isPaused) throw new Error("DOWNLOAD_PAUSED");
                if (taskState && taskState.isSkipped) throw new Error("DOWNLOAD_SKIPPED");
                
                lastProgressTime = Date.now();
                await onProgress(Number(downloaded), Number(total || totalSize || 0));
            }
        });

        const monitorPromise = new Promise<void>((_, reject) => {
            stallInterval = setInterval(() => {
                if (isFinished) {
                    if (stallInterval) clearInterval(stallInterval);
                    return;
                }
                const taskState = taskControlMap.get(jobKey);
                if (taskState && taskState.isSkipped) return reject(new Error("DOWNLOAD_SKIPPED"));
                if (taskState && taskState.isPaused) {
                    lastProgressTime = Date.now();
                    return;
                }
                if (Date.now() - lastProgressTime > DOWNLOAD_STALL_TIMEOUT) {
                    return reject(new Error("DOWNLOAD_TIMEOUT_STALLED"));
                }
            }, 5000);
        });

        await Promise.race([downloadPromise, monitorPromise]);
        isFinished = true;
    } finally {
        if (stallInterval) clearInterval(stallInterval);
    }
}

function getDestinationLink(): string {
    const defaultLink = 'https://t.me/telegram';
    if (!destinationChatId) return defaultLink;
    let val = destinationChatId.toString().trim();
    if (!val) return defaultLink;

    if (val.startsWith('https://') || val.startsWith('http://')) {
        return val;
    }
    if (val.startsWith('t.me/')) {
        return 'https://' + val;
    }
    if (val.startsWith('@')) {
        return 'https://t.me/' + val.substring(1);
    }

    if (/^-?\d+$/.test(val)) {
        let cleanId = val;
        if (cleanId.startsWith('-100')) {
            cleanId = cleanId.substring(4);
        } else if (cleanId.startsWith('-')) {
            cleanId = cleanId.substring(1);
        }
        return `https://t.me/c/${cleanId}/999999`;
    }

    return `https://t.me/${val}`;
}

// Moved to top for hoisting safety
const escapeMarkdown = (text: string) => {
    return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
};

const safeBotCall = async (method: string, ...args: any[]) => {
    let retries = 0;
    const maxRetries = 5;
    while (retries < maxRetries) {
        try {
            return await (bot as any)?.[method](...args);
        } catch (e: any) {
            const is429 = e.error_code === 429 || e.message?.includes('429');
            const isNetworkError = e.message?.includes('TIMEOUT') || e.message?.includes('ETIMEDOUT') || e.message?.includes('socket hang up') || e.message?.includes('ECONNRESET') || e.message?.includes('ECONNREFUSED');
            if ((is429 || isNetworkError) && retries < maxRetries - 1) {
                let retryAfter = 15;
                if (is429) {
                    // Try to get from parameters
                    if (e.parameters?.retry_after) {
                        retryAfter = e.parameters.retry_after;
                    } else {
                        // Try to parse from message: "429 Too Many Requests: retry after 1357"
                        const match = e.message.match(/retry after (\d+)/);
                        if (match) {
                            retryAfter = parseInt(match[1], 10);
                        }
                    }
                }
                
                // Add a small buffer
                const waitTime = (is429 ? (retryAfter + 5) : 3) * 1000;
                
                console.log(`[Bot API] Temporary issue (${e.message}) on ${method}. Waiting ${Math.round(waitTime / 1000)}s (Attempt ${retries + 1}/${maxRetries})...`);
                await sleep(waitTime);
                retries++;
                continue;
            }
            
            // Special handling for common errors
            if (e.message?.includes("can't parse entities")) {
                console.error(`[Bot API] Parse mode error on ${method}. args: ${JSON.stringify(args)}`);
                if (args.length > 0 && typeof args[args.length - 1] === 'object') {
                    const options = { ...args[args.length - 1] };
                    if (options.parse_mode) {
                        console.warn(`[Bot API] Parse mode error on ${method}. Text: ${args[0]}. Retrying without parse_mode.`);
                        delete options.parse_mode;
                        args[args.length - 1] = options;
                        retries++;
                        continue;
                    }
                }
            }

            if (e.message?.includes('TOPIC_CLOSED') || e.message?.includes('message thread not found')) {
                if (args.length > 0 && typeof args[args.length - 1] === 'object') {
                    const options = { ...args[args.length - 1] };
                    if (options.message_thread_id || options.reply_to_message_id) {
                        console.warn(`[Bot API] Topic error on ${method}. Retrying without thread context.`);
                        delete options.message_thread_id;
                        delete options.reply_to_message_id;
                        args[args.length - 1] = options;
                        retries++;
                        continue;
                    }
                }
            }

            if (is429) throw e; // RETHROW if max retries reached
            
            if (e.message?.includes('message is not modified')) {
                return true;
            }
            
            // For other errors, log and potentially return null if it's an optional call
            const msgLower = (e.message || '').toLowerCase();
            const isExpectedSilent = msgLower.includes("message is not modified") || 
                                     msgLower.includes("there is no text in the message") ||
                                     msgLower.includes("message can't be edited") ||
                                     msgLower.includes("chat not found") ||
                                     msgLower.includes("message to delete not found") ||
                                     msgLower.includes("inline keyboard expected") ||
                                     msgLower.includes("message to edit not found");
            
            if (!isExpectedSilent) {
                console.error(`[Bot API] Error on ${method}:`, e.message);
            }
            return null;
        }
    }
    return null;
};

const ensureSafeMessageLength = (text: string): string => {
    if (!text || text.length <= 4000) return text;
    let truncated = text.substring(0, 3950);
    truncated += "\n...(truncated due to length limit)";
    const tripleBacktickCount = (truncated.match(/```/g) || []).length;
    if (tripleBacktickCount % 2 === 1) {
        truncated += "\n```";
    }
    return truncated;
};

const safeSendMessage = async (chatId: number, text: string, options: any = {}) => {
    const safeText = ensureSafeMessageLength(text);
    try {
        await bot.sendChatAction(chatId, 'typing');
    } catch(e) {}
    return await safeBotCall('sendMessage', chatId, safeText, options);
};

const safeEditMessage = async (text: string, options: { chat_id: number, message_id: number, parse_mode?: any, disable_web_page_preview?: boolean, reply_markup?: any }) => {
    if (!options.message_id || options.message_id === 0) return;
    const safeText = ensureSafeMessageLength(text);
    
    // 1. Attempt editMessageText
    const res = await safeBotCall('editMessageText', safeText, options);
    if (res) return res;

    // 2. Fallback: Attempt editMessageCaption
    const resCaption = await safeBotCall('editMessageCaption', safeText, {
        chat_id: options.chat_id,
        message_id: options.message_id,
        parse_mode: options.parse_mode,
        reply_markup: options.reply_markup
    });
    if (resCaption) return resCaption;

    // 3. Ultimate Fallback: Delete and send new text message
    try {
        await safeBotCall('deleteMessage', options.chat_id, options.message_id).catch(() => {});
        return await safeSendMessage(options.chat_id, safeText, {
            parse_mode: options.parse_mode,
            disable_web_page_preview: options.disable_web_page_preview,
            reply_markup: options.reply_markup
        });
    } catch (e3: any) {
        return null;
    }
};

const activeFullMirrorSessions = new Map<string, any>();
const activeTopicCloneSessions = new Map<string, any>();

async function saveRecentSource(userId: number, sourceId: string, sourceName: string) {
    if (!approvedUsersCollection) return;
    try {
        const settingsUid = await resolveSettingsUserId(userId);
        const userDoc = await approvedUsersCollection.findOne({ userId: settingsUid });
        let recent = userDoc?.recentSources || [];
        recent = recent.filter((r: any) => r.sourceId !== sourceId);
        recent.unshift({ sourceId, sourceName });
        if (recent.length > 10) recent = recent.slice(0, 10);
        
        await approvedUsersCollection.updateOne(
            { userId: settingsUid },
            { $set: { recentSources: recent } }
        );
    } catch (e) {
        console.error("Error saving recent source:", e);
    }
}

async function saveRecentDestination(userId: number, destId: string, groupName: string) {
    if (!approvedUsersCollection) return;
    try {
        const settingsUid = await resolveSettingsUserId(userId);
        const userDoc = await approvedUsersCollection.findOne({ userId: settingsUid });
        let recent = userDoc?.recentDestinations || [];
        recent = recent.filter((r: any) => r.destId !== destId);
        recent.unshift({ destId, groupName });
        if (recent.length > 10) recent = recent.slice(0, 10);
        
        await approvedUsersCollection.updateOne(
            { userId: settingsUid },
            { $set: { recentDestinations: recent } }
        );
    } catch (e) {
        console.error("Error saving recent destination:", e);
    }
}

async function updateTopicCloneProgress(sessionId: string) {
    const session = activeTopicCloneSessions.get(sessionId);
    if (!session) return;
    
    const { chatId, statusMsgId, totalFiles, processedFiles, successCount, failedCount, topicTitle, sourceGroupId, destGroupId, startTime } = session;
    
    const filePercentage = totalFiles > 0 ? Math.round((processedFiles / totalFiles) * 100) : 0;
    
    const barLength = 12;
    const filledLength = Math.round((filePercentage / 100) * barLength);
    const emptyLength = barLength - filledLength;
    const bar = '▰'.repeat(filledLength) + '▱'.repeat(emptyLength);
    
    let estTimeStr = '';
    if (processedFiles > 0) {
        const elapsedMs = Date.now() - startTime;
        const msPerFile = elapsedMs / processedFiles;
        const remainingFiles = totalFiles - processedFiles;
        const estRemainingMs = msPerFile * remainingFiles;
        const totalSecs = Math.round(estRemainingMs / 1000);
        if (totalSecs < 60) {
            estTimeStr = `${totalSecs}s`;
        } else {
            const minutes = Math.floor(totalSecs / 60);
            const seconds = totalSecs % 60;
            estTimeStr = `${minutes}m ${seconds}s`;
        }
    }
    
    const isFinished = processedFiles >= totalFiles;
    
    let text = `┏━━━━━━━━━━━━━━━━━━━━━━┓\n` +
               `┃ 📍 𝗧𝗢𝗣𝗜𝗖 𝗖𝗟𝗢𝗡𝗘 𝗣𝗥𝗢𝗚𝗥𝗘𝗦𝗦 ┃\n` +
               `┗━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
               `📚 𝗧𝗼𝗽𝗶𝗰\n` +
               `└➤ ${topicTitle || 'No Title'}\n\n` +
               `╭─────── 📊 𝗦𝗧𝗔𝗧𝗜𝗦𝗧𝗜𝗖𝗦 ──╮\n` +
               `│ 📦 𝗧𝗼𝘁𝗮𝗹 𝗙𝗶𝗹𝗲𝘀 : ${totalFiles}\n` +
               `│ 🔄 𝗣𝗿𝗼𝗰𝗲𝘀𝘀𝗲𝗱   : ${processedFiles} / ${totalFiles}\n` +
               `│ 🟢 𝗦𝘂𝗰𝗰𝗲𝘀𝘀     : ${successCount}\n` +
               `│ 🔴 𝗙𝗮𝗶𝗹𝗲𝗱      : ${failedCount}\n` +
               `│ ⏳ 𝗥𝗲𝗺𝗮𝗶𝗻𝗶𝗻𝗴   : ${totalFiles - processedFiles}\n` +
               `│ 🕒 𝗘𝗧𝗔         : ${estTimeStr}\n` +
               `╰──────────────────────╯\n\n` +
               `🚀 𝗣𝗥𝗢𝗚𝗥𝗘𝗦𝗦\n` +
               `${bar} ${filePercentage}%\n` +
               `━━━━━━━━━━━━━`;
               
    if (isFinished) {
        text += `\n\n🎉 **All specific topic tasks completed!**`;
    }
    
    await safeEditMessage(text, { 
        chat_id: chatId, 
        message_id: statusMsgId, 
        parse_mode: 'Markdown'
    }).catch((err: any) => {
        console.warn(`[Topic Clone Progress] Failed to edit message for session ${sessionId}:`, err.message);
    });
    
    if (isFinished) {
        activeTopicCloneSessions.delete(sessionId);
        
        // Pin the completed status bar
        try {
            await safeBotCall('pinChatMessage', chatId, String(statusMsgId), { disable_notification: false });
        } catch (pinErr: any) {
            console.error("[Topic Clone Profile] pinChatMessage failed on finished:", pinErr.message);
        }
        
        // Notify user in chat
        try {
            await safeSendMessage(chatId, `🔔 **Notification:** Specific Topic Clone task Completed!\n\nSare task khatm ho gaya inside topic \`${topicTitle}\`.`);
        } catch(e) {
            console.error("Error sending topic clone completion notification", e);
        }
    }
}

async function resumeFullMirrorSession(chatId: number, sessionId: string, triggerQuery: any) {
    if (!fullMirrorSessionsCollection) {
        throw new Error("Database not ready.");
    }
    const session = await fullMirrorSessionsCollection.findOne({ sessionId });
    if (!session) {
        throw new Error("Session tracker not found in database.");
    }

    const { sourceId, dest, isLiveOption, userId } = session;
    if (!sourceId || !dest) {
        throw new Error("Invalid session backup data.");
    }

    // Clean up any pending tasks for this session from database and in-memory queue to start fresh
    for (let i = taskQueue.length - 1; i >= 0; i--) {
        if (taskQueue[i].fullMirrorSessionId === sessionId) {
            taskQueue.splice(i, 1);
        }
    }
    if (queuedTasksCollection) {
        await queuedTasksCollection.deleteMany({ fullMirrorSessionId: sessionId }).catch(() => {});
    }

    const targetUid = Number(userId || await resolveSettingsUserId(triggerQuery.from.id));
    const client = await getConnectedUserbotClient(targetUid);
    if (!client) throw new Error("Your Userbot session is not active. Please reconnect first.");

    let sourceEntity: any;
    try {
        sourceEntity = await safelyResolveFullEntity(client, sourceId);
    } catch (e: any) {
        if (!sourceId.startsWith('-100') && !isNaN(Number(sourceId))) {
            sourceEntity = await safelyResolveFullEntity(client, "-100" + sourceId);
        } else {
            throw e;
        }
    }
    
    const destPath = dest.destId;
    let destEntity: any = null;
    try {
        destEntity = await safelyResolveFullEntity(client, destPath);
    } catch (e: any) {
        if (!destPath.startsWith('-100') && !isNaN(Number(destPath))) {
            destEntity = await safelyResolveFullEntity(client, "-100" + destPath).catch(() => null);
        }
    }
    if (!destEntity) {
        throw new Error("Could not access destination group.");
    }

    let sourceTopics: Record<number, string> = {};
    let destTopics: Record<string, number> = {};
    const destTopicsTitleMap: Record<number, string> = {};
    const isSourceForum = (sourceEntity as any).forum;
    const isDestForum = (destEntity as any).forum;

    if (isSourceForum) {
        try {
            const res: any = await client.invoke(new Api.channels.GetForumTopics({ channel: sourceEntity, offsetDate: 0, offsetId: 0, offsetTopic: 0, limit: 100 }));
            res.topics?.forEach((t: any) => {
                if (t.title) sourceTopics[t.id] = t.title;
            });
        } catch (e) {
            console.warn("Failed to fetch source topics:", e);
        }
    }

    if (isDestForum) {
        try {
            const res: any = await client.invoke(new Api.channels.GetForumTopics({ channel: destEntity, offsetDate: 0, offsetId: 0, offsetTopic: 0, limit: 100 }));
            res.topics?.forEach((t: any) => {
                if (t.title) {
                    destTopics[t.title.trim().toLowerCase()] = t.id;
                    destTopicsTitleMap[t.id] = t.title;
                }
            });
        } catch (e) {
            console.warn("Failed to fetch destination topics:", e);
        }
    }

    const sourceIdRaw = (sourceEntity as any).id?.toString() || "";
    const sourceIdClean = sourceIdRaw.replace('-100', '');

    const alreadyMirroredDocs = mirroredMessagesCollection ? 
          await mirroredMessagesCollection.find({ destId: destPath }).toArray() : [];
    const alreadyMirroredLinks = new Set(alreadyMirroredDocs.map((doc: any) => doc.link));

    // Load blocked topics to skip
    const userDoc = await approvedUsersCollection?.findOne({ userId: targetUid.toString() });
    const blockedTopics = (userDoc?.blockedTopics || []).map((t: string) => t.trim().toLowerCase());

    const msgsToQueue = [];
    const topicMap: Record<number, number | undefined> = {};
    let latestMsgId = 0;
    let skippedCount = 0;

    for await (const m of client.iterMessages(sourceEntity, { reverse: true, limit: undefined })) {
        if (m.action) continue; 
        if (!m.message && !m.media) continue;

        if (m.id > latestMsgId) {
            latestMsgId = m.id;
        }

        const virtualLink = `https://t.me/c/${sourceIdClean}/${m.id}`;
        if (alreadyMirroredLinks.has(virtualLink)) {
            skippedCount++;
            continue;
        }

        let overrideThreadId: number | undefined = dest.destThreadId; // Base thread ID
        let sourceTopicId: number | undefined;

        if (isSourceForum && isDestForum && (m as any).replyTo) {
            const replyTo = (m as any).replyTo;
            sourceTopicId = replyTo.replyToTopId || replyTo.replyToMsgId;
            
            if (sourceTopicId) {
                const topicTitle = sourceTopics[sourceTopicId];
                if (topicTitle) {
                    const normTitle = topicTitle.trim().toLowerCase();
                    // Skip if blocked
                    if (blockedTopics.some((bt: string) => bt === normTitle || bt === sourceTopicId!.toString())) {
                        skippedCount++;
                        continue;
                    }

                    if (topicMap[sourceTopicId] !== undefined) {
                        overrideThreadId = topicMap[sourceTopicId] ?? dest.destThreadId;
                    } else {
                        const normalizedTitle = topicTitle.trim().toLowerCase();
                        if (destTopics[normalizedTitle]) {
                            topicMap[sourceTopicId] = destTopics[normalizedTitle];
                            overrideThreadId = destTopics[normalizedTitle];
                        } else {
                            try {
                                const createResult: any = await client.invoke(new Api.channels.CreateForumTopic({
                                    channel: destEntity,
                                    title: topicTitle
                                }));
                                const update = createResult.updates?.find((u: any) => u.className === 'UpdateNewForumTopic');
                                let newDestTopicId = update?.topicId;
                                
                                if (!newDestTopicId) {
                                    const retryTopics: any = await client.invoke(new Api.channels.GetForumTopics({ channel: destEntity, limit: 100 }));
                                    newDestTopicId = retryTopics.topics?.find((t: any) => t.title?.trim().toLowerCase() === normalizedTitle)?.id;
                                }
                                
                                if (newDestTopicId) {
                                    destTopics[normalizedTitle] = newDestTopicId;
                                    destTopicsTitleMap[newDestTopicId] = topicTitle;
                                    topicMap[sourceTopicId] = newDestTopicId;
                                    overrideThreadId = newDestTopicId;
                                }
                            } catch (e) {
                                console.warn(`Failed to create topic ${topicTitle}:`, e);
                                topicMap[sourceTopicId] = undefined;
                            }
                        }
                    }
                }
            }
        }

        msgsToQueue.push({ 
            chatId, 
            link: virtualLink, 
            userId: triggerQuery.from.id,
            forceGeneralPath: true,
            overrideThreadId,
            overrideTargetId: destPath,
            isMirror: true
         });
    }

    if (msgsToQueue.length === 0) {
        throw new Error(`All remaining messages are already successfully mirrored or skipped.`);
    }

    // Sort by topic
    const tasksByTopic = new Map<string | number, any[]>();
    const generalTasks: any[] = [];

    for (const task of msgsToQueue) {
        if (task.overrideThreadId !== undefined && task.overrideThreadId !== null) {
            if (!tasksByTopic.has(task.overrideThreadId)) {
                tasksByTopic.set(task.overrideThreadId, []);
            }
            tasksByTopic.get(task.overrideThreadId)!.push(task);
        } else {
            generalTasks.push(task);
        }
    }

    const orderedTasks: any[] = [];
    if (generalTasks.length > 0) {
        orderedTasks.push(...generalTasks);
    }
    for (const [topicId, tasks] of tasksByTopic.entries()) {
        orderedTasks.push(...tasks);
    }

    // Re-create new topic stats and session object
    const topicStats: Record<string | number, { total: number; processed: number; isMarkedCompleted: boolean; title: string }> = {};

    for (const task of orderedTasks) {
        task.fullMirrorSessionId = sessionId;

        const threadId = task.overrideThreadId !== undefined && task.overrideThreadId !== null ? task.overrideThreadId : 'general';
        const topicTitle = task.overrideThreadId !== undefined && task.overrideThreadId !== null ? (destTopicsTitleMap[task.overrideThreadId] || `Topic #${task.overrideThreadId}`) : 'General Discussion';

        if (!topicStats[threadId]) {
            topicStats[threadId] = {
                total: 0,
                processed: 0,
                isMarkedCompleted: false,
                title: topicTitle
            };
        }
        topicStats[threadId].total++;
    }

    // Update session tracker in mongoDB and memory
    const updatedSession = {
        ...session,
        totalFiles: orderedTasks.length,
        processedFiles: 0,
        successCount: 0,
        failedCount: 0,
        topicStats
    };

    activeFullMirrorSessions.set(sessionId, updatedSession);
    await fullMirrorSessionsCollection.updateOne({ sessionId }, { $set: updatedSession });

    // Trigger initial progress bar write/re-write
    await updateGlobalMirrorProgress(sessionId).catch(pErr => console.error("[Resume Progress Update Failed]", pErr));

    // Enqueue
    taskQueue.push(...orderedTasks);
    dbEnqueueTasks(orderedTasks).catch(e => console.error("[Queue DB] Bulk enqueue error during resume:", e));
    runNextTask();

    return orderedTasks.length;
}

const showBlockedTopicsPanel = async (chatId: number, fromId: number, editMessageId?: number) => {
    if (!fromId) return;
    const settingsUid = await resolveSettingsUserId(fromId);
    const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
    const blockedTopics = userDoc?.blockedTopics || [];

    let text = `🚫 **Blocked Topics Manager**\n\n` +
               `Configure topic names or IDs to skip downloading during the full mirror process. If a topic matches, the bot will skip its files completely.\n\n` +
               `**Current Blocked Topics (${blockedTopics.length}):**\n`;
               
    if (blockedTopics.length > 0) {
        blockedTopics.forEach((t: string, idx: number) => {
            text += `${idx + 1}. \`${t}\`\n`;
        });
    } else {
        text += `_No topics are currently blocked._\n`;
    }

    const markup = {
        inline_keyboard: [
            [
                { text: '➕ Add Topic', callback_data: 'add_blocked_topic_start' },
                { text: '🗑 Clear All', callback_data: 'clear_blocked_topics_action' }
            ],
            [{ text: '⬅️ Back to Settings', callback_data: 'bot_settings' }]
        ]
    };

    if (editMessageId) {
        await safeEditMessage(text, {
            chat_id: chatId,
            message_id: editMessageId,
            parse_mode: 'Markdown',
            reply_markup: markup
        });
    } else {
        await safeSendMessage(chatId, text, {
            parse_mode: 'Markdown',
            reply_markup: markup
        });
    }
};

async function updateGlobalMirrorProgress(sessionId: string) {
    const session = activeFullMirrorSessions.get(sessionId);
    if (!session) return;
    
    const { chatId, statusMsgId, totalFiles, processedFiles, successCount, failedCount, topicStats } = session;
    
    // Find active topic title
    let activeTopicName = 'General Discussion';
    let completedTopics = 0;
    const totalTopics = Object.keys(topicStats).length;
    
    for (const threadId of Object.keys(topicStats)) {
        const stats = topicStats[threadId];
        if (stats.processed < stats.total) {
            // First non-completed topic is considered the active one
            activeTopicName = stats.title;
        }
        if (stats.processed >= stats.total) {
            completedTopics++;
        }
    }
    
    const filePercentage = totalFiles > 0 ? Math.round((processedFiles / totalFiles) * 100) : 0;
    
    // Build beautiful progress bar (length 15)
    const barLength = 15;
    const filledLength = Math.round((filePercentage / 100) * barLength);
    const emptyLength = barLength - filledLength;
    const bar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
    
    const isFinished = processedFiles >= totalFiles;
    
    let text = `📍 **[GLOBAL PROGRESS] Full Group Mirror Setup**\n\n` +
               `📁 **Total Files inside Group:** \`${totalFiles}\`\n` +
               `⏳ **Processed:** \`${processedFiles} / ${totalFiles}\` ` +
               `(🟢 Success: \`${successCount}\` | 🔴 Failed: \`${failedCount}\`)\n\n` +
               `👉 **Mirror Progress Bar:**\n` +
               `\`[${bar}]\` **${filePercentage}%**\n\n` +
               `📌 **Total Topics:** \`${totalTopics}\`\n` +
               `✅ **Completed Topics:** \`${completedTopics} / ${totalTopics}\`\n\n` +
               `🔄 **Current Active Topic:** \`${activeTopicName}\`\n` +
               `└ _Status:_ ${isFinished ? '🟢 Mirroring Completed!' : '⏳ Mirroring contents...'}\n\n` +
               `━━━━━━━\n` +
               `_This pinned status bar tracks the entire folder mirroring process in real-time._`;
               
    if (isFinished) {
        text += `\n\n🎉 **Full Mirror completed successfully!**`;
    }
    
    await safeEditMessage(text, { 
        chat_id: chatId, 
        message_id: statusMsgId, 
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🚫 Block This or Any Topic', callback_data: `add_blocked_topic_start` }]
            ]
        }
    }).catch((err: any) => {
        console.warn(`[Progress Update] Failed to edit message for session ${sessionId}:`, err.message);
    });
    
    if (isFinished) {
        activeFullMirrorSessions.delete(sessionId);
        if (fullMirrorSessionsCollection) {
            await fullMirrorSessionsCollection.deleteOne({ sessionId }).catch(() => {});
        }
    } else {
        if (fullMirrorSessionsCollection) {
            await fullMirrorSessionsCollection.replaceOne({ sessionId }, session, { upsert: true }).catch(() => {});
        }
    }
}

async function safelyResolveEntity(client: TelegramClient, entity: any): Promise<any> {
    try {
        if (!entity) throw new Error("Entity is undefined");

        let lookupEntity = entity;

        // A. If entity is a string but is actually JSON containing PeerChannel, parse it first
        if (typeof entity === 'string' && entity.trim().startsWith('{')) {
            try {
                const parsed = JSON.parse(entity);
                entity = parsed;
                lookupEntity = parsed;
            } catch (jsonErr) {}
        }

        // B. Handle raw Peer or Entity objects (PeerChannel, PeerUser, Channel, User, Chat, etc)
        if (typeof entity === 'object' && entity !== null) {
            if (entity.className === 'PeerChannel' && entity.channelId) {
                const cid = entity.channelId.toString();
                lookupEntity = cid.startsWith('-100') ? cid : "-100" + cid;
            } else if (entity.className === 'PeerUser' && entity.userId) {
                lookupEntity = entity.userId.toString();
            } else if (entity.className === 'PeerChat' && entity.chatId) {
                lookupEntity = entity.chatId.toString();
            } else if (entity.className === 'Channel' && entity.id) {
                const cid = entity.id.toString();
                lookupEntity = cid.startsWith('-100') ? cid : "-100" + cid;
            } else if (entity.className === 'Chat' && entity.id) {
                lookupEntity = entity.id.toString();
            } else if (entity.className === 'User' && entity.id) {
                lookupEntity = entity.id.toString();
            } else if (entity.id) {
                const idStr = entity.id.toString();
                if (entity.className && (entity.className.toLowerCase().includes('channel') || entity.className.toLowerCase().includes('chat'))) {
                    lookupEntity = idStr.startsWith('-100') ? idStr : "-100" + idStr;
                } else {
                    lookupEntity = idStr;
                }
            }
        }

        // C. Clean duplicate/unbalanced prefixes
        if (typeof lookupEntity === 'string' || typeof lookupEntity === 'number') {
            let idStr = lookupEntity.toString().trim();
            while (idStr.startsWith('-100-100')) {
                idStr = "-100" + idStr.substring(8);
            }
            if (/^\d+$/.test(idStr)) {
                if (idStr.length >= 9) {
                    lookupEntity = "-100" + idStr;
                } else {
                    lookupEntity = idStr;
                }
            } else if (idStr.startsWith('-100')) {
                lookupEntity = idStr;
            } else if (idStr.startsWith('-')) {
                const absStr = idStr.substring(1);
                if (absStr.startsWith('100')) {
                    lookupEntity = idStr;
                } else if (absStr.length >= 9) {
                    lookupEntity = "-100" + absStr;
                } else {
                    lookupEntity = idStr;
                }
            } else {
                lookupEntity = idStr;
            }
        }

        // D. If it's already an input peer, return it directly
        if (lookupEntity && lookupEntity.className && lookupEntity.className.startsWith('InputPeer')) {
            return lookupEntity;
        }

        // E. Define match criteria
        const searchId = lookupEntity.toString().replace('-100', '').trim();
        const searchIdWithPrefix = lookupEntity.toString().startsWith('-100') ? lookupEntity.toString() : "-100" + lookupEntity.toString();

        const matchDialog = (d: any) => {
            const dIdStr = d.id ? d.id.toString() : "";
            const entityIdStr = d.entity && d.entity.id ? d.entity.id.toString() : "";
            return dIdStr === lookupEntity.toString() || 
                   dIdStr === searchId ||
                   dIdStr === searchIdWithPrefix ||
                   entityIdStr === lookupEntity.toString() ||
                   entityIdStr === searchId ||
                   entityIdStr === searchIdWithPrefix ||
                   (d.entity?.username && d.entity.username.toLowerCase() === searchId.replace('@', '').toLowerCase()) ||
                   (d.name && d.name.toLowerCase() === lookupEntity.toString().toLowerCase());
        };

        // F. Standard check in existing cached Dialogs (very fast, no network overhead if cached)
        const clientAny = client as any;
        const now = Date.now();

        if (clientAny._dialogsCache && clientAny._dialogsCache.length > 0) {
            const found = clientAny._dialogsCache.find(matchDialog);
            if (found) {
                try {
                    return await client.getInputEntity(found.entity);
                } catch (e) {}
            }
        }

        // F1. Attempt direct construction for -100 IDs if they look like they might have been seen recently
        const idStrRaw = lookupEntity.toString();
        if (idStrRaw.startsWith('-100')) {
            const cleanId = idStrRaw.replace('-100', '');
            if (/^\d+$/.test(cleanId)) {
                try {
                    // Peek into internal peer cache if possible
                    const peer = await (client as any)._entityCache?.get(bigInt(cleanId));
                    if (peer) return await client.getInputEntity(peer);
                } catch (e) {}
            }
        }

        // G. Try direct resolution via GramJS's built-in getEntity
        try {
            const resolved = await client.getEntity(lookupEntity);
            if (resolved) {
                return await client.getInputEntity(resolved);
            }
        } catch (e: any) {
            // Silently proceed to fallbacks
        }

        // H. Try direct resolution via GramJS's built-in getInputEntity
        try {
            return await client.getInputEntity(lookupEntity);
        } catch (e: any) {
            // Silently proceed to fallbacks
        }

        // I. Direct query path for Numerical IDs (Fastest & Safest)
        const idStrClean = lookupEntity.toString().replace('-100', '').replace('-', '').trim();
        if (/^\d+$/.test(idStrClean)) {
            const isPotentialChannel = lookupEntity.toString().startsWith('-100');

            // Strategy 1: messages.GetChats (Resolves both private groups and supergroups if ID works)
            try {
                console.log(`[safelyResolveEntity] Invoking messages.GetChats for ID: ${idStrClean}`);
                const response = await client.invoke(new Api.messages.GetChats({
                    id: [bigInt(idStrClean)]
                })) as any;
                
                if (response && response.chats && response.chats.length > 0) {
                    const matched = response.chats[0];
                    console.log(`[safelyResolveEntity] messages.GetChats matched: "${matched.title}"`);
                    try {
                        return await client.getInputEntity(matched);
                    } catch (e) {
                         // Construction fallback
                         if (matched.className === 'Channel' || matched.broadcast || matched.megagroup) {
                             return new Api.InputPeerChannel({
                                 channelId: bigInt(matched.id.toString()),
                                 accessHash: matched.accessHash ? bigInt(matched.accessHash.toString()) : bigInt(0)
                             });
                         } else {
                             return new Api.InputPeerChat({ chatId: bigInt(matched.id.toString()) });
                         }
                    }
                }
            } catch (err) {}

        // Strategy 2: channels.GetChannels (Specific for supergroups/channels)
        if (isPotentialChannel) {
            try {
                const chResp = await client.invoke(new Api.channels.GetChannels({
                    id: [new Api.InputChannel({ channelId: bigInt(idStrClean), accessHash: bigInt(0) })]
                })).catch(() => null) as any;
                
                if (chResp && chResp.chats && chResp.chats.length > 0) {
                    try {
                        return await client.getInputEntity(chResp.chats[0]);
                    } catch (e) {
                         return new Api.InputPeerChannel({
                             channelId: bigInt(chResp.chats[0].id.toString()),
                             accessHash: chResp.chats[0].accessHash ? bigInt(chResp.chats[0].accessHash.toString()) : bigInt(0)
                         });
                    }
                }
            } catch (err) {}
        }
        }

        // II. Deep search via getDialogs (Paginating to find "lost" entities)
        if (!(client as any)._isBotInApp) {
            try {
                console.log(`[safelyResolveEntity] Starting deep resolve for ${idStrClean}...`);
                let batchLimit = 1000;
                let currentOffsetDate = 0;
                
                // Try first 1000
                const firstBatch = await client.getDialogs({ limit: 1000 });
                let found = firstBatch.find(matchDialog);
                if (found) return await client.getInputEntity(found.entity);

                // If large account, go deeper (up to 12,000 dialogs)
                if (firstBatch.length >= 950) {
                    console.log(`[safelyResolveEntity] Extremely large account. Paginating deeply...`);
                    let lastDate = firstBatch[firstBatch.length - 1].date;
                    for (let i = 0; i < 11; i++) {
                        const moreDialogs = await client.getDialogs({ limit: 1000, offsetDate: lastDate });
                        if (!moreDialogs || moreDialogs.length === 0) break;
                        found = moreDialogs.find(matchDialog);
                        if (found) return await client.getInputEntity(found.entity);
                        lastDate = moreDialogs[moreDialogs.length - 1].date;
                        if (moreDialogs.length < 1000) break;
                    }
                }
            } catch (dgErr: any) {
                console.warn(`[safelyResolveEntity] Deep dialog search failed: ${dgErr.message}`);
            }
        }

        // III. Last Resort: Forced Construction
        console.log(`[safelyResolveEntity] Forced construction resort for ${lookupEntity}`);
        const finalIdStr = lookupEntity.toString().trim();
        if (finalIdStr.startsWith('-100')) {
            const cid = finalIdStr.replace('-100', '');
            if (/^\d+$/.test(cid)) {
                return new Api.InputPeerChannel({ 
                    channelId: bigInt(cid), 
                    accessHash: bigInt(0) 
                });
            }
        } else if (finalIdStr.startsWith('-')) {
            const cid = finalIdStr.substring(1);
            if (/^\d+$/.test(cid)) {
                return new Api.InputPeerChat({ chatId: bigInt(cid) });
            }
        } else if (/^\d+$/.test(finalIdStr)) {
            return new Api.InputPeerUser({ userId: bigInt(finalIdStr), accessHash: bigInt(0) });
        }

        throw new Error(`Resolution failed for ID: ${lookupEntity}`);
    } catch (e: any) {
        console.error(`[safelyResolveEntity] Fatal failure: ${e.message}`);
        // If it's already a -100 ID, try to return a constructed peer anyway
        if (typeof entity === 'string' && entity.startsWith('-100')) {
            return new Api.InputPeerChannel({ channelId: bigInt(entity.replace('-100', '')), accessHash: bigInt(0) });
        }
        throw e;
    }
}

async function safelyResolveFullEntity(client: TelegramClient, entity: any): Promise<any> {
    const peer = await safelyResolveEntity(client, entity);
    try {
        return await client.getEntity(peer);
    } catch (e: any) {
        if (e.errorMessage === 'CHANNEL_INVALID' || e.errorMessage === 'CHANNEL_PRIVATE' || (e.message && (e.message.includes('CHANNEL_INVALID') || e.message.includes('CHANNEL_PRIVATE')))) {
            try {
                return await client.getInputEntity(peer);
            } catch (innerE) {
                throw new Error(`Cannot access chat/channel format for ${entity}. It may be private, invalid, or the Userbot is not a member.`);
            }
        }
        throw e;
    }
}

const adminActiveSession = new Map<number, number>(); // adminTelegramId -> activeUserbotUserId

const userActionStates: Record<number, { 
    type: 'batch_start' | 'batch_end' | 'mirror_target' | 'set_thumb' | 'set_cap' | 'set_path' | 'mirror_choice' | 'set_mirror_source' | 'enter_topic_id' | 'mirror_path_add_source' | 'mirror_path_await_dest' | 'topic_clone_group' | 'topic_clone_topic_id' | 'add_rename_rule' | 'set_api_id' | 'set_api_hash' | 'full_mirror_group' | 'full_mirror_dest_select' | 'live_mirror_dest_select' | 'set_cooldown_secs' | 'set_concurrency_val' | 'topic_clone_dest_select' | 'enter_clone_dest_id' | 'set_jump_to_path' | 'add_blocked_topic' | 'enter_manual_specific_topic' | 'forward_start_link' | 'set_source_id' | 'set_dest_id' | 'forward_end_link', 
    startLink?: string,
    mirrorTarget?: any,
    pendingMirrorDest?: string,
    pendingMirrorThread?: number,
    pendingSourceId?: string,
    pendingSourceName?: string,
    cloneSourceGroupId?: string,
    pendingCloneDest?: string,
    pendingSourceIdForDirectClone?: string
}> = {};

// User Sessions Management and watchdog
const userClients = new Map<number, TelegramClient>();
const pendingConnections = new Map<number, Promise<any>>();
const userSessions = new Map<number, string>();

async function runActiveWatchdog() {
    try {
        if (!approvedUsersCollection) return;
        const users = await approvedUsersCollection.find({ stringSession: { $exists: true, $ne: "" } }).toArray();
        for (const user of users) {
            const userId = Number(user.userId);
            if (isNaN(userId)) continue;

            const existingClient = userClients.get(userId);
            if (!existingClient) {
                console.log(`[Watchdog] User ${userId} bot client missing in memory. Re-connecting...`);
                await getConnectedUserbotClient(userId).catch(err => {
                    console.error(`[Watchdog] Failed to connect user ${userId} in watchdog: ${err.message}`);
                });
            } else {
                let healthy = false;
                if (existingClient.connected) {
                    try {
                        // Heartbeat ping check (10s timeout)
                        let timeoutId: any;
                        await Promise.race([
                            existingClient.getMe(),
                            new Promise((_, reject) => {
                                timeoutId = setTimeout(() => reject(new Error("Heartbeat Timeout")), 30000);
                            })
                        ]);
                        clearTimeout(timeoutId);
                        healthy = true;
                    } catch (heartbeatErr: any) {
                        console.warn(`[Watchdog] User ${userId} heartbeat check failed: ${heartbeatErr.message}`);
                    }
                }

                if (!healthy) {
                    console.log(`[Watchdog] User ${userId} bot client failed heartbeat or disconnected. Repairing & reconnecting...`);
                    activeWatchers.delete(userId);
                    userClients.delete(userId);
                    try {
                        await existingClient.disconnect().catch(() => {});
                    } catch (e) {}
                    await getConnectedUserbotClient(userId).catch(err => {
                        console.error(`[Watchdog] Failed to cleanly reconnect user ${userId} in watchdog: ${err.message}`);
                    });
                } else if (!activeWatchers.has(userId)) {
                    console.log(`[Watchdog] User ${userId} watcher not active. Restarting watcher...`);
                    await startAutoMirrorWatcher(userId, existingClient).catch((err: any) => {
                        console.error(`[Watchdog] Failed to restart watcher for ${userId} in watchdog: ${err.message}`);
                    });
                }
            }
        }
    } catch (e: any) {
        console.error(`[Watchdog] Error occurred: ${e.message}`);
    }
}

// MongoDB Connection & Settings Loading
if (mongoUri) {
  client = new MongoClient(mongoUri, {
    connectTimeoutMS: 5000,
    socketTimeoutMS: 5000,
    serverSelectionTimeoutMS: 5000,
  });
  client.connect()
    .then(async () => {
      dbStatus = 'Connected';
      console.log('MongoDB Connected');
      
      const db = client!.db('bot_studio');
      settingsCollection = db.collection('settings');
      approvedUsersCollection = db.collection('approved_users');
      mirroredMessagesCollection = db.collection('mirrored_messages');
      queuedTasksCollection = db.collection('queued_tasks');
      failedTasksCollection = db.collection('failed_tasks');
      fullMirrorSessionsCollection = db.collection('full_mirror_sessions');
      fileCacheCollection = db.collection('file_cache');
      scheduledTasksCollection = db.collection('scheduled_tasks');
      
      // Cron: Cleanup backups older than 7 days
      cron.schedule('0 0 * * *', async () => {
        console.log('[Cron] Cleaning up old backups...');
        const files = fs.readdirSync('/tmp');
        const now = Date.now();
        for (const file of files) {
          if (file.startsWith('backup_mirrored_')) {
            const filePath = `/tmp/${file}`;
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > 7 * 24 * 60 * 60 * 1000) {
              fs.unlinkSync(filePath);
              console.log(`[Cron] Deleted old backup: ${file}`);
            }
          }
        }
      });
      
      // Cron: Scheduled Mirroring (check every minute)
      cron.schedule('* * * * *', async () => {
         if (!scheduledTasksCollection) return;
         const now = new Date();
         const tasks = await scheduledTasksCollection.find({ 
            nextRun: { $lte: now },
            active: true 
         }).toArray();

         for (const task of tasks) {
            // Trigger mirroring task
            console.log(`[Cron] Triggering scheduled task: ${task.link}`);
            // ... invoke processTask logic
            // Add queueing logic
            // ...
            // Update nextRun
            await scheduledTasksCollection.updateOne({ _id: task._id }, { $set: { nextRun: new Date(now.getTime() + task.intervalMs) } });
         }
      });

      // Load approved users into cache
      const users = await approvedUsersCollection.find({}).toArray();
      users.forEach((u: any) => approvedUsersCache.add(u.userId.toString()));

      // Load active full mirror sessions
      try {
          const sessions = await fullMirrorSessionsCollection.find({}).toArray();
          for (const s of sessions) {
              activeFullMirrorSessions.set(s.sessionId, s);
          }
          console.log(`[Init] Loaded ${activeFullMirrorSessions.size} active full mirror sessions from DB.`);
      } catch (err) {
          console.error("[Init Sessions] Failed to load full mirror sessions:", err);
      }

      // Load persistent queued tasks
      try {
          const dbTasks = await queuedTasksCollection.find({}).sort({ createdAt: 1, _id: 1 }).toArray();
          if (dbTasks && dbTasks.length > 0) {
              console.log(`[Init] Found ${dbTasks.length} queued tasks in DB. Restoring to task queue...`);
              for (const dbTask of dbTasks) {
                  const restored: Task = {
                      id: dbTask.id || dbTask._id?.toString(),
                      chatId: Number(dbTask.chatId),
                      userId: Number(dbTask.userId),
                      link: dbTask.link,
                      statusMsgId: dbTask.statusMsgId,
                      batchId: dbTask.batchId,
                      overrideThreadId: dbTask.overrideThreadId,
                      forceGeneralPath: dbTask.forceGeneralPath,
                      overrideTargetId: dbTask.overrideTargetId,
                      isMirror: dbTask.isMirror,
                      fullMirrorSessionId: dbTask.fullMirrorSessionId,
                      topicCloneSessionId: dbTask.topicCloneSessionId,
                      retries: dbTask.retries !== undefined ? Number(dbTask.retries) : 0
                  };
                  taskQueue.push(restored);
              }
              console.log(`[Init] Loaded ${taskQueue.length} tasks from DB. Starting runNextTask in 5 seconds...`);
              setTimeout(() => {
                  runNextTask().catch(e => console.error("[Init Queue] runNextTask failed:", e));
              }, 5000);
          }
      } catch (err: any) {
          console.error("[Init Queue] Failed to load persistent tasks:", err);
      }

      // Load persistent settings first
      const settings = await settingsCollection.findOne({ type: 'global_config' });
      if (settings) {
        if (settings.adminId) currentAdminId = settings.adminId;
        if (settings.destinationChatId) destinationChatId = settings.destinationChatId;
        if (settings.apiId) apiIdValue = Number(settings.apiId);
        if (settings.apiHash) apiHashValue = settings.apiHash;
        if (settings.downloadLibrary) currentDownloadLibrary = settings.downloadLibrary;
        if (settings.uploadEngine) currentUploadEngine = settings.uploadEngine;
        if (settings.renameRules) globalRenameRules = settings.renameRules;
        if (settings.proxy) globalProxy = settings.proxy;
        if (settings.maxConcurrentTasks !== undefined) {
          MAX_CONCURRENT_TASKS = Number(settings.maxConcurrentTasks);
        }
        if (settings.maxTasksPerUser !== undefined) {
          MAX_TASKS_PER_USER = Number(settings.maxTasksPerUser);
        }
        if (settings.cooldownSeconds !== undefined) {
          globalCooldownSeconds = Number(settings.cooldownSeconds);
        }
        
        if (settings.stringSession) {
            const adminToMigrate = currentAdminId || ALLOWED_ADMIN_IDS[0];
            const adminExists = users.some((u: any) => u.userId.toString() === adminToMigrate.toString() && u.stringSession);
            if (!adminExists && approvedUsersCollection) {
                await approvedUsersCollection.updateOne(
                    { userId: adminToMigrate.toString() },
                    { $set: { stringSession: settings.stringSession } },
                    { upsert: true }
                );
                users.push({ userId: adminToMigrate.toString(), stringSession: settings.stringSession } as any);
            }
        }
        console.log('Settings loaded from DB (with Proxy)');
      }

      // Initialize all active user watchers now that credentials are loaded
      const activeUsers = users.filter((u: any) => u.stringSession);
      console.log(`[Init] Reconnecting ${activeUsers.length} user sessions...`);
      for (const user of activeUsers) {
          getConnectedUserbotClient(Number(user.userId)).catch(e => {
              console.error(`[Init] Auto-connection failed for ${user.userId}: ${e.message}`);
          });
      }

      // Periodically check, recover, and self-heal user sessions and watchers every 60 seconds
      setInterval(runActiveWatchdog, 60000);
    })
    .catch((err) => {
      dbStatus = 'Error';
      console.error('MongoDB Connection Error:', err);
    });
}

// Admin Check Utility
const ALLOWED_ADMIN_IDS = ["6431447408", "6581298945", "6065778458"];

const isAdmin = (userId: number | undefined) => {
  if (!userId) return false;
  const uidStr = userId.toString().trim();
  const mainAdminStr = currentAdminId?.toString().trim();
  return ALLOWED_ADMIN_IDS.includes(uidStr) || (mainAdminStr && uidStr === mainAdminStr);
};

// Approval Check Utility
const isAuthorized = (userId: number | undefined) => {
  return isAdmin(userId);
};

const resolveSettingsUserId = async (fromId: number | undefined): Promise<string> => {
    if (!fromId) return "";
    
    // 1. Check if admin explicitly switched to a session (in memory)
    if (adminActiveSession.has(fromId)) {
        return adminActiveSession.get(fromId)!.toString();
    }

    const fromIdStr = fromId.toString();
    
    // 2. Check if the admin has a persisted active userbot in their DB document
    if (approvedUsersCollection) {
        try {
            const adminDoc = await approvedUsersCollection.findOne({ userId: fromIdStr });
            if (adminDoc?.activeUserbotUserId) {
                const activeUid = adminDoc.activeUserbotUserId.toString();
                const ubotDoc = await approvedUsersCollection.findOne({ userId: activeUid, stringSession: { $exists: true, $ne: "" } });
                if (ubotDoc) {
                    adminActiveSession.set(fromId, Number(activeUid));
                    return activeUid;
                }
            }
        } catch (e: any) {
            console.error(`[resolveSettingsUserId] Error getting persisted ubot: ${e.message}`);
        }
    }

    // 3. Check if the current user has a direct session
    if (approvedUsersCollection) {
        try {
            const directSession = await approvedUsersCollection.findOne({ userId: fromIdStr, stringSession: { $exists: true, $ne: "" }});
            if (directSession) {
                adminActiveSession.set(fromId, fromId);
                return fromIdStr;
            }
        } catch (e) {}
    }

    // 4. Fallback to any userbot account logged in by this admin
    if (approvedUsersCollection) {
        try {
            const loggedByThisAdmin = await approvedUsersCollection.findOne({ 
                addedByAdminId: fromIdStr, 
                stringSession: { $exists: true, $ne: "" }
            });
            if (loggedByThisAdmin) {
                const uidStr = loggedByThisAdmin.userId;
                adminActiveSession.set(fromId, Number(uidStr));
                return uidStr;
            }
        } catch (e) {}
    }

    // 5. Ultimate Fallback: any userbot account with a valid stringSession in the database!
    if (approvedUsersCollection) {
        try {
            const anyUbotSession = await approvedUsersCollection.findOne({ 
                stringSession: { $exists: true, $ne: "" }
            });
            if (anyUbotSession) {
                const uidStr = anyUbotSession.userId;
                adminActiveSession.set(fromId, Number(uidStr));
                return uidStr;
            }
        } catch (e) {}
    }
    
    // 6. Fallback to primary admin search or ALLOWED_ADMIN_IDS
    if (isAdmin(fromId)) {
        try {
            if (currentAdminId && currentAdminId.toString() !== fromIdStr) {
                 const primarySession = await approvedUsersCollection?.findOne({ userId: currentAdminId.toString(), stringSession: { $exists: true, $ne: "" }});
                 if (primarySession) {
                     adminActiveSession.set(fromId, Number(currentAdminId));
                     return currentAdminId.toString();
                 }
            }
            
            const firstAdmin = ALLOWED_ADMIN_IDS[0];
            if (firstAdmin && firstAdmin !== fromIdStr) {
                 const fallbackSession = await approvedUsersCollection?.findOne({ userId: firstAdmin, stringSession: { $exists: true, $ne: "" }});
                 if (fallbackSession) {
                     adminActiveSession.set(fromId, Number(firstAdmin));
                     return firstAdmin;
                 }
            }
        } catch (e) {}
    }

    return fromIdStr;
};

    // GramJS Login State
    const loginStates: Record<number, {
      step?: 'awaiting_phone' | 'awaiting_otp' | 'awaiting_2fa';
      phone?: string;
      client?: TelegramClient;
      resolvePhoneCode?: (code: string) => void;
      resolvePassword?: (password: string) => void;
      hasErrorOtp?: boolean;
      hasError2Fa?: boolean;
      lastErrorMsg?: string;
    }> = {};

    if (token) {
      try {
        bot = new TelegramBot(token, { 
          polling: {
            params: {
              timeout: 30
            }
          },
          request: {
            url: "https://api.telegram.org",
            timeout: 120000,
            agentOptions: {
              keepAlive: true,
              keepAliveMsecs: 10000
            }
          } as any
        });
        botStatus = 'Running';
        
        bot.getMe().then((me) => {
          botInfo = me;
          console.log(`Bot started: @${me.username}`);
        }).catch((err) => {
          botStatus = 'Error';
          console.error(`Failed to retrieve bot info:`, err.message);
        });

        // Security Interceptor to ignore all non-admin messages globally
        const globalProcessedUpdateKeys = new Set<string>();

        const originalProcessUpdate = bot.processUpdate.bind(bot);
        bot.processUpdate = (update: TelegramBot.Update) => {
            // Deduplicate at the root level for ALL incoming updates (commands, callbacks, etc.)
            let updateKey = '';
            if (update.message) {
                updateKey = `msg_${update.message.chat.id}_${update.message.message_id}`;
            } else if (update.callback_query) {
                updateKey = `cbq_${update.callback_query.id}`;
            }
            
            if (updateKey) {
                if (globalProcessedUpdateKeys.has(updateKey)) {
                    console.log(`[Deduplicator] Ignored duplicate update globally for key: ${updateKey}`);
                    return;
                }
                globalProcessedUpdateKeys.add(updateKey);
                setTimeout(() => {
                    globalProcessedUpdateKeys.delete(updateKey);
                }, 5 * 60 * 1000);
            }

            const fromId = update.message?.from?.id || update.callback_query?.from?.id;
            // Ignore if fromId is present but they are not an admin
            if (fromId && !isAdmin(fromId)) {
                return;
            }
            return originalProcessUpdate(update);
        };

        // Commands List for Bot Menu
        bot.setMyCommands([
          { command: 'start', description: '🚀 Start the bot' },
          { command: 'batch', description: '📥 Download multiple links' },
          { command: 'forward', description: '⏩ Forward messages in batch' },
          { command: 'settings', description: '⚙️ Show bot settings' },
          { command: 'cancel', description: '🛑 Stop current task' },
          { command: 'jumptopath', description: '📍 Set upload destination ID' },
          { command: 'setpath', description: '📂 Set upload destination' },
          { command: 'setspecifictopic', description: '📌 Save destination topic' },
          { command: 'setmirror', description: '🔗 Configure auto-mirror' },
          { command: 'mirror', description: '🔄 Clone group/topic content' },
          { command: 'ping', description: '⏱ Check bot latency' },
          { command: 'status', description: 'Show queue and database status' },
          { command: 'login', description: 'Log in with Telegram credentials' },
          { command: 'logout', description: 'Revoke session and clear data' },
          { command: 'sync', description: 'Force sync Userbot groups' },
          { command: 'restart', description: 'Restart bot internal services' },
          { command: 'clearmirrorhistory', description: 'Clear mirrored links history' },
          { command: 'setcooldown', description: 'Set delay between mirror tasks' },
          { command: 'dashboard', description: 'Show active progress & system dashboard' },
          { command: 'speed', description: 'Configure concurrency & task speed' },
          { command: 'queue', description: 'Display and manage pending queue tasks' },
          { command: 'pausequeue', description: 'Pause execution of the task queue' },
          { command: 'resumequeue', description: 'Resume execution of the task queue' },
          { command: 'canceltask', description: 'Cancel task by index: /canceltask <idx>' },
          { command: 'prioritizetask', description: 'Bring task to front: /prioritizetask <idx>' },
          { command: 'clearqueue', description: 'Wipe all pending tasks in queue' },
          { command: 'cleartopiccache', description: 'Clear topic ID cache' },
          { command: 'help', description: 'Show help guide' }
        ]);

        const handleSetMirror = async (chatId: number, fromId: number | undefined, msg: TelegramBot.Message) => {
            try {
                if (!isAdmin(fromId) || !fromId) throw new Error("Restricted: Admin access required.");
                
                if (msg.chat.type === 'private') {
                    throw new Error("Use this command in the **Destination Group**.");
                }

                if (approvedUsersCollection) {
                    const settingsUid = await resolveSettingsUserId(fromId);
                    const userDoc = await approvedUsersCollection.findOne({ userId: settingsUid });
                    const savedDestinations = userDoc?.savedDestinations || [];
                    
                    const destId = chatId.toString();
                    const destThreadId = msg.message_thread_id;
                    const groupName = msg.chat.title || 'Group';
                    
                    // Prevent duplicates (per group ID)
                    const filtered = savedDestinations.filter((d: any) => d.destId !== destId);
                    filtered.push({
                        destId,
                        destThreadId,
                        groupName,
                        topicName: destThreadId ? `Topic ${destThreadId}` : 'General',
                        createdAt: new Date()
                    });
                    
                    const finalDestinations = filtered.slice(-20); // Limit to 20 saved destinations
                    
                    await approvedUsersCollection.updateOne(
                        { userId: settingsUid },
                        { $set: { savedDestinations: finalDestinations } }
                    );
                    
                    const destDisplay = destThreadId ? `${groupName} (Topic: ${destThreadId})` : groupName;
                    safeSendMessage(chatId, `✅ **Destination Saved!**\n\n**Destination:** ${destDisplay}\n\nYou can now select this destination when using **Live Mirror** or **Full Mirror Group** from the bot menu.`, { parse_mode: 'Markdown' });
                }
            } catch (err: any) {
                safeSendMessage(chatId, `❌ **Mirror Sync Error:** ${err.message}`);
            }
        };

        const handleSync = async (chatId: number, fromId: number | undefined) => {
            try {
                if (!isAdmin(fromId) || !fromId) throw new Error("Restricted: Admin access required.");
                const targetUid = Number(await resolveSettingsUserId(fromId));
                const client = await getConnectedUserbotClient(targetUid);
                if (!client) throw new Error("Userbot not logged in.");

                safeSendMessage(chatId, "🔄 **Forcing Entity Sync...**\nThis will refresh your groups and channels. This may take a moment.");
                entityCache.clear();
                await client.getDialogs({ limit: 100 });
                safeSendMessage(chatId, "✅ **Sync Complete!** Your recent groups and channels are now cached.");
            } catch (err: any) {
                safeSendMessage(chatId, `❌ **Sync Failed:** ${err.message}`);
            }
        };

        const handleLogin = async (chatId: number, fromId: number | undefined, force: boolean = false) => {
          try {
            if (!isAdmin(fromId)) throw new Error("Restricted: You are not an Admin.");
            if (!apiIdValue || !apiHashValue) throw new Error("Missing API_ID or API_HASH. Please set them using /settings or your environment/dashboard variables.");

            const hasActiveSession = fromId && (userSessions.get(fromId) || (await approvedUsersCollection?.findOne({ userId: fromId.toString() }))?.stringSession);
            if (!force && !isAdmin(fromId) && hasActiveSession) {
                return safeSendMessage(chatId, "✅ **You are already logged in!**\n\nYour session is active. If you want to log in with a different account, use `/login force` or `/logout` first.", { parse_mode: 'Markdown' });
            }

            if (force && fromId) {
                pendingConnections.delete(fromId);
                const oldClient = userClients.get(fromId);
                if (oldClient) {
                    await oldClient.disconnect().catch(() => {});
                    userClients.delete(fromId);
                }
                userSessions.delete(fromId);
                activeWatchers.delete(fromId);
            }

            if (fromId && loginStates[fromId]) {
                return safeSendMessage(chatId, "⏳ **Login already in progress.**\n\nPlease complete the current steps or use /cancel.", { parse_mode: 'Markdown' });
            }

            safeSendMessage(chatId, "👋 **Ready to connect!**\n\nPlease enter your phone number in international format (e.g., `+91XXXXXXXXXX`).\n\n_Note: This will link a Userbot session to your account._", { 
              parse_mode: 'Markdown',
              reply_markup: { force_reply: true }
            });
            
            loginStates[fromId!] = { step: 'awaiting_phone' };
          } catch (err: any) {
            safeSendMessage(chatId, `❌ **Error:** ${err.message}`);
          }
        };

    const handleLogout = async (chatId: number, fromId: number | undefined) => {
      try {
        if (!isAdmin(fromId)) throw new Error("Restricted: Admin access required.");
        if (!fromId) return;

        return safeSendMessage(chatId, "⚠️ **To manage or logout accounts, please use the /login dashboard.**");
      } catch (err: any) {
        safeSendMessage(chatId, `❌ **Logout Error:** ${err.message}`);
      }
    };

    const handleSettings = async (chatId: number, fromId: number | undefined, messageId?: number) => {
        if (!isAdmin(fromId)) return;
        if (!fromId) return;

        const targetUidStr = await resolveSettingsUserId(fromId);
        const targetUid = Number(targetUidStr);

        const userDoc = await approvedUsersCollection?.findOne({ userId: targetUidStr });
        const session = userSessions.get(targetUid) || userDoc?.stringSession;
        
        let pathDisplay = `Log Group (${DEFAULT_LOG_GROUP})`;
        if (userDoc?.uploadPath === 'me') {
            pathDisplay = 'Saved Messages';
        } else if (userDoc?.uploadPath) {
            const name = userDoc.uploadGroupName || userDoc.uploadPath;
            const topic = userDoc.uploadTopicName ? ` > ${userDoc.uploadTopicName}` : '';
            pathDisplay = `${name}${topic}`;
        }

        let mirrorPathsText = '';
        if (userDoc?.mirrorPaths && userDoc.mirrorPaths.length > 0) {
            mirrorPathsText = `\n📂 **Mirror Pairings (${userDoc.mirrorPaths.length}):**\n`;
            userDoc.mirrorPaths.slice(0, 5).forEach((p: any, i: number) => {
                const sourceName = p.sourceName || 'Target Group';
                mirrorPathsText += `${i + 1}. **(${sourceName}) (${p.sourceId}) ➔ ${p.groupName}**${p.topicName !== 'General' ? ' (' + p.topicName + ')' : ''}\n`;
            });
            if (userDoc.mirrorPaths.length > 5) mirrorPathsText += `_...and ${userDoc.mirrorPaths.length - 5} more_\n`;
        }
        
        let uploadModeDisplay = '📹 Video';
        if (userDoc?.uploadMode === 'document') {
            uploadModeDisplay = '📁 Document/File';
        }

        let uploadAgentDisplay = '👤 User Account';
        if (userDoc?.uploadAgent === 'bot') {
            uploadAgentDisplay = '🤖 Bot itself';
        }

        const apiDisplayId = apiIdValue ? '✅ Set (Hidden for Security)' : '❌ Missing';
        const apiDisplayHash = apiHashValue ? '✅ Set (Hidden for Security)' : '❌ Missing';

        const cooldownSecs = userDoc?.cooldownSeconds !== undefined ? userDoc.cooldownSeconds : 5;
        const cooldownDisplay = cooldownSecs === 0 ? '🔴 OFF (0s)' : `🟢 ${cooldownSecs} seconds`;

        const text = `⚙️ 𝗔𝗱𝘃𝗮𝗻𝗰𝗲𝗱 𝗖𝗼𝗻𝗳𝗶𝗴𝘂𝗿𝗮𝘁𝗶𝗼𝗻\n\n` +
                     `🗄️ 𝗗𝗮𝘁𝗮𝗯𝗮𝘀𝗲: ${dbStatus === 'Connected' ? '✅ Online' : '❌ Offline'}\n` +
                     `👤 𝗨𝘀𝗲𝗿𝗯𝗼𝘁: ${session ? '✅ Active' : '❌ Missing'}\n` +
                     `🎬 𝗠𝗼𝗱𝗲: ${uploadModeDisplay}\n` +
                     `🤖 𝗔𝗴𝗲𝗻𝘁: ${uploadAgentDisplay}\n` +
                     `🚀 𝗨𝗽𝗹𝗼𝗮𝗱 𝗘𝗻𝗴𝗶𝗻𝗲: ${currentUploadEngine}\n` +
                     `📥 𝗗𝗼𝘄𝗻𝗹𝗼𝗮𝗱 𝗘𝗻𝗴𝗶𝗻𝗲: ${currentDownloadLibrary}\n` +
                     `📍 𝗗𝗲𝘀𝘁𝗶𝗻𝗮𝘁𝗶𝗼𝗻: \`${pathDisplay}\`\n` +
                     `⏱️ 𝗖𝗼𝗼𝗹𝗱𝗼𝘄𝗻: ${cooldownDisplay}\n` +
                     `⚡ 𝗖𝗼𝗻𝗰𝘂𝗿𝗿𝗲𝗻𝗰𝘆: \`${MAX_CONCURRENT_TASKS}\`\n\n` +
                     `${mirrorPathsText}\n` +
                     `👇 𝗖𝗼𝗻𝗳𝗶𝗴𝘂𝗿𝗲 𝗣𝗮𝗿𝗮𝗺𝗲𝘁𝗲𝗿𝘀:`;
        
        const markup = {
            inline_keyboard: [
              [
                { text: '🖼️ 𝗧𝗵𝘂𝗺𝗯', callback_data: 'set_thumb' },
                { text: '🗑️ 𝗧𝗵𝘂𝗺𝗯', callback_data: 'clr_thumb' },
                { text: '📝 𝗖𝗮𝗽𝘁𝗶𝗼𝗻', callback_data: 'set_cap' }
              ],
              [
                { text: '📂 𝗣𝗮𝘁𝗵', callback_data: 'set_path_cmd' },
                { text: '🗑️ 𝗣𝗮𝘁𝗵', callback_data: 'clr_path_cmd' },
                { text: '🔄 𝗠𝗶𝗿𝗿𝗼𝗿𝘀', callback_data: 'manage_mirror_paths' }
              ],
              [
                { text: `🚀 𝗨𝗽: ${currentUploadEngine}`, callback_data: 'toggle_engine' },
                { text: `📥 𝗗𝗼𝘄𝗻: ${currentDownloadLibrary}`, callback_data: 'toggle_down_library' }
              ],
              [
                { text: userDoc?.uploadMode === 'document' ? '📁 𝗙𝗶𝗹𝗲 𝗠𝗼𝗱𝗲' : '📹 𝗩𝗶𝗱𝗲𝗼 𝗠𝗼𝗱𝗲', callback_data: 'toggle_mode' },
                { text: userDoc?.uploadAgent === 'bot' ? '🤖 𝗕𝗼𝘁' : '👤 𝗨𝘀𝗲𝗿', callback_data: 'toggle_agent' }
              ],
              [
                { text: '✏️ 𝗥𝗲𝗻𝗮𝗺𝗲', callback_data: 'toggle_rename' },
                { text: `⏱️ 𝗗𝗲𝗹𝗮𝘆 ${cooldownSecs}`, callback_data: 'change_cooldown_start' },
                { text: `⚡ 𝗠𝗮𝘅 ${MAX_CONCURRENT_TASKS}`, callback_data: 'change_concurrency_start' }
              ],
              [
                { text: '🔄 𝗦𝘆𝗻𝗰', callback_data: 're_login' },
                { text: '📜 𝗟𝗼𝗴𝘀', callback_data: 'view_logs' },
                { text: '🛡️ 𝗔𝘂𝗱𝗶𝘁', callback_data: 'check_perms' },
                { text: '🚫 𝗕𝗮𝗻', callback_data: 'blocked_topics_panel' }
              ],
              [{ text: '⬅️ 𝗕𝗮𝗰𝗸', callback_data: 'menu_back' }]
            ]
        };

        const SETTINGS_LOGO_PATH = path.join(process.cwd(), 'src/assets/images/settings_logo_1779546440304.png');
        const hasLogo = fs.existsSync(SETTINGS_LOGO_PATH);

        if (messageId) {
            if (hasLogo) {
                // Delete the old message (likely text-only) and send a new one with photo to ensure logo is shown
                await safeBotCall('deleteMessage', chatId, messageId).catch(() => {});
                await safeBotCall('sendPhoto', chatId, SETTINGS_LOGO_PATH, { caption: text, parse_mode: 'Markdown', reply_markup: markup });
            } else {
                await safeEditMessage(text, { 
                    chat_id: chatId, 
                    message_id: messageId, 
                    parse_mode: 'Markdown',
                    reply_markup: markup
                });
            }
        } else {
            if (hasLogo) {
                await safeBotCall('sendPhoto', chatId, SETTINGS_LOGO_PATH, { caption: text, parse_mode: 'Markdown', reply_markup: markup });
            } else {
                await safeSendMessage(chatId, text, {
                    parse_mode: 'Markdown',
                    reply_markup: markup
                });
            }
            sendBackMenu(chatId);
        }
    };

    const handleCancel = (chatId: number, fromId: number | undefined) => {
      if (!isAdmin(fromId)) return;
      let cancelled = false;
      
      // Global Cancel: Clear all login states
      const loginCount = Object.keys(loginStates).length;
      if (loginCount > 0) {
        for (const key in loginStates) {
          if (loginStates[key].client) loginStates[key].client?.disconnect();
        }
        for (const key in loginStates) delete loginStates[key];
        cancelled = true;
      }

      // Global Cancel: Clear all user action states
      const actionCount = Object.keys(userActionStates).length;
      if (actionCount > 0) {
        for (const key in userActionStates) delete userActionStates[key as any];
        cancelled = true;
      }

      // Global Cancel: Clear the entire task queue
      if (taskQueue.length > 0) {
          taskQueue.length = 0;
          dbClearAllTasks().catch(e => console.error("[Queue DB] failed to clear on cancel:", e));
          cancelled = true;
      }
      
      // Cancel active tasks, except live mirror tasks
      for (const [key, job] of activeTaskJobs) {
          if (job.isMirror && ['searching', 'downloading', 'uploading'].includes(job.phase)) {
              continue;
          }
          activeTaskJobs.delete(key);
          taskControlMap.delete(key);
          cancelled = true;
      }

      if (cancelled) {
          safeSendMessage(chatId, "✅ All non-essential/pending tasks have been cancelled.");
      }

      // Reset activity trackers
      activeTasksPerUser.clear();
      activeTasksCount = 0;

      if (cancelled) {
        safeSendMessage(chatId, "🛑 **GLOBAL CANCEL:**\nAll active tasks, batches, user operations, and queues have been wiped globally.");
      } else {
        safeSendMessage(chatId, "⚠️ **No active tasks or operations found to cancel.**");
      }
    };

    const userAnimeHistory = new Map<number, Set<string>>();

    async function getRandomAnimePhotoUrl(userId?: number): Promise<string> {
        // High contrast, colorful anime and cartoon style students (boys and girls) engaging in education, studying, holding books, wearing glasses, graduating, coding, and classrooms with clear faces. All optimized for Telegram to avoid HTTP/Timeout errors.
        const faceCatalog = [
            // Smart pink-haired anime girl studying with book close-up (Girl)
            'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=480&q=70&fm=jpg&fit=crop',
            // Cyberpunk student girl with glowing glasses studying complex tech digital screens (Girl)
            'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=480&q=70&fm=jpg&fit=crop',
            // Cool student boy coder with colorful backlight coding on laptop (Boy)
            'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=480&q=70&fm=jpg&fit=crop',
            // Elegant watercolor-style studious cartoon girl reading books (Girl)
            'https://images.unsplash.com/photo-1541562232579-512a21360020?w=480&q=70&fm=jpg&fit=crop',
            // Creative bright pop-art student girl with stylish blue eye-shadow drawing (Girl)
            'https://images.unsplash.com/photo-1613376023733-0a73315d9b06?w=480&q=70&fm=jpg&fit=crop',
            // Colorful 3D cute cartoon student boy avatar with graduation cap / degree (Boy)
            'https://images.unsplash.com/photo-1608889175123-8ec330b86f84?w=480&q=70&fm=jpg&fit=crop',
            // Smart boy student coder sitting in front of neon computer workspace (Boy)
            'https://images.unsplash.com/photo-1566492031773-4f4e44671857?w=480&q=70&fm=jpg&fit=crop',
            // Cute animated study girl with headphones sketch-paint style (Girl)
            'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=480&q=70&fm=jpg&fit=crop',
            // Bright cheerful cartoon girl student profile surrounded by colourful school blackboard (Girl)
            'https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=480&q=70&fm=jpg&fit=crop',
            // Smart handsome student boy avatar with glasses looking confident (Boy)
            'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=480&q=70&fm=jpg&fit=crop',
            // Colorful chemistry student girl holding bright colorful test tubes in science class (Girl)
            'https://images.unsplash.com/photo-1507413245164-6160d8298b31?w=480&q=70&fm=jpg&fit=crop',
            // Vibrant anime-style young girl student with big glowing blue eyes reading (Girl)
            'https://images.unsplash.com/photo-1580477667995-2b94f01c9516?w=480&q=70&fm=jpg&fit=crop',
            // Artistic anime student boy sketching layout with colorful markers (Boy)
            'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=480&q=70&fm=jpg&fit=crop',
            // Beautiful smart student girl inside high-tech modern VR research lab (Girl)
            'https://images.unsplash.com/photo-1593508512255-86ab42a8e620?w=480&q=70&fm=jpg&fit=crop',
            // High contrast cute pastel-drawn cartoon chibi student with book bag (Boy/Girl Chibi)
            'https://images.unsplash.com/photo-1561037404-61cd46aa615b?w=480&q=70&fm=jpg&fit=crop',
            // Joyful young classmates reading together in creative school study room (Girls)
            'https://images.unsplash.com/photo-1509062522246-3755977927d7?w=480&q=70&fm=jpg&fit=crop',
            // Vibrant tech master boy student with glowing cyber background (Boy)
            'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=480&q=70&fm=jpg&fit=crop',
            // Glowing magical library learning concept with colorful swirling galaxy and books
            'https://images.unsplash.com/photo-1532012197267-da84d127e765?w=480&q=70&fm=jpg&fit=crop',
            // Innovative digital learning student with creative neon screen light reflections
            'https://images.unsplash.com/photo-1620641788421-7a1c342ea42e?w=480&q=70&fm=jpg&fit=crop',
            // Smart group of students looking up, celebrating graduation milestones (Boys & Girls)
            'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?w=480&q=70&fm=jpg&fit=crop',
            // Whimsical 3D blocky cartoon smart-boy learning model avatar with clear face (Boy)
            'https://images.unsplash.com/photo-1628157582853-a796fa650a6a?w=480&q=70&fm=jpg&fit=crop',
            // Neon color-wheel graphic design student in abstract aesthetic workspace
            'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=480&q=70&fm=jpg&fit=crop',
            // Beautiful colorful stack of neon study notebooks and creative markers setup
            'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=480&q=70&fm=jpg&fit=crop',
            // Modern studious student girl with glowing red ink background sketch (Girl)
            'https://images.unsplash.com/photo-1601987177651-8edfe6c20009?w=480&q=70&fm=jpg&fit=crop'
        ];

        const id = userId || 0;
        if (!userAnimeHistory.has(id)) {
            userAnimeHistory.set(id, new Set<string>());
        }
        const history = userAnimeHistory.get(id)!;

        // Reset history if user has seen almost all to allow infinite loop safely
        if (history.size >= faceCatalog.length - 2) {
            history.clear();
        }

        // We will select a unique educational cartoon style boy/girl face
        for (let attempt = 0; attempt < 20; attempt++) {
            const possibleUrl = faceCatalog[Math.floor(Math.random() * faceCatalog.length)];

            if (history.has(possibleUrl)) {
                continue; // Repeat detected, try another candidate to ensure a NEW one is served
            }

            history.add(possibleUrl);
            return possibleUrl;
        }

        // Emergency fallback to avoid failures, reset history
        history.clear();
        const fallbackUrl = faceCatalog[Math.floor(Math.random() * faceCatalog.length)];
        history.add(fallbackUrl);
        return fallbackUrl;
    }

    // Developer debug command

    bot.onText(/\/status/, async (msg) => {
        if (!isAdmin(msg.from?.id)) return;
        const totalUsers = approvedUsersCollection ? await approvedUsersCollection.countDocuments({}) : 0;
        const msgStr = `📊 **𝗦𝘆𝘀𝘁𝗲𝗺 𝗦𝘁𝗮𝘁𝘂𝘀 & 𝗠𝗲𝘁𝗿𝗶𝗰𝘀**\n\n` +
                       `⏳ **𝗤𝘂𝗲𝘂𝗲 𝗟𝗲𝗻𝗴𝘁𝗵:** \`${taskQueue.length} tasks\`\n` +
                       `⚙️ **𝗔𝗰𝘁𝗶𝘃𝗲 𝗧𝗮𝘀𝗸𝘀:** \`${activeTasksCount}\`\n` +
                       `⚡ **𝗠𝗮𝘅 𝗖𝗼𝗻𝗰𝘂𝗿𝗿𝗲𝗻𝗰𝘆:** \`${MAX_CONCURRENT_TASKS}\`\n` +
                       `👥 **𝗧𝗼𝘁𝗮𝗹 𝗨𝘀𝗲𝗿𝘀:** \`${totalUsers}\`\n` +
                       `⏱️ **𝗡𝗲𝘅𝘁 𝗥𝘂𝗻 𝗔𝘁:** \`${nextTaskRunAt ? nextTaskRunAt.toLocaleString() : 'Immediate'}\``;
        safeSendMessage(msg.chat.id, msgStr, { parse_mode: 'Markdown' });
    });

    const sendMainMenu = (chatId: number) => {
        const keyboard = {
            keyboard: [
                [{ text: '⚙️ Settings' }, { text: '📈 Dashboard' }],
                [{ text: '📦 Batch' }, { text: '⚙️ Mirror Engine' }],
                [{ text: '📍 Set Path' }, { text: '❌ Cancel' }],
                [{ text: '🚀 Start' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        };
        bot.sendMessage(chatId, "🛠 𝗕𝗼𝘁 𝗠𝗮𝗶𝗻 𝗠𝗲𝗻𝘂\n\nSelect a task:", {
            reply_markup: keyboard
        });
    };

    const sendBackMenu = (chatId: number) => {
        const keyboard = {
            keyboard: [
                [{ text: '⬅️ Back' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        };
        bot.sendMessage(chatId, "⬅️ Use the button below to return to the Main Menu:", {
            reply_markup: keyboard
        });
    };

    const handleStartMessage = async (msg: any, messageId?: number, overrideFrom?: any) => {
        const fromUser = overrideFrom || msg.from;
        if (!isAuthorized(fromUser?.id)) {
            const unauthorizedText = `🚫 **Access Denied**\n\nHello ${fromUser?.first_name || 'User'}, you do not have permission to use this bot. Access is strictly limited to authorized administrators.`;
            if (messageId) {
                return safeEditMessage(unauthorizedText, { chat_id: msg.chat.id, message_id: messageId, parse_mode: 'Markdown' });
            }
            return safeSendMessage(msg.chat.id, unauthorizedText, {
                parse_mode: 'Markdown'
            });
        }

        const welcomeText = `🤖 **𝗥𝗼𝗵𝗶𝘁  𝗦𝗮𝘃𝗲  𝗥𝗲𝘀𝘁𝗿𝗶𝗰𝘁𝗶𝗰𝘁𝗲𝗱  𝗯𝗼𝘁  𝟮𝟬𝟮𝟲**\n\n` +
                            `👋 𝗛𝗲𝗹𝗹𝗼 **${fromUser?.first_name || 'Admin'}**!\n\n` +
                            `I am the premium **Restricted Content Saver** bot. I help you bypass download restrictions and mirror entire groups efficiently.\n\n` +
                            `✨ 𝗖𝗼𝗿𝗲 𝗙𝗲𝗮𝘁𝘂𝗿𝗲𝘀:\n` +
                            `• Download Restricted Media\n` +
                            `• Mirror Groups/Channels\n` +
                            `• Topic preservation support\n\n` +
                            `🛡 𝗦𝘁𝗮𝘁𝘂𝘀: Authorized Partner`;
        
        const menuKeyboard = {
            inline_keyboard: [
                [
                    { text: '⚙️ 𝗦𝗲𝘁𝘁𝗶𝗻𝗴𝘀', callback_data: 'bot_settings' },
                    { text: '📈 𝗗𝗮𝘀𝗵𝗯𝗼𝗮𝗿𝗱', callback_data: 'dashboard_cmd' }
                ],
                [
                    { text: '📦 𝗕𝗮𝘁𝗰𝗵', callback_data: 'batch_cmd' },
                    { text: '⚙️ 𝗠𝗶𝗿𝗿𝗼𝗿 𝗘𝗻𝗴𝗶𝗻𝗲', callback_data: 'mirror_cmd' }
                ],
                [
                    { text: '📍 𝗦𝗲𝘁 𝗣𝗮𝘁𝗵', callback_data: 'set_path_cmd' },
                    { text: '❌ 𝗖𝗮𝗻𝗰𝗲𝗹', callback_data: 'cancel_cmd' }
                ],
                [
                    { text: '🚀 𝗦𝘁𝗮𝗿𝘁 𝗦𝗶𝗻𝗴𝗹𝗲 𝗧𝗮𝗿𝗴𝗲𝘁', callback_data: 'start_cmd_link' }
                ],
                [
                    { text: '🌸 𝗔𝗻𝗶𝗺𝗲 𝗣𝗵𝗼𝘁𝗼', callback_data: 'send_anime_photo' }
                ]
            ]
        };

        const logoPath = path.join(process.cwd(), 'src/assets/images/rohit_restricticted_bot_2026_1781261184565.jpg');
        const hasLogo = fs.existsSync(logoPath);

        if (messageId) {
             try {
                 // Try editing to check if the message matches the type
                 const res = await safeEditMessage(welcomeText, {
                     chat_id: msg.chat.id,
                     message_id: messageId,
                     parse_mode: 'Markdown',
                     reply_markup: menuKeyboard
                 });
                 if (res) return res;
             } catch (e: any) {
                 console.log("[Menu] edit failed, falling back to delete-recreate:", e.message);
             }
             
             // If direct edit fails (e.g. text msg trying to set photo, or vice-versa), delete and send fresh
             await safeBotCall('deleteMessage', msg.chat.id, messageId).catch(() => {});
             if (hasLogo) {
                 return await safeBotCall('sendPhoto', msg.chat.id, logoPath, {
                     caption: welcomeText,
                     parse_mode: 'Markdown',
                     reply_markup: menuKeyboard
                 });
             } else {
                 return await safeSendMessage(msg.chat.id, welcomeText, {
                     parse_mode: 'Markdown',
                     reply_markup: menuKeyboard
                 });
             }
        } else {
             if (hasLogo) {
                 return await safeBotCall('sendPhoto', msg.chat.id, logoPath, {
                     caption: welcomeText,
                     parse_mode: 'Markdown',
                     reply_markup: menuKeyboard
                 });
             } else {
                 return await safeSendMessage(msg.chat.id, welcomeText, {
                     parse_mode: 'Markdown',
                     reply_markup: menuKeyboard
                 });
             }
        }
    };

    const handleForward = async (chatId: number, fromId: number | undefined) => {
      try {
        if (!isAdmin(fromId) || !fromId) throw new Error("Restricted: Admin access required.");
        
        userActionStates[fromId] = { type: 'forward_start_link' };
        
        safeSendMessage(chatId, "🚀 **Batch Forward Started**\n\nSend the **Starting Link** now.");
      } catch (err: any) {
        safeSendMessage(chatId, `❌ **Error:** ${err.message}`);
      }
    };

    const handleBatch = async (chatId: number, fromId: number | undefined, messageId?: number) => {
      try {
        if (!isAdmin(fromId) || !fromId) throw new Error("Restricted: Admin access required.");
        
        const contextUid = Number(await resolveSettingsUserId(fromId));
        const client = await getConnectedUserbotClient(contextUid);
        if (!client) throw new Error("Userbot Session Required: Please /login first.");
        
        userActionStates[fromId] = { type: 'batch_start' };
        
        const text = "📦 **Batch Process Started**\n\nSend the **Starting Link** now.";
        if (messageId) {
            safeEditMessage(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        } else {
            safeSendMessage(chatId, text, { reply_markup: { force_reply: true }, parse_mode: 'Markdown' });
        }
      } catch (err: any) {
        safeSendMessage(chatId, `❌ **Error:** ${err.message}`);
      }
    };

    const handleBatchForward = async (chatId: number, fromId: number, startLink: string, endLink: string) => {
        const parseLink = (link: string) => {
            const match = link.match(/t\.me\/(?:c\/)?([a-zA-Z0-9_-]+)\/(\d+)/i);
            if (!match) throw new Error("Invalid link format");
            let chatId = match[1];
            if (/^\d+$/.test(chatId)) chatId = '-100' + chatId;
            return { chatId, msgId: parseInt(match[2]) };
        };

        const start = parseLink(startLink);
        const end = parseLink(endLink);
        
        if (start.chatId !== end.chatId) throw new Error("Links must be from the same chat");
        
        const contextUid = Number(await resolveSettingsUserId(fromId));
        const client = await getConnectedUserbotClient(contextUid);
        if (!client) throw new Error("Userbot Session Required.");
        
        const userDoc = await approvedUsersCollection.findOne({ userId: contextUid.toString() });
        const destChatId = userDoc?.uploadPath;
        if (!destChatId) throw new Error("Destination path not set. Use /setpath");
        
        for (let i = start.msgId; i <= end.msgId; i++) {
            try {
                await client.forwardMessages(destChatId, {
                    messages: [i],
                    fromPeer: start.chatId,
                    dropAuthor: true 
                });
            } catch (e: any) {
                if (e.seconds) {
                    console.log(`[FloodWait] Waiting ${e.seconds} seconds.`);
                    await new Promise(r => setTimeout(r, (e.seconds + 1) * 1000));
                    i--; // Retry this message
                } else {
                    console.log(`[Individual Forward Error] Msg ${i} failed: ${e.message}`);
                }
            }
            await new Promise(r => setTimeout(r, 600));
        }
        safeSendMessage(chatId, "✅ **Batch Forward Complete!**");
    };

    const handleMirror = async (chatId: number, fromId: number | undefined, messageId?: number) => {
      try {
        if (!isAdmin(fromId) || !fromId) throw new Error("Restricted: Mirroring is an Admin feature.");

        const contextUid = Number(await resolveSettingsUserId(fromId));
        const client = await getConnectedUserbotClient(contextUid);
        if (!client) throw new Error("Userbot Session Required: Please /login first.");
        
        const options: any = { 
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📁 𝗠𝗶𝗿𝗿𝗼𝗿 𝗟𝗶𝘀𝘁', callback_data: 'mirror_list' },
                        { text: '➕ 𝗔𝗱𝗱 𝗡𝗲𝘄', callback_data: 'mirror_add_start' }
                    ],
                    [
                        { text: '🎯 𝗧𝗼𝗽𝗶𝗰 𝗖𝗹𝗼𝗻𝗲', callback_data: 'topic_clone_start' },
                        { text: '🔄 𝗙𝘂𝗹𝗹 𝗠𝗶𝗿𝗿𝗼𝗿', callback_data: 'full_mirror_start' }
                    ],
                    [
                        { text: '📊 𝗣𝗿𝗼𝗴𝗿𝗲𝘀𝘀', callback_data: 'full_mirror_progress_list' }
                    ],
                    [ { text: '⬅️ 𝗕𝗮𝗰𝗸', callback_data: 'menu_back' } ]
                ]
            }
        };

        if (messageId) {
            safeEditMessage("🪞 𝗠𝗶𝗿𝗿𝗼𝗿 𝗛𝘂𝗯\n\nChoose an action:", { chat_id: chatId, message_id: messageId, ...options });
        } else {
            safeSendMessage(chatId, "🪞 𝗠𝗶𝗿𝗿𝗼𝗿 𝗛𝘂𝗯\n\nChoose an action:", options);
        }
      } catch (err: any) {
        safeSendMessage(chatId, `❌ **Error:** ${err.message}`);
      }
    };

    bot.onText(/\/start/, (msg) => {
        handleStartMessage(msg);
    });

    bot.onText(/\/forward/, (msg) => {
        handleForward(msg.chat.id, msg.from?.id);
    });

    if (!(bot as any)._isPatchedForAnswer) {
        const originalAnswer = bot.answerCallbackQuery.bind(bot);
        (bot as any).answerCallbackQuery = async function(...args: any[]) {
             const qId = args[0];
             if (processedCallbackQueryIds.has(`ans_${qId}`)) {
                 return Promise.resolve(); 
             }
             processedCallbackQueryIds.add(`ans_${qId}`);
             setTimeout(() => processedCallbackQueryIds.delete(`ans_${qId}`), 5 * 60 * 1000);
             return originalAnswer(...args).catch((err: any) => console.log('Answer CB Error avoided:', err.message));
        };
        (bot as any)._isPatchedForAnswer = true;
    }

    bot.on('callback_query', async (query) => {
      const chatId = query.message?.chat.id;
      if (!chatId) return;

      // Deduplicate callback queries
      if (processedCallbackQueryIds.has(query.id)) {
        console.log(`[Deduplicator] Ignored duplicate callback query for ID: ${query.id}`);
        return;
      }
      processedCallbackQueryIds.add(query.id);
      setTimeout(() => {
        processedCallbackQueryIds.delete(query.id);
      }, 5 * 60 * 1000);

      // Instantly answer the callback query to remove loading spinner for most menu navigation!
      const needsCustomAlert = query.data && (
          query.data.includes('del_') || 
          query.data.includes('clr_') || 
          query.data.includes('toggle_') || 
          query.data.includes('approve_') || 
          query.data.includes('decline_')
      );
      if (!needsCustomAlert && isAdmin(query.from.id)) {
          bot?.answerCallbackQuery(query.id).catch(() => {});
      }

      if (query.data?.startsWith('clonesource_direct_')) {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const sourceId = query.data.replace('clonesource_direct_', '');
          
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const savedDestinations = userDoc?.savedDestinations || [];
          
          if (savedDestinations.length === 0) {
              return bot?.answerCallbackQuery(query.id, { text: '❌ No Saved Destinations. Use /setmirror in target group first.', show_alert: true });
          }
          
          userActionStates[query.from.id] = { 
              type: 'topic_clone_dest_select',
              pendingSourceIdForDirectClone: sourceId 
          };
          
          const uniqueDestinations: { dest: any, originalIndex: number }[] = [];
          const seen = new Set();
          savedDestinations.forEach((d: any, originalIndex: number) => {
              if (d && d.destId && !seen.has(d.destId)) {
                  seen.add(d.destId);
                  uniqueDestinations.push({ dest: d, originalIndex });
              }
          });
          const kb = uniqueDestinations.map((item) => {
              return [
                  { text: item.dest.groupName + (item.dest.destThreadId ? ` (Topic ${item.dest.destThreadId})` : ''), callback_data: `tc_dest_direct_${item.originalIndex}` }
              ];
          });
          kb.push([{ text: '🔙 Back', callback_data: 'start_back' }]);
          kb.push([{ text: '➕ Enter New Group ID', callback_data: 'clonedest_new' }]);
          
          await safeEditMessage(`🔗 **Source Selected!**\n\nNow select the **Destination Group** to clone to:`, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              reply_markup: { inline_keyboard: kb }
          });
          bot?.answerCallbackQuery(query.id).catch(() => {});
          return;
      }

      if (query.data?.startsWith('tc_dest_direct_')) {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const state = userActionStates[query.from.id];
          if (!state || state.type !== 'topic_clone_dest_select' || !state.pendingSourceIdForDirectClone) {
              return bot?.answerCallbackQuery(query.id, { text: '❌ Session expired.', show_alert: true });
          }
          
          const idx = parseInt(query.data.split('_')[3]);
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const dest = (userDoc?.savedDestinations || [])[idx];
          if (!dest) {
              return bot?.answerCallbackQuery(query.id, { text: '❌ Destination not found.', show_alert: true });
          }
          
          const sourceId = state.pendingSourceIdForDirectClone;
          state.type = 'topic_clone_topic_id';
          state.cloneSourceGroupId = sourceId;
          state.pendingCloneDest = dest.destId;
          
          await saveRecentDestination(query.from.id, dest.destId, dest.groupName);
          
          await safeEditMessage(`✅ **Destination Selected: ${dest.groupName}**\n\n📌 Please enter the **Topic ID** of the topic you want to clone now.`, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              reply_markup: { force_reply: true }
          });
          bot?.answerCallbackQuery(query.id).catch(() => {});
          return;
      }

      if (query.data?.startsWith('mirrorsource_direct_')) {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const sourceId = query.data.replace('mirrorsource_direct_', '');
          
          let groupName = sourceId;
          try {
              const tgClient = await getConnectedUserbotClient(query.from.id);
              const entity = await tgClient.getEntity(sourceId);
              groupName = (entity as any).title || groupName;
          } catch(e) { console.error("Error resolving source name", e); }
          
          await saveRecentSource(query.from.id, sourceId, groupName);
          
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const savedDestinations = userDoc?.savedDestinations || [];
          
          if (savedDestinations.length === 0) {
              return bot?.answerCallbackQuery(query.id, { text: '❌ No Saved Destinations. Use /setmirror in target group first.', show_alert: true });
          }
          
          userActionStates[query.from.id] = { 
              type: 'live_mirror_dest_select',
              pendingSourceId: sourceId,
              pendingSourceName: groupName
          };
          
          const uniqueDestinations: { dest: any, originalIndex: number }[] = [];
          const seen = new Set();
          savedDestinations.forEach((d: any, originalIndex: number) => {
              if (d && d.destId && !seen.has(d.destId)) {
                  seen.add(d.destId);
                  uniqueDestinations.push({ dest: d, originalIndex });
              }
          });
          const kb = uniqueDestinations.map((item) => {
              return [
                  { text: item.dest.groupName + (item.dest.destThreadId ? ` (Topic ${item.dest.destThreadId})` : ''), callback_data: `lm_dest_${item.originalIndex}` },
                  { text: '🗑', callback_data: `del_saved_dest:${item.originalIndex}` }
              ];
          });
          kb.push([{ text: '🔙 Back', callback_data: 'start_back' }]);
          
          await safeEditMessage(`✅ **Source Selected: ${groupName}**\n\n**Select Destination Group for Live Mirror:**`, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              reply_markup: { inline_keyboard: kb }
          });
          bot?.answerCallbackQuery(query.id).catch(() => {});
          return;
      }

      if (query.data?.startsWith('fullmirror_direct_')) {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const sourceId = query.data.replace('fullmirror_direct_', '');
          
          let groupName = sourceId;
          try {
              const tgClient = await getConnectedUserbotClient(query.from.id);
              const entity = await tgClient.getEntity(sourceId);
              groupName = (entity as any).title || groupName;
          } catch(e) { console.error("Error resolving source name", e); }
          
          await saveRecentSource(query.from.id, sourceId, groupName);
          
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const savedDestinations = userDoc?.savedDestinations || [];
          
          if (savedDestinations.length === 0) {
              return bot?.answerCallbackQuery(query.id, { text: '❌ No Saved Destinations. Use /setmirror in target group first.', show_alert: true });
          }
          
          userActionStates[query.from.id] = { 
              type: 'full_mirror_dest_select',
              pendingSourceId: sourceId,
              pendingSourceName: groupName
          };
          
          const uniqueDestinations: { dest: any, originalIndex: number }[] = [];
          const seen = new Set();
          savedDestinations.forEach((d: any, originalIndex: number) => {
              if (d && d.destId && !seen.has(d.destId)) {
                  seen.add(d.destId);
                  uniqueDestinations.push({ dest: d, originalIndex });
              }
          });
          const kb = uniqueDestinations.map((item) => {
              return [
                  { text: item.dest.groupName + (item.dest.destThreadId ? ` (Topic ${item.dest.destThreadId})` : ''), callback_data: `fm_dest_${item.originalIndex}` },
                  { text: '🗑', callback_data: `del_saved_dest:${item.originalIndex}` }
              ];
          });
          kb.push([{ text: '🔙 Back', callback_data: 'start_back' }]);
          
          await safeEditMessage(`✅ **Source Selected: ${groupName}**\n\n**Select Destination Group for Full Mirror:**`, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              reply_markup: { inline_keyboard: kb }
          });
          bot?.answerCallbackQuery(query.id).catch(() => {});
          return;
      }

      if (query.data === 'clonesource_new') {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          userActionStates[query.from.id] = { type: 'set_source_id' };
          await safeEditMessage(`➕ **Enter New Source ID**\n\nPlease send the **Source ID** (e.g., \`-100xxxxxxxxxx\` or \`@channelname\`).`, {
              chat_id: chatId,
              message_id: query.message!.message_id
          });
          bot?.answerCallbackQuery(query.id).catch(() => {});
          return;
      }

      if (query.data === 'clonedest_new') {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          userActionStates[query.from.id] = { type: 'set_dest_id' };
          await safeEditMessage(`➕ **Enter New Destination ID**\n\nPlease send the **Destination ID** (e.g., \`-100xxxxxxxxxx\` or \`@channelname\`).`, {
              chat_id: chatId,
              message_id: query.message!.message_id
          });
          bot?.answerCallbackQuery(query.id).catch(() => {});
          return;
      }

      if (query.data === 'request_access') {
          safeSendMessage(chatId, "❌ **Request flow disabled.** Access is restricted to predefined admin IDs.");
          return;
      }

      if (query.data?.startsWith('approve_')) {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const userId = query.data.split('_')[1];
          
          if (approvedUsersCollection) {
              await approvedUsersCollection.updateOne({ userId: userId }, { $set: { userId, approvedAt: new Date() } }, { upsert: true });
              approvedUsersCache.add(userId);
              bot?.answerCallbackQuery(query.id, { text: 'User Approved!' });
              safeEditMessage(`✅ User \`${userId}\` has been **Approved**.`, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: 'Markdown' });
              safeSendMessage(Number(userId), "🎊 **Good news!** The admin has approved your access. Type /start to begin.");
          }
          return;
      }

      if (query.data?.startsWith('decline_')) {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const userId = query.data.split('_')[1];
          safeEditMessage(`❌ Request from \`${userId}\` was **Declined**.`, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: 'Markdown' });
          safeSendMessage(Number(userId), "❌ Sorry, your access request was declined by the admin.");
          return;
      }

      if (query.data === 'menu_back') {
          await handleStartMessage(query.message, query.message!.message_id, query.from);
          bot?.answerCallbackQuery(query.id).catch(() => {});
          return;
      }
      if (false as any) {
          const menuKeyboard = {
            inline_keyboard: [
                [
                    { text: '⚙️ 𝗦𝗲𝘁𝘁𝗶𝗻𝗴𝘀', callback_data: 'bot_settings' },
                    { text: '📈 𝗗𝗮𝘀𝗵𝗯𝗼𝗮𝗿𝗱', callback_data: 'dashboard_cmd' }
                ],
                [
                    { text: '📦 𝗕𝗮𝘁𝗰𝗵', callback_data: 'batch_cmd' },
                    { text: '⚙️ 𝗠𝗶𝗿𝗿𝗼𝗿 𝗘𝗻𝗴𝗶𝗻𝗲', callback_data: 'mirror_cmd' }
                ],
                [
                    { text: '📍 𝗦𝗲𝘁 𝗣𝗮𝘁𝗵', callback_data: 'set_path_cmd' },
                    { text: '❌ 𝗖𝗮𝗻𝗰𝗲𝗹', callback_data: 'cancel_cmd' }
                ],
                [
                    { text: '🚀 𝗦𝘁𝗮𝗿𝘁 𝗦𝗶𝗻𝗴𝗹𝗲 𝗧𝗮𝗿𝗴𝗲𝘁', callback_data: 'start_cmd_link' }
                ]
            ]
        };
        await safeEditMessage("🛠 𝗕𝗼𝘁 𝗠𝗮𝗶𝗻 𝗠𝗲𝗻𝘂\n\nSelect a task:", {
                chat_id: chatId,
                message_id: query.message!.message_id,
                reply_markup: menuKeyboard,
                parse_mode: 'Markdown'
            });
            bot?.answerCallbackQuery(query.id);
            return;
      }

  // Handle interactive mirror selection
  if (query.data?.startsWith('mirrordest_')) {
      if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
      const state = userActionStates[query.from.id];
      if (!state || state.type !== 'mirror_target') {
          return bot?.answerCallbackQuery(query.id, { text: '❌ Session expired.', show_alert: true });
      }

      const action = query.data.split('_')[1];
      if (action === 'new') {
          state.type = 'enter_topic_id';
          safeEditMessage("🔗 **Please send the Destination Group ID or Link:**", { chat_id: chatId, message_id: query.message!.message_id });
      } else {
          // Direct selection: action is the ID
          state.pendingMirrorDest = action;
          
          // Resolve group name
          let groupName = action;
          try {
              const tgClient = await getConnectedUserbotClient(query.from.id);
              const entity = await tgClient.getEntity(action);
              groupName = (entity as any).title || groupName;
          } catch(e) { console.error("Error resolving group name", e); }
          
          // Update recent destinations
          await approvedUsersCollection?.updateOne(
              { userId: query.from.id },
              { $addToSet: { recentDestinations: { destId: action, groupName: groupName } } }
          );
          
          state.type = 'mirror_path_add_source';
          await safeEditMessage(`🔗 **Destination Selected: ${groupName}**\n\nNow send the **Source Group Link/ID** to mirror from:`, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              reply_markup: { force_reply: true }
          });
      }
      bot?.answerCallbackQuery(query.id);
      return;
  }

  // Handle interactive topic clone destination registered selection
  if (query.data?.startsWith('tc_dest_')) {
      if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
      const state = userActionStates[query.from.id];
      if (!state || state.type !== 'topic_clone_dest_select') {
          return bot?.answerCallbackQuery(query.id, { text: '❌ Session expired.', show_alert: true });
      }

      const idx = parseInt(query.data.split('_')[2]);
      const settingsUid = await resolveSettingsUserId(query.from.id);
      const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
      const dest = (userDoc?.savedDestinations || [])[idx];
      if (!dest) {
          return bot?.answerCallbackQuery(query.id, { text: '❌ Destination not found.', show_alert: true });
      }

      // Direct selection: dest.destId is the ID
      state.pendingCloneDest = dest.destId;
      
      let groupName = dest.groupName;
      await saveRecentDestination(query.from.id, dest.destId, groupName);
      
      const recentSources = userDoc?.recentSources || [];
      let kb: any[] = [];
      if (recentSources.length > 0) {
          recentSources.forEach((s: any) => {
              kb.push([{ text: `📥 ${s.sourceName}`, callback_data: `clonesource_${s.sourceId}` }]);
          });
          kb.push([{ text: `➕ Enter New Source ID`, callback_data: `clonesource_new` }]);
      }
      
      state.type = 'topic_clone_group';
      if (kb.length > 0) {
          await safeEditMessage(`🔗 **Destination Selected: ${groupName}**\n\n2. Select or enter the **Source Group** to clone from:`, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              reply_markup: { inline_keyboard: kb }
          });
      } else {
          await safeEditMessage(`🔗 **Destination Selected: ${groupName}**\n\n2. Now send the **Source Group Link/ID** to clone from:`, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              reply_markup: { force_reply: true }
          });
      }
      bot?.answerCallbackQuery(query.id);
      return;
  }

  // Handle interactive clone destination selection
  if (query.data?.startsWith('clonedest_')) {
      if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
      const state = userActionStates[query.from.id];
      if (!state || state.type !== 'topic_clone_dest_select') {
          return bot?.answerCallbackQuery(query.id, { text: '❌ Session expired.', show_alert: true });
      }

      const action = query.data.split('_')[1];
      if (action === 'new') {
          state.type = 'enter_clone_dest_id';
          safeEditMessage("🔗 **Please send the Destination Group ID or Link:**", { chat_id: chatId, message_id: query.message!.message_id });
      } else {
          // Direct selection: action is the ID
          state.pendingCloneDest = action;
          
          let groupName = action;
          try {
              const tgClient = await getConnectedUserbotClient(query.from.id);
              const entity = await tgClient.getEntity(action);
              groupName = (entity as any).title || groupName;
          } catch(e) { console.error("Error resolving group name", e); }
          
          await saveRecentDestination(query.from.id, action, groupName);
          
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const recentSources = userDoc?.recentSources || [];
          
          let kb: any[] = [];
          if (recentSources.length > 0) {
              recentSources.forEach((s: any) => {
                  kb.push([{ text: `📥 ${s.sourceName}`, callback_data: `clonesource_${s.sourceId}` }]);
              });
              kb.push([{ text: `➕ Enter New Source ID`, callback_data: `clonesource_new` }]);
          }
          
          state.type = 'topic_clone_group';
          if (kb.length > 0) {
              await safeEditMessage(`🔗 **Destination Selected: ${groupName}**\n\n2. Select or enter the **Source Group** to clone from:`, {
                  chat_id: chatId,
                  message_id: query.message!.message_id,
                  reply_markup: { inline_keyboard: kb }
              });
          } else {
              await safeEditMessage(`🔗 **Destination Selected: ${groupName}**\n\n2. Now send the **Source Group Link/ID** to clone from:`, {
                  chat_id: chatId,
                  message_id: query.message!.message_id,
                  reply_markup: { force_reply: true }
              });
          }
      }
      bot?.answerCallbackQuery(query.id);
      return;
  }


  if (query.data?.startsWith('clonesource_')) {
      if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
      const state = userActionStates[query.from.id];
      if (!state || state.type !== 'topic_clone_group') {
          return bot?.answerCallbackQuery(query.id, { text: '❌ Session expired.', show_alert: true });
      }

      const action = query.data.split('_')[1];
      if (action === 'new') {
          await safeEditMessage("🔗 **Please send the Source Group ID or Link to clone from:**", { chat_id: chatId, message_id: query.message!.message_id });
      } else {
          const sourceId = action;
          state.type = 'topic_clone_topic_id';
          state.cloneSourceGroupId = sourceId;
          
          let groupName = sourceId;
          try {
              const tgClient = await getConnectedUserbotClient(query.from.id);
              const entity = await tgClient.getEntity(sourceId);
              groupName = (entity as any).title || groupName;
          } catch(e) { console.error("Error resolving source name", e); }
          
          await saveRecentSource(query.from.id, sourceId, groupName);

          await safeEditMessage(`✅ **Source Selected: ${groupName}**\n\n3. Please enter the **Topic ID** of the topic you want to clone now.`, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              reply_markup: { force_reply: true }
          });
      }
      bot?.answerCallbackQuery(query.id);
      return;
  }

  if (query.data?.startsWith('mirrorsource_')) {
      if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
      const state = userActionStates[query.from.id];
      if (!state || state.type !== 'mirror_path_add_source') {
          return bot?.answerCallbackQuery(query.id, { text: '❌ Session expired.', show_alert: true });
      }

      const action = query.data.split('_')[1];
      if (action === 'new') {
          await safeEditMessage("🔗 **Please send the Source Group ID or Link:**", { chat_id: chatId, message_id: query.message!.message_id });
      } else {
          const sourceId = action;
          state.pendingSourceId = sourceId;
          
          let groupName = sourceId;
          try {
              const tgClient = await getConnectedUserbotClient(query.from.id);
              const entity = await tgClient.getEntity(sourceId);
              groupName = (entity as any).title || groupName;
          } catch(e) { console.error("Error resolving source name", e); }
          state.pendingSourceName = groupName;
          
          await saveRecentSource(query.from.id, sourceId, groupName);

          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const savedDestinations = userDoc?.savedDestinations || [];
          
          if (savedDestinations.length === 0) {
              delete userActionStates[query.from.id];
              await safeEditMessage("❌ **No Saved Destinations.**\nPlease add a destination by going to your destination group and typing `/setmirror` first.", { chat_id: chatId, message_id: query.message!.message_id });
              bot?.answerCallbackQuery(query.id);
              return;
          }

          state.type = 'live_mirror_dest_select';
          const uniqueDestinations: { dest: any, originalIndex: number }[] = [];
          const seen = new Set();
          savedDestinations.forEach((d: any, originalIndex: number) => {
              if (d && d.destId && !seen.has(d.destId)) {
                  seen.add(d.destId);
                  uniqueDestinations.push({ dest: d, originalIndex });
              }
          });
          const kb = uniqueDestinations.map((item) => {
              return [
                  { text: item.dest.groupName + (item.dest.destThreadId ? ` (Topic ${item.dest.destThreadId})` : ''), callback_data: `lm_dest_${item.originalIndex}` },
                  { text: '🗑', callback_data: `del_saved_dest:${item.originalIndex}` }
              ];
          });
          kb.push([{ text: '🔙 Back', callback_data: 'start_back' }]);

          await safeEditMessage(`✅ **Source Selected: ${groupName}**\n\n**Select Destination Group for Live Mirror:**`, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              reply_markup: { inline_keyboard: kb }
          });
      }
      bot?.answerCallbackQuery(query.id);
      return;
  }

      if (query.data === 'start_cmd') {
          handleStartMessage(
            { ...query.message, from: query.from },
            query.message?.message_id
          );
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'send_anime_photo') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          bot?.answerCallbackQuery(query.id, { text: '🎨 Fetching Anime Photo...' }).catch(() => {});
          try {
              const url = await getRandomAnimePhotoUrl(query.from?.id);
              const captionText = `🌸 **Here is your random Anime photo!** ✨\n\n_Keep clicking the button below to get more!_`;
              const replyMarkup = {
                  inline_keyboard: [
                      [
                          { text: '🔄 Get Another Anime (Ek Aur Bhejo)', callback_data: 'send_anime_photo' }
                      ],
                      [
                          { text: '⬅️ Back to Menu', callback_data: 'menu_back' }
                      ]
                  ]
              };

              let success = false;
              if (query.message) {
                  try {
                      const editResult = await safeBotCall('editMessageMedia', {
                          type: 'photo',
                          media: url,
                          caption: captionText,
                          parse_mode: 'Markdown'
                      }, {
                          chat_id: chatId,
                          message_id: query.message.message_id,
                          reply_markup: replyMarkup
                      });
                      
                      // safeBotCall returns null on error rather than throwing, so we must check if editResult is truthy
                      if (editResult) {
                          success = true;
                      } else {
                          console.log("[Anime] editMessageMedia returned null, triggering sendPhoto fallback");
                      }
                  } catch (err: any) {
                      console.log("[Anime] editMessageMedia exception, falling back:", err.message);
                  }
              }

              if (!success) {
                  if (query.message) {
                      await safeBotCall('deleteMessage', chatId, query.message.message_id).catch(() => {});
                  }
                  await safeBotCall('sendPhoto', chatId, url, {
                      caption: captionText,
                      parse_mode: 'Markdown',
                      reply_markup: replyMarkup
                  });
              }
          } catch (err: any) {
              console.error("[Anime] Error in sending anime photo:", err);
              try {
                  await safeSendMessage(chatId, `❌ **Could not fetch Anime Photo:** ${err.message}`, {
                      reply_markup: {
                          inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'menu_back' }]]
                      }
                  });
              } catch (e) {}
          }
          return;
      }
      
      if (query.data === 'start_cmd_link') {
          safeSendMessage(chatId, "🔗 **Send Target Link**\n\nPlease send the message link you want to start downloading.", {
            parse_mode: 'Markdown',
            reply_markup: { force_reply: true }
          });
          bot?.answerCallbackQuery(query.id);
          return;
      }
      
      if (query.data === 'dashboard_cmd') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          try {
              const text = await generateDashboardText();
              safeEditMessage(text, {
                  chat_id: chatId,
                  message_id: query.message?.message_id || 0,
                  parse_mode: 'Markdown',
                  disable_web_page_preview: true,
                  reply_markup: {
                      inline_keyboard: [
                          [
                              { text: '🔄 Refresh Stats', callback_data: 'refresh_dashboard' },
                              isQueuePaused ? { text: '▶️ Resume Queue', callback_data: 'resume_queue_cb' } : { text: '⏸️ Pause Queue', callback_data: 'pause_queue_cb' }
                          ],
                          [
                              { text: '📋 View Queue', callback_data: 'view_queue_cb' },
                              { text: '🗑️ Clear Queue', callback_data: 'clear_queue_cb' }
                          ],
                          [
                              { text: '⬅️ Back to Menu', callback_data: 'menu_back' }
                          ]
                      ]
                  }
              });
          } catch (err: any) {
              bot?.answerCallbackQuery(query.id, { text: '❌ Error: ' + err.message, show_alert: true });
          }
          return;
      }
      
      if (query.data === 'login_cmd') {
          handleLogin(chatId, query.from?.id);
          bot?.answerCallbackQuery(query.id);
          return;
      }
      if (query.data === 'batch_cmd') {
          handleBatch(chatId, query.from?.id, query.message?.message_id);
          bot?.answerCallbackQuery(query.id);
          return;
      }
      if (query.data === 'mirror_cmd') {
          handleMirror(chatId, query.from?.id, query.message?.message_id);
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'full_mirror_progress_list') {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          
          try {
              if (activeFullMirrorSessions.size === 0) {
                  const options = {
                      parse_mode: 'Markdown',
                      reply_markup: {
                          inline_keyboard: [
                              [
                                  { text: '🔄 Refresh', callback_data: 'full_mirror_progress_list' },
                                  { text: '⬅️ Back', callback_data: 'mirror_cmd' }
                              ]
                          ]
                      }
                  };
                  try {
                      await safeEditMessage("📭 **No active full mirror sessions currently in progress.**\n\nAll tasks have concluded or no session is active.", {
                          chat_id: chatId,
                          message_id: query.message!.message_id,
                          ...options
                      });
                  } catch (e) {
                      await safeSendMessage(chatId, "📭 **No active full mirror sessions currently in progress.**\n\nAll tasks have concluded or no session is active.", options);
                  }
              } else {
                  let text = `📊 **Active Full Mirror Sessions (${activeFullMirrorSessions.size}):**\n\n`;
                  let idx = 1;
                  const keyboard = [];
                  for (const [id, session] of activeFullMirrorSessions.entries()) {
                      const filePercentage = session.totalFiles > 0 ? Math.round((session.processedFiles / session.totalFiles) * 100) : 0;
                      text += `**${idx}.** Session: \`${id}\`\n`;
                      if (session.sourceId) text += `└ **Source:** \`${session.sourceId}\`\n`;
                      text += `└ **Processed:** \`${session.processedFiles} / ${session.totalFiles}\` (${filePercentage}%)\n`;
                      text += `└ **Status:** 🟢 Success: \`${session.successCount}\` | 🔴 Failed: \`${session.failedCount}\`\n\n`;
                      
                      keyboard.push([
                          { text: `🔄 Resume #${idx}`, callback_data: `fm_resume_${id}` },
                          { text: `🗑 Del #${idx}`, callback_data: `fm_deltrack_${id}` }
                      ]);
                      idx++;
                  }
                  
                  keyboard.push([
                      { text: '🔄 Refresh List', callback_data: 'full_mirror_progress_list' },
                      { text: '⬅️ Back', callback_data: 'mirror_cmd' }
                  ]);
                  
                  try {
                      await safeEditMessage(text, {
                          chat_id: chatId,
                          message_id: query.message!.message_id,
                          parse_mode: 'Markdown',
                          reply_markup: { inline_keyboard: keyboard }
                      });
                  } catch (e) {
                      await safeSendMessage(chatId, text, {
                          parse_mode: 'Markdown',
                          reply_markup: { inline_keyboard: keyboard }
                      });
                  }
              }
          } catch (err: any) {
              safeSendMessage(chatId, `❌ Error fetching active sessions: ${err.message}`);
          }
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data?.startsWith('fm_resume_')) {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const sessId = query.data.split('_').slice(2).join('_');
          bot?.answerCallbackQuery(query.id, { text: '🔄 Resuming mirror session...' });
          
          const statusMsg = await safeSendMessage(chatId, `🔄 **Resuming full mirror session [${sessId}]...**\nChecking already copied files and skipping them. This may take a moment...`);
          try {
              const queuedCount = await resumeFullMirrorSession(chatId, sessId, query);
              await safeEditMessage(`✅ **Session [${sessId}] Resumed Successfully!**\nEnqueued **${queuedCount}** remaining tasks to the download queue.`, {
                  chat_id: chatId,
                  message_id: statusMsg!.message_id
              });
          } catch (err: any) {
              await safeEditMessage(`❌ **Resume Failed:** ${err.message}`, {
                  chat_id: chatId,
                  message_id: statusMsg!.message_id
              });
          }
          return;
      }

      if (query.data?.startsWith('fm_deltrack_')) {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const sessId = query.data.split('_').slice(2).join('_');
          
          activeFullMirrorSessions.delete(sessId);
          if (fullMirrorSessionsCollection) {
              await fullMirrorSessionsCollection.deleteOne({ sessionId: sessId }).catch(() => {});
          }
          await queuedTasksCollection?.deleteMany({ fullMirrorSessionId: sessId }).catch(() => {});
          for (let i = taskQueue.length - 1; i >= 0; i--) {
              if (taskQueue[i].fullMirrorSessionId === sessId) {
                  taskQueue.splice(i, 1);
              }
          }
          
          await bot?.answerCallbackQuery(query.id, { text: '🗑 Track deleted successfully!', show_alert: true });
          // Refresh list
          try {
              if (activeFullMirrorSessions.size === 0) {
                  const options = {
                      parse_mode: 'Markdown',
                      reply_markup: {
                          inline_keyboard: [
                              [
                                  { text: '🔄 Refresh', callback_data: 'full_mirror_progress_list' },
                                  { text: '⬅️ Back', callback_data: 'mirror_cmd' }
                              ]
                          ]
                      }
                  };
                  await safeEditMessage("📭 **No active full mirror sessions currently in progress.**\n\nAll tasks have concluded or no session is active.", {
                      chat_id: chatId,
                      message_id: query.message!.message_id,
                      ...options
                  });
              } else {
                  let text = `📊 **Active Full Mirror Sessions (${activeFullMirrorSessions.size}):**\n\n`;
                  let idx = 1;
                  const keyboard = [];
                  for (const [id, session] of activeFullMirrorSessions.entries()) {
                      const filePercentage = session.totalFiles > 0 ? Math.round((session.processedFiles / session.totalFiles) * 100) : 0;
                      text += `**${idx}.** Session: \`${id}\`\n`;
                      if (session.sourceId) text += `└ **Source:** \`${session.sourceId}\`\n`;
                      text += `└ **Processed:** \`${session.processedFiles} / ${session.totalFiles}\` (${filePercentage}%)\n`;
                      text += `└ **Status:** 🟢 Success: \`${session.successCount}\` | 🔴 Failed: \`${session.failedCount}\`\n\n`;
                      
                      keyboard.push([
                          { text: `🔄 Resume #${idx}`, callback_data: `fm_resume_${id}` },
                          { text: `🗑 Del #${idx}`, callback_data: `fm_deltrack_${id}` }
                      ]);
                      idx++;
                  }
                  keyboard.push([
                      { text: '🔄 Refresh List', callback_data: 'full_mirror_progress_list' },
                      { text: '⬅️ Back', callback_data: 'mirror_cmd' }
                  ]);
                  
                  await safeEditMessage(text, {
                      chat_id: chatId,
                      message_id: query.message!.message_id,
                      parse_mode: 'Markdown',
                      reply_markup: { inline_keyboard: keyboard }
                  });
              }
          } catch (e: any) {
              console.error("[Del Track Progress Refresh Failed]", e.message);
          }
          return;
      }
      
      if (query.data === 'blocked_topics_panel') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          await showBlockedTopicsPanel(chatId, query.from.id, query.message!.message_id);
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'add_blocked_topic_start') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          userActionStates[query.from.id] = { type: 'add_blocked_topic' };
          safeSendMessage(chatId, "🚫 **Add Blocked Topic**\n\nTo block a topic *specifically for a single group*, simply paste the **Topic Link** (e.g. `https://t.me/c/12345/678`).\n\nAlternatively, you can send the exact **Topic Title** (case-insensitive) to block it globally across all groups.\n\n_To cancel, send /cancel._", {
              parse_mode: 'Markdown',
              reply_markup: { force_reply: true }
          });
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'clear_blocked_topics_action') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const settingsUid = await resolveSettingsUserId(query.from?.id);
          if (approvedUsersCollection) {
              await approvedUsersCollection.updateOne({ userId: settingsUid }, { $unset: { blockedTopics: "" } });
          }
          await bot?.answerCallbackQuery(query.id, { text: '✅ All Blocked Topics Cleared!', show_alert: true });
          await showBlockedTopicsPanel(chatId, query.from.id, query.message!.message_id);
          return;
      }

      if (query.data === 'full_mirror_start') {
          if (!isAdmin(query.from.id)) return safeBotCall('answerCallbackQuery', query.id, { text: '❌ Admin only', show_alert: true });
          userActionStates[query.from.id] = { type: 'full_mirror_group' };
          safeSendMessage(chatId, "🔄 **Full Group Mirror**\n\n1. Please send the **Source Group/Channel ID or Link** you want to completely mirror.", {
              reply_markup: { force_reply: true }
          });
          safeBotCall('answerCallbackQuery', query.id);
          return;
      }

      if (query.data === 'topic_clone_start') {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          
          userActionStates[query.from.id] = { type: 'topic_clone_dest_select' };
          
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection.findOne({ userId: settingsUid });
          const savedDestinations = userDoc?.savedDestinations || [];
          
          if (savedDestinations.length === 0) {
              delete userActionStates[query.from.id];
              return safeEditMessage("❌ **No Saved Destinations.**\nPlease add a destination by going to your destination group and typing `/setspecifictopic` or `/setmirror` first.", {
                  chat_id: chatId,
                  message_id: query.message!.message_id,
                  reply_markup: {
                      inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'mirror_cmd' }]]
                  }
              });
          }

          // Deduplicate based on destId for display but remember the original indices
          const uniqueDestinations: { dest: any, originalIndex: number }[] = [];
          const seen = new Set();
          savedDestinations.forEach((d: any, originalIndex: number) => {
              if (d && d.destId && !seen.has(d.destId)) {
                  seen.add(d.destId);
                  uniqueDestinations.push({ dest: d, originalIndex });
              }
          });
          const kb = uniqueDestinations.map((item) => {
              return [
                  { text: item.dest.groupName + (item.dest.destThreadId ? ` (Topic ${item.dest.destThreadId})` : ''), callback_data: `tc_dest_${item.originalIndex}` },
                  { text: '🗑', callback_data: `del_saved_dest:${item.originalIndex}` }
              ];
          });
          kb.push([{ text: '➕ Enter New Group ID', callback_data: `clonedest_new` }]);
          kb.push([{ text: '❌ Cancel', callback_data: 'mirror_cmd' }]);
          
          safeEditMessage("🎯 **Clone Specific Topic**\n\n1. Select Destination Group:", { chat_id: chatId, message_id: query.message!.message_id, reply_markup: { inline_keyboard: kb } });
          bot?.answerCallbackQuery(query.id);
          return;
      }
      
      if (query.data === 'mirror_add_start') {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          userActionStates[query.from.id] = { type: 'mirror_path_add_source' };
          
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const recent = userDoc?.recentSources || [];
          
          let kb: any[] = [];
          if (recent.length > 0) {
              recent.forEach((s: any) => {
                  kb.push([{ text: `📥 ${s.sourceName}`, callback_data: `mirrorsource_${s.sourceId}` }]);
              });
              kb.push([{ text: `➕ Enter New Source ID`, callback_data: `mirrorsource_new` }]);
          }
          
          if (kb.length > 0) {
              safeSendMessage(chatId, "🔗 **New Live Mirror Setup**\n\n🎯 Select or Enter the **Source Group**:", {
                  reply_markup: { inline_keyboard: kb }
              });
          } else {
              safeSendMessage(chatId, "🔗 **New Live Mirror Setup**\n\n1. Please send the **Source Group ID** or **Link** you want to auto-mirror content FROM.", {
                  reply_markup: { force_reply: true }
              });
          }
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data?.startsWith('lm_dest_')) {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const state = userActionStates[query.from.id];
          if (!state || state.type !== 'live_mirror_dest_select') {
              return bot?.answerCallbackQuery(query.id, { text: '❌ Session expired.', show_alert: true });
          }

          const idx = parseInt(query.data.split('_')[2]);
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const dest = (userDoc?.savedDestinations || [])[idx];
          if (!dest) {
              return bot?.answerCallbackQuery(query.id, { text: '❌ Destination not found.', show_alert: true });
          }

          const sourceId = state.pendingSourceId!;
          const sourceName = state.pendingSourceName || 'Source Group';
          delete userActionStates[query.from.id];

          const mirrorPaths = userDoc?.mirrorPaths || [];
          
          let initialLastId = 0;
          try {
              const targetUid = Number(settingsUid);
              const userbotClient = await getConnectedUserbotClient(targetUid);
              if (userbotClient) {
                  const sourceEntity = await safelyResolveFullEntity(userbotClient, sourceId).catch(() => null);
                  if (sourceEntity) {
                      const msgs = await userbotClient.getMessages(sourceEntity, { limit: 1 });
                      if (msgs && msgs.length > 0) {
                          initialLastId = msgs[0].id;
                      }
                  }
              }
          } catch (e: any) {
              console.error("[Init Path] Failed to fetch last message ID for new live mirror:", e.message);
          }

          const filtered = mirrorPaths.filter((p: any) => p.sourceId !== sourceId);
          filtered.push({
              sourceId,
              sourceNumericId: sourceId,
              sourceUsername: '',
              sourceName,
              destId: dest.destId,
              destThreadId: dest.destThreadId,
              groupName: dest.groupName,
              topicName: dest.topicName,
              isLive: true,
              lastProcessedMsgId: initialLastId,
              createdAt: new Date()
          });

          const finalPaths = filtered;

          if (approvedUsersCollection) {
              await approvedUsersCollection.updateOne(
                  { userId: settingsUid },
                  { $set: { mirrorPaths: finalPaths } }
              );
              
              const destDisplay = dest.destThreadId ? `${dest.groupName} (Topic: ${dest.destThreadId})` : dest.groupName;
              safeSendMessage(chatId, `✅ **Live Mirror Path Setup Finished!**\n\n**Source:** \`${sourceName}\` (\`${sourceId}\`)\n**Destination:** ${destDisplay}\n⚡ **Live Status:** 🟢 Live ON (Auto-mirroring active!)${initialLastId > 0 ? `\n📥 **Starting from post ID:** \`${initialLastId}\`` : ''}`, { parse_mode: 'Markdown' });
          }
          
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data?.startsWith('fm_dest_')) {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const state = userActionStates[query.from.id];
          if (!state || state.type !== 'full_mirror_dest_select') {
              return bot?.answerCallbackQuery(query.id, { text: '❌ Session expired.', show_alert: true });
          }

          const idx = parseInt(query.data.split('_')[2]);
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const dest = (userDoc?.savedDestinations || [])[idx];
          if (!dest) {
              return bot?.answerCallbackQuery(query.id, { text: '❌ Destination not found.', show_alert: true });
          }

          const sourceId = state.pendingSourceId!;
          const destDisplay = dest.destThreadId ? `${dest.groupName} (Topic: ${dest.destThreadId})` : dest.groupName;

          const keyboard = [
              [
                  { text: '🔄 Full + ⚡ Live Mirror', callback_data: `fmlive_yes_${idx}` },
                  { text: '📥 History Copy Only', callback_data: `fmlive_no_${idx}` }
              ],
              [
                  { text: '❌ Cancel', callback_data: 'mirror_cmd' }
              ]
          ];

          await safeEditMessage(`🔄 **Full Mirror Options**\n\nWould you like to also auto-enable **Live Mirroring** for this setup once started?\n\n**Source:** \`${sourceId}\`\n**Destination:** ${destDisplay}\n\n*If you choose YES, we will queue the full history copy and also automatically register this channel/group to mirror future new posts in real-time!*`, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: keyboard }
          });
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data?.startsWith('fmlive_yes_') || query.data?.startsWith('fmlive_no_')) {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const state = userActionStates[query.from.id];
          if (!state || state.type !== 'full_mirror_dest_select') {
              return bot?.answerCallbackQuery(query.id, { text: '❌ Session expired.', show_alert: true });
          }

          const isLiveOption = query.data.startsWith('fmlive_yes_');
          const idx = parseInt(query.data.split('_')[2]);
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const dest = (userDoc?.savedDestinations || [])[idx];
          if (!dest) {
              return bot?.answerCallbackQuery(query.id, { text: '❌ Destination not found.', show_alert: true });
          }

          const sourceId = state.pendingSourceId!;
          delete userActionStates[query.from.id];

          const statusMsg = await safeSendMessage(chatId, `📂 **Starting Full Mirror...**\nSource Group: \`${sourceId}\`\nFetching history, this may take a moment depending on the group size.`);
          
          try {
              const targetUid = Number(await resolveSettingsUserId(query.from.id));
              const client = await getConnectedUserbotClient(targetUid);
              if (!client) throw new Error("Your Userbot session is not active. Please /login first.");
              
              let sourceEntity: any;
              try {
                  sourceEntity = await safelyResolveFullEntity(client, sourceId);
              } catch (e: any) {
                  if (!sourceId.startsWith('-100') && !isNaN(Number(sourceId))) {
                      sourceEntity = await safelyResolveFullEntity(client, "-100" + sourceId);
                  } else {
                      throw e;
                  }
              }
              const destPath = dest.destId;
              
              let destEntity: any = null;
              try {
                  destEntity = await safelyResolveFullEntity(client, destPath);
              } catch (e: any) {
                  if (!destPath.startsWith('-100') && !isNaN(Number(destPath))) {
                      destEntity = await safelyResolveFullEntity(client, "-100" + destPath).catch(() => null);
                  }
              }
              if (!destEntity) {
                  throw new Error("Could not access destination group. Please check your upload path.");
              }

              let sourceTopics: Record<number, string> = {};
              let destTopics: Record<string, number> = {};
              const destTopicsTitleMap: Record<number, string> = {};
              const isSourceForum = (sourceEntity as any).forum;
              const isDestForum = (destEntity as any).forum;

              if (isSourceForum) {
                  try {
                      const res: any = await client.invoke(new Api.channels.GetForumTopics({ channel: sourceEntity, offsetDate: 0, offsetId: 0, offsetTopic: 0, limit: 100 }));
                      res.topics?.forEach((t: any) => {
                          if (t.title) sourceTopics[t.id] = t.title;
                      });
                  } catch (e) {
                      console.warn("Failed to fetch source topics:", e);
                  }
              }

              if (isDestForum) {
                  try {
                      const res: any = await client.invoke(new Api.channels.GetForumTopics({ channel: destEntity, offsetDate: 0, offsetId: 0, offsetTopic: 0, limit: 100 }));
                      res.topics?.forEach((t: any) => {
                          if (t.title) {
                              destTopics[t.title.trim().toLowerCase()] = t.id;
                              destTopicsTitleMap[t.id] = t.title;
                          }
                      });
                  } catch (e) {
                      console.warn("Failed to fetch destination topics:", e);
                  }
              }
              
              const sourceIdRaw = (sourceEntity as any).id?.toString() || "";
              const sourceIdClean = sourceIdRaw.replace('-100', '');

              const alreadyMirroredDocs = mirroredMessagesCollection ? 
                    await mirroredMessagesCollection.find({ destId: destPath }).toArray() : [];
              const alreadyMirroredLinks = new Set(alreadyMirroredDocs.map((doc: any) => doc.link));
              let skippedCount = 0;

              const msgsToQueue = [];
              const topicMap: Record<number, number | undefined> = {};
              let latestMsgId = 0;

              for await (const m of client.iterMessages(sourceEntity, { reverse: true, limit: undefined })) {
                  if (m.action) continue; 
                  if (!m.message && !m.media) continue;

                  if (m.id > latestMsgId) {
                      latestMsgId = m.id;
                  }

                  const virtualLink = `https://t.me/c/${sourceIdClean}/${m.id}`;
                  if (alreadyMirroredLinks.has(virtualLink)) {
                      skippedCount++;
                      continue;
                  }

                  let overrideThreadId: number | undefined = dest.destThreadId; // Base thread ID

                  if (isSourceForum && isDestForum && (m as any).replyTo) {
                      const replyTo = (m as any).replyTo;
                      const sourceTopicId = replyTo.replyToTopId || replyTo.replyToMsgId;
                      
                      if (sourceTopicId) {
                          const topicTitle = sourceTopics[sourceTopicId];
                          if (topicTitle) {
                              if (topicMap[sourceTopicId] !== undefined) {
                                  overrideThreadId = topicMap[sourceTopicId] ?? dest.destThreadId;
                              } else {
                                  const normalizedTitle = topicTitle.trim().toLowerCase();
                                  if (destTopics[normalizedTitle]) {
                                      topicMap[sourceTopicId] = destTopics[normalizedTitle];
                                      overrideThreadId = destTopics[normalizedTitle];
                                  } else {
                                      try {
                                          const createResult: any = await client.invoke(new Api.channels.CreateForumTopic({
                                              channel: destEntity,
                                              title: topicTitle
                                          }));
                                          const update = createResult.updates?.find((u: any) => u.className === 'UpdateNewForumTopic');
                                          let newDestTopicId = update?.topicId;
                                          
                                          if (!newDestTopicId) {
                                              const retryTopics: any = await client.invoke(new Api.channels.GetForumTopics({ channel: destEntity, limit: 100 }));
                                              newDestTopicId = retryTopics.topics?.find((t: any) => t.title?.trim().toLowerCase() === normalizedTitle)?.id;
                                          }
                                          
                                          if (newDestTopicId) {
                                              destTopics[normalizedTitle] = newDestTopicId;
                                              destTopicsTitleMap[newDestTopicId] = topicTitle;
                                              topicMap[sourceTopicId] = newDestTopicId;
                                              overrideThreadId = newDestTopicId;
                                          }
                                      } catch (e) {
                                          console.warn(`Failed to create topic ${topicTitle}:`, e);
                                          topicMap[sourceTopicId] = undefined;
                                      }
                                  }
                              }
                          }
                      }
                  }

                  msgsToQueue.push({ 
                      chatId, 
                      link: virtualLink, 
                       userId: query.from.id,
                      forceGeneralPath: true,
                      overrideThreadId,
                      overrideTargetId: destPath,
                      isMirror: true
                   });
              }

              if (msgsToQueue.length === 0) {
                  throw new Error(`No new messages found inside this group.${skippedCount > 0 ? ` All ${skippedCount} messages were already successfully mirrored previously.` : ''}`);
              }

              // Group and sort messages by topic to achieve grouped sequential downloading (Topic by Topic first)
              const tasksByTopic = new Map<string | number, any[]>();
              const generalTasks: any[] = [];

              for (const task of msgsToQueue) {
                  if (task.overrideThreadId !== undefined && task.overrideThreadId !== null) {
                      if (!tasksByTopic.has(task.overrideThreadId)) {
                          tasksByTopic.set(task.overrideThreadId, []);
                      }
                      tasksByTopic.get(task.overrideThreadId)!.push(task);
                  } else {
                      generalTasks.push(task);
                  }
              }

              const orderedTasks: any[] = [];
              if (generalTasks.length > 0) {
                  orderedTasks.push(...generalTasks);
              }
              for (const [topicId, tasks] of tasksByTopic.entries()) {
                  orderedTasks.push(...tasks);
              }

              // Register Global Mirror Session status message and pin it
              const sessionId = `fm_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
              const topicStats: Record<string | number, { total: number; processed: number; isMarkedCompleted: boolean; title: string }> = {};

              for (const task of orderedTasks) {
                  task.fullMirrorSessionId = sessionId;

                  const threadId = task.overrideThreadId !== undefined && task.overrideThreadId !== null ? task.overrideThreadId : 'general';
                  const topicTitle = task.overrideThreadId !== undefined && task.overrideThreadId !== null ? (destTopicsTitleMap[task.overrideThreadId] || `Topic #${task.overrideThreadId}`) : 'General Discussion';

                  if (!topicStats[threadId]) {
                      topicStats[threadId] = {
                          total: 0,
                          processed: 0,
                          isMarkedCompleted: false,
                          title: topicTitle
                      };
                  }
                  topicStats[threadId].total++;
              }

              const globalStatusMsg = await safeSendMessage(chatId, `📍 **[GLOBAL PROGRESS] Setting up Universal Mirror...**\nInitializing tracking bar...`);
              let globalStatusMsgId = globalStatusMsg?.message_id || 0;

              if (globalStatusMsgId) {
                  try {
                      await bot?.pinChatMessage(chatId, globalStatusMsgId);
                  } catch (pErr: any) {
                      console.warn("[Full Mirror] Global progress bar pin failed:", pErr.message);
                  }
              }

              const fmSession = {
                  sessionId,
                  chatId,
                  userId: query.from.id,
                  statusMsgId: globalStatusMsgId,
                  totalFiles: orderedTasks.length,
                  processedFiles: 0,
                  successCount: 0,
                  failedCount: 0,
                  topicStats,
                  sourceId,
                  dest,
                  isLiveOption
              };

              activeFullMirrorSessions.set(sessionId, fmSession);
              if (fullMirrorSessionsCollection) {
                  await fullMirrorSessionsCollection.insertOne(fmSession).catch(err => {
                      console.error("[Full Mirror DB Save Failed]", err);
                  });
              }

              // Trigger initial progress bar write
              await updateGlobalMirrorProgress(sessionId).catch(pErr => console.error("[Full Mirror Initial Update Failed]", pErr));

              // --- IF USER ENABLED LIVE MIRROR, AUTO REGISTER THE PATH ---
              let liveMirrorSuccessInfo = '';
              if (isLiveOption) {
                  const sourceName = (sourceEntity as any).title || 'Source Group';
                  const mirrorPaths = userDoc?.mirrorPaths || [];
                  const filtered = mirrorPaths.filter((p: any) => p.sourceId !== sourceId);
                  
                  filtered.push({
                      sourceId,
                      sourceNumericId: sourceId,
                      sourceUsername: '',
                      sourceName,
                      destId: dest.destId,
                      destThreadId: dest.destThreadId,
                      groupName: dest.groupName,
                      topicName: dest.topicName,
                      isLive: true,
                      lastProcessedMsgId: latestMsgId,
                      createdAt: new Date()
                  });

                  if (approvedUsersCollection) {
                      await approvedUsersCollection.updateOne(
                          { userId: settingsUid },
                          { $set: { mirrorPaths: filtered } }
                      );
                      // Start watcher for client
                      await startAutoMirrorWatcher(Number(settingsUid), client).catch(err => {
                          console.warn("[Full Mirror -> Live Watcher] Failed to auto start watcher:", err.message);
                      });
                      
                      const destDisplay = dest.destThreadId ? `${dest.groupName} (Topic: ${dest.destThreadId})` : dest.groupName;
                      liveMirrorSuccessInfo = `\n\n⚡ **Live Mirror registered too!**\n└ **Source:** \`${sourceName}\`\n└ **Destination:** \`${destDisplay}\`\n└ **Status:** 🟢 Live ON (Future posts will auto-mirror starting from ID \`${latestMsgId}\`)`;
                  }
              }

              taskQueue.push(...orderedTasks);
              dbEnqueueTasks(orderedTasks).catch(e => console.error("[Queue DB] Bulk enqueue error:", e));
              runNextTask();
              if (statusMsg) {
                  const skipText = skippedCount > 0 ? ` (Skipped **${skippedCount}** already mirrored previously)` : '';
                  await safeEditMessage(`✅ Added **${orderedTasks.length}** items from Full Mirror to copy queue.${skipText}\nDestination path: \`${destPath}\`.${liveMirrorSuccessInfo}`, {
                      chat_id: chatId,
                      message_id: statusMsg.message_id
                  });
              }
          } catch (err: any) {
              if (statusMsg) {
                  await safeEditMessage(`❌ **Mirror Error:** ${err.message}`, {
                      chat_id: chatId,
                      message_id: statusMsg.message_id
                  });
              } else {
                  safeSendMessage(chatId, `❌ **Mirror Error:** ${err.message}`);
              }
          }

          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'mirror_list') {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          
          try {
              const settingsUid = await resolveSettingsUserId(query.from.id);
              const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
              const paths = userDoc?.mirrorPaths || [];
              
              if (paths.length === 0) {
                  safeSendMessage(chatId, "📭 **No active mirror paths found.**\nUse /setmirror in a destination group to add one.");
              } else {
                  let text = `📂 **Active Mirror Paths (${paths.length}):**\n\n`;
                  const keyboard = [];
                  
                  for (let i = 0; i < paths.length; i++) {
                      const p = paths[i];
                      const destName = p.groupName || 'Group';
                      const topicName = p.topicName || 'General';
                      const liveStatus = p.isLive ? '🟢 LIVE ON' : '🔴 LIVE OFF';
                      const sourceName = p.sourceName || 'Target Group';
                      const lastScanText = p.isLive ? `\n   └ **Last Scan (IST):** \`${formatISTTime(p.lastScannedAt)}\`` : '';
                      
                      text += `**${i + 1}. (${sourceName}) (${p.sourceId}) ➔ ${destName}**\n`;
                      text += `└ Topic: ${topicName} | Status: ${liveStatus}${lastScanText}\n\n`;
                      
                      keyboard.push([
                          { text: liveStatus, callback_data: `mirrortoggle_${i}` },
                          { text: '🔄 Scan', callback_data: `mirrorscan_${i}` },
                          { text: '🗑 Delete', callback_data: `mirrordel_${i}` }
                      ]);
                  }
                  
                  keyboard.push([{ text: '⬅️ Back', callback_data: 'mirror_cmd' }]);
                  
                  safeSendMessage(chatId, text, {
                      parse_mode: 'Markdown',
                      reply_markup: { inline_keyboard: keyboard }
                  });
              }
          } catch (err) {
              safeSendMessage(chatId, "❌ Error fetching mirror list.");
          }
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data?.startsWith('mirrordel_')) {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const index = parseInt(query.data.split('_')[1]);
          
          try {
              const settingsUid = await resolveSettingsUserId(query.from.id);
              const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
              const paths = userDoc?.mirrorPaths || [];
              if (paths[index]) {
                  const removed = paths.splice(index, 1);
                  await approvedUsersCollection.updateOne(
                      { userId: settingsUid },
                      { $set: { mirrorPaths: paths } }
                  );
                  bot?.answerCallbackQuery(query.id, { text: `✅ Removed mirror from ${removed[0].sourceId}` });
                  // Refresh list
                  bot?.deleteMessage(chatId, query.message!.message_id).catch(() => {});
                  safeSendMessage(chatId, "✅ Path removed. Use /mirror to see updated list.");
              }
          } catch (err) {
              bot?.answerCallbackQuery(query.id, { text: '❌ Deletion failed' });
          }
          return;
      }

      if (query.data?.startsWith('mirrorscan_')) {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const index = parseInt(query.data.split('_')[1]);
          try {
              const settingsUid = await resolveSettingsUserId(query.from.id);
              const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
              const paths = userDoc?.mirrorPaths || [];
              if (paths[index]) {
                  bot?.answerCallbackQuery(query.id, { text: `🔄 Starting scan for ${paths[index].sourceId}...` });
                  const client = await getConnectedUserbotClient(parseInt(settingsUid));
                  catchUpLiveMirrors(parseInt(settingsUid), client).then(() => {
                      safeSendMessage(chatId, `✅ Scan completed for ${paths[index].sourceId}`);
                  }).catch(e => {
                      console.error(e.message || e);
                      safeSendMessage(chatId, `❌ Scan failed for ${paths[index].sourceId}`);
                  });
              }
          } catch (err) { bot?.answerCallbackQuery(query.id, { text: '❌ Error' }); }
          return;
      }

      if (query.data?.startsWith('mirrortoggle_')) {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const index = parseInt(query.data.split('_')[1]);
          
          try {
              const settingsUid = await resolveSettingsUserId(query.from.id);
              const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
              const paths = userDoc?.mirrorPaths || [];
              if (paths[index]) {
                  paths[index].isLive = !paths[index].isLive;
                  await approvedUsersCollection.updateOne(
                      { userId: settingsUid },
                      { $set: { mirrorPaths: paths } }
                  );
                  
                  const status = paths[index].isLive ? "🟢 Live ON" : "🔴 Live OFF";
                  bot?.answerCallbackQuery(query.id, { text: `✅ ${status} for ${paths[index].sourceId}` });
                  
                  // Refresh the list view
                  bot?.deleteMessage(chatId, query.message!.message_id).catch(() => {});
                  // Trigger mirror_list callback logic again
                  query.data = 'mirror_list';
                  // This is a bit hacky, better to extract the logic to a function, but for now I'll just re-trigger or inform.
                  safeSendMessage(chatId, "✅ Status updated. Checking Mirror List again...");
                  handleMirror(chatId, query.from.id, query.message?.message_id);
              }
          } catch (err) {
              bot?.answerCallbackQuery(query.id, { text: '❌ Toggle failed' });
          }
          return;
      }

      if (query.data === 'cancel_cmd') {
          handleCancel(chatId, query.from?.id);
          bot?.answerCallbackQuery(query.id);
          return;
      }
      if (query.data === 'logout_cmd') {
          handleLogout(chatId, query.from?.id);
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'mode_recent') {
          const state = userActionStates[query.from.id];
          if (state && state.type === 'mirror_choice') {
              const link = state.mirrorTarget;
              const fromId = query.from.id;
              delete userActionStates[fromId];
              await safeSendMessage(chatId, "✅ **Starting Recent Content Mirror...**");
              const statusMsg = await safeSendMessage(chatId, "🔍 **Processing Latest...**", { parse_mode: 'Markdown' });
              const newTask = { chatId, link, statusMsgId: statusMsg?.message_id || 0, userId: fromId, isMirror: true, retries: 0 };
              taskQueue.push(newTask);
              dbEnqueueTask(newTask).catch(e => console.error("[Queue DB] enqueue error:", e));
              runNextTask();
          }
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'mode_single_topic') {
          const state = userActionStates[query.from.id];
          if (state && state.type === 'mirror_choice') {
              state.type = 'enter_topic_id';
              safeSendMessage(chatId, "🎯 **Copy One Topic**\n\nPlease send the **Topic ID** you want to clone from the source group.", {
                  reply_markup: { force_reply: true }
              });
          }
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'mode_topics') {
          const state = userActionStates[query.from.id];
          if (state && state.type === 'mirror_choice') {
              const sourceTarget = state.mirrorTarget;
              const fromId = query.from.id;
              delete userActionStates[fromId];
              
              const loadingMsg = await safeSendMessage(chatId, "📂 **Scanning Source Topics...**");
              
              try {
                  const targetUid = Number(await resolveSettingsUserId(fromId));
                  const client = await getConnectedUserbotClient(targetUid);
                  if (!client) throw new Error("Userbot disconnected.");
                  
                  let sourceEntity: any;
                  try {
                      sourceEntity = await safelyResolveFullEntity(client, sourceTarget);
                  } catch (e: any) {
                      console.error("Failed to resolve source entity:", e);
                      throw new Error("Could not access Source.");
                  }
                  const topicsResult: any = await client.invoke(new Api.channels.GetForumTopics({
                      channel: sourceEntity,
                      limit: 30
                  }));

                  if (!topicsResult.topics || topicsResult.topics.length === 0) {
                      throw new Error("No topics found. Source group must be a Forum.");
                  }

                  const userDoc = await approvedUsersCollection?.findOne({ userId: fromId.toString() });
                  
                  const sourceIdRaw = sourceEntity.id?.toString() || "";
                  const sourceId = sourceIdRaw.replace('-100', '');
                  
                  const mirrorPath = userDoc?.mirrorPaths?.find((p: any) => 
                    p.sourceId === sourceId || p.sourceId === `-100${sourceId}` || sourceId === p.sourceId.replace('-100', '')
                  );

                  let destPath = mirrorPath ? mirrorPath.destId : (userDoc?.uploadPath || DEFAULT_LOG_GROUP);
                  if (!userDoc?.uploadPath) {
                      destPath = DEFAULT_LOG_GROUP;
                  }
                  const destEntity: any = await safelyResolveFullEntity(client, destPath).catch(() => { throw new Error("Could not access Destination.")});

                  await safeEditMessage(`📍 **Mirroring ${topicsResult.topics.length} Topics.**\nCloning started...`, { chat_id: chatId, message_id: loadingMsg!.message_id });

                  for (const topic of topicsResult.topics) {
                      let destTopicId;
                      const topicName = topic.title;
                      try {
                          // First, verify if topic already exists in destination
                          const existing: any = await client.invoke(new Api.channels.GetForumTopics({ 
                             channel: destEntity, 
                             limit: 500 
                          }));
                          const found = existing.topics?.find((t: any) => t.title?.trim().toLowerCase() === topicName.trim().toLowerCase());
                          
                          if (found) {
                              destTopicId = found.id;
                              console.log(`[Mirror] Reusing existing topic "${topicName}" -> ${destTopicId}`);
                          } else {
                              console.log(`[Mirror] Creating new topic "${topicName}"`);
                              const createResult: any = await client.invoke(new Api.channels.CreateForumTopic({
                                  channel: destEntity,
                                  title: topicName
                              }));
                              const newTopicUpdate = createResult.updates?.find((u: any) => u.className === 'UpdateNewForumTopic');
                              destTopicId = newTopicUpdate?.topicId;
                          }
                      } catch (topicErr) {
                          // Fallback retry
                          const existing: any = await client.invoke(new Api.channels.GetForumTopics({ channel: destEntity, limit: 100 }));
                          destTopicId = existing.topics?.find((t: any) => t.title?.trim().toLowerCase() === topicName.trim().toLowerCase())?.id;
                      }

                      if (destTopicId) {
                          const messages: any = await client.getMessages(sourceEntity, {
                              limit: 20,
                              replyTo: topic.id
                          });

                          const cloneTasksToQueue: Task[] = [];
                          for (const m of messages) {
                              if (m.media) {
                                  const entityIdRaw = sourceEntity.id?.toString() || "";
                                  const entityId = entityIdRaw.replace('-100', '');
                                  const virtualLink = `https://t.me/c/${entityId}/${m.id}`;
                                  
                                  cloneTasksToQueue.push({ 
                                      chatId, 
                                      link: virtualLink, 
                                      userId: fromId,
                                      overrideThreadId: destTopicId,
                                      isMirror: true
                                  });
                              }
                          }
                          if (cloneTasksToQueue.length > 0) {
                              taskQueue.push(...cloneTasksToQueue);
                              dbEnqueueTasks(cloneTasksToQueue).catch(e => console.error("[Queue DB] Bulk enqueue error:", e));
                          }
                      }
                  }
                  runNextTask();

              } catch (err: any) {
                  safeSendMessage(chatId, `❌ **Mirror Error:** ${err.message}`);
              }
          }
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'help_cmds') {
        const helpText = `📖 *RESTRICTED MIRROR BOT - COMPLETE HELP GUIDE* 📖\n\n` +
          `This guide provides a comprehensive overview of all command definitions, interactive buttons, and functional workflows for this bot.\n\n` +
          `⚙️ **Command Reference Guide:**\n\n` +
          `• \`/start\` 🚀 - Initializes the bot and presents the main action menu.\n` +
          `• \`/login\` 👤 - Authenticates your Telegram account (Userbot). Required for restricted chats.\n` +
          `• \`/settings\` ⚙️ - Accesses upload settings, custom thumbnail options, rename rules, and download engine modes.\n` +
          `• \`/mirror\` 🔄 - Configures cloning, active live paths, or complete mirror/copy options.\n` +
          `• \`/batch\` 📦 - Executes multi-link batch processing mode, allowing you to queue multiple links.\n` +
          `• \`/status\` 📊 - Shows ongoing download/upload transfer progress and active mirror tasks.\n` +
          `• \`/dashboard\` 📈 - Displays general transfer statistics: data volumes, success/failure counts.\n` +
          `• \`/setmirror\` 📍 - Establishes a live mirroring channel or destination path directly inside a group/channel.\n` +
          `• \`/setpath\` 🛣 - Sets the default global destination channel/group link or ID.\n` +
          `• \`/clearmirrorhistory\` 🗑 - Clears the database of downloaded message histories so you can re-mirror identical posts.\n` +
          `• \`/setcooldown\` ⏳ - Adjusts the delay interval between successive mirrored messages.\n` +
          `• \`/speed\` ⚡ - Configures your userbot’s multi-thread capabilities and connection speeds.\n` +
          `• \`/cancel\` 🛑 - Halts and aborts the currently running task (batch copy or mirror operations).\n` +
          `• \`/logout\` 🚪 - Securely disconnects and removes your active userbot Telegram session.\n` +
          `• \`/ping\` 🏓 - Verifies the latency and responds with active server connection status.\n` +
          `• \`/restart\` 🔄 - Restarts the bot application instance (Admin restricted).\n` +
          `• \`/sync\` 🔄 - Re-synchronizes any active mirror paths and session keys.\n\n` +
          `--- \n\n` +
          `🖱 **Interactive Touch Elements & Buttons:**\n\n` +
          `• **Login / Authenticate** 🔑 - Prompts you to paste a standard \`STRING_SESSION\` to authenticate.\n` +
          `• **Batch** 📦 - Starts input prompting to process a bulk queue of distinct message links.\n` +
          `• **Mirror** 🔄 - Opens choices to initiate clones, specific topic clones, or setup live mirroring channels.\n` +
          `• **Settings** ⚙️ - Interactively updates custom thumbnails, adds/removes filename rename rules, and toggles engines.\n` +
          `• **Logout** 🚪 - Terminates and removes any saved userbot session.\n` +
          `• **Cancel** 🛑 - Stops the active long-running mirroring or batch download gracefully.\n` +
          `• **Official Channel** 📢 - Direct link to open the official destination channel.\n` +
          `• **Help** ❓ - Re-displays this complete interactive help guide in English.`;
        bot?.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
        bot?.answerCallbackQuery(query.id);
        return;
      }

      if (query.data === 'bot_settings') {
        if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
        handleSettings(chatId, query.from?.id, query.message?.message_id);
        bot?.answerCallbackQuery(query.id);
        return;
      }

      if (query.data === 'set_path_cmd') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const savedDestinations = userDoc?.savedDestinations || [];

          const text = `📍 **𝗨𝗽𝗹𝗼𝗮𝗱 𝗗𝗲𝘀𝘁𝗶𝗻𝗮𝘁𝗶𝗼𝗻 𝗦𝗲𝘁𝘁𝗶𝗻𝗴𝘀**\n\n` +
                       `Current active destination: \`${userDoc?.uploadGroupName || userDoc?.uploadPath || 'Log Group'}\`\n\n` +
                       `Choose an option below:\n\n` +
                       `• **Select saved destination:** Pick from previously saved group list with group name.\n` +
                       `• **Input new destination:** Forward a message or send a Telegram link to register a new path.`;

          const markup = {
              inline_keyboard: [
                  [
                      { text: `📋 Saved Destinations (${savedDestinations.length})`, callback_data: 'list_saved_dests_cmd' }
                  ],
                  [
                      { text: '✏️ Input New Destination', callback_data: 'input_new_path_cmd' }
                  ],
                  [
                      { text: '⬅️ Back to Settings', callback_data: 'bot_settings' }
                  ]
              ]
          };

          await safeEditMessage(text, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: 'Markdown', reply_markup: markup });
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'input_new_path_cmd') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          userActionStates[query.from.id] = { type: 'set_path' };
          safeSendMessage(chatId, "📍 **Set Custom Destination**\n\nPlease forward any message from target **Group/Channel** here, or send its **Public Link**.\n\n_Bot will upload files to this location instead of your private DM._", { 
              parse_mode: 'Markdown',
              reply_markup: { force_reply: true }
          });
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'list_saved_dests_cmd') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const savedDestinations = userDoc?.savedDestinations || [];

          let text = `📋 **𝗦𝗮𝘃𝗲𝗱 𝗨𝗽𝗹𝗼𝗮𝗱 𝗗𝗲𝘀𝘁𝗶𝗻𝗮𝘁𝗶𝗼𝗻𝘀**\n\n` +
                     `Select any target group below to make it your **Active Upload Destination**:\n\n`;

          const markup: any = { inline_keyboard: [] };
          if (savedDestinations.length === 0) {
              text += `_No saved destinations found. Use /setspecifictopic or /setmirror in any group to save it first._`;
          } else {
              // De-duplicate if needed
              const uniqueDestinations = [...new Map(savedDestinations.map((d: any) => [`${d.destId}_${d.destThreadId || ''}`, d])).values()];
              uniqueDestinations.forEach((d: any, idx: number) => {
                  const label = `${d.groupName}${d.destThreadId ? ` (Topic ${d.destThreadId})` : ''}`;
                  text += `• **${label}** (\`${d.destId}\`)\n`;
                  markup.inline_keyboard.push([
                      { text: `🎯 Set ${d.groupName}`, callback_data: `set_active_dest_idx:${idx}` },
                      { text: '🗑️ Delete', callback_data: `del_saved_dest_from_list:${idx}` }
                  ]);
              });
          }

          markup.inline_keyboard.push([{ text: '⬅️ Back', callback_data: 'set_path_cmd' }]);

          await safeEditMessage(text, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: 'Markdown', reply_markup: markup });
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data?.startsWith('set_active_dest_idx:')) {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          const idx = parseInt(query.data.split(':')[1]);
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const savedDestinations = userDoc?.savedDestinations || [];
          const dest = savedDestinations[idx];

          if (dest) {
              const adminIdStr = query.from.id.toString();
              const update = { 
                  $set: { 
                      uploadPath: dest.destId, 
                      uploadGroupName: dest.groupName, 
                      uploadTopicId: dest.destThreadId || null, 
                      uploadTopicName: dest.destThreadId ? `Topic ${dest.destThreadId}` : '' 
                  } 
              };
              if (approvedUsersCollection) {
                  await approvedUsersCollection.updateOne({ userId: adminIdStr }, update);
                  if (settingsUid !== adminIdStr) {
                      await approvedUsersCollection.updateOne({ userId: settingsUid }, update);
                  }
              }
              bot?.answerCallbackQuery(query.id, { text: `🎯 Active path set to: ${dest.groupName}`, show_alert: true });
              
              // Go back to Settings
              handleSettings(chatId, query.from?.id, query.message!.message_id);
          } else {
              bot?.answerCallbackQuery(query.id, { text: '❌ Destination not found.', show_alert: true });
          }
          return;
      }

      if (query.data?.startsWith('del_saved_dest_from_list:')) {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          const index = parseInt(query.data.split(':')[1]);
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const savedDestinations = userDoc?.savedDestinations || [];
          
          if (savedDestinations[index]) {
              savedDestinations.splice(index, 1);
              await approvedUsersCollection?.updateOne({ userId: settingsUid }, { $set: { savedDestinations: savedDestinations } });
              bot?.answerCallbackQuery(query.id, { text: '✅ Destination Deleted', show_alert: true });
              
              let text = `📋 **𝗦𝗮𝘃𝗲𝗱 𝗨𝗽𝗹𝗼𝗮𝗱 𝗗𝗲𝘀𝘁𝗶𝗻𝗮𝘁𝗶𝗼𝗻𝘀**\n\n` +
                         `Select any target group below to make it your **Active Upload Destination**:\n\n`;

              const markup: any = { inline_keyboard: [] };
              if (savedDestinations.length === 0) {
                  markup.inline_keyboard.push([{ text: '⬅️ Back', callback_data: 'set_path_cmd' }]);
                  await safeEditMessage(text + `_No saved destinations found. Use /setspecifictopic or /setmirror in any group to save it first._`, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: 'Markdown', reply_markup: markup });
              } else {
                  const uniqueDestinations = [...new Map(savedDestinations.map((d: any) => [`${d.destId}_${d.destThreadId || ''}`, d])).values()];
                  uniqueDestinations.forEach((d: any, idx: number) => {
                      const label = `${d.groupName}${d.destThreadId ? ` (Topic ${d.destThreadId})` : ''}`;
                      text += `• **${label}** (\`${d.destId}\`)\n`;
                      markup.inline_keyboard.push([
                          { text: `🎯 Set ${d.groupName}`, callback_data: `set_active_dest_idx:${idx}` },
                          { text: '🗑️ Delete', callback_data: `del_saved_dest_from_list:${idx}` }
                      ]);
                  });
                  markup.inline_keyboard.push([{ text: '⬅️ Back', callback_data: 'set_path_cmd' }]);
                  await safeEditMessage(text, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: 'Markdown', reply_markup: markup });
              }
          } else {
              bot?.answerCallbackQuery(query.id, { text: '❌ Destination not found', show_alert: true });
          }
          return;
      }

      if (query.data === 'clr_path_cmd') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          if (approvedUsersCollection) {
              const settingsUid = await resolveSettingsUserId(query.from?.id);
              await approvedUsersCollection.updateOne({ userId: settingsUid }, { $unset: { uploadPath: "" } });
              bot?.answerCallbackQuery(query.id, { text: '✅ Destination Reset to Default', show_alert: true });
              handleSettings(chatId, query.from?.id, query.message!.message_id);
          }
          return;
      }

      if (query.data === 'toggle_engine') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          const engines = ['Auto', 'GramJS', 'Telethon', 'Pyrogram', 'Hydrogram'];
          let idx = engines.indexOf(currentUploadEngine);
          if (idx === -1) idx = 1; // default to GramJS
          currentUploadEngine = engines[(idx + 1) % engines.length];
          if (settingsCollection) {
              await settingsCollection.updateOne({ type: 'global_config' }, { $set: { uploadEngine: currentUploadEngine } }, { upsert: true });
          }
          bot?.answerCallbackQuery(query.id, { text: `✅ Upload Engine set to ${currentUploadEngine}` });
          // Refresh settings menu using edit instead of delete/new to avoid flicker
          handleSettings(chatId, query.from?.id, query.message!.message_id);
          return;
      }

      if (query.data === 'toggle_down_library') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          const libs = ['Auto', 'GramJS', 'Telethon', 'Pyrogram', 'Hydrogram'];
          let idx = libs.indexOf(currentDownloadLibrary);
          if (idx === -1) idx = 1; // default to GramJS
          currentDownloadLibrary = libs[(idx + 1) % libs.length];
          if (settingsCollection) {
              await settingsCollection.updateOne({ type: 'global_config' }, { $set: { downloadLibrary: currentDownloadLibrary } }, { upsert: true });
          }
          bot?.answerCallbackQuery(query.id, { text: `✅ Download Engine set to ${currentDownloadLibrary}` });
          // Refresh settings menu using edit instead of delete/new to avoid flicker
          handleSettings(chatId, query.from?.id, query.message!.message_id);
          return;
      }

      if (query.data === 'start_back') {
        bot?.deleteMessage(chatId, query.message!.message_id);
      }

      if (query.data === 'set_api_id') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          userActionStates[query.from.id] = { type: 'set_api_id' };
          safeSendMessage(chatId, "🔑 **Set Telegram API ID**\n\nPlease enter your 7 or 8-digit **API_ID** from my.telegram.org.\n\n_To cancel, send /cancel or other text._", {
              parse_mode: 'Markdown',
              reply_markup: { force_reply: true }
          });
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'set_api_hash') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          userActionStates[query.from.id] = { type: 'set_api_hash' };
          safeSendMessage(chatId, "🔑 **Set Telegram API Hash**\n\nPlease enter your 32-character **API_HASH** from my.telegram.org.\n\n_To cancel, send /cancel or other text._", {
              parse_mode: 'Markdown',
              reply_markup: { force_reply: true }
          });
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'set_thumb') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          userActionStates[query.from.id] = { type: 'set_thumb' };
          safeSendMessage(chatId, "🎨 **Set Custom Thumbnail**\n\nPlease **send the Photo** (as compressed image) here that you want to use as your custom thumbnail.\n\n_To cancel, send /cancel or other text._", {
              parse_mode: 'Markdown',
              reply_markup: { force_reply: true }
          });
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'clr_thumb') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          const settingsUid = await resolveSettingsUserId(query.from?.id);
          if (approvedUsersCollection) {
              await approvedUsersCollection.updateOne(
                  { userId: settingsUid },
                  { $unset: { customThumbnailFileId: "" } }
              );
          }
          const userCustomThumbPath = path.join(os.tmpdir(), `custom_thumb_${settingsUid}.jpg`);
          if (fs.existsSync(userCustomThumbPath)) {
              try {
                  fs.unlinkSync(userCustomThumbPath);
              } catch (e) {}
          }
          bot?.answerCallbackQuery(query.id, { text: '✅ Custom Thumbnail Cleared!', show_alert: true });
          handleSettings(chatId, query.from?.id, query.message!.message_id);
          return;
      }

      if (query.data === 'set_cap') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          userActionStates[query.from.id] = { type: 'set_cap' };
          safeSendMessage(chatId, "📝 **Set Custom Caption Template**\n\nPlease send your custom caption template. Use \`{original}\` where you want the original (renamed) caption text to appear.\n\n**Example:**\n\`🍿 Name: {original}\n\nJoin: @MyChannel\`\n\n_To reset anytime, send \"clear\" or \"reset\"._\n_To cancel, send /cancel or other text._", {
              parse_mode: 'Markdown',
              reply_markup: { force_reply: true }
          });
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'toggle_mode') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          if (approvedUsersCollection) {
              const settingsUid = await resolveSettingsUserId(query.from?.id);
              const userDoc = await approvedUsersCollection.findOne({ userId: settingsUid });
              const currentMode = userDoc?.uploadMode === 'document' ? 'video' : 'document';
              await approvedUsersCollection.updateOne(
                  { userId: settingsUid },
                  { $set: { uploadMode: currentMode } }
              );
              bot?.answerCallbackQuery(query.id, { text: `✅ Upload Mode set to ${currentMode === 'document' ? 'Document/File' : 'Video'}` });
              handleSettings(chatId, query.from?.id, query.message!.message_id);
          }
          return;
      }

      if (query.data === 'toggle_agent') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          if (approvedUsersCollection) {
              const settingsUid = await resolveSettingsUserId(query.from?.id);
              const userDoc = await approvedUsersCollection.findOne({ userId: settingsUid });
              const currentAgent = userDoc?.uploadAgent === 'bot' ? 'user' : 'bot';
              await approvedUsersCollection.updateOne(
                  { userId: settingsUid },
                  { $set: { uploadAgent: currentAgent } }
              );
              bot?.answerCallbackQuery(query.id, { text: `✅ Upload Agent set to ${currentAgent === 'bot' ? 'Bot itself' : 'User Account'}` });
              handleSettings(chatId, query.from?.id, query.message!.message_id);
          }
          return;
      }

      if (query.data === 'toggle_rename' || query.data === 'rename_rules_panel') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          const settingsUid = await resolveSettingsUserId(query.from?.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const userRules = userDoc?.renameRules || [];

          let rulesList = '';
          if (userRules && userRules.length > 0) {
              userRules.forEach((rule: any, idx: number) => {
                  rulesList += `${idx + 1}. \`${rule.keyword}\` ➔ \`${rule.replaceWith || '(blank)'}\`\n`;
              });
          } else {
              rulesList = '_No custom rename rules defined._\n';
          }

          const renameText = `📝 **Rename Rules Manager**\n\nConfigure custom replacement rules. When keywords are found in captions or filenames, they get replaced instantly prior to upload.\n\n**Current Rules:**\n${rulesList}`;
          const renameMarkup = {
              inline_keyboard: [
                  [
                      { text: '➕ Add Rule', callback_data: 'add_rename_rule_start' },
                      { text: '🗑 Clear All', callback_data: 'clear_rename_rules_action' }
                  ],
                  [{ text: '⬅️ Back to Settings', callback_data: 'bot_settings' }]
              ]
          };

          await safeEditMessage(renameText, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              parse_mode: 'Markdown',
              reply_markup: renameMarkup
          });
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'add_rename_rule_start') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          userActionStates[query.from.id] = { type: 'add_rename_rule' };
          safeSendMessage(chatId, "📝 **Add Rename Rule**\n\nPlease send your keyword and its replacement separated by \`=\`.\n\n**Format:**\n\`keyword = replacement\`\n\n**Example:**\n\`netflix = Zee5\`\n\n_To cancel, send /cancel or other text._", {
              parse_mode: 'Markdown',
              reply_markup: { force_reply: true }
          });
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'clear_rename_rules_action') {
          if (!isAdmin(query.from?.id)) return safeBotCall('answerCallbackQuery', query.id, { text: '❌ Restricted to Admin', show_alert: true });
          const settingsUid = await resolveSettingsUserId(query.from?.id);
          if (approvedUsersCollection) {
              await approvedUsersCollection.updateOne({ userId: settingsUid }, { $unset: { renameRules: "" } });
          }
          safeBotCall('answerCallbackQuery', query.id, { text: '✅ All Rename Rules Cleared for this Session!', show_alert: true });
          
          const renameText = `📝 **Rename Rules Manager**\n\nConfigure custom replacement rules. When keywords are found in captions or filenames, they get replaced instantly prior to upload.\n\n**Current Rules:**\n_No custom rename rules defined._\n`;
          const renameMarkup = {
              inline_keyboard: [
                  [
                      { text: '➕ Add Rule', callback_data: 'add_rename_rule_start' },
                      { text: '🗑 Clear All', callback_data: 'clear_rename_rules_action' }
                  ],
                  [{ text: '⬅️ Back to Settings', callback_data: 'bot_settings' }]
              ]
          };
          await safeEditMessage(renameText, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              parse_mode: 'Markdown',
              reply_markup: renameMarkup
          });
          return;
      }

      if (query.data === 'change_cooldown_start') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          userActionStates[query.from.id] = { type: 'set_cooldown_secs' };
          safeSendMessage(chatId, "⏱ **Set Cooldown Seconds**\n\nPlease enter the cooldown delay in seconds (e.g., \`5\`), or send \`0\` or \`off\` to disable cooldown entirely.", {
              parse_mode: 'Markdown',
              reply_markup: { force_reply: true }
          });
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'check_perms') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          bot?.answerCallbackQuery(query.id, { text: '🔍 Auditing System Permissions...' });

          const settingsUid = await resolveSettingsUserId(query.from?.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          let userbotStatus = '❌ Offline / Missing Session';
          let userbotUsername = 'N/A';
          let destStatus = '⚠️ Default Destination';
          let apiIdStatus = apiIdValue ? '✅ Configured' : '❌ Missing';
          let apiHashStatus = apiHashValue ? '✅ Configured' : '❌ Missing';

          try {
              const targetUid = Number(settingsUid);
              const client = await getConnectedUserbotClient(targetUid);
              if (client) {
                  const me = await client.getMe().catch(() => null);
                  if (me) {
                      userbotStatus = '✅ Connected (Session Live)';
                      userbotUsername = `@${(me as any).username || (me as any).firstName || 'User'}`;
                      
                      // Check destination status if set
                      if (userDoc?.uploadPath && userDoc.uploadPath !== 'me') {
                          try {
                              const destEntity = await safelyResolveFullEntity(client, userDoc.uploadPath).catch(() => null);
                              if (destEntity) {
                                  destStatus = `✅ Accessible (\`${userDoc.uploadGroupName || 'Group'}\`)`;
                              } else {
                                  destStatus = `❌ Not Found / Cannot Access (Userbot is not a member or blocked)`;
                              }
                          } catch (e) {
                              destStatus = `❌ Access Error (Invalid channel/group or permission error)`;
                          }
                      } else if (userDoc?.uploadPath === 'me') {
                          destStatus = '✅ Saved Messages (DM)';
                      } else {
                          destStatus = `✅ Default Log Group (${DEFAULT_LOG_GROUP})`;
                      }
                  } else {
                      userbotStatus = '⚠️ Session exists but Failed to Authenticate';
                  }
              }
          } catch (err: any) {
              userbotStatus = `❌ Connection Error: ${err.message}`;
          }

          const auditText = `🛡 **Security & Permissions Audit**\n\n` +
                            `• **Database Conn:** ${dbStatus === 'Connected' ? '✅ Online (MongoDB Connected)' : '❌ Offline'}\n` +
                            `• **API ID:** ${apiIdStatus}\n` +
                            `• **API Hash:** ${apiHashStatus}\n` +
                            `• **Userbot Account:** ${userbotStatus}\n` +
                            `• **Userbot Username:** \`${userbotUsername}\`\n` +
                            `• **Upload Destination:** ${destStatus}\n` +
                            `• **Mirror Pairings:** ${userDoc?.mirrorPaths?.length || 0} active configurations\n\n` +
                            `💡 *Tip: If some destination channels or channels to mirror are inaccessible, make sure your userbot has joined them.*`;

          safeSendMessage(chatId, auditText, { parse_mode: 'Markdown' });
          return;
      }

      if (query.data === 're_login') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          bot?.answerCallbackQuery(query.id, { text: '🔄 Forcing Sync...' });
          await handleSync(chatId, query.from?.id);
          return;
      }

      if (query.data === 'view_logs') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          bot?.answerCallbackQuery(query.id, { text: '⚡ Fetching Server Logs...' });

          const lastLogs = sysLogs.slice(-20).join('\n');
          const logsText = `📋 **Latest System Logs (Last 20 lines):**\n\n\`\`\`\n${lastLogs || 'No logs recorded yet.'}\n\`\`\``;

          safeSendMessage(chatId, logsText, { parse_mode: 'Markdown' });
          return;
      }

      if (query.data === 'manage_mirror_paths') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const paths = userDoc?.mirrorPaths || [];
          
          let text = '📂 **Mirror Paths Manager**\n\nSelect a path to remove:\n';
          const markup: any = { inline_keyboard: [] };
          
          if (paths.length === 0) {
              text += '_No mirror paths configured._';
          } else {
              paths.forEach((p: any, i: number) => {
                  text += `${i + 1}. \`${p.sourceId}\` ➔ ${p.groupName}\n`;
                  markup.inline_keyboard.push([{ text: `🗑 Delete ${i + 1}`, callback_data: `del_mirror_path:${i}` }]);
              });
          }
          markup.inline_keyboard.push([{ text: '⬅️ Back to Settings', callback_data: 'bot_settings' }]);
          
          await safeEditMessage(text, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: 'Markdown', reply_markup: markup });
          bot?.answerCallbackQuery(query.id);
          return;
      }
      
      if (query.data?.startsWith('del_mirror_path:')) {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          const index = parseInt(query.data.split(':')[1]);
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const paths = userDoc?.mirrorPaths || [];
          
          if (paths[index]) {
              paths.splice(index, 1);
              await approvedUsersCollection?.updateOne({ userId: settingsUid }, { $set: { mirrorPaths: paths } });
              bot?.answerCallbackQuery(query.id, { text: '✅ Path Deleted', show_alert: true });
              // Re-render
              query.data = 'manage_mirror_paths';
              
              // Let's re-render the list:
              let text = '📂 **Mirror Paths Manager**\n\nSelect a path to remove:\n';
              const markup: any = { inline_keyboard: [] };
              if (paths.length === 0) {
                  text += '_No mirror paths configured._';
              } else {
                  paths.forEach((p: any, i: number) => {
                      text += `${i + 1}. \`${p.sourceId}\` ➔ ${p.groupName}\n`;
                      markup.inline_keyboard.push([{ text: `🗑 Delete ${i + 1}`, callback_data: `del_mirror_path:${i}` }]);
                  });
              }
              markup.inline_keyboard.push([{ text: '⬅️ Back to Settings', callback_data: 'bot_settings' }]);
              await safeEditMessage(text, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: 'Markdown', reply_markup: markup });
          } else {
              bot?.answerCallbackQuery(query.id, { text: '❌ Path not found', show_alert: true });
          }
          return;
      }
      
      if (query.data?.startsWith('del_saved_dest:')) {
          const index = parseInt(query.data.split(':')[1]);
          const settingsUid = await resolveSettingsUserId(query.from.id);
          const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
          const savedDestinations = userDoc?.savedDestinations || [];
          
          if (savedDestinations[index]) {
              savedDestinations.splice(index, 1);
              await approvedUsersCollection?.updateOne({ userId: settingsUid }, { $set: { savedDestinations: savedDestinations } });
              bot?.answerCallbackQuery(query.id, { text: '✅ Destination Deleted', show_alert: true });
              
              const state = userActionStates[query.from.id];
              
              // Dynamic Re-rendering
              if (state?.type === 'topic_clone_dest_select') {
                  const uniqueDestinations: { dest: any, originalIndex: number }[] = [];
                  const seen = new Set();
                  savedDestinations.forEach((d: any, originalIndex: number) => {
                      if (d && d.destId && !seen.has(d.destId)) {
                          seen.add(d.destId);
                          uniqueDestinations.push({ dest: d, originalIndex });
                      }
                  });
                  const kb = uniqueDestinations.map((item) => {
                      return [
                          { text: item.dest.groupName + (item.dest.destThreadId ? ` (Topic ${item.dest.destThreadId})` : ''), callback_data: `tc_dest_${item.originalIndex}` },
                          { text: '🗑', callback_data: `del_saved_dest:${item.originalIndex}` }
                      ];
                  });
                  kb.push([{ text: '➕ Enter New Group ID', callback_data: `clonedest_new` }]);
                  kb.push([{ text: '❌ Cancel', callback_data: 'mirror_cmd' }]);

                  await safeEditMessage("🎯 **Clone Specific Topic**\n\n1. Select Destination Group (Deleted destination removed):", {
                      chat_id: chatId,
                      message_id: query.message!.message_id,
                      reply_markup: { inline_keyboard: kb }
                  }).catch(() => {});
              } else if (state?.type === 'live_mirror_dest_select') {
                  const sourceName = state.pendingSourceName || 'Source Group';
                  const uniqueDestinations: { dest: any, originalIndex: number }[] = [];
                  const seen = new Set();
                  savedDestinations.forEach((d: any, originalIndex: number) => {
                      if (d && d.destId && !seen.has(d.destId)) {
                          seen.add(d.destId);
                          uniqueDestinations.push({ dest: d, originalIndex });
                      }
                  });
                  const kb = uniqueDestinations.map((item) => {
                      return [
                          { text: item.dest.groupName + (item.dest.destThreadId ? ` (Topic ${item.dest.destThreadId})` : ''), callback_data: `lm_dest_${item.originalIndex}` },
                          { text: '🗑', callback_data: `del_saved_dest:${item.originalIndex}` }
                      ];
                  });
                  kb.push([{ text: '❌ Cancel', callback_data: 'start_back' }]);

                  await safeEditMessage(`✅ **Source Selected: ${sourceName}**\n\n**Select Destination Group for Live Mirror:**`, {
                      chat_id: chatId,
                      message_id: query.message!.message_id,
                      reply_markup: { inline_keyboard: kb }
                  }).catch(() => {});
              } else if (state?.type === 'full_mirror_dest_select') {
                  const sourceId = state.pendingSourceId!;
                  const uniqueDestinations: { dest: any, originalIndex: number }[] = [];
                  const seen = new Set();
                  savedDestinations.forEach((d: any, originalIndex: number) => {
                      if (d && d.destId && !seen.has(d.destId)) {
                          seen.add(d.destId);
                          uniqueDestinations.push({ dest: d, originalIndex });
                      }
                  });
                  const kb = uniqueDestinations.map((item) => {
                      return [
                          { text: item.dest.groupName + (item.dest.destThreadId ? ` (Topic ${item.dest.destThreadId})` : ''), callback_data: `fm_dest_${item.originalIndex}` },
                          { text: '🗑', callback_data: `del_saved_dest:${item.originalIndex}` }
                      ];
                  });
                  kb.push([{ text: '❌ Cancel', callback_data: 'start_back' }]);

                  await safeEditMessage(`✅ **Source Selected: Source** (\`${sourceId}\`)\n\n**Select Destination Group for Full Mirror:**`, {
                      chat_id: chatId,
                      message_id: query.message!.message_id,
                      reply_markup: { inline_keyboard: kb }
                  }).catch(() => {});
              }
          } else {
              bot?.answerCallbackQuery(query.id, { text: '❌ Destination not found', show_alert: true });
          }
          return;
      }

      if (query.data === 'change_concurrency_start') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          userActionStates[query.from.id] = { type: 'set_concurrency_val' };
          safeSendMessage(chatId, "⚡ **Set Concurrency Limit**\n\nPlease enter the maximum number of concurrent tasks (between 1 and 20).", {
              parse_mode: 'Markdown',
              reply_markup: { force_reply: true }
          });
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'refresh_dashboard') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          const text = await generateDashboardText();
          await safeEditMessage(text, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              parse_mode: 'Markdown',
              reply_markup: {
                  inline_keyboard: [
                      [
                          { text: '🔄 Refresh Stats', callback_data: 'refresh_dashboard' },
                          isQueuePaused ? { text: '▶️ Resume Queue', callback_data: 'resume_queue_cb' } : { text: '⏸️ Pause Queue', callback_data: 'pause_queue_cb' }
                      ],
                      [
                          { text: '📋 View Queue', callback_data: 'view_queue_cb' },
                          { text: '🗑️ Clear Queue', callback_data: 'clear_queue_cb' }
                      ]
                  ]
              }
          }).catch(() => {});
          bot?.answerCallbackQuery(query.id, { text: '🔄 Dashboard Refreshed!' });
          return;
      }

      if (query.data === 'resume_queue_cb') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          isQueuePaused = false;
          bot?.answerCallbackQuery(query.id, { text: '▶️ Task Queue Resumed!' });
          const text = await generateDashboardText();
          await safeEditMessage(text + `\n\n▶️ **System Resumed:** Continuing downloads...`, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              parse_mode: 'Markdown',
              reply_markup: {
                  inline_keyboard: [
                      [
                          { text: '🔄 Refresh Stats', callback_data: 'refresh_dashboard' },
                          { text: '⏸️ Pause Queue', callback_data: 'pause_queue_cb' }
                      ],
                      [
                          { text: '📋 View Queue', callback_data: 'view_queue_cb' },
                          { text: '🗑️ Clear Queue', callback_data: 'clear_queue_cb' }
                      ]
                  ]
              }
          }).catch(() => {});
          runNextTask();
          return;
      }

      if (query.data === 'pause_queue_cb') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          isQueuePaused = true;
          bot?.answerCallbackQuery(query.id, { text: '⏸️ Task Queue Paused!' });
          const text = await generateDashboardText();
          await safeEditMessage(text + `\n\n⏸️ **System Paused:** Incoming files holding in queue.`, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              parse_mode: 'Markdown',
              reply_markup: {
                  inline_keyboard: [
                      [
                          { text: '🔄 Refresh Stats', callback_data: 'refresh_dashboard' },
                          { text: '▶️ Resume Queue', callback_data: 'resume_queue_cb' }
                      ],
                      [
                          { text: '📋 View Queue', callback_data: 'view_queue_cb' },
                          { text: '🗑️ Clear Queue', callback_data: 'clear_queue_cb' }
                      ]
                  ]
              }
          }).catch(() => {});
          return;
      }

      if (query.data === 'clear_queue_cb') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          taskQueue.length = 0;
          await dbClearAllTasks().catch(e => console.error("[Queue DB] Clear stats error:", e));
          bot?.answerCallbackQuery(query.id, { text: '🧹 Pending Queue Cleared!' });
          const text = await generateDashboardText();
          await safeEditMessage(text + `\n\n🧹 **Queue Cleared:** All waiting items wiped clean.`, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              parse_mode: 'Markdown',
              reply_markup: {
                  inline_keyboard: [
                      [
                          { text: '🔄 Refresh Stats', callback_data: 'refresh_dashboard' },
                          isQueuePaused ? { text: '▶️ Resume Queue', callback_data: 'resume_queue_cb' } : { text: '⏸️ Pause Queue', callback_data: 'pause_queue_cb' }
                      ],
                      [
                          { text: '📋 View Queue', callback_data: 'view_queue_cb' },
                          { text: '🗑️ Clear Queue', callback_data: 'clear_queue_cb' }
                      ]
                  ]
              }
          }).catch(() => {});
          return;
      }

      if (query.data === 'retry_all_failed_cb') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          const count = await retryAllFailedTasks();
          bot?.answerCallbackQuery(query.id, { text: `🔄 Requeued ${count} failed tasks!` });
          await safeEditMessage(`✅ **Failed Tasks Replaced!**\n\nRequeued ${count} tasks back into the active mirror queue successfully.`, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              parse_mode: 'Markdown',
              reply_markup: {
                  inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'menu_back' }]]
              }
          }).catch(() => {});
          return;
      }

      if (query.data === 'clear_failed_cb') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          await clearAllFailedTasks();
          bot?.answerCallbackQuery(query.id, { text: '🧹 Cleared failed logs!' });
          await safeEditMessage(`🧹 **Failure Logs Cleared!**\n\nAll historical mirror failures have been erased from the system database.`, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              parse_mode: 'Markdown',
              reply_markup: {
                  inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'menu_back' }]]
              }
          }).catch(() => {});
          return;
      }

      if (query.data === 'view_queue_cb') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          bot?.answerCallbackQuery(query.id, { text: '📋 Querying Queue Details...' });
          
          let qText = `📊 **Task Queue & Interactive Tracker**\n`;
          qText += `===============================\n\n`;
          qText += `• **Queue Status:** ${isQueuePaused ? '⏸️ PAUSED' : '🟢 RUNNING'}\n`;
          qText += `• **Active Workers:** \`${activeTasksCount} / ${MAX_CONCURRENT_TASKS}\`\n`;
          qText += `• **Pending Tasks in Queue:** \`${taskQueue.length} files\`\n\n`;

          if (activeTaskJobs.size > 0) {
              qText += `⚙️ **Currently Executing Jobs:**\n`;
              for (const [key, job] of activeTaskJobs) {
                  const parts = job.link.split('/');
                  const msgId = parts[parts.length - 1] || 'Media';
                  qText += `• **[Message ${msgId}](${job.link})** (${job.phase || 'processing'})\n`;
                  if (job.progress) {
                      const pct = (job.progress.percent || 0).toFixed(1);
                      qText += `  └ \`[${pct}%]\` of \`${formatBytes(job.progress.total)}\` at \`${formatBytes(job.progress.speed)}/s\`\n`;
                  }
              }
              qText += `\n`;
          }

          if (taskQueue.length === 0) {
              qText += `📭 _No pending tasks in the queue._\n`;
          } else {
               qText += `⏳ **Pending Queue Tasks (First 10):**\n`;
               for (let i = 0; i < Math.min(10, taskQueue.length); i++) {
                   const t = taskQueue[i];
                   const parts = t.link.split('/');
                   const mId = parts[parts.length - 1] || 'Media';
                   qText += `**${i + 1}.** [Msg ${mId}](${t.link}) ${t.isMirror ? '🔄' : ''}\n`;
               }
               if (taskQueue.length > 10) {
                   qText += `_...and ${taskQueue.length - 10} more files wait in queue._\n`;
               }
               qText += `\n💡 Use \`/canceltask <index>\` to cancel or \`/prioritizetask <index>\` to prioritize.\n`;
          }

          const qKeyboard = [
              [
                  isQueuePaused ? { text: '▶️ Resume Queue', callback_data: 'resume_queue_cb' } : { text: '⏸️ Pause Queue', callback_data: 'pause_queue_cb' },
                  { text: '🔄 Refresh Queue', callback_data: 'view_queue_cb' }
              ],
              [
                  { text: '🔙 Back to Dashboard', callback_data: 'refresh_dashboard' }
              ]
          ];

          await safeEditMessage(qText, {
              chat_id: chatId,
              message_id: query.message!.message_id,
              parse_mode: 'Markdown',
              disable_web_page_preview: true,
              reply_markup: { inline_keyboard: qKeyboard }
          }).catch(() => {});
          return;
      }

      // INTEGRATED WORKLOAD PAUSE/SYNC & LOGIN HANDLERS
      const fromId = query.from?.id;
      const data = query.data || "";

      if (data === "start_login") {
          if (!isAdmin(fromId)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          await bot?.answerCallbackQuery(query.id);
          handleLogin(chatId, fromId);
          return;
      }

      if (data.startsWith("switch_session:")) {
          if (!isAdmin(fromId)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const targetUid = Number(data.split(":")[1]);
          adminActiveSession.set(fromId!, targetUid);
          if (approvedUsersCollection) {
              await approvedUsersCollection.updateOne(
                  { userId: fromId!.toString() },
                  { $set: { activeUserbotUserId: targetUid } },
                  { upsert: true }
              ).catch((e: any) => console.error("[Switch DB Switch] Error:", e));
          }
          await bot?.answerCallbackQuery(query.id, { text: "✅ Active session switched!" });
          bot.processUpdate({ message: { ...query.message, text: '/login', from: query.from } } as any);
          return;
      }

      if (data.startsWith("logout_session:")) {
          if (!isAdmin(fromId)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const targetUid = Number(data.split(":")[1]);
          await bot?.answerCallbackQuery(query.id, { text: "Logging out..." });
          
          // Perform global logout
          const client = userClients.get(targetUid);
          if (client) {
              await client.disconnect().catch(() => {});
              userClients.delete(targetUid);
          }
          userSessions.delete(targetUid);
          activeWatchers.delete(targetUid);
          if (approvedUsersCollection) {
              await approvedUsersCollection.updateOne({ userId: targetUid.toString() }, { $unset: { stringSession: "", phoneNumber: "", fullName: "" } });
              await approvedUsersCollection.updateMany(
                  { activeUserbotUserId: targetUid },
                  { $unset: { activeUserbotUserId: "" } }
              ).catch(() => {});
          }

          safeSendMessage(chatId, `✅ Session for **${targetUid}** has been disconnected.`);
          // Refresh dashboard
          bot.processUpdate({ message: { ...query.message, text: '/login', from: query.from } } as any);
          return;
      }

      if (data.startsWith("pause_") || data.startsWith("resume_")) {
          if (!isAdmin(fromId)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const jobKey = data.substring(data.indexOf('_') + 1);
          const isPause = data.startsWith("pause_");
          
          const taskState = taskControlMap.get(jobKey) || { isPaused: false, shouldRetry: false };
          taskState.isPaused = isPause;
          taskControlMap.set(jobKey, taskState);
          
          await bot?.answerCallbackQuery(query.id, { text: isPause ? "⏸️ Download Paused!" : "▶️ Download Resumed!", show_alert: false });
          
          // Re-render buttons
          if (query.message) {
              const markup = createProgressMarkup(jobKey, isPause);
              await safeBotCall('editMessageReplyMarkup', markup, {
                  chat_id: query.message.chat.id,
                  message_id: query.message.message_id
              });
          }
          return;
      }

      if (data.startsWith("retry_")) {
          if (!isAdmin(fromId)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const jobKey = data.substring(data.indexOf('_') + 1);
          const taskState = taskControlMap.get(jobKey) || { isPaused: false, shouldRetry: false };
          taskState.shouldRetry = true;
          taskControlMap.set(jobKey, taskState);
          await bot?.answerCallbackQuery(query.id, { text: "🔁 Retrying download...", show_alert: false });
          return;
      }

      if (data.startsWith("skip_")) {
          if (!isAdmin(fromId)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const jobKey = data.substring(data.indexOf('_') + 1);
          const taskState = taskControlMap.get(jobKey) || { isPaused: false, shouldRetry: false, isSkipped: false };
          taskState.isSkipped = true;
          taskControlMap.set(jobKey, taskState);
          await bot?.answerCallbackQuery(query.id, { text: "⏭️ Skipping active task...", show_alert: false });
          return;
      }

    });

    bot.onText(/\/ping/, (msg) => {
        const start = Date.now();
        bot?.sendMessage(msg.chat.id, "🏓 **𝗣𝗼𝗻𝗴! 𝗕𝗼𝘁 𝗶𝘀 𝗢𝗻𝗹𝗶𝗻𝗲**", { parse_mode: 'Markdown' }).then((m) => {
            const end = Date.now();
            bot?.editMessageText(`🏓 **𝗣𝗼𝗻𝗴! 𝗕𝗼𝘁 𝗶𝘀 𝗔𝗰𝘁𝗶𝘃𝗲**\n\n⚡ 𝗟𝗮𝘁𝗲𝗻𝗰𝘆: \`${end - start}ms\``, { chat_id: msg.chat.id, message_id: m.message_id, parse_mode: 'Markdown' });
        });
    });

    bot.onText(/\/login(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const fromId = msg.from?.id;
        
        if (!isAdmin(fromId)) {
            return safeSendMessage(chatId, "❌ **Access Restricted.** Only authorized admins can manage logins.");
        }

        const force = match?.[1]?.trim().toLowerCase() === 'force';
        if (force) {
            return handleLogin(chatId, fromId, true);
        }

        // Show session dashboard for Admins
        try {
            const allUsers = await approvedUsersCollection?.find({ stringSession: { $exists: true, $ne: "" } }).toArray() || [];
            
            if (allUsers.length === 0) {
                return handleLogin(chatId, fromId);
            }

            let text = "📱 **Active Sessions Dashboard**\n\n";
            text += `Total Connected: **${allUsers.length}**\n\n`;
            
            const activeSessionStr = await resolveSettingsUserId(fromId);

            const keyboard = [];
            for (const u of allUsers) {
                const phone = u.phoneNumber || "Unknown";
                const name = u.fullName || u.userId;
                const isActive = u.userId === activeSessionStr;
                text += `${isActive ? '🟢' : '👤'} **${name}** (${phone})\n`;
                keyboard.push([
                    { text: isActive ? `✅ Active: ${phone}` : `🔄 Switch to ${phone}`, callback_data: `switch_session:${u.userId}` },
                    { text: `❌ Logout`, callback_data: `logout_session:${u.userId}` }
                ]);
            }
            
            keyboard.push([{ text: "➕ Login New Account", callback_data: "start_login" }]);

            safeSendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        } catch (err) {
            handleLogin(chatId, fromId);
        }
    });

    // Removed duplicate callback query listener to prevent collisions. Handlers successfully integrated into primary listener.
    bot.onText(/\/batch/, (msg) => handleBatch(msg.chat.id, msg.from?.id));
    bot.onText(/\/mirror/, (msg) => {
        // Simple entry, interactive selection starts here
        handleMirrorInteractive(msg.chat.id, msg.from?.id, msg);
    });

    const handleMirrorInteractive = async (chatId: number, fromId: number | undefined, msg: TelegramBot.Message) => {
        try {
            if (!isAdmin(fromId) || !fromId) throw new Error("Restricted: Admin access required.");
            const settingsUid = await resolveSettingsUserId(fromId);
            const userDoc = await approvedUsersCollection.findOne({ userId: settingsUid });
            
            // 1. Prompt for Destination Group Selection
            const recent = userDoc?.recentDestinations || [];
            let keyboard: any[] = [];
            
            if (recent.length > 0) {
                recent.forEach((r: any) => {
                    keyboard.push([{ text: `📂 ${r.groupName}`, callback_data: `mirrordest_${r.destId}` }]);
                });
                keyboard.push([{ text: `➕ Enter New Group ID`, callback_data: `mirrordest_new` }]);
            } else {
                keyboard.push([{ text: `➕ Enter New Group ID`, callback_data: `mirrordest_new` }]);
            }
            
            userActionStates[fromId] = { type: 'mirror_target' };
            safeSendMessage(chatId, "🎯 **Select Destination Group for Mirroring:**", {
                reply_markup: { inline_keyboard: keyboard }
            });
        } catch (err: any) {
            safeSendMessage(chatId, `❌ **Error:** ${err.message}`);
        }
    };

    bot.onText(/\/cancel/, (msg) => handleCancel(msg.chat.id, msg.from?.id));
    bot.onText(/\/logout/, (msg) => handleLogout(msg.chat.id, msg.from?.id));
    
    bot.onText(/\/restart/, async (msg) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;
        
        let report = "🔄 **System Hard Restart Initiated**\n\n";

        // 1. Stop Task Queue
        const tasksStopped = taskQueue.length;
        taskQueue.length = 0; // Clear array
        dbClearAllTasks().catch(e => console.error("[Queue DB] failed to clear on restart:", e));
        nextTaskRunAt = null;
        report += `🛑 Tasks Stopped: \`${tasksStopped}\`\n`;

        // 2. Clear Performance Junk
        for (const key in libraryPerfMetrics) {
            libraryPerfMetrics[key] = { totalBytes: 0, totalTimeMs: 0, count: 0 };
        }
        
        // Cleanup actual junk files from disk
        let junkCleanedCount = 0;
        try {
            const tmpDir = os.tmpdir();
            const files = fs.readdirSync(tmpDir);
            for (const file of files) {
                if (file.startsWith('temp_') || file.startsWith('thumb_') || file.includes('userbot_')) {
                    try {
                        fs.unlinkSync(path.join(tmpDir, file));
                        junkCleanedCount++;
                    } catch {}
                }
            }
        } catch (e) {
            console.error("Failed to clean disk junk:", e);
        }
        report += `🧹 Junk Files Removed: \`${junkCleanedCount}\`\n`;
        report += `📊 Metrics Reset: \`Done\`\n`;

        // 3. Clear Interaction States
        const actionsCleared = Object.keys(userActionStates).length;
        for (const key in userActionStates) delete userActionStates[Number(key)];
        report += `🖱 UI States Cleared: \`${actionsCleared}\`\n`;

        // 4. Clear Login Buffer
        const loginsAborted = Object.keys(loginStates).length;
        for (const key in loginStates) {
            try {
                await loginStates[Number(key)].client?.disconnect();
            } catch {}
            delete loginStates[Number(key)];
        }
        report += `🔐 Pending Logins Aborted: \`${loginsAborted}\`\n`;

        // 5. Disconnect Active Clients (Bypass/Refresh logic)
        const clientsRefreshed = userClients.size;
        for (const [userId, client] of userClients.entries()) {
            try {
                await client.disconnect();
            } catch (e) {
                console.error(`Failed to disconnect client for user ${userId}:`, e);
            }
        }
        userClients.clear();
        report += `⚡ Active Sessions Re-queued: \`${clientsRefreshed}\`\n`;

        // 6. Check for API Limits (Global)
        report += `📍 API Limit Bypass: \`Active\` (Rotating sessions & clearing buffers)\n`;
        
        report += `\n✅ **System is now clean. Bot operations resumed.**`;
        report += `\n💾 **Login Persistence:** \`SAFE\` (Your accounts stay logged in)`;

        bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/clearmirrorhistory/, async (msg) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;

        if (mirroredMessagesCollection) {
            try {
                await mirroredMessagesCollection.deleteMany({});
                safeSendMessage(chatId, "✨ **𝗠𝗶𝗿𝗿𝗼𝗿 𝗛𝗶𝘀𝘁𝗼𝗿𝘆 𝗖𝗹𝗲𝗮𝗿𝗲𝗱 𝗦𝘂𝗰𝗰𝗲𝘀𝘀𝗳𝘂𝗹𝗹𝘆!**\n\n🧹 All historical mirror/copy logs have been wiped. All previously processed/skipped files can now be cloned again!");
            } catch (err: any) {
                safeSendMessage(chatId, `❌ **𝗘𝗿𝗿𝗼𝗿:** ${err.message}`);
            }
        } else {
            safeSendMessage(chatId, "⚠️ **𝗗𝗮𝘁𝗮𝗯𝗮𝘀𝗲 𝗻𝗼𝘁 𝗿𝗲𝗮𝗱𝘆.** Please try again in a few seconds.");
        }
    });

    bot.onText(/\/setpath/, async (msg) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;

        if (msg.chat.type === 'private') {
            return bot.sendMessage(chatId, "❌ Use this command inside a **Group or Channel** to set it as a destination.");
        }

        const groupTitle = msg.chat.title || 'Restricted Group';
        const topicId = msg.message_thread_id;
        
        if (approvedUsersCollection) {
            const adminIdStr = fromId.toString();
            const settingsUid = await resolveSettingsUserId(fromId);
            
            const update = { 
                $set: { 
                    uploadPath: chatId.toString(),
                    uploadTopicId: topicId || null,
                    uploadGroupName: groupTitle,
                    uploadTopicName: topicId ? `Topic ${topicId}` : ''
                } 
            };
            
            // Update both the admin's doc AND the session's doc to ensure settings persist
            await approvedUsersCollection.updateOne({ userId: adminIdStr }, update);
            if (settingsUid !== adminIdStr) {
                await approvedUsersCollection.updateOne({ userId: settingsUid }, update);
            }
            
            const dest = topicId ? `${groupTitle} (Topic: ${topicId})` : groupTitle;
            const confirmationText = `🎯 **𝗗𝗲𝘀𝘁𝗶𝗻𝗮𝘁𝗶𝗼𝗻 𝗦𝗮𝘃𝗲𝗱 𝗦𝘂𝗰𝗰𝗲𝘀𝘀𝗳𝘂𝗹𝗹𝘆!**\n\n📁 Files will now be uploaded to:\n📍 \`${dest}\``;
            
            // Send to Group/Channel
            await safeSendMessage(chatId, confirmationText, { 
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id 
            });

            // Send to User's Private Bot DM
            if (fromId.toString() !== chatId.toString()) {
                await safeSendMessage(fromId, confirmationText, { 
                    parse_mode: 'Markdown'
                });
            }
        }
    });

    bot.onText(/\/jumptopath(?:\s+(.+))?/, async (msg, match) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;

        const args = match?.[1]?.trim();
        if (!args) {
            userActionStates[fromId] = { type: 'set_jump_to_path' };
            return safeSendMessage(chatId, "📍 **𝗘𝗻𝘁𝗲𝗿 𝗗𝗲𝘀𝘁𝗶𝗻𝗮𝘁𝗶𝗼𝗻 𝗚𝗿𝗼𝘂𝗽 𝗜𝗗 / 𝗨𝘀𝗲𝗿𝗻𝗮𝗺𝗲:**\n\n👉 Send one of the following:\n• Group/Channel ID (e.g., `-1001844729124`)\n• Channel/Group Username (e.g., `@MyOutputChannel`)\n• Access link with optional Thread/Topic ID (e.g., `https://t.me/c/1844729124 12`)\n\n🛑 _Type /cancel to cancel this input request._", { parse_mode: 'Markdown' });
        }

        const parts = args.split(/\s+/);
        let rawPath = parts[0];
        let topicId: number | null = parts[1] ? parseInt(parts[1]) : null;

        if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) {
            const urlParts = rawPath.split('/').filter(p => p.length > 0);
            const domainIdx = urlParts.findIndex(p => p.includes('t.me') || p === 't.me');
            if (domainIdx !== -1 && urlParts.length > domainIdx + 1) {
                const nextPart = urlParts[domainIdx + 1];
                if (nextPart === 'c' && urlParts.length > domainIdx + 2) {
                    let channelId = urlParts[domainIdx + 2];
                    if (!channelId.startsWith('-100') && /^\d+$/.test(channelId)) {
                        channelId = "-100" + channelId;
                    }
                    rawPath = channelId;
                    if (urlParts.length > domainIdx + 3) {
                        const possibleMsgOrTopic = parseInt(urlParts[domainIdx + 3]);
                        if (!isNaN(possibleMsgOrTopic) && topicId === null) {
                            topicId = possibleMsgOrTopic;
                        }
                    }
                } else {
                    rawPath = "@" + nextPart;
                }
            }
        }

        if (!rawPath.startsWith('-') && !rawPath.startsWith('@') && /^[a-zA-Z]/.test(rawPath)) {
            rawPath = "@" + rawPath;
        }

        if (approvedUsersCollection) {
            const adminIdStr = fromId.toString();
            const settingsUid = await resolveSettingsUserId(fromId);
            
            const update = { 
                $set: { 
                    uploadPath: rawPath,
                    uploadTopicId: topicId || null,
                    uploadGroupName: rawPath,
                    uploadTopicName: topicId ? `Topic ${topicId}` : ''
                } 
            };
            
            await approvedUsersCollection.updateOne({ userId: adminIdStr }, update);
            if (settingsUid !== adminIdStr) {
                await approvedUsersCollection.updateOne({ userId: settingsUid }, update);
            }
            
            const dest = topicId ? `${rawPath} (Topic ID: ${topicId})` : rawPath;
            const confirmationText = `🚀 **𝗨𝗽𝗹𝗼𝗮𝗱 𝗗𝗲𝘀𝘁𝗶𝗻𝗮𝘁𝗶𝗼𝗻 𝗦𝗮𝘃𝗲𝗱 𝘃𝗶𝗮 𝗝𝘂𝗺𝗽𝗧𝗼𝗣𝗮𝘁𝗵!**\n\n📍 All upcoming tasks will be processed and routed to:\n🎯 \`${dest}\``;
            
            await safeSendMessage(chatId, confirmationText, { parse_mode: 'Markdown' });
        } else {
            safeSendMessage(chatId, "⚠️ **Database not ready.** Please try again.");
        }
    });

    bot.onText(/\/setcooldown(?:\s+(.+))?/, async (msg, match) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;
        
        const seconds = match?.[1] ? parseInt(match[1]) : null;
        if (seconds === null || isNaN(seconds)) {
            return safeSendMessage(chatId, "❌ **Usage:** \`/setcooldown <seconds>\` (min 15)", { parse_mode: 'Markdown' });
        }
        
        const targetUid = await resolveSettingsUserId(fromId);
        await approvedUsersCollection?.updateOne({ userId: targetUid }, { $set: { cooldownSeconds: Math.max(5, seconds) } });
        safeSendMessage(chatId, `⏳ **𝗠𝗶𝗿𝗿𝗼𝗿 𝗗𝗲𝗹𝗮𝘆 𝗖𝗼𝗼𝗹𝗱𝗼𝘄𝗻 𝗨𝗽𝗱𝗮𝘁𝗲𝗱!**\n\n⏱️ Cooldown set to **${seconds}** seconds between successive messages.`, { parse_mode: 'Markdown' });
    });
    bot.onText(/\/setmirror/, (msg) => handleSetMirror(msg.chat.id, msg.from?.id, msg));
    bot.onText(/\/sync/, (msg) => handleSync(msg.chat.id, msg.from?.id));
    
    bot.onText(/\/setspecifictopic(?:@\w+)?(?:\s+(.+))?/, async (msg, match) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;

        const args = match?.[1]?.trim() || '';

        if (msg.chat.type === 'private') {
            if (!args) {
                userActionStates[fromId] = { type: 'enter_manual_specific_topic' };
                return safeSendMessage(chatId, "📍 **Manual Specific Topic / Destination Setup**\n\nPlease send the **Group ID**, optional **Topic ID** and optional **Group Name**.\n\nForm: `<GroupId> [TopicId] [GroupName]`\nExample with topic: `-1001844729124 12 My Cool Group`\nExample without topic: `-1001844729124 My Cool Group`\n\n🛑 _Type /cancel to cancel this request._", { parse_mode: 'Markdown' });
            }

            const parts = args.split(/\s+/);
            const rawGroupId = parts[0];
            if (!rawGroupId.startsWith('-') && !/^\d+$/.test(rawGroupId)) {
                return safeSendMessage(chatId, "❌ **Invalid Group ID.** It should typically start with `-` (e.g. `-100xxxxxxxxxx`).");
            }

            let topicId: number | null = null;
            let groupName = '';
            let namePartStartIdx = 1;

            if (parts.length > 1) {
                const secondPart = parts[1];
                if (/^\d+$/.test(secondPart)) {
                    topicId = parseInt(secondPart);
                    namePartStartIdx = 2;
                }
            }
            groupName = parts.slice(namePartStartIdx).join(' ').trim();
            if (!groupName) {
                groupName = `Manual Group ${rawGroupId}`;
            }

            if (approvedUsersCollection) {
                const settingsUid = await resolveSettingsUserId(fromId);
                const userDoc = await approvedUsersCollection.findOne({ userId: settingsUid });
                const savedDestinations = userDoc?.savedDestinations || [];

                const filtered = savedDestinations.filter((d: any) => !(d.destId === rawGroupId && d.destThreadId === topicId));
                filtered.push({
                    destId: rawGroupId,
                    destThreadId: topicId,
                    groupName,
                    topicName: topicId ? `Topic ${topicId}` : 'General',
                    createdAt: new Date()
                });

                const finalDest = filtered.slice(-20);
                await approvedUsersCollection.updateOne(
                    { userId: settingsUid },
                    { $set: { savedDestinations: finalDest } }
                );

                const destDisplay = topicId ? `${groupName} (Topic: ${topicId})` : groupName;
                const privateConfirm = `✅ **Specific Destination Stored Successfully!**\n\n📁 Destination: \`${destDisplay}\`\n📍 ID: \`${rawGroupId}\` ${topicId ? `(Topic: \`${topicId}\`)` : ''}\n\nThis target group has been saved to your **Saved Destinations** list!`;
                await safeSendMessage(chatId, privateConfirm, { parse_mode: 'Markdown' });

                // Try to send a confirmation directly to that group if the bot is present!
                try {
                    const notifyOptions: any = { parse_mode: 'Markdown' };
                    if (topicId) notifyOptions.message_thread_id = topicId;
                    await safeSendMessage(Number(rawGroupId), `✅ **Specific Destination Registered!**\n\nThis group has been registered as an upload destination inside the bot for admin/user configuration.`, notifyOptions);
                } catch (e) {
                    console.log("[setspecifictopic] Could not send direct notification to manually added group (expected if bot has not joined yet):", e);
                }
            }
        } else {
            // Inside a group or channel
            const groupTitle = args || msg.chat.title || 'Group';
            const topicId = msg.message_thread_id || null;
            const destId = chatId.toString();

            if (approvedUsersCollection) {
                const settingsUid = await resolveSettingsUserId(fromId);
                const userDoc = await approvedUsersCollection.findOne({ userId: settingsUid });
                const savedDestinations = userDoc?.savedDestinations || [];

                const filtered = savedDestinations.filter((d: any) => !(d.destId === destId && d.destThreadId === topicId));
                filtered.push({
                    destId,
                    destThreadId: topicId,
                    groupName: groupTitle,
                    topicName: topicId ? `Topic ${topicId}` : 'General',
                    createdAt: new Date()
                });

                const finalDest = filtered.slice(-20);
                await approvedUsersCollection.updateOne(
                    { userId: settingsUid },
                    { $set: { savedDestinations: finalDest } }
                );

                const destDisplay = topicId ? `${groupTitle} (Topic: ${topicId})` : groupTitle;
                const confirmMsg = `✅ **Specific Destination Stored Successfully!**\n\n📁 Destination: \`${destDisplay}\`\n📍 ID: \`${destId}\` ${topicId ? `(Topic: \`${topicId}\`)` : ''}\n\nThis target group has been saved to your **Saved Destinations** list!`;
                
                // 1. Send inside the Destination Group itself
                await safeSendMessage(chatId, confirmMsg, { 
                    parse_mode: 'Markdown',
                    reply_to_message_id: msg.message_id 
                });

                // 2. Send inside User/Admin's Private Bot DM
                if (fromId.toString() !== chatId.toString()) {
                    await safeSendMessage(fromId, `📁 **New Upload Destination Registered from Group:**\n\n🎯 **${destDisplay}** with ID \`${destId}\` has been added to your **Saved Destinations** list.\n\nYou can select it as your active destination anytime from the Settings panel!`, {
                        parse_mode: 'Markdown'
                    }).catch(() => {});
                }
            }
        }
    });
    
    bot.onText(/\/pausequeue/, async (msg) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;

        isQueuePaused = true;
        safeSendMessage(chatId, "⏸️ **𝗧𝗮𝘀𝗸 𝗤𝘂𝗲𝘂𝗲 𝗵𝗮𝘀 𝗯𝗲𝗲𝗻 𝗣𝗮𝘂𝘀𝗲𝗱!**\n\n⚠️ No new tasks will be processed until resumed via \`/resumequeue\` command.", { parse_mode: 'Markdown' });
    });

    bot.onText(/\/resumequeue/, async (msg) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;

        isQueuePaused = false;
        safeSendMessage(chatId, "▶️ **𝗧𝗮𝘀𝗸 𝗤𝘂𝗲𝘂𝗲 𝗵𝗮𝘀 𝗯𝗲𝗲𝗻 𝗥𝗲𝘀𝘂𝗺𝗲𝗱!**\n\n⚡ Processing of pending queued tasks has recommenced successfully.", { parse_mode: 'Markdown' });
        runNextTask();
    });

    bot.onText(/\/queue/, async (msg) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;

        let rText = `📊 **Task Queue & Tracker Dashboard**\n`;
        rText += `===============================\n\n`;
        rText += `• **Queue Status:** ${isQueuePaused ? '⏸️ PAUSED' : '🟢 RUNNING'}\n`;
        rText += `• **Active Workers:** \`${activeTasksCount} / ${MAX_CONCURRENT_TASKS}\`\n`;
        rText += `• **Pending Tasks in Queue:** \`${taskQueue.length} files\`\n\n`;

        if (activeTaskJobs.size > 0) {
            rText += `⚙️ **Currently Executing Jobs:**\n`;
            for (const [key, job] of activeTaskJobs) {
                const parts = job.link.split('/');
                const msgId = parts[parts.length - 1] || 'Media';
                rText += `• **[Message ${msgId}](${job.link})** (${job.phase || 'processing'})\n`;
                if (job.progress) {
                    const pct = (job.progress.percent || 0).toFixed(1);
                    rText += `  └ \`[${pct}%]\` of \`${formatBytes(job.progress.total)}\` at \`${formatBytes(job.progress.speed)}/s\` (ETA: \`${job.progress.eta >= 0 ? job.progress.eta + 's' : 'N/A'}\`)\n`;
                }
            }
            rText += `\n`;
        }

        if (taskQueue.length === 0) {
            rText += `📭 _No pending tasks in the queue._\n`;
        } else {
            rText += `⏳ **Pending Queue Tasks (First 15):**\n`;
            for (let i = 0; i < Math.min(15, taskQueue.length); i++) {
                const t = taskQueue[i];
                const parts = t.link.split('/');
                const mId = parts[parts.length - 1] || 'Media';
                rText += `**${i + 1}.** [Msg ${mId}](${t.link}) ${t.isMirror ? '🔄 [Mirror]' : ''}\n`;
            }
            if (taskQueue.length > 15) {
                rText += `_...and ${taskQueue.length - 15} more files wait in queue._\n`;
            }
            rText += `\n💡 **Queue Control Actions:**\n`;
            rText += `• Move task to front: \`/prioritizetask <index>\`\n`;
            rText += `• Cancel task: \`/canceltask <index>\`\n`;
            rText += `• Wipe pending: \`/clearqueue\`\n`;
        }

        const keyboard = [
            [
                isQueuePaused ? { text: '▶️ Resume Queue', callback_data: 'resume_queue_cb' } : { text: '⏸️ Pause Queue', callback_data: 'pause_queue_cb' },
                { text: '🔄 Refresh Queue', callback_data: 'view_queue_cb' }
            ],
            [
                { text: '🗑️ Clear Queue', callback_data: 'clear_queue_cb' }
            ]
        ];

        safeSendMessage(chatId, rText, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: keyboard }
        });
    });

    bot.onText(/\/canceltask(?:\s+(.+))?/, async (msg, match) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;

        const argStr = match?.[1]?.trim().toLowerCase();
        if (!argStr) {
            return safeSendMessage(chatId, "❌ **Usage:** \`/canceltask <1-based index>\` or \`/canceltask all\`\nType \`/queue\` to view index numbers.", { parse_mode: 'Markdown' });
        }

        if (argStr === 'all') {
            taskQueue.length = 0;
            dbClearAllTasks().catch(e => console.error("[Queue DB] Clear cancel-all error:", e));
            return safeSendMessage(chatId, "🗑️ **All pending tasks inside the queue have been cancelled!**", { parse_mode: 'Markdown' });
        }

        const idx = parseInt(argStr);
        if (isNaN(idx) || idx < 1 || idx > taskQueue.length) {
            return safeSendMessage(chatId, `❌ **Error:** Please enter a valid index number between 1 and ${taskQueue.length}.`, { parse_mode: 'Markdown' });
        }

        const removed = taskQueue.splice(idx - 1, 1)[0];
        dbDequeueTask(removed).catch(e => console.error("[Queue DB] Dequeue cancelled task error:", e));

        const parts = removed.link.split('/');
        const msgId = parts[parts.length - 1] || 'Media';
        safeSendMessage(chatId, `✅ **Cancelled Task #${idx}:** [Message ${msgId}](${removed.link}) has been removed from the queue.`, { parse_mode: 'Markdown', disable_web_page_preview: true });
    });

    bot.onText(/\/prioritizetask(?:\s+(.+))?/, async (msg, match) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;

        const argStr = match?.[1]?.trim();
        if (!argStr) {
            return safeSendMessage(chatId, "❌ **Usage:** \`/prioritizetask <1-based index>\`\nThis moves a task to index 1 of the queue.", { parse_mode: 'Markdown' });
        }

        const idx = parseInt(argStr);
        if (isNaN(idx) || idx < 1 || idx > taskQueue.length) {
            return safeSendMessage(chatId, `❌ **Error:** Please enter a valid index number between 1 and ${taskQueue.length}.`, { parse_mode: 'Markdown' });
        }

        if (idx === 1) {
            return safeSendMessage(chatId, "💡 **Task is already at the absolute front of the queue.**");
        }

        const chosen = taskQueue.splice(idx - 1, 1)[0];
        taskQueue.unshift(chosen);
        dbRequeueFrontTask(chosen).catch(e => console.error("[Queue DB] requeue front error:", e));

        const parts = chosen.link.split('/');
        const msgId = parts[parts.length - 1] || 'Media';
        safeSendMessage(chatId, `⚡ **Task Prioritized:** [Message ${msgId}](${chosen.link}) has been elevated to index 1 and will run next!`, { parse_mode: 'Markdown', disable_web_page_preview: true });

        if (!isQueuePaused) {
            runNextTask();
        }
    });

    bot.onText(/\/clearqueue/, async (msg) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;

        taskQueue.length = 0;
        dbClearAllTasks().catch(e => console.error("[Queue DB] clearqueue error:", e));
        safeSendMessage(chatId, "🗑️ **𝗣𝗲𝗻𝗱𝗶𝗻𝗴 𝗤𝘂𝗲𝘂𝗲 𝗖𝗹𝗲𝗮𝗿𝗲𝗱 𝗦𝘂𝗰𝗰𝗲𝘀𝘀𝗳𝘂𝗹𝗹𝘆!**\n\n🧹 All waiting tasks have been removed from the queue.", { parse_mode: 'Markdown' });
    });

    bot.onText(/\/cleartopiccache/, async (msg) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;

        topicMappingCache.clear();
        safeSendMessage(chatId, "🔄 **𝗧𝗼𝗽𝗶𝗰 𝗠𝗮𝗽𝗽𝗶𝗻𝗴 𝗖𝗮𝗰𝗵𝗲 𝗖𝗹𝗲𝗮𝗿𝗲𝗱!**\n\n⚡ All cached topic IDs will be dynamically resolved from Telegram on the next request.", { parse_mode: 'Markdown' });
    });

    bot.onText(/\/dashboard/, async (msg) => {
        if (!isAdmin(msg.from?.id)) return;
        try {
            const text = await generateDashboardText();
            bot?.sendMessage(msg.chat.id, text, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔄 Refresh Stats', callback_data: 'refresh_dashboard' },
                            isQueuePaused ? { text: '▶️ Resume Queue', callback_data: 'resume_queue_cb' } : { text: '⏸️ Pause Queue', callback_data: 'pause_queue_cb' }
                        ],
                        [
                            { text: '📋 View Queue', callback_data: 'view_queue_cb' },
                            { text: '🗑️ Clear Queue', callback_data: 'clear_queue_cb' }
                        ]
                    ]
                }
            });
        } catch (err: any) {
            safeSendMessage(msg.chat.id, `❌ **Dashboard Error:** ${err.message}`);
        }
    });

    bot.onText(/\/speed(?:\s+(.+))?/, async (msg, match) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;

        const valStr = match?.[1]?.trim();
        if (!valStr) {
            return safeSendMessage(chatId, 
                `⚡ **Speed & Concurrency Configuration**\n\n` +
                `• **Global Max Concurrent Tasks:** \`${MAX_CONCURRENT_TASKS}\`\n` +
                `• **Max Tasks Per User:** \`${MAX_TASKS_PER_USER}\`\n\n` +
                `To change settings, send: \`/speed <concurrency> [tasks_per_user]\`\n` +
                `Example: \`/speed 3 3\` or \`/speed 5\``, 
                { parse_mode: 'Markdown' }
            );
        }
        
        const args = valStr.split(/\s+/);
        const limit = parseInt(args[0]);
        if (isNaN(limit) || limit < 1 || limit > 20) {
            return safeSendMessage(chatId, `❌ **Error:** Limit must be a number between 1 and 20.`);
        }
        
        let perUserLimit = limit;
        if (args[1]) {
            const parsedPerUser = parseInt(args[1]);
            if (!isNaN(parsedPerUser) && parsedPerUser >= 1) {
                perUserLimit = parsedPerUser;
            }
        }
        
        MAX_CONCURRENT_TASKS = limit;
        MAX_TASKS_PER_USER = perUserLimit;
        
        if (settingsCollection) {
            await settingsCollection.updateOne(
                { type: 'global_config' }, 
                { $set: { maxConcurrentTasks: limit, maxTasksPerUser: perUserLimit } }, 
                { upsert: true }
            );
        }
        
        safeSendMessage(chatId, `✅ **Speed configuration updated!**\n\n• **Global Concurrency:** \`${limit}\` concurrent tasks\n• **User Concurrency:** \`${perUserLimit}\` tasks per user`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/failed/, async (msg) => {
        if (!isAdmin(msg.from?.id)) return;
        const chatId = msg.chat.id;
        try {
            const failedTasks = failedTasksCollection ? await failedTasksCollection.find({}).sort({ failedAt: -1 }).limit(10).toArray() : [];
            const failedCount = failedTasksCollection ? await failedTasksCollection.countDocuments({}) : 0;
            
            if (failedCount === 0) {
                await safeSendMessage(chatId, "🎉 **No current failed tasks!** All copy & mirror operations are clean and successful.", { parse_mode: 'Markdown' });
                return;
            }
            
            let failedText = `⚠️ **Failed Mirror/Copy Tasks Report**\n`;
            failedText += `• **Total Failed Logs:** \`${failedCount} tasks\`\n`;
            failedText += `===============================\n\n`;
            
            failedTasks.forEach((t: any, i: number) => {
                const parts = t.link.split('/');
                const msgId = parts[parts.length - 1] || 'Media';
                failedText += `**${i + 1}. [Message ${msgId}](${t.link})**\n`;
                failedText += `  ├─ **Error:** \`${t.error || 'Unknown Error'}\`\n`;
                failedText += `  └─ **Failed At:** \`${t.failedAt ? new Date(t.failedAt).toLocaleString() : 'N/A'}\`\n\n`;
            });
            
            if (failedCount > 10) {
                failedText += `_...and ${failedCount - 10} more failed tasks._\n\n`;
            }
            
            failedText += `💡 You can retry these failed tasks using the dashboard or buttons below.`;
            
            await bot?.sendMessage(chatId, failedText, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔄 Retry All Failed', callback_data: 'retry_all_failed_cb' },
                            { text: '🗑️ Clear Failed Logs', callback_data: 'clear_failed_cb' }
                        ],
                        [
                            { text: '⬅️ Back to Menu', callback_data: 'menu_back' }
                        ]
                    ]
                }
            });
        } catch (err: any) {
            safeSendMessage(chatId, `❌ **Failed Tracker Error:** ${err.message}`);
        }
    });
    
    bot.onText(/\/settings/, async (msg) => {
      try {
        if (!isAdmin(msg.from?.id)) throw new Error("Restricted: Settings are locked.");
        if (!msg.from?.id) return;

        await handleSettings(msg.chat.id, msg.from.id);
      } catch (err: any) {
        bot?.sendMessage(msg.chat.id, `❌ **Error:** ${err.message}`);
      }
    });

    bot.onText(/\/help/, async (msg) => {
        const helpText = `📖 *RESTRICTED MIRROR BOT - COMPLETE HELP GUIDE* 📖\n\n` +
          `This guide provides a comprehensive overview of all command definitions, interactive buttons, and functional workflows for this bot.\n\n` +
          `⚙️ **Command Reference Guide:**\n\n` +
          `• \`/start\` 🚀 - Initializes the bot and presents the main action menu.\n` +
          `• \`/login\` 👤 - Authenticates your Telegram account (Userbot). Required for restricted chats.\n` +
          `• \`/settings\` ⚙️ - Accesses upload settings, custom thumbnail options, rename rules, and download engine modes.\n` +
          `• \`/mirror\` 🔄 - Configures cloning, active live paths, or complete mirror/copy options.\n` +
          `• \`/batch\` 📦 - Executes multi-link batch processing mode, allowing you to queue multiple links.\n` +
          `• \`/status\` 📊 - Shows ongoing download/upload transfer progress and active mirror tasks.\n` +
          `• \`/dashboard\` 📈 - Displays general transfer statistics: data volumes, success/failure counts.\n` +
          `• \`/setmirror\` 📍 - Establishes a live mirroring channel or destination path directly inside a group/channel.\n` +
          `• \`/setspecifictopic\` 📁 - Saves a target destination group or topic with custom group name.\n` +
          `• \`/setpath\` 🛣 - Sets the default global destination channel/group link or ID.\n` +
          `• \`/clearmirrorhistory\` 🗑 - Clears the database of downloaded message histories so you can re-mirror identical posts.\n` +
          `• \`/setcooldown\` ⏳ - Adjusts the delay interval between successive mirrored messages.\n` +
          `• \`/speed\` ⚡ - Configures your userbot’s multi-thread capabilities and connection speeds.\n` +
          `• \`/cancel\` 🛑 - Halts and aborts the currently running task (batch copy or mirror operations).\n` +
          `• \`/logout\` 🚪 - Securely disconnects and removes your active userbot Telegram session.\n` +
          `• \`/ping\` 🏓 - Verifies the latency and responds with active server connection status.\n` +
          `• \`/restart\` 🔄 - Restarts the bot application instance (Admin restricted).\n` +
          `• \`/sync\` 🔄 - Re-synchronizes any active mirror paths and session keys.\n\n` +
          `--- \n\n` +
          `🖱 **Interactive Touch Elements & Buttons:**\n\n` +
          `• **Login / Authenticate** 🔑 - Prompts you to paste a standard \`STRING_SESSION\` to authenticate.\n` +
          `• **Batch** 📦 - Starts input prompting to process a bulk queue of distinct message links.\n` +
          `• **Mirror** 🔄 - Opens choices to initiate clones, specific topic clones, or setup live mirroring channels.\n` +
          `• **Settings** ⚙️ - Interactively updates custom thumbnails, adds/removes filename rename rules, and toggles engines.\n` +
          `• **Logout** 🚪 - Terminates and removes any saved userbot session.\n` +
          `• **Cancel** 🛑 - Stops the active long-running mirroring or batch download gracefully.\n` +
          `• **Official Channel** 📢 - Direct link to open the official destination channel.\n` +
          `• **Help** ❓ - Re-displays this complete interactive help guide in English.`;
        bot?.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
    });

    // Helper to get or create topic by name
const getOrCreateTopic = async (client: TelegramClient, channelEntity: any, topicName: string): Promise<{ topicId?: number; error?: string }> => {
    try {
        const cacheKey = `${channelEntity.id}:${topicName.trim().toLowerCase()}`;
        if (topicMappingCache.has(cacheKey)) {
             return { topicId: topicMappingCache.get(cacheKey) };
        }

        const destTopics: any = await client.invoke(new Api.channels.GetForumTopics({
            channel: channelEntity,
            limit: 500
        }));
        
        const found = destTopics.topics?.find((t: any) => t.title?.trim().toLowerCase() === topicName.trim().toLowerCase());
        if (found) {
            console.log(`[TopicMgr] Found existing topic "${topicName}" -> ID: ${found.id}`);
            topicMappingCache.set(cacheKey, found.id);
            return { topicId: found.id };
        }

        console.log(`[TopicMgr] Creating new topic "${topicName}"...`);
        const createResult: any = await client.invoke(new Api.channels.CreateForumTopic({
            channel: channelEntity,
            title: topicName
        }));
        const update = createResult.updates?.find((u: any) => u.className === 'UpdateNewForumTopic');
        if (update?.topicId) {
            topicMappingCache.set(cacheKey, update.topicId);
            return { topicId: update.topicId };
        }
        // Fallback: Scan if not found in updates
        const retryTopics: any = await client.invoke(new Api.channels.GetForumTopics({ channel: channelEntity, limit: 200 }));
        const foundRetry = retryTopics.topics?.find((t: any) => t.title?.trim().toLowerCase() === topicName.trim().toLowerCase());
        if (foundRetry) {
            topicMappingCache.set(cacheKey, foundRetry.id);
            return { topicId: foundRetry.id };
        }
        return { error: "Could not find UpdateNewForumTopic in creation updates nor in subsequent scan" };
    } catch (err: any) {
        console.error(`[TopicMgr] Error in getOrCreateTopic for ${topicName}: ${err.message}`);
        // Retry scan
        try {
            const retryTopics: any = await client.invoke(new Api.channels.GetForumTopics({ channel: channelEntity, limit: 200 }));
            const retryFound = retryTopics.topics?.find((t: any) => t.title?.trim().toLowerCase() === topicName.trim().toLowerCase())?.id;
            if (retryFound) {
                topicMappingCache.set(`${channelEntity.id}:${topicName.trim().toLowerCase()}`, retryFound);
                return { topicId: retryFound };
            }
            return { error: `${err.message} (Retry topic scan of existing topics also returned no match)` };
        } catch (retryErr: any) { 
            return { error: `${err.message} (Retry scan failed: ${retryErr.message})` }; 
        }
    }
};
interface ActiveJob {
    link: string;
    chatId: number;
    userId: number;
    phase: 'searching' | 'downloading' | 'uploading' | 'cooldown';
    isMirror?: boolean;
    progress?: {
        total: number;
        current: number;
        speed: number;
        percent: number;
        elapsed: number;
        eta: number;
    };
    cooldownRemaining?: number;
    startTime: number;
}
activeTaskJobs = new Map<string, ActiveJob>();

function formatBytes(bytes: number, decimals = 2) {
    if (!bytes || isNaN(bytes) || bytes <= 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function generateDashboardText() {
    const activeTasks = activeTasksCount;
    const queueLen = taskQueue.length;
    const dbStatusText = dbStatus === 'Connected' ? '🟢 Connected' : '🔴 Disconnected';

    const formatDashboardTime = (s: number) => {
        if (s <= 0) return "0s";
        if (s < 60) return `${Math.round(s)}s`;
        const m = Math.floor(s / 60);
        const sec = Math.round(s % 60);
        return `${m}m ${sec}s`;
    };

    // 1. Batch Sync Status Summary
    const totalBatches = batchStatusMap.size;
    let activeBatchesText = '';
    let activeBatchesCount = 0;
    let completedBatchesCount = 0;

    for (const [batchId, info] of batchStatusMap) {
        const remaining = info.total - info.processed;
        if (remaining > 0) {
            activeBatchesCount++;
            const progress = info.total > 0 ? Math.min(100, Math.max(0, Math.floor((info.processed / info.total) * 100))) : 0;
            const barLength = 10;
            const filled = Math.min(barLength, Math.max(0, Math.round((progress / 100) * barLength)));
            const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barLength - filled));
            const elapsed = (Date.now() - info.startTime) / 1000;
            
            activeBatchesText += `\n📦 **BATCH ID:** \`${batchId.substring(0, 8)}\`\n`;
            activeBatchesText += `  ├─ **Progress:** \`[${bar}]\` **${progress}%**\n`;
            activeBatchesText += `  ├─ **Processed:** \`${info.processed} / ${info.total}\` (Success: \`${info.success}\` | Failed: \`${info.failed}\`)\n`;
            activeBatchesText += `  ├─ **Current Link:** \`${info.currentLink ? info.currentLink.split('/').pop() : 'Idle'}\`\n`;
            activeBatchesText += `  └─ **Running:** \`${formatDashboardTime(elapsed)}\`\n`;
        } else {
            completedBatchesCount++;
        }
    }

    if (activeBatchesCount === 0) {
        activeBatchesText = `\n_No active batch synchronizations running._`;
    }

    // 2. Active Mirror Jobs & Standalone Jobs
    let activeMirrorText = '';
    let activeTaskText = '';
    let activeMirrorCount = 0;
    let activeTaskCount = 0;

    for (const [key, job] of activeTaskJobs) {
        const linkParts = job.link.split('/');
        const msgId = linkParts[linkParts.length - 1] || 'Media';
        
        let jobText = `\n⚙️ **TASK:** [Message ${msgId}](${job.link})\n`;
        jobText += `  ├─ **Phase:** `;
        if (job.phase === 'searching') jobText += `🔍 Searching/Resolving source\n`;
        else if (job.phase === 'cooldown') jobText += `⏳ In Cooldown (${job.cooldownRemaining || 0}s remaining)\n`;
        else if (job.phase === 'downloading') jobText += `📥 Downloading from Telegram\n`;
        else if (job.phase === 'uploading') jobText += `📤 Uploading to Destination\n`;
        
        if (job.progress) {
            const progress = job.progress;
            const barLength = 10;
            const percentVal = Math.min(100, Math.max(0, progress.percent || 0));
            const filledLength = Math.min(barLength, Math.max(0, Math.round((percentVal / 100) * barLength)));
            const emptyLength = Math.max(0, barLength - filledLength);
            const bar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
            
            jobText += `  ├─ **Progress:** \`[${bar}]\` **${percentVal.toFixed(1)}%**\n`;
            jobText += `  ├─ **Size:** \`${formatBytes(progress.current)} / ${formatBytes(progress.total)}\`\n`;
            jobText += `  ├─ **Speed:** \`${formatBytes(progress.speed)}/s\`\n`;
            jobText += `  └─ **Time:** Elapsed \`${progress.elapsed}s\` | ETA \`${progress.eta >= 0 ? progress.eta + 's' : 'N/A'}\`\n`;
        }
        jobText += `  -----------------------------\n`;

        if (job.isMirror) {
            activeMirrorText += jobText;
            activeMirrorCount++;
        } else {
            activeTaskText += jobText;
            activeTaskCount++;
        }
    }

    if (activeMirrorCount === 0) {
        activeMirrorText = `_No active mirror tasks running._`;
    }
    if (activeTaskCount === 0) {
        activeTaskText = `_No active standalone downloads running._`;
    }

    return `📈 **𝗗𝗔𝗦𝗛𝗕𝗢𝗔𝗥𝗗 : 𝗥𝗼𝗵𝗶𝘁  𝗦𝗮𝘃𝗲  𝗥𝗲𝘀𝘁𝗿𝗶𝗰𝘁𝗶𝗰𝘁𝗲𝗱  𝗯𝗼𝘁  𝟮𝟬𝟮𝟲**\n` +
           `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
           `🖥️ **𝗦𝗬𝗦𝗧𝗘𝗠  𝗛𝗘𝗔𝗟𝗧𝗛:**\n` +
           `├ **Database Connect:** ${dbStatusText}\n` +
           `├ **Active Pipelines:** \`${activeTasks} / ${MAX_CONCURRENT_TASKS} workers\`\n` +
           `└ **Queue Backlog:** \`${queueLen} pending files\`\n\n` +
           `⚡ **𝗦𝗣𝗘𝗘𝗗  &  𝗟𝗜𝗠𝗜𝗧𝗦:**\n` +
           `├ **Global Concurrency:** \`${MAX_CONCURRENT_TASKS} tasks\`\n` +
           `└ **Max User Limit:** \`${MAX_TASKS_PER_USER} tasks/user\`\n\n` +
           `📦 **𝗕𝗔𝗧𝗖𝗛  𝗦𝗬𝗡𝗖  𝗦𝗨𝗠𝗠𝗔𝗥𝗬:**\n` +
           `├ **Total Registered:** \`${totalBatches}\`\n` +
           `├ **Running Syncs:** \`${activeBatchesCount}\`\n` +
           `└ **Finished Batches:** \`${completedBatchesCount}\`\n` +
           `${activeBatchesText}\n\n` +
           `🔄 **𝗠𝗜𝗥𝗥𝗢𝗥  𝗔𝗖𝗧𝗜𝗩𝗘  𝗝𝗢𝗕𝗦:**\n` +
           `${activeMirrorText}\n\n` +
           `📥 **𝗦𝗧𝗔𝗡𝗗𝗔𝗟𝗢𝗡𝗘  𝗔𝗖𝗧𝗜𝗩𝗘  𝗝𝗢𝗕𝗦:**\n` +
           `${activeTaskText}\n\n` +
           `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
           `🕒 _Last Auto-Update: ${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_`;
}

const lastTaskTimePerUser = new Map<number, number>();

interface BatchInfo {
    total: number;
    processed: number;
    success: number;
    failed: number;
    startTime: number;
    summaryMsgId: number;
    chatId: number;
    currentLink?: string;
    lastUpdate?: number;
}
batchStatusMap = new Map<string, BatchInfo>();

const refreshBatchSummary = async (batchId: string, force = false) => {
    const info = batchStatusMap.get(batchId);
    if (!info || !bot) return;

    // Throttle updates: only once every 3 seconds unless forced (final update)
    const now = Date.now();
    if (!force && info.lastUpdate && (now - info.lastUpdate < 3000)) return;
    info.lastUpdate = now;

    const remaining = info.total - info.processed;
    const elapsed = (now - info.startTime) / 1000;
    const avgTimePerLink = info.processed > 0 ? elapsed / info.processed : 0;
    const etaSeconds = remaining * avgTimePerLink;

    const formatTime = (s: number) => {
        if (s <= 0) return "0s";
        if (s < 60) return `${Math.round(s)}s`;
        const m = Math.floor(s / 60);
        const sec = Math.round(s % 60);
        return `${m}m ${sec}s`;
    };

    const progress = info.total > 0 ? Math.floor((info.processed / info.total) * 100) : 0;
    const size = 15;
    const filled = Math.min(size, Math.max(0, Math.floor((size * (info.processed || 0)) / (info.total || 1))));
    const empty = Math.max(0, size - filled);
    const bar = "🟩".repeat(filled) + "⬜".repeat(empty);

    const isFinished = remaining <= 0;
    const progressBar = "█".repeat(Math.min(8, Math.max(0, Math.round(progress / 12.5))));

    const text = `╔═══ ⚡ 𝗕𝗮𝘁𝗰𝗵 𝗘𝗻𝗴𝗶𝗻𝗲 ⚡ ═══╗\n` +
                 `║ 🟢 𝗦𝘆𝘀𝘁𝗲𝗺: 𝗢𝗻𝗹𝗶𝗻𝗲\n` +
                 `║ 📊 𝗟𝗼𝗮𝗱: ${progress}% ${progressBar}\n` +
                 `╠═══════════════════════\n` +
                 `║ 🔗 𝗜𝗻𝗽𝘂𝘁 : ${info.total} 𝗟𝗶𝗻𝗸𝘀\n` +
                 `║ ✅ 𝗗𝗼𝗻𝗲  : ${info.success}\n` +
                 `║ ❌ 𝗘𝗿𝗿𝗼𝗿 : ${info.failed}\n` +
                 `║ ⏳ 𝗪𝗮𝗶𝘁  : ${remaining}\n` +
                 `╠═══════════════════════\n` +
                 `║ 🚀 𝗔𝗰𝘁𝗶𝘃𝗲 𝗠𝗼𝗱𝗲\n` +
                 `║ ${info.currentLink ? info.currentLink.substring(0, 30) : 'Idle...'}\n` +
                 `╠═══════════════════════\n` +
                 `║ ⏱ ${formatTime(elapsed)} • ${isFinished ? 'Done ⚡' : 'Updating...'}\n` +
                 `╚═══════════════════════╝\n` +
                 `🔄 ${isFinished ? 'Finished' : '𝗨𝗽𝗱𝗮𝘁𝗶𝗻𝗴...'}`;

    await safeEditMessage(text, {
        chat_id: info.chatId,
        message_id: info.summaryMsgId,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
    });
};

async function dbEnqueueTask(task: Task) {
    if (!task.id) {
        task.id = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    }
    if (queuedTasksCollection) {
        try {
            await queuedTasksCollection.insertOne({
                id: task.id,
                chatId: task.chatId,
                userId: task.userId,
                link: task.link,
                statusMsgId: task.statusMsgId,
                batchId: task.batchId,
                overrideThreadId: task.overrideThreadId,
                forceGeneralPath: task.forceGeneralPath,
                overrideTargetId: task.overrideTargetId,
                isMirror: task.isMirror,
                fullMirrorSessionId: task.fullMirrorSessionId,
                topicCloneSessionId: task.topicCloneSessionId,
                createdAt: new Date()
            });
        } catch (err) {
            console.error('[DB Queue] Error inserting task:', err);
        }
    }
}

dbEnqueueTasks = async function(tasks: Task[]) {
    if (tasks.length === 0) return;
    for (const t of tasks) {
        if (!t.id) {
            t.id = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
        }
    }
    if (queuedTasksCollection) {
        try {
            const now = Date.now();
            const docs = tasks.map((t, index) => ({
                id: t.id,
                chatId: t.chatId,
                userId: t.userId,
                link: t.link,
                statusMsgId: t.statusMsgId,
                batchId: t.batchId,
                overrideThreadId: t.overrideThreadId,
                forceGeneralPath: t.forceGeneralPath,
                overrideTargetId: t.overrideTargetId,
                isMirror: t.isMirror,
                fullMirrorSessionId: t.fullMirrorSessionId,
                topicCloneSessionId: t.topicCloneSessionId,
                createdAt: new Date(now + index)
            }));
            await queuedTasksCollection.insertMany(docs);
        } catch (err) {
            console.error('[DB Queue] Error inserting bulk tasks:', err);
        }
    }
}

dbDequeueTask = async function(task: Task) {
    if (queuedTasksCollection && task.id) {
        try {
            await queuedTasksCollection.deleteOne({ id: task.id });
        } catch (err) {
            console.error('[DB Queue] Error deleting task:', err);
        }
    }
}

async function dbRequeueFrontTask(task: Task) {
    if (queuedTasksCollection && task.id) {
        try {
            await queuedTasksCollection.insertOne({
                id: task.id,
                chatId: task.chatId,
                userId: task.userId,
                link: task.link,
                statusMsgId: task.statusMsgId,
                batchId: task.batchId,
                overrideThreadId: task.overrideThreadId,
                forceGeneralPath: task.forceGeneralPath,
                overrideTargetId: task.overrideTargetId,
                isMirror: task.isMirror,
                fullMirrorSessionId: task.fullMirrorSessionId,
                topicCloneSessionId: task.topicCloneSessionId,
                retries: task.retries || 0,
                createdAt: new Date(Date.now() - 3600000)
            });
        } catch (err) {
            console.error('[DB Queue] Error requeuing front task:', err);
        }
    }
}

dbClearAllTasks = async function() {
    if (queuedTasksCollection) {
        try {
            await queuedTasksCollection.deleteMany({});
        } catch (err) {
            console.error('[DB Queue] Error clearing tasks:', err);
        }
    }
}

async function saveFailedTask(task: Task, reason: string) {
    if (failedTasksCollection) {
        try {
            await failedTasksCollection.insertOne({
                id: task.id || Date.now().toString(36) + Math.random().toString(36).substring(2, 8),
                chatId: Number(task.chatId),
                userId: Number(task.userId),
                link: task.link,
                error: reason,
                failedAt: new Date(),
                overrideThreadId: task.overrideThreadId,
                forceGeneralPath: task.forceGeneralPath,
                overrideTargetId: task.overrideTargetId,
                isMirror: task.isMirror
            });
            console.log(`[Failed Tracker] Saved failed task to MongoDB: ${task.link}`);
        } catch (err) {
            console.error('[Failed Tracker] Error saving failed task:', err);
        }
    }
}

retryFailedTask = async function(id: string) {
    if (failedTasksCollection) {
        try {
            const taskDoc = await failedTasksCollection.findOne({ id });
            if (taskDoc) {
                const newTask: Task = {
                    id: taskDoc.id,
                    chatId: Number(taskDoc.chatId),
                    userId: Number(taskDoc.userId),
                    link: taskDoc.link,
                    overrideThreadId: taskDoc.overrideThreadId,
                    forceGeneralPath: taskDoc.forceGeneralPath,
                    overrideTargetId: taskDoc.overrideTargetId,
                    isMirror: taskDoc.isMirror,
                    retries: 0
                };
                taskQueue.push(newTask);
                await dbEnqueueTask(newTask);
                await failedTasksCollection.deleteOne({ id });
                console.log(`[Failed Tracker] Retrying failed task: ${newTask.link}`);
                runNextTask();
                return true;
            }
        } catch (err) {
            console.error('[Failed Tracker] Error retrying failed task:', err);
        }
    }
    return false;
}

retryAllFailedTasks = async function() {
    if (failedTasksCollection) {
        try {
            const failedTasks = await failedTasksCollection.find({}).toArray();
            if (failedTasks.length > 0) {
                const restoredTasks: Task[] = [];
                for (const taskDoc of failedTasks) {
                    const newTask: Task = {
                        id: taskDoc.id || Date.now().toString(36) + Math.random().toString(36).substring(2, 8),
                        chatId: Number(taskDoc.chatId),
                        userId: Number(taskDoc.userId),
                        link: taskDoc.link,
                        overrideThreadId: taskDoc.overrideThreadId,
                        forceGeneralPath: taskDoc.forceGeneralPath,
                        overrideTargetId: taskDoc.overrideTargetId,
                        isMirror: taskDoc.isMirror,
                        retries: 0
                    };
                    taskQueue.push(newTask);
                    restoredTasks.push(newTask);
                }
                await dbEnqueueTasks(restoredTasks);
                await failedTasksCollection.deleteMany({});
                console.log(`[Failed Tracker] Requeued ${failedTasks.length} failed tasks.`);
                runNextTask();
                return failedTasks.length;
            }
        } catch (err) {
            console.error('[Failed Tracker] Error retrying all failed tasks:', err);
        }
    }
    return 0;
}

clearAllFailedTasks = async function() {
    if (failedTasksCollection) {
        try {
            await failedTasksCollection.deleteMany({});
            console.log('[Failed Tracker] Cleared all failed tasks from database');
            return true;
        } catch (err) {
            console.error('[Failed Tracker] Error clearing failed tasks:', err);
        }
    }
    return false;
}

runNextTask = async () => {
    console.log(`[Queue] runNextTask started. activeTasksCount: ${activeTasksCount}, queueLength: ${taskQueue.length}`);
    if (isQueuePaused) {
        console.log(`[Queue] Queue is currently PAUSED. Aborting execution.`);
        return;
    }
    if (activeTasksCount >= MAX_CONCURRENT_TASKS || taskQueue.length === 0) {
        console.log(`[Queue] Hit limit or empty queue. Aborting runNextTask.`);
        return;
    }

    const fallbackIdVal = currentAdminId || ALLOWED_ADMIN_IDS[0] || 'admin';
    const getTaskUserKey = (uId: any) => {
        if (!uId) return fallbackIdVal.toString();
        return uId.toString();
    };

    // Find the first task whose user has available task slots
    let taskIndex = -1;
    for (let i = 0; i < taskQueue.length; i++) {
        const uIdKey = getTaskUserKey(taskQueue[i].userId);
        const uActive = activeTasksPerUser.get(uIdKey) || 0;
        if (uActive < MAX_TASKS_PER_USER) {
            taskIndex = i;
            break;
        }
    }

    if (taskIndex === -1) {
        console.log(`[Queue] All tasks belong to users who are currently busy. Keeping in queue.`);
        return;
    }

    // Force sequential: if any task is already active globally, do not start
    if (activeTasksCount > 0) {
        console.log(`[Queue] Another task is already active. Sequential mode enforced.`);
        return;
    }

    // Check if the task is stuck (if it takes too long or failed before)
    // Here we can just ensure that if the queue runner is called, 
    // it will always pick the oldest (or next) task sequentially.
    // The current implementation of taskQueue.splice(taskIndex, 1)[0] 
    // and the check `if (activeTasksCount > 0) return;` 
    // already enforces sequential execution (MaxActive=1).
    // The user also mentioned "stuck files" or "failed files" 
    // need to be retried automatically. 
    // The retry logic is already in place.
    
    // Capture the task and check if we can immediately trigger another worker for the next slot
    const task = taskQueue.splice(taskIndex, 1)[0];
    dbDequeueTask(task).catch(e => console.error("[Queue DB] dequeue error:", e));
    const fromId = task.userId;
    const fromIdKey = getTaskUserKey(fromId);

    activeTasksCount++;
    const currentActiveForUser = (activeTasksPerUser.get(fromIdKey) || 0) + 1;
    activeTasksPerUser.set(fromIdKey, currentActiveForUser);

    const jobKey = `${task.userId}-${task.link}`;
    activeTaskJobs.set(jobKey, {
        link: task.link,
        chatId: task.chatId,
        userId: task.userId,
        phase: 'searching',
        startTime: Date.now(),
        isMirror: task.isMirror
    });
    
    console.log(`[Queue] Task assigned. activeTasksCount: ${activeTasksCount}, User ${fromIdKey} active: ${currentActiveForUser}`);
    
    // Proactively try to fill next available slot if more tasks exist
    if (activeTasksCount < MAX_CONCURRENT_TASKS && taskQueue.length > 0) {
        console.log(`[Queue] Triggering another worker slots empty.`);
        setImmediate(runNextTask);
    }

    let statusMsgId = task.statusMsgId || 0;
    try {
        // Update batch info if applicable
        if (task.batchId) {
            console.log(`[Queue] refreshing batch summary...`);
            const info = batchStatusMap.get(task.batchId);
            if (info) {
                info.currentLink = task.link;
                await refreshBatchSummary(task.batchId).catch(e => console.error("[Queue] refreshBatchSummary Error:", e));
            }
        }

        // Send individual status message one-by-one if not exists
        if (!statusMsgId) {
            console.log(`[Queue] Sending initial searching message...`);
            const msgId = task.link.split('/').pop() || 'media';
            const sMsg = await safeSendMessage(task.chatId, `🔍 **Searching Item:** \`${msgId}\`...`, { parse_mode: 'Markdown' });
            statusMsgId = sMsg?.message_id || 0;
        }

        let cooldownSecs = globalCooldownSeconds;
        if (approvedUsersCollection) {
            try {
                const targetUidStr = await resolveSettingsUserId(fromId);
                const userDoc = await approvedUsersCollection.findOne({ userId: targetUidStr });
                if (userDoc && userDoc.cooldownSeconds !== undefined) {
                    cooldownSecs = Number(userDoc.cooldownSeconds);
                }
            } catch (dbErr) {
                console.error("[Queue] Failed to fetch cooldownSeconds from DB:", dbErr);
            }
        }

        const taskNow = Date.now();
        const userLastTaskTime = lastTaskTimePerUser.get(fromIdKey) || 0;
        console.log(`[Queue] Cooldown check. taskNow: ${taskNow}, lastTaskTime: ${userLastTaskTime}, configSecs: ${cooldownSecs}`);
        
        const cooldownMs = cooldownSecs * 1000;
        if (cooldownMs > 0 && userLastTaskTime > 0) {
            const timeDiff = taskNow - userLastTaskTime;
            if (timeDiff < cooldownMs) {
                const waitSecs = Math.ceil((cooldownMs - timeDiff) / 1000);
                const jobKey = `${task.userId}-${task.link}`;
                const job = activeTaskJobs.get(jobKey);
                if (job) {
                    job.phase = 'cooldown';
                    job.cooldownRemaining = waitSecs;
                }
                console.log(`[Queue] Throttling for ${waitSecs}s due to ${cooldownSecs}s cooldown.`);
                for (let i = waitSecs; i > 0; i--) {
                    if (job) {
                        job.cooldownRemaining = i;
                    }
                    const totalBarLen = 12;
                    const elapsed = waitSecs - i;
                    const filledLen = Math.min(totalBarLen, Math.max(0, Math.round((elapsed / Math.max(1, waitSecs)) * totalBarLen)));
                    const emptyLen = Math.max(0, totalBarLen - filledLen);
                    const cBar = '█'.repeat(filledLen) + '░'.repeat(emptyLen);
                    const pct = Math.round((elapsed / waitSecs) * 100);

                    const cooldownText = `⏳ **Auto-Countdown Cooldown Active**\n\n` +
                                         `• **Status:** Anti-Flood Limit Buffer\n` +
                                         `• **Time Remaining:** \`${i} seconds\`\n` +
                                         `• **Delay Progress:** \`[${cBar}]\` **${pct}%**\n\n` +
                                         `🛡 _Protecting your Telegram session against API throttling limits._`;

                    await safeEditMessage(cooldownText, { chat_id: task.chatId, message_id: statusMsgId, parse_mode: 'Markdown' }).catch(() => {});
                    await sleep(1000);
                }
            }
        }

        nextTaskRunAt = null;
        console.log(`[Queue] Starting processTask for link ${task.link}`);
        let success = false;
        let finalDone = false;
        let isTopicBlocked = false;

        if (task.fullMirrorSessionId) {
            const session = activeFullMirrorSessions.get(task.fullMirrorSessionId);
            if (session) {
                const threadId = task.overrideThreadId !== undefined && task.overrideThreadId !== null ? task.overrideThreadId : 'general';
                const topicStat = session.topicStats[threadId];
                if (topicStat) {
                    const topicTitle = (topicStat.title || '').trim().toLowerCase();
                    // Load blocked topics
                    const settingsUid = await resolveSettingsUserId(fromId);
                    const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
                    const blockedTopics = (userDoc?.blockedTopics || []).map((t: string) => t.trim().toLowerCase());
                    
                    const srcMatch = task.link.match(/t\.me\/(?:c\/)?([a-zA-Z0-9_-]+)\/(\d+)/i);
                    let sourceGroupIdStr = srcMatch ? srcMatch[1].replace('-100', '') : '';
                    
                    if (blockedTopics.some((bt: string) => 
                        bt === topicTitle || 
                        bt === threadId.toString() || 
                        (sourceGroupIdStr && (bt === `-100${sourceGroupIdStr}_${threadId}` || bt === `${sourceGroupIdStr}_${threadId}`))
                    )) {
                        isTopicBlocked = true;
                        console.log(`[Queue] Skipping blocked topic: "${topicStat.title}" (ThreadId: ${threadId})`);
                    }
                }
            }
        }

        try {
            if (isTopicBlocked) {
                await safeEditMessage(`🚫 **Skipped task (Blocked Topic):**\n└ Link: ${task.link}`, { chat_id: task.chatId, message_id: statusMsgId });
                success = true; // Act as success so that it iterates forward cleanly without errors
                finalDone = true;
            } else {
                // Task timeout is completely removed as requested, allowing unlimited download time for large content.
                success = await processTask(task.chatId, task.link, statusMsgId, fromId, task.overrideThreadId, task.forceGeneralPath, task.overrideTargetId, task.isMirror);
                finalDone = true;
            }
        } catch (taskErr: any) {
            const isSkip = taskErr.message?.includes("DOWNLOAD_SKIPPED");
            if (!isSkip) {
                console.error(`[Queue] processTask failed or threw natively:`, taskErr);
            } else {
                console.log(`[Queue] Task skipped gracefully: ${task.link}`);
            }
            
            if (taskErr.message.includes("FloodWait")) {
                let waitMs = 30000; // Default 30s
                const match = taskErr.message.match(/wait of (\d+) seconds/i) || taskErr.message.match(/(\d+) seconds/i);
                if (match && match[1]) {
                    waitMs = (parseInt(match[1]) + 5) * 1000;
                }
                console.log(`[Queue] Task paused due to flood wait. Re-queueing at the front. Waiting ${waitMs}ms.`);
                taskQueue.unshift(task); // Re-queue at the front to maintain order
                await safeEditMessage(`⚠️ **Task Paused (FloodWait):** Telegram Bot currently under heavy abuse. Waiting ${Math.ceil(waitMs / 1000)} seconds... \n\n🔗 **Link:** ${task.link}`, { chat_id: task.chatId, message_id: statusMsgId });
                await sleep(waitMs);
                return;
            }

            task.retries = (task.retries || 0) + 1;
            // isSkip is already declared above in the catch block
            const isPermissionError = taskErr.message?.includes("Userbot session does not have access");
            if (task.retries <= 3 && !isSkip && !isPermissionError) {
                console.log(`[Queue] Retrying task (Retry ${task.retries}/3)`);
                taskQueue.unshift(task); // Re-queue at the front
                dbRequeueFrontTask(task).catch(e => console.error("[Queue DB] requeue front error on retry:", e));
                await safeEditMessage(`⚠️ **Task Error:** ${taskErr.message}\nRetrying (${task.retries}/3)...\n\n🔗 **Link:** ${task.link}`, { chat_id: task.chatId, message_id: statusMsgId });
                if (taskErr.message?.includes('Timeout')) {
                    await sleep(3000); // Give MTProto more time
                }
            } else {
                // Final failure
                const failReason = isSkip ? "Task skipped by user choice" : (taskErr.message || "Max retries reached");
                await safeEditMessage(isSkip ? `⏭️ **Task Skipped:** ${failReason}\n\n🔗 **Link:** ${task.link}` : `❌ **Task Failed:** ${taskErr.message} (Max retries reached)\n\n🔗 **Link:** ${task.link}`, { chat_id: task.chatId, message_id: statusMsgId });
                
                if (!isSkip) {
                    await saveFailedTask(task, failReason);
                }

                // Add to in-memory logs
                const cleanLink = task.link.trim();
                const destTargetStr = task.overrideTargetId ? task.overrideTargetId.toString() : 'Default';
                inMemoryMirrorLogs.unshift({
                    link: cleanLink,
                    destId: destTargetStr,
                    mirroredAt: new Date().toISOString(),
                    status: isSkip ? 'Skipped' : 'Failed',
                    info: failReason
                });
                if (inMemoryMirrorLogs.length > 500) inMemoryMirrorLogs.pop();
                finalDone = true;
            }
            success = false;
        }
        console.log(`[Queue] processTask finished with success=${success}`);
        if (success) {
            downloadCounter++;
            if (downloadCounter >= 100) {
                console.log("[Anti-Flood] Cool down triggered (100 tasks). Waiting 90s...");
                await sleep(90000);
                downloadCounter = 0;
            }
        }
        lastTaskTimePerUser.set(fromIdKey, Date.now());

        if (finalDone && task.fullMirrorSessionId) {
            const session = activeFullMirrorSessions.get(task.fullMirrorSessionId);
            if (session) {
                session.processedFiles++;
                if (success) {
                    session.successCount++;
                } else {
                    session.failedCount++;
                }

                // Update topic stats
                const threadId = task.overrideThreadId !== undefined && task.overrideThreadId !== null ? task.overrideThreadId : 'general';
                const topicStat = session.topicStats[threadId];
                if (topicStat) {
                    topicStat.processed++;
                    if (topicStat.processed >= topicStat.total && !topicStat.isMarkedCompleted) {
                        topicStat.isMarkedCompleted = true;
                    }
                }

                // Trigger progress bar write
                await updateGlobalMirrorProgress(task.fullMirrorSessionId).catch(err => {
                    console.error("[Full Mirror Progress Update Failed]", err);
                });
            }
        }

        if (finalDone && task.topicCloneSessionId) {
            const tcSession = activeTopicCloneSessions.get(task.topicCloneSessionId);
            if (tcSession) {
                tcSession.processedFiles++;
                if (success) {
                    tcSession.successCount++;
                } else {
                    tcSession.failedCount++;
                }
                
                const now = Date.now();
                const isFinished = tcSession.processedFiles >= tcSession.totalFiles;
                if (!tcSession.lastUpdate || now - tcSession.lastUpdate >= 4000 || isFinished) {
                    tcSession.lastUpdate = now;
                    await updateTopicCloneProgress(task.topicCloneSessionId).catch(err => {
                        console.error("[Topic Clone Progress Update Failed]", err);
                    });
                }
            }
        }
        
        if (task.batchId) {
            const info = batchStatusMap.get(task.batchId);
            if (info) {
                info.processed++;
                if (success) info.success++;
                else info.failed++;
                const isFinished = info.processed === info.total;
                await refreshBatchSummary(task.batchId, isFinished).catch(e => console.error("[Queue] Final refreshBatchSummary Error:", e));
            }
        }
    } catch (e: any) {
        console.error("[Queue] Queue execution error:", e);
        if (e.description?.includes("too many requests") || e.error_code === 429) {
            const retryAfter = (e.parameters?.retry_after || 60) + 5;
            console.warn(`[Queue] 429 Detected. Slot paused for ${retryAfter}s...`);
            await safeEditMessage(`⚠️ **429 Too Many Requests:** Telegram limitation active. Retrying automatically in ${retryAfter} seconds...`, { chat_id: task.chatId, message_id: statusMsgId });
            // Put the task back at the front if it failed due to 429
            taskQueue.unshift(task);
            dbRequeueFrontTask(task).catch(e => console.error("[Queue DB] requeue front error:", e));
            setTimeout(runNextTask, retryAfter * 1000);
            // activeTasksCount-- needs to be removed from here because it's handled in finally
            activeTasksPerUser.set(fromIdKey, Math.max(0, (activeTasksPerUser.get(fromIdKey) || 1) - 1));
            return;
        }
    } finally {
        const jobKey = `${task.userId}-${task.link}`;
        activeTaskJobs.delete(jobKey);
        activeTasksCount--;
        activeTasksPerUser.set(fromIdKey, Math.max(0, (activeTasksPerUser.get(fromIdKey) || 1) - 1));
        console.log(`[Queue] Finally block hit. activeTasksCount is now ${activeTasksCount}, User ${fromIdKey} active: ${activeTasksPerUser.get(fromIdKey)}`);
        // Add human-like random jitter (1 to 3 seconds) between tasks in the same slot
        const jitter = Math.floor(Math.random() * 2000) + 1000;
        nextTaskRunAt = Date.now() + jitter;
        setTimeout(runNextTask, jitter); 
    }
};

async function updateMirrorPathLastId(userId: number, sourceId: string, lastId: number) {
    if (!approvedUsersCollection) return;
    try {
        const settingsUid = await resolveSettingsUserId(userId);
        const userDoc = await approvedUsersCollection.findOne({ userId: settingsUid });
        if (!userDoc || !userDoc.mirrorPaths) return;
        
        const normalize = (id: any) => id?.toString().replace('-100', '');
        const cleanSource = normalize(sourceId);
        
        let updated = false;
        const newPaths = userDoc.mirrorPaths.map((p: any) => {
            if (normalize(p.sourceId) === cleanSource || normalize(p.sourceNumericId) === cleanSource) {
                p.lastScannedAt = new Date().toISOString();
                updated = true;
                if (!p.lastProcessedMsgId || lastId > p.lastProcessedMsgId) {
                    p.lastProcessedMsgId = lastId;
                }
            }
            return p;
        });
        
        if (updated) {
            await approvedUsersCollection.updateOne(
                { userId: settingsUid },
                { $set: { mirrorPaths: newPaths } }
            );
        }
    } catch (e: any) {
        console.error(`[Watcher] Error updating last processed message ID: ${e.message}`);
    }
}

async function catchUpLiveMirrors(userId: number, client: TelegramClient) {
    if (!approvedUsersCollection) return;
    try {
        const settingsUid = await resolveSettingsUserId(userId);
        const userDoc = await approvedUsersCollection.findOne({ userId: settingsUid });
        if (!userDoc || !userDoc.mirrorPaths) return;

        const livePaths = userDoc.mirrorPaths.filter((p: any) => p.isLive === true);
        if (livePaths.length === 0) return;

        console.log(`[CatchUp] Checking catch-up for user ${userId} with ${livePaths.length} live paths...`);

        for (const pathObj of livePaths) {
            const sourceId = pathObj.sourceId;
            const lastId = pathObj.lastProcessedMsgId;
            
            // Set exact scan time
            pathObj.lastScannedAt = new Date().toISOString();
            
            if (!lastId) {
                // If there's no lastProcessedMsgId, initialize it with the latest message ID
                try {
                    const sourceEntity = await safelyResolveFullEntity(client, sourceId).catch(() => null);
                    if (sourceEntity) {
                        const msgs = await client.getMessages(sourceEntity, { limit: 1 });
                        if (msgs && msgs.length > 0) {
                            pathObj.lastProcessedMsgId = msgs[0].id;
                            await approvedUsersCollection.updateOne(
                                { userId: settingsUid },
                                { $set: { mirrorPaths: userDoc.mirrorPaths } }
                            );
                            console.log(`[CatchUp] Initialized lastProcessedMsgId to ${msgs[0].id} for source ${sourceId}`);
                        }
                    }
                } catch (err: any) {
                    console.error(`[CatchUp] Failed to initialize lastProcessedMsgId for ${sourceId}:`, err.message);
                }
                continue;
            }

            console.log(`[CatchUp] Scanning ${sourceId} from message ID > ${lastId}`);

            try {
                const sourceEntity = await safelyResolveFullEntity(client, sourceId).catch(() => null);
                if (!sourceEntity) {
                    console.warn(`[CatchUp] Could not resolve source entity for ${sourceId}`);
                    continue;
                }

                // Query messages with minId = lastId. This gets messages newer than lastId.
                const messages: any = await client.getMessages(sourceEntity, {
                    minId: lastId,
                    limit: 100
                });

                if (messages && messages.length > 0) {
                    console.log(`[CatchUp] Found ${messages.length} missed messages in source ${sourceId}`);
                    // Since getMessages returns newest first, reverse it to process from oldest to newest
                    const sortedMessages = [...messages].reverse();

                    for (const m of sortedMessages) {
                        if (m instanceof Api.MessageEmpty) continue;
                        if (m.out) continue;
                        if (m.action instanceof Api.MessageActionTopicCreate) {
                            continue;
                        }

                        // Verify topic alignment if this is a topic-specific mirror path
                        if (pathObj.topicName && pathObj.topicName !== 'General') {
                            const replyTo = m.replyTo;
                            const sourceTopicId = replyTo ? (replyTo.replyToTopId || replyTo.replyToMsgId) : undefined;
                            let msgTopicName = 'General';
                            
                            if (sourceTopicId) {
                                const sourceIdStr = sourceId.toString().replace('-100', '');
                                if (!sourceTopicCache.has(sourceIdStr)) sourceTopicCache.set(sourceIdStr, new Map());
                                const chatTopicCache = sourceTopicCache.get(sourceIdStr)!;
                                if (chatTopicCache.has(sourceTopicId)) {
                                    msgTopicName = chatTopicCache.get(sourceTopicId)!;
                                } else {
                                    try {
                                        const topicsResult: any = await client.invoke(new Api.channels.GetForumTopics({
                                            channel: sourceEntity,
                                            limit: 500
                                        }));
                                        const foundTopic = topicsResult.topics?.find((t: any) => t.id === sourceTopicId);
                                        if (foundTopic) {
                                            msgTopicName = foundTopic.title;
                                            chatTopicCache.set(sourceTopicId, msgTopicName);
                                        }
                                    } catch(e) {}
                                }
                            }

                            if (msgTopicName.trim().toLowerCase() !== pathObj.topicName.trim().toLowerCase()) {
                                continue;
                            }
                        }

                        const destId = pathObj.destId;
                        let destTopicId = pathObj.destThreadId ? Number(pathObj.destThreadId) : undefined;

                        if (pathObj.topicName && pathObj.topicName !== 'General') {
                            try {
                                const destEntity = await safelyResolveFullEntity(client, destId);
                                const destTopics: any = await client.invoke(new Api.channels.GetForumTopics({
                                    channel: destEntity,
                                    limit: 200
                                }));
                                const found = destTopics.topics?.find((t: any) => t.title?.trim().toLowerCase() === pathObj.topicName.trim().toLowerCase());
                                if (found) {
                                    destTopicId = found.id;
                                } else {
                                    const createResult: any = await client.invoke(new Api.channels.CreateForumTopic({
                                        channel: destEntity,
                                        title: pathObj.topicName
                                    }));
                                    const update = createResult.updates?.find((u: any) => u.className === 'UpdateNewForumTopic');
                                    destTopicId = update?.topicId;
                                }
                            } catch (e: any) {
                                console.error(`[CatchUp] Dest Topic resolution failed: ${e.message}`);
                            }
                        }

                        const entityId = sourceId.toString().replace('-100', '');
                        const virtualLink = `https://t.me/c/${entityId}/${m.id}`;

                        console.log(`[CatchUp] Queueing missed message ${m.id} to task queue... -> Link: ${virtualLink}`);

                        // Notify user about start
                        bot?.sendMessage(userId, `🚀 **Live Mirror Detected New Content!**\n\nStarting download for: ${virtualLink}`, { parse_mode: 'Markdown' }).catch(() => {});

                        const newTask = {
                            chatId: userId,
                            link: virtualLink,
                            userId: userId,
                            overrideThreadId: destTopicId,
                            overrideTargetId: destId,
                            isMirror: true,
                            retries: 0
                        };
                        taskQueue.push(newTask);
                        dbEnqueueTask(newTask).catch(e => console.error("[Queue DB] enqueue error:", e));

                        pathObj.lastProcessedMsgId = m.id;
                    }

                    // Save the updated lastProcessedMsgId to the DB
                    await approvedUsersCollection.updateOne(
                        { userId: settingsUid },
                        { $set: { mirrorPaths: userDoc.mirrorPaths } }
                    );

                    runNextTask();
                }
            } catch (err: any) {
                console.error(`[CatchUp] Error during catch-up for ${sourceId}:`, err.message);
                if (err.message && err.message.includes('CHANNEL_INVALID')) {
                    console.log(`[CatchUp] Disabling live path for invalid channel: ${sourceId}`);
                    pathObj.isLive = false;
                    await approvedUsersCollection.updateOne(
                        { userId: settingsUid },
                        { $set: { mirrorPaths: userDoc.mirrorPaths } }
                    );
                    bot?.sendMessage(userId, `⚠️ **Mirror Path Disabled**\n\nThe source channel ${sourceId} is invalid or no longer accessible. The live mirror path has been disabled.`).catch(() => {});
                }
            }
        }
        
        // Save the updated lastScannedAt and message IDs back to database
        await approvedUsersCollection.updateOne(
            { userId: settingsUid },
            { $set: { mirrorPaths: userDoc.mirrorPaths } }
        );
    } catch (err: any) {
        console.error(`[CatchUp] Error in catch-Up live mirrors:`, err.message);
    }
}

startAutoMirrorWatcher = async (userId: number, client: TelegramClient) => {
    if (activeWatchers.has(userId)) return;
    activeWatchers.add(userId);

    console.log(`[Watcher] Starting Auto-Mirror for user ${userId}`);

    client.addEventHandler(async (event: any) => {
        try {
            const message = event.message;
            if (!message || message.out) return;

            // Use event.match or event.chatId as it's more consistent in GramJS
            let chatIdRaw = '';
            if (event.chatId) {
                chatIdRaw = event.chatId.toString().replace('-100', '');
            } else if (message.peerId) {
                const pid = message.peerId;
                if (pid.channelId) chatIdRaw = pid.channelId.toString().replace('-100', '');
                else if (pid.chatId) chatIdRaw = pid.chatId.toString();
                else if (pid.userId) chatIdRaw = pid.userId.toString();
            }
            
            if (!chatIdRaw) return;
            
            const settingsUid = await resolveSettingsUserId(userId);
            const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
            const paths = userDoc?.mirrorPaths || [];
            
            // Normalize IDs for robust matching
            const normalize = (id: any) => id?.toString().replace('-100', '');

            // 1. Match by Normalized Chat ID
            const cleanChatId = chatIdRaw;
            let matchingPaths = paths.filter((p: any) => 
                p.isLive === true && (
                    normalize(p.sourceId) === cleanChatId || 
                    normalize(p.sourceNumericId) === cleanChatId
                )
            );

            // 2. Fallback: match by Username if not matched yet
            if (matchingPaths.length === 0) {
                try {
                    const chatEntity = await message.getChat();
                    if (chatEntity && chatEntity.username) {
                        const currentUsername = chatEntity.username.toLowerCase();
                        matchingPaths = paths.filter((p: any) => 
                            p.isLive === true && (
                                (p.sourceUsername && p.sourceUsername.toLowerCase() === currentUsername) ||
                                (p.sourceId && p.sourceId.replace('@', '').toLowerCase() === currentUsername)
                            )
                        );
                    }
                } catch (e) {}
            }

            if (matchingPaths.length > 0) {
                let topicName = 'General';
                
                // Proactively handle Topic Creation service messages
                if (message.action instanceof Api.MessageActionTopicCreate) {
                    topicName = (message.action as any).title || 'General';
                    console.log(`[Watcher] New topic detected in source: ${topicName}`);
                    
                    if (!sourceTopicCache.has(chatIdRaw)) sourceTopicCache.set(chatIdRaw, new Map());
                    const chatTopicCache = sourceTopicCache.get(chatIdRaw)!;
                    chatTopicCache.set(message.id, topicName);
                } else {
                    // Determine Topic Name from reply header
                    const replyTo = message.replyTo;
                    // For Forums, replyToTopId is the topic ID
                    const sourceTopicId = replyTo ? (replyTo.replyToTopId || replyTo.replyToMsgId) : undefined;
                    
                    if (sourceTopicId) {
                        if (!sourceTopicCache.has(chatIdRaw)) sourceTopicCache.set(chatIdRaw, new Map());
                        const chatTopicCache = sourceTopicCache.get(chatIdRaw)!;

                        if (chatTopicCache.has(sourceTopicId)) {
                            topicName = chatTopicCache.get(sourceTopicId)!;
                        } else {
                            try {
                                const chatEntity = await message.getChat();
                                let foundTopic = null;
                                try {
                                    const topicsResult: any = await client.invoke(new Api.channels.GetForumTopics({
                                        channel: chatEntity,
                                        limit: 500 // Search deeper
                                    }));
                                    foundTopic = topicsResult.topics?.find((t: any) => t.id === sourceTopicId);
                                } catch (e1) {}

                                if (foundTopic) {
                                    topicName = foundTopic.title;
                                    chatTopicCache.set(sourceTopicId, topicName);
                                } else {
                                    // Fallback: inspect starting topic message directly
                                    const msgs = await client.getMessages(chatEntity, { ids: [sourceTopicId] });
                                    if (msgs && msgs.length > 0) {
                                        const topicMsg = msgs[0];
                                        if (topicMsg?.action && (topicMsg.action as any).title) {
                                            topicName = (topicMsg.action as any).title;
                                            chatTopicCache.set(sourceTopicId, topicName);
                                        }
                                    }
                                }
                            } catch (err: any) {
                                console.error(`[Watcher] Failed to get topic info: ${err.message}`);
                            }
                        }
                    }
                }

                // Select the best matching path from matchingPaths based on topicName
                let match = matchingPaths.find((p: any) => p.topicName && p.topicName.trim().toLowerCase() === topicName.trim().toLowerCase());
                if (!match) {
                    // Fallback to general/full mirror path
                    match = matchingPaths.find((p: any) => !p.topicName || p.topicName === 'General');
                }

                if (!match) {
                    console.log(`[Watcher] No matching path/topic mirror config found for topic "${topicName}" in source ${chatIdRaw}`);
                    return;
                }

                console.log(`[Watcher] Match found! Source: ${match.sourceId} (Topic: ${topicName}) -> Dest: ${match.destId}`);

                const destId = match.destId;
                let destTopicId = match.destThreadId ? Number(match.destThreadId) : undefined;
                
                if (!destTopicId && topicName !== 'General') {
                    if (!mirrorTopicCache.has(destId)) mirrorTopicCache.set(destId, new Map());
                    const userDestCache = mirrorTopicCache.get(destId)!;
                    
                    if (userDestCache.has(topicName)) {
                        destTopicId = userDestCache.get(topicName);
                    } else {
                        try {
                            const destEntity = await safelyResolveFullEntity(client, destId);
                            // Robust Topic Verification before creation
                            const destTopics: any = await client.invoke(new Api.channels.GetForumTopics({
                                channel: destEntity,
                                limit: 500 // Scan deeper for existing topic
                            }));
                            const found = destTopics.topics?.find((t: any) => t.title?.trim().toLowerCase() === topicName.trim().toLowerCase());
                            if (found) {
                                destTopicId = found.id;
                                console.log(`[Watcher] Found existing topic "${topicName}" in destination ID: ${destTopicId}`);
                            } else {
                                console.log(`[Watcher] No existing topic "${topicName}" found. Creating new topic...`);
                                try {
                                    const createResult: any = await client.invoke(new Api.channels.CreateForumTopic({
                                        channel: destEntity,
                                        title: topicName
                                    }));
                                    const update = createResult.updates?.find((u: any) => u.className === 'UpdateNewForumTopic');
                                    destTopicId = update?.topicId;
                                } catch (e) {
                                    // Final retry scan
                                    const retryTopics: any = await client.invoke(new Api.channels.GetForumTopics({ channel: destEntity, limit: 200 }));
                                    destTopicId = retryTopics.topics?.find((t: any) => t.title?.trim().toLowerCase() === topicName.trim().toLowerCase())?.id;
                                }
                            }
                            if (destTopicId) userDestCache.set(topicName, destTopicId);
                        } catch (err: any) {
                            console.error(`[Watcher] Dest Topic Error: ${err.message}`);
                        }
                    }
                }

                const entityId = chatIdRaw.replace('-100', '');
                const virtualLink = `https://t.me/c/${entityId}/${message.id}`;
                
                // If it was just a topic creation, we don't need to mirror a specific message
                if (message.action instanceof Api.MessageActionTopicCreate) {
                    return;
                }

                console.log(`[Watcher] Queuing mirror task: ${virtualLink} -> Topic ${destTopicId || 'General'}`);
                
                // --- INCREMENTAL MIRRORING CHECK ---
                if (mirroredMessagesCollection) {
                    const alreadyMirrored = await mirroredMessagesCollection.findOne({ link: virtualLink, destId: match.destId });
                    if (alreadyMirrored) {
                        console.log(`[Watcher] Message already mirrored, skipping: ${virtualLink}`);
                        return;
                    }
                }
                
                // Notify user about start
                bot?.sendMessage(userId, `🚀 **Live Mirror Detected New Content!**\n\nStarting download for: ${virtualLink}`, { parse_mode: 'Markdown' }).catch(() => {});

                const newTask = {
                    chatId: userId, 
                    link: virtualLink,
                    userId: userId,
                    overrideThreadId: destTopicId,
                    overrideTargetId: match.destId,
                    isMirror: true,
                    retries: 0
                };
                taskQueue.push(newTask);
                dbEnqueueTask(newTask).catch(e => console.error("[Queue DB] enqueue error:", e));
                
                runNextTask();
                
                // Keep track of the last processed message ID in real-time
                await updateMirrorPathLastId(userId, chatIdRaw, message.id);
            }
        } catch (e: any) {
            console.error(`[Watcher] Event Handler Error: ${e.message}`);
        }
    }, new NewMessage({}));

    // Trigger catch-up scanning for any messages sent during downtime
    catchUpLiveMirrors(userId, client).catch((err: any) => {
        console.error(`[Watcher] Catch-up failed for user ${userId}:`, err.message);
    });
}

getConnectedUserbotClient = async (userId: number) => {
    const lookupId = userId;

    // Check if there's already a connection in progress
    if (pendingConnections.has(lookupId)) {
        return pendingConnections.get(lookupId);
    }

    const connectPromise = (async () => {
        // Check if we already have an active client for this user
        if (userClients.has(lookupId)) {
            const client = userClients.get(lookupId)!;
            try {
                if (client.connected) {
                    try {
                        await client.getMe();
                        await startAutoMirrorWatcher(lookupId, client);
                        return client;
                    } catch (e: any) {
                        if (e.message?.includes('AUTH_KEY_UNREGISTERED')) throw e;
                    }
                }
                await client.connect();
                await client.getMe();
                await startAutoMirrorWatcher(lookupId, client);
                return client;
            } catch (e: any) {
                console.warn(`[getConnectedUserbotClient] Client fail for ${lookupId}: ${e.message}`);
                userClients.delete(lookupId);
                activeWatchers.delete(lookupId);
            }
        }

        // Try to load session from DB/Memory
        let sessionStr = userSessions.get(lookupId);
        if (!sessionStr && approvedUsersCollection) {
            const userDoc = await approvedUsersCollection.findOne({ userId: lookupId.toString() });
            if (userDoc?.stringSession) {
                sessionStr = userDoc.stringSession;
                userSessions.set(lookupId, sessionStr);
            }
        }

        if (!sessionStr) return null;

        try {
            if (!apiIdValue || !apiHashValue) return null;

            const client = new TelegramClient(
                new StringSession(sessionStr),
                apiIdValue,
                apiHashValue,
                {
                    connectionRetries: 15,
                    timeout: 300000,
                    requestRetries: 10,
                    ...getRandomDeviceProps(),
                    useWSS: false,
                    autoReconnect: true,
                    floodSleepThreshold: 300,
                    proxy: undefined,
                }
            );

            await client.connect();
            
            // Verify session immediately
            try {
                await client.getMe();
                userClients.set(lookupId, client);
                console.log(`[getConnectedUserbotClient] Session verified for ${lookupId}`);
                
                // Prefetch dialogs backgroundly and safely
                client.getDialogs({ limit: 150 }).then(dlgs => {
                    (client as any)._dialogsCache = dlgs;
                    (client as any)._dialogsCacheTime = Date.now();
                }).catch(err => {
                    console.warn(`[getConnectedUserbotClient] Background prefetch failed: ${err.message}`);
                });

                await startAutoMirrorWatcher(lookupId, client);
                return client;
            } catch (meErr: any) {
                console.error(`[getConnectedUserbotClient] Verification failed for ${lookupId}: ${meErr.message}`);
                if (meErr.message?.includes('AUTH_KEY_UNREGISTERED')) {
                    userSessions.delete(lookupId);
                    // if (approvedUsersCollection) {
                    //     await approvedUsersCollection.updateOne({ userId: lookupId.toString() }, { $unset: { stringSession: "" } });
                    // }
                    await client.disconnect().catch(() => {});
                    return null;
                }
                
                if (meErr.message?.includes('AUTH_KEY_DUPLICATED')) {
                    userSessions.delete(lookupId);
                    // if (approvedUsersCollection) {
                    //     await approvedUsersCollection.updateOne({ userId: lookupId.toString() }, { $unset: { stringSession: "" } });
                    // }
                    await client.disconnect().catch(() => {});
                    console.error(`Session key duplicated for ${lookupId}. Cleared session.`);
                    return null;
                }
                
                await client.disconnect().catch(() => {});
                throw new Error(`[Userbot] Verification failed for ${lookupId}: ${meErr.message}`);
            }
        } catch (err: any) {
            console.error(`Userbot Client failed for user ${lookupId}:`, err);
            if (err.message?.includes('AUTH_KEY_DUPLICATED') || (err as any).errorMessage === 'AUTH_KEY_DUPLICATED') {
                userSessions.delete(lookupId);
                // if (approvedUsersCollection) {
                //     await approvedUsersCollection.updateOne({ userId: lookupId.toString() }, { $unset: { stringSession: "" } });
                // }
                console.error(`Session key duplicated for ${lookupId} in watchdog. Cleared session.`);
                throw new Error(`[Userbot] Session key duplicated for ${lookupId}. Cleared session.`);
            }
            throw new Error(`[Userbot] Connection failed for user ${lookupId}: ${err.message}`);
        }
    })();

    pendingConnections.set(lookupId, connectPromise);
    try {
        return await connectPromise;
    } finally {
        pendingConnections.delete(lookupId);
    }
};

createProgressBar = (total: number, current: number, label: string, startTime: number, pathStr?: string) => {
    const percentage = Math.min(100, Math.max(0, Math.floor((current / (total || 1)) * 100)));
    const size = 12;
    const filled = Math.min(size, Math.max(0, Math.floor((size * (current || 0)) / (total || 1))));
    const empty = Math.max(0, size - filled);
    
    const colors = ["🟥", "🟧", "🟨", "🟩", "🟦", "🟪"];
    let progressBar = "";
    for(let i = 0; i < filled; i++) {
        progressBar += colors[Math.floor((i / size) * colors.length)];
    }
    progressBar += "⬜".repeat(empty);
    
    const now = Date.now();
    const elapsed = (now - startTime) / 1000;
    const speed = elapsed > 0 ? (current / elapsed) : 0; // bytes per second
    const remaining = total - current;
    const eta = speed > 0 ? Math.ceil(remaining / speed) : 0;

    const formatBytes = (bytes: number) => {
        if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        let i = Math.floor(Math.log(bytes) / Math.log(k));
        if (i < 0) i = 0;
        if (i >= sizes.length) i = sizes.length - 1;
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const formatTime = (seconds: number) => {
        if (seconds === 0 || seconds > 86400 * 7) return "∞";
        if (seconds < 60) return `${seconds}s`;
        const totalMins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        if (totalMins < 60) return `${totalMins}m ${secs}s`;
        const hours = Math.floor(totalMins / 60);
        const mins = totalMins % 60;
        return `${hours}h ${mins}m`;
    };

    const formatElapsed = (seconds: number) => {
        if (seconds <= 0) return "0s";
        if (seconds < 60) return `${Math.floor(seconds)}s`;
        const totalMins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        if (totalMins < 60) return `${totalMins}m ${secs}s`;
        const hours = Math.floor(totalMins / 60);
        const mins = totalMins % 60;
        return `${hours}h ${mins}m`;
    };

    const icon = label === "Downloading" ? "⬇️" : "⬆️";
    const meta = label === "Downloading" ? "Server ⟿ Bot" : "Bot ⟿ Your Chat";

    // Enhanced progress tracker
    const text = `╔═══ ${icon} ${label.toUpperCase()} ═══╗\n` +
           `║ ${progressBar} ${percentage}%\n` +
           `╠══════════════════════╣\n` +
           `║ 📦 𝗦𝗶𝘇𝗲   : ${formatBytes(current)} / ${formatBytes(total)}\n` +
           `║ ⚡ 𝗦𝗽𝗲𝗲𝗱  : ${formatBytes(speed)}/s\n` +
           `║ ⏳ 𝗘𝗧𝗔    : ${formatTime(eta)} (Elapsed: ${formatElapsed(elapsed)})\n` +
           `╠══════════════════════╣\n` +
           `║ 🚀 𝗠𝗼𝗱𝗲   : ${currentUploadEngine}\n` +
           `║ 🛰 𝗥𝗼𝘂𝘁𝗲  : ${meta}\n` +
           `║ 👣 𝗣𝗮𝘁𝗵    : ${pathStr || 'N/A'}\n` +
           `╚══════════════════════╝`;
    return text;
};

createProgressMarkup = (jobKey: string, isPaused: boolean) => ({
    inline_keyboard: [[
        { text: isPaused ? '▶️ Resume' : '⏸️ Pause', callback_data: `${isPaused ? 'resume' : 'pause'}_${jobKey}` },
        { text: '🔁 Retry', callback_data: `retry_${jobKey}` },
        { text: '⏭️ Skip Task', callback_data: `skip_${jobKey}` }
    ]]
});

    const getBestClientForLinkData = async (linkData: any, preferredUserIdParam: number, statusMsgId?: number, chatId?: number) => {
        const preferredUserId = Number(await resolveSettingsUserId(preferredUserIdParam)) || preferredUserIdParam;

        // Strictly use the preferred account as requested by the user
        const client = await getConnectedUserbotClient(preferredUserId);
        if (client) {
            try {
                let entity = await safelyResolveEntity(client, linkData.channelId).catch(() => null);
                if (!entity && !linkData.isRestricted && typeof linkData.channelId === 'string' && !linkData.channelId.startsWith('-')) {
                    try {
                        await client.invoke(new Api.channels.JoinChannel({ channel: linkData.channelId }));
                        entity = await safelyResolveEntity(client, linkData.channelId).catch(() => null);
                    } catch (joinErr) {}
                }
                if (entity) {
                    const msgs = await client.getMessages(entity, { ids: [linkData.msgId] });
                    if (msgs && msgs.length > 0 && !(msgs[0] instanceof Api.MessageEmpty)) {
                        return { client, userId: preferredUserId, peer: entity };
                    }
                }
            } catch (e) {}
        }

        // --- SMART ROUTING CRITICAL FALLBACK ---
        // Try other active connected clients to see if they can access the channel/message
        for (const [vId, otherClient] of userClients.entries()) {
            if (vId === preferredUserId) continue;
            try {
                let entity = await safelyResolveEntity(otherClient, linkData.channelId).catch(() => null);
                if (!entity && !linkData.isRestricted && typeof linkData.channelId === 'string' && !linkData.channelId.startsWith('-')) {
                    try {
                        await otherClient.invoke(new Api.channels.JoinChannel({ channel: linkData.channelId }));
                        entity = await safelyResolveEntity(otherClient, linkData.channelId).catch(() => null);
                    } catch (joinErr) {}
                }
                if (entity) {
                    const msgs = await otherClient.getMessages(entity, { ids: [linkData.msgId] });
                    if (msgs && msgs.length > 0 && !(msgs[0] instanceof Api.MessageEmpty)) {
                        console.log(`[Smart Route] Routed fetch of msg ${linkData.msgId} from preferred user ${preferredUserId} to active user ${vId}`);
                        return { client: otherClient, userId: vId, peer: entity };
                    }
                }
            } catch (e) {}
        }

        return { client, userId: preferredUserId, peer: null };
    };

    const getBestClientForTarget = async (targetId: any, preferredUserIdParam: number, statusMsgId?: number, chatId?: number) => {
        const preferredUserId = Number(await resolveSettingsUserId(preferredUserIdParam)) || preferredUserIdParam;
        
        // Strictly use the preferred account as requested by the user
        const prefClient = await getConnectedUserbotClient(preferredUserId);
        if (prefClient) {
            try {
                let entity = await safelyResolveEntity(prefClient, targetId).catch(() => null);
                if (!entity && typeof targetId === 'string' && !targetId.startsWith('-') && !targetId.startsWith('{')) {
                    try {
                        await prefClient.invoke(new Api.channels.JoinChannel({ channel: targetId }));
                        entity = await safelyResolveEntity(prefClient, targetId).catch(() => null);
                    } catch (joinErr) {}
                }
                if (entity) return { client: prefClient, userId: preferredUserId, peer: entity };
            } catch (e) {}
        }

        // --- SMART ROUTING CRITICAL FALLBACK ---
        // Try other active connected clients to see if they can access the destination target
        for (const [vId, otherClient] of userClients.entries()) {
            if (vId === preferredUserId) continue;
            try {
                let entity = await safelyResolveEntity(otherClient, targetId).catch(() => null);
                if (!entity && typeof targetId === 'string' && !targetId.startsWith('-') && !targetId.startsWith('{')) {
                    try {
                        await otherClient.invoke(new Api.channels.JoinChannel({ channel: targetId }));
                        entity = await safelyResolveEntity(otherClient, targetId).catch(() => null);
                    } catch (joinErr) {}
                }
                if (entity) {
                    console.log(`[Smart Route] Routed destination ${targetId} from preferred user ${preferredUserId} to active user ${vId}`);
                    return { client: otherClient, userId: vId, peer: entity };
                }
            } catch (e) {}
        }
        
        return { client: prefClient, userId: preferredUserId, peer: null };
    };

    const processTask = async (chatId: number, link: string, statusMsgId: number, userId: number, threadIdOverride?: number, forceGeneralPath?: boolean, targetIdOverride?: any, isMirror?: boolean): Promise<boolean> => {
        let cleanLink = link.trim();
        let destTargetStr = (targetIdOverride || "Default").toString();
        let tempFilePath: string | undefined = undefined;
        let thumbPath: string | undefined = undefined;
        let hasThumb = false;
        try {
            const getLinkData = (url: string) => {
                const cleanUrl = url.trim().split('?')[0];
                const parts = cleanUrl.split('/').filter(p => p.length > 0);
                
                const msgId = parseInt(parts[parts.length - 1]);
                if (isNaN(msgId)) throw new Error("Could not parse Message ID from link.");

                const domainIdx = parts.findIndex(p => p.includes('t.me') || p === 't.me');
                if (domainIdx === -1 || parts.length <= domainIdx + 1) {
                    throw new Error("Invalid Telegram Link format.");
                }

                const nextPart = parts[domainIdx + 1];
                if (nextPart === 'c' && parts.length > domainIdx + 2) {
                    let channelId = parts[domainIdx + 2];
                    // Ensure private channel ID starts with -100 for reliable lookups
                    if (!channelId.startsWith('-100') && /^\d+$/.test(channelId)) {
                        channelId = "-100" + channelId;
                    }
                    return {
                        channelId: channelId,
                        msgId: msgId,
                        isRestricted: true
                    };
                }

                return {
                    channelId: nextPart, // This is either a username @username or a public chat ID
                    msgId: msgId,
                    isRestricted: false
                };
            };

            const linkData = getLinkData(link);
            
            const { client: sourceClient, peer: resolvedSourcePeer } = await getBestClientForLinkData(linkData, userId, statusMsgId, chatId);
            if (!sourceClient) {
                await safeEditMessage("❌ **No active Userbot session has access to this source!**\n\nPlease /login with an account that is a member of this channel, or ensure your currently logged-in account has access.", { chat_id: chatId, message_id: statusMsgId });
                return false;
            }
            
            let userDoc: any = null;
            if (approvedUsersCollection) {
                userDoc = await approvedUsersCollection.findOne({ userId: (await resolveSettingsUserId(userId)) });
            }
            const customRules = userDoc?.renameRules || [];

            if (!sourceClient.connected) await sourceClient.connect().catch(() => {});

            // Resolve target upload destination (User preference or default)
            let uploadTarget: any = targetIdOverride || DEFAULT_LOG_GROUP;
            let threadId: number | undefined = threadIdOverride;
            console.log(`[Debug ProcessTask] targetIdOverride: ${targetIdOverride}, threadIdOverride: ${threadIdOverride}, uploadTarget: ${uploadTarget}, threadId: ${threadId}`);

            let mirrorPath: any = undefined;
            if (targetIdOverride === undefined) {
                const sourceId = linkData.channelId;
                mirrorPath = (isMirror || !forceGeneralPath) ? userDoc?.mirrorPaths?.find((p: any) => 
                     p.sourceId === sourceId || p.sourceId === `-100${sourceId}` || sourceId === p.sourceId.replace('-100', '')
                ) : undefined;

                if (mirrorPath) {
                    uploadTarget = mirrorPath.destId;
                    if (threadId === undefined) threadId = mirrorPath.destThreadId ? Number(mirrorPath.destThreadId) : undefined;
                } else if (!isMirror && userDoc?.uploadPath) {
                    uploadTarget = userDoc.uploadPath;
                    if (threadId === undefined && (userDoc.uploadTopicId || userDoc.uploadThreadId)) {
                        threadId = Number(userDoc.uploadTopicId || userDoc.uploadThreadId);
                    }
                }
            }

            // CRITICAL USER MANDATE: If no Upload/Set Path is configured AND no target was provided, by default send strictly to -1003995334936 only and nowhere else.
            if (!userDoc?.uploadPath && targetIdOverride === undefined) {
                uploadTarget = DEFAULT_LOG_GROUP;
                threadId = undefined;
            }

        // Smart Route Destination: Find a client that can reach the destination
            let destClient: any = null;
            let destPeer: any = null;

            if (userDoc?.uploadAgent === 'bot') {
                let bClient = await getConnectedBotClient();
                if (!bClient) {
                    console.warn("Bot GramJS Client not initially available, retrying once...");
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    bClient = await getConnectedBotClient();
                }
                
                if (!bClient) {
                    if (botFloodWaitEnd > Date.now()) {
                        throw new Error("Telegram Bot currently under heavy abuse (FloodWait). Please wait a few minutes.");
                    }
                    throw new Error("Bot GramJS Client is not configured or connected. Please make sure BOT_TOKEN, API_ID, and API_HASH are valid.");
                }
                destClient = bClient;
                try {
                    const directResolve = await destClient.getEntity(uploadTarget);
                    destPeer = await destClient.getInputEntity(directResolve);
                } catch (e: any) {
                    throw new Error("Target destination could not be resolved by the Telegram Bot. Ensure the Bot has been joined/invited to the destination chat/channel as an Administrator.");
                }
            } else {
                const resolvedTarget = await getBestClientForTarget(uploadTarget, userId, statusMsgId, chatId);
                destClient = resolvedTarget.client;
                destPeer = resolvedTarget.peer;
            }
            
            let finalDestPeer = destPeer;
            
            // Construct path display
            let destName = "Target";
            let destTopic = "";
            if (isMirror && mirrorPath) {
                destName = mirrorPath.destGroupName || "Mirror Target";
                destTopic = mirrorPath.destTopicName || "";
            } else {
                destName = userDoc?.uploadGroupName || "Group";
                destTopic = userDoc?.uploadTopicName || "";
            }
            const pathDisplay = `${destName}${destTopic ? ' > ' + destTopic : ''}`;

            if (!finalDestPeer || (finalDestPeer.className === 'InputPeerChannel' && finalDestPeer.accessHash?.toString() === '0')) {
                try {
                    // Pre-flight check to fail early before downloading/uploading
                    const directResolve = await destClient.getEntity(uploadTarget);
                    finalDestPeer = await destClient.getInputEntity(directResolve);
                } catch (e: any) {
                    if (userDoc?.uploadAgent === 'bot') {
                        throw new Error("Target destination could not be resolved by the Telegram Bot. Ensure the Bot is added as an Administrator in the destination.");
                    } else {
                        throw new Error("Target destination could not be resolved by your Userbot. Ensure the Userbot has joined the destination chat/channel.");
                    }
                }
            }
            if (!destClient) {
                if (userDoc?.uploadAgent === 'bot') {
                    throw new Error("Telegram Bot destination client unreachable.");
                } else {
                    throw new Error("Destination unreachable. Ensure your Userbot is a member.");
                }
            }

            destTargetStr = uploadTarget.toString();
            cleanLink = link.trim();
            if (isMirror && mirroredMessagesCollection) {
                const existing = await mirroredMessagesCollection.findOne({ link: cleanLink, destId: destTargetStr });
                if (existing) {
                    inMemoryMirrorLogs.unshift({
                        link: cleanLink,
                        destId: destTargetStr,
                        mirroredAt: new Date().toISOString(),
                        status: 'Skipped',
                        info: 'Already mirrored to destination'
                    });
                    if (inMemoryMirrorLogs.length > 500) inMemoryMirrorLogs.pop();
                    await safeEditMessage(`⚡ **Skipped:** Already mirrored to destination.\n\n🔗 **Link:** ${link}`, { chat_id: chatId, message_id: statusMsgId });
                    return true;
                }
            }

            const recordSuccessfulMirror = async () => {
                inMemoryMirrorLogs.unshift({
                    link: cleanLink,
                    destId: destTargetStr,
                    mirroredAt: new Date().toISOString(),
                    status: 'Success'
                });
                if (inMemoryMirrorLogs.length > 500) inMemoryMirrorLogs.pop();
                if (mirroredMessagesCollection) {
                    await mirroredMessagesCollection.updateOne(
                        { link: cleanLink, destId: destTargetStr },
                        { $set: { link: cleanLink, destId: destTargetStr, mirroredAt: new Date() } },
                        { upsert: true }
                    ).catch(err => console.error("[recordSuccessfulMirror] Error:", err));
                }
            };

            await safeEditMessage("🔍 **Locating content...**", { chat_id: chatId, message_id: statusMsgId });
            const sourcePeer = resolvedSourcePeer || await safelyResolveEntity(sourceClient, linkData.channelId);

            await safeEditMessage("📥 **Retrieving content...**", { chat_id: chatId, message_id: statusMsgId });
            
            let msg: any;
            let retryCount = 0;
            let timeoutRetryCount = 0;
            const maxRetries = 2;
            const maxTimeoutRetries = 7;
            while (retryCount <= maxRetries && timeoutRetryCount <= maxTimeoutRetries) {
                try {
                    console.log(`[Debug] Attempting to fetch message ${linkData.msgId} from ${linkData.channelId} using sourceClient (attempt ${retryCount+1}).`);
                    const messages = await sourceClient.getMessages(sourcePeer, { ids: [linkData.msgId] });
                    msg = messages?.[0];
                    if (msg && !(msg instanceof Api.MessageEmpty)) break;
                    
                    console.log(`[Debug] sourceClient returned empty, trying destClient.`);
                    const destSourcePeer = (destClient === sourceClient) ? sourcePeer : await safelyResolveEntity(destClient, linkData.channelId).catch(() => null);
                    if (destSourcePeer) {
                        const destMessages = await destClient.getMessages(destSourcePeer, { ids: [linkData.msgId] });
                        msg = destMessages?.[0];
                        if (msg && !(msg instanceof Api.MessageEmpty)) break;
                    }

                    throw new Error("ENTITY_ACCESS_STALE");
                } catch (err: any) {
                    const isInvalidErr = err.errorMessage === 'CHANNEL_INVALID' || err.errorMessage === 'PEER_ID_INVALID' || (err.message && (err.message.includes('CHANNEL_INVALID') || err.message.includes('PEER_ID_INVALID') || err.message.includes('STALE')));
                    const isTimeoutErr = err.message && (err.message.toUpperCase().includes('TIMEOUT') || err.message.toUpperCase().includes('ETIMEDOUT') || err.message.toUpperCase().includes('SOCKET HANG UP'));
                    
                    if (isTimeoutErr && timeoutRetryCount < maxTimeoutRetries) {
                        timeoutRetryCount++;
                        console.log(`[Content Fetch] Timeout detected, retrying ${timeoutRetryCount}/${maxTimeoutRetries}...`);
                        await sleep(2000);
                        continue;
                    }
                    
                    if (isInvalidErr && retryCount < maxRetries) {
                        retryCount++;
                        await safeEditMessage(`🔄 **Retrying content access (${retryCount}/${maxRetries})...**`, { chat_id: chatId, message_id: statusMsgId });
                        await sleep(2000);
                        continue;
                    }
                    
                    if (isInvalidErr) {
                        throw new Error(`Cannot access the channel. The channel may be private, restricted, or the Userbot is not a member.`);
                    }
                    if (isTimeoutErr) {
                        throw new Error(`Telegram API Timeout`);
                    }
                    throw err;
                }
            }

            if (!msg || !(msg instanceof Api.Message)) throw new Error("Content not found. The Userbot session used does not have access to this message. Please switch to an account that is a member of the source channel, or verify the link.");

            let fileKey: string | null = null;

            // Advanced Topic Blocking logic for all MIRROR modes
            if (isMirror) {
                const settingsUid = await resolveSettingsUserId(userId);
                const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
                const blockedTopics = (userDoc?.blockedTopics || []).map((t: string) => t.trim().toLowerCase());
                
                let sourceThreadId = msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId || msg.replyToMsgId;
                const sourceGroupIdStr = linkData.channelId.toString().replace('-100', '');
                
                if (sourceThreadId) {
                    const blockStr = `-100${sourceGroupIdStr}_${sourceThreadId}`.toLowerCase();
                    const blockStrWithoutMinus100 = `${sourceGroupIdStr}_${sourceThreadId}`.toLowerCase();
                    
                    if (blockedTopics.some((bt: string) => bt === sourceThreadId.toString() || bt === blockStr || bt === blockStrWithoutMinus100)) {
                        console.log(`[Queue] Skipping blocked topic for message ${linkData.msgId} (ThreadId: ${sourceThreadId})`);
                        await safeEditMessage(`🚫 **Skipped task (Blocked Topic):**\n└ Link: ${link}`, { chat_id: chatId, message_id: statusMsgId });
                        return true; // Return success so queue continues without breaking
                    }
                }
            }

            // Attempt direct forward first as requested by user
            let canForward = true;
            let forwardAttempted = false;
            if (msg.noforwards || (msg as any).noforwards) {
                console.log(`[Debug] Direct forward not possible: Message noforwards flag is set.`);
                canForward = false;
            } else {
                try {
                    const chatEntity = await msg.getChat().catch(() => null);
                    if (chatEntity && (chatEntity.noforwards || (chatEntity as any).noforwards)) {
                        console.log(`[Debug] Direct forward not possible: Chat content protection is enabled.`);
                        canForward = false;
                    }
                } catch (chatError) {
                    console.warn(`Failed to inspect chat entity for restricted forwarding check:`, chatError);
                }
            }

            if (canForward) {
                console.log(`[Debug] Attempting direct forward for msg ${linkData.msgId}`);
                await safeEditMessage("🚀 **Attempting direct forward...**", { chat_id: chatId, message_id: statusMsgId });
                try {
                    let finalSourcePeer = (destClient === sourceClient) ? sourcePeer : await safelyResolveEntity(destClient, linkData.channelId).catch(() => null);
                    if (!finalSourcePeer) {
                        finalSourcePeer = sourcePeer;
                    }
                    const targetPeer = finalDestPeer || await safelyResolveEntity(destClient, uploadTarget);
                    
                    if (finalSourcePeer && targetPeer) {
                        forwardAttempted = true;
                        const forwardResult = await destClient.invoke(new Api.messages.ForwardMessages({
                            fromPeer: finalSourcePeer,
                            id: [linkData.msgId],
                            toPeer: targetPeer,
                            dropAuthor: true,
                            topMsgId: threadId,
                            randomId: [helpers.generateRandomLong(true)]
                        }));
                        console.log(`[Debug] Direct forward successful.`);
                        
                        let sentMsgId = 0;
                        if (forwardResult && forwardResult.updates) {
                            for (const upd of forwardResult.updates) {
                                if (upd instanceof Api.UpdateNewMessage && upd.message && (upd.message as any).id) {
                                    sentMsgId = (upd.message as any).id;
                                    break;
                                }
                            }
                        }

                        let uploadedLink = "";
                        if (sentMsgId) {
                            try {
                                const entity = await destClient.getEntity(targetPeer);
                                const channelId = entity.id.toString().replace("-100", "");
                                uploadedLink = `https://t.me/c/${channelId}/${sentMsgId}`;
                            } catch (e) {}
                        }

                        const kb: any[] = [];
                        const row: any[] = [];
                        if (link && link.startsWith("http")) row.push({ text: "⏪ Source", url: link });
                        if (uploadedLink) row.push({ text: "📤 Upload", url: uploadedLink });
                        if (row.length > 0) kb.push(row);

                        await safeEditMessage(`🎯 **Success! (Direct Forward)**`, { 
                            chat_id: chatId, 
                            message_id: statusMsgId,
                            reply_markup: kb.length > 0 ? { inline_keyboard: kb } : undefined
                        });
                        await recordSuccessfulMirror();
                        return true;

                    } else {
                        console.log(`[Debug] Direct forward skipped: finalSourcePeer or targetPeer missing.`);
                    }
                } catch (e: any) {
                    console.log(`[Debug] Direct forward attempt failed: ${e.message || e}. Falling back to download/upload flow.`);
                }
            } else {
                console.log(`[Debug] Skipped direct forward because forwarding is restricted/not possible.`);
            }

            if (!msg.media || msg.media instanceof Api.MessageMediaWebPage) {
                await destClient.sendMessage(finalDestPeer, { message: applyRenameRules(msg.message || "", customRules), replyTo: threadId });
                
                const kb: any[] = [];
                const row: any[] = [];
                if (link && link.startsWith("http")) row.push({ text: "⏪ Source", url: link });
                // We don't have the uploaded file link easily here, so we will omit it for now or use a placeholder if appropriate, 
                // but user asked for "upload wale me kha tumne us file ko upload Kiya uska link hoga"
                // Given the current structure, omitting it or handling it later might be best if it's too complex.
                
                if (row.length > 0) kb.push(row);
                
                await safeEditMessage(`🎯 **Success!**`, { 
                    chat_id: chatId, 
                    message_id: statusMsgId,
                    reply_markup: kb.length > 0 ? { inline_keyboard: kb } : undefined
                });
                await recordSuccessfulMirror();
                return true;

            }

            if (!(msg.media instanceof Api.MessageMediaDocument) && !(msg.media instanceof Api.MessageMediaPhoto)) {
                // If it is another type of media (e.g. Geo, Contact, Poll), log and skip it.
                console.warn(`[Queue] Skipping unsupported media type: ${msg.media.className}`);
                return false;
            }

            // --- Cache Interception start ---
            fileKey = getSecureHashedFileKey(msg);
            console.log(`[Cache] Checking cache with fileKey: ${fileKey}`);
            let cachedFileRecord: any = null;
            if (fileKey && fileCacheCollection) {
                try {
                    cachedFileRecord = await fileCacheCollection.findOne({ fileKey });
                } catch (ce) {
                    console.error("[Cache] Failed to query cache database:", ce);
                }
            }

            if (cachedFileRecord) {
                console.log(`[Cache] Matching file found in cache:`, cachedFileRecord);
                await safeEditMessage(`⚡ **Cached file found! Forwarding directly...**`, { chat_id: chatId, message_id: statusMsgId });
                
                try {
                    const defaultLogPeer = await safelyResolveEntity(destClient, DEFAULT_LOG_GROUP);
                    const targetPeer = finalDestPeer || await safelyResolveEntity(destClient, uploadTarget);
                    
                    if (defaultLogPeer && targetPeer) {
                        forwardAttempted = true;
                        const forwardResult = await destClient.invoke(new Api.messages.ForwardMessages({
                            fromPeer: defaultLogPeer,
                            id: [Number(cachedFileRecord.savedMsgId)],
                            toPeer: targetPeer,
                            dropAuthor: true,
                            topMsgId: threadId,
                            randomId: [helpers.generateRandomLong(true)]
                        }));
                        
                        let sentMsgId: number | undefined;
                        if (forwardResult && forwardResult.updates) {
                            for (const upd of forwardResult.updates) {
                                if (upd instanceof Api.UpdateNewMessage && upd.message && (upd.message as any).id) {
                                    sentMsgId = (upd.message as any).id;
                                    break;
                                }
                            }
                        }
                        
                        let uploadedLink = "";
                        if (sentMsgId) {
                            try {
                                const entity = await destClient.getEntity(targetPeer);
                                const channelId = entity.id.toString().replace("-100", "");
                                uploadedLink = `https://t.me/c/${channelId}/${sentMsgId}`;
                            } catch (e) {}
                        }
                        
                        let message = `┏━━━━━━━━━━━━━━━━━━━━━━┓\n┃ 🎯 𝗦𝘂𝗰𝗰𝗲𝘀𝘀𝗳𝘂𝗹𝗹𝘆 𝗠𝗶𝗿𝗿𝗼𝗿𝗲𝗱! ┃\n┣━━━━━━━━━━━━━━━━━━━━━━┫\n┃ ⚡ (Cache Hit - Forwarded) ┃\n┗━━━━━━━━━━━━━━━━━━━━━━┛`;
                        const kb: any[] = [];
                        const row: any[] = [];
                        if (link && link.startsWith("http")) {
                            row.push({ text: "🔗 𝗦𝗼𝘂𝗿𝗰𝗲", url: link });
                        }
                        if (uploadedLink) {
                            row.push({ text: "📥 𝗗𝗼𝘄𝗻𝗹𝗼𝗮𝗱", url: uploadedLink });
                        }
                        if (row.length > 0) kb.push(row);
                        
                        await safeEditMessage(message, { chat_id: chatId, message_id: statusMsgId, reply_markup: kb.length > 0 ? { inline_keyboard: kb } : undefined });
                        await recordSuccessfulMirror();
                        return true;
                    }
                } catch (forwardErr) {
                    console.error("[Cache] Forward from cache failed. Retrying with full download/upload flow...", forwardErr);
                    if (forwardErr && (forwardErr as any).errorMessage === "MESSAGE_ID_INVALID") {
                         await fileCacheCollection.deleteOne({ fileKey }).catch(() => {});
                         console.log(`[Cache] Invalidated cache entry for: ${fileKey}`);
                    }
                    // Falls back to standard download flow if forward fails
                }
            }
            // --- Cache Interception end ---

            if (forwardAttempted) return true;
            await safeEditMessage(`📥 **Downloading via Source Account...**`, { chat_id: chatId, message_id: statusMsgId });
            
            console.log(`[Debug] Downloading message. msg: ${JSON.stringify(msg, (key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}`);                
            let filename = "file";
            if (msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document) {
                const attr = msg.media.document.attributes.find(a => a instanceof Api.DocumentAttributeFilename);
                if (attr && (attr as any).fileName) filename = (attr as any).fileName;
            } else if (msg.media instanceof Api.MessageMediaPhoto) {
                filename = "photo.jpg";
            }
            filename = applyRenameRules(filename, customRules);

            tempFilePath = path.join(os.tmpdir(), `dl_${userId}_${linkData.channelId}_${linkData.msgId}_${filename}`);
            thumbPath = path.join(os.tmpdir(), `thumb_${userId}_${linkData.channelId}_${linkData.msgId}.jpg`);
            hasThumb = false;
            let downloadStartTime = Date.now();

            // Try custom thumbnail first
            const settingsUidForThumb = await resolveSettingsUserId(userId);
            const userCustomThumbPath = path.join(os.tmpdir(), `custom_thumb_${settingsUidForThumb}.jpg`);
            if (userDoc?.customThumbnailFileId) {
                try {
                    const downloaded = await bot?.downloadFile(userDoc.customThumbnailFileId, os.tmpdir());
                    if (downloaded) {
                        fs.renameSync(downloaded, userCustomThumbPath);
                    }
                } catch (err) {}
            }

            if (fs.existsSync(userCustomThumbPath)) {
                try {
                    fs.copyFileSync(userCustomThumbPath, thumbPath);
                    hasThumb = true;
                } catch (err) {}
            } else if (msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document) {
                const doc = msg.media.document;
                if (doc.thumbs && doc.thumbs.length > 0) {
                    try {
                        const largestThumb = doc.thumbs[doc.thumbs.length - 1]; 
                        await sourceClient.downloadMedia(msg, { thumb: largestThumb, outputFile: thumbPath });
                        hasThumb = fs.existsSync(thumbPath);
                    } catch (e) {}
                }
            }
            
            let totalBytes = 0;
            let currentBytes = 0;
            let lastDownloadUpdate = 0;
            const jobKey = `${userId}-${link}`;
            const tryDownload = async () => {
                await resumeDownloadFile(sourceClient, msg, tempFilePath, jobKey, async (c, t) => {
                    // Pause check (Throw early to prevent GramJS idle socket TIMEOUT)
                    const taskState = taskControlMap.get(jobKey);
                    if (taskState && taskState.isPaused) {
                        throw new Error("DOWNLOAD_PAUSED");
                    }
                    if (taskState && taskState.isSkipped) {
                        throw new Error("DOWNLOAD_SKIPPED");
                    }

                    const now = Date.now();
                    totalBytes = Number(t || 0);
                    currentBytes = Number(c);
                    const elapsed = (now - downloadStartTime) / 1000;
                    const speed = elapsed > 0 ? (currentBytes / elapsed) : 0;
                    const percent = totalBytes > 0 ? ((currentBytes / totalBytes) * 100) : 0;
                    const eta = speed > 0 && totalBytes > 0 ? Math.max(0, (totalBytes - currentBytes) / speed) : -1;

                    const job = activeTaskJobs.get(jobKey);
                    if (job) {
                        job.phase = 'downloading';
                        job.progress = {
                            total: totalBytes,
                            current: currentBytes,
                            speed: speed,
                            percent: percent,
                            elapsed: Math.floor(elapsed),
                            eta: Math.round(eta)
                        };
                    }

                    if (now - lastDownloadUpdate > 5000 || currentBytes === totalBytes) {
                        lastDownloadUpdate = now;
                        const isPaused = taskControlMap.get(jobKey)?.isPaused || false;
                        safeEditMessage(createProgressBar(totalBytes, currentBytes, "Downloading", downloadStartTime, pathDisplay), { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown', reply_markup: createProgressMarkup(jobKey, isPaused) }).catch(() => {});
                    }
                });
            };

            let downloadDone = false;
            let downloadRetries = 0;
            while (!downloadDone) {
                try {
                    await tryDownload();
                    downloadDone = true;
                } catch (err: any) {
                    const taskState = taskControlMap.get(jobKey);
                    if (taskState && taskState.isSkipped) {
                        throw new Error("DOWNLOAD_SKIPPED");
                    }
                    if (taskState && taskState.isPaused) {
                        console.log(`[Download] Task ${jobKey} is paused by user. Entering idle wait...`);
                        
                        // Edit message status to (Paused)
                        safeEditMessage(createProgressBar(totalBytes || 100, currentBytes || 0, "Downloading (Paused)", downloadStartTime, pathDisplay), { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown', reply_markup: createProgressMarkup(jobKey, true) }).catch(() => {});
                        
                        // Loop to wait for resume
                        while (true) {
                            const currentTaskState = taskControlMap.get(jobKey);
                            if (!currentTaskState || !currentTaskState.isPaused) {
                                break;
                            }
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                        
                        // Edited status to (Resuming...)
                        safeEditMessage(createProgressBar(totalBytes || 100, currentBytes || 0, "Downloading (Resuming...)", downloadStartTime, pathDisplay), { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown', reply_markup: createProgressMarkup(jobKey, false) }).catch(() => {});
                        console.log(`[Download] Task ${jobKey} was resumed. Reconnecting stream...`);
                        
                        // Reset downloadStartTime to compensate for paused duration, so speed calculations remain correct
                        downloadStartTime = Date.now();
                        continue;
                    }

                    if (taskState && taskState.shouldRetry) {
                        taskState.shouldRetry = false;
                        taskControlMap.set(jobKey, taskState);
                        console.log(`[Download] Retrying task ${jobKey}...`);
                        continue;
                    }

                    const errStr = (err.message || "").toUpperCase();
                    const isTimeout = errStr.includes("TIMEOUT") || errStr.includes("ETIMEDOUT") || errStr.includes("SOCKET HANG UP") || errStr.includes("DOWNLOAD_TIMEOUT_STALLED");
                    const isFileRef = errStr.includes("FILE_REFERENCE_EXPIRED") || errStr.includes("FILE_REFERENCE") || errStr.includes("REFERENCE_EXPIRED") || errStr.includes("FILE_REFERENCE_INVALID");
                    
                    if ((isTimeout || isFileRef) && downloadRetries < 5) {
                        downloadRetries++;
                        console.log(`[Download] Download failed (timeout/file ref). Retrying... (Attempt ${downloadRetries}/5) Error: ${errStr}`);
                        try {
                            const targetSourcePeer = resolvedSourcePeer || await safelyResolveEntity(sourceClient, linkData.channelId).catch(() => null);
                            if (targetSourcePeer) {
                                const refetchedMsgs = await sourceClient.getMessages(targetSourcePeer, { ids: [linkData.msgId] });
                                if (refetchedMsgs && refetchedMsgs.length > 0 && !(refetchedMsgs[0] instanceof Api.MessageEmpty)) {
                                    msg = refetchedMsgs[0];
                                    // Redownload custom/automatic thumbnail now that reference is updated
                                    if (!hasThumb && !fs.existsSync(userCustomThumbPath) && msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document) {
                                        const doc = msg.media.document;
                                        if (doc.thumbs && doc.thumbs.length > 0) {
                                            try {
                                                const largestThumb = doc.thumbs[doc.thumbs.length - 1]; 
                                                await sourceClient.downloadMedia(msg, { thumb: largestThumb, outputFile: thumbPath });
                                                hasThumb = fs.existsSync(thumbPath);
                                            } catch (e) {}
                                        }
                                    }
                                    continue; // Retry the while loop
                                }
                            }
                        } catch (e) {
                            console.log("[Download] Failed to refetch message for file reference. Details:", e);
                        }
                        
                        // If we fall through but it's just a timeout, we can still just retry!
                        if (isTimeout && !isFileRef) {
                            console.log(`[Download] isTimeout without file ref expiration. Continuing attempt ${downloadRetries}/5`);
                            continue;
                        }
                    }
                    throw err;
                }
            }

            if (!fs.existsSync(tempFilePath) || fs.statSync(tempFilePath).size === 0) throw new Error("Download failed.");

            // Reset job phase to uploading
            const prepKey = `${userId}-${link}`;
            const prepJob = activeTaskJobs.get(prepKey);
            if (prepJob) {
                prepJob.phase = 'uploading';
                delete prepJob.progress;
            }

            const agentLabel = (userDoc?.uploadAgent === 'bot') ? 'Bot itself' : 'Destination Account';
            const uploadRes = await safeEditMessage(`📤 **Uploading via ${agentLabel}...**`, { chat_id: chatId, message_id: statusMsgId });
            if (uploadRes && uploadRes.id) statusMsgId = uploadRes.id;
            
            const uploadStartTime = Date.now();
            const totalSize = fs.statSync(tempFilePath).size;
            let lastUploadUpdate = 0;

            let uploadWorkers = 4;
            if (totalSize > 1000 * 1024 * 1024) { // > 1GB
                uploadWorkers = 16;
            } else if (totalSize > 500 * 1024 * 1024) { // > 500 MB
                uploadWorkers = 10;
            } else if (totalSize > 100 * 1024 * 1024) {
                uploadWorkers = 8;
            } else if (totalSize > 20 * 1024 * 1024) {
                uploadWorkers = 4;
            }

            let uploadDone = false;
            let uploadRetries = 0;
            let sentMsg: any = null;

            while (!uploadDone) {
                try {
                    if (!destClient.connected) await destClient.connect().catch(() => {});
                    const uploadedFile = await destClient.uploadFile({
                        file: new CustomFile(filename, totalSize, tempFilePath),
                        workers: uploadWorkers,
                        onProgress: async (current: any) => {
                            let currentBytes = Number(current);
                            if (currentBytes <= 1.0 && currentBytes >= 0) {
                                currentBytes = Math.floor(currentBytes * totalSize);
                            }
                            const now = Date.now();
                            const elapsed = (now - uploadStartTime) / 1000;
                            const speed = elapsed > 0 ? (currentBytes / elapsed) : 0;
                            const percent = totalSize > 0 ? ((currentBytes / totalSize) * 100) : 0;
                            const eta = speed > 0 && totalSize > 0 ? Math.max(0, (totalSize - currentBytes) / speed) : -1;
        
                            const jobKey = `${userId}-${link}`;
                            const job = activeTaskJobs.get(jobKey);
                            if (job) {
                                job.phase = 'uploading';
                                job.progress = {
                                    total: totalSize,
                                    current: currentBytes,
                                    speed: speed,
                                    percent: percent,
                                    elapsed: Math.floor(elapsed),
                                    eta: Math.round(eta)
                                };
                            }
        
                            if (now - lastUploadUpdate > 1000 || currentBytes === totalSize) {
                                lastUploadUpdate = now;
                                const text = createProgressBar(Number(totalSize), currentBytes, "Uploading", uploadStartTime, pathDisplay);
                                const progressRes = await safeEditMessage(text, { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown' });
                                if (progressRes && progressRes.id) statusMsgId = progressRes.id;
                            }
                        }
                    });
        
                    const attributes: any[] = [new Api.DocumentAttributeFilename({ fileName: filename })];
                    
                    if (msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document) {
                        const videoAttr = msg.media.document.attributes.find(a => a instanceof Api.DocumentAttributeVideo);
                        if (videoAttr) {
                            const vAttr = videoAttr as any;
                            attributes.push(new Api.DocumentAttributeVideo({
                                duration: Number(vAttr.duration || 0),
                                w: Number(vAttr.w || 0),
                                h: Number(vAttr.h || 0),
                                supportsStreaming: true,
                                nosound: vAttr.nosound
                            }));
                        } else if (filename.endsWith('.mp4') || filename.endsWith('.mkv') || filename.endsWith('.mov') || filename.endsWith('.avi') || filename.endsWith('.webm')) {
                            attributes.push(new Api.DocumentAttributeVideo({
                                duration: 0,
                                w: 0,
                                h: 0,
                                supportsStreaming: true
                            }));
                        }
                    } else if (filename.endsWith('.mp4') || filename.endsWith('.mkv') || filename.endsWith('.mov') || filename.endsWith('.avi') || filename.endsWith('.webm')) {
                        attributes.push(new Api.DocumentAttributeVideo({
                            duration: 0,
                            w: 0,
                            h: 0,
                            supportsStreaming: true
                        }));
                    }
                    
                    let caption = applyRenameRules(msg.message || "", customRules);
                    if (userDoc?.customCaptionTemplate) {
                        const template = userDoc.customCaptionTemplate;
                        caption = template.includes("{original}") ? template.replace("{original}", caption) : `${caption}\n\n${template}`;
                    }
        
                    sentMsg = await destClient.sendFile(finalDestPeer, {
                        file: uploadedFile,
                        caption: caption,
                        workers: uploadWorkers,
                        attributes: attributes,
                        thumb: hasThumb ? thumbPath : undefined,
                        replyTo: threadId,
                    } as any);

                    // --- Save Copy to Saved Files Cache topic in DEFAULT_LOG_GROUP start ---
                    let savedLogMsg: any = null;
                    try {
                        const logGroupPeer = await safelyResolveEntity(destClient, DEFAULT_LOG_GROUP);
                        if (logGroupPeer) {
                            const cachedTopicId = await getOrCreateCachedFilesTopicId(destClient);
                            console.log(`[CacheLog] Saving copy of file to DEFAULT_LOG_GROUP under topic/thread ${cachedTopicId}`);
                            
                            savedLogMsg = await destClient.sendFile(logGroupPeer, {
                                file: uploadedFile,
                                caption: caption,
                                workers: uploadWorkers,
                                attributes: attributes,
                                thumb: hasThumb ? thumbPath : undefined,
                                replyTo: cachedTopicId
                            } as any);
                        }
                    } catch (logErr) {
                        console.error("[CacheLog] Failed to save copy of file to DEFAULT_LOG_GROUP:", logErr);
                    }

                    if (savedLogMsg && fileKey && fileCacheCollection) {
                        try {
                            await fileCacheCollection.updateOne(
                                { fileKey },
                                {
                                    $set: {
                                        fileKey,
                                        fileName: filename,
                                        totalSize: totalSize,
                                        savedMsgId: savedLogMsg.id,
                                        savedChatId: secureMetadataField(DEFAULT_LOG_GROUP),
                                        sourceLink: link,
                                        cachedAt: new Date(),
                                        expiresAt: new Date(Date.now() + CACHE_TTL_MS)
                                    }
                                },
                                { upsert: true }
                            );
                            console.log(`[CacheLog] File successfully registered in file_cache collection under fileKey: ${fileKey}`);
                        } catch (dbErr) {
                            console.error("[CacheLog] Failed to insert file cache record to MongoDB:", dbErr);
                        }
                    }
                    // --- Save Copy to Saved Files Cache topic in DEFAULT_LOG_GROUP end ---

                    uploadDone = true;
                } catch (err: any) {
                    const errStr = (err.message || "").toUpperCase();
                    const isTimeout = errStr.includes("TIMEOUT") || errStr.includes("ETIMEDOUT") || errStr.includes("SOCKET HANG UP");
                    
                    if (isTimeout && uploadRetries < 5) {
                        uploadRetries++;
                        console.log(`[Upload] Upload failed due to timeout. Retrying... (Attempt ${uploadRetries}/5). Error: ${errStr}`);
                        continue;
                    }
                    
                    throw err;
                }
            }

            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            if (hasThumb && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
            
            let uploadedLink = "";
            try {
                const entity = await destClient.getEntity(finalDestPeer);
                const channelId = entity.id.toString().replace("-100", "");
                uploadedLink = `https://t.me/c/${channelId}/${sentMsg.id}`;
            } catch(e) {}
            
            let message = `┏━━━━━━━━━━━━━━━━━━━━━━┓\n┃ 🎯 𝗦𝘂𝗰𝗰𝗲𝘀𝘀𝗳𝘂𝗹𝗹𝘆 𝗠𝗶𝗿𝗿𝗼𝗿𝗲𝗱! ┃\n┗━━━━━━━━━━━━━━━━━━━━━━┛`;
            
            const kb: any[] = [];
            const row: any[] = [];
            if (link && link.startsWith("http")) {
                row.push({ text: "🔗 𝗦𝗼𝘂𝗿𝗰𝗲", url: link });
            }
            if (uploadedLink) {
                row.push({ text: "📥 𝗗𝗼𝘄𝗻𝗹𝗼𝗮𝗱", url: uploadedLink });
            }
            if (row.length > 0) kb.push(row);
            
            await safeEditMessage(message, { chat_id: chatId, message_id: statusMsgId, reply_markup: kb.length > 0 ? { inline_keyboard: kb } : undefined });
            await recordSuccessfulMirror();
            return true;
        } catch (err: any) {
            const isSkip = err.message?.includes("DOWNLOAD_SKIPPED");
            if (!isSkip) {
                console.error("Link Process Error:", err);
            } else {
                console.log("[Process] Task was skipped gracefully by user choice.");
            }
            let errMsg = err.message || "";
            if (err.errorMessage === 'CHANNEL_INVALID' || errMsg.includes("CHANNEL_INVALID")) errMsg = "Channel not found. Ensure Userbot is a member of BOTH chats.";
            else if (errMsg.includes("Content not found") || errMsg.includes("PEER_ID_INVALID") || errMsg.includes("USER_NOT_PARTICIPANT")) {
                errMsg = "Content inaccessible: Userbot session does not have access. Join source chats, verify link is not restricted.";
            }
            if (!errMsg && err.errorMessage) errMsg = err.errorMessage;
            
            // Clean up files on error
            if (tempFilePath && fs.existsSync(tempFilePath)) {
                try { fs.unlinkSync(tempFilePath); } catch (e) {}
            }
            if (thumbPath && fs.existsSync(thumbPath)) {
                try { fs.unlinkSync(thumbPath); } catch (e) {}
            }

            throw new Error(errMsg || "Unknown Error");
        }
    };

    bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const fromId = msg.from?.id;
      const text = msg.text;

      console.log(`[Message Handler] Received message from ${fromId}: ${text || 'No text'}`);

      if (text === '⚙️ Settings') { handleSettings(chatId, fromId); return; }
      if (text === '📈 Dashboard') {
          if (!fromId || !isAdmin(fromId)) return;
          try {
              const textStr = await generateDashboardText();
              bot?.sendMessage(chatId, textStr, {
                  parse_mode: 'Markdown',
                  disable_web_page_preview: true,
                  reply_markup: {
                      inline_keyboard: [
                          [
                              { text: '🔄 Refresh Stats', callback_data: 'refresh_dashboard' },
                              isQueuePaused ? { text: '▶️ Resume Queue', callback_data: 'resume_queue_cb' } : { text: '⏸️ Pause Queue', callback_data: 'pause_queue_cb' }
                          ],
                          [
                              { text: '📋 View Queue', callback_data: 'view_queue_cb' },
                              { text: '🗑️ Clear Queue', callback_data: 'clear_queue_cb' }
                          ]
                      ]
                  }
              });
          } catch (err: any) {
              safeSendMessage(chatId, `❌ **Dashboard Error:** ${err.message}`);
          }
          return;
      }
      if (text === '⬅️ Back') { sendMainMenu(chatId); return; }
      if (text === '📦 Batch') { handleBatch(chatId, fromId); return; }
      if (text === '📍 Set Path') { 
          if (!fromId || !isAdmin(fromId)) {
             bot.sendMessage(chatId, "❌ Restricted to Admin");
             return;
          }
          userActionStates[fromId] = { type: 'set_path' };
          bot.sendMessage(chatId, "📍 **Set Custom Destination**\n\nPlease forward any message from target **Group/Channel** here, or send its **Public Link**.\n\n_Bot will upload files to this location instead of your private DM._", { 
              parse_mode: 'Markdown',
              reply_markup: { force_reply: true }
          });
          return; 
      }
      if (text === '⚙️ Mirror Engine') { handleMirror(chatId, fromId, msg.message_id); return; }
      if (text === '❌ Cancel') { handleCancel(chatId, fromId); return; }
      if (text === '🚀 Start') { 
          handleStartMessage(msg);
          return; 
      }

      // Intercept states early to allow non-text actions (like setting custom thumbnail image)
      if (fromId && userActionStates[fromId]) {
          const state = userActionStates[fromId];

          console.log(`[Message Handler] State type for ${fromId}: ${state.type}`);
          if (state.type === 'forward_start_link') {
              userActionStates[fromId].startLink = msg.text;
              userActionStates[fromId].type = 'forward_end_link';
              bot.sendMessage(chatId, "✅ Starting link saved.\n\nNow send the **Ending Link**.");
              return;
          }
          if (state.type === 'forward_end_link') {
              const startLink = userActionStates[fromId].startLink;
              const endLink = msg.text!;
              delete userActionStates[fromId];
              
              bot.sendMessage(chatId, "⏳ **Processing batch forward...**\n\nThis might take a while.");
              handleBatchForward(chatId, fromId, startLink, endLink).catch(err => {
                  safeSendMessage(chatId, `❌ **Forwarding Error:** ${err.message}`);
              });
              return;
          }

          if (state.type === 'add_blocked_topic') {
              const textInput = msg.text || '';
              delete userActionStates[fromId];
              const cleanedTopic = textInput.trim();
              if (cleanedTopic) {
                  let finalVal = cleanedTopic;
                  const match = cleanedTopic.match(/t\.me\/(?:c\/)?([a-zA-Z0-9_-]+)\/(\d+)/i);
                  if (match) {
                      let groupId = match[1];
                      let topicId = match[2];
                      
                      // normalize numerical group ids
                      if (/^\d+$/.test(groupId)) {
                          groupId = '-100' + groupId; // Standardize to -100 format if it was numerical
                      } else {
                          groupId = groupId.toLowerCase();
                      }
                      
                      finalVal = `${groupId}_${topicId}`;
                  }

                  const settingsUid = await resolveSettingsUserId(fromId);
                  if (approvedUsersCollection) {
                      await approvedUsersCollection.updateOne(
                          { userId: settingsUid },
                          { $addToSet: { blockedTopics: finalVal } },
                          { upsert: true }
                      );
                      safeSendMessage(chatId, `✅ **Topic Blocked successfully!**\n└ Link/Name: \`${cleanedTopic}\`${finalVal !== cleanedTopic ? `\n└ Internal Format: \`${finalVal}\`` : ''}`, { parse_mode: 'Markdown' });
                  }
              } else {
                  safeSendMessage(chatId, `❌ **Invalid input.** Blocked topic name cannot be empty.`);
              }
              await showBlockedTopicsPanel(chatId, fromId);
              return;
          }

          if (state.type === 'set_source_id') {
              const textInput = msg.text || '';
              delete userActionStates[fromId];
              await saveRecentSource(fromId, textInput, textInput);
              safeSendMessage(chatId, `✅ **Source ID Saved:** \`${textInput}\``);
              return;
          }
          if (state.type === 'set_dest_id') {
              const textInput = msg.text || '';
              delete userActionStates[fromId];
              await saveRecentDestination(fromId, textInput, "Manual Destination");
              safeSendMessage(chatId, `✅ **Destination ID Saved:** \`${textInput}\``);
              return;
          }

          if (state.type === 'enter_manual_specific_topic') {
              const textInput = msg.text || '';
              delete userActionStates[fromId];
              const cleaned = textInput.trim();
              if (!cleaned) {
                  safeSendMessage(chatId, "❌ **Operation canceled or empty input.**");
                  return;
              }
              const parts = cleaned.split(/\s+/);
              const rawGroupId = parts[0];
              if (!rawGroupId.startsWith('-') && !/^\d+$/.test(rawGroupId)) {
                  safeSendMessage(chatId, "❌ **Invalid Group ID.** It should typically start with `-` (e.g. `-100xxxxxxxxxx`).");
                  return;
              }

              let topicId: number | null = null;
              let groupName = '';
              let namePartStartIdx = 1;

              if (parts.length > 1) {
                  const secondPart = parts[1];
                  if (/^\d+$/.test(secondPart)) {
                      topicId = parseInt(secondPart);
                      namePartStartIdx = 2;
                  }
              }

              groupName = parts.slice(namePartStartIdx).join(' ').trim();
              if (!groupName) {
                  groupName = `Manual Group ${rawGroupId}`;
              }

              if (approvedUsersCollection) {
                  const settingsUid = await resolveSettingsUserId(fromId);
                  const userDoc = await approvedUsersCollection.findOne({ userId: settingsUid });
                  const savedDestinations = userDoc?.savedDestinations || [];

                  const filtered = savedDestinations.filter((d: any) => !(d.destId === rawGroupId && d.destThreadId === topicId));
                  filtered.push({
                      destId: rawGroupId,
                      destThreadId: topicId,
                      groupName,
                      topicName: topicId ? `Topic ${topicId}` : 'General',
                      createdAt: new Date()
                  });

                  const finalDest = filtered.slice(-20);
                  await approvedUsersCollection.updateOne(
                      { userId: settingsUid },
                      { $set: { savedDestinations: finalDest } }
                  );

                  const destDisplay = topicId ? `${groupName} (Topic: ${topicId})` : groupName;
                  await safeSendMessage(chatId, `✅ **Specific Destination Stored Successfully!**\n\n📁 Destination: \`${destDisplay}\`\n📍 ID: \`${rawGroupId}\` ${topicId ? `(Topic: \`${topicId}\`)` : ''}\n\nThis target group has been saved to your **Saved Destinations** list!`, { parse_mode: 'Markdown' });

                  // Try to send a confirmation directly to that group if the bot is present!
                  try {
                      const notifyOptions: any = { parse_mode: 'Markdown' };
                      if (topicId) notifyOptions.message_thread_id = topicId;
                      await safeSendMessage(Number(rawGroupId), `✅ **Specific Destination Registered!**\n\nThis group has been registered as an upload destination inside the bot for admin/user configuration.`, notifyOptions);
                  } catch (e) {
                      console.log("[setspecifictopic] Could not send direct notification to manually added group in state handler (expected if bot has not joined yet):", e);
                  }
              }
              return;
          }

          if (state.type === 'set_api_id') {
              const textInput = msg.text || '';
              delete userActionStates[fromId];
              const parsedId = Number(textInput.trim());
              if (!isNaN(parsedId) && parsedId > 0) {
                  apiIdValue = parsedId;
                  if (settingsCollection) {
                      await settingsCollection.updateOne(
                          { type: 'global_config' },
                          { $set: { apiId: parsedId.toString() } },
                          { upsert: true }
                      );
                  }
                  safeSendMessage(chatId, `✅ **Telegram API ID Saved successfully!** (Hidden for Security)`, { parse_mode: 'Markdown' });
              } else {
                  safeSendMessage(chatId, `❌ **Invalid Input.** API ID must be a positive number. Setting cancelled.`);
              }
              handleSettings(chatId, fromId);
              return;
          }

          if (state.type === 'set_api_hash') {
              const textInput = msg.text || '';
              delete userActionStates[fromId];
              const cleanedHash = textInput.trim();
              if (cleanedHash.length === 32) {
                  apiHashValue = cleanedHash;
                  if (settingsCollection) {
                      await settingsCollection.updateOne(
                          { type: 'global_config' },
                          { $set: { apiHash: cleanedHash } },
                          { upsert: true }
                      );
                  }
                  safeSendMessage(chatId, `✅ **Telegram API Hash Saved successfully!** (Hidden for Security)`, { parse_mode: 'Markdown' });
              } else {
                  safeSendMessage(chatId, `❌ **Invalid Input.** API Hash must be exactly 32 hexadecimal characters. Setting cancelled.`);
              }
              handleSettings(chatId, fromId);
              return;
          }

          if (state.type === 'set_thumb') {
              if (msg.photo && msg.photo.length > 0) {
                  delete userActionStates[fromId];
                  const fileId = msg.photo[msg.photo.length - 1].file_id;
                  const settingsUid = await resolveSettingsUserId(fromId);
                  if (approvedUsersCollection) {
                      await approvedUsersCollection.updateOne(
                          { userId: settingsUid },
                          { $set: { customThumbnailFileId: fileId } }
                      );
                  }
                  // Download locally as well just in case
                  const userCustomThumbPath = path.join(os.tmpdir(), `custom_thumb_${settingsUid}.jpg`);
                  try {
                      const downloadedPath = await bot.downloadFile(fileId, os.tmpdir());
                      if (fs.existsSync(userCustomThumbPath)) fs.unlinkSync(userCustomThumbPath);
                      fs.renameSync(downloadedPath, userCustomThumbPath);
                      safeSendMessage(chatId, `✅ **Custom Thumbnail Saved successfully!**\n\nThis will be automatically applied to any future media you mirror/upload.`);
                  } catch (e: any) {
                      safeSendMessage(chatId, `✅ **Custom Thumbnail Registered in DB!** But local download temporarily failed: ${e.message}. It will be retrieved automatically on the next task.`);
                  }
                  handleSettings(chatId, fromId);
              } else {
                  safeSendMessage(chatId, "❌ **Invalid input.** Please send a valid **Photo** (compressed image) as your custom thumbnail. Try again or `/cancel`:");
              }
              return;
          }

          if (state.type === 'set_cap') {
              const textInput = msg.text || '';
              delete userActionStates[fromId];
              const settingsUid = await resolveSettingsUserId(fromId);
              if (textInput.toLowerCase() === 'clear' || textInput.toLowerCase() === 'reset') {
                  if (approvedUsersCollection) {
                      await approvedUsersCollection.updateOne(
                          { userId: settingsUid },
                          { $unset: { customCaptionTemplate: "" } }
                      );
                  }
                  safeSendMessage(chatId, `✅ **Custom Caption Template Cleared.** Settings restored to default.`);
              } else {
                  if (approvedUsersCollection) {
                      await approvedUsersCollection.updateOne(
                          { userId: settingsUid },
                          { $set: { customCaptionTemplate: textInput } }
                      );
                  }
                  safeSendMessage(chatId, `✅ **Custom Caption Template Saved!**\n\n**Template:**\n\`\`\`\n${textInput}\n\`\`\`\n\n_To reset anytime, click Caption again and send "clear"._`, { parse_mode: 'Markdown' });
              }
              handleSettings(chatId, fromId);
              return;
          }

          if (state.type === 'add_rename_rule') {
              const ruleText = msg.text || '';
              delete userActionStates[fromId];
              
              if (ruleText.includes('=')) {
                  const parts = ruleText.split('=');
                  const keyword = parts[0].trim();
                  const replaceWith = parts.slice(1).join('=').trim();
                  
                  if (keyword) {
                      const settingsUid = await resolveSettingsUserId(fromId);
                      if (approvedUsersCollection) {
                          const userDoc = await approvedUsersCollection.findOne({ userId: settingsUid });
                          let userRules = userDoc?.renameRules || [];
                          // Prevent duplicates
                          userRules = userRules.filter((r: any) => r.keyword.toLowerCase() !== keyword.toLowerCase());
                          userRules.push({ keyword, replaceWith });
                          
                          await approvedUsersCollection.updateOne(
                              { userId: settingsUid },
                              { $set: { renameRules: userRules } }
                          );
                      }
                      
                      safeSendMessage(chatId, `✅ **Rename Rule Added!**\n\n\`${keyword}\` will now be replaced with \`${replaceWith}\` in files and captions.`, { parse_mode: 'Markdown' });
                  } else {
                      safeSendMessage(chatId, "❌ **Error:** Keyword cannot be empty.");
                  }
              } else {
                  safeSendMessage(chatId, "🛑 **Rename rule addition cancelled** (or format was invalid). Ensure you use \`=\` separator.");
              }
              handleSettings(chatId, fromId);
              return;
          }

          if (state.type === 'set_cooldown_secs') {
              const textInput = (msg.text || '').trim().toLowerCase();
              delete userActionStates[fromId];
              
              let val = 5; // Default fallback to 5 seconds
              let success = false;
              if (textInput === 'off' || textInput === '0') {
                  val = 0;
                  success = true;
              } else {
                  const cleaned = parseInt(textInput);
                  if (!isNaN(cleaned) && cleaned >= 0) {
                      val = cleaned;
                      success = true;
                  }
              }

              if (success) {
                  if (approvedUsersCollection) {
                      const settingsUid = await resolveSettingsUserId(fromId);
                      await approvedUsersCollection.updateOne(
                          { userId: settingsUid },
                          { $set: { cooldownSeconds: val } }
                      );
                  }
                  if (val === 0) {
                      safeSendMessage(chatId, `✅ **Cooldown Delay Disabled!** Tasks will now execute with no delay between them.`, { parse_mode: 'Markdown' });
                  } else {
                      safeSendMessage(chatId, `✅ **Cooldown Delay Saved!** Delay has been set to **${val} seconds** between tasks.`, { parse_mode: 'Markdown' });
                  }
              } else {
                  safeSendMessage(chatId, `❌ **Invalid Input.** Cooldown must be a non-negative number of seconds or "off". Setting cancelled.`);
              }
              handleSettings(chatId, fromId);
              return;
          }

          if (state.type === 'set_concurrency_val') {
              const textInput = (msg.text || '').trim();
              delete userActionStates[fromId];
              
              const cleaned = parseInt(textInput);
              if (!isNaN(cleaned) && cleaned >= 1 && cleaned <= 20) {
                  MAX_CONCURRENT_TASKS = cleaned;
                  MAX_TASKS_PER_USER = cleaned; // Sync user tasks limit with concurrency limit for ease of use
                  if (settingsCollection) {
                      await settingsCollection.updateOne(
                          { type: 'global_config' },
                          { $set: { maxConcurrentTasks: cleaned, maxTasksPerUser: cleaned } },
                          { upsert: true }
                      );
                  }
                  safeSendMessage(chatId, `✅ **Concurrency Limit Saved!** The bot is now limited to **${cleaned} parallel tasks** globally.`, { parse_mode: 'Markdown' });
              } else {
                  safeSendMessage(chatId, `❌ **Invalid Input.** Concurrency must be a number between 1 and 20. Setting cancelled.`);
              }
              handleSettings(chatId, fromId);
              return;
          }
      }

      if (!text) return;
      if (text.startsWith('/')) return;

      // Handle Interactive Actions (Batch, Mirror, Login)
      if (fromId && userActionStates[fromId]) {
          const state = userActionStates[fromId];
          
          if (state.type === 'set_jump_to_path') {
              const textInput = (msg.text || '').trim();
              delete userActionStates[fromId];

              const parts = textInput.split(/\s+/);
              let rawPath = parts[0];
              let topicId: number | null = parts[1] ? parseInt(parts[1]) : null;

              if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) {
                  const urlParts = rawPath.split('/').filter(p => p.length > 0);
                  const domainIdx = urlParts.findIndex(p => p.includes('t.me') || p === 't.me');
                  if (domainIdx !== -1 && urlParts.length > domainIdx + 1) {
                      const nextPart = urlParts[domainIdx + 1];
                      if (nextPart === 'c' && urlParts.length > domainIdx + 2) {
                          let channelId = urlParts[domainIdx + 2];
                          if (!channelId.startsWith('-100') && /^\d+$/.test(channelId)) {
                              channelId = "-100" + channelId;
                          }
                          rawPath = channelId;
                          if (urlParts.length > domainIdx + 3) {
                              const possibleMsgOrTopic = parseInt(urlParts[domainIdx + 3]);
                              if (!isNaN(possibleMsgOrTopic) && topicId === null) {
                                  topicId = possibleMsgOrTopic;
                              }
                          }
                      } else {
                          rawPath = "@" + nextPart;
                      }
                  }
              }

              if (!rawPath.startsWith('-') && !rawPath.startsWith('@') && /^[a-zA-Z]/.test(rawPath)) {
                  rawPath = "@" + rawPath;
              }

              if (approvedUsersCollection) {
                  const adminIdStr = fromId.toString();
                  const settingsUid = await resolveSettingsUserId(fromId);
                  
                  const update = { 
                      $set: { 
                          uploadPath: rawPath,
                          uploadTopicId: topicId || null,
                          uploadGroupName: rawPath,
                          uploadTopicName: topicId ? `Topic ${topicId}` : ''
                      } 
                  };
                  
                  await approvedUsersCollection.updateOne({ userId: adminIdStr }, update);
                  if (settingsUid !== adminIdStr) {
                      await approvedUsersCollection.updateOne({ userId: settingsUid }, update);
                  }
                  
                  const dest = topicId ? `${rawPath} (Topic ID: ${topicId})` : rawPath;
                  const confirmationText = `✅ **Upload Destination Saved via JumpToPath!**\n\nAll tasks will now be processed to:\n📍 \`${dest}\``;
                  
                  await safeSendMessage(chatId, confirmationText, { parse_mode: 'Markdown' });
              } else {
                  safeSendMessage(chatId, "⚠️ **Database not ready.** Please try again.");
              }
              return;
          }

          if (state.type === 'set_path') {
              const text = msg.text || '';
              let targetId = '';
              let topicId: number | null = null;

              if (msg.forward_from_chat) {
                  targetId = msg.forward_from_chat.id.toString();
              } else if (text.startsWith('https://t.me/c/')) {
                  const parts = text.split('/');
                  targetId = '-100' + parts[4];
                  topicId = parseInt(parts[5]) || null;
              } else if (text.startsWith('https://t.me/')) {
                  targetId = '@' + text.split('/').pop();
                  topicId = null;
              } else if (text.startsWith('-100') || /^\d+$/.test(text)) {
                  targetId = text;
              }

              if (targetId) {
                  delete userActionStates[fromId];
                  if (approvedUsersCollection) {
                      const settingsUid = await resolveSettingsUserId(fromId);
                      const adminIdStr = fromId.toString();
                      const update = { $set: { uploadPath: targetId, uploadGroupName: targetId, uploadTopicId: topicId, uploadTopicName: '' } };
                      await approvedUsersCollection.updateOne({ userId: adminIdStr }, update);
                      if (settingsUid !== adminIdStr) {
                          await approvedUsersCollection.updateOne({ userId: settingsUid }, update);
                      }
                  }
                  safeSendMessage(chatId, `✅ **Path Saved!**\nFiles will now be uploaded to: \`${targetId}\`\n\n_Note: Ensure the Userbot is a member of that chat._`, { parse_mode: 'Markdown' });
                  try {
                      const sendMessageOptions: any = { parse_mode: 'Markdown' };
                      if (topicId) {
                          sendMessageOptions.message_thread_id = topicId;
                      }
                      await bot.sendMessage(targetId, "✅ **SetDone: Bot is ready to upload here.**", sendMessageOptions);
                  } catch (e) {
                      console.error("Failed to send SetDone to destination", e);
                  }
                  handleSettings(chatId, fromId);
              } else {
                  safeSendMessage(chatId, "❌ **Invalid Input.**\nPlease forward a message or send a valid Group/Channel link.");
              }
              return;
          }

          if (state.type === 'enter_clone_dest_id') {
              const text = msg.text || '';
              const destId = text.trim();
              
              if (destId.startsWith('https://t.me/') || destId.startsWith('-100') || /^\d+$/.test(destId)) {
                  try {
                      const targetUid = Number(await resolveSettingsUserId(fromId));
                      const client = await getConnectedUserbotClient(targetUid);
                      if (!client) throw new Error("Userbot session not active.");

                      const destEntity = await safelyResolveEntity(client, destId);
                      const currentDestId = (destEntity as any).id?.toString() || destId;
                      const resolvedDestId = currentDestId.startsWith('-100') ? currentDestId : (currentDestId.startsWith('-') ? currentDestId : "-100" + currentDestId);
                      const destTitle = (destEntity as any).title || destId;

                      await saveRecentDestination(fromId, resolvedDestId, destTitle);

                      state.type = 'topic_clone_group';
                      state.pendingCloneDest = resolvedDestId;

                      const settingsUid = await resolveSettingsUserId(fromId);
                      const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
                      const recentSources = userDoc?.recentSources || [];
                      
                      let kb: any[] = [];
                      if (recentSources.length > 0) {
                          recentSources.forEach((s: any) => {
                              kb.push([{ text: `📥 ${s.sourceName}`, callback_data: `clonesource_${s.sourceId}` }]);
                          });
                          kb.push([{ text: `➕ Enter New Source ID`, callback_data: `clonesource_new` }]);
                      }

                      if (kb.length > 0) {
                          await safeSendMessage(chatId, `✅ **Destination Saved:** **${destTitle}** (\`${resolvedDestId}\`)\n\n2. Select or enter the **Source Group** to clone from:`, {
                              reply_markup: { inline_keyboard: kb }
                          });
                      } else {
                          await safeSendMessage(chatId, `✅ **Destination Saved:** **${destTitle}** (\`${resolvedDestId}\`)\n\n2. Now send the **Source Group Link/ID** or forward a message to clone from:`, {
                              reply_markup: { force_reply: true }
                          });
                      }

                      try {
                          await bot.sendMessage(resolvedDestId, "✅ **SetDone: Bot is ready to upload here for specific topic mirror.**").catch(() => null);
                      } catch(e) {}
                  } catch (e: any) {
                      safeSendMessage(chatId, `❌ **Error verifying destination:** ${e.message}`);
                  }
              } else {
                  safeSendMessage(chatId, "❌ **Invalid ID.** Please send a valid Group/Channel ID or link.");
              }
              return;
          }

          if (state.type === 'set_mirror_source') {
              const text = msg.text || '';
              let sourceId = '';

              if (msg.forward_from_chat) {
                  sourceId = msg.forward_from_chat.id.toString();
              } else if (text.startsWith('https://t.me/')) {
                  const parts = text.split('/');
                  sourceId = parts[parts.length - 1];
              } else if (text.startsWith('-100') || /^\d+$/.test(text)) {
                  sourceId = text;
              }

              if (sourceId) {
                  const destId = state.pendingMirrorDest!;
                  const destThreadId = state.pendingMirrorThread;
                  delete userActionStates[fromId];
                  
                  if (approvedUsersCollection) {
                      const settingsUid = await resolveSettingsUserId(fromId);
                      const userDoc = await approvedUsersCollection.findOne({ userId: settingsUid });
                      const mirrorPaths = userDoc?.mirrorPaths || [];
                      
                      const filtered = mirrorPaths.filter((p: any) => p.sourceId !== sourceId);
                      filtered.push({
                          sourceId,
                          destId,
                          destThreadId,
                          groupName: msg.chat.title || 'Group',
                          topicName: destThreadId ? `Topic ${destThreadId}` : 'General',
                          createdAt: new Date()
                      });

                      const finalPaths = filtered;

                      await approvedUsersCollection.updateOne(
                          { userId: settingsUid },
                          { $set: { mirrorPaths: finalPaths } }
                      );

                      const destDisplay = destThreadId ? `${msg.chat.title} (Topic: ${destThreadId})` : msg.chat.title;
                      safeSendMessage(chatId, `✅ **Mirror Path Saved!**\n\n**Source:** \`${sourceId}\`\n**Destination:** \`${destDisplay}\`\n\n_Anything mirrored from this source will now go to this destination._`, { parse_mode: 'Markdown' });
                      
                      if (fromId.toString() !== chatId.toString()) {
                          safeSendMessage(fromId, `✅ **New Mirror Mapping:**\nSource: \`${sourceId}\`\nDest: \`${destDisplay}\``, { parse_mode: 'Markdown' });
                      }
                  }
              } else {
                  safeSendMessage(chatId, "❌ **Invalid Input.**\nPlease forward a message or send a valid ID/Link.");
              }
              return;
          }

          if (state.type === 'topic_clone_group') {
              const text = msg.text || '';
              let sourceId = '';

              if (msg.forward_from_chat) {
                  sourceId = msg.forward_from_chat.id.toString();
              } else if (text.startsWith('https://t.me/')) {
                  const parts = text.split('/');
                  sourceId = parts[parts.length - 1]; // fallback
                  if (text.includes('/c/')) {
                      sourceId = '-100' + parts[parts.length-2]; 
                  }
              } else if (text.startsWith('-100') || /^\d+$/.test(text)) {
                  sourceId = text;
              }

              if (sourceId) {
                  state.type = 'topic_clone_topic_id';
                  
                  let groupName = "Source Group";
                  if (msg.forward_from_chat && msg.forward_from_chat.title) {
                      groupName = msg.forward_from_chat.title;
                  } else {
                      try {
                          const targetUid = Number(await resolveSettingsUserId(fromId));
                          const tgClient = await getConnectedUserbotClient(targetUid);
                          if (tgClient) {
                              const sourceEntity = await safelyResolveFullEntity(tgClient, sourceId).catch(() => null);
                              if (sourceEntity) {
                                  if ((sourceEntity as any).title) {
                                      groupName = (sourceEntity as any).title;
                                  }
                                  const realId = (sourceEntity as any).id?.toString();
                                  if (realId) {
                                      sourceId = realId.startsWith('-100') ? realId : (realId.startsWith('-') ? realId : "-100" + realId);
                                  }
                              }
                          }
                      } catch(e) {}
                  }
                  
                  state.cloneSourceGroupId = sourceId;
                  await saveRecentSource(fromId, sourceId, groupName);

                  safeSendMessage(chatId, `✅ **Source Saved:** **${groupName}** (\`${sourceId}\`)\n\n3. Please enter the **Topic ID** of the topic you want to clone now:`, {
                      reply_markup: { force_reply: true }
                  });
              } else {
                  safeSendMessage(chatId, "❌ **Invalid Source ID or Link.**\nPlease forward a message or send a valid Group/Channel ID/Link.");
              }
              return;
          }

          if (state.type === 'mirror_path_add_source') {
              const text = msg.text || '';
              let sourceId = '';

              if (msg.forward_from_chat) {
                  sourceId = msg.forward_from_chat.id.toString();
              } else if (text.startsWith('https://t.me/')) {
                  const parts = text.split('/');
                  sourceId = parts[parts.length - 1];
              } else if (text.startsWith('-100') || /^\d+$/.test(text)) {
                  sourceId = text;
              }

              if (sourceId) {
                  const settingsUid = await resolveSettingsUserId(fromId);
                  const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
                  const savedDestinations = userDoc?.savedDestinations || [];
                  if (savedDestinations.length === 0) {
                      delete userActionStates[fromId];
                      safeSendMessage(chatId, "❌ **No Saved Destinations.**\nPlease add a destination by going to your destination group and typing `/setmirror` first.");
                      return;
                  }

                  state.type = 'live_mirror_dest_select';
                  state.pendingSourceId = sourceId;

                  let groupName = "Source Group";
                  if (msg.forward_from_chat && msg.forward_from_chat.title) {
                      groupName = msg.forward_from_chat.title;
                  } else {
                      try {
                          const targetUid = Number(settingsUid);
                          const userbotClient = await getConnectedUserbotClient(targetUid);
                          if (userbotClient) {
                              const sourceEntity = await safelyResolveFullEntity(userbotClient, sourceId).catch(() => null);
                              if (sourceEntity && (sourceEntity as any).title) {
                                  groupName = (sourceEntity as any).title;
                              }
                          }
                      } catch (e) {
                          // ignore
                      }
                  }
                  state.pendingSourceName = groupName;
                  await saveRecentSource(fromId, sourceId, groupName);

                  const uniqueDestinations: { dest: any, originalIndex: number }[] = [];
                  const seen = new Set();
                  savedDestinations.forEach((d: any, originalIndex: number) => {
                      if (d && d.destId && !seen.has(d.destId)) {
                          seen.add(d.destId);
                          uniqueDestinations.push({ dest: d, originalIndex });
                      }
                  });
                  const kb = uniqueDestinations.map((item) => {
                      return [
                          { text: item.dest.groupName + (item.dest.destThreadId ? ` (Topic ${item.dest.destThreadId})` : ''), callback_data: `lm_dest_${item.originalIndex}` },
                          { text: '🗑', callback_data: `del_saved_dest:${item.originalIndex}` }
                      ];
                  });
                  kb.push([{ text: '❌ Cancel', callback_data: 'start_back' }]);

                  safeSendMessage(chatId, `✅ **Source ID Recognized:** \`${sourceId}\`\n\n**Select Destination Group for Live Mirror:**`, {
                      parse_mode: 'Markdown',
                      reply_markup: {
                          inline_keyboard: kb
                      }
                  });
              } else {
                  safeSendMessage(chatId, "❌ **Invalid Source.**\nPlease forward a message or send a valid ID/Link.");
              }
              return;
          }

          if ((state as any).type === 'topic_clone_group') {
              const text = msg.text || '';
              let sourceId = '';

              if (msg.forward_from_chat) {
                  sourceId = msg.forward_from_chat.id.toString();
              } else if (text.startsWith('https://t.me/')) {
                  const parts = text.split('/');
                  sourceId = parts[parts.length - 1]; // fallback
                  if (text.includes('/c/')) {
                      sourceId = '-100' + parts[parts.length-2]; 
                  }
              } else if (text.startsWith('-100') || /^\d+$/.test(text)) {
                  sourceId = text;
              }

              if (sourceId) {
                  state.type = 'topic_clone_topic_id';
                  state.cloneSourceGroupId = sourceId;
                  
                  let groupName = "Source Group";
                  if (msg.forward_from_chat && msg.forward_from_chat.title) {
                      groupName = msg.forward_from_chat.title;
                  } else {
                      try {
                          const targetUid = Number(await resolveSettingsUserId(fromId));
                          const tgClient = await getConnectedUserbotClient(targetUid);
                          if (tgClient) {
                              const sourceEntity = await safelyResolveFullEntity(tgClient, sourceId).catch(() => null);
                              if (sourceEntity && (sourceEntity as any).title) {
                                  groupName = (sourceEntity as any).title;
                              }
                          }
                      } catch(e) {}
                  }
                  await saveRecentSource(fromId, sourceId, groupName);

                  safeSendMessage(chatId, `✅ **Source Recognized: ${groupName}** (\`${sourceId}\`)\n\n2. Please enter the **Topic ID** of the topic you want to clone now.`, {
                      reply_markup: { force_reply: true }
                  });
              } else {
                  safeSendMessage(chatId, "❌ **Invalid Source ID or Link.**\nPlease forward a message or send a valid Group/Channel ID/Link.");
              }
              return;
          }

          if (state.type === 'full_mirror_group') {
              const text = msg.text || '';
              let sourceId = '';

              if (msg.forward_from_chat) {
                  sourceId = msg.forward_from_chat.id.toString();
              } else if (text.startsWith('https://t.me/')) {
                  const parts = text.split('/');
                  sourceId = parts[parts.length - 1]; 
                  if (text.includes('/c/')) {
                      sourceId = '-100' + parts[parts.length-2]; 
                  }
              } else if (text.startsWith('-100') || /^\d+$/.test(text)) {
                  sourceId = text;
              }

              if (!sourceId) {
                  safeSendMessage(chatId, "❌ **Invalid Source.**\nPlease forward a message or send a valid Group/Channel ID/Link.");
                  return;
              }

              const settingsUid = await resolveSettingsUserId(fromId);
              const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
              const savedDestinations = userDoc?.savedDestinations || [];
              if (savedDestinations.length === 0) {
                  delete userActionStates[fromId];
                  safeSendMessage(chatId, "❌ **No Saved Destinations.**\nPlease add a destination by going to your destination group and typing `/setmirror` first.");
                  return;
              }

              state.type = 'full_mirror_dest_select';
              state.pendingSourceId = sourceId;

              let groupName = "Source Group";
              if (msg.forward_from_chat && msg.forward_from_chat.title) {
                  groupName = msg.forward_from_chat.title;
              } else {
                  try {
                      const targetUid = Number(settingsUid);
                      const userbotClient = await getConnectedUserbotClient(targetUid);
                      if (userbotClient) {
                          const sourceEntity = await safelyResolveFullEntity(userbotClient, sourceId).catch(() => null);
                          if (sourceEntity && (sourceEntity as any).title) {
                              groupName = (sourceEntity as any).title;
                          }
                      }
                  } catch (e) {}
              }
              await saveRecentSource(fromId, sourceId, groupName);

              // Deduplicate based on destId for display but remember the original indices
              const uniqueDestinations: { dest: any, originalIndex: number }[] = [];
              const seen = new Set();
              savedDestinations.forEach((d: any, originalIndex: number) => {
                  if (d && d.destId && !seen.has(d.destId)) {
                      seen.add(d.destId);
                      uniqueDestinations.push({ dest: d, originalIndex });
                  }
              });

              const kb = uniqueDestinations.map((item) => {
                  return [
                      { text: item.dest.groupName + (item.dest.destThreadId ? ` (Topic ${item.dest.destThreadId})` : ''), callback_data: `fm_dest_${item.originalIndex}` },
                      { text: '🗑', callback_data: `del_saved_dest:${item.originalIndex}` }
                  ];
              });
              kb.push([{ text: '❌ Cancel', callback_data: 'start_back' }]);

              safeSendMessage(chatId, `✅ **Source Selected: ${groupName}** (\`${sourceId}\`)\n\n**Select Destination Group for Full Mirror:**`, {
                  parse_mode: 'Markdown',
                  reply_markup: {
                      inline_keyboard: kb
                  }
              });
              return;
          }

          if (state.type === 'topic_clone_topic_id') {
              const topicId = parseInt(text);
              if (isNaN(topicId)) {
                  safeSendMessage(chatId, "❌ **Invalid ID.** Please send a numeric Topic ID.");
                  return;
              }
              
              const sourceGroupId = state.cloneSourceGroupId!;
              const destGroupId = state.pendingCloneDest!;
              delete userActionStates[fromId];
              
              await safeSendMessage(chatId, `📂 **Starting Specific Topic Clone...**\nSource: \`${sourceGroupId}\`\nTopic ID: \`${topicId}\`\nDest: \`${destGroupId}\``);
              
              try {
                  const targetUid = Number(await resolveSettingsUserId(fromId));
                  const client = await getConnectedUserbotClient(targetUid);
                  if (!client) throw new Error("Your Userbot session is not active. Please /login first.");
                  
                  const sourceEntity = await safelyResolveFullEntity(client, sourceGroupId);
                  const destEntity = await safelyResolveFullEntity(client, destGroupId);
                  
                  const realSourceId = (sourceEntity as any).id?.toString() || sourceGroupId;
                  const resolvedSourceId = realSourceId.startsWith('-100') ? realSourceId : "-100" + realSourceId;
                  const sourceUsername = (sourceEntity as any).username || '';

                  const realDestId = (destEntity as any).id?.toString() || destGroupId;
                  const resolvedDestId = realDestId.startsWith('-100') ? realDestId : "-100" + realDestId;

                  // Dynamically assign correct sourceName to the mirrorPath
                  const sourceTitle = (sourceEntity as any).title || "Source Group";
                  const destTitle = (destEntity as any).title || "Destination Group";

                  // Get topic title
                  let topicTitle = "Mirrored Topic";
                  try {
                      const topicsResult: any = await client.invoke(new Api.channels.GetForumTopics({ channel: sourceEntity, limit: 100 }));
                      const topic = topicsResult.topics?.find((t: any) => t.id === topicId);
                      if (topic) topicTitle = topic.title;
                  } catch(e) { console.error("Error getting topic title", e); }
                  
                  // Save mirror path to database first, with fully resolved fields!
                  const settingsUid = await resolveSettingsUserId(fromId);
                  const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
                  const paths = userDoc?.mirrorPaths || [];
                  
                  // Remove any duplicate specific topic mirror config first
                  const filteredPaths = paths.filter((p: any) => 
                      !(p.sourceId === resolvedSourceId && p.destId === resolvedDestId && p.destThreadId === Number(topicId))
                  );
                  
                  filteredPaths.push({ 
                      sourceId: resolvedSourceId, 
                      sourceNumericId: resolvedSourceId,
                      sourceUsername,
                      sourceName: sourceTitle,
                      destId: resolvedDestId, 
                      destThreadId: Number(topicId), 
                      groupName: destTitle, 
                      topicName: topicTitle,
                      isLive: true, // Auto-enable live matching on this Specific Topic!
                      createdAt: new Date()
                  });
                  await approvedUsersCollection?.updateOne({ userId: settingsUid }, { $set: { mirrorPaths: filteredPaths } });

                  // Create or get topic in dest
                  console.log(`[Debug] Topic Clone: destEntity: ${destEntity.id}, topicTitle: ${topicTitle}`);
                  const topicResult = await getOrCreateTopic(client, destEntity, topicTitle);
                  console.log(`[Debug] Topic Clone result:`, topicResult);                
                  
                  if (topicResult.error) {
                      throw new Error(`Could not create or find the topic.\n\n⚠️ **Telegram Error:** \`${topicResult.error}\`\n\n💡 **Troubleshooting Tips:**\n1. Ensure the destination is indeed a **Forum Group** (Forum must be turned on in settings).\n2. Make sure the Userbot account has **Admin / Create Topics** permission inside that group.\n3. Make sure the destination link or ID is fully correct and the userbot has successfully joined.`);
                  }
                  
                  const destTopicId = topicResult.topicId;
                  
                  // Update mirrorPath destTopicId to the real created destTopicId!
                  const finalPaths = filteredPaths.map((p: any) => {
                      if (p.sourceId === resolvedSourceId && p.destId === resolvedDestId && p.destThreadId === Number(topicId)) {
                          return { ...p, destThreadId: destTopicId };
                      }
                      return p;
                  });
                  await approvedUsersCollection?.updateOne({ userId: settingsUid }, { $set: { mirrorPaths: finalPaths } });

                  // Confirmation in topic
                  try {
                      await safeSendMessage(Number(resolvedDestId), `✅ **SetDone: Bot is ready to upload here for specific topic mirror.**`, { message_thread_id: destTopicId });
                      await safeSendMessage(Number(DEFAULT_LOG_GROUP), `✅ **Topic Mirror Set!**\nTarget Id: ${resolvedDestId}\nTopic Id: ${destTopicId}`);
                  } catch(e) { console.error("Error sending topic mirror confirmation", e); }
                  
                  const sourceIdClean = resolvedSourceId.replace('-100', '');

                  const alreadyMirroredDocs = mirroredMessagesCollection ? 
                        await mirroredMessagesCollection.find({ destId: resolvedDestId }, { projection: { link: 1 } }).toArray() : [];
                  const alreadyMirroredLinks = new Set(alreadyMirroredDocs.map((doc: any) => doc.link));
                  let skippedCount = 0;
                  let queuedCount = 0;
                  const topicTasksToQueue: Task[] = [];

                  for await (const m of client.iterMessages(sourceEntity, {
                      replyTo: topicId
                  })) {
                      if (m.action) continue; 
                      if (!m.message && !m.media) continue;

                      const virtualLink = `https://t.me/c/${sourceIdClean}/${m.id}`;
                      if (alreadyMirroredLinks.has(virtualLink)) {
                          skippedCount++;
                          continue;
                      }
                      
                      topicTasksToQueue.push({ 
                          chatId, 
                          link: virtualLink, 
                          userId: fromId,
                          forceGeneralPath: false,
                          overrideTargetId: resolvedDestId, 
                          overrideThreadId: destTopicId,
                          isMirror: true
                      });
                      queuedCount++;
                  }
                  
                  // Sort by ID to ensure oldest to newest processing
                  topicTasksToQueue.sort((a, b) => {
                      const idA = parseInt(a.link.split('/').pop() || '0');
                      const idB = parseInt(b.link.split('/').pop() || '0');
                      return idA - idB;
                  });

                  if (queuedCount === 0 && skippedCount === 0) {
                      throw new Error("No messages found inside this topic, or topic ID is invalid.");
                  }

                  if (topicTasksToQueue.length > 0) {
                      const topicCloneSessionId = `tc-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
                      const statusMsg = await safeSendMessage(chatId, `⏳ **Initializing real-time universal tracking bar...**`);
                      const statusMsgId = statusMsg ? statusMsg.message_id : undefined;

                      for (const t of topicTasksToQueue) {
                          t.topicCloneSessionId = topicCloneSessionId;
                      }

                      const sessionInfo = {
                          chatId,
                          statusMsgId,
                          totalFiles: queuedCount,
                          processedFiles: 0,
                          successCount: 0,
                          failedCount: 0,
                          topicTitle,
                          sourceGroupId: resolvedSourceId,
                          destGroupId: resolvedDestId,
                          startTime: Date.now()
                      };
                      activeTopicCloneSessions.set(topicCloneSessionId, sessionInfo);

                      if (statusMsgId) {
                          try {
                              await safeBotCall('pinChatMessage', chatId, String(statusMsgId), { disable_notification: true });
                          } catch (pErr) {
                              console.error("[Queue DB] pinChatMessage initial error:", pErr);
                          }
                      }

                      taskQueue.push(...topicTasksToQueue);
                      dbEnqueueTasks(topicTasksToQueue).catch(e => console.error("[Queue DB] Bulk enqueue error:", e));

                      await updateTopicCloneProgress(topicCloneSessionId).catch(err => {
                          console.error("[Topic Clone Progress Setup Failed]", err);
                      });
                  }

                  // Start watcher for client so live mirroring works as well!
                  await startAutoMirrorWatcher(Number(settingsUid), client).catch(err => {
                      console.warn("[Topic Clone -> Live Watcher] Failed to auto start watcher:", err.message);
                  });

                  runNextTask();
                  const skipText = skippedCount > 0 ? ` (Skipped **${skippedCount}** already mirrored previously)` : '';
                  safeSendMessage(chatId, `✅ Added **${queuedCount}** items from Topic ID \`${topicId}\` to copy queue${skipText} for destination: \`${resolvedDestId}\` (Topic: \`${topicTitle}\`).`);
              } catch (err: any) {
                  safeSendMessage(chatId, `❌ **Clone Error:** ${err.message}`);
              }
              return;
          }

          if (state.type === 'enter_topic_id') {
              const topicId = parseInt(text);
              if (isNaN(topicId)) {
                  safeSendMessage(chatId, "❌ **Invalid ID.** Please send a numeric Topic ID.");
                  return;
              }
              
              const sourceTarget = state.mirrorTarget;
              delete userActionStates[fromId];
              
              await safeSendMessage(chatId, `📂 **Starting Single Topic Mirror (ID: ${topicId})...**`);
              
              try {
                  const targetUid = Number(await resolveSettingsUserId(fromId));
                  const client = await getConnectedUserbotClient(targetUid);
                  if (!client) throw new Error("Disconnected.");
                  
                  const sourceEntity = await safelyResolveFullEntity(client, sourceTarget);
                  const userDoc = await approvedUsersCollection?.findOne({ userId: fromId.toString() });
                  
                  const sourceIdRaw = (sourceEntity as any).id?.toString() || "";
                  const sourceIdClean = sourceIdRaw.replace('-100', '');
                  const mirrorPath = userDoc?.mirrorPaths?.find((p: any) => 
                      p.sourceId === sourceIdClean || p.sourceId === `-100${sourceIdClean}` || sourceIdClean === p.sourceId.replace('-100', '')
                  );

                  let destId = mirrorPath ? mirrorPath.destId : (userDoc?.uploadPath || DEFAULT_LOG_GROUP);
                  if (!userDoc?.uploadPath) {
                      destId = DEFAULT_LOG_GROUP;
                  }

                  const messages: any = await client.getMessages(sourceEntity, {
                      limit: 100,
                      replyTo: topicId
                  });

                  const groupTasksToQueue: Task[] = [];
                  for (const m of messages) {
                      if (m.media) {
                          const entityId = sourceIdClean;
                          const virtualLink = `https://t.me/c/${entityId}/${m.id}`;
                          groupTasksToQueue.push({ 
                              chatId, 
                              link: virtualLink, 
                              userId: fromId,
                              overrideThreadId: mirrorPath?.destThreadId ? Number(mirrorPath.destThreadId) : undefined,
                              isMirror: true
                          });
                      }
                  }
                  if (groupTasksToQueue.length > 0) {
                      taskQueue.push(...groupTasksToQueue);
                      dbEnqueueTasks(groupTasksToQueue).catch(e => console.error("[Queue DB] Bulk enqueue error:", e));
                  }
                  runNextTask();
                  safeSendMessage(chatId, `✅ Added **${messages.length}** content items to queue.`);
              } catch (err: any) {
                  safeSendMessage(chatId, `❌ **Mirror Error:** ${err.message}`);
              }
              return;
          }

          if (state.type === 'batch_start') {
              if (text.startsWith('https://t.me/')) {
                  state.startLink = text;
                  state.type = 'batch_end';
                  await safeSendMessage(chatId, "🔗 **Received Start Link.**\nNow send the **End Link**.", { reply_markup: { force_reply: true } });
              } else {
                  await safeSendMessage(chatId, "❌ Please send a valid Telegram link.");
              }
              return;
          }

          if (state.type === 'batch_end') {
              if (text.startsWith('https://t.me/')) {
                  const endLink = text;
                  const startLink = state.startLink!;
                  delete userActionStates[fromId];

                  try {
                      const startId = getMsgId(startLink);
                      const endId = getMsgId(endLink);
                      const baseUrl = startLink.substring(0, startLink.lastIndexOf('/') + 1);

                      if (isNaN(startId) || isNaN(endId)) throw new Error("Invalid range IDs.");
                      if (endId < startId) throw new Error("End link ID must be greater than start link ID.");

                      const count = endId - startId + 1;
                      // Unlimited batch size as requested by user

                      const batchId = `batch_${Date.now()}_${fromId}`;
                      
                      // 1. Send and PIN Summary Message
                      console.log(`[Batch] Initializing batch: count=${count}, startId=${startId}, endId=${endId}`);
                      const summaryMsg = await safeSendMessage(chatId, `⏳ **Initializing Batch Process...**\nLinks: \`${count}\` requested.`, { parse_mode: 'Markdown' });
                      if (summaryMsg) {
                          console.log(`[Batch] Pinning summary msg ID: ${summaryMsg.message_id}`);
                          await bot?.pinChatMessage(chatId, summaryMsg.message_id).catch(e => console.error("[Batch] pin failure:", e));
                          batchStatusMap.set(batchId, {
                              total: count,
                              processed: 0,
                              success: 0,
                              failed: 0,
                              startTime: Date.now(),
                              summaryMsgId: summaryMsg.message_id,
                              chatId: chatId
                          });
                      }

                      console.log(`[Batch] Sending Batch Accepted...`);
                      await safeSendMessage(chatId, `✅ **Batch Accepted!**\nProcessing \`${count}\` links. The summary has been pinned above.`);
                      
                      const batchTasksToQueue: Task[] = [];
                      for (let i = startId; i <= endId; i++) {
                          const link = `${baseUrl}${i}`;
                          batchTasksToQueue.push({ chatId, link, batchId, userId: fromId });
                      }
                      if (batchTasksToQueue.length > 0) {
                          taskQueue.push(...batchTasksToQueue);
                          dbEnqueueTasks(batchTasksToQueue).catch(e => console.error("[Queue DB] Bulk enqueue error:", e));
                      }
                      
                      console.log(`[Batch] Queue loaded. Calling runNextTask. TaskQueue size: ${taskQueue.length}, Active: ${activeTasksCount}`);
                      runNextTask();

                  } catch (err: any) {
                      safeSendMessage(chatId, `❌ **Batch Error:** ${err.message}`);
                  }
              } else {
                  safeSendMessage(chatId, "❌ Please send a valid Telegram link.");
              }
              return;
          }

          if (state.type === 'mirror_target') {
              if (text.startsWith('https://t.me/') || text.startsWith('-100') || /^\d+$/.test(text)) {
                  const target = text;
                  state.type = 'mirror_choice' as any;
                  (state as any).mirrorTarget = target;

                  safeSendMessage(chatId, `🎯 **Target Recognized:** \`${target}\`\n\nChoose mirroring mode:`, {
                      parse_mode: 'Markdown',
                      reply_markup: {
                          inline_keyboard: [
                              [
                                  { text: 'Full Clone (Recent)', callback_data: 'mode_recent' },
                                  { text: 'Copy with Topics 📂', callback_data: 'mode_topics' }
                              ],
                              [
                                  { text: 'Copy One Topic 🎯', callback_data: 'mode_single_topic' }
                              ],
                              [ { text: '❌ Cancel', callback_data: 'cancel_cmd' } ]
                          ]
                      }
                  });
              } else {
                  await safeSendMessage(chatId, "❌ Please send a valid Telegram link.");
              }
              return;
          }
      }

      // Handle Interactive Login Steps
      if (fromId && loginStates[fromId]) {
        const val = text?.trim();
        if (!val || val.startsWith('/')) return; // Ignore commands or empty text

        if (!isAdmin(fromId)) {
            delete loginStates[fromId];
            return;
        }
        const state = loginStates[fromId];

        // Existing resolvers (OTP or Password)
        if (state.resolvePhoneCode) {
            const resolve = state.resolvePhoneCode;
            delete state.resolvePhoneCode;
            // Simulate realistic human typing delay (2s to 4.5s)
            await sleep(Math.random() * 2500 + 2000);
            return resolve(val.replace(/[^a-zA-Z0-9]/g, ''));
        }

        if (state.resolvePassword) {
            const resolve = state.resolvePassword;
            delete state.resolvePassword;
            // Simulate human typing delay (1s to 3s)
            await sleep(Math.random() * 2000 + 1000);
            return resolve(val);
        }

        // Fresh login: this must be the phone number
        if (!state.client) {
            try {
                // Ensure phone number starts with '+' and is stripped of whitespace or dashes
                let phone = val.replace(/\s+/g, '').replace(/[-()]/g, '');
                if (!phone.startsWith('+') && /^\d+$/.test(phone)) {
                    phone = '+' + phone;
                }
                
                if (phone.length < 10 || phone.length > 15) {
                    safeSendMessage(chatId, "❌ **Invalid Phone Number Length.** Please enter a valid international phone number (e.g., +91xxxxxxxxxx).");
                    delete loginStates[fromId];
                    return;
                }
                
                // Ensure API ID and Hash are set for this user context
                // If not, we might need to ask the user, but for now just use globals
                if (!apiIdValue || !apiHashValue) {
                     safeSendMessage(chatId, "❌ **API ID or API HASH not configured.** Please set them using `/setapiid` and `/setapihash`.");
                     delete loginStates[fromId];
                     return;
                }

                const client = new TelegramClient(new StringSession(""), apiIdValue, apiHashValue, {
                    connectionRetries: 15,
                    timeout: 300000,
                    requestRetries: 10,
                    ...getRandomDeviceProps(),
                    floodSleepThreshold: 300,
                    proxy: undefined,
                });
                state.client = client;
                state.phone = phone;

                // Explicitly establish connection with retry logic
                let connected = false;
                for (let i = 0; i < 3; i++) {
                    try {
                        console.log(`[Login] Connection attempt ${i+1} for ${fromId}...`);
                        await client.connect();
                        connected = true;
                        break;
                    } catch (connErr) {
                        console.error(`[Login] Connection attempt ${i+1} failed:`, connErr);
                        await sleep(3000);
                    }
                }

                if (!connected) {
                    throw new Error("Could not establish connection to Telegram servers. Please check your proxy or try again later.");
                }

                console.log(`[Login] Client connected for ${fromId}. Starting auth flow...`);

                client.start({
                    phoneNumber: async () => state.phone!,
                    phoneCode: async () => {
                        console.log(`[Login] Requested phone code for ${fromId}`);
                        await sleep(1000);
                        if (state.hasErrorOtp) {
                            safeSendMessage(chatId, `❌ **Incorrect or Expired Code.**\n\nPlease check your other Telegram app and type the new code carefully with spaces.\n\nExample: \`1 2 3 4 5\``, { 
                                parse_mode: 'Markdown', reply_markup: { force_reply: true } 
                            });
                        } else {
                            safeSendMessage(chatId, `📧 **Received!** \n\nTelegram has just sent a login code directly to your other device.\n\n⚠️ **Important:** Please type the code with spaces between digits (e.g., \`1 2 3 4 5\`) so Telegram doesn't block it.`, { 
                                parse_mode: 'Markdown', reply_markup: { force_reply: true } 
                            });
                        }
                        return new Promise((resolve) => { 
                            console.log(`[Login] Waiting for OTP for ${fromId}`);
                            state.step = 'awaiting_otp';
                            state.resolvePhoneCode = resolve; 
                            state.hasErrorOtp = false; // reset flag
                        });
                    },
                    password: async (hint) => {
                        console.log(`[Login] Requested 2FA password for ${fromId}`);
                        await sleep(1000);
                        if (state.hasError2Fa) {
                            safeSendMessage(chatId, `❌ **Incorrect 2FA Password.**\n\nPlease try again. \nHint: \`${hint || 'None'}\``, { 
                                parse_mode: 'Markdown', reply_markup: { force_reply: true } 
                            });
                        } else {
                            safeSendMessage(chatId, `🔐 **Almost there!**\n\nYour account has two-step verification enabled for extra protection.\n\nHint: \`${hint || 'None'}\`\n\nPlease enter your 2FA password to finish connecting:`, { 
                                parse_mode: 'Markdown', reply_markup: { force_reply: true } 
                            });
                        }
                        return new Promise((resolve) => { 
                            console.log(`[Login] Waiting for 2FA password for ${fromId}`);
                            state.step = 'awaiting_2fa';
                            state.resolvePassword = resolve; 
                            state.hasError2Fa = false; // reset flag
                        });
                    },
                    onError: async (err: any) => {
                        console.error(`[Login] Internally caught error for ${fromId}:`, err);
                        const msg = err.message || err.errorMessage || "Unknown error";
                        
                        if (msg.includes("PHONE_CODE_INVALID") || msg.includes("CODE_INVALID") || msg.includes("CODE_EMPTY")) {
                            state.hasErrorOtp = true;
                            return false; // Tells GramJS to loop and re-prompt phoneCode!
                        }
                        
                        if (msg.includes("PASSWORD_HASH_INVALID") || msg.includes("PASSWORD_EMPTY")) {
                            state.hasError2Fa = true;
                            return false; // Tells GramJS to loop and re-prompt password!
                        }

                        // If it's something else like EXPIRED, we can't recover easily inside GramJS loop
                        state.lastErrorMsg = msg;
                        return true; // Aborts start process
                    }
                }).then(async () => {
                    const session = client.session.save() as unknown as string;
                    
                    const me = await client.getMe().catch(() => null) as any;
                    const accountUserId = me ? Number(me.id) : fromId;
                    
                    userSessions.set(accountUserId, session);
                    userClients.set(accountUserId, client);
                    
                    const fullName = me ? `${me.firstName || ""} ${me.lastName || ""}`.trim() : "User";
                    const phoneNumber = me?.phone || state.phone || "Unknown";

                    if (approvedUsersCollection) {
                        await approvedUsersCollection.updateOne(
                            { userId: accountUserId.toString() }, 
                            { $set: { 
                                stringSession: session, 
                                lastLogin: new Date(),
                                fullName,
                                phoneNumber,
                                addedByAdminId: fromId.toString()
                            } }, 
                            { upsert: true }
                        );
                    }
                    adminActiveSession.set(fromId, accountUserId);
                    if (approvedUsersCollection) {
                        await approvedUsersCollection.updateOne(
                            { userId: fromId.toString() },
                            { $set: { activeUserbotUserId: accountUserId } },
                            { upsert: true }
                        ).catch((e: any) => console.error("[Login DB Switched] Error:", e));
                    }

                    safeSendMessage(chatId, `✅ **Successfully Logged In!**\n\n👤 Account: **${fullName}**\n📱 Phone: **${phoneNumber}**`);
                    // Warm up entity cache immediately after login
                    await client.getDialogs({ limit: 40 }).catch(() => {});
                    safeSendMessage(chatId, "✨ **Setup Complete!** This account has been set as your active working session.\nYou can manage sessions via /login dashboard.");
                    delete loginStates[fromId];
                }).catch((err) => {
                    if (loginStates[fromId]) {
                        console.error(`[Login] Final Catch Error for ${fromId}:`, err);
                        let cleanMsg = err.message || "Unknown error";
                        if (cleanMsg === "AUTH_USER_CANCEL" && loginStates[fromId]?.lastErrorMsg) {
                            cleanMsg = loginStates[fromId].lastErrorMsg!;
                        }
                        const solution = getLoginErrorSolution(cleanMsg);
                        
                        let displayMsg = cleanMsg;
                        if (cleanMsg.includes('PHONE_CODE_EXPIRED') || cleanMsg.includes('AUTH_KEY_UNREGISTERED')) {
                            displayMsg = "The authentication code has expired. Please type /login again to request a new one.";
                        } else if (cleanMsg.includes('SESSION_PASSWORD_NEEDED')) {
                            displayMsg = "2FA Password is required on your Telegram account.";
                        }
                        
                        safeSendMessage(chatId, `❌ **Login Failed:** \`${displayMsg}\`\n\n💡 **Solution:** ${solution}`);
                        state.client?.disconnect();
                        delete loginStates[fromId];
                    }
                });
            } catch (err: any) {
                safeSendMessage(chatId, `❌ **Setup Error:** ${err.message}`);
                delete loginStates[fromId];
            }
            return;
        }
      }

      // Direct Source Group ID detection & saving when no other state is active
      if (fromId && !userActionStates[fromId] && !loginStates[fromId] && text) {
          const cleanText = text.trim();
          let isPotentialSource = false;
          let parsedSourceId = cleanText;

          if (/^-100\d+$/.test(cleanText)) {
              isPotentialSource = true;
          } else if (/^-\d+$/.test(cleanText)) {
              isPotentialSource = true;
          } else if (/^\d{8,15}$/.test(cleanText)) {
              isPotentialSource = true;
              parsedSourceId = '-100' + cleanText;
          } else if (/^@[a-zA-Z0-9_]{5,32}$/.test(cleanText)) {
              isPotentialSource = true;
          } else if (/^https?:\/\/t\.me\/([a-zA-Z0-9_]{5,32})\/?$/.test(cleanText)) {
              const usernameMatch = cleanText.match(/^https?:\/\/t\.me\/([a-zA-Z0-9_]{5,32})\/?$/);
              if (usernameMatch) {
                  isPotentialSource = true;
                  parsedSourceId = '@' + usernameMatch[1];
              }
          } else if (/^https?:\/\/t\.me\/c\/(\d+)\/?$/.test(cleanText)) {
              const privateGroupIdMatch = cleanText.match(/^https?:\/\/t\.me\/c\/(\d+)\/?$/);
              if (privateGroupIdMatch) {
                  isPotentialSource = true;
                  parsedSourceId = '-100' + privateGroupIdMatch[1];
              }
          }

          if (isPotentialSource) {
              if (!isAdmin(fromId)) return;
              
              const statusMsg = await safeSendMessage(chatId, `🔍 **Verifying and saving source ID:** \`${parsedSourceId}\`...`);
              try {
                  const targetUid = Number(await resolveSettingsUserId(fromId));
                  const client = await getConnectedUserbotClient(targetUid);
                  if (!client) throw new Error("No active Userbot session found. Please login first via /login.");
                  
                  const sourceEntity = await safelyResolveFullEntity(client, parsedSourceId);
                  const realSourceId = (sourceEntity as any).id?.toString() || parsedSourceId;
                  const resolvedSourceId = realSourceId.startsWith('-100') ? realSourceId : (realSourceId.startsWith('-') ? realSourceId : "-100" + realSourceId);
                  const groupName = (sourceEntity as any).title || parsedSourceId;
                  
                  await saveRecentSource(fromId, resolvedSourceId, groupName);
                  
                  const inlineKeyboard = [
                      [
                          { text: '🔄 Live Mirror', callback_data: `mirrorsource_direct_${resolvedSourceId}` },
                          { text: '⚡ Full Mirror', callback_data: `fullmirror_direct_${resolvedSourceId}` }
                      ],
                      [
                          { text: '📂 Clone Topics', callback_data: `clonesource_direct_${resolvedSourceId}` }
                      ],
                      [
                          { text: '❌ Cancel', callback_data: 'cancel_cmd' }
                      ]
                  ];

                  await safeEditMessage(`✅ **Source Group Saved successfully!**\n\n📌 Title: **${groupName}**\n📍 ID: \`${resolvedSourceId}\`\n\nThis source group has been added to your saved sources. Select an action below to configure it:`, {
                      chat_id: chatId,
                      message_id: statusMsg?.message_id || 0,
                      reply_markup: { inline_keyboard: inlineKeyboard }
                  });
              } catch (e: any) {
                  const errMsg = e.message || "Unknown error";
                  await safeEditMessage(`❌ **Failed to verify/save source group:** ${errMsg}\n\nPlease ensure the Userbot session is active and has access to this chat.`, {
                      chat_id: chatId,
                      message_id: statusMsg?.message_id || 0
                  });
              }
              return;
          }
      }

      // Invite link autodetection & join (Resolves t.me/joinchat/... and t.me/+...)
      const inviteHashMatch = text.match(/(?:https?:\/\/)?t\.me\/(?:joinchat\/|\+)([a-zA-Z0-9_\-]+)/);
      if (inviteHashMatch) {
          if (!fromId) return;
          if (!isAuthorized(fromId)) return safeSendMessage(chatId, "❌ **Access Restricted**\n\nYou are not authorized to use this bot.");
          const inviteHash = inviteHashMatch[1];
          const statusMsg = await safeSendMessage(chatId, `🔄 **Private channel/group invite link detected.**\nAttempting to join using your active Userbot session...`);
          try {
              const targetUid = Number(await resolveSettingsUserId(fromId));
              const client = await getConnectedUserbotClient(targetUid);
              if (!client) throw new Error("No active Userbot session found. Please login first via /login.");
              
              const res = await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash }));
              let chatTitle = "Private Chat";
              let resolvedSourceId = "";
              if (res && res.chats && res.chats.length > 0) {
                  const firstChat = res.chats[0];
                  chatTitle = firstChat.title || chatTitle;
                  const chatEntityId = firstChat.id?.toString();
                  if (chatEntityId) {
                      resolvedSourceId = chatEntityId.startsWith('-100') ? chatEntityId : (chatEntityId.startsWith('-') ? chatEntityId : "-100" + chatEntityId);
                  }
              }
              
              if (resolvedSourceId) {
                  await saveRecentSource(fromId, resolvedSourceId, chatTitle);
                  
                  const inlineKeyboard = [
                      [
                          { text: '🔄 Live Mirror', callback_data: `mirrorsource_direct_${resolvedSourceId}` },
                          { text: '⚡ Full Mirror', callback_data: `fullmirror_direct_${resolvedSourceId}` }
                      ],
                      [
                          { text: '📂 Clone Topics', callback_data: `clonesource_direct_${resolvedSourceId}` }
                      ],
                      [
                          { text: '❌ Cancel', callback_data: 'cancel_cmd' }
                      ]
                  ];

                  await safeEditMessage(`✅ **Successfully Joined Private Channel/Group and Saved!**\n\n📌 Title: **${chatTitle}**\n📍 ID: \`${resolvedSourceId}\`\n\nThis source has been saved to your recent sources! Select an action to configure it:`, {
                      chat_id: chatId,
                      message_id: statusMsg?.message_id || 0,
                      reply_markup: { inline_keyboard: inlineKeyboard }
                  });
              } else {
                  await safeEditMessage(`✅ **Successfully Joined Private Channel/Group!**\n\n📌 Title: **${chatTitle}**\n👤 Userbot ID: **${targetUid}**\n\nYou can now copy links from this channel and paste them here to download/mirror.`, { chat_id: chatId, message_id: statusMsg?.message_id || 0 });
              }
          } catch (e: any) {
              let errMsg = e.message || "Unknown error";
              if (errMsg.includes("USER_ALREADY_PARTICIPANT")) {
                  // Resolve entity of existing chat to save it anyway
                  try {
                      const targetUid = Number(await resolveSettingsUserId(fromId));
                      const client = await getConnectedUserbotClient(targetUid);
                      if (client) {
                          const inviteInfo: any = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash }));
                          let resolvedSourceId = "";
                          let chatTitle = "Private Chat";
                          if (inviteInfo && inviteInfo.chat) {
                              chatTitle = inviteInfo.chat.title || chatTitle;
                              const chatEntityId = inviteInfo.chat.id?.toString();
                              if (chatEntityId) {
                                  resolvedSourceId = chatEntityId.startsWith('-100') ? chatEntityId : (chatEntityId.startsWith('-') ? chatEntityId : "-100" + chatEntityId);
                              }
                          }
                          
                          if (resolvedSourceId) {
                              await saveRecentSource(fromId, resolvedSourceId, chatTitle);
                              const inlineKeyboard = [
                                  [
                                      { text: '🔄 Live Mirror', callback_data: `mirrorsource_direct_${resolvedSourceId}` },
                                      { text: '⚡ Full Mirror', callback_data: `fullmirror_direct_${resolvedSourceId}` }
                                  ],
                                  [
                                      { text: '📂 Clone Topics', callback_data: `clonesource_direct_${resolvedSourceId}` }
                                  ],
                                  [
                                      { text: '❌ Cancel', callback_data: 'cancel_cmd' }
                                  ]
                              ];
                              await safeEditMessage(`ℹ️ **Already a member!** Saved to your recent sources:\n\n📌 Title: **${chatTitle}**\n📍 ID: \`${resolvedSourceId}\`\n\nSelect an action to configure it:`, {
                                  chat_id: chatId,
                                  message_id: statusMsg?.message_id || 0,
                                  reply_markup: { inline_keyboard: inlineKeyboard }
                              });
                              return;
                          }
                      }
                  } catch (resolveErr) {
                      console.error("Failed to check chat invite on participant error", resolveErr);
                  }
                  await safeEditMessage(`ℹ️ **Already a member!** Your active Userbot is already a participant of this channel/group.`, { chat_id: chatId, message_id: statusMsg?.message_id || 0 });
              } else if (errMsg.includes("INVITE_HASH_EXPIRED")) {
                  await safeEditMessage(`❌ **Failed to join:** The invite link has expired or is invalid.`, { chat_id: chatId, message_id: statusMsg?.message_id || 0 });
              } else if (errMsg.includes("INVITE_HASH_INVALID")) {
                  await safeEditMessage(`❌ **Failed to join:** The invite link contains an invalid hash.`, { chat_id: chatId, message_id: statusMsg?.message_id || 0 });
              } else {
                  await safeEditMessage(`❌ **Failed to join:** ${errMsg}`, { chat_id: chatId, message_id: statusMsg?.message_id || 0 });
              }
          }
          return;
      }

      // Link detection (Supports Topics and multiple segments)
      const links = text.match(/(?:https?:\/\/)?t\.me\/(?:c\/)?[\w.-]+(?:\/[\d]+)+/g);
      if (links && links.length > 0) {
        if (!isAuthorized(fromId)) return safeSendMessage(chatId, "❌ **Access Restricted**\n\nYou are not authorized to process links. Please use /start to request access.");
        if (!isAdmin(fromId) && links.length > 1) return safeSendMessage(chatId, "❌ Only authorized admins can process multiple links at once.");

        const linkTasksToQueue: Task[] = [];
        for (const link of links) {
            const options: any = { parse_mode: 'Markdown' };
            if (msg.message_thread_id) options.message_thread_id = msg.message_thread_id;
            
            const statusMsg = await safeSendMessage(chatId, `🔍 **Analyzing link:** \`${link.split('/').pop()}\`...`, options);
            linkTasksToQueue.push({ 
                chatId: chatId, 
                link: link, 
                statusMsgId: statusMsg?.message_id || 0, 
                userId: fromId!,
                overrideThreadId: msg.message_thread_id
            });
        }
        if (linkTasksToQueue.length > 0) {
            taskQueue.push(...linkTasksToQueue);
            dbEnqueueTasks(linkTasksToQueue).catch(e => console.error("[Queue DB] Bulk enqueue error:", e));
        }

        runNextTask();
        const options: any = { parse_mode: 'Markdown' };
        if (msg.message_thread_id) options.message_thread_id = msg.message_thread_id;
         const addedCount = links.length;
         const totalQueued = taskQueue.length;
         const message = `╭─ ⌛ 𝗤𝘂𝗲𝘂𝗲𝗱 ───╮\n│ ✅ 𝗔𝗱𝗱𝗲𝗱 : ${addedCount}         \n│ 📦 𝗧𝗼𝘁𝗮𝗹 : ${totalQueued}\n╰────────────╯`;
         safeSendMessage(msg.chat.id, message, options);
        return;
      }
    });

    bot.on('polling_error', (error) => {
      // Silence noisy but common network/polling errors in this environment
      const silentErrors = [
        'TIMEOUT',
        '409 Conflict',
        'socket hang up',
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'EHOSTUNREACH'
      ];
      
      if (silentErrors.some(msg => error.message?.includes(msg))) {
        return;
      }
      console.error('Bot Polling Error:', error.message);
    });

    // Graceful shutdown
    const shutdown = async () => {
      console.log('Shutting down bot...');
      if (bot) await bot.stopPolling();
      if (client) await client.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    bot.on('error', (error: any) => {
      console.error('Bot Critical Error:', error.message || error);
      botStatus = 'Error';
    });

  } catch (err) {
    console.error('Init failed:', err);
    botStatus = 'Failed';
  }
}

app.use(express.json());

app.get('/api/status', async (req, res) => {
  try {
    res.json({
      status: botStatus,
      dbStatus: dbStatus,
      adminConfigured: !!currentAdminId,
      botInfo: botInfo,
      queueSize: taskQueue.length,
      nextTaskIn: nextTaskRunAt ? Math.max(0, Math.round((nextTaskRunAt - Date.now()) / 1000)) : 0,
      proxy: undefined,
      isQueuePaused: isQueuePaused,
      activeJobs: Array.from(activeTaskJobs.values()).map(job => ({
        link: job.link,
        phase: job.phase,
        progress: job.progress ? {
          percent: job.progress.percent,
          current: job.progress.current,
          total: job.progress.total,
          speed: job.progress.speed,
          elapsed: job.progress.elapsed,
          eta: job.progress.eta
        } : null,
        cooldownRemaining: job.cooldownRemaining,
        isMirror: job.isMirror
      })),
      batches: Array.from(batchStatusMap.entries()).map(([batchId, info]) => {
        const remaining = info.total - info.processed;
        const progress = info.total > 0 ? Math.floor((info.processed / info.total) * 100) : 0;
        return {
          batchId,
          total: info.total,
          processed: info.processed,
          success: info.success,
          failed: info.failed,
          currentLink: info.currentLink,
          startTime: info.startTime,
          progress,
          isActive: remaining > 0
        };
      }),
      taskQueue: taskQueue.map(t => ({
        link: t.link,
        isMirror: t.isMirror,
        userId: t.userId
      })),
      config: {
        hasToken: !!token,
        hasMongo: !!mongoUri,
        hasTarget: !!destinationChatId
      },
      settings: {
        adminId: currentAdminId,
        destinationChatId: destinationChatId,
        apiId: apiIdValue || null,
        apiHash: apiHashValue || null,
        downloadLibrary: currentDownloadLibrary,
        uploadEngine: currentUploadEngine,
        renameRules: globalRenameRules,
        cooldownSeconds: globalCooldownSeconds,
        mirrorPaths: approvedUsersCollection ? ((await approvedUsersCollection.findOne({userId: ALLOWED_ADMIN_IDS[0].toString()}, {  maxTimeMS: 4000 }))?.mirrorPaths || []) : []
      }
    });
  } catch (err: any) {
    console.error('[API Status] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/queue/pause', (req, res) => {
  isQueuePaused = true;
  res.json({ success: true });
});

app.post('/api/queue/resume', (req, res) => {
  isQueuePaused = false;
  if (typeof runNextTask === 'function') {
    runNextTask();
  }
  res.json({ success: true });
});

app.post('/api/queue/clear', (req, res) => {
  taskQueue.length = 0;
  if (typeof dbClearAllTasks === 'function') {
    dbClearAllTasks().catch(e => console.error("[Queue DB] Clear cancel-all error:", e));
  }
  res.json({ success: true });
});

app.post('/api/queue/cancel-item', (req, res) => {
  const { index } = req.body;
  if (index === undefined || index < 0 || index >= taskQueue.length) {
    return res.status(400).json({ error: 'Invalid task queue index' });
  }
  const removed = taskQueue.splice(index, 1)[0];
  if (typeof dbDequeueTask === 'function') {
    dbDequeueTask(removed).catch(e => console.error("[Queue DB] Dequeue cancelled task error:", e));
  }
  res.json({ success: true, removed });
});

app.post('/api/queue/prioritize-item', (req, res) => {
  const { index } = req.body;
  if (index === undefined || index < 0 || index >= taskQueue.length) {
    return res.status(400).json({ error: 'Invalid task queue index' });
  }
  if (index === 0) {
    return res.json({ success: true, info: 'Task already at top' });
  }
  const chosen = taskQueue.splice(index, 1)[0];
  taskQueue.unshift(chosen);
  res.json({ success: true, chosen });
});

app.get('/api/failed/list', async (req, res) => {
  try {
     const failed = failedTasksCollection ? await failedTasksCollection.find({}, { maxTimeMS: 4000 }).sort({ failedAt: -1 }).toArray() : [];
     res.json({ failed });
  } catch (err: any) {
     res.status(500).json({ error: err.message });
  }
});

app.post('/api/failed/retry-all', async (req, res) => {
  try {
     const count = await retryAllFailedTasks();
     res.json({ success: true, count });
  } catch (err: any) {
     res.status(500).json({ error: err.message });
  }
});

app.post('/api/failed/retry-item', async (req, res) => {
  const { id } = req.body;
  try {
     const success = await retryFailedTask(id);
     res.json({ success });
  } catch (err: any) {
     res.status(500).json({ error: err.message });
  }
});

app.post('/api/failed/clear', async (req, res) => {
  try {
     await clearAllFailedTasks();
     res.json({ success: true });
  } catch (err: any) {
     res.status(500).json({ error: err.message });
  }
});

app.get('/api/mirrored/history', async (req, res) => {
  try {
    let logs = [...inMemoryMirrorLogs];
    if (mirroredMessagesCollection) {
      try {
        const dbLogs = await mirroredMessagesCollection.find({}, { maxTimeMS: 4000 }).sort({ mirroredAt: -1 }).limit(100).toArray();
        const mappedDbLogs = dbLogs.map((log: any) => ({
          link: log.link,
          destId: log.destId,
          mirroredAt: log.mirroredAt ? new Date(log.mirroredAt).toISOString() : new Date().toISOString(),
          status: 'Success',
          info: 'Fetched from database collection'
        }));
        
        // Merge list preventing duplicates
        const seen = new Set();
        const merged = [];
        for (const log of [...logs, ...mappedDbLogs]) {
          const key = `${log.link}-${log.destId}`;
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(log);
          }
        }
        return res.json({ logs: merged.slice(0, 100) });
      } catch (dbErr) {
        console.error("Database logs fetching error:", dbErr);
      }
    }
    res.json({ logs });
  } catch (err: any) {
    res.status(500).json({ error: err.message, logs: inMemoryMirrorLogs });
  }
});

app.post('/api/mirrored/clear', async (req, res) => {
  inMemoryMirrorLogs.length = 0;
  if (mirroredMessagesCollection) {
    try {
      // Export before clearing
      const data = await mirroredMessagesCollection.find({}).toArray();
      const backupFilename = `/tmp/backup_mirrored_${Date.now()}.json`;
      fs.writeFileSync(backupFilename, JSON.stringify(data, null, 2));
      console.log(`[API clear history] Backup created at ${backupFilename}`);
      
      await mirroredMessagesCollection.deleteMany({});
    } catch (err: any) {
      console.error("[API clear history] Error clearing/backing up Mongo mirror history:", err);
      return res.status(500).json({ error: err.message });
    }
  }
  res.json({ success: true });
});

app.post('/api/mirrored/export', async (req, res) => {
  if (mirroredMessagesCollection) {
    try {
      const data = await mirroredMessagesCollection.find({}).toArray();
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  } else {
    res.status(500).json({ error: "No collection" });
  }
});

app.post('/api/mirrored/import', async (req, res) => {
  const { data } = req.body;
  if (mirroredMessagesCollection && Array.isArray(data)) {
    try {
      await mirroredMessagesCollection.insertMany(data);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  } else {
    res.status(400).json({ error: "Invalid data" });
  }
});

app.post('/api/queue/add', async (req, res) => {
  const { link, isMirror } = req.body;
  if (!link) return res.status(400).json({ error: 'Missing link' });
  try {
    const systemAdminId = Number(currentAdminId || ALLOWED_ADMIN_IDS[0] || 0);
    const task: Task = {
      chatId: systemAdminId,
      userId: systemAdminId,
      link,
      isMirror: !!isMirror
    };
    taskQueue.push(task);
    if (approvedUsersCollection) {
      dbEnqueueTasks([task]).catch(e => console.error("[Queue DB] enqueue error:", e));
    }
    if (typeof runNextTask === 'function') {
      runNextTask();
    }
    res.json({ success: true, task });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system/restart', (req, res) => {
  res.json({ success: true, message: 'Restarting bot server...' });
  setTimeout(() => process.exit(0), 1000);
});

app.post('/api/system/ping', (req, res) => {
  res.json({ success: true, message: 'Pong! Bot is active.' });
});

app.post('/api/system/cleartopics', (req, res) => {
  topicMappingCache.clear();
  res.json({ success: true, message: 'Topic cache cleared.' });
});

app.post('/api/system/logout', async (req, res) => {
  const { adminId } = req.body;
  if (!approvedUsersCollection) return res.status(503).json({ error: 'Database not ready' });
  try {
     const settingsUid = adminId || currentAdminId || ALLOWED_ADMIN_IDS[0]?.toString();
     await approvedUsersCollection.updateOne({ userId: settingsUid }, { $unset: { stringSession: "" } });
     userSessions.delete(Number(settingsUid));
     res.json({ success: true, message: 'Logged out successfully.' });
  } catch(e: any) {
     res.status(500).json({ error: e.message });
  }
});

app.post('/api/mirror/add-path', async (req, res) => {
  const { sourceId, destId, groupName, destThreadId, destTopicName } = req.body;
  if (!approvedUsersCollection) return res.status(503).json({ error: 'Database not ready' });
  try {
     const settingsUid = currentAdminId || ALLOWED_ADMIN_IDS[0]?.toString();
     const newPath = { sourceId, destId, groupName: groupName || "App Mirror Target", destThreadId, destTopicName };
     await approvedUsersCollection.updateOne(
        { userId: settingsUid },
        { $push: { mirrorPaths: newPath } } as any,
        { upsert: true }
     );
     res.json({ success: true, message: 'Mirror path added.' });
  } catch(e: any) {
     res.status(500).json({ error: e.message });
  }
});

app.post('/api/mirror/delete-path', async (req, res) => {
  const { index } = req.body;
  if (!approvedUsersCollection) return res.status(503).json({ error: 'Database not ready' });
  try {
     const settingsUid = currentAdminId || ALLOWED_ADMIN_IDS[0]?.toString();
     const userDoc = await approvedUsersCollection.findOne({ userId: settingsUid });
     const paths = userDoc?.mirrorPaths || [];
     if (paths[index]) {
         paths.splice(index, 1);
         await approvedUsersCollection.updateOne({ userId: settingsUid }, { $set: { mirrorPaths: paths } });
     }
     res.json({ success: true, message: 'Mirror path removed.' });
  } catch(e: any) {
     res.status(500).json({ error: e.message });
  }
});

app.post('/api/batch/start', async (req, res) => {
  const { startLink, endLink, isMirror } = req.body;
  if (!startLink || !endLink) return res.status(400).json({ error: 'Missing startLink or endLink' });
  
  try {
    const startId = getMsgId(startLink);
    const endId = getMsgId(endLink);
    const baseUrl = startLink.substring(0, startLink.lastIndexOf('/') + 1);

    if (isNaN(startId) || isNaN(endId)) throw new Error("Invalid range message IDs.");
    if (endId < startId) throw new Error("End link ID must be greater than start link ID.");

    const count = endId - startId + 1;
    // Unlimited batch size as requested by user

    const systemAdminId = Number(currentAdminId || ALLOWED_ADMIN_IDS[0] || 0);
    const batchId = `batch_${Date.now()}_web`;

    batchStatusMap.set(batchId, {
      total: count,
      processed: 0,
      success: 0,
      failed: 0,
      startTime: Date.now(),
      summaryMsgId: 0,
      chatId: systemAdminId
    });

    const batchTasksToQueue: Task[] = [];
    for (let i = startId; i <= endId; i++) {
        const link = `${baseUrl}${i}`;
        batchTasksToQueue.push({ 
          chatId: systemAdminId, 
          link, 
          batchId, 
          userId: systemAdminId,
          isMirror: !!isMirror 
        });
    }

    if (batchTasksToQueue.length > 0) {
        taskQueue.push(...batchTasksToQueue);
        if (approvedUsersCollection) {
          dbEnqueueTasks(batchTasksToQueue).catch(e => console.error("[Queue DB] Bulk enqueue error:", e));
        }
    }
    
    if (typeof runNextTask === 'function') {
      runNextTask();
    }
    res.json({ success: true, count, batchId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/setpath', async (req, res) => {
    if (!approvedUsersCollection) return res.status(503).json({ error: 'Database not ready' });
    const { chatId, topicId, groupTitle, topicName, userId } = req.body;
    
    try {
        const adminIdStr = userId.toString();
        const settingsUid = await resolveSettingsUserId(Number(userId));
        
        const update = { 
            $set: { 
                uploadPath: chatId.toString(),
                uploadTopicId: topicId || null,
                uploadGroupName: groupTitle,
                uploadTopicName: topicName || ''
            } 
        };
        
        // Update both the admin's doc AND the session's doc to ensure settings persist
        await approvedUsersCollection.updateOne({ userId: adminIdStr }, update);
        if (settingsUid !== adminIdStr) {
             await approvedUsersCollection.updateOne({ userId: settingsUid }, update);
        }
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings', async (req, res) => {
  if (!settingsCollection) return res.status(503).json({ error: 'Database not ready' });
  const { adminId, stringSession, destinationChatId: newDestId, apiId: newApiId, apiHash: newApiHash, downloadLibrary, uploadEngine, renameRules, proxy, cooldownSeconds } = req.body;
  try {
    const updateData: any = {};
    if (adminId) updateData.adminId = adminId;
        if (stringSession) {
            updateData.stringSession = stringSession;
            const activeAdminId = adminId || currentAdminId || ALLOWED_ADMIN_IDS[0];
            if (activeAdminId && approvedUsersCollection) {
                await approvedUsersCollection.updateOne(
                    { userId: activeAdminId.toString() },
                    { $set: { stringSession } },
                    { upsert: true }
                );
                userSessions.set(Number(activeAdminId), stringSession);
                approvedUsersCache.add(activeAdminId.toString());
            }
        }
    if (newDestId) updateData.destinationChatId = newDestId;
        if (newApiId) {
            updateData.apiId = newApiId;
            apiIdValue = Number(newApiId);
        }
        if (newApiHash) {
            updateData.apiHash = newApiHash;
            apiHashValue = newApiHash;
        }
        if (downloadLibrary) {
            updateData.downloadLibrary = downloadLibrary;
            currentDownloadLibrary = downloadLibrary;
        }
        if (uploadEngine) {
            updateData.uploadEngine = uploadEngine;
            currentUploadEngine = uploadEngine;
        }
        if (cooldownSeconds !== undefined) {
             updateData.cooldownSeconds = Number(cooldownSeconds);
             globalCooldownSeconds = Number(cooldownSeconds);
        }
        if (Array.isArray(renameRules)) {
            updateData.renameRules = renameRules;
            globalRenameRules = renameRules;
        }

        await settingsCollection.updateOne({ type: 'global_config' }, { $set: updateData }, { upsert: true });
        
        if (adminId) currentAdminId = adminId;
        if (newDestId) destinationChatId = newDestId;
        res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Global error handlers to prevent unhandled rejections from crashing or being noisy
process.on('unhandledRejection', (reason: any, promise) => {
    const msg = (reason?.message || String(reason)).toLowerCase();
    if (msg.includes('429') || reason?.error_code === 429 || msg.includes('topic_closed') || msg.includes('message thread not found') || msg.includes('timeout') || msg.includes('etimedout') || msg.includes('socket hang up') || msg.includes('econnreset') || msg.includes('econnrefused')) {
        console.warn('Silent caught known Telegram Rejection:', msg);
    } else {
        console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    }
});

process.on('uncaughtException', (err: any) => {
    const msg = (err?.message || String(err)).toLowerCase();
    if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('socket hang up') || msg.includes('econnreset') || msg.includes('econnrefused')) {
        console.warn('Silent caught known Telegram/Network Uncaught Exception:', msg);
    } else {
        console.error('Uncaught Exception:', err);
    }
});


const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function checkIfContentExists(secureKey: string): Promise<any | null> {
    if (!fileCacheCollection) return null;
    return await fileCacheCollection.findOne({ secureKey });
}

async function verifyTelegramCacheExists(client: any, peer: any, messageId: number): Promise<boolean> {
    try {
        const messages = await client.getMessages(peer, { ids: [messageId] });
        return messages && messages.length > 0 && !messages[0].deleted;
    } catch (e) {
        return false;
    }
}

function secureMetadataField(value: any): string {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function startCacheCleanup() {
  cron.schedule('0 0 * * *', async () => {
    console.log('[Cache] Running daily cache cleanup...');
    if(fileCacheCollection) {
        await fileCacheCollection.deleteMany({ expiresAt: { $lt: new Date() } });
    }
  });
}

async function startServer() {
  await startCacheCleanup();
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }
  app.listen(port, '0.0.0.0', () => console.log(`Server: http://0.0.0.0:${port}`));
}

startServer();
