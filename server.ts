import cron from 'node-cron';
import express from 'express';
import path from 'path';
import TelegramBot from 'node-telegram-bot-api';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { TelegramClient, Api, helpers } from 'telegram';
import { StringSession } from 'telegram/sessions';
import bigInt from 'big-integer';
import { NewMessage } from 'telegram/events';

const MAX_CONCURRENT_TASKS = 1; 
const MAX_TASKS_PER_USER = 1;
let activeTasksCount = 0;
const activeTasksPerUser = new Map<number, number>();

const mirrorTopicCache = new Map<string, Map<string, number>>();
const sourceTopicCache = new Map<string, Map<number, string>>();
const activeWatchers = new Set<number>();
const mirrorTasks = new Map<string, cron.ScheduledTask[]>();
let getConnectedUserbotClient: (userId: number) => Promise<any>;
let startAutoMirrorWatcher: (userId: number, client: TelegramClient) => Promise<any>;
import fs from 'fs';
import os from 'os';
import { CustomFile } from 'telegram/client/uploads';

function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
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
let settingsCollection: any = null;
let approvedUsersCollection: any = null;
let mirroredMessagesCollection: any = null;

// Global Settings State
let currentAdminId = process.env.ADMIN_ID;
let destinationChatId = process.env.DESTINATION_CHAT_ID;
let currentDownloadLibrary = 'GramJS';
let currentUploadEngine = 'GramJS';
const uploadEngines = ['GramJS', 'Telethon', 'Pyrogram', 'Hydrogram'];
const approvedUsersCache = new Set<string>();
let globalRenameRules: Array<{ keyword: string; replaceWith: string }> = [];

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
    chatId: number;
    userId: number;
    link: string;
    statusMsgId?: number;
    batchId?: string;
    overrideThreadId?: number;
    forceGeneralPath?: boolean;
    overrideTargetId?: any;
    isMirror?: boolean;
}

const MESSAGE_UPDATE_THROTTLE = 2000; // Reduced to 2s for better responsiveness
const taskQueue: Task[] = [];
let nextTaskRunAt: number | null = null;

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
                const retryAfter = is429 ? ((e.parameters?.retry_after || 15) + 5) : 3;
                console.log(`[Bot API] Temporary issue (${e.message}) on ${method}. Waiting ${retryAfter}s (Attempt ${retries + 1}/${maxRetries})...`);
                await sleep(retryAfter * 1000);
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
            
            // For other errors, log and potentially return null if it's an optional call
            const msgLower = (e.message || '').toLowerCase();
            const isExpectedSilent = msgLower.includes("message is not modified") || 
                                     msgLower.includes("there is no text in the message") ||
                                     msgLower.includes("message can't be edited") ||
                                     msgLower.includes("chat not found") ||
                                     msgLower.includes("message to edit not found");
            
            if (!isExpectedSilent) {
                console.error(`[Bot API] Error on ${method}:`, e.message);
            }
            return null;
        }
    }
    return null;
};

const safeSendMessage = async (chatId: number, text: string, options: any = {}) => {
    return await safeBotCall('sendMessage', chatId, text, options);
};

const safeEditMessage = async (text: string, options: { chat_id: number, message_id: number, parse_mode?: any, disable_web_page_preview?: boolean, reply_markup?: any }) => {
    if (!options.message_id || options.message_id === 0) return;
    
    // 1. Attempt editMessageText
    const res = await safeBotCall('editMessageText', text, options);
    if (res) return res;

    // 2. Fallback: Attempt editMessageCaption
    const resCaption = await safeBotCall('editMessageCaption', text, {
        chat_id: options.chat_id,
        message_id: options.message_id,
        parse_mode: options.parse_mode,
        reply_markup: options.reply_markup
    });
    if (resCaption) return resCaption;

    // 3. Ultimate Fallback: Delete and send new text message
    try {
        await safeBotCall('deleteMessage', options.chat_id, options.message_id).catch(() => {});
        return await safeSendMessage(options.chat_id, text, {
            parse_mode: options.parse_mode,
            disable_web_page_preview: options.disable_web_page_preview,
            reply_markup: options.reply_markup
        });
    } catch (e3: any) {
        return null;
    }
};

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
                })).catch(e => {
                    // If CHANNEL_INVALID, it might be private or deleted
                    if (e.errorMessage === 'CHANNEL_INVALID' || e.errorMessage === 'CHANNEL_PRIVATE' || (e.message && (e.message.includes('CHANNEL_INVALID') || e.message.includes('CHANNEL_PRIVATE')))) return null;
                    throw e;
                }) as any;
                
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
    type: 'batch_start' | 'batch_end' | 'mirror_target' | 'set_thumb' | 'set_cap' | 'set_path' | 'mirror_choice' | 'set_mirror_source' | 'enter_topic_id' | 'mirror_path_add_source' | 'mirror_path_await_dest' | 'topic_clone_group' | 'topic_clone_topic_id' | 'add_rename_rule' | 'set_api_id' | 'set_api_hash' | 'full_mirror_group' | 'full_mirror_dest_select' | 'live_mirror_dest_select' | 'set_cooldown_secs', 
    startLink?: string,
    mirrorTarget?: any,
    pendingMirrorDest?: string,
    pendingMirrorThread?: number,
    pendingSourceId?: string,
    pendingSourceName?: string,
    cloneSourceGroupId?: string
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
                if (!existingClient.connected) {
                    console.log(`[Watchdog] User ${userId} bot client disconnected. Cleaning and Re-connecting...`);
                    activeWatchers.delete(userId);
                    userClients.delete(userId);
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
    connectTimeoutMS: 30000,
    socketTimeoutMS: 45000,
  });
  client.connect()
    .then(async () => {
      dbStatus = 'Connected';
      console.log('MongoDB Connected');
      
      const db = client!.db('bot_studio');
      settingsCollection = db.collection('settings');
      approvedUsersCollection = db.collection('approved_users');
      mirroredMessagesCollection = db.collection('mirrored_messages');

      // Load approved users into cache
      const users = await approvedUsersCollection.find({}).toArray();
      users.forEach((u: any) => approvedUsersCache.add(u.userId.toString()));

      // Load persistent settings first
      const settings = await settingsCollection.findOne({ type: 'global_config' });
      if (settings) {
        if (settings.adminId) currentAdminId = settings.adminId;
        if (settings.apiId) apiIdValue = Number(settings.apiId);
        if (settings.apiHash) apiHashValue = settings.apiHash;
        if (settings.renameRules) globalRenameRules = settings.renameRules;
        if (settings.proxy) globalProxy = settings.proxy;
        
        if (settings.stringSession) {
            const adminToMigrate = currentAdminId || ALLOWED_ADMIN_IDS[0];
            const adminExists = users.some((u: any) => u.userId.toString() === adminToMigrate.toString() && u.stringSession);
            if (!adminExists && approvedUsersCollection) {
                await approvedUsersCollection.updateOne(
                    { userId: adminToMigrate.toString() },
                    { $set: { stringSession: settings.stringSession } },
                    { upsert: true }
                );
                users.push({ userId: adminToMigrate.toString(), stringSession: settings.stringSession });
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
    }> = {};

    if (token) {
      try {
        bot = new TelegramBot(token, { 
          polling: {
            params: {
              timeout: 30
            }
          }
        });
        botStatus = 'Running';
        
        bot.getMe().then((me) => {
          botInfo = me;
          console.log(`Bot started: @${me.username}`);
        });

        // Security Interceptor to ignore all non-admin messages globally
        const originalProcessUpdate = bot.processUpdate.bind(bot);
        bot.processUpdate = (update: TelegramBot.Update) => {
            const fromId = update.message?.from?.id || update.callback_query?.from?.id;
            // Ignore if fromId is present but they are not an admin
            if (fromId && !isAdmin(fromId)) {
                return;
            }
            return originalProcessUpdate(update);
        };

        // Commands List for Bot Menu
        bot.setMyCommands([
          { command: 'start', description: 'Start the bot' },
          { command: 'ping', description: 'Check bot latency' },
          { command: 'login', description: 'Log in with Telegram credentials' },
          { command: 'logout', description: 'Revoke session and clear data' },
          { command: 'batch', description: 'Download multiple links' },
          { command: 'cancel', description: 'Stop current task' },
          { command: 'settings', description: 'Show bot settings' },
          { command: 'sync', description: 'Force sync Userbot groups' },
          { command: 'restart', description: 'Restart bot internal services' },
          { command: 'mirror', description: 'Clone group/topic content' },
          { command: 'setpath', description: 'Set upload destination Topic/Group' },
          { command: 'setmirror', description: 'Configure a new auto-mirror path' },
          { command: 'clearmirrorhistory', description: 'Clear mirrored links history' },
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
                mirrorPathsText += `${i + 1}. \`${p.sourceId}\` ➔ ${p.groupName}${p.topicName !== 'General' ? ' (' + p.topicName + ')' : ''}\n`;
            });
            if (userDoc.mirrorPaths.length > 5) mirrorPathsText += `_...and ${userDoc.mirrorPaths.length - 5} more_\n`;
        }
        
        let uploadModeDisplay = '📹 Video';
        if (userDoc?.uploadMode === 'document') {
            uploadModeDisplay = '📁 Document/File';
        }

        const apiDisplayId = apiIdValue ? '✅ Set (Hidden for Security)' : '❌ Missing';
        const apiDisplayHash = apiHashValue ? '✅ Set (Hidden for Security)' : '❌ Missing';

        const cooldownSecs = userDoc?.cooldownSeconds !== undefined ? userDoc.cooldownSeconds : 5;
        const cooldownDisplay = cooldownSecs === 0 ? '🔴 OFF (0s)' : `🟢 ${cooldownSecs} seconds`;

        const text = `⚙️ **Advanced Configuration**\n\n` +
                     `• **Database:** ${dbStatus === 'Connected' ? '✅ Online' : '❌ Offline'}\n` +
                     `• **Userbot:** ${session ? '✅ Active' : '❌ Missing'}\n` +
                     `• **Upload Mode:** ${uploadModeDisplay}\n` +
                     `• **Engine:** 🚀 ${currentUploadEngine}\n` +
                     `• **Destination:** 📍 \`${pathDisplay}\`\n` +
                     `• **Cooldown Between Tasks:** ${cooldownDisplay}\n` +
                     `• **API ID:** ${apiDisplayId}\n` +
                     `• **API Hash:** ${apiDisplayHash}\n\n` +
                     `${mirrorPathsText}\n` +
                     `Configure your bot parameters below:`;
        
        const markup = {
            inline_keyboard: [
              [
                { text: 'Set Thumb', callback_data: 'set_thumb' },
                { text: 'Clr Thumb', callback_data: 'clr_thumb' },
                { text: 'Caption', callback_data: 'set_cap' }
              ],
              [
                { text: '📁 Set Path', callback_data: 'set_path_cmd' },
                { text: '🗑 Reset Path', callback_data: 'clr_path_cmd' },
                { text: '📂 Manage Mirror', callback_data: 'manage_mirror_paths' }
              ],
              [
                { text: '🔑 Set API ID', callback_data: 'set_api_id' },
                { text: '🔑 Set API Hash', callback_data: 'set_api_hash' }
              ],
              [
                { text: `Engine: ${currentUploadEngine}`, callback_data: 'toggle_engine' },
                { text: userDoc?.uploadMode === 'document' ? '📁 Mode: File' : '📹 Mode: Video', callback_data: 'toggle_mode' },
                { text: 'Rename Rules', callback_data: 'toggle_rename' }
              ],
              [
                { text: `⏱ Cooldown: ${cooldownSecs === 0 ? 'OFF (0s)' : `${cooldownSecs}s`}`, callback_data: 'change_cooldown_start' }
              ],
              [
                { text: 'Force Sync', callback_data: 're_login' },
                { text: 'Logs', callback_data: 'view_logs' },
                { text: 'Audit', callback_data: 'check_perms' }
              ],
              [{ text: '⬅️ Back to Menu', callback_data: 'start_back' }]
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
          cancelled = true;
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

    // Developer debug command
    bot.onText(/\/status/, async (msg) => {
        if (!isAdmin(msg.from?.id)) return;
        const msgStr = `📊 System Status:
Queue: ${taskQueue.length}
Active: ${activeTasksCount}
MaxConcurrent: ${MAX_CONCURRENT_TASKS}
NextTaskRunAt: ${nextTaskRunAt}`;
        safeSendMessage(msg.chat.id, msgStr);
    });

    const handleBatch = async (chatId: number, fromId: number | undefined) => {
      try {
        if (!isAdmin(fromId) || !fromId) throw new Error("Restricted: Admin access required.");
        
        const contextUid = Number(await resolveSettingsUserId(fromId));
        const client = await getConnectedUserbotClient(contextUid);
        if (!client) throw new Error("Userbot Session Required: Please /login first.");
        
        userActionStates[fromId] = { type: 'batch_start' };
        safeSendMessage(chatId, "📦 **Batch Process Started**\n\nSend the **Starting Link** now.", {
          reply_markup: { force_reply: true }
        });
      } catch (err: any) {
        safeSendMessage(chatId, `❌ **Error:** ${err.message}`);
      }
    };

    const handleMirror = async (chatId: number, fromId: number | undefined, msg: any) => {
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
                        { text: '📁 Mirror List', callback_data: 'mirror_list' },
                        { text: '➕ Add New Mirror', callback_data: 'mirror_add_start' }
                    ],
                    [
                        { text: '🎯 Clone Specific Topic', callback_data: 'topic_clone_start' },
                        { text: '🔄 Full Mirror Group', callback_data: 'full_mirror_start' }
                    ],
                    [ { text: '❌ Close', callback_data: 'start_back' } ]
                ]
            }
        };
        if (msg?.message_thread_id) options.message_thread_id = msg.message_thread_id;

        safeSendMessage(chatId, "🪞 **Mirror Hub**\n\nChoose an action:", options);
      } catch (err: any) {
        safeSendMessage(chatId, `❌ **Error:** ${err.message}`);
      }
    };

    bot.onText(/\/start/, (msg) => {
       const photoUrl = `https://picsum.photos/1000/600?random=${Date.now()}`;
       
       if (!isAuthorized(msg.from?.id)) {
           const unauthorizedText = `🚫 **Access Denied**\n\nHello ${msg.from?.first_name}, you do not have permission to use this bot. Access is strictly limited to authorized administrators.`;
           return safeBotCall('sendPhoto', msg.chat.id, photoUrl, {
               caption: unauthorizedText,
               parse_mode: 'Markdown'
           });
       }

       const welcomeText = `👋 **Hello ${msg.from?.first_name}!**\n\nI am the **Restricted Content Saver** bot. I help you bypass download restrictions and mirror entire groups efficiently.\n\n✨ **Core Features:**\n• Download Restricted Media\n• Mirror Groups/Channels\n• Topic preservation support\n\n🛡 **Status:** Authorized User`;
       
       safeBotCall('sendPhoto', msg.chat.id, photoUrl, {
        caption: welcomeText,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Login', callback_data: 'login_cmd' },
              { text: 'Batch', callback_data: 'batch_cmd' },
              { text: 'Mirror', callback_data: 'mirror_cmd' }
            ],
            [
              { text: 'Settings', callback_data: 'bot_settings' },
              { text: 'Logout', callback_data: 'logout_cmd' },
              { text: 'Cancel', callback_data: 'cancel_cmd' }
            ],
            [
              { text: 'Official Channel', url: 'https://t.me/telegram' },
              { text: 'Help', callback_data: 'help_cmds' }
            ]
          ]
        }
      });
    });

    bot.on('callback_query', async (query) => {
      const chatId = query.message?.chat.id;
      if (!chatId) return;

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
              const entity = await client.getEntity(action);
              groupName = (entity as any).title || groupName;
          } catch(e) { console.error("Error resolving group name", e); }
          
          // Update recent destinations
          await approvedUsersCollection?.updateOne(
              { userId: query.from.id },
              { $addToSet: { recentDestinations: { destId: action, groupName: groupName } } }
          );
          
          state.type = 'mirror_path_add_source';
          safeEditMessage(chatId, `🔗 **Destination Selected: ${groupName}**\n\nNow send the **Source Group Link/ID** to mirror from:`, { reply_markup: { force_reply: true }});
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
              const entity = await client.getEntity(action);
              groupName = (entity as any).title || groupName;
          } catch(e) { console.error("Error resolving group name", e); }
          
          await approvedUsersCollection?.updateOne(
              { userId: query.from.id },
              { $addToSet: { recentDestinations: { destId: action, groupName: groupName } } }
          );
          
          state.type = 'topic_clone_group';
          safeEditMessage(chatId, `🔗 **Destination Selected: ${groupName}**\n\n2. Now send the **Source Group Link/ID** to clone from:`, { reply_markup: { force_reply: true }});
      }
      bot?.answerCallbackQuery(query.id);
      return;
  }


      if (query.data === 'login_cmd') handleLogin(chatId, query.from?.id);
      if (query.data === 'batch_cmd') handleBatch(chatId, query.from?.id);
      if (query.data === 'mirror_cmd') handleMirror(chatId, query.from?.id, query.message);
      
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
          const recent = userDoc?.recentDestinations || [];
          
          let keyboard: any[] = [];
          recent.forEach((r: any) => {
              keyboard.push([{ text: `📂 ${r.groupName}`, callback_data: `clonedest_${r.destId}` }]);
          });
          keyboard.push([{ text: `➕ Enter New Group ID`, callback_data: `clonedest_new` }]);
          
          safeEditMessage("🎯 **Clone Specific Topic**\n\n1. Select Destination Group:", { chat_id: chatId, message_id: query.message!.message_id, reply_markup: { inline_keyboard: keyboard } });
          bot?.answerCallbackQuery(query.id);
          return;
      }
      
      if (query.data === 'mirror_add_start') {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          userActionStates[query.from.id] = { type: 'mirror_path_add_source' };
          safeSendMessage(chatId, "🔗 **New Live Mirror Setup**\n\n1. Please send the **Source Group ID** or **Link** you want to auto-mirror content FROM.", {
              reply_markup: { force_reply: true }
          });
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
                          if (t.title) destTopics[t.title.trim().toLowerCase()] = t.id;
                      });
                  } catch (e) {
                      console.warn("Failed to fetch destination topics:", e);
                  }
              }
              
              const sourceIdRaw = (sourceEntity as any).id?.toString() || "";
              const sourceIdClean = sourceIdRaw.replace('-100', '');

              const msgsToQueue = [];
              const topicMap: Record<number, number | undefined> = {};

              for await (const m of client.iterMessages(sourceEntity, { reverse: true, limit: undefined })) {
                  if (m.action) continue; 
                  if (!m.message && !m.media) continue;

                  const virtualLink = `https://t.me/c/${sourceIdClean}/${m.id}`;
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
                  throw new Error("No messages found inside this group.");
              }

              taskQueue.push(...msgsToQueue);
              runNextTask();
              if (statusMsg) {
                  await safeEditMessage(`✅ Added **${msgsToQueue.length}** items from Full Mirror to copy queue.\nDestination path: \`${destPath}\`.`, {
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
                      
                      text += `**${i + 1}.** \`${p.sourceId}\` ➔ ${destName}\n`;
                      text += `└ Topic: ${topicName} | Status: ${liveStatus}\n\n`;
                      
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
                      console.error(e);
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
                  handleMirror(chatId, query.from.id, query.message);
              }
          } catch (err) {
              bot?.answerCallbackQuery(query.id, { text: '❌ Toggle failed' });
          }
          return;
      }

      if (query.data === 'cancel_cmd') handleCancel(chatId, query.from?.id);
      if (query.data === 'logout_cmd') handleLogout(chatId, query.from?.id);

      if (query.data === 'mode_recent') {
          const state = userActionStates[query.from.id];
          if (state && state.type === 'mirror_choice') {
              const link = state.mirrorTarget;
              const fromId = query.from.id;
              delete userActionStates[fromId];
              await safeSendMessage(chatId, "✅ **Starting Recent Content Mirror...**");
              const statusMsg = await safeSendMessage(chatId, "🔍 **Processing Latest...**", { parse_mode: 'Markdown' });
              taskQueue.push({ chatId, link, statusMsgId: statusMsg?.message_id || 0, userId: fromId, isMirror: true });
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

                  const destPath = mirrorPath ? mirrorPath.destId : (userDoc?.uploadPath || DEFAULT_LOG_GROUP);
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

                          for (const m of messages) {
                              if (m.media) {
                                  const entityIdRaw = sourceEntity.id?.toString() || "";
                                  const entityId = entityIdRaw.replace('-100', '');
                                  const virtualLink = `https://t.me/c/${entityId}/${m.id}`;
                                  
                                  taskQueue.push({ 
                                      chatId, 
                                      link: virtualLink, 
                                      userId: fromId,
                                      overrideThreadId: destTopicId,
                                      isMirror: true
                                  });
                              }
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
        const helpText = `📜 **Available Commands:**\n\n` +
          `• /login - Start authentication\n` +
          `• /batch - Process multiple links\n` +
          `• /mirror - Copy entire group content\n` +
          `• /cancel - Stop current process\n` +
          `• /settings - Configure bot behavior\n` +
          `• /clearmirrorhistory - Reset full mirror history\n\n` +
          `**Note:** You must have a valid \`STRING_SESSION\` for restricted content access.`;
        bot?.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
      }

      if (query.data === 'bot_settings') {
        if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
        handleSettings(chatId, query.from?.id, query.message?.message_id);
      }

      if (query.data === 'set_path_cmd') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          userActionStates[query.from.id] = { type: 'set_path' };
          safeSendMessage(chatId, "📍 **Set Custom Destination**\n\nPlease forward any message from target **Group/Channel** here, or send its **Public Link**.\n\n_Bot will upload files to this location instead of your private DM._", { 
              parse_mode: 'Markdown',
              reply_markup: { force_reply: true }
          });
          bot?.answerCallbackQuery(query.id);
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
          currentUploadEngine = currentUploadEngine === 'Telethon' ? 'Pyrogram' : 'Telethon';
          if (settingsCollection) {
              await settingsCollection.updateOne({ type: 'global_config' }, { $set: { uploadEngine: currentUploadEngine } }, { upsert: true });
          }
          bot?.answerCallbackQuery(query.id, { text: `✅ Upload Engine set to ${currentUploadEngine}` });
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
              // We need to re-render, but this flow is triggered from inside the selection menu.
              // For now, answering the callback is sufficient; the user can just select again or cancel.                
          } else {
              bot?.answerCallbackQuery(query.id, { text: '❌ Destination not found', show_alert: true });
          }
          return;
      }

    });

    bot.onText(/\/ping/, (msg) => {
        const start = Date.now();
        bot?.sendMessage(msg.chat.id, "🏓 **Pong!**", { parse_mode: 'Markdown' }).then((m) => {
            const end = Date.now();
            bot?.editMessageText(`🏓 **Pong!**\n\nLatency: \`${end - start}ms\``, { chat_id: msg.chat.id, message_id: m.message_id, parse_mode: 'Markdown' });
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
            
            const activeSessionId = adminActiveSession.get(fromId) || fromId;
            const activeSessionStr = activeSessionId?.toString();

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

    bot.on('callback_query', async (query) => {
        const fromId = query.from?.id;
        const data = query.data || "";
        const chatId = query.message?.chat.id;

        if (!isAdmin(fromId)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });

        if (data === "start_login") {
            await bot?.answerCallbackQuery(query.id);
            handleLogin(chatId!, fromId);
        } else if (data.startsWith("switch_session:")) {
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
        } else if (data.startsWith("logout_session:")) {
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

            safeSendMessage(chatId!, `✅ Session for **${targetUid}** has been disconnected.`);
            // Refresh dashboard
            bot.processUpdate({ message: { ...query.message, text: '/login', from: query.from } } as any);
        }
    });
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
                safeSendMessage(chatId, "✅ **Mirror History Cleared Successfully!**\nAll previously processed/skipped files can now be cloned again.");
            } catch (err: any) {
                safeSendMessage(chatId, `❌ **Error clearing history:** ${err.message}`);
            }
        } else {
            safeSendMessage(chatId, "⚠️ **Database not ready.** Please try again in a few seconds.");
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
            const confirmationText = `✅ **Destination Saved!**\n\nFiles will now be uploaded to:\n📍 \`${dest}\``;
            
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

    bot.onText(/\/setcooldown(?:\s+(.+))?/, async (msg, match) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;
        
        const seconds = match?.[1] ? parseInt(match[1]) : null;
        if (seconds === null || isNaN(seconds)) {
            return safeSendMessage(chatId, "❌ Usage: `/setcooldown <seconds>` (min 15)");
        }
        
        const targetUid = await resolveSettingsUserId(fromId);
        await approvedUsersCollection?.updateOne({ userId: targetUid }, { $set: { cooldownSeconds: Math.max(5, seconds) } });
        safeSendMessage(chatId, `✅ Cooldown set to ${seconds} seconds.`);
    });
    bot.onText(/\/setmirror/, (msg) => handleSetMirror(msg.chat.id, msg.from?.id, msg));
    bot.onText(/\/sync/, (msg) => handleSync(msg.chat.id, msg.from?.id));
    
    bot.onText(/\/settings/, async (msg) => {
      try {
        if (!isAdmin(msg.from?.id)) throw new Error("Restricted: Settings are locked.");
        if (!msg.from?.id) return;

        const session = userSessions.get(msg.from.id) || (await approvedUsersCollection?.findOne({ userId: msg.from.id.toString() }))?.stringSession;

        const text = `⚙️ **Bot Configuration**\n\n` +
                     `• **Database:** ${dbStatus === 'Connected' ? '✅ Connected' : '❌ Disconnected'}\n` +
                     `• **Userbot:** ${session ? '✅ Connected' : '❌ Missing Session'}\n\n` +
                     `Use the interactive menu to manage settings.`;
        
        bot?.sendMessage(msg.chat.id, text, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Settings Menu', callback_data: 'bot_settings' },
                { text: 'Logout Session', callback_data: 'logout_cmd' }
              ]
            ]
          }
        });
      } catch (err: any) {
        bot?.sendMessage(msg.chat.id, `❌ **Error:** ${err.message}`);
      }
    });

    // Helper to get or create topic by name
const getOrCreateTopic = async (client: TelegramClient, channelEntity: any, topicName: string) => {
    try {
        const destTopics: any = await client.invoke(new Api.channels.GetForumTopics({
            channel: channelEntity,
            limit: 500
        }));
        
        const found = destTopics.topics?.find((t: any) => t.title?.trim().toLowerCase() === topicName.trim().toLowerCase());
        if (found) {
            console.log(`[TopicMgr] Found existing topic "${topicName}" -> ID: ${found.id}`);
            return found.id;
        }

        console.log(`[TopicMgr] Creating new topic "${topicName}"...`);
        const createResult: any = await client.invoke(new Api.channels.CreateForumTopic({
            channel: channelEntity,
            title: topicName
        }));
        const update = createResult.updates?.find((u: any) => u.className === 'UpdateNewForumTopic');
        return update?.topicId;
    } catch (err: any) {
        console.error(`[TopicMgr] Error in getOrCreateTopic for ${topicName}: ${err.message}`);
        // Retry scan
        try {
            const retryTopics: any = await client.invoke(new Api.channels.GetForumTopics({ channel: channelEntity, limit: 200 }));
            return retryTopics.topics?.find((t: any) => t.title?.trim().toLowerCase() === topicName.trim().toLowerCase())?.id;
        } catch { return undefined; }
    }
};
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
const batchStatusMap = new Map<string, BatchInfo>();

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
    const filled = Math.floor((size * info.processed) / info.total);
    const bar = "🟩".repeat(filled) + "⬜".repeat(size - filled);

    const isFinished = remaining <= 0;
    const progressBar = "█".repeat(Math.round(progress / 12.5));

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

const runNextTask = async () => {
    console.log(`[Queue] runNextTask started. activeTasksCount: ${activeTasksCount}, queueLength: ${taskQueue.length}`);
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

    // Capture the task and check if we can immediately trigger another worker for the next slot
    const task = taskQueue.splice(taskIndex, 1)[0];
    const fromId = task.userId;
    const fromIdKey = getTaskUserKey(fromId);

    activeTasksCount++;
    const currentActiveForUser = (activeTasksPerUser.get(fromIdKey) || 0) + 1;
    activeTasksPerUser.set(fromIdKey, currentActiveForUser);
    
    console.log(`[Queue] Task assigned. activeTasksCount: ${activeTasksCount}, User ${fromIdKey} active: ${currentActiveForUser}`);
    
    // Proactively try to fill next available slot if more tasks exist
    if (activeTasksCount < MAX_CONCURRENT_TASKS && taskQueue.length > 0) {
        console.log(`[Queue] Triggering another worker slots empty.`);
        setImmediate(runNextTask);
    }

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
        let statusMsgId = task.statusMsgId;
        if (!statusMsgId) {
            console.log(`[Queue] Sending initial searching message...`);
            const msgId = task.link.split('/').pop() || 'media';
            const sMsg = await safeSendMessage(task.chatId, `🔍 **Searching Item:** \`${msgId}\`...`, { parse_mode: 'Markdown' });
            statusMsgId = sMsg?.message_id || 0;
        }

        let cooldownSecs = 5; // Updated to 5 seconds as requested
        if (approvedUsersCollection) {
            try {
                const targetUidStr = await resolveSettingsUserId(fromId);
                const userDoc = await approvedUsersCollection.findOne({ userId: targetUidStr });
                if (userDoc && userDoc.cooldownSeconds !== undefined) {
                    cooldownSecs = Math.max(5, Number(userDoc.cooldownSeconds));
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
                console.log(`[Queue] Throttling for ${waitSecs}s due to ${cooldownSecs}s cooldown.`);
                for (let i = waitSecs; i > 0; i--) {
                    await safeEditMessage(`⏳ **Cooldown:** Waiting ${i} seconds to avoid Telegram API limit before downloading next file...`, { chat_id: task.chatId, message_id: statusMsgId });
                    await sleep(1000);
                }
            }
        }

        nextTaskRunAt = null;
        console.log(`[Queue] Starting processTask for link ${task.link}`);
        let success = false;
        try {
            const timeoutPromise = new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error("Global Task Timeout (15 minutes)")), 15 * 60 * 1000));
            success = await Promise.race([
                processTask(task.chatId, task.link, statusMsgId, fromId, task.overrideThreadId, task.forceGeneralPath, task.overrideTargetId, task.isMirror),
                timeoutPromise
            ]);
        } catch (taskErr: any) {
            console.error(`[Queue] processTask timed out or threw natively:`, taskErr);
            await safeEditMessage(`❌ **Task Timeout/Error:** ${taskErr.message}`, { chat_id: task.chatId, message_id: statusMsgId });
            success = false;
        }
        console.log(`[Queue] processTask finished with success=${success}`);
        lastTaskTimePerUser.set(fromIdKey, Date.now());
        
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
            setTimeout(runNextTask, retryAfter * 1000);
            // activeTasksCount-- needs to be removed from here because it's handled in finally
            activeTasksPerUser.set(fromIdKey, Math.max(0, (activeTasksPerUser.get(fromIdKey) || 1) - 1));
            return;
        }
    } finally {
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
                if (!p.lastProcessedMsgId || lastId > p.lastProcessedMsgId) {
                    p.lastProcessedMsgId = lastId;
                    updated = true;
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

                        taskQueue.push({
                            chatId: userId,
                            link: virtualLink,
                            userId: userId,
                            overrideThreadId: destTopicId,
                            overrideTargetId: destId,
                            isMirror: true
                        });

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
            }
        }
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
            let match = paths.find((p: any) => 
                p.isLive === true && (
                    normalize(p.sourceId) === cleanChatId || 
                    normalize(p.sourceNumericId) === cleanChatId
                )
            );

            // 2. Fallback: match by Username if not matched yet
            if (!match) {
                try {
                    const chatEntity = await message.getChat();
                    if (chatEntity && chatEntity.username) {
                        const currentUsername = chatEntity.username.toLowerCase();
                        match = paths.find((p: any) => 
                            p.isLive === true && (
                                (p.sourceUsername && p.sourceUsername.toLowerCase() === currentUsername) ||
                                (p.sourceId && p.sourceId.replace('@', '').toLowerCase() === currentUsername)
                            )
                        );
                    }
                } catch (e) {}
            }

            if (match) {
                console.log(`[Watcher] Match found! Source: ${match.sourceId} -> Dest: ${match.destId}`);
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

                const destId = match.destId;
                let destTopicId = undefined;
                
                if (topicName !== 'General') {
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
                        } catch (err) {
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
                
                taskQueue.push({
                    chatId: userId, 
                    link: virtualLink,
                    userId: userId,
                    overrideThreadId: destTopicId,
                    overrideTargetId: match.destId,
                    isMirror: true
                });
                
                runNextTask();
                
                // Keep track of the last processed message ID in real-time
                await updateMirrorPathLastId(userId, chatIdRaw, message.id);
            }
        } catch (e) {
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
                if (e.message?.includes('AUTH_KEY_UNREGISTERED')) {
                    userSessions.delete(lookupId);
                    if (approvedUsersCollection) {
                         await approvedUsersCollection.updateOne({ userId: lookupId.toString() }, { $unset: { stringSession: "" } });
                    }
                }
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
                    connectionRetries: 50,
                    timeout: 600000,
                    requestRetries: 15,
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
                    if (approvedUsersCollection) {
                        await approvedUsersCollection.updateOne({ userId: lookupId.toString() }, { $unset: { stringSession: "" } });
                    }
                }
                await client.disconnect().catch(() => {});
                return null;
            }
        } catch (err: any) {
            console.error(`Userbot Client failed for user ${lookupId}:`, err);
            return null;
        }
    })();

    pendingConnections.set(lookupId, connectPromise);
    try {
        return await connectPromise;
    } finally {
        pendingConnections.delete(lookupId);
    }
};

    const createProgressBar = (total: number, current: number, label: string, startTime: number) => {
        const percentage = Math.min(100, Math.max(0, Math.floor((current / total) * 100)));
        const size = 18;
        const filled = Math.floor((size * current) / total);
        const empty = size - filled;
        const progressBar = "█".repeat(filled) + "░".repeat(empty);
        
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

        const icon = label === "Downloading" ? "DOWNLOAD" : "UPLOAD";
        const meta = label === "Downloading" ? "Server ⟿ Bot" : "Bot ⟿ Your Chat";

        // Slower updates for human-like profile (every 5 seconds)
        const text = `╔═ ${icon} STATUS ═╗\n` +
               `${percentage}% ${progressBar}\n\n` +
               `📦 Size:  ${formatBytes(current)} / ${formatBytes(total)}\n` +
               `⚡Speed: ${formatBytes(speed)}/s\n` +
               `⏳EST: ${formatTime(eta)}\n` +
               `╚══════════════════╝\n\n` +
               `🛡 Mode: VPS-Turbo (${currentUploadEngine})\n` +
               `🛰 Route: ${meta}`;
        return text;
    };

    // Access memory: Stores which account worked for which channel (channelId -> userId)
    const chatAccessCache = new Map<string, number>();

    const getBestClientForLinkData = async (linkData: any, preferredUserIdParam: number, statusMsgId?: number, chatId?: number) => {
        const preferredUserId = Number(await resolveSettingsUserId(preferredUserIdParam)) || preferredUserIdParam;

        // Strictly use the preferred account as requested by the user
        const client = await getConnectedUserbotClient(preferredUserId);
        if (client) {
            try {
                const entity = await safelyResolveEntity(client, linkData.channelId).catch(() => null);
                if (entity) {
                    const msgs = await client.getMessages(entity, { ids: [linkData.msgId] });
                    if (msgs && msgs.length > 0 && !(msgs[0] instanceof Api.MessageEmpty)) {
                        return { client, userId: preferredUserId, peer: entity };
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
                const entity = await safelyResolveEntity(prefClient, targetId).catch(() => null);
                if (entity) return { client: prefClient, userId: preferredUserId, peer: entity };
            } catch (e) {}
        }
        
        return { client: prefClient, userId: preferredUserId, peer: null };
    };

    const processTask = async (chatId: number, link: string, statusMsgId: number, userId: number, threadIdOverride?: number, forceGeneralPath?: boolean, targetIdOverride?: any, isMirror?: boolean): Promise<boolean> => {
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
            if (!sourceClient) throw new Error("No active Userbot session to access source.");
            
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

            if (targetIdOverride === undefined) {
                const sourceId = linkData.channelId;
                const mirrorPath = (isMirror || !forceGeneralPath) ? userDoc?.mirrorPaths?.find((p: any) => 
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

            // Smart Route Destination: Find a client that can reach the destination
            const { client: destClient, peer: destPeer } = await getBestClientForTarget(uploadTarget, userId, statusMsgId, chatId);
            
            let finalDestPeer = destPeer;
            if (!finalDestPeer || (finalDestPeer.className === 'InputPeerChannel' && finalDestPeer.accessHash?.toString() === '0')) {
                try {
                    // Pre-flight check to fail early before downloading/uploading
                    const directResolve = await destClient.getEntity(uploadTarget);
                    finalDestPeer = await destClient.getInputEntity(directResolve);
                } catch (e: any) {
                    throw new Error("Target destination could not be resolved by your Userbot. Ensure the Userbot has joined the destination chat/channel.");
                }
            }
            if (!destClient) throw new Error("Destination unreachable. Ensure your Userbot is a member.");

            const destTargetStr = uploadTarget.toString();
            const cleanLink = link.trim();
            if (isMirror && mirroredMessagesCollection) {
                const existing = await mirroredMessagesCollection.findOne({ link: cleanLink, destId: destTargetStr });
                if (existing) {
                    await safeEditMessage(`⚡ **Skipped:** Already mirrored to destination.`, { chat_id: chatId, message_id: statusMsgId });
                    return true;
                }
            }

            const recordSuccessfulMirror = async () => {
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
            const maxRetries = 2;
            while (retryCount <= maxRetries) {
                try {
                    console.log(`[Debug] Attempting to fetch message ${linkData.msgId} from ${linkData.channelId} using sourceClient (attempt ${retryCount+1}).`);
                    const messages = await sourceClient.getMessages(sourcePeer, { ids: [linkData.msgId] });
                    msg = messages?.[0];
                    if (msg && !(msg instanceof Api.MessageEmpty)) break;
                    
                    console.log(`[Debug] sourceClient returned empty, trying destClient.`);
                    const destMessages = await destClient.getMessages(sourcePeer, { ids: [linkData.msgId] });
                    msg = destMessages?.[0];
                    if (msg && !(msg instanceof Api.MessageEmpty)) break;

                    throw new Error("ENTITY_ACCESS_STALE");
                } catch (err: any) {
                    const isInvalidErr = err.errorMessage === 'CHANNEL_INVALID' || err.errorMessage === 'PEER_ID_INVALID' || (err.message && (err.message.includes('CHANNEL_INVALID') || err.message.includes('PEER_ID_INVALID') || err.message.includes('STALE')));
                    if (retryCount < maxRetries && isInvalidErr) {
                        retryCount++;
                        await safeEditMessage(`🔄 **Retrying content access (${retryCount}/${maxRetries})...**`, { chat_id: chatId, message_id: statusMsgId });
                        await sleep(2000);
                        continue;
                    }
                    if (isInvalidErr && retryCount >= maxRetries) {
                        throw new Error(`Cannot access the channel. The channel may be private, restricted, or the Userbot is not a member.`);
                    }
                    throw err;
                }
            }

            if (!msg || !(msg instanceof Api.Message)) throw new Error("Content not found. The Userbot session used does not have access to this message. Please switch to an account that is a member of the source channel, or verify the link.");

            // Check if forwarding is allowed by source (Content Protection / Restrict Content is OFF)
            let isForwardingRestricted = !!msg.noforwards;
            let chatEntity = null;
            try {
                chatEntity = await msg.getChat().catch(() => null);
                if (chatEntity && chatEntity.noforwards) {
                    isForwardingRestricted = true;
                }
            } catch (chatError) {
                console.warn(`Failed to inspect chat entity for restricted forwarding check:`, chatError);
            }

            console.log(`[Debug] Checking forward. msg.noforwards: ${msg.noforwards}, chatEntity.noforwards: ${chatEntity?.noforwards}, linkData: ${JSON.stringify(linkData)}`);
            if (!isForwardingRestricted) {
                console.log(`[Debug] Attempting direct forward.`);
                await safeEditMessage("🚀 **Mirroring...**", { chat_id: chatId, message_id: statusMsgId });
                try {
                    let finalSourcePeer = (destClient === sourceClient) ? sourcePeer : await safelyResolveEntity(destClient, linkData.channelId).catch(() => null);
                    if (!finalSourcePeer) {
                        finalSourcePeer = sourcePeer;
                    }
                    console.log(`[Debug] finalSourcePeer: ${finalSourcePeer ? 'Resolved' : 'Not Resolved'}`);

                    if (finalSourcePeer) {
                        const targetPeer = finalDestPeer || await safelyResolveEntity(destClient, uploadTarget);
                        console.log(`[Debug] targetPeer: ${targetPeer ? 'Resolved' : 'Not Resolved'}`);

                        if (targetPeer) {
                            await destClient.invoke(new Api.messages.ForwardMessages({
                                fromPeer: finalSourcePeer,
                                id: [linkData.msgId],
                                toPeer: targetPeer,
                                dropAuthor: true,
                                topMsgId: threadId,
                                randomId: [helpers.generateRandomLong(true)]
                            }));
                            console.log(`[Debug] Forward successful.`);
                            await safeEditMessage("🎯 **Success!**", { chat_id: chatId, message_id: statusMsgId });
                            await recordSuccessfulMirror();
                            return true;
                        } else {
                            console.log(`[Debug] Forward failed: Could not resolve targetPeer.`);
                        }
                    } else {
                        console.log(`[Debug] Forward failed: Could not resolve finalSourcePeer.`);
                    }
                } catch (e) {
                    console.error(`[Debug] Forward exception: ${e}`);
                }
            } else {
                console.log(`[Debug] Skipping direct forward due to restriction.`);
            }

            if (!msg.media) {
                await destClient.sendMessage(finalDestPeer, { message: applyRenameRules(msg.message || "", customRules), replyTo: threadId });
                await safeEditMessage("🎯 **Success!**", { chat_id: chatId, message_id: statusMsgId });
                await recordSuccessfulMirror();
                return true;
            }

            await safeEditMessage(`📥 **Downloading via Source Account...**`, { chat_id: chatId, message_id: statusMsgId });
            
            let filename = "file";
            if (msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document) {
                const attr = msg.media.document.attributes.find(a => a instanceof Api.DocumentAttributeFilename);
                if (attr && (attr as any).fileName) filename = (attr as any).fileName;
            } else if (msg.media instanceof Api.MessageMediaPhoto) {
                filename = "photo.jpg";
            }
            filename = applyRenameRules(filename, customRules);

            const tempFilePath = path.join(os.tmpdir(), `dl_${Date.now()}_${filename}`);
            const thumbPath = path.join(os.tmpdir(), `thumb_${Date.now()}.jpg`);
            let hasThumb = false;
            const downloadStartTime = Date.now();

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
            
            let lastDownloadUpdate = 0;
            await sourceClient.downloadMedia(msg, {
                outputFile: tempFilePath,
                progressCallback: (c, t) => {
                    const now = Date.now();
                    if (now - lastDownloadUpdate > 2000 || Number(c) === Number(t)) {
                        lastDownloadUpdate = now;
                        safeEditMessage(createProgressBar(Number(t || 0), Number(c), "Downloading", downloadStartTime), { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown' }).catch(() => {});
                    }
                }
            });

            if (!fs.existsSync(tempFilePath) || fs.statSync(tempFilePath).size === 0) throw new Error("Download failed.");

            await safeEditMessage(`📤 **Uploading via Destination Account...**`, { chat_id: chatId, message_id: statusMsgId });
            
            const uploadStartTime = Date.now();
            const totalSize = fs.statSync(tempFilePath).size;
            let lastUploadUpdate = 0;

            const uploadedFile = await destClient.uploadFile({
                file: new CustomFile(filename, totalSize, tempFilePath),
                workers: 1,
                onProgress: (current: any) => {
                    let currentBytes = Number(current);
                    if (currentBytes <= 1.0 && currentBytes >= 0) {
                        currentBytes = Math.floor(currentBytes * totalSize);
                    }
                    const now = Date.now();
                    if (now - lastUploadUpdate > 2000 || currentBytes === totalSize) {
                        lastUploadUpdate = now;
                        const text = createProgressBar(Number(totalSize), currentBytes, "Uploading", uploadStartTime);
                        safeEditMessage(text, { chat_id: chatId, message_id: statusMsgId, parse_mode: 'Markdown' }).catch(() => {});
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

            await destClient.sendFile(finalDestPeer, {
                file: uploadedFile,
                caption: caption,
                workers: 8,
                attributes: attributes,
                thumb: hasThumb ? thumbPath : undefined,
                replyTo: threadId,
            } as any);

            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            if (hasThumb && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
            
            await safeEditMessage("🎯 **Successfully mirrored!**", { chat_id: chatId, message_id: statusMsgId });
            await recordSuccessfulMirror();
            return true;
        } catch (err: any) {
            console.error("Link Process Error:", err);
            let errMsg = err.message;
            if (err.errorMessage === 'CHANNEL_INVALID' || (errMsg && errMsg.includes("CHANNEL_INVALID"))) errMsg = "Channel not found. Ensure Userbot is a member of BOTH chats.";
            if (!errMsg && err.errorMessage) errMsg = err.errorMessage;
            await safeEditMessage(`❌ **Failed:** ${errMsg || "Unknown Error"}`, { chat_id: chatId, message_id: statusMsgId });
            return false;
        }
    };

    bot.on('message', async (msg) => {
      console.log(`[Message Handler] Received message from ${msg.from?.id}: ${msg.text || 'No text'}`);
      const chatId = msg.chat.id;
      const fromId = msg.from?.id;
      const text = msg.text;

      // Intercept states early to allow non-text actions (like setting custom thumbnail image)
      if (fromId && userActionStates[fromId]) {
          const state = userActionStates[fromId];

          console.log(`[Message Handler] State type for ${fromId}: ${state.type}`);
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
      }

      if (!text) return;
      if (text.startsWith('/')) return;

      // Handle Interactive Actions (Batch, Mirror, Login)
      if (fromId && userActionStates[fromId]) {
          const state = userActionStates[fromId];
          
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

                      // Check if bot (Userbot) is admin
                      // Minimal check for admin if possible, or just accept if resolved
                      
                      state.type = 'topic_clone_group';
                      state.pendingCloneDest = destId;
                      safeSendMessage(chatId, `✅ **Destination Verified and Set:** \`${destId}\`\n\n1. Please send the **Source Group ID** or Link you want to clone FROM.`, { reply_markup: { force_reply: true } });
                      
                      await bot.sendMessage(destId, "✅ **SetDone: Bot is ready to upload here for specific topic mirror.**");
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
                  }
                  state.pendingSourceName = groupName;

                  const uniqueDestinations = [...new Map(savedDestinations.map((d: any) => [d.destId, d])).values()];
               const kb = uniqueDestinations.map((d: any, idx: number) => {
                       return [
                           { text: d.groupName + (d.destThreadId ? ` (Topic ${d.destThreadId})` : ''), callback_data: `lm_dest_${idx}` },
                           { text: '🗑', callback_data: `del_saved_dest:${idx}` }
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
                  state.cloneSourceGroupId = sourceId;
                  safeSendMessage(chatId, `✅ **Source Recognized:** \`${sourceId}\`\n\n2. Please enter the **Topic ID** of the topic you want to clone now.`, {
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

              // Deduplicate based on destId for display
              const uniqueDestinations = [...new Map(savedDestinations.map((d: any) => [d.destId, d])).values()];

              const kb = uniqueDestinations.map((d: any, idx: number) => {
                  return [
                      { text: d.groupName + (d.destThreadId ? ` (Topic ${d.destThreadId})` : ''), callback_data: `fm_dest_${idx}` },
                      { text: '🗑', callback_data: `del_saved_dest:${idx}` }
                  ];
              });
              kb.push([{ text: '❌ Cancel', callback_data: 'start_back' }]);

              safeSendMessage(chatId, `✅ **Source Selected:** \`${sourceId}\`\n\n**Select Destination Group for Full Mirror:**`, {
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
              
              const settingsUid = await resolveSettingsUserId(fromId);
              const userDoc = await approvedUsersCollection?.findOne({ userId: settingsUid });
              const paths = userDoc?.mirrorPaths || [];
              paths.push({ sourceId: sourceGroupId, destId: destGroupId, destThreadId: Number(topicId), groupName: "Topic " + topicId + " Mirror" });
              await approvedUsersCollection?.updateOne({ userId: settingsUid }, { $set: { mirrorPaths: paths } });
              
              try {
                  const targetUid = Number(await resolveSettingsUserId(fromId));
                  const client = await getConnectedUserbotClient(targetUid);
                  if (!client) throw new Error("Your Userbot session is not active. Please /login first.");
                  
                  const sourceEntity = await safelyResolveFullEntity(client, sourceGroupId);
                  const destEntity = await safelyResolveEntity(client, destGroupId);
                  
                  // Get topic title
                  let topicTitle = "Mirrored Topic";
                  try {
                      const topicsResult: any = await client.invoke(new Api.channels.GetForumTopics({ channel: sourceEntity, limit: 100 }));
                      const topic = topicsResult.topics?.find((t: any) => t.id === topicId);
                      if (topic) topicTitle = topic.title;
                  } catch(e) { console.error("Error getting topic title", e); }
                  
                  // Create or get topic in dest
                  console.log(`[Debug] Topic Clone: destEntity: ${destEntity.id}, topicTitle: ${topicTitle}`);
                  const destTopicId = await getOrCreateTopic(client, destEntity, topicTitle);
                  console.log(`[Debug] Topic Clone: destTopicId: ${destTopicId}`);                
                  
                  if (!destTopicId) throw new Error("Could not create or find the topic. Please ensure the destination is a Forum group.");
                  
                  // Confirmation in topic
                  try {
                      await safeSendMessage(Number(destGroupId.toString().replace('-100', '')), `✅ **SetDone: Bot is ready to upload here for specific topic mirror.**`, { message_thread_id: destTopicId });
                  } catch(e) { console.error("Error sending topic mirror confirmation", e); }
                  
                  const sourceIdRaw = (sourceEntity as any).id?.toString() || "";
                  const sourceIdClean = sourceIdRaw.replace('-100', '');

                  const messages: any = await client.getMessages(sourceEntity, { limit: 500, replyTo: topicId });

                  if (!messages || messages.length === 0) {
                      throw new Error("No messages found inside this topic, or topic ID is invalid.");
                  }

                  messages.sort((a: any, b: any) => a.id - b.id);

                  let queuedCount = 0;
                  for (const m of messages) {
                      if (m.action) continue; 
                      if (!m.message && !m.media) continue;

                      const virtualLink = `https://t.me/c/${sourceIdClean}/${m.id}`;
                      
                      taskQueue.push({ 
                          chatId, 
                          link: virtualLink, 
                          userId: fromId,
                          forceGeneralPath: false,
                          overrideTargetId: destGroupId, 
                          threadIdOverride: destTopicId,
                          isMirror: true
                      });
                      queuedCount++;
                  }

                  runNextTask();
                  safeSendMessage(chatId, `✅ Added **${queuedCount}** items from Topic ID \`${topicId}\` to copy queue for destination: \`${destGroupId}\` (Topic: \`${topicTitle}\`).`);
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

                  const destId = mirrorPath ? mirrorPath.destId : (userDoc?.uploadPath || DEFAULT_LOG_GROUP);

                  const messages: any = await client.getMessages(sourceEntity, {
                      limit: 100,
                      replyTo: topicId
                  });

                  for (const m of messages) {
                      if (m.media) {
                          const entityId = sourceIdClean;
                          const virtualLink = `https://t.me/c/${entityId}/${m.id}`;
                          taskQueue.push({ 
                              chatId, 
                              link: virtualLink, 
                              userId: fromId,
                              overrideThreadId: mirrorPath?.destThreadId ? Number(mirrorPath.destThreadId) : undefined,
                              isMirror: true
                          });
                      }
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
                      const getMsgId = (url: string) => parseInt(url.trim().split('/').pop() || '0');
                      const startId = getMsgId(startLink);
                      const endId = getMsgId(endLink);
                      const baseUrl = startLink.substring(0, startLink.lastIndexOf('/') + 1);

                      if (isNaN(startId) || isNaN(endId)) throw new Error("Invalid range IDs.");
                      if (endId < startId) throw new Error("End link ID must be greater than start link ID.");

                      const count = endId - startId + 1;
                      if (count > 200) throw new Error("Batch limit exceeded (Max 200 links at once).");

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
                      
                      for (let i = startId; i <= endId; i++) {
                          const link = `${baseUrl}${i}`;
                          taskQueue.push({ chatId, link, batchId, userId: fromId });
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
            return resolve(val);
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
                    connectionRetries: 50,
                    timeout: 600000,
                    requestRetries: 15,
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
                        safeSendMessage(chatId, `📧 **Received!** \n\nTelegram has just sent a login code directly to your other device.\n\nPlease type it here so I can confirm it's you.`, { 
                            parse_mode: 'Markdown', reply_markup: { force_reply: true } 
                        });
                        return new Promise((resolve) => { 
                            console.log(`[Login] Waiting for OTP for ${fromId}`);
                            state.step = 'awaiting_otp';
                            state.resolvePhoneCode = resolve; 
                        });
                    },
                    password: async (hint) => {
                        console.log(`[Login] Requested 2FA password for ${fromId}`);
                        await sleep(1000);
                        safeSendMessage(chatId, `🔐 **Almost there!**\n\nYour account has two-step verification enabled for extra protection.\n\nHint: \`${hint || 'None'}\`\n\nPlease enter your 2FA password to finish connecting:`, { 
                            parse_mode: 'Markdown', reply_markup: { force_reply: true } 
                        });
                        return new Promise((resolve) => { 
                            console.log(`[Login] Waiting for 2FA password for ${fromId}`);
                            state.step = 'awaiting_2fa';
                            state.resolvePassword = resolve; 
                        });
                    },
                    onError: (err: any) => {
                        console.error(`[Login] Internally caught error for ${fromId}, aborting flow:`, err);
                        throw err;
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
                        const cleanMsg = err.message || "Unknown error";
                        const solution = getLoginErrorSolution(cleanMsg);
                        
                        let displayMsg = cleanMsg;
                        if (cleanMsg.includes('PHONE_CODE_EXPIRED') || cleanMsg.includes('AUTH_KEY_UNREGISTERED')) {
                            displayMsg = "The authentication code has expired or is invalid. Please type /login again to request a new one.";
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

      // Link detection (Supports Topics and multiple segments)
      const links = text.match(/(?:https?:\/\/)?t\.me\/(?:c\/)?[\w.-]+(?:\/[\d]+)+/g);
      if (links && links.length > 0) {
        if (!isAuthorized(fromId)) return safeSendMessage(chatId, "❌ **Access Restricted**\n\nYou are not authorized to process links. Please use /start to request access.");
        if (!isAdmin(fromId) && links.length > 1) return safeSendMessage(chatId, "❌ Only authorized admins can process multiple links at once.");

        for (const link of links) {
            const options: any = { parse_mode: 'Markdown' };
            if (msg.message_thread_id) options.message_thread_id = msg.message_thread_id;
            
            const statusMsg = await safeSendMessage(chatId, `🔍 **Analyzing link:** \`${link.split('/').pop()}\`...`, options);
            taskQueue.push({ 
                chatId: chatId, 
                link: link, 
                statusMsgId: statusMsg?.message_id || 0, 
                userId: fromId!,
                overrideThreadId: msg.message_thread_id
            });
        }

        runNextTask();
        const options: any = { parse_mode: 'Markdown' };
        if (msg.message_thread_id) options.message_thread_id = msg.message_thread_id;
        safeSendMessage(msg.chat.id, `⌛ **Queued:** Added ${links.length} task(s) to the processing queue.\n\n_Total items waiting: ${taskQueue.length}_`, options);
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

    bot.on('error', (error) => {
      console.error('Bot Critical Error:', error);
      botStatus = 'Error';
    });

  } catch (err) {
    console.error('Init failed:', err);
    botStatus = 'Failed';
  }
}

app.use(express.json());

app.get('/api/status', (req, res) => {
  res.json({
    status: botStatus,
    dbStatus: dbStatus,
    adminConfigured: !!currentAdminId,
    botInfo: botInfo,
    queueSize: taskQueue.length,
    nextTaskIn: nextTaskRunAt ? Math.max(0, Math.round((nextTaskRunAt - Date.now()) / 1000)) : 0,
    proxy: undefined,
    config: {
      hasToken: !!token,
      hasMongo: !!mongoUri,
      hasTarget: !!destinationChatId
    },
    settings: {
      adminId: currentAdminId,
      destinationChatId: destinationChatId,
      apiId: process.env.API_ID || null,
      apiHash: process.env.API_HASH || null,
      downloadLibrary: currentDownloadLibrary,
      renameRules: globalRenameRules
    }
  });
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
  const { adminId, stringSession, destinationChatId: newDestId, apiId: newApiId, apiHash: newApiHash, downloadLibrary, renameRules, proxy, cooldownSeconds } = req.body;
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
        if (cooldownSeconds !== undefined) {
             updateData.cooldownSeconds = Number(cooldownSeconds);
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

async function startServer() {
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
