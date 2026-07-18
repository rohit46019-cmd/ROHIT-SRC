const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

// Location 1: 4134-4146 area
// We look for the pattern where we have two consecutive closing braces that are improperly nested
// Or specifically the one we created.
const pattern1 = /if \(true\) \{\s*const botClient = await getConnectedBotClient\(\);\s*if \(!botClient\) throw new Error\("Bot client not available for forced bot mirroring\."\);\s*forwardingClient = botClient;\s*\/\/ Re-resolve entities for Bot client\s*try \{\s*fSourceEntity = await safelyResolveFullEntity\(forwardingClient, sourceEntity\);\s*fDestEntity = await safelyResolveFullEntity\(forwardingClient, dest\.destId\);\s*\} catch \(e\) \{\s*console\.warn\("\[BulkForward\] Bot failed to resolve source\/dest, falling back to user client entities:", e\.message\);\s*\}\s*\}\s*\}/;

const replacement1 = `if (true) {
                          const botClient = await getConnectedBotClient();
                          if (!botClient) throw new Error("Bot client not available for forced bot mirroring.");
                          forwardingClient = botClient;
                               // Re-resolve entities for Bot client
                               try {
                                   fSourceEntity = await safelyResolveFullEntity(forwardingClient, sourceEntity);
                                   fDestEntity = await safelyResolveFullEntity(forwardingClient, dest.destId);
                               } catch (e) {
                                   console.warn("[BulkForward] Bot failed to resolve source/dest, falling back to user client entities:", e.message);
                               }
                       }`;

if (content.match(pattern1)) {
    content = content.replace(pattern1, replacement1);
    console.log("Fixed Location 1");
} else {
    console.log("Pattern 1 not found");
}

// Location 2: 9146-9158 area
const pattern2 = /if \(true\) \{\s*const botClient = await getConnectedBotClient\(\);\s*if \(!botClient\) throw new Error\("Bot client not available for forced bot mirroring\."\);\s*forwardingClient = botClient;\s*\/\/ Re-resolve entities for Bot client\s*try \{\s*fSourceEntity = await safelyResolveFullEntity\(forwardingClient, resolvedSourceId\);\s*fDestEntity = await safelyResolveFullEntity\(forwardingClient, resolvedDestId\);\s*\} catch \(e\) \{\s*console\.warn\("\[BulkForward Topic\] Bot failed to resolve source\/dest:", e\.message\);\s*\}\s*\}\s*\}/;

const replacement2 = `if (true) {
                          const botClient = await getConnectedBotClient();
                          if (!botClient) throw new Error("Bot client not available for forced bot mirroring.");
                          forwardingClient = botClient;
                             // Re-resolve entities for Bot client
                             try {
                                 fSourceEntity = await safelyResolveFullEntity(forwardingClient, resolvedSourceId);
                                 fDestEntity = await safelyResolveFullEntity(forwardingClient, resolvedDestId);
                             } catch (e) {
                                 console.warn("[BulkForward Topic] Bot failed to resolve source/dest:", e.message);
                             }
                        }`;

if (content.match(pattern2)) {
    content = content.replace(pattern2, replacement2);
    console.log("Fixed Location 2");
} else {
    console.log("Pattern 2 not found");
}

fs.writeFileSync('server.ts', content);
