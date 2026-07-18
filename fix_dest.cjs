const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

// Replace the ternary (chatId < 0 ? chatId.toString() : "") with just chatId.toString()
content = content.replace(/\(chatId < 0 \? chatId\.toString\(\) : ""\)/g, "chatId.toString()");

// Remove the throws that happen if no destination is set
content = content.replace(/if \(!destPath\) \{\s*throw new Error\("No destination path configured\. Please set an upload path in \/settings or use a mirror binding\."\);\s*\}/g, "if (!destPath) { destPath = chatId.toString(); }");
content = content.replace(/if \(!uploadTarget\) \{\s*throw new Error\("No destination path configured\. Please set an upload path in \/settings or use a mirror binding\."\);\s*\}/g, "if (!uploadTarget) { uploadTarget = chatId.toString(); }");
content = content.replace(/if \(!destId\) \{\s*throw new Error\("No destination path configured\. Please configure an upload path in \/settings or use a mirror binding\."\);\s*\}/g, "if (!destId) { destId = chatId.toString(); }");

fs.writeFileSync('server.ts', content);
console.log("Destination logic updated.");
