// -----------------------------------------------------------------------------
// 📱 DansBot WhatsApp Manager (Fixed + Stable + Live Tracker)
// -----------------------------------------------------------------------------

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { Boom } from '@hapi/boom';

// --- Global Bot Status Object ---
export const botStatus = {
  connection: 'idle',
  lastUpdate: new Date().toISOString(),
  phoneNumber: '',
  qrGenerated: false
};

// --- Utility Paths ---
const publicPath = path.join(process.cwd(), 'public');
const qrPath = path.join(publicPath, 'qr.png');
const pairingFile = path.join(publicPath, 'pairing.txt');

if (!fs.existsSync(publicPath)) fs.mkdirSync(publicPath);

// --- Core Bot Function ---
export async function startSession(sessionName = 'main', phoneNumber = '') {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(`./auth/${sessionName}`);
    const { version } = await fetchLatestBaileysVersion();

    botStatus.connection = 'connecting';
    botStatus.lastUpdate = new Date().toISOString();
    botStatus.phoneNumber = phoneNumber;

    console.log('🚀 Starting WhatsApp session...');
    console.log('📡 Using Baileys version:', version.join('.'));

    const sock = makeWASocket({
      version,
      logger: P({ level: 'silent' }),
      printQRInTerminal: true,
      auth: state,
      browser: ['DansBot', 'Chrome', '4.0']
    });

    // --- Generate QR code when needed ---
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        botStatus.qrGenerated = true;
        botStatus.connection = 'connecting';
        botStatus.lastUpdate = new Date().toISOString();
        await qrcode.toFile(qrPath, qr);
        console.log('✅ QR code updated — Scan it in WhatsApp Web');
      }

      if (connection === 'open') {
        botStatus.connection = 'connected';
        botStatus.lastUpdate = new Date().toISOString();
        console.log('🟢 WhatsApp Connected!');
        if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
      }

      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (reason === DisconnectReason.loggedOut) {
          console.log('❌ Session logged out. Clearing credentials.');
          fs.rmSync(`./auth/${sessionName}`, { recursive: true, force: true });
          botStatus.connection = 'disconnected';
        } else {
          console.log('🔁 Reconnecting...');
          botStatus.connection = 'reconnecting';
          startSession(sessionName);
        }
        botStatus.lastUpdate = new Date().toISOString();
      }
    });

    // --- Save credentials whenever updated ---
    sock.ev.on('creds.update', saveCreds);

    // --- Optional message event for testing ---
    sock.ev.on('messages.upsert', async (msg) => {
      try {
        const message = msg.messages[0];
        if (!message.message) return;

        const from = message.key.remoteJid;
        const text = message.message.conversation || message.message.extendedTextMessage?.text;

        if (text && text.toLowerCase() === 'ping') {
          await sock.sendMessage(from, { text: 'Pong! ✅ Bot is active.' });
        }
      } catch (err) {
        console.error('Error handling message:', err);
      }
    });

    // --- Pairing Code Login ---
    if (phoneNumber && !state.creds.registered) {
      console.log('📱 Requesting pairing code for:', phoneNumber);
      const code = await sock.requestPairingCode(phoneNumber);
      fs.writeFileSync(pairingFile, code, 'utf8');
      console.log('✅ Pairing code generated:', code);
    }
  } catch (err) {
    console.error('💥 Fatal error in startSession:', err);
    botStatus.connection = 'error';
    botStatus.lastUpdate = new Date().toISOString();
  }
}