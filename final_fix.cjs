const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

// 1. Make getConnectedBotClient more robust
content = content.replace(
    /if \(connectedBotClient && connectedBotClient\.connected\) \{\s*return connectedBotClient;\s*\}/,
    `if (connectedBotClient) {
        if (connectedBotClient.connected) return connectedBotClient;
        try {
            await connectedBotClient.connect();
            if (connectedBotClient.connected) return connectedBotClient;
        } catch (e) {
            console.warn("[getConnectedBotClient] Failed to reconnect existing client, creating new one.");
        }
    }`
);

// 2. Ensure settings display reflects forced Bot agent
content = content.replace(
    /let uploadAgentDisplay = '🤖 Bot Account \(Self\)';/g,
    "let uploadAgentDisplay = '🤖 Bot Account (Forced)'; // UserBot upload disabled by admin"
);

// 3. Update instructions in /settings message
content = content.replace(
    /`🤖 𝗔𝗴𝗲𝗻𝘁: \${uploadAgentDisplay}\\n` \+/g,
    "`🤖 𝗔𝗴𝗲𝗻𝘁: Bot Account (Forced)\\n` +"
);

content = content.replace(
    /`└ \*UserBot uses your ID\. Bot Account uses this Bot itself\.\*\\n\\n` \+/g,
    "`└ *Bot Account is forced for all uploads.*\\n\\n` +"
);

fs.writeFileSync('server.ts', content);
console.log("Final UI and connection fixes applied.");
