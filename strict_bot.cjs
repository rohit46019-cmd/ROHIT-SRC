const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

// Pattern 1: forwardingClient assignment in mirror topics
content = content.replace(
    /if \(true\) \{\s*const botClient = await getConnectedBotClient\(\);\s*if \(botClient\) \{\s*forwardingClient = botClient;/g,
    `if (true) {
                          const botClient = await getConnectedBotClient();
                          if (!botClient) throw new Error("Bot client not available for forced bot mirroring.");
                          forwardingClient = botClient;`
);

// Pattern 2: forwardingClient assignment in specific topic clone
content = content.replace(
    /if \(true\) \{\s*const botClient = await getConnectedBotClient\(\);\s*if \(botClient\) \{\s*forwardingClient = botClient;/g,
    `if (true) {
                        const botClient = await getConnectedBotClient();
                        if (!botClient) throw new Error("Bot client not available for forced bot mirroring.");
                        forwardingClient = botClient;`
);

fs.writeFileSync('server.ts', content);
console.log("Strict bot requirement applied.");
