import express from 'express';
import path from 'path';
import TelegramBot from 'node-telegram-bot-api';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { TelegramClient, Api, helpers } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';

const mirrorTopicCache = new Map<string, Map<string, number>>();
const sourceTopicCache = new Map<string, Map<number, string>>();
const activeWatchers = new Set<number>();
let getConnectedUserbotClient: (userId: number) => Promise<any>;
let startAutoMirrorWatcher: (userId: number, client: TelegramClient) => Promise<any>;
import fs from 'fs';
import os from 'os';
import { CustomFile } from 'telegram/client/uploads';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const mongoUri = process.env.MONGODB_URI;
let apiIdValue = Number(process.env.API_ID) || 0;
let apiHashValue = process.env.API_HASH || "";

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

// Global Settings State
let currentAdminId = process.env.ADMIN_ID;
let destinationChatId = process.env.DESTINATION_CHAT_ID;
let currentDownloadLibrary = 'GramJS';
let currentUploadEngine = 'GramJS';
const uploadEngines = ['GramJS', 'Telethon', 'Pyrogram', 'Hydrogram'];
const approvedUsersCache = new Set<string>();
let globalRenameRules: Array<{ keyword: string; replaceWith: string }> = [];

function applyRenameRules(text: string): string {
    if (!text) return "";
    let result = text;
    for (const rule of globalRenameRules) {
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


const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function safelyResolveEntity(client: any, entity: any): Promise<any> {
    try {
        if (!entity) throw new Error("Entity is undefined");

        // 1. If it's already an input peer, return it
        if (entity.className && entity.className.startsWith('InputPeer')) {
            return entity;
        }

        // 2. If it's a PeerChannel, PeerUser, or PeerChat (a raw peer), resolve to full Entity first
        if (entity.className === 'PeerChannel' || entity.className === 'PeerUser' || entity.className === 'PeerChat') {
            try {
                // This is the CRITICAL part for PeerChannel resolution
                const resolved = await client.getEntity(entity);
                return await client.getInputEntity(resolved);
            } catch (e) {
                // Human-like pause before fallback
                await sleep(Math.random() * 500 + 300);
                
                // Fallback to dialogs search if getEntity fails (e.g. not in cache and not found)
                const dialogs = await client.getDialogs({ limit: 2000 });
                const idToCheck = (entity.channelId || entity.userId || entity.chatId).toString();
                const found = dialogs.find((d: any) => d.id.toString() === idToCheck);
                if (found) return found.inputEntity || await client.getInputEntity(found.entity);
            }
        }
        
        // 3. Try getting input entity directly as a backup
        return await client.getInputEntity(entity);
    } catch (e) {
        // Human-like pause before fallback
        await sleep(Math.random() * 500 + 300);
        
        // Fallback for numeric IDs if the above fails
        const idStr = entity.toString();
        if (/^\d{10}$/.test(idStr)) {
            try {
                return await client.getInputEntity('-100' + idStr);
            } catch (e2) {}
        }
        
        // Final attempt
        try {
            const resolvedEntity = await client.getEntity(entity);
            return await client.getInputEntity(resolvedEntity);
        } catch (e3) {
            throw new Error(`Could not resolve entity for: ${JSON.stringify(entity)}. Ensure access.`);
        }
    }
}

const userActionStates: Record<number, { 
    type: 'batch_start' | 'batch_end' | 'mirror_target' | 'set_thumb' | 'set_cap' | 'set_path' | 'mirror_choice' | 'set_mirror_source' | 'enter_topic_id' | 'mirror_path_add_source' | 'mirror_path_await_dest' | 'topic_clone_group' | 'topic_clone_topic_id' | 'add_rename_rule' | 'set_api_id' | 'set_api_hash' | 'full_mirror_group' | 'full_mirror_dest_select' | 'live_mirror_dest_select', 
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
        console.log('Settings loaded from DB');
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
  return ALLOWED_ADMIN_IDS.includes(userId.toString()) || (currentAdminId && userId.toString() === currentAdminId.toString());
};

// Approval Check Utility
const isAuthorized = (userId: number | undefined) => {
  return isAdmin(userId);
};

    // GramJS Login State
    const loginStates: Record<number, {
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
        ]);

        const handleSetMirror = async (chatId: number, fromId: number | undefined, msg: TelegramBot.Message) => {
            try {
                if (!isAdmin(fromId) || !fromId) throw new Error("Restricted: Admin access required.");
                
                if (msg.chat.type === 'private') {
                    throw new Error("Use this command in the **Destination Group**.");
                }

                if (approvedUsersCollection) {
                    const userDoc = await approvedUsersCollection.findOne({ userId: fromId.toString() });
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
                        { userId: fromId.toString() },
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
                const client = await getConnectedUserbotClient(fromId);
                if (!client) throw new Error("Userbot not logged in.");

                safeSendMessage(chatId, "🔄 **Forcing Entity Sync...**\nThis will refresh your groups and channels. This may take a moment.");
                entityCache.clear();
                await client.getDialogs({ limit: 100 });
                safeSendMessage(chatId, "✅ **Sync Complete!** Your recent groups and channels are now cached.");
            } catch (err: any) {
                safeSendMessage(chatId, `❌ **Sync Failed:** ${err.message}`);
            }
        };

        const handleLogin = async (chatId: number, fromId: number | undefined) => {
          try {
            if (!isAdmin(fromId)) throw new Error("Restricted: You are not an Admin.");
            if (!apiIdValue || !apiHashValue) throw new Error("Missing API_ID or API_HASH. Please set them using /settings or your environment/dashboard variables.");

            if (fromId && (userSessions.get(fromId) || (await approvedUsersCollection?.findOne({ userId: fromId.toString() }))?.stringSession)) {
                return safeSendMessage(chatId, "✅ **You are already logged in!**\n\nYour session is active. If you want to log in with a different account, use /logout first.", { parse_mode: 'Markdown' });
            }

            if (fromId && loginStates[fromId]) {
                return safeSendMessage(chatId, "⏳ **Login already in progress.**\n\nPlease complete the current steps or use /cancel.", { parse_mode: 'Markdown' });
            }

            safeSendMessage(chatId, "👋 Hello there! I'm your secure Telegram manager. To connect your account and start managing your files safely, please reply with your phone number, formatted internationally (e.g., +91XXXXXXXXXX).", { 
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

        const client = userClients.get(fromId);
        if (client) {
            await client.disconnect();
            userClients.delete(fromId);
        }
        userSessions.delete(fromId);

        if (approvedUsersCollection) {
          await approvedUsersCollection.updateOne({ userId: fromId.toString() }, { $unset: { stringSession: "" } });
          safeSendMessage(chatId, "🔒 **Logged Out:** Your Userbot session has been cleared and client disconnected.");
        }
      } catch (err: any) {
        safeSendMessage(chatId, `❌ **Logout Error:** ${err.message}`);
      }
    };

    const handleSettings = async (chatId: number, fromId: number | undefined, messageId?: number) => {
        if (!isAdmin(fromId)) return;
        if (!fromId) return;

        const userDoc = await approvedUsersCollection?.findOne({ userId: fromId.toString() });
        const session = userSessions.get(fromId) || userDoc?.stringSession;
        
        let pathDisplay = 'Default (This Bot)';
        if (userDoc?.uploadPath) {
            const name = userDoc.uploadGroupName || userDoc.uploadPath;
            const topic = userDoc.uploadTopicName ? ` > ${userDoc.uploadTopicName}` : '';
            pathDisplay = `${name}${topic}`;
        }

        let mirrorPathsText = '';
        if (userDoc?.mirrorPaths && userDoc.mirrorPaths.length > 0) {
            mirrorPathsText = `\n📂 **Mirror Pairings (${userDoc.mirrorPaths.length}/16):**\n`;
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

        const text = `⚙️ **Advanced Configuration**\n\n` +
                     `• **Database:** ${dbStatus === 'Connected' ? '✅ Online' : '❌ Offline'}\n` +
                     `• **Userbot:** ${session ? '✅ Active' : '❌ Missing'}\n` +
                     `• **Upload Mode:** ${uploadModeDisplay}\n` +
                     `• **Engine:** 🚀 ${currentUploadEngine}\n` +
                     `• **Destination:** 📍 \`${pathDisplay}\`\n` +
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
                await bot?.deleteMessage(chatId, messageId).catch(() => {});
                await bot?.sendPhoto(chatId, SETTINGS_LOGO_PATH, { caption: text, parse_mode: 'Markdown', reply_markup: markup });
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
                await bot?.sendPhoto(chatId, SETTINGS_LOGO_PATH, { caption: text, parse_mode: 'Markdown', reply_markup: markup });
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
      
      if (fromId && loginStates[fromId]) {
        if (loginStates[fromId].client) loginStates[fromId].client?.disconnect();
        delete loginStates[fromId];
        cancelled = true;
      }

      if (fromId && userActionStates[fromId]) {
        delete userActionStates[fromId];
        cancelled = true;
      }

      if (fromId) {
          const originalLength = taskQueue.length;
          const remainingTasks = taskQueue.filter(task => task.userId !== fromId);
          if (remainingTasks.length < originalLength) {
              taskQueue.length = 0;
              taskQueue.push(...remainingTasks);
              cancelled = true;
          }
      }

      if (cancelled) {
        safeSendMessage(chatId, "🛑 **All active tasks, batches, and operations have been cancelled.**");
      } else {
        safeSendMessage(chatId, "⚠️ **No active tasks or operations found to cancel.**");
      }
    };

    const handleBatch = async (chatId: number, fromId: number | undefined) => {
      try {
        if (!isAdmin(fromId) || !fromId) throw new Error("Restricted: Admin access required.");
        
        const session = userSessions.get(fromId) || (await approvedUsersCollection?.findOne({ userId: fromId.toString() }))?.stringSession;
        if (!session) throw new Error("Userbot Session Required: Please /login first.");
        
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

        const session = userSessions.get(fromId) || (await approvedUsersCollection?.findOne({ userId: fromId.toString() }))?.stringSession;
        if (!session) throw new Error("Userbot Session Required: Please /login first.");
        
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
           return bot?.sendPhoto(msg.chat.id, photoUrl, {
               caption: unauthorizedText,
               parse_mode: 'Markdown'
           });
       }

       const welcomeText = `👋 **Hello ${msg.from?.first_name}!**\n\nI am the **Restricted Content Saver** bot. I help you bypass download restrictions and mirror entire groups efficiently.\n\n✨ **Core Features:**\n• Download Restricted Media\n• Mirror Groups/Channels\n• Topic preservation support\n\n🛡 **Status:** Authorized User`;
       
       bot?.sendPhoto(msg.chat.id, photoUrl, {
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

      if (query.data === 'login_cmd') handleLogin(chatId, query.from?.id);
      if (query.data === 'batch_cmd') handleBatch(chatId, query.from?.id);
      if (query.data === 'mirror_cmd') handleMirror(chatId, query.from?.id, query.message);
      
      if (query.data === 'full_mirror_start') {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          userActionStates[query.from.id] = { type: 'full_mirror_group' };
          safeSendMessage(chatId, "🔄 **Full Group Mirror**\n\n1. Please send the **Source Group/Channel ID or Link** you want to completely mirror.", {
              reply_markup: { force_reply: true }
          });
          bot?.answerCallbackQuery(query.id);
          return;
      }

      if (query.data === 'topic_clone_start') {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          userActionStates[query.from.id] = { type: 'topic_clone_group' };
          safeSendMessage(chatId, "🎯 **Clone Specific Topic**\n\n1. Please send the **Source Group/Channel ID or Link** from which you want to clone the topic.", {
              reply_markup: { force_reply: true }
          });
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
          const userDoc = await approvedUsersCollection?.findOne({ userId: query.from.id.toString() });
          const dest = (userDoc?.savedDestinations || [])[idx];
          if (!dest) {
              return bot?.answerCallbackQuery(query.id, { text: '❌ Destination not found.', show_alert: true });
          }

          const sourceId = state.pendingSourceId!;
          const sourceName = state.pendingSourceName || 'Source Group';
          delete userActionStates[query.from.id];

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
              createdAt: new Date()
          });

          const finalPaths = filtered.slice(-20);

          if (approvedUsersCollection) {
              await approvedUsersCollection.updateOne(
                  { userId: query.from.id.toString() },
                  { $set: { mirrorPaths: finalPaths } }
              );
              
              const destDisplay = dest.destThreadId ? `${dest.groupName} (Topic: ${dest.destThreadId})` : dest.groupName;
              safeSendMessage(chatId, `✅ **Live Mirror Path Setup Finished!**\n\n**Source:** \`${sourceName}\` (\`${sourceId}\`)\n**Destination:** ${destDisplay}\n⚡ **Live Status:** 🟢 Live ON (Auto-mirroring active!)`, { parse_mode: 'Markdown' });
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
          const userDoc = await approvedUsersCollection?.findOne({ userId: query.from.id.toString() });
          const dest = (userDoc?.savedDestinations || [])[idx];
          if (!dest) {
              return bot?.answerCallbackQuery(query.id, { text: '❌ Destination not found.', show_alert: true });
          }

          const sourceId = state.pendingSourceId!;
          delete userActionStates[query.from.id];

          const statusMsg = await safeSendMessage(chatId, `📂 **Starting Full Mirror...**\nSource Group: \`${sourceId}\`\nFetching history, this may take a moment depending on the group size.`);
          
          try {
              const client = await getConnectedUserbotClient(query.from.id);
              if (!client) throw new Error("Your Userbot session is not active. Please /login first.");
              
              let sourceEntity: any;
              try {
                  sourceEntity = await client.getEntity(sourceId);
              } catch (e: any) {
                  if (!sourceId.startsWith('-100') && !isNaN(Number(sourceId))) {
                      sourceEntity = await client.getEntity("-100" + sourceId);
                  } else {
                      throw e;
                  }
              }
              const destPath = dest.destId;
              
              let destEntity: any = null;
              try {
                  destEntity = await client.getEntity(destPath);
              } catch (e: any) {
                  if (!destPath.startsWith('-100') && !isNaN(Number(destPath))) {
                      destEntity = await client.getEntity("-100" + destPath).catch(() => null);
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
                      overrideTargetId: destPath
                  });
              }

              if (msgsToQueue.length === 0) {
                  throw new Error("No messages found inside this group.");
              }

              taskQueue.push(...msgsToQueue);
              if (!isTaskRunning) runNextTask();
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
              const userDoc = await approvedUsersCollection?.findOne({ userId: query.from.id.toString() });
              const paths = userDoc?.mirrorPaths || [];
              
              if (paths.length === 0) {
                  safeSendMessage(chatId, "📭 **No active mirror paths found.**\nUse /setmirror in a destination group to add one.");
              } else {
                  let text = `📂 **Active Mirror Paths (${paths.length}/16):**\n\n`;
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
              const userDoc = await approvedUsersCollection?.findOne({ userId: query.from.id.toString() });
              const paths = userDoc?.mirrorPaths || [];
              if (paths[index]) {
                  const removed = paths.splice(index, 1);
                  await approvedUsersCollection.updateOne(
                      { userId: query.from.id.toString() },
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

      if (query.data?.startsWith('mirrortoggle_')) {
          if (!isAdmin(query.from.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Admin only', show_alert: true });
          const index = parseInt(query.data.split('_')[1]);
          
          try {
              const userDoc = await approvedUsersCollection?.findOne({ userId: query.from.id.toString() });
              const paths = userDoc?.mirrorPaths || [];
              if (paths[index]) {
                  paths[index].isLive = !paths[index].isLive;
                  await approvedUsersCollection.updateOne(
                      { userId: query.from.id.toString() },
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
              taskQueue.push({ chatId, link, statusMsgId: statusMsg?.message_id || 0, userId: fromId });
              if (!isTaskRunning) runNextTask();
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
                  const client = await getConnectedUserbotClient(fromId);
                  if (!client) throw new Error("Userbot disconnected.");
                  
                  let sourceEntity: any;
                  try {
                      sourceEntity = await client.getEntity(sourceTarget);
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

                  const destPath = mirrorPath ? mirrorPath.destId : userDoc?.uploadPath;
                  if (!destPath) throw new Error("Please set a Destination Path first using /setpath or /setmirror.");

                  const destEntity: any = await client.getEntity(destPath).catch(() => { throw new Error("Could not access Destination.")});

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
                                      overrideThreadId: destTopicId
                                  });
                              }
                          }
                      }
                  }
                  if (!isTaskRunning) runNextTask();

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
          `• /settings - Configure bot behavior\n\n` +
          `**Note:** You must have a valid \`STRING_SESSION\` for restricted content access.`;
        bot?.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
      }

      if (query.data === 'bot_settings') {
        if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
        handleSettings(chatId, query.from?.id);
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
              await approvedUsersCollection.updateOne({ userId: query.from.id.toString() }, { $unset: { uploadPath: "" } });
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
          if (approvedUsersCollection) {
              await approvedUsersCollection.updateOne(
                  { userId: query.from.id.toString() },
                  { $unset: { customThumbnailFileId: "" } }
              );
          }
          const userCustomThumbPath = path.join(os.tmpdir(), `custom_thumb_${query.from.id}.jpg`);
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
              const userDoc = await approvedUsersCollection.findOne({ userId: query.from.id.toString() });
              const currentMode = userDoc?.uploadMode === 'document' ? 'video' : 'document';
              await approvedUsersCollection.updateOne(
                  { userId: query.from.id.toString() },
                  { $set: { uploadMode: currentMode } }
              );
              bot?.answerCallbackQuery(query.id, { text: `✅ Upload Mode set to ${currentMode === 'document' ? 'Document/File' : 'Video'}` });
              handleSettings(chatId, query.from?.id, query.message!.message_id);
          }
          return;
      }

      if (query.data === 'toggle_rename' || query.data === 'rename_rules_panel') {
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          let rulesList = '';
          if (globalRenameRules && globalRenameRules.length > 0) {
              globalRenameRules.forEach((rule, idx) => {
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
          if (!isAdmin(query.from?.id)) return bot?.answerCallbackQuery(query.id, { text: '❌ Restricted to Admin', show_alert: true });
          globalRenameRules = [];
          if (settingsCollection) {
              await settingsCollection.updateOne({ type: 'global_config' }, { $set: { renameRules: [] } }, { upsert: true });
          }
          bot?.answerCallbackQuery(query.id, { text: '✅ All Rename Rules Cleared!', show_alert: true });
          
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
          const userDoc = await approvedUsersCollection?.findOne({ userId: query.from.id.toString() });
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
          const userDoc = await approvedUsersCollection?.findOne({ userId: query.from.id.toString() });
          const paths = userDoc?.mirrorPaths || [];
          
          if (paths[index]) {
              paths.splice(index, 1);
              await approvedUsersCollection?.updateOne({ userId: query.from.id.toString() }, { $set: { mirrorPaths: paths } });
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
          const userDoc = await approvedUsersCollection?.findOne({ userId: query.from.id.toString() });
          const savedDestinations = userDoc?.savedDestinations || [];
          
          if (savedDestinations[index]) {
              savedDestinations.splice(index, 1);
              await approvedUsersCollection?.updateOne({ userId: query.from.id.toString() }, { $set: { savedDestinations: savedDestinations } });
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

    bot.onText(/\/login/, (msg) => handleLogin(msg.chat.id, msg.from?.id));
    bot.onText(/\/batch/, (msg) => handleBatch(msg.chat.id, msg.from?.id));
    bot.onText(/\/mirror/, (msg) => handleMirror(msg.chat.id, msg.from?.id, msg));
    bot.onText(/\/cancel/, (msg) => handleCancel(msg.chat.id, msg.from?.id));
    bot.onText(/\/logout/, (msg) => handleLogout(msg.chat.id, msg.from?.id));
    
    bot.onText(/\/restart/, async (msg) => {
        const fromId = msg.from?.id;
        const chatId = msg.chat.id;
        if (!fromId || !isAdmin(fromId)) return;
        
        // Disconnect all active clients
        for (const [userId, client] of userClients.entries()) {
            try {
                await client.disconnect();
            } catch (e) {
                console.error(`Failed to disconnect client for user ${userId}:`, e);
            }
        }

        // Clear all clients to force re-initialization on next action
        userClients.clear();
        
        bot.sendMessage(chatId, "🔄 **Bot Restarting Internal Services...**\n\nAll active userbot sessions have been disconnected and cleared. The bot will re-authenticate on next use.", { parse_mode: 'Markdown' });
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
            await approvedUsersCollection.updateOne(
                { userId: fromId.toString() },
                { 
                    $set: { 
                        uploadPath: chatId.toString(),
                        uploadTopicId: topicId || null,
                        uploadGroupName: groupTitle,
                        uploadTopicName: topicId ? `Topic ${topicId}` : ''
                    } 
                }
            );
            
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

    // Concurrency Control
let isTaskRunning = false;
interface Task {
    chatId: number;
    userId: number;
    link: string;
    statusMsgId?: number;
    batchId?: string;
    overrideThreadId?: number;
    forceGeneralPath?: boolean;
}
const taskQueue: Task[] = [];
const MESSAGE_UPDATE_THROTTLE = 2500; // ms between updates to the same message

const safeSendMessage = async (chatId: number, text: string, options: any = {}) => {
    try {
        return await bot?.sendMessage(chatId, text, options);
    } catch (e: any) {
        if (e.error_code === 429) {
            const retryAfter = (e.parameters?.retry_after || 5) + 1;
            console.log(`Rate limited on send. Waiting ${retryAfter}s...`);
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            return await bot?.sendMessage(chatId, text, options);
        }
        if (e.message?.includes("can't parse entities")) {
            console.warn(`Failed to parse entities in chat ${chatId}. Retrying without parse_mode.`);
            const newOptions = { ...options };
            delete newOptions.parse_mode;
            try {
                return await bot?.sendMessage(chatId, text, newOptions);
            } catch (innerErr) {
                console.error("Safe Send Error (Retry):", (innerErr as any).message);
                return null;
            }
        }
        if (e.message?.includes('TOPIC_CLOSED') || e.message?.includes('message thread not found')) {
            console.warn(`Topic closed or not found in chat ${chatId}. Retrying without thread ID.`);
            const newOptions = { ...options };
            delete newOptions.message_thread_id;
            try {
                return await bot?.sendMessage(chatId, text, newOptions);
            } catch (innerErr) {
                return null;
            }
        }
        console.error("Safe Send Error:", e.message);
        return null;
    }
};

const safeEditMessage = async (text: string, options: { chat_id: number, message_id: number, parse_mode?: any, disable_web_page_preview?: boolean, reply_markup?: any }) => {
    if (!options.message_id || options.message_id === 0) return;
    try {
        return await bot?.editMessageText(text, options);
    } catch (e: any) {
        if (e.description?.includes("there is no text in the message to edit") || e.message?.includes("text") || e.description?.includes("message to edit not found")) {
            try {
                return await bot?.editMessageCaption(text, {
                    chat_id: options.chat_id,
                    message_id: options.message_id,
                    parse_mode: options.parse_mode,
                    reply_markup: options.reply_markup
                });
            } catch (e2) {}
        }
        if (e.error_code === 429) return null;
        if (e.message?.includes('TOPIC_CLOSED') || e.message?.includes('message thread not found')) {
            console.warn(`Topic closed/invalid for edit in chat ${options.chat_id}. Failing gracefully.`);
            return null;
        }
        if (e.description?.includes("message is not modified")) return null;
        return null;
    }
};

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
    if (isTaskRunning || taskQueue.length === 0) return;
    isTaskRunning = true;

    try {
        const task = taskQueue.shift();
        if (!task) return;

        const fromId = task.userId;

        // Update batch info if applicable
        if (task.batchId) {
            const info = batchStatusMap.get(task.batchId);
            if (info) {
                info.currentLink = task.link;
                await refreshBatchSummary(task.batchId);
            }
        }

        // Send individual status message one-by-one if not exists
        let statusMsgId = task.statusMsgId;
        if (!statusMsgId) {
            const msgId = task.link.split('/').pop() || 'media';
            const sMsg = await safeSendMessage(task.chatId, `🔍 **Searching Item:** \`${msgId}\`...`, { parse_mode: 'Markdown' });
            statusMsgId = sMsg?.message_id || 0;
        }

        const success = await processTask(task.chatId, task.link, statusMsgId, fromId, task.overrideThreadId, task.forceGeneralPath, task.overrideTargetId);
        await new Promise(r => setTimeout(r, 3000));
        
        if (task.batchId) {
            const info = batchStatusMap.get(task.batchId);
            if (info) {
                info.processed++;
                if (success) info.success++;
                else info.failed++;
        const isFinished = info.processed === info.total;
                await refreshBatchSummary(task.batchId, isFinished);
            }
        }
    } catch (e: any) {
        if (e.description?.includes("too many requests") || e.error_code === 429) {
            const retryAfter = (e.parameters?.retry_after || 60) + 5;
            console.log(`429 Too Many Requests. Waiting ${retryAfter}s...`);
            setTimeout(runNextTask, retryAfter * 1000);
            isTaskRunning = false;
            return;
        }
        console.error("Queue execution error:", e);
    } finally {
        if (isTaskRunning) {
            isTaskRunning = false;
            // Add human-like random jitter (2 to 7 seconds)
            const jitter = Math.floor(Math.random() * 5000) + 2000;
            setTimeout(runNextTask, jitter); 
        }
    }
};

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
            
            const userDoc = await approvedUsersCollection?.findOne({ userId: userId.toString() });
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
                            const destEntity = await client.getEntity(destId);
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
                    overrideTargetId: match.destId
                });
                
                if (!isTaskRunning) runNextTask();
            }
        } catch (e) {
            console.error(`[Watcher] Event Handler Error: ${e.message}`);
        }
    }, new NewMessage({}));
}

getConnectedUserbotClient = async (userId: number) => {
    // Check if we already have an active client for this user
    if (userClients.has(userId)) {
        const client = userClients.get(userId)!;
        try {
            if (client.connected) {
                await startAutoMirrorWatcher(userId, client);
                return client;
            }
            await client.connect();
            await startAutoMirrorWatcher(userId, client);
            return client;
        } catch (e) {
            userClients.delete(userId);
            activeWatchers.delete(userId);
        }
    }

    // Try to load session from DB/Memory
    let sessionStr = userSessions.get(userId);
    if (!sessionStr && approvedUsersCollection) {
        const userDoc = await approvedUsersCollection.findOne({ userId: userId.toString() });
        if (userDoc?.stringSession) {
            sessionStr = userDoc.stringSession;
            userSessions.set(userId, sessionStr);
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
                connectionRetries: 10,
                deviceModel: "iPhone 15 Pro",
                systemVersion: "iOS 17.5",
                appVersion: "10.0.0",
                langCode: "en",
                systemLangCode: "hi-IN",
                useWSS: false,
                autoReconnect: true,
                floodSleepThreshold: 300,
                maxConcurrentDownloads: 1,
                requestRetries: 10,
                timeout: 300000
            }
        );
        await client.connect();
        
        // Cache limited dialogs to avoid suspicious bulk fetching
        await client.getDialogs({ limit: 20 }).catch(() => {});
        
        userClients.set(userId, client);
        await startAutoMirrorWatcher(userId, client);
        return client;
    } catch (err) {
        console.error(`Userbot Client failed for user ${userId}:`, err);
        return null;
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

    const processTask = async (chatId: number, link: string, statusMsgId: number, userId: number, threadIdOverride?: number, forceGeneralPath?: boolean, targetIdOverride?: any): Promise<boolean> => {
        try {
            const client = await getConnectedUserbotClient(userId);
            if (!client) throw new Error("Your Userbot session is not active. Please /login first.");
            let userDoc: any = null;
            if (approvedUsersCollection) {
                userDoc = await approvedUsersCollection.findOne({ userId: userId.toString() });
            }

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
                    return {
                        channelId: parts[domainIdx + 2],
                        msgId: msgId,
                        isRestricted: true
                    };
                }

                return {
                    channelId: nextPart,
                    msgId: msgId,
                    isRestricted: url.includes('/c/')
                };
            };

            const linkData = getLinkData(link);

            // Ping check to ensure connection is alive
            if (!client.connected) {
                await client.connect();
            }

            // Resolve target upload destination (User preference or default)
            let uploadTarget: any = chatId;
            let threadId: number | undefined = undefined;
            if (approvedUsersCollection && !userDoc) {
                userDoc = await approvedUsersCollection.findOne({ userId: userId.toString() });
            }
                
                // Priority 1: Specific Mirror Path for this source (ignore if forceGeneralPath is true)
                const sourceId = linkData.channelId;
                const mirrorPath = !forceGeneralPath ? userDoc?.mirrorPaths?.find((p: any) => 
                     p.sourceId === sourceId || p.sourceId === `-100${sourceId}` || sourceId === p.sourceId.replace('-100', '')
                ) : undefined;

                if (mirrorPath) {
                    uploadTarget = mirrorPath.destId;
                    threadId = mirrorPath.destThreadId ? Number(mirrorPath.destThreadId) : undefined;
                } else if (userDoc?.uploadPath) {
                    uploadTarget = userDoc.uploadPath;
                    if (userDoc.uploadTopicId || userDoc.uploadThreadId) {
                        threadId = Number(userDoc.uploadTopicId || userDoc.uploadThreadId);
                    }
                }

            if (threadIdOverride !== undefined) {
                threadId = threadIdOverride;
            }
            if (targetIdOverride !== undefined) {
                uploadTarget = targetIdOverride;
            }
            const msgId = linkData.msgId;
            const channelIdInput = linkData.channelId;
            const isRestricted = linkData.isRestricted;
            let peer: any;

            if (isNaN(msgId)) throw new Error("Could not parse Message ID from link.");
            
            await safeEditMessage("🔍 **Locating channel and message...**", { chat_id: chatId, message_id: statusMsgId });

            const findPeer = async (id: string, isPrivate: boolean) => {
                // 1. Normalize ID format
                const numericId = id.replace(/^-100/, "");
                const isNumeric = /^\d+$/.test(numericId);
                const fullId = isPrivate || isNumeric ? `-100${numericId}` : id;
                const bId = isNumeric ? BigInt(numericId) : null;
                const bFullId = bId ? BigInt(`-100${numericId}`) : null;
                
                // 2. Check local memory cache
                if (entityCache.has(fullId)) return entityCache.get(fullId);
                
                // 3. Attempt direct resolution (often works if seen in current session)
                try {
                    const entity = await client.getEntity(isNumeric ? (bFullId as any) : id).catch(() => 
                        isNumeric ? client.getEntity(bId as any) : client.getEntity(id)
                    );
                    if (entity) {
                        try {
                            const input = await client.getInputEntity(entity);
                            entityCache.set(fullId, input);
                            return input;
                        } catch (e) {
                            // If getInputEntity fails, return entity itself, it might still work
                            entityCache.set(fullId, entity);
                            return entity;
                        }
                    }
                } catch (e) {}

                // 4. Scan Dialogs (The most reliable way to fetch access_hash for restricted entities)
                const scanDialogsSlice = async (limit: number, offsetDate?: number) => {
                    try {
                        const dialogs = await client.getDialogs({ limit, offsetDate, archived: true });
                        for (const d of dialogs) {
                            const dIdStr = d.id.toString();
                            const dIdNumeric = dIdStr.replace(/^-100/, "");
                            
                            // Robust numeric matching
                            if (isNumeric) {
                                if (dIdNumeric === numericId || dIdStr === numericId || dIdStr === fullId || dIdStr.endsWith(numericId)) {
                                    const peerVal = d.inputEntity;
                                    entityCache.set(fullId, peerVal);
                                    return peerVal;
                                }
                            } else {
                                // Robust username/name matching
                                if (d.name?.toLowerCase() === id.toLowerCase() || dIdStr === id) {
                                    const peerVal = d.inputEntity;
                                    entityCache.set(fullId, peerVal);
                                    return peerVal;
                                }
                            }
                        }
                    } catch (e) {}
                    return null;
                };

                bot?.editMessageText("🔄 **Accessing your Telegram ID...**", { chat_id: chatId, message_id: statusMsgId }).catch(() => {});
                
                // Check recent 100 dialogs first
                const firstHit = await scanDialogsSlice(100);
                if (firstHit) return firstHit;

                // Deep scan if still not found (up to 5000 dialogs covering massive accounts)
                bot?.editMessageText("🔄 **Deep scanning your account folders...**", { chat_id: chatId, message_id: statusMsgId }).catch(() => {});
                let currentOffset = 0;
                for (let i = 0; i < 50; i++) { 
                    const dialogs = await client.getDialogs({ limit: 100, offsetDate: currentOffset, archived: true }).catch(() => []);
                    if (!dialogs || dialogs.length === 0) break;
                    
                    for (const d of dialogs) {
                        const dIdStr = d.id.toString();
                        const dIdNumeric = dIdStr.replace(/^-100/, "");
                        if (isNumeric && (dIdNumeric === numericId || dIdStr === numericId || dIdStr === fullId)) {
                            const peerVal = d.inputEntity;
                            entityCache.set(fullId, peerVal);
                            return peerVal;
                        }
                        if (!isNumeric && d.name?.toLowerCase() === id.toLowerCase()) {
                            const peerVal = d.inputEntity;
                            entityCache.set(fullId, peerVal);
                            return peerVal;
                        }
                    }
                    currentOffset = dialogs[dialogs.length - 1].date;
                }

                // Final resolution attempt using library internal cache
                try {
                    const input = await client.getInputEntity(isNumeric ? (bFullId as any) : id);
                    if (input) return input;
                } catch (e) {}

                return isNumeric ? bFullId : id;
            };

            peer = await findPeer(channelIdInput, isRestricted);

            if (isNaN(msgId)) throw new Error("Invalid Message Link format.");

            await safeEditMessage("📥 **Retrieving message content...**", { chat_id: chatId, message_id: statusMsgId });
            
            let msg: any;
            try {
                const messages = await client.getMessages(peer, { ids: [msgId] });
                msg = messages?.[0];
            } catch (err: any) {
                // If peer is unreachable, try to refresh and retry
                if (err.message.includes('CHANNEL_INVALID') || err.message.includes('PEER_ID_INVALID') || err.message.includes('MESSAGES_ID_INVALID')) {
                    await safeEditMessage("🔄 **Access Error. Syncing specific channel...**", { chat_id: chatId, message_id: statusMsgId });
                    await client.getDialogs({ limit: 40 });
                    // Try to re-resolve peer
                    const newPeer = await findPeer(channelIdInput, isRestricted);
                    const messages = await client.getMessages(newPeer, { ids: [msgId] });
                    msg = messages?.[0];
                } else {
                    throw err;
                }
            }

            if (!msg || !(msg instanceof Api.Message)) {
                throw new Error("Message not found or inaccessible. Either the link is invalid, protected, or the Userbot is NOT a participant in that specific channel/group.");
            }
            
            uploadTarget = await client.getEntity(uploadTarget).catch(() => uploadTarget);

            // Check if forwarding is allowed by source (Content Protection / Restrict Content is OFF)
            let isForwardingRestricted = !!msg.noforwards;
            try {
                const chatEntity = await msg.getChat().catch(() => null);
                if (chatEntity && chatEntity.noforwards) {
                    isForwardingRestricted = true;
                }
            } catch (chatError) {
                console.warn(`Failed to inspect chat entity for restricted forwarding check:`, chatError);
            }

            if (!isForwardingRestricted) {
                if (statusMsgId && statusMsgId !== 0) {
                    await safeEditMessage("🚀 **Attempting direct forwarding (Sender Hidden)...**", { chat_id: chatId, message_id: statusMsgId });
                }
                const randomId = helpers.generateRandomLong(true);
                let targetPeer: any = uploadTarget;
                try {
                    targetPeer = await safelyResolveEntity(client, uploadTarget);
                } catch (e) {
                    targetPeer = uploadTarget;
                }

                try {
                    const forwardRequest = new Api.messages.ForwardMessages({
                        fromPeer: peer,
                        id: [msgId],
                        toPeer: targetPeer,
                        dropAuthor: true, // Hides "Forwarded from..." sender info tag
                        topMsgId: threadId, // Target topic group thread id
                        randomId: [randomId]
                    });
                    await client.invoke(forwardRequest);
                    if (statusMsgId && statusMsgId !== 0) {
                        await safeEditMessage("🎯 **Content forwarded directly & securely (Sender Hidden)!**", { chat_id: chatId, message_id: statusMsgId });
                    }
                    return true;
                } catch (forwardErr: any) {
                    console.warn(`Direct forward failed, falling back to download & upload. Error:`, forwardErr.message);
                    if (statusMsgId && statusMsgId !== 0) {
                        await safeEditMessage("📥 **Direct forwarding restricted. Falling back to downloading locally & uploading...**", { chat_id: chatId, message_id: statusMsgId });
                    }
                    // Fall back to down/up pipeline below
                }
            } else {
                if (statusMsgId && statusMsgId !== 0) {
                    await safeEditMessage("📥 **Direct forwarding restricted by source. Falling back to downloading locally & uploading...**", { chat_id: chatId, message_id: statusMsgId });
                }
            }

            if (!msg.media) {
                if (statusMsgId && statusMsgId !== 0) {
                    await safeEditMessage("🚀 **Mirroring text content...**", { chat_id: chatId, message_id: statusMsgId });
                }
                const customMsgText = applyRenameRules(msg.message || "");
                await client.sendMessage(uploadTarget, { 
                    message: customMsgText, 
                    replyTo: threadId 
                });
                if (statusMsgId && statusMsgId !== 0) {
                    await safeEditMessage("🎯 **Text content mirrored successfully!**", { chat_id: chatId, message_id: statusMsgId });
                }
                return true;
            }

            const downloadWorkers = 32; 
            const uploadWorkers = currentUploadEngine === 'Telethon' ? 16 : 8; 

            let filename = "file";
            if (msg.media instanceof Api.MessageMediaDocument) {
                const doc = msg.media.document as Api.Document;
                const attr = doc.attributes.find(a => a instanceof Api.DocumentAttributeFilename);
                if (attr && (attr as any).fileName) filename = (attr as any).fileName;
            } else if (msg.media instanceof Api.MessageMediaPhoto) {
                filename = "photo.jpg";
            }

            // Apply custom pattern and keyword renaming to filename
            filename = applyRenameRules(filename);

            const tempFilePath = path.join(os.tmpdir(), `dl_${Date.now()}_${filename}`);
            const thumbPath = path.join(os.tmpdir(), `thumb_${Date.now()}.jpg`);
            let hasThumb = false;

            await safeEditMessage(`📥 **Preparing to download media...**\n_Mode: ${currentUploadEngine}_`, { chat_id: chatId, message_id: statusMsgId });

            // Try custom thumbnail first
            const userCustomThumbPath = path.join(os.tmpdir(), `custom_thumb_${userId}.jpg`);
            if (!fs.existsSync(userCustomThumbPath) && userDoc?.customThumbnailFileId) {
                try {
                    const downloaded = await bot?.downloadFile(userDoc.customThumbnailFileId, os.tmpdir());
                    if (downloaded) {
                        fs.renameSync(downloaded, userCustomThumbPath);
                    }
                } catch (err) {
                    console.error("Failed to download custom thumbnail from Telegram:", err);
                }
            }

            if (fs.existsSync(userCustomThumbPath)) {
                try {
                    fs.copyFileSync(userCustomThumbPath, thumbPath);
                    hasThumb = true;
                } catch (err) {
                    console.error("Failed to copy custom thumbnail:", err);
                }
            } else if (msg.media instanceof Api.MessageMediaDocument) {
                // Otherwise try downloading original channel media's thumbnail
                const doc = msg.media.document as Api.Document;
                if (doc.thumbs && doc.thumbs.length > 0) {
                    try {
                        const largestThumb = doc.thumbs[doc.thumbs.length - 1]; // Use largest thumb
                        await client.downloadMedia(msg, {
                            thumb: largestThumb,
                            outputFile: thumbPath
                        });
                        hasThumb = fs.existsSync(thumbPath);
                    } catch (e) {
                        console.error("Thumbnail download failed:", e);
                    }
                }
            }

            let lastUpdate = 0;
            const downloadStartTime = Date.now();
            
            // Download to disk instead of buffer for stability on large files
            await sleep(3000 + Math.random() * 2000);
            await client.downloadMedia(msg, {
                workers: downloadWorkers, 
                outputFile: tempFilePath,
                dcId: msg.media && (msg.media as any).document ? (msg.media as any).document.dcId : undefined,
                requestRetry: 5,
                progressCallback: (current, total) => {
                    const now = Date.now();
                    if (now - lastUpdate > 2000) { // 2s throttle
                        lastUpdate = now;
                        const text = createProgressBar(Number(total || fileStats.size), Number(current), "Downloading", downloadStartTime);
                        safeEditMessage(text, { 
                            chat_id: chatId, 
                            message_id: statusMsgId,
                            parse_mode: 'Markdown'
                        });
                    }
                }
            } as any);

            const fileStats = fs.statSync(tempFilePath);
            if (fileStats.size === 0) throw new Error("Downloaded file is empty.");

            await safeEditMessage(`📤 **Uploading via High-Speed Channel...**\n_Engine: ${currentUploadEngine}_`, { chat_id: chatId, message_id: statusMsgId });

            let caption = applyRenameRules(msg.message || "");
            if (userDoc?.customCaptionTemplate) {
                const template = userDoc.customCaptionTemplate;
                if (template.includes("{original}")) {
                    caption = template.replace("{original}", caption);
                } else {
                    caption = `${caption}\n\n${template}`;
                }
            }
            let uploadLastUpdate = 0;
            const uploadStartTime = Date.now();
            const totalSize = fileStats.size;

            // Manual chunked upload for maximum reliability
            const uploadedFile = await client.uploadFile({
                file: new CustomFile(filename, totalSize, tempFilePath),
                workers: uploadWorkers,
                onProgress: (current: any) => {
                    const now = Date.now();
                    if (now - uploadLastUpdate > 2000) { // 2s throttle
                        uploadLastUpdate = now;
                        const text = createProgressBar(Number(totalSize), Number(current), "Uploading", uploadStartTime);
                        safeEditMessage(text, { 
                            chat_id: chatId, 
                            message_id: statusMsgId,
                            parse_mode: 'Markdown'
                        });
                    }
                }
            });

            await safeEditMessage("🚀 **Finalizing transmission...**", { chat_id: chatId, message_id: statusMsgId });

            try {
                const attributes: any[] = [];
                if (filename !== "file") {
                    attributes.push(new Api.DocumentAttributeFilename({ fileName: filename }));
                }

                // If it's a video and upload mode is video, add video attributes to ensure it's playable in TG
                const isVideo = filename.toLowerCase().match(/\.(mp4|mkv|mov|avi)$/);
                const isDocumentMode = userDoc?.uploadMode === 'document';
                if (isVideo && !isDocumentMode) {
                    attributes.push(new Api.DocumentAttributeVideo({
                        duration: 0,
                        w: 0,
                        h: 0,
                        supportsStreaming: true
                    }));
                }

                await client.sendFile(uploadTarget, {
                    file: uploadedFile,
                    caption: caption,
                    workers: uploadWorkers,
                    attributes: attributes,
                    thumb: hasThumb ? thumbPath : undefined,
                    replyTo: threadId,
                } as any);
            } catch (sendErr: any) {
                if (sendErr.message.includes('PEER_ID_INVALID')) {
                    const destPeer = await safelyResolveEntity(client, uploadTarget).catch(() => uploadTarget);
                    await client.sendFile(destPeer, {
                        file: uploadedFile,
                        caption: caption,
                        workers: uploadWorkers,
                        attributes: [new Api.DocumentAttributeFilename({ fileName: filename })],
                        thumb: hasThumb ? thumbPath : undefined,
                        replyTo: threadId,
                    } as any);
                } else {
                    throw sendErr;
                }
            }

            // Cleanup temp files
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            if (hasThumb && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

            await safeEditMessage("🎯 **Successfully sent to your chat!**", { chat_id: chatId, message_id: statusMsgId });
            return true;
        } catch (err: any) {
            console.error("Link Process Error:", err);
            let errMsg = err.message;
            if (errMsg.includes("CHANNEL_INVALID")) errMsg = "Channel not found. Ensure Userbot is a member of the group.";
            await safeEditMessage(`❌ **Failed:** ${errMsg}`, { chat_id: chatId, message_id: statusMsgId });
            return false;
        }
    };

    bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const fromId = msg.from?.id;
      const text = msg.text;

      // Intercept states early to allow non-text actions (like setting custom thumbnail image)
      if (fromId && userActionStates[fromId]) {
          const state = userActionStates[fromId];

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
                  if (approvedUsersCollection) {
                      await approvedUsersCollection.updateOne(
                          { userId: fromId.toString() },
                          { $set: { customThumbnailFileId: fileId } }
                      );
                  }
                  // Download locally as well just in case
                  const userCustomThumbPath = path.join(os.tmpdir(), `custom_thumb_${fromId}.jpg`);
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
              if (textInput.toLowerCase() === 'clear' || textInput.toLowerCase() === 'reset') {
                  if (approvedUsersCollection) {
                      await approvedUsersCollection.updateOne(
                          { userId: fromId.toString() },
                          { $unset: { customCaptionTemplate: "" } }
                      );
                  }
                  safeSendMessage(chatId, `✅ **Custom Caption Template Cleared.** Settings restored to default.`);
              } else {
                  if (approvedUsersCollection) {
                      await approvedUsersCollection.updateOne(
                          { userId: fromId.toString() },
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
                      // Prevent duplicates
                      globalRenameRules = globalRenameRules.filter(r => r.keyword.toLowerCase() !== keyword.toLowerCase());
                      globalRenameRules.push({ keyword, replaceWith });
                      
                      if (settingsCollection) {
                          await settingsCollection.updateOne(
                              { type: 'global_config' }, 
                              { $set: { renameRules: globalRenameRules } }, 
                              { upsert: true }
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
      }

      if (!text) return;
      if (text.startsWith('/')) return;

      // Handle Interactive Actions (Batch, Mirror, Login)
      if (fromId && userActionStates[fromId]) {
          const state = userActionStates[fromId];
          
          if (state.type === 'set_path') {
              const text = msg.text || '';
              let targetId = '';

              if (msg.forward_from_chat) {
                  targetId = msg.forward_from_chat.id.toString();
              } else if (text.startsWith('https://t.me/')) {
                  const parts = text.split('/');
                  targetId = parts[parts.length - 1];
              } else if (text.startsWith('-100') || /^\d+$/.test(text)) {
                  targetId = text;
              }

              if (targetId) {
                  delete userActionStates[fromId];
                  if (approvedUsersCollection) {
                      await approvedUsersCollection.updateOne({ userId: fromId.toString() }, { $set: { uploadPath: targetId } });
                  }
                  safeSendMessage(chatId, `✅ **Path Saved!**\nFiles will now be uploaded to: \`${targetId}\`\n\n_Note: Ensure the Userbot is a member of that chat._`, { parse_mode: 'Markdown' });
                  handleSettings(chatId, fromId);
              } else {
                  safeSendMessage(chatId, "❌ **Invalid Input.**\nPlease forward a message or send a valid Group/Channel link.");
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
                      const userDoc = await approvedUsersCollection.findOne({ userId: fromId.toString() });
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

                      const finalPaths = filtered.slice(-16);

                      await approvedUsersCollection.updateOne(
                          { userId: fromId.toString() },
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
                  const userDoc = await approvedUsersCollection?.findOne({ userId: fromId.toString() });
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

              const userDoc = await approvedUsersCollection?.findOne({ userId: fromId.toString() });
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
              delete userActionStates[fromId];
              
              await safeSendMessage(chatId, `📂 **Starting Specific Topic Clone...**\nSource Group: \`${sourceGroupId}\`\nTopic ID: \`${topicId}\``);
              
              try {
                  const client = await getConnectedUserbotClient(fromId);
                  if (!client) throw new Error("Your Userbot session is not active. Please /login first.");
                  
                  const sourceEntity = await client.getEntity(sourceGroupId);
                  const userDoc = await approvedUsersCollection?.findOne({ userId: fromId.toString() });
                  
                  const destPath = userDoc?.uploadPath;
                  if (!destPath) {
                      throw new Error("No general upload destination set. Please configure your upload path first under settings or /setpath.");
                  }
                  
                  const sourceIdRaw = (sourceEntity as any).id?.toString() || "";
                  const sourceIdClean = sourceIdRaw.replace('-100', '');

                  // Fetch messages in this topic (up to 500)
                  const messages: any = await client.getMessages(sourceEntity, {
                      limit: 500,
                      replyTo: topicId
                  });

                  if (!messages || messages.length === 0) {
                      throw new Error("No messages found inside this topic, or topic ID is invalid.");
                  }

                  // Sort messages chronologically (oldest to newest)
                  messages.sort((a: any, b: any) => a.id - b.id);

                  let queuedCount = 0;
                  for (const m of messages) {
                      if (m.action) continue; // Skip service messages
                      if (!m.message && !m.media) continue; // Skip empty messages with no content and no media

                      const virtualLink = `https://t.me/c/${sourceIdClean}/${m.id}`;
                      
                      taskQueue.push({ 
                          chatId, 
                          link: virtualLink, 
                          userId: fromId,
                          forceGeneralPath: true
                      });
                      queuedCount++;
                  }

                  if (!isTaskRunning) runNextTask();
                  safeSendMessage(chatId, `✅ Added **${queuedCount}** items from Topic ID \`${topicId}\` to copy queue for general destination path: \`${destPath}\`.`);
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
                  const client = await getConnectedUserbotClient(fromId);
                  if (!client) throw new Error("Disconnected.");
                  
                  const sourceEntity = await client.getEntity(sourceTarget);
                  const userDoc = await approvedUsersCollection?.findOne({ userId: fromId.toString() });
                  
                  const sourceIdRaw = (sourceEntity as any).id?.toString() || "";
                  const sourceIdClean = sourceIdRaw.replace('-100', '');
                  const mirrorPath = userDoc?.mirrorPaths?.find((p: any) => 
                      p.sourceId === sourceIdClean || p.sourceId === `-100${sourceIdClean}` || sourceIdClean === p.sourceId.replace('-100', '')
                  );

                  const destId = mirrorPath ? mirrorPath.destId : userDoc?.uploadPath;
                  if (!destId) throw new Error("Please set a Destination Path first.");

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
                              overrideThreadId: mirrorPath?.destThreadId ? Number(mirrorPath.destThreadId) : undefined
                          });
                      }
                  }
                  if (!isTaskRunning) runNextTask();
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
                      const summaryMsg = await safeSendMessage(chatId, `⏳ **Initializing Batch Process...**\nLinks: \`${count}\` requested.`, { parse_mode: 'Markdown' });
                      if (summaryMsg) {
                          await bot?.pinChatMessage(chatId, summaryMsg.message_id).catch(() => {});
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

                      await safeSendMessage(chatId, `✅ **Batch Accepted!**\nProcessing \`${count}\` links. The summary has been pinned above.`);
                      
                      for (let i = startId; i <= endId; i++) {
                          const link = `${baseUrl}${i}`;
                          taskQueue.push({ chatId, link, batchId, userId: fromId });
                      }
                      
                      if (!isTaskRunning) runNextTask();

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
        if (!isAdmin(fromId)) {
            delete loginStates[fromId];
            return;
        }
        const state = loginStates[fromId];
        const val = text?.trim();
        if (!val) return;

        // Existing resolvers (OTP or Password)
        if (state.resolvePhoneCode) {
            const resolve = state.resolvePhoneCode;
            delete state.resolvePhoneCode;
            // Simulate human typing delay (1s to 3s)
            await sleep(Math.random() * 2000 + 1000);
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
                const phone = val;
                
                // Ensure API ID and Hash are set for this user context
                // If not, we might need to ask the user, but for now just use globals
                if (!apiIdValue || !apiHashValue) {
                     safeSendMessage(chatId, "❌ **API ID or API HASH not configured.** Please set them using `/setapiid` and `/setapihash`.");
                     delete loginStates[fromId];
                     return;
                }

                const models = ["iPhone 15 Pro", "iPhone 13", "Android 14", "Pixel 8 Pro", "Samsung S23"];
                const device = models[Math.floor(Math.random() * models.length)];
                
                const client = new TelegramClient(new StringSession(""), apiIdValue, apiHashValue, { 
                    connectionRetries: 5,
                    timeout: 300000,
                    deviceModel: device,
                    systemVersion: "iOS 17.5",
                    appVersion: "10.0.0",
                    langCode: "en", 
                    floodSleepThreshold: 300,
                    systemLangCode: "hi-IN"
                });
                state.client = client;
                state.phone = phone;

                // Human-like delay before starting the flow
                await sleep(Math.random() * 2000 + 1000);

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
                    onError: (err) => {
                        console.error(`[Login] Error for ${fromId}:`, err);
                        console.error(`[Login] Error Details: ${JSON.stringify(err)}`);
                        let msg = err.message;
                        if (msg.includes('PHONE_CODE_EXPIRED') || msg.includes('AUTH_KEY_UNREGISTERED')) {
                            msg = "The authentication code has expired or is invalid. Please type /login again to request a new one.";
                        } else if (msg.includes('SESSION_PASSWORD_NEEDED')) {
                            msg = "2FA Password is required on your Telegram account.";
                        }
                        safeSendMessage(chatId, `❌ **Process Failed:** ${msg}`);
                        state.client?.disconnect();
                        delete loginStates[fromId];
                    }
                }).then(async () => {
                    const session = client.session.save() as unknown as string;
                    userSessions.set(fromId, session);
                    userClients.set(fromId, client);
                    
                    if (approvedUsersCollection) {
                        await approvedUsersCollection.updateOne(
                            { userId: fromId.toString() }, 
                            { $set: { stringSession: session, lastLogin: new Date() } }, 
                            { upsert: true }
                        );
                    }
                    safeSendMessage(chatId, "✅ **Successfully Logged In!** This session is isolated to your account.");
                    // Warm up entity cache immediately after login
                    await client.getDialogs({ limit: 40 }).catch(() => {});
                    safeSendMessage(chatId, "✨ **Setup Complete!** You can now send restricted links.");
                    delete loginStates[fromId];
                }).catch((err) => {
                    if (loginStates[fromId]) {
                        console.error(`[Login] Catch Error for ${fromId}:`, err);
                        console.error(`[Login] Error Details: ${JSON.stringify(err)}`);
                        let msg = err.message;
                        if (msg.includes('PHONE_CODE_EXPIRED') || msg.includes('AUTH_KEY_UNREGISTERED')) {
                            msg = "The authentication code has expired or is invalid. Please type /login again to request a new one.";
                        } else if (msg.includes('SESSION_PASSWORD_NEEDED')) {
                            msg = "2FA Password is required on your Telegram account.";
                        }
                        safeSendMessage(chatId, `❌ **Authentication Error:** ${msg}`);
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

        if (!isTaskRunning) {
            runNextTask();
        } else {
            const options: any = { parse_mode: 'Markdown' };
            if (msg.message_thread_id) options.message_thread_id = msg.message_thread_id;
            safeSendMessage(msg.chat.id, `⌛ **Queued:** Added ${links.length} task(s) to the processing queue.\n\n_Total items waiting: ${taskQueue.length}_`, options);
        }
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

app.post('/api/settings', async (req, res) => {
  if (!settingsCollection) return res.status(503).json({ error: 'Database not ready' });
  const { adminId, stringSession, destinationChatId: newDestId, apiId: newApiId, apiHash: newApiHash, downloadLibrary, renameRules } = req.body;
  try {
    const updateData: any = {};
    if (adminId) updateData.adminId = adminId;
    if (stringSession) updateData.stringSession = stringSession;
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

// Silence TOPIC_CLOSED unhandled rejections as they are handled in safeSendMessage
process.on('unhandledRejection', (reason) => {
    const r = reason as any;
    if (r?.message?.includes('TOPIC_CLOSED') || r?.message?.includes('message thread not found')) {
        return;
    }
    console.error('Unhandled Rejection:', reason);
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
