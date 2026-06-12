const fs = require('fs');

let code = fs.readFileSync('server.ts', 'utf8');

// We want to replace patterns like:
// await safeEditMessage(...);
// bot?.answerCallbackQuery(query.id);
// 
// WITH:
// bot?.answerCallbackQuery(query.id).catch(()=>{});
// await safeEditMessage(...);

// Regex to find await and then answerCallbackQuery(query.id);
let newCode = code.replace(/(await\s+(?:safeEditMessage|bot\?\.sendMessage|bot\?\.editMessage)[^{]*?);?\s*(bot\?\.answerCallbackQuery\(query\.id\);)/gs, '$2\n$1;');

if (newCode !== code) {
    fs.writeFileSync('server.ts', newCode);
    console.log("Replaced instances successfully.");
} else {
    console.log("No instances found.");
}
