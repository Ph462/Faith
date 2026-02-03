const express = require('express');
const cors = require('cors');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { 
  DisconnectReason, 
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

// Logger
const logger = pino({ level: 'silent' });

// Store client state
let sock = null;
let connectionState = {
  connected: false,
  connecting: false,
  pairingCode: null,
  phoneNumber: null,
  error: null,
  qr: null
};

// Session directory
const SESSION_DIR = process.env.VERCEL 
  ? '/tmp/whatsapp-session' 
  : path.join(__dirname, '..', 'session');

// Ensure session directory exists
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Store messages and chats in memory
let chats = [];
let messagesStore = {};

// Initialize WhatsApp connection
async function connectToWhatsApp(phoneNumber) {
  try {
    // Get auth state
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    // Fetch latest version
    const { version } = await fetchLatestBaileysVersion();
    
    // Create socket
    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: ['WhatsApp Dashboard', 'Chrome', '120.0.0'],
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        connectionState.qr = qr;
        console.log('QR Code received');
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed, reconnecting:', shouldReconnect);
        
        connectionState.connected = false;
        connectionState.connecting = false;
        
        if (shouldReconnect) {
          // Reconnect after a delay
          setTimeout(() => connectToWhatsApp(phoneNumber), 3000);
        } else {
          // Clear session on logout
          connectionState.error = 'Logged out';
          sock = null;
        }
      } else if (connection === 'open') {
        console.log('WhatsApp connected!');
        connectionState.connected = true;
        connectionState.connecting = false;
        connectionState.pairingCode = null;
        connectionState.qr = null;
        connectionState.error = null;
        
        // Load chats
        await loadChats();
      }
    });

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type === 'notify') {
        for (const msg of messages) {
          const chatId = msg.key.remoteJid;
          
          if (!messagesStore[chatId]) {
            messagesStore[chatId] = [];
          }
          
          const messageData = {
            id: msg.key.id,
            body: msg.message?.conversation || 
                  msg.message?.extendedTextMessage?.text || 
                  msg.message?.imageMessage?.caption ||
                  '[Media]',
            from: msg.key.remoteJid,
            timestamp: msg.messageTimestamp,
            isOutgoing: msg.key.fromMe,
            type: Object.keys(msg.message || {})[0]
          };
          
          messagesStore[chatId].push(messageData);
          
          // Update chat list
          updateChatWithMessage(chatId, messageData);
        }
      }
    });

    // Request pairing code if phone number provided
    if (phoneNumber && !state.creds.registered) {
      connectionState.connecting = true;
      
      // Wait a bit for the socket to be ready
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        connectionState.pairingCode = code;
        console.log('Pairing code:', code);
      } catch (err) {
        console.error('Error requesting pairing code:', err);
        connectionState.error = err.message;
        connectionState.connecting = false;
      }
    }

    return sock;
  } catch (error) {
    console.error('Connection error:', error);
    connectionState.error = error.message;
    connectionState.connecting = false;
    throw error;
  }
}

// Load chats from WhatsApp
async function loadChats() {
  if (!sock) return;
  
  try {
    const chatList = await sock.groupFetchAllParticipating();
    const groups = Object.values(chatList);
    
    chats = groups.map(group => ({
      id: group.id,
      name: group.subject || 'Unknown',
      isGroup: true,
      timestamp: group.creation,
      lastMessage: null
    }));
    
    console.log(`Loaded ${chats.length} group chats`);
  } catch (err) {
    console.error('Error loading chats:', err);
  }
}

// Update chat with new message
function updateChatWithMessage(chatId, message) {
  const existingChat = chats.find(c => c.id === chatId);
  
  if (existingChat) {
    existingChat.lastMessage = {
      body: message.body,
      timestamp: message.timestamp
    };
    existingChat.timestamp = message.timestamp;
  } else {
    chats.unshift({
      id: chatId,
      name: chatId.split('@')[0],
      isGroup: chatId.endsWith('@g.us'),
      timestamp: message.timestamp,
      lastMessage: {
        body: message.body,
        timestamp: message.timestamp
      }
    });
  }
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    platform: process.env.VERCEL ? 'vercel' : 'standalone'
  });
});

// Get connection status
app.get('/api/connection-status', (req, res) => {
  res.json({
    connected: connectionState.connected,
    connecting: connectionState.connecting,
    error: connectionState.error,
    hasPairingCode: !!connectionState.pairingCode
  });
});

// Request pairing code
app.post('/api/request-pairing-code', async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ 
        success: false, 
        message: 'Phone number is required' 
      });
    }

    // Clean phone number
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    
    if (cleanPhone.length < 10) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid phone number format' 
      });
    }

    connectionState.phoneNumber = cleanPhone;
    connectionState.connecting = true;
    connectionState.error = null;
    connectionState.pairingCode = null;

    // Initialize connection
    await connectToWhatsApp(cleanPhone);

    // Wait for pairing code (with timeout)
    let attempts = 0;
    const maxAttempts = 30;
    
    while (!connectionState.pairingCode && attempts < maxAttempts) {
      if (connectionState.error) {
        return res.status(500).json({
          success: false,
          message: connectionState.error
        });
      }
      
      if (connectionState.connected) {
        return res.json({
          success: true,
          message: 'Already connected',
          connected: true
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
      attempts++;
    }

    if (connectionState.pairingCode) {
      res.json({
        success: true,
        pairingCode: connectionState.pairingCode,
        message: 'Enter this code in WhatsApp: Settings → Linked Devices → Link a Device → Link with phone number'
      });
    } else {
      res.status(408).json({
        success: false,
        message: 'Timeout waiting for pairing code. Please try again.'
      });
    }

  } catch (error) {
    console.error('Error requesting pairing code:', error);
    connectionState.connecting = false;
    connectionState.error = error.message;
    
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to generate pairing code'
    });
  }
});

// Get all chats
app.get('/api/chats', async (req, res) => {
  if (!connectionState.connected) {
    return res.status(503).json({ 
      success: false, 
      message: 'WhatsApp not connected' 
    });
  }

  res.json({
    success: true,
    chats: chats
  });
});

// Get messages for a chat
app.get('/api/chats/:chatId/messages', async (req, res) => {
  if (!connectionState.connected) {
    return res.status(503).json({ 
      success: false, 
      message: 'WhatsApp not connected' 
    });
  }

  try {
    const { chatId } = req.params;
    const decodedChatId = decodeURIComponent(chatId);
    
    // Return cached messages or empty array
    const chatMessages = messagesStore[decodedChatId] || [];

    res.json({
      success: true,
      messages: chatMessages
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Send a message
app.post('/api/chats/:chatId/messages', async (req, res) => {
  if (!connectionState.connected) {
    return res.status(503).json({ 
      success: false, 
      message: 'WhatsApp not connected' 
    });
  }

  try {
    const { chatId } = req.params;
    const { message } = req.body;
    const decodedChatId = decodeURIComponent(chatId);

    if (!message) {
      return res.status(400).json({
        success: false,
        message: 'Message content is required'
      });
    }

    const sentMessage = await sock.sendMessage(decodedChatId, { text: message });

    const messageData = {
      id: sentMessage.key.id,
      body: message,
      timestamp: Math.floor(Date.now() / 1000),
      isOutgoing: true
    };

    // Cache the message
    if (!messagesStore[decodedChatId]) {
      messagesStore[decodedChatId] = [];
    }
    messagesStore[decodedChatId].push(messageData);

    res.json({
      success: true,
      message: messageData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Get contacts
app.get('/api/contacts', async (req, res) => {
  if (!connectionState.connected) {
    return res.status(503).json({ 
      success: false, 
      message: 'WhatsApp not connected' 
    });
  }

  try {
    // Baileys doesn't have a direct contacts API like whatsapp-web.js
    // Return chats as contacts
    const contacts = chats.map(chat => ({
      id: chat.id,
      name: chat.name,
      number: chat.id.split('@')[0],
      isGroup: chat.isGroup
    }));

    res.json({
      success: true,
      contacts
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Disconnect
app.post('/api/disconnect', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      sock = null;
    }
    
    // Clear session files
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }
    
    connectionState = {
      connected: false,
      connecting: false,
      pairingCode: null,
      phoneNumber: null,
      error: null,
      qr: null
    };

    chats = [];
    messagesStore = {};

    res.json({ success: true, message: 'Disconnected successfully' });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// For Vercel serverless
if (process.env.VERCEL) {
  module.exports = app;
} else {
  // Start server for local/VPS
  app.listen(PORT, () => {
    console.log(`WhatsApp server running on port ${PORT}`);
    console.log(`Platform: Standalone`);
    console.log(`Session directory: ${SESSION_DIR}`);
  });
}
