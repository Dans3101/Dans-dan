import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeInMemoryStore,
  Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import QRCode from 'qrcode';
import dotenv from 'dotenv';

dotenv.config();

// === Global Status Tracker ===
export let botStatus = {
  connection: 'idle', // idle | connecting | qr | connecting_ws | connected | reconnecting | disconnected
  lastUpdate: new Date().toISOString(),
  phoneNumber: null,
  lastError: null
};

// === Folders ===
const authRoot = './auth';
const publicFolder = join(process.cwd(), 'public');
if (!existsSync(authRoot)) mkdirSync(authRoot, { recursive: true });
if (!existsSync(publicFolder)) mkdirSync(publicFolder, { recursive: true });

// === Config Files ===
const blocklistPath = './blocklist.json';
const featuresPath = './features.json';

// === Load Data ===
let blocklist = existsSync(blocklistPath)
  ? JSON.parse(readFileSync(blocklistPath))
  : [];

let features = existsSync(featuresPath)
  ? JSON.parse(readFileSync(featuresPath))
  : { autoview: true, faketyping: true };

// === Store (in-memory) ===
const store = makeInMemoryStore({});

function updateStatus(newStatus, extra = {}) {
  botStatus = {
    ...botStatus,
    connection: newStatus,
    lastUpdate: new Date().toISOString(),
    ...extra
  };
}

// Helper to save QR image
async function saveQrImage(qr) {
  try {
    const qrPath = join(publicFolder, 'qr.png');
    // write QR with higher error correction and small margin
    await QRCode.toFile(qrPath, qr, { errorCorrectionLevel: 'H', margin: 1, width: 700 });
    console.log(`✅ QR code saved at ${qrPath}`);
  } catch (e) {
    console.error('❌ Failed to save QR code:', e);
  }
}

// === Main Function ===
export async function startSession(sessionId = 'main', phoneNumber = null) {
  updateStatus('connecting', { phoneNumber: phoneNumber || null, lastError: null });
  const sessionDir = join(authRoot, sessionId);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion().catch((e) => {
    console.warn('⚠️ fetchLatestBaileysVersion failed, using default version.', e);
    return { version: [2, 3000, 0] };
  });

  console.log(`📦 Baileys version detected: ${version.join('.')}`);

  // Create socket with robust browser signature
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('DansBot')
  });

  // bind store to events for better state handling
  store.bind(sock.ev);

  // ensure credentials are saved
  sock.ev.on('creds.update', saveCreds);

  // connection updates
  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, qr, lastDisconnect } = update;

      // QR: show only when not using phone-number pairing
      if (qr && !phoneNumber) {
        updateStatus('qr');
        await saveQrImage(qr);
        console.log('🔎 New QR generated — scan at /qr (valid short time).');
        // schedule a QR refresh in 45s if still not connected
        setTimeout(async () => {
          // if still in qr state, request a fresh QR by restarting session instance
          if (botStatus.connection === 'qr') {
            console.log('⏳ QR likely expired — requesting new QR by restarting socket');
            try {
              await sock.logout().catch(() => {});
            } catch {}
            // re-start session (this will generate a fresh QR)
            startSession(sessionId, phoneNumber);
          }
        }, 45_000);
      }

      // connection states
      if (connection === 'connecting') {
        updateStatus('connecting_ws');
        console.log('🔌 Connecting websocket to WhatsApp...');
      }

      if (connection === 'open') {
        updateStatus('connected');
        console.log(`✅ WhatsApp session "${sessionId}" connected`);
        // once connected the store contains contacts and other state
        setupListeners(sock);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : lastDisconnect?.error?.statusCode || 'unknown';
        console.log(`❌ Disconnected. Code: ${statusCode}`, lastDisconnect?.error || '');
        updateStatus('disconnected', { lastError: statusCode });

        // handle logout vs temporary disconnect
        if (statusCode !== DisconnectReason.loggedOut) {
          updateStatus('reconnecting');
          console.log('🔁 Attempting to reconnect (will re-create socket)...');
          // small backoff before reconnect
          setTimeout(() => startSession(sessionId, phoneNumber), 2000);
        } else {
          console.log('⛔ Session logged out. Remove auth files and re-link.');
          // leave auth folder intact for manual deletion by user
        }
      }
    } catch (err) {
      console.error('🔥 connection.update handler error:', err);
      updateStatus('disconnected', { lastError: String(err) });
    }
  });

  // generate pairing code only when requested explicitly
  if (phoneNumber) {
    try {
      const pairingFile = join(publicFolder, 'pairing.txt');
      if (existsSync(pairingFile)) unlinkSync(pairingFile); // clear old code
      console.log(`📲 Generating pairing code for ${phoneNumber}...`);
      // requestPairingCode should be called once socket is created
      const code = await sock.requestPairingCode(phoneNumber);
      writeFileSync(pairingFile, code);
      console.log(`🔗 Pairing code ready (showing on dashboard): ${code}`);
      // update status to show pairing mode
      updateStatus('qr', { lastError: null });
    } catch (err) {
      console.error('❌ Pairing code generation failed:', err);
      updateStatus('disconnected', { lastError: String(err) });
    }
  }

  return sock;
}

// === Incoming Messages ===
async function handleIncomingMessage(sock, msg) {
  try {
    const sender = msg.key.remoteJid;
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      '';
    const command = text.trim().toLowerCase();

    if (blocklist.includes(sender)) return;

    const commands = {
      '.ping': '🏓 Pong!',
      '.alive': '✅ DansBot is alive!',
      '.status': `📊 Status:\n${Object.entries(features)
        .map(([k, v]) => `• ${k}: ${v ? '✅' : '❌'}`)
        .join('\n')}`,
      '.menu': `📜 Menu:\n• .ping\n• .alive\n• .status\n• .menu\n• .shutdown\n• .broadcast <msg>\n• .block <number>\n• .unblock <number>\n• .toggle <feature>`
    };

    if (commands[command]) {
      await sock.sendMessage(sender, { text: commands[command] }, { quoted: msg });
      return;
    }

    if (command.startsWith('.') && !commands[command]) {
      await sock.sendMessage(
        sender,
        { text: `❓ Unknown command: ${command}\nType .menu to see available commands.` },
        { quoted: msg }
      );
    }

    if (features.faketyping) {
      await sock.sendPresenceUpdate('composing', sender);
      await new Promise((res) => setTimeout(res, 1500));
      await sock.sendPresenceUpdate('paused', sender);
    }

    await sock.readMessages([msg.key]);
  } catch (err) {
    console.error('Error handling message:', err);
  }
}

// === Listeners ===
function setupListeners(sock) {
  // messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe) await handleIncomingMessage(sock, msg);
    }
  });

  // keep bot presence alive to avoid being marked offline
  setInterval(() => {
    try {
      sock.sendPresenceUpdate('available');
      console.log('🟢 Bot presence pinged');
    } catch (e) {
      // ignore if socket not ready
    }
  }, 30_000);
}