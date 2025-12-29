const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const yts = require('yt-search');
const { MongoClient } = require('mongodb');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

// ==================== CONFIGURATION ====================
const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['💥', '👍', '😍', '💗', '🎈', '🎉', '🥳', '😎', '🚀', '🔥'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    ADMIN_LIST_PATH: './admin.json',
    IMAGE_PATH: 'https://files.catbox.moe/0hlvm6.png',
    NEWSLETTER_JIDS: ['120363402434929024@newsletter'],
    NEWSLETTER_REACT_EMOJIS: ['❤️', '🔥', '😀', '👍', '✨'],
    AUTO_REACT_NEWSLETTERS: 'true',
    OWNER_NUMBER: '94742271802',
    CREATOR_NUMBERS: ['94761613328', '94761613328'],
    BOT_NAME: '𝖢𝖧𝖠𝖫𝖠𝖧 𝖬𝖣',
    OWNER_NAME: 'Chalana Induwara',
    TEAM_NAME: 'CHALAH MD MINI BOT V3',
    SAVE_MSG: 'Hi! I noticed your number is not saved. Would you like to save my contact?',
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://chalanainduwara:chalana2009@cluster0.yktata3.mongodb.net/',
    DB_NAME: 'cluster0',
    NEWS_JSON_URL: '',
    CHANNEL_LINK: "https://whatsapp.com/channel/0029Vb6V5Xl6LwHgkapiAI0V/184''
};

// ==================== GLOBAL VARIABLES ====================
const activeSockets = new Map();
const socketCreationTime = new Map();
const sessionHealth = new Map();
const pendingSaves = new Map();
const savedMessages = new Map();
const unsavedContacts = new Set();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
let mongoClient;
let db;
let mongoConnected = false;

// ==================== HELPER FUNCTIONS ====================

// Check if sender is owner
function isOwner(sender) {
    const number = sender.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
    return number === config.OWNER_NUMBER;
}

// Check if sender is creator
function isCreator(sender) {
    const number = sender.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
    return config.CREATOR_NUMBERS.includes(number);
}

// Format message helper
function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

// Get Sri Lanka timestamp
function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

// Create serial
const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

// Capital first letter
function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

// ==================== MONGODB CONNECTION ====================
async function connectToMongoDB() {
    try {
        if (!config.MONGODB_URI) {
            console.log('MongoDB URI not configured, skipping connection');
            return false;
        }

        mongoClient = new MongoClient(config.MONGODB_URI);
        await mongoClient.connect();
        db = mongoClient.db(config.DB_NAME);
        mongoConnected = true;
        console.log('✅ Connected to MongoDB');
        
        // Create collections if they don't exist
        await db.createCollection('sessions').catch(() => {});
        await db.createCollection('messages').catch(() => {});
        await db.createCollection('configs').catch(() => {});
        await db.createCollection('contacts').catch(() => {});
        
        return true;
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error);
        mongoConnected = false;
        return false;
    }
}

// Save session to MongoDB
async function saveSessionToMongo(number, sessionData) {
    if (!mongoConnected) return false;
    
    try {
        const collection = db.collection('sessions');
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        await collection.replaceOne(
            { number: sanitizedNumber },
            {
                number: sanitizedNumber,
                sessionData: sessionData,
                lastUpdated: new Date(),
                active: true
            },
            { upsert: true }
        );
        
        console.log(`✅ Saved session for ${sanitizedNumber} to MongoDB`);
        return true;
    } catch (error) {
        console.error('❌ Failed to save session to MongoDB:', error);
        return false;
    }
}

// Restore session from MongoDB
async function restoreSessionFromMongo(number) {
    if (!mongoConnected) return null;
    
    try {
        const collection = db.collection('sessions');
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        const session = await collection.findOne({ 
            number: sanitizedNumber,
            active: true 
        });
        
        if (session && session.sessionData) {
            console.log(`✅ Restored session for ${sanitizedNumber} from MongoDB`);
            return session.sessionData;
        }
        
        return null;
    } catch (error) {
        console.error('❌ Failed to restore session from MongoDB:', error);
        return null;
    }
}

// Save message for anti-delete
async function saveMessageToDb(messageData) {
    if (!mongoConnected) return false;
    
    try {
        const collection = db.collection('messages');
        await collection.insertOne({
            ...messageData,
            savedAt: new Date()
        });
        return true;
    } catch (error) {
        console.error('❌ Failed to save message:', error);
        return false;
    }
}

// Get deleted message
async function getDeletedMessage(messageId, remoteJid) {
    if (!mongoConnected) return null;
    
    try {
        const collection = db.collection('messages');
        const message = await collection.findOne({
            'key.id': messageId,
            'key.remoteJid': remoteJid
        });
        return message;
    } catch (error) {
        console.error('❌ Failed to get deleted message:', error);
        return null;
    }
}

// Load user config from MongoDB
async function loadUserConfig(number) {
    if (!mongoConnected) return { ...config };
    
    try {
        const collection = db.collection('configs');
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        const userConfig = await collection.findOne({ number: sanitizedNumber });
        if (userConfig && userConfig.config) {
            return { ...config, ...userConfig.config };
        }
        
        return { ...config };
    } catch (error) {
        console.error('❌ Failed to load user config:', error);
        return { ...config };
    }
}

// Update user config in MongoDB
async function updateUserConfig(number, newConfig) {
    if (!mongoConnected) return false;
    
    try {
        const collection = db.collection('configs');
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        await collection.replaceOne(
            { number: sanitizedNumber },
            {
                number: sanitizedNumber,
                config: newConfig,
                lastUpdated: new Date()
            },
            { upsert: true }
        );
        
        console.log(`✅ Updated config for ${sanitizedNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Failed to update config:', error);
        return false;
    }
}

// Save unsaved contact
async function saveUnsavedContact(number, name = '') {
    if (!mongoConnected) return false;
    
    try {
        const collection = db.collection('contacts');
        await collection.insertOne({
            number: number.replace(/[^0-9]/g, ''),
            name: name || 'Unknown',
            savedAt: new Date()
        });
        return true;
    } catch (error) {
        console.error('❌ Failed to save contact:', error);
        return false;
    }
}

// Get unsaved contacts
async function getUnsavedContacts() {
    if (!mongoConnected) return [];
    
    try {
        const collection = db.collection('contacts');
        const contacts = await collection.find({}).toArray();
        return contacts;
    } catch (error) {
        console.error('❌ Failed to get contacts:', error);
        return [];
    }
}

// Get MongoDB session count
async function getMongoSessionCount() {
    if (!mongoConnected) return 0;
    
    try {
        const collection = db.collection('sessions');
        const count = await collection.countDocuments({ active: true });
        return count;
    } catch (error) {
        console.error('❌ Failed to get session count:', error);
        return 0;
    }
}

// Delete session from MongoDB
async function deleteSessionFromMongo(number) {
    if (!mongoConnected) return false;
    
    try {
        const collection = db.collection('sessions');
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        await collection.updateOne(
            { number: sanitizedNumber },
            { $set: { active: false } }
        );
        
        console.log(`✅ Marked session as inactive for ${sanitizedNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Failed to delete session:', error);
        return false;
    }
}

// Clean duplicate sessions
async function cleanDuplicateSessions() {
    if (!mongoConnected) return;
    
    try {
        const collection = db.collection('sessions');
        const sessions = await collection.find({}).toArray();
        
        const uniqueSessions = new Map();
        for (const session of sessions) {
            if (!uniqueSessions.has(session.number) || 
                session.lastUpdated > uniqueSessions.get(session.number).lastUpdated) {
                uniqueSessions.set(session.number, session);
            }
        }
        
        // Delete all and reinsert unique ones
        await collection.deleteMany({});
        if (uniqueSessions.size > 0) {
            await collection.insertMany(Array.from(uniqueSessions.values()));
        }
        
        console.log(`✅ Cleaned duplicate sessions, kept ${uniqueSessions.size} unique sessions`);
    } catch (error) {
        console.error('❌ Failed to clean duplicate sessions:', error);
    }
}

// ==================== MEDIA FUNCTIONS ====================
async function downloadAndSaveMedia(message, type) {
    try {
        const buffer = await downloadMediaMessage(message, 'buffer', {});
        return buffer;
    } catch (error) {
        console.error('Failed to download media:', error);
        return null;
    }
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

// ==================== NEWSLETTER FUNCTIONS ====================
async function setupNewsletterHandlers(socket, userConfig) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;
        
        const jid = message.key.remoteJid;
        if (!userConfig.NEWSLETTER_JIDS.includes(jid)) return;
        
        if (userConfig.AUTO_REACT_NEWSLETTERS !== 'true') return;
        
        try {
            const emojis = userConfig.NEWSLETTER_REACT_EMOJIS || config.NEWSLETTER_REACT_EMOJIS;
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;
            
            if (!messageId) return;
            
            await socket.newsletterReactMessage(
                jid,
                messageId.toString(),
                randomEmoji
            );
            
            console.log(`✅ Reacted to newsletter message ${messageId} with ${randomEmoji}`);
        } catch (error) {
            console.error('Newsletter reaction error:', error);
        }
    });
}

// Auto follow newsletters
async function autoFollowNewsletters(socket, newsletters) {
    for (const jid of newsletters) {
        try {
            // Check if already following
            const isFollowing = await socket.newsletterIsFollowing?.(jid).catch(() => false);
            
            if (!isFollowing) {
                await socket.newsletterFollow(jid);
                console.log(`✅ Auto-followed newsletter: ${jid}`);
            } else {
                console.log(`📰 Already following newsletter: ${jid}`);
            }
        } catch (error) {
            console.error(`❌ Failed to follow newsletter ${jid}:`, error.message);
        }
    }
}

// ==================== STATUS HANDLERS ====================
async function setupStatusHandlers(socket, userConfig) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || 
            !message.key.participant) return;
        
        try {
            if (userConfig.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }
            
            if (userConfig.AUTO_VIEW_STATUS === 'true') {
                await socket.readMessages([message.key]);
            }
            
            if (userConfig.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = userConfig.AUTO_LIKE_EMOJI[
                    Math.floor(Math.random() * userConfig.AUTO_LIKE_EMOJI.length)
                ];
                await socket.sendMessage(
                    message.key.remoteJid,
                    { react: { text: randomEmoji, key: message.key } },
                    { statusJidList: [message.key.participant] }
                );
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

// Continue in Part 2...




// ==================== COMMAND HANDLERS ====================
// ==================== COMMAND HANDLERS ====================
async function setupCommandHandlers(socket, number) {
    const userConfig = await loadUserConfig(number);
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        
        // Save all messages for anti-delete
        if (mongoConnected) {
            await saveMessageToDb({
                key: msg.key,
                message: msg.message,
                pushName: msg.pushName,
                participant: msg.participant
            });
        }
        
        // Check for unsaved contacts - FIXED VERSION
        const sender = msg.key.remoteJid;
        const senderNumber = sender.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
        
        // Only process for personal chats, not groups
        if (!msg.key.fromMe && sender.endsWith('@s.whatsapp.net')) {
            try {
                // Check if number exists on WhatsApp - CORRECT METHOD
                const [result] = await socket.onWhatsApp(senderNumber);
                
                if (result && result.exists) {
                    // Check if we haven't already processed this contact
                    if (!unsavedContacts.has(senderNumber)) {
                        // Check if contact is in our phone contacts
                        const contact = await socket.getContact(sender);
                        
                        // If contact doesn't have a name or has default name, it's likely not saved
                        if (!contact || !contact.name || contact.name === contact.notify) {
                            unsavedContacts.add(senderNumber);
                            await saveUnsavedContact(senderNumber, msg.pushName);
                            
                            // Send save message
                            await socket.sendMessage(sender, {
                                text: userConfig.SAVE_MSG || config.SAVE_MSG
                            });
                            
                            // Send owner VCF
                            const ownerVCard = `BEGIN:VCARD\nVERSION:3.0\nFN:${config.OWNER_NAME}\nTEL;type=CELL;type=VOICE;waid=${config.OWNER_NUMBER}:+${config.OWNER_NUMBER}\nEND:VCARD`;
                            
                            await socket.sendMessage(sender, {
                                contacts: {
                                    displayName: config.OWNER_NAME,
                                    contacts: [{ vcard: ownerVCard }]
                                }
                            });
                            
                            console.log(`📱 Sent save contact message to ${senderNumber}`);
                        }
                    }
                }
            } catch (error) {
                console.error('Error checking contact:', error);
                // Continue execution even if contact check fails
            }
        }
        
        // React with ✅ for creators
        if (isCreator(sender)) {
            try {
                await socket.sendMessage(sender, { 
                    react: { text: '✅', key: msg.key } 
                });
            } catch (error) {
                console.error('Failed to react to creator message:', error);
            }
        }
        
        // Rest of the command handler code continues...
        let command = null;
        let args = [];
        
        // Parse command
        if (msg.message.conversation || msg.message.extendedTextMessage?.text) {
            const text = (msg.message.conversation || msg.message.extendedTextMessage.text || '').trim();
            if (text.startsWith(userConfig.PREFIX)) {
                const parts = text.slice(userConfig.PREFIX.length).trim().split(/\s+/);
                command = parts[0].toLowerCase();
                args = parts.slice(1);
            }
        }
        
        if (!command) return;
        
        // Continue with command execution...
     
        // Create quoted message helper
        const myquoted = msg;
        
        // Load command from plugins
        const commandFile = path.join(__dirname, 'plugins', `${command}.js`);
        if (fs.existsSync(commandFile)) {
            try {
                const cmdModule = require(commandFile);
                await cmdModule.execute(socket, msg, args, {
                    config: userConfig,
                    isOwner: isOwner(sender),
                    isCreator: isCreator(sender),
                    formatMessage,
                    getSriLankaTimestamp,
                    number,
                    sender,
                    myquoted
                });
                return;
            } catch (error) {
                console.error(`Plugin ${command} error:`, error);
            }
        }
        
        // Built-in commands
        
                
             // Download commands
                case 'ytmp3':
                    if (args.length < 1) {
                        await socket.sendMessage(sender, { text: '❌ Usage: .ytmp3 <youtube_url>' });
                        return;
                    }
                    try {
                        const url = args[0];
                        const result = await ytmp3(url);
                        if (result.success) {
                            await socket.sendMessage(sender, {
                                audio: { url: result.download },
                                mimetype: 'audio/mp4',
                                fileName: `${result.title}.mp3`
                            });
                        } else {
                            await socket.sendMessage(sender, { text: '❌ Failed to download audio' });
                        }
                    } catch (error) {
                        await socket.sendMessage(sender, { text: '❌ Error downloading audio' });
                    }
                    break;

                case 'ytmp4':
                    if (args.length < 1) {
                        await socket.sendMessage(sender, { text: '❌ Usage: .ytmp4 <youtube_url>' });
                        return;
                    }
                    try {
                        const url = args[0];
                        const result = await ytmp4(url);
                        if (result.success) {
                            await socket.sendMessage(sender, {
                                video: { url: result.download },
                                mimetype: 'video/mp4',
                                fileName: `${result.title}.mp4`
                            });
                        } else {
                            await socket.sendMessage(sender, { text: '❌ Failed to download video' });
                        }
                    } catch (error) {
                        await socket.sendMessage(sender, { text: '❌ Error downloading video' });
                    }
                    break;

                case 'tiktok':
                    if (args.length < 1) {
                        await socket.sendMessage(sender, { text: '❌ Usage: .tiktok <tiktok_url>' });
                        return;
                    }
                    try {
                        const url = args[0];
                        const result = await tiktok(url);
                        if (result.success) {
                            if (result.type === 'video') {
                                await socket.sendMessage(sender, {
                                    video: { url: result.download },
                                    mimetype: 'video/mp4',
                                    fileName: `${result.title}.mp4`
                                });
                            } else {
                                await socket.sendMessage(sender, {
                                    image: { url: result.thumbnail },
                                    caption: `*${result.title}*\n\nDownload: ${result.download}`
                                });
                            }
                        } else {
                            await socket.sendMessage(sender, { text: '❌ Failed to download TikTok content' });
                        }
                    } catch (error) {
                        await socket.sendMessage(sender, { text: '❌ Error downloading TikTok content' });
                    }
                    break;

                case 'facebook':
                    if (args.length < 1) {
                        await socket.sendMessage(sender, { text: '❌ Usage: .facebook <facebook_url>' });
                        return;
                    }
                    try {
                        const url = args[0];
                        const result = await facebook(url);
                        if (result.success) {
                            await socket.sendMessage(sender, {
                                video: { url: result.download },
                                mimetype: 'video/mp4',
                                fileName: `${result.title}.mp4`
                            });
                        } else {
                            await socket.sendMessage(sender, { text: '❌ Failed to download Facebook video' });
                        }
                    } catch (error) {
                        await socket.sendMessage(sender, { text: '❌ Error downloading Facebook video' });
                    }
                    break;

                case 'insta':
case 'Instagram':
                    if (args.length < 1) {
                        await socket.sendMessage(sender, { text: '❌ Usage: .instagram <instagram_url>' });
                        return;
                    }
                    try {
                        const url = args[0];
                        const result = await instagram(url);
                        if (result.success) {
                            if (result.type === 'video') {
                                await socket.sendMessage(sender, {
                                    video: { url: result.download },
                                    mimetype: 'video/mp4',
                                    fileName: `${result.title}.mp4`
                                });
                            } else {
                                await socket.sendMessage(sender, {
                                    image: { url: result.download },
                                    caption: `*${result.title}*`
                                });
                            }
                        } else {
                            await socket.sendMessage(sender, { text: '❌ Failed to download Instagram content' });
                        }
                    } catch (error) {
                        await socket.sendMessage(sender, { text: '❌ Error downloading Instagram content' });
                    }
                    break;

                case 'twitter':
                    if (args.length < 1) {
                        await socket.sendMessage(sender, { text: '❌ Usage: .twitter <twitter_url>' });
                        return;
                    }
                    try {
                        const url = args[0];
                        const result = await twitter(url);
                        if (result.success) {
                            if (result.type === 'video') {
                                await socket.sendMessage(sender, {
                                    video: { url: result.download },
                                    mimetype: 'video/mp4',
                                    fileName: `${result.title}.mp4`
                                });
                            } else {
                                await socket.sendMessage(sender, {
                                    image: { url: result.download },
                                    caption: `*${result.title}*`
                                });
                            }
                        } else {
                            await socket.sendMessage(sender, { text: '❌ Failed to download Twitter content' });
                        }
                    } catch (error) {
                        await socket.sendMessage(sender, { text: '❌ Error downloading Twitter content' });
                    }
                    break;
                    
                    
                    case 'alive': {
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    // Greeting by time
    const now = new Date();
    const hour = now.getHours();
    let greeting = "Hello 🌎";
    if (hour >= 5 && hour < 12) greeting = "🌅 Good Morning!";
    else if (hour >= 12 && hour < 17) greeting = "🌞 Good Afternoon!";
    else if (hour >= 17 && hour < 21) greeting = "🌆 Good Evening!";
    else greeting = "🌙 Good Night!";

    await socket.sendMessage(sender, {
        image: { url: config.IMAGE_PATH },
        caption: formatMessage(
            '📡 𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐒𝐓𝐀𝐓𝐔𝐒',
            `${greeting}\n\n` +
            `🤖 *CHALAH MD MINI BOT*: Active\n` +
            `⏰ *Uptime*: ${hours}h ${minutes}m ${seconds}s\n` +
            `🟢 *Active Sessions*: ${activeSockets.size}\n` +
            `🔢 *Your Number*: ${number}\n` +
            `🔄 *Auto-Features*: All Active\n` +
            `☁️ *Storage*: MongoDB (${mongoConnected ? '✅ Connected' : '❌ Connecting...'})\n` +
            `📋 *Pending Saves*: ${pendingSaves.size}`,
            '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
        )
    }, { quoted: myquoted });
    break;
}
           

case 'fallow':
case 'followchannel': {
    try {
        if (!args[0]) {
            return await socket.sendMessage(sender, {
                text: '*❌ Please provide a channel URL or JID*\n\n' +
                      '*Usage:*\n' +
                      '• .follow <channel_url>\n' +
                      '• .follow <channel_jid>\n\n' +
                      '*Example:*\n' +
                      '• .follow https://whatsapp.com/channel/0029VbAua1VK5cDL3AtIEP3I\n' +
                      '• .follow 120363420895783008@newsletter'
            }, { quoted: myquoted });
        }

        const input = args.join(' ').trim();
        let channelJid = '';

        // Check if input is a URL or JID
        if (input.includes('whatsapp.com/channel/')) {
            // Extract channel code from URL
            const channelCodeMatch = input.match(/channel\/([a-zA-Z0-9]+)/);
            if (!channelCodeMatch) {
                return await socket.sendMessage(sender, {
                    text: '*❌ Invalid channel URL format*'
                }, { quoted: myquoted });
            }
            // Convert to potential JID
            channelJid = `${channelCodeMatch[1]}@newsletter`;
        } else if (input.includes('@newsletter')) {
            channelJid = input;
        } else {
            // Assume it's a channel code and add newsletter suffix
            channelJid = `${input}@newsletter`;
        }

        await socket.sendMessage(sender, { react: { text: '➕', key: msg.key } });

        // Try to follow the channel
        try {
            await socket.newsletterFollow(channelJid);

            // Add to config if owner
            if (isOwner(sender)) {
                if (!config.NEWSLETTER_JIDS.includes(channelJid)) {
                    config.NEWSLETTER_JIDS.push(channelJid);

                    const userConfig = await loadUserConfig(number);
                    userConfig.NEWSLETTER_JIDS = config.NEWSLETTER_JIDS;
                    await updateUserConfig(number, userConfig);
                }
            }

            await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

            await socket.sendMessage(sender, {
                image: { url: config.IMAGE_PATH },
                caption: formatMessage(
                    '✅ CHANNEL FOLLOWED',
                    `Successfully followed channel!\n\n` +
                    `*Channel JID:* ${channelJid}\n` +
                    `*Auto-React:* ${config.AUTO_REACT_NEWSLETTERS === 'true' ? '✅ Enabled' : '❌ Disabled'}\n` +
                    (isOwner(sender) ? `*Added to auto-react list:* ✅` : ''),
                    '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
                )
            }, { quoted: myquoted });

        } catch (error) {
            console.error('Follow error:', error);
            await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });

            let errorMessage = 'Failed to follow channel';
            if (error.message.includes('not found')) {
                errorMessage = 'Channel not found or invalid JID';
            } else if (error.message.includes('already')) {
                errorMessage = 'Already following this channel';
            }

            await socket.sendMessage(sender, {
                text: `*❌ ${errorMessage}*\n\nTried JID: ${channelJid}`
            }, { quoted: myquoted });
        }

    } catch (error) {
        console.error('❌ Follow command error:', error);
        await socket.sendMessage(sender, {
            text: `*❌ Error:* ${error.message || 'Failed to follow channel'}`
        }, { quoted: myquoted });
    }
    break;
}

case 'unfollow':
case 'unfollowchannel': {
    try {
        if (!args[0]) {
            return await socket.sendMessage(sender, {
                text: '*❌ Please provide a channel URL or JID*\n\n' +
                      '*Usage:*\n' +
                      '• .unfollow <channel_url>\n' +
                      '• .unfollow <channel_jid>'
            }, { quoted: myquoted });
        }

        const input = args.join(' ').trim();
        let channelJid = '';

        // Check if input is a URL or JID
        if (input.includes('whatsapp.com/channel/')) {
            const channelCodeMatch = input.match(/channel\/([a-zA-Z0-9]+)/);
            if (!channelCodeMatch) {
                return await socket.sendMessage(sender, {
                    text: '*❌ Invalid channel URL format*'
                }, { quoted: myquoted });
            }
            channelJid = `${channelCodeMatch[1]}@newsletter`;
        } else if (input.includes('@newsletter')) {
            channelJid = input;
        } else {
            channelJid = `${input}@newsletter`;
        }

        await socket.sendMessage(sender, { react: { text: '➖', key: msg.key } });

        try {
            await socket.newsletterUnfollow(channelJid);

            // Remove from config if owner
            if (isOwner(sender)) {
                const index = config.NEWSLETTER_JIDS.indexOf(channelJid);
                if (index > -1) {
                    config.NEWSLETTER_JIDS.splice(index, 1);

                    const userConfig = await loadUserConfig(number);
                    userConfig.NEWSLETTER_JIDS = config.NEWSLETTER_JIDS;
                    await updateUserConfig(number, userConfig);
                }
            }

            await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

            await socket.sendMessage(sender, {
                text: `✅ *Successfully unfollowed channel*\n\n*JID:* ${channelJid}`
            }, { quoted: myquoted });

        } catch (error) {
            await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
            await socket.sendMessage(sender, {
                text: `*❌ Failed to unfollow channel*\n\nJID: ${channelJid}`
            }, { quoted: myquoted });
        }

    } catch (error) {
        console.error('❌ Unfollow error:', error);
        await socket.sendMessage(sender, {
            text: `*❌ Error:* ${error.message || 'Failed to unfollow channel'}`
        }, { quoted: myquoted });
    }
    break;
}

 
case 'updatejid': {
                    try {
                        // Get current user's config
                        const userConfig = await loadUserConfig(number);

                        // Update newsletter JIDs
                        userConfig.NEWSLETTER_JIDS = [...config.NEWSLETTER_JIDS];
                        userConfig.NEWSLETTER_REACT_EMOJIS = [...config.NEWSLETTER_REACT_EMOJIS];
                        userConfig.AUTO_REACT_NEWSLETTERS = config.AUTO_REACT_NEWSLETTERS;

                        // Save updated config
                        await updateUserConfig(number, userConfig);

                        // Apply settings
                        applyConfigSettings(userConfig);

                        // Auto-follow new newsletters for active session
                        if (activeSockets.has(number)) {
                            const userSocket = activeSockets.get(number);
                            for (const newsletterJid of config.NEWSLETTER_JIDS) {
                                try {
                                    await userSocket.newsletterFollow(newsletterJid);
                                    console.log(`✅ ${number} followed newsletter: ${newsletterJid}`);
                                } catch (error) {
                                    console.warn(`⚠️ ${number} failed to follow ${newsletterJid}: ${error.message}`);
                                }
                            }
                        }

                        // Send success message
                        await socket.sendMessage(sender, {
                            image: { url: config.IMAGE_PATH },
                            caption: formatMessage(
                                '📝 NEWSLETTER CONFIG UPDATE',
                                `Successfully updated your newsletter configuration!\n\n` +
                                `Current Newsletter JIDs:\n${config.NEWSLETTER_JIDS.join('\n')}\n\n` +
                                `Auto-React: ${config.AUTO_REACT_NEWSLETTERS === 'true' ? '✅ Enabled' : '❌ Disabled'}\n` +
                                `React Emojis: ${config.NEWSLETTER_REACT_EMOJIS.join(', ')}`,
                                '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
                            )
                        }, { quoted: msg });

                    } catch (error) {
                        console.error('❌ Update CJ command failed:', error);
                        await socket.sendMessage(sender, {
                            text: `*❌ Error updating config:*\n${error.message}`
                        }, { quoted: msg });
                    }
                    break;
                }

                case 'jid': {
                    try {
                        let replyJid = '';
                        let caption = '';

                        if (msg.message.extendedTextMessage?.contextInfo?.participant) {
                            replyJid = msg.message.extendedTextMessage.contextInfo.participant;
                        }

                        const mentionedJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;

                        caption = formatMessage(
                            '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐉𝐈𝐃 𝐈𝐍𝐅𝐎',
                            `*Chat JID:* ${sender}\n` +
                            (replyJid ? `*Replied User JID:* ${replyJid}\n` : '') +
                            (mentionedJid?.length ? `*Mentioned JID:* ${mentionedJid.join('\n')}\n` : '') +
                            (msg.key.remoteJid.endsWith('@g.us') ?
                                `*Group JID:* ${msg.key.remoteJid}\n` : '') +
                            `\n*📝 Note:*\n` +
                            `• User JID Format: number@s.whatsapp.net\n` +
                            `• Group JID Format: number@g.us\n` +
                            `• Newsletter JID Format: number@newsletter`,
                            '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
                        );

                        await socket.sendMessage(sender, {
                            image: { url: config.IMAGE_PATH },
                            caption: caption,
                            contextInfo: {
                                mentionedJid: mentionedJid || [],
                                forwardingScore: 999,
                                isForwarded: true
                            }
                        }, { quoted: myquoted });

                    } catch (error) {
                        console.error('❌ GetJID error:', error);
                        await socket.sendMessage(sender, {
                            text: '*Error:* Failed to get JID information'
                        }, { quoted: myquoted });
                    }
                    break;
                }

                case 'addnewsletter': {
                    if (!isOwner(sender)) {
                        return await socket.sendMessage(sender, {
                            text: `*❌ This command is only for the owner.*`
                        }, { quoted: msg });
                    }

                    if (!args[0]) {
                        return await socket.sendMessage(sender, {
                            text: '*Please provide a newsletter JID\nExample: .addnewsletter 120363xxxxxxxxxx@newsletter*'
                        }, { quoted: msg });
                    }

                    const newJid = args[0];
                    if (!newJid.endsWith('@newsletter')) {
                        return await socket.sendMessage(sender, {
                            text: '*❌ Invalid JID format. Must end with @newsletter*'
                        }, { quoted: msg });
                    }

                    if (!config.NEWSLETTER_JIDS.includes(newJid)) {
                        config.NEWSLETTER_JIDS.push(newJid);

                        const userConfig = await loadUserConfig(number);
                        userConfig.NEWSLETTER_JIDS = config.NEWSLETTER_JIDS;
                        userConfig.NEWSLETTER_REACT_EMOJIS = config.NEWSLETTER_REACT_EMOJIS;
                        userConfig.AUTO_REACT_NEWSLETTERS = config.AUTO_REACT_NEWSLETTERS;

                        await updateUserConfig(number, userConfig);
                        applyConfigSettings(userConfig);

                        try {
                            await socket.newsletterFollow(newJid);
                            console.log(`✅ Followed new newsletter: ${newJid}`);

                            await socket.sendMessage(sender, {
                                image: { url: config.IMAGE_PATH },
                                caption: formatMessage(
                                    '✅ NEWSLETTER ADDED & FOLLOWED',
                                    `Successfully added and followed newsletter:\n${newJid}\n\n` +
                                    `Total newsletters: ${config.NEWSLETTER_JIDS.length}\n` +
                                    `Auto-react: ${config.AUTO_REACT_NEWSLETTERS === 'true' ? '✅ Enabled' : '❌ Disabled'}\n` +
                                    `React emojis: ${config.NEWSLETTER_REACT_EMOJIS.join(', ')}`,
                                    '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
                                )
                            }, { quoted: msg });
                        } catch (error) {
                            console.error(`❌ Failed to follow newsletter ${newJid}:`, error.message);

                            await socket.sendMessage(sender, {
                                image: { url: config.IMAGE_PATH },
                                caption: formatMessage(
                                    '⚠️ NEWSLETTER ADDED (Follow Failed)',
                                    `Newsletter added but follow failed:\n${newJid}\n\n` +
                                    `Error: ${error.message}\n` +
                                    `Total newsletters: ${config.NEWSLETTER_JIDS.length}`,
                                    '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 |𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
                                )
                            }, { quoted: msg });
                        }
                    } else {
                        await socket.sendMessage(sender, {
                            text: '*⚠️ This newsletter JID is already in the list.*'
                        }, { quoted: msg });
                    }
                    break;
                }

                case 'listnewsletters': {
                    const userConfig = await loadUserConfig(number);
                    const currentNewsletters = userConfig.NEWSLETTER_JIDS || config.NEWSLETTER_JIDS;

                    const newsletterList = currentNewsletters.map((jid, index) =>
                        `${index + 1}. ${jid}`
                    ).join('\n');

                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH },
                        caption: formatMessage(
                            '📋 AUTO-REACT NEWSLETTER LIST',
                            `Auto-react enabled for:\n\n${newsletterList || 'No newsletters added'}\n\n` +
                            `React Emojis: ${config.NEWSLETTER_REACT_EMOJIS.join(', ')}\n` +
                            `Status: ${config.AUTO_REACT_NEWSLETTERS === 'true' ? '✅ Active' : '❌ Inactive'}\n` +
                            `Total: ${currentNewsletters.length} newsletters`,
                            '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
                        )
                    }, { quoted: msg });
                    break;
                }
                
    
    
case 'removenewsletter': {
                    if (!isOwner(sender)) {
                        return await socket.sendMessage(sender, {
                            text: '*❌ This command is only for the owner.*'
                        }, { quoted: msg });
                    }

                    if (!args[0]) {
                        const newsletterList = config.NEWSLETTER_JIDS.map((jid, index) =>
                            `${index + 1}. ${jid}`
                        ).join('\n');

                        return await socket.sendMessage(sender, {
                            text: `*Please provide a newsletter JID to remove*\n\nCurrent newsletters:\n${newsletterList || 'No newsletters added'}`
                        }, { quoted: msg });
                    }

                    const removeJid = args[0];
                    const index = config.NEWSLETTER_JIDS.indexOf(removeJid);

                    if (index > -1) {
                        config.NEWSLETTER_JIDS.splice(index, 1);

                        const userConfig = await loadUserConfig(number);
                        userConfig.NEWSLETTER_JIDS = config.NEWSLETTER_JIDS;
                        await updateUserConfig(number, userConfig);
                        applyConfigSettings(userConfig);

                        try {
                            await socket.newsletterUnfollow(removeJid);
                            console.log(`✅ Unfollowed newsletter: ${removeJid}`);
                        } catch (error) {
                            console.error(`Failed to unfollow newsletter: ${error.message}`);
                        }

                        await socket.sendMessage(sender, {
                            image: { url: config.IMAGE_PATH },
                            caption: formatMessage(
                                '🗑️ NEWSLETTER REMOVED',
                                `Successfully removed newsletter:\n${removeJid}\n\n` +
                                `Remaining newsletters: ${config.NEWSLETTER_JIDS.length}`,
                                '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
                            )
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '*❌ This newsletter JID is not in the list.*'
                        }, { quoted: msg });
                    }
                    break;
                }

                case 'togglenewsletterreact': {
                    if (!isOwner(sender)) {
                        return await socket.sendMessage(sender, {
                            text: '*❌ This command is only for the owner.*'
                        }, { quoted: msg });
                    }

                    config.AUTO_REACT_NEWSLETTERS = config.AUTO_REACT_NEWSLETTERS === 'true' ? 'false' : 'true';

                    const userConfig = await loadUserConfig(number);
                    userConfig.AUTO_REACT_NEWSLETTERS = config.AUTO_REACT_NEWSLETTERS;
                    userConfig.NEWSLETTER_JIDS = config.NEWSLETTER_JIDS;
                    userConfig.NEWSLETTER_REACT_EMOJIS = config.NEWSLETTER_REACT_EMOJIS;
                    await updateUserConfig(number, userConfig);
                    applyConfigSettings(userConfig);

                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH },
                        caption: formatMessage(
                            '🔄 NEWSLETTER AUTO-REACT TOGGLED',
                            `Newsletter auto-react is now: ${config.AUTO_REACT_NEWSLETTERS === 'true' ? '✅ ENABLED' : '❌ DISABLED'}\n\n` +
                            `Active for ${config.NEWSLETTER_JIDS.length} newsletters`,
                            '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
                        )
                    }, { quoted: msg });
                    break;
                }

                case 'setnewsletteremojis': {
                    if (!isOwner(sender)) {
                        return await socket.sendMessage(sender, {
                            text: '*❌ This command is only for the owner.*'
                        }, { quoted: msg });
                    }

                    if (args.length === 0) {
                        return await socket.sendMessage(sender, {
                            text: `*Please provide emojis*\nCurrent emojis: ${config.NEWSLETTER_REACT_EMOJIS.join(', ')}\n\nExample: .setnewsletteremojis ❤️ 🔥 😍`
                        }, { quoted: msg });
                    }

                    config.NEWSLETTER_REACT_EMOJIS = args;

                    const userConfig = await loadUserConfig(number);
                    userConfig.NEWSLETTER_REACT_EMOJIS = config.NEWSLETTER_REACT_EMOJIS;
                    await updateUserConfig(number, userConfig);
                    applyConfigSettings(userConfig);

                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH },
                        caption: formatMessage(
                            '✅ NEWSLETTER EMOJIS UPDATED',
                            `New react emojis: ${config.NEWSLETTER_REACT_EMOJIS.join(', ')}`,
                            '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
                        )
                    }, { quoted: msg });
                    break;
                }

                case 'song': {
                    try {
                        const ddownr = require('denethdev-ytmp3');

                        function extractYouTubeId(url) {
                            const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
                            const match = url.match(regex);
                            return match ? match[1] : null;
                        }

                        function convertYouTubeLink(input) {
                            const videoId = extractYouTubeId(input);
                            if (videoId) {
                                return `https://www.youtube.com/watch?v=${videoId}`;
                            }
                            return input;
                        }

                        const q = args.join(' ');

                        if (!q || q.trim() === '') {
                            return await socket.sendMessage(sender, { text: '*`Need YT_URL or Title`*' }, { quoted: myquoted });
                        }

                        const fixedQuery = convertYouTubeLink(q.trim());

                        const search = await yts(fixedQuery);
                        if (!search?.videos || search.videos.length === 0) {
                            return await socket.sendMessage(sender, { text: '*`No results found`*' }, { quoted: myquoted });
                        }

                        const data = search.videos[0];
                        if (!data) {
                            return await socket.sendMessage(sender, { text: '*`No results found`*' }, { quoted: myquoted });
                        }

                        const url = data.url;
                        const desc = `
*𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐁𝐎𝐓*


🎶 *Title:* ${data.title} 🎧
🍂 *Duration:* ${data.timestamp}
🔖 *Uploaded On:* ${data.ago}

> © ᴩᴏᴡᴇʀᴅ ʙʏ 𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 |
`;

                        await socket.sendMessage(sender, {
                            image: { url: data.thumbnail },
                            caption: desc,
                            contextInfo: {
                                mentionedJid: [],
                                forwardingScore: 1,
                                isForwarded: true,
                                forwardedNewsletterMessageInfo: {
                                    newsletterJid: '120363402434929024@newsletter',
                                    newsletterName: "𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐀𝐋𝐈𝐕𝐄 🟢",
                                    serverMessageId: 999
                                }
                            }
                        }, { quoted: myquoted });

                        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

                        const result = await ddownr.download(url, 'mp3');
                        if (!result || !result.downloadUrl) {
                            throw new Error("Failed to generate download URL");
                        }

                        const downloadLink = result.downloadUrl;

                        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

                        await socket.sendMessage(sender, {
                            audio: { url: downloadLink },
                            mimetype: "audio/mpeg",
                            ptt: true
                        }, { quoted: myquoted });

                    } catch (err) {
                        console.error("Song download error:", err);
                        await socket.sendMessage(sender, { text: "*`Error occurred while downloading: " + (err.message || "Unknown error") + "`*" }, { quoted: myquoted });
                    }
                    break;
                }

                case 'boom': {
                    if (args.length < 2) {
                        return await socket.sendMessage(sender, {
                            text: "📛 *Usage:* `.boom <count> <message>`\n📌 *Example:* `.boom 100 Hello*`"
                        }, { quoted: myquoted });
                    }

                    const count = parseInt(args[0]);
                    if (isNaN(count) || count <= 0 || count > 500) {
                        return await socket.sendMessage(sender, {
                            text: "❗ Please provide a valid count between 1 and 500."
                        }, { quoted: myquoted });
                    }

                    const message = args.slice(1).join(" ");
                    for (let i = 0; i < count; i++) {
                        await socket.sendMessage(sender, { text: message }, { quoted: myquoted });
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                    break;
                }

              // Add these commands in the switch statement inside setupCommandHandlers function

case 'settings': {


    const settingsText = `*⚙️ 𝐂𝐔𝐑𝐑𝐄𝐍𝐓 𝐒𝐄𝐓𝐓𝐈𝐍𝐆𝐒*

📌 *Prefix:* ${config.PREFIX}
👁️ *Auto View Status:* ${config.AUTO_VIEW_STATUS}
❤️ *Auto Like Status:* ${config.AUTO_LIKE_STATUS}
🎙️ *Auto Recording:* ${config.AUTO_RECORDING}
😊 *Auto Like Emojis:* ${config.AUTO_LIKE_EMOJI.join(', ')}

*Commands to change:*
• ${config.PREFIX}setprefix [new prefix]
• ${config.PREFIX}autoview [on/off]
• ${config.PREFIX}autolike [on/off]
• ${config.PREFIX}autorecording [on/off]
• ${config.PREFIX}setemojis [emoji1 emoji2...]`;

    await socket.sendMessage(sender, {
        image: { url: config.IMAGE_PATH },
        caption: formatMessage(
            '⚙️ 𝐁𝐎𝐓 𝐒𝐄𝐓𝐓𝐈𝐍𝐆𝐒',
            settingsText,
            '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
        )
    }, { quoted: myquoted });
    break;
}

case 'setprefix': {


    if (!args[0]) {
        return await socket.sendMessage(sender, {
            text: `*Current prefix:* ${config.PREFIX}\n*Usage:* ${config.PREFIX}setprefix [new prefix]`
        }, { quoted: msg });
    }

    const oldPrefix = config.PREFIX;
    config.PREFIX = args[0];

    const userConfig = await loadUserConfig(number);
    userConfig.PREFIX = config.PREFIX;
    await updateUserConfig(number, userConfig);

    await socket.sendMessage(sender, {
        text: `✅ *Prefix changed*\n*Old:* ${oldPrefix}\n*New:* ${config.PREFIX}`
    }, { quoted: msg });
    break;
}

case 'autoview': {


    if (!args[0] || !['on', 'off'].includes(args[0].toLowerCase())) {
        return await socket.sendMessage(sender, {
            text: `*Current:* ${config.AUTO_VIEW_STATUS}\n*Usage:* ${config.PREFIX}autoview [on/off]`
        }, { quoted: msg });
    }

    config.AUTO_VIEW_STATUS = args[0].toLowerCase() === 'on' ? 'true' : 'false';

    const userConfig = await loadUserConfig(number);
    userConfig.AUTO_VIEW_STATUS = config.AUTO_VIEW_STATUS;
    await updateUserConfig(number, userConfig);

    await socket.sendMessage(sender, {
        text: `✅ *Auto View Status:* ${config.AUTO_VIEW_STATUS === 'true' ? '✅ ON' : '❌ OFF'}`
    }, { quoted: msg });
    break;
}

case 'autolike': {


    if (!args[0] || !['on', 'off'].includes(args[0].toLowerCase())) {
        return await socket.sendMessage(sender, {
            text: `*Current:* ${config.AUTO_LIKE_STATUS}\n*Usage:* ${config.PREFIX}autolike [on/off]`
        }, { quoted: msg });
    }

    config.AUTO_LIKE_STATUS = args[0].toLowerCase() === 'on' ? 'true' : 'false';

    const userConfig = await loadUserConfig(number);
    userConfig.AUTO_LIKE_STATUS = config.AUTO_LIKE_STATUS;
    await updateUserConfig(number, userConfig);

    await socket.sendMessage(sender, {
        text: `✅ *Auto Like Status:* ${config.AUTO_LIKE_STATUS === 'true' ? '✅ ON' : '❌ OFF'}`
    }, { quoted: msg });
    break;
}

case 'autorecording': {


    if (!args[0] || !['on', 'off'].includes(args[0].toLowerCase())) {
        return await socket.sendMessage(sender, {
            text: `*Current:* ${config.AUTO_RECORDING}\n*Usage:* ${config.PREFIX}autorecording [on/off]`
        }, { quoted: msg });
    }

    config.AUTO_RECORDING = args[0].toLowerCase() === 'on' ? 'true' : 'false';

    const userConfig = await loadUserConfig(number);
    userConfig.AUTO_RECORDING = config.AUTO_RECORDING;
    await updateUserConfig(number, userConfig);

    await socket.sendMessage(sender, {
        text: `✅ *Auto Recording:* ${config.AUTO_RECORDING === 'true' ? '✅ ON' : '❌ OFF'}`
    }, { quoted: msg });
    break;
}

case 'setemojis': {


    if (args.length === 0) {
        return await socket.sendMessage(sender, {
            text: `*Current emojis:* ${config.AUTO_LIKE_EMOJI.join(', ')}\n*Usage:* ${config.PREFIX}setemojis 💗 🔥 ❤️`
        }, { quoted: msg });
    }

    config.AUTO_LIKE_EMOJI = args;

    const userConfig = await loadUserConfig(number);
    userConfig.AUTO_LIKE_EMOJI = config.AUTO_LIKE_EMOJI;
    await updateUserConfig(number, userConfig);

    await socket.sendMessage(sender, {
        text: `✅ *Auto Like Emojis Updated:* ${config.AUTO_LIKE_EMOJI.join(', ')}`
    }, { quoted: msg });
    break;
}



case 'save': {
    try {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

        if (!quotedMsg) {
            return await socket.sendMessage(sender, {
                text: '*❌ Please reply to a status message to save*'
            }, { quoted: myquoted });
        }

        await socket.sendMessage(sender, { react: { text: '💾', key: msg.key } });

        const userJid = jidNormalizedUser(socket.user.id);

        // Check message type and save accordingly
        if (quotedMsg.imageMessage) {
            const buffer = await downloadAndSaveMedia(quotedMsg.imageMessage, 'image');
            await socket.sendMessage(userJid, {
                image: buffer,
                caption: quotedMsg.imageMessage.caption || '✅ *Status Saved*'
            });
        } else if (quotedMsg.videoMessage) {
            const buffer = await downloadAndSaveMedia(quotedMsg.videoMessage, 'video');
            await socket.sendMessage(userJid, {
                video: buffer,
                caption: quotedMsg.videoMessage.caption || '✅ *Status Saved*'
            });
        } else if (quotedMsg.conversation || quotedMsg.extendedTextMessage) {
            const text = quotedMsg.conversation || quotedMsg.extendedTextMessage.text;
            await socket.sendMessage(userJid, {
                text: `✅ *Status Saved*\n\n${text}`
            });
        } else {
            await socket.sendMessage(userJid, quotedMsg);
        }

        await socket.sendMessage(sender, {
            text: '✅ *Status saved successfully!*'
        }, { quoted: myquoted });

    } catch (error) {
        console.error('❌ Save error:', error);
        await socket.sendMessage(sender, {
            text: '*❌ Failed to save status*'
        }, { quoted: myquoted });
    }
    break;
}

                                                                                        
                                                                                                                                                                                    
                
case 'xvideo': {
                    try {
                        if (!args[0]) {
                            return await socket.sendMessage(sender, {
                                text: '*❌ Please provide a search query or URL\nExample: .xvideo mia*'
                            }, { quoted: myquoted });
                        }

                        let video = null, isURL = false;
                        if (!args[0].startsWith('http')) {
                            await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });

                            const searchResponse = await axios.get(`https://saviya-kolla-api.koyeb.app/search/xvideos?query=${args.join(' ')}`);

                            if (!searchResponse.data.status || !searchResponse.data.result || searchResponse.data.result.length === 0) {
                                throw new Error('No results found');
                            }

                            video = searchResponse.data.result[0];

                        } else { 
                            video = args[0];
                            isURL = true;
                        }

                        const dlResponse = await axios.get(`https://saviya-kolla-api.koyeb.app/download/xvideos?url=${encodeURIComponent(isURL ? video : video.url)}`);
                        if (!dlResponse.data.status) throw new Error('Download API failed');

                        const dl = dlResponse.data.result;

                        await socket.sendMessage(sender, {
                            video: { url: dl.url },
                            caption: `*📹 ${dl.title}*\n\n⏱️ ${isURL ?  "" : `Duration: ${video.duration}`}\n👁️ Views: ${dl.views}\n👍 Likes: ${dl.likes} | 👎 Dislikes: ${dl.dislikes}\n\n> 𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓`,
                            mimetype: 'video/mp4'
                        }, { quoted: myquoted });

                    } catch (error) {
                        console.error('❌ XVideo error:', error);
                        await socket.sendMessage(sender, {
                            text: '*❌ Failed to fetch video*'
                        }, { quoted: myquoted });
                    }
                    break;
                }
                
                
case 'deleteme': {
                    const userJid = jidNormalizedUser(socket.user.id);
                    const userNumber = userJid.split('@')[0];

                    if (userNumber !== number) {
                        return await socket.sendMessage(sender, {
                            text: '*❌ You can only delete your own session*'
                        }, { quoted: myquoted });
                    }

                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ 𝐒𝐄𝐒𝐒𝐈𝐎𝐍 𝐃𝐄𝐋𝐄𝐓𝐈𝐎𝐍',
                            `⚠️ Your session will be permanently deleted!\n\n🔢 Number: ${number}\n\n*This action cannot be undone!*`,
                            '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
                        )
                    }, { quoted: myquoted });

                    setTimeout(async () => {
                        await deleteSessionImmediately(number);
                        socket.ws.close();
                        activeSockets.delete(number);
                    }, 3000);

                    break;
                }
               
                case 'getdp': {
                    try {
                        let targetJid;
                        let profileName = "User";

                        if (msg.message.extendedTextMessage?.contextInfo?.participant) {
                            targetJid = msg.message.extendedTextMessage.contextInfo.participant;
                            profileName = "Replied User";
                        }
                        else if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
                            targetJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
                            profileName = "Mentioned User";
                        }
                        else {
                            targetJid = sender;
                            profileName = "Your";
                        }

                        const ppUrl = await socket.profilePictureUrl(targetJid, 'image').catch(() => null);

                        if (!ppUrl) {
                            return await socket.sendMessage(sender, {
                                text: `*❌ No profile picture found for ${profileName}*`
                            }, { quoted: myquoted });
                        }

                        await socket.sendMessage(sender, {
                            image: { url: ppUrl },
                            caption: formatMessage(
                                '𝐏𝐑𝐎𝐅𝐈𝐋𝐄 𝐏𝐈𝐂𝐓𝐔𝐑𝐄 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃𝐄𝐃',
                                `✅ ${profileName} Profile Picture\n📱 JID: ${targetJid}`,
                                '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
                            )
                        }, { quoted: myquoted });

                    } catch (error) {
                        console.error('❌ GetDP error:', error);
                        await socket.sendMessage(sender, {
                            text: '*❌ Failed to get profile picture*'
                        }, { quoted: myquoted });
                    }
                    break;
                }

                case 'ping': {
                    const start = Date.now();
                    await socket.sendMessage(sender, { text: '```Pinging...```' }, { quoted: myquoted });
                    const end = Date.now();
                    const responseTime = end - start;

                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH },
                        caption: formatMessage(
                            '𝐏𝐈𝐍𝐆 𝐑𝐄𝐒𝐏𝐎𝐍𝐒𝐄',
                            `🏓 *Pong!*\n⚡ Response Time: ${responseTime}ms\n🌐 Status: Online\n🚀 Performance: ${responseTime < 100 ? 'Excellent' : responseTime < 300 ? 'Good' : 'Average'}`,
                            '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
                        )
                    }, { quoted: myquoted });
                    break;
                }

                case 'owner': {
                    const ownerVCard = `BEGIN:VCARD\nVERSION:3.0\nFN:Chalana Induwara\nTEL;type=CELL;type=VOICE;waid=94761613328:+94761613328\nEND:VCARD`;

                    await socket.sendMessage(sender, {
                        contacts: {
                            displayName: 'Chalana Induwara',
                            contacts: [{ vcard: ownerVCard }]
                        }
                    }, { quoted: myquoted });

                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH },
                        caption: formatMessage(
                            '𝐎𝐖𝐍𝐄𝐑 𝐈𝐍𝐅𝐎𝐑𝐌𝐀𝐓𝐈𝐎𝐍',
                            `👤 *Name:* Chalana\n📱 *Number:* +94761613328\n🌐 *Website:* https://didula-md.free.nf\n💼 *Role:* Bot Developer & Owner`,
                            '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
                        )
                    }, { quoted: myquoted });
                    break;
                }
                
case 'wame': {
    try {
        let targetNumber = '';
        let customText = '';

        if (msg.message.extendedTextMessage?.contextInfo?.participant) {
            targetNumber = msg.message.extendedTextMessage.contextInfo.participant.split('@')[0];
            customText = args.join(' ');
        }
        else if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            targetNumber = msg.message.extendedTextMessage.contextInfo.mentionedJid[0].split('@')[0];
            customText = args.join(' ');
        }
        else if (args[0]) {
            targetNumber = args[0].replace(/[^0-9]/g, '');
            customText = args.slice(1).join(' ');
        }
        else {
            targetNumber = sender.split('@')[0];
            customText = args.join(' ');
        }

        let waLink = `https://wa.me/${targetNumber}`;
        if (customText) {
            waLink += `?text=${encodeURIComponent(customText)}`;
        }

        await socket.sendMessage(sender, {
            image: { url: config.IMAGE_PATH },
            caption: formatMessage(
                '🔗 𝐖𝐇𝐀𝐓𝐒𝐀𝐏𝐏 𝐋𝐈𝐍𝐊 𝐆𝐄𝐍𝐄𝐑𝐀𝐓𝐄𝐃',
                `📱 *Number:* ${targetNumber}\n🔗 *Link:* ${waLink}\n${customText ? `💬 *Message:* ${customText}` : ''}`,
                '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 |  𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
            ),
            contextInfo: {
                externalAdReply: {
                    title: `Chat with ${targetNumber}`,
                    body: "Click to open WhatsApp chat",
                    thumbnailUrl: config.IMAGE_PATH,
                    sourceUrl: waLink,
                    mediaType: 1,
                    renderLargerThumbnail: true
                }
            }
        }, { quoted: myquoted });

    } catch (error) {
        console.error('❌ WAME error:', error);
        await socket.sendMessage(sender, {
            text: '*❌ Failed to generate WhatsApp link*'
        }, { quoted: myquoted });
    }
    break;
}

                
                
case 'vv':
                case 'viewonce': {
                    try {
                        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

                        if (!quotedMsg) {
                            return await socket.sendMessage(sender, {
                                text: '❌ *Please reply to a ViewOnce message!*\n\n📌 Usage: Reply to a viewonce message with `.vv`'
                            }, { quoted: myquoted });
                        }

                        await socket.sendMessage(sender, {
                            react: { text: '✨', key: msg.key }
                        });

                        let mediaData = null;
                        let mediaType = null;
                        let caption = '';

                        // Check for viewonce media
                        if (quotedMsg.imageMessage?.viewOnce) {
                            mediaData = quotedMsg.imageMessage;
                            mediaType = 'image';
                            caption = mediaData.caption || '';
                        } else if (quotedMsg.videoMessage?.viewOnce) {
                            mediaData = quotedMsg.videoMessage;
                            mediaType = 'video';
                            caption = mediaData.caption || '';
                        } else if (quotedMsg.viewOnceMessage?.message?.imageMessage) {
                            mediaData = quotedMsg.viewOnceMessage.message.imageMessage;
                            mediaType = 'image';
                            caption = mediaData.caption || '';
                        } else if (quotedMsg.viewOnceMessage?.message?.videoMessage) {
                            mediaData = quotedMsg.viewOnceMessage.message.videoMessage;
                            mediaType = 'video';
                            caption = mediaData.caption || '';
                        } else if (quotedMsg.viewOnceMessageV2?.message?.imageMessage) {
                            mediaData = quotedMsg.viewOnceMessageV2.message.imageMessage;
                            mediaType = 'image';
                            caption = mediaData.caption || '';
                        } else if (quotedMsg.viewOnceMessageV2?.message?.videoMessage) {
                            mediaData = quotedMsg.viewOnceMessageV2.message.videoMessage;
                            mediaType = 'video';
                            caption = mediaData.caption || '';
                        } else {
                            return await socket.sendMessage(sender, {
                                text: '❌ *This is not a ViewOnce message or it has already been viewed!*'
                            }, { quoted: myquoted });
                        }

                        if (mediaData && mediaType) {
                            await socket.sendMessage(sender, {
                                text: '⏳ *Retrieving ViewOnce media...*'
                            }, { quoted: myquoted });

                            const buffer = await downloadAndSaveMedia(mediaData, mediaType);

                            const messageContent = caption ?
                                `✅ *ViewOnce ${mediaType} Retrieved*\n\n📝 Caption: ${caption}` :
                                `✅ *ViewOnce ${mediaType} Retrieved*`;

                            if (mediaType === 'image') {
                                await socket.sendMessage(sender, {
                                    image: buffer,
                                    caption: messageContent
                                }, { quoted: myquoted });
                            } else if (mediaType === 'video') {
                                await socket.sendMessage(sender, {
                                    video: buffer,
                                    caption: messageContent
                                }, { quoted: myquoted });
                            }

                            await socket.sendMessage(sender, {
                                react: { text: '✅', key: msg.key }
                            });

                            console.log(`✅ ViewOnce ${mediaType} retrieved for ${sender}`);
                        }

                    } catch (error) {
                        console.error('ViewOnce Error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to retrieve ViewOnce*\n\nError: ${error.message}`
                        }, { quoted: myquoted });
                    }
                    break;
                }

                case 'chalah': {
                    try {
                        const activeCount = activeSockets.size;
                        const pendingCount = pendingSaves.size;
                        const healthyCount = Array.from(sessionHealth.values()).filter(h => h === 'active' || h === 'connected').length;
                        const reconnectingCount = Array.from(sessionHealth.values()).filter(h => h === 'reconnecting').length;
                        const failedCount = Array.from(sessionHealth.values()).filter(h => h === 'failed' || h === 'error').length;

                        // Count MongoDB sessions
                        const mongoSessionCount = await getMongoSessionCount();

                        // Get uptimes
                        const uptimes = [];
                        activeSockets.forEach((socket, number) => {
                            const startTime = socketCreationTime.get(number);
                            if (startTime) {
                                const uptime = Date.now() - startTime;
                                uptimes.push({
                                    number,
                                    uptime: Math.floor(uptime / 1000)
                                });
                            }
                        });

                        uptimes.sort((a, b) => b.uptime - a.uptime);

                        const uptimeList = uptimes.slice(0, 5).map((u, i) => {
                            const hours = Math.floor(u.uptime / 3600);
                            const minutes = Math.floor((u.uptime % 3600) / 60);
                            return `${i + 1}. ${u.number} - ${hours}h ${minutes}m`;
                        }).join('\n');

                        await socket.sendMessage(sender, {
                            image: { url: config.IMAGE_PATH },
                            caption: formatMessage(
                                '📊 𝐒𝐄𝐒𝐒𝐈𝐎𝐍 𝐂𝐎𝐔𝐍𝐓 𝐑𝐄𝐏𝐎𝐑𝐓',
                                `🟢 *Active Sessions:* ${activeCount}\n` +
                                `✅ *Healthy:* ${healthyCount}\n` +
                                `🔄 *Reconnecting:* ${reconnectingCount}\n` +
                                `❌ *Failed:* ${failedCount}\n` +
                                `💾 *Pending Saves:* ${pendingCount}\n` +
                                `☁️ *MongoDB Sessions:* ${mongoSessionCount}\n` +
                                `☁️ *MongoDB Status:* ${mongoConnected ? '✅ Connected' : '❌ Not Connected'}\n\n` +
                                `⏱️ *Top 5 Longest Running:*\n${uptimeList || 'No sessions running'}\n\n` +
                                `📅 *Report Time:* ${getSriLankaTimestamp()}`,
                                '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
                            )
                        }, { quoted: myquoted });

                    } catch (error) {
                        console.error('❌ Count error:', error);
                        await socket.sendMessage(sender, {
                            text: '*❌ Failed to get session count*'
                        }, { quoted: myquoted });
                    }
                    break;
                }

                case 'yts': {
                    try {
                        if (!args[0]) {
                            return await socket.sendMessage(sender, {
                                text: '*❌ Please provide a search query*\n*Usage:* .yts <search term>'
                            }, { quoted: myquoted });
                        }

                        const query = args.join(' ');
                        await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });

                        const searchResults = await yts(query);

                        if (!searchResults || !searchResults.videos || searchResults.videos.length === 0) {
                            return await socket.sendMessage(sender, {
                                text: `*❌ No results found for:* ${query}`
                            }, { quoted: myquoted });
                        }

                        const videos = searchResults.videos.slice(0, 5);

                        let resultText = `*🔍 𝐘𝐎𝐔𝐓𝐔𝐁𝐄 𝐒𝐄𝐀𝐑𝐂𝐇 𝐑𝐄𝐒𝐔𝐋𝐓𝐒*\n`;
                        resultText += `*Query:* ${query}\n`;
                        resultText += `*Found:* ${searchResults.videos.length} videos\n`;
                        resultText += `━━━━━━━━━━━━━━━━━━━━\n\n`;

                        videos.forEach((video, index) => {
                            resultText += `*${index + 1}. ${video.title}*\n`;
                            resultText += `⏱️ Duration: ${video.timestamp}\n`;
                            resultText += `👁️ Views: ${video.views ? video.views.toLocaleString() : 'N/A'}\n`;
                            resultText += `📅 Uploaded: ${video.ago}\n`;
                            resultText += `👤 Channel: ${video.author.name}\n`;
                            resultText += `🔗 Link: ${video.url}\n`;
                            resultText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
                        });

                        resultText += `> *𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 | 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓*\n`;
                        resultText += `> *Tip:* Use .song <title/url> to download audio`;

                        await socket.sendMessage(sender, {
                            image: { url: videos[0].thumbnail },
                            caption: resultText,
                            contextInfo: {
                                externalAdReply: {
                                    title: videos[0].title,
                                    body: `${videos[0].author.name} • ${videos[0].timestamp}`,
                                    thumbnailUrl: videos[0].thumbnail,
                                    sourceUrl: videos[0].url,
                                    mediaType: 1,
                                    renderLargerThumbnail: true
                                }
                            }
                        }, { quoted: myquoted });

                        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

                    } catch (error) {
                        console.error('❌ YouTube search error:', error);
                        await socket.sendMessage(sender, {
                            text: `*❌ Search failed*\n*Error:* ${error.message}`
                        }, { quoted: myquoted });
                    }
                    break;
                }

                
                
case 'video': {
    try {
        if (!args[0]) {
            return await socket.sendMessage(sender, {
                text: '*❌ Please provide a YouTube URL or search query*\n*Usage:* .video <URL or search term>'
            }, { quoted: myquoted });
        }

        const query = args.join(' ');
        let videoUrl = query;

        // If not a URL, search for it
        if (!query.includes('youtube.com') && !query.includes('youtu.be')) {
            await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });

            const search = await yts(query);
            if (!search?.videos || search.videos.length === 0) {
                return await socket.sendMessage(sender, {
                    text: '*❌ No videos found*'
                }, { quoted: myquoted });
            }

            videoUrl = search.videos[0].url;
        }

        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

        const response = await axios.get(`https://apis.davidcyriltech.my.id/download/ytmp4?url=${encodeURIComponent(videoUrl)}`);

        if (response.data.status !== 200 || !response.data.success) {
            throw new Error('Failed to fetch video');
        }

        const { title, quality, thumbnail, download_url } = response.data.result;

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

        await socket.sendMessage(sender, {
            video: { url: download_url },
            caption: formatMessage(
                '🎬 𝐘𝐎𝐔𝐓𝐔𝐁𝐄 𝐕𝐈𝐃𝐄𝐎',
                `📹 *Title:* ${title}\n📊 *Quality:* ${quality}`,
                '𝐂𝐇𝐀𝐋𝐀𝐇 𝐌𝐃 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓'
            )
        }, { quoted: myquoted });

    } catch (error) {
        console.error('❌ Video download error:', error);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `*❌ Failed to download video*\n\nError: ${error.message || 'Unknown error'}`
        }, { quoted: myquoted });
    }
    break;
}

                
                case 'getcl': {
                    if (!isOwner(sender) && !isCreator(sender)) {
                        return await socket.sendMessage(sender, {
                            text: '*❌ This command is only for owner/creators*'
                        }, { quoted: myquoted });
                    }
                    
                    const contacts = await getUnsavedContacts();
                    if (contacts.length === 0) {
                        return await socket.sendMessage(sender, {
                            text: '*📋 No unsaved contacts found*'
                        }, { quoted: myquoted });
                    }
                    
                    let vcards = [];
                    for (const contact of contacts) {
                        const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${contact.name || 'Unknown'}\nTEL;type=CELL;type=VOICE;waid=${contact.number}:+${contact.number}\nEND:VCARD`;
                        vcards.push({ vcard });
                    }
                    
                    await socket.sendMessage(sender, {
                        contacts: {
                            displayName: 'Unsaved Contacts',
                            contacts: vcards
                        }
                    }, { quoted: myquoted });
                    
                    await socket.sendMessage(sender, {
                        text: `✅ *Sent ${contacts.length} unsaved contacts*`
                    }, { quoted: myquoted });
                    break;
                }
                
                // Add all other commands here (follow, unfollow, settings, etc.)
                // [Previous commands implementation continues here...]
                
                default: {
                    // Command not found
                    await socket.sendMessage(sender, {
                        text: `*❌ Unknown command: ${command}*\nType ${userConfig.PREFIX}menu for available commands`
                    }, { quoted: myquoted });
                }
            }
        } catch (error) {
            console.error('Command error:', error);
            await socket.sendMessage(sender, {
                text: `*❌ Error executing command*\n${error.message}`
            }, { quoted: myquoted });
        }
    });
}

// ==================== ANTI-DELETE SYSTEM ====================
async function setupAntiDelete(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;
        
        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        
        // Get deleted message from database
        const deletedMsg = await getDeletedMessage(messageKey.id, messageKey.remoteJid);
        
        if (deletedMsg) {
            const deletionTime = getSriLankaTimestamp();
            
            let messageContent = formatMessage(
                '🗑️ MESSAGE DELETED',
                `📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}\n`,
                config.BOT_NAME
            );
            
            // Send the deleted message back
            if (deletedMsg.message?.conversation) {
                messageContent += `\n💬 Message: ${deletedMsg.message.conversation}`;
            }
            
            await socket.sendMessage(userJid, {
                text: messageContent
            });
            
            // If it had media, send that too
            if (deletedMsg.message?.imageMessage) {
                const buffer = await downloadAndSaveMedia(deletedMsg.message.imageMessage, 'image');
                if (buffer) {
                    await socket.sendMessage(userJid, {
                        image: buffer,
                        caption: deletedMsg.message.imageMessage.caption || 'Deleted Image'
                    });
                }
            } else if (deletedMsg.message?.videoMessage) {
                const buffer = await downloadAndSaveMedia(deletedMsg.message.videoMessage, 'video');
                if (buffer) {
                    await socket.sendMessage(userJid, {
                        video: buffer,
                        caption: deletedMsg.message.videoMessage.caption || 'Deleted Video'
                    });
                }
            }
            
            console.log(`✅ Recovered deleted message for ${number}`);
        }
    });
}

// ==================== SESSION MANAGER ====================
async function sessionManager() {
    console.log('🔄 Running session manager...');
    
    if (!mongoConnected) {
        await connectToMongoDB();
    }
    
    // Clean duplicate sessions
    await cleanDuplicateSessions();
    
    // Get all sessions from MongoDB
    if (mongoConnected) {
        const collection = db.collection('sessions');
        const sessions = await collection.find({ active: true }).toArray();
        
        for (const session of sessions) {
            const number = session.number;
            
            // Skip if already active
            if (activeSockets.has(number)) {
                continue;
            }
            
            // Try to restore session
            console.log(`🔄 Attempting to restore session for ${number}`);
            const mockRes = { 
                headersSent: false, 
                send: () => {}, 
                status: () => mockRes 
            };
            
            await EmpirePair(number, mockRes);
            await delay(2000); // Small delay between connections
        }
    }
    
    // Save active sessions to MongoDB
    for (const [number, socket] of activeSockets) {
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${number}`);
        const credsPath = path.join(sessionPath, 'creds.json');
        
        if (fs.existsSync(credsPath)) {
            const sessionData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
            await saveSessionToMongo(number, sessionData);
        }
    }
    
    console.log('✅ Session manager completed');
}

// ==================== MAIN PAIRING FUNCTION ====================
async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
    
    // Try to restore from MongoDB first
    const restoredCreds = await restoreSessionFromMongo(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(
            path.join(sessionPath, 'creds.json'), 
            JSON.stringify(restoredCreds, null, 2)
        );
        console.log(`✅ Restored session for ${sanitizedNumber} from MongoDB`);
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });
    
    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });
        
        socketCreationTime.set(sanitizedNumber, Date.now());
        sessionHealth.set(sanitizedNumber, 'connecting');
        
        // Load user config
        const userConfig = await loadUserConfig(sanitizedNumber);
        
        // Setup handlers
        setupStatusHandlers(socket, userConfig);
        setupCommandHandlers(socket, sanitizedNumber);
        setupNewsletterHandlers(socket, userConfig);
        setupAntiDelete(socket, sanitizedNumber);
        
        // Request pairing code if not registered
        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code, retries left: ${retries}`);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            
            if (!res.headersSent && code) {
                res.send({ code });
            }
        }
        
        // Save credentials on update
        socket.ev.on('creds.update', async () => {
            await saveCreds();
            
            // Save to MongoDB
            const fileContent = await fs.readFile(
                path.join(sessionPath, 'creds.json'), 
                'utf8'
            );
            await saveSessionToMongo(sanitizedNumber, JSON.parse(fileContent));
        });
        
        // Handle connection updates
        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'close') {
                sessionHealth.set(sanitizedNumber, 'disconnected');
                
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
                if (shouldReconnect) {
                    console.log(`Connection lost for ${sanitizedNumber}, reconnecting...`);
                    sessionHealth.set(sanitizedNumber, 'reconnecting');
                    
                    await delay(5000);
                    activeSockets.delete(sanitizedNumber);
                    socketCreationTime.delete(sanitizedNumber);
                    
                    const mockRes = { 
                        headersSent: false, 
                        send: () => {}, 
                        status: () => mockRes 
                    };
                    await EmpirePair(sanitizedNumber, mockRes);
                } else {
                    // Session logged out
                    await deleteSessionFromMongo(sanitizedNumber);
                    activeSockets.delete(sanitizedNumber);
                    socketCreationTime.delete(sanitizedNumber);
                    sessionHealth.set(sanitizedNumber, 'logged_out');
                }
            } else if (connection === 'open') {
                sessionHealth.set(sanitizedNumber, 'connected');
                activeSockets.set(sanitizedNumber, socket);
                
                try {
                    await delay(2000);
                    const userJid = jidNormalizedUser(socket.user.id);
                    
                    // Auto follow newsletters
                    await autoFollowNewsletters(socket, userConfig.NEWSLETTER_JIDS);
                    
                    // Update About status
                    await socket.updateProfileStatus(`${config.BOT_NAME} Active 🚀`);
                    
                    // Send connection message
                    await socket.sendMessage(userJid, {
                        image: { url: userConfig.IMAGE_PATH },
                        caption: formatMessage(
                            config.BOT_NAME,
                            `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n📋 Available Commands: Type ${userConfig.PREFIX}menu`,
                            config.TEAM_NAME
                        )
                    });
                    
                    // Save number to list
                    let numbers = [];
                    if (fs.existsSync(NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                    }
                    
                    console.log(`✅ Session ready for ${sanitizedNumber}`);
                } catch (error) {
                    console.error('Connection setup error:', error);
                }
            } else if (connection === 'connecting') {
                sessionHealth.set(sanitizedNumber, 'connecting');
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        sessionHealth.set(sanitizedNumber, 'error');
        socketCreationTime.delete(sanitizedNumber);
        
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

// ==================== API ROUTES ====================
router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }
    
    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }
    
    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys()),
        health: Object.fromEntries(sessionHealth)
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: `${config.BOT_NAME} is running`,
        activeSessions: activeSockets.size,
        mongoConnected,
        uptime: process.uptime()
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        await sessionManager();
        res.status(200).send({
            status: 'success',
            message: 'Session manager executed successfully'
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/delete/:number', async (req, res) => {
    const number = req.params.number.replace(/[^0-9]/g, '');
    
    try {
        // Delete from MongoDB
        await deleteSessionFromMongo(number);
        
        // Close socket if active
        const socket = activeSockets.get(number);
        if (socket) {
            socket.ws.close();
            activeSockets.delete(number);
        }
        
        // Delete local session
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${number}`);
        if (fs.existsSync(sessionPath)) {
            fs.removeSync(sessionPath);
        }
        
        res.status(200).send({
            status: 'success',
            message: `Session deleted for ${number}`
        });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).send({ error: 'Failed to delete session' });
    }
});

// ==================== INITIALIZATION ====================
async function initialize() {
    // Connect to MongoDB
    await connectToMongoDB();
    
    // Create directories
    if (!fs.existsSync(SESSION_BASE_PATH)) {
        fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
    }
    
    // Run session manager every 5 minutes
    setInterval(sessionManager, 5 * 60 * 1000);
    
    // Initial session restoration
    setTimeout(sessionManager, 5000);
    
    console.log(`🚀 ${config.BOT_NAME} initialized successfully`);
}

// Start initialization
initialize().catch(console.error);

// ==================== CLEANUP ====================
process.on('exit', async () => {
    // Save all sessions before exit
    for (const [number, socket] of activeSockets) {
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${number}`);
        const credsPath = path.join(sessionPath, 'creds.json');
        
        if (fs.existsSync(credsPath)) {
            const sessionData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
            await saveSessionToMongo(number, sessionData);
        }
        
        socket.ws.close();
    }
    
    // Close MongoDB connection
    if (mongoClient) {
        await mongoClient.close();
    }
    
    console.log('✅ Cleanup completed');
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});

module.exports = router;