const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

content = content.replace(
    /let uploadAgentDisplay = '👤 UserBot \(Your Account\)';\s*if \(true\) \{\s*uploadAgentDisplay = '🤖 Bot Account \(Self\)';\s*\}/g,
    "let uploadAgentDisplay = '🤖 Bot Account (Self)';"
);

// also let's make sure the toggle_agent button was removed.
content = content.replace(
    /\{\s*text:\s*true \? '🤖 Switch to UserBot' : '👤 Switch to Bot',\s*callback_data:\s*'toggle_agent'\s*\}\s*,?/g,
    ""
);

fs.writeFileSync('server.ts', content);
console.log("Done");
