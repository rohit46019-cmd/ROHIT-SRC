const fs = require('fs');

let content = fs.readFileSync('server.ts', 'utf8');

content = content.replace(/let uploadAgentDisplay = '👤 UserBot \(Your Account\)';\s*if \(userDoc\?\.uploadAgent === 'bot'\) \{\s*uploadAgentDisplay = '🤖 Bot Account \(Self\)';\s*\}/g, "let uploadAgentDisplay = '🤖 Bot Account (Self)';");

content = content.replace(/\{\s*text:\s*userDoc\?\.uploadAgent === 'bot' \? '🤖 Switch to UserBot' : '👤 Switch to Bot',\s*callback_data:\s*'toggle_agent'\s*\}\s*,?/g, "");

content = content.replace(/const agentLabel = \(userDoc\?\.uploadAgent === 'bot'\) \? 'Bot Account' : 'UserBot Account';/g, "const agentLabel = 'Bot Account';");

content = content.replace(/userDoc\?\.uploadAgent === 'bot'/g, "true");

content = content.replace(/if \(query\.data === 'toggle_agent'\) \{[\s\S]*?return;\s*\}/, "");

fs.writeFileSync('server.ts', content);
console.log("Replaced successfully!");
