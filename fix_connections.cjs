const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

// 1. safelyResolveFullEntity guard
content = content.replace(
    /return await client\.getEntity\(peer\);/g,
    `await ensureClientConnected(client);\n        return await client.getEntity(peer);`
);

// 2. processTask getMessages guard (source)
content = content.replace(
    /const messages = await sourceClient\.getMessages\(sourcePeer, \{ ids: \[linkData\.msgId\] \}\);/g,
    `await ensureClientConnected(sourceClient);\n                    const messages = await sourceClient.getMessages(sourcePeer, { ids: [linkData.msgId] });`
);

// 3. processTask getMessages guard (dest)
content = content.replace(
    /const destMessages = await destClient\.getMessages\(destSourcePeer, \{ ids: \[linkData\.msgId\] \}\);/g,
    `await ensureClientConnected(destClient);\n                        const destMessages = await destClient.getMessages(destSourcePeer, { ids: [linkData.msgId] });`
);

// 4. processTask ForwardMessages guard
content = content.replace(
    /const forwardResult = await destClient\.invoke\(new Api\.messages\.ForwardMessages\(\{/g,
    `await ensureClientConnected(destClient);\n                        const forwardResult = await destClient.invoke(new Api.messages.ForwardMessages({`
);

// 5. processTask sendMessage guard
content = content.replace(
    /await destClient\.sendMessage\(finalDestPeer, \{ message: applyRenameRules\(msg\.message \|\| "", customRules\), replyTo: threadId \}\);/g,
    `await ensureClientConnected(destClient);\n                await destClient.sendMessage(finalDestPeer, { message: applyRenameRules(msg.message || "", customRules), replyTo: threadId });`
);

// 6. downloadMedia guards
content = content.replace(
    /await sourceClient\.downloadMedia\(msg, \{ thumb: largestThumb, outputFile: thumbPath \}\);/g,
    `await ensureClientConnected(sourceClient);\n                        await sourceClient.downloadMedia(msg, { thumb: largestThumb, outputFile: thumbPath });`
);

// 7. uploadFile guard
content = content.replace(
    /const uploadedFile = await destClient\.uploadFile\(\{/g,
    `await ensureClientConnected(destClient);\n                    const uploadedFile = await destClient.uploadFile({`
);

fs.writeFileSync('server.ts', content);
console.log("Connection guards applied.");
