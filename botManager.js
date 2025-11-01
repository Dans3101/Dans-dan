import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import QRCode from 'qrcode';
import dotenv from 'dotenv';

dotenv.config();

// === Global Status Tracker ===
export let botStatus = {
  connection: 'idle', // idle | connecting | connected | reconnecting | disconnected
  lastUpdate: new Date().toISOString(),
  phoneNumber: null
};

// === Folders ===
const authFolder = './auth';
const publicFolder = join(process.cwd(), 'public');
if (!existsSync(authFolder)) mkdirSync(authFolder);
if (!existsSync(publicFolder)) mkdirSync(publicFolder);

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

// === Main Function ===
export async function startSession(sessionId, phoneNumber = null) {
  botStatus.connection = 'connecting';
  botStatus.lastUpdate = new Date().toISOString();
  botStatus.phoneNumber = phoneNumber || null;

  const { state, saveCreds } = await useMultiFileAuthState(join(authFolder, sessionId));
  const { version } = await fetchLatestBaileysVersion();

  console.log(`📦 Baileys v${version.join('.')}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['DansBot', 'Chrome', '122']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    // QR LOGIN (default)
    if (qr && !phoneNumber) {
      const qrPath = join(publicFolder, 'qr.png');
      QRCode.toFile(qrPath, qr, (err) => {
        if (err) console.error('❌ Failed to save QR code:', err);
        else console.log(`✅ QR code saved at ${qrPath}`);
      });
    }

    // CONNECTION STATES
    if (connection === 'connecting') {
      botStatus.connection = 'connecting';
      botStatus.lastUpdate = new Date().toISOString();
    }

    if (connection === 'open') {
      botStatus.connection = 'connected';
      botStatus.lastUpdate = new Date().toISOString();
      console.log(`✅ WhatsApp session "${sessionId}" connected`);
      setupListeners(sock);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : 'unknown';
      console.log(`❌ Disconnected. Code: ${statusCode}`);

      botStatus.connection = 'disconnected';
      botStatus.lastUpdate = new Date().toISOString();

      if (statusCode !== DisconnectReason.loggedOut) {
        console.log('🔁 Reconnecting...');
        botStatus.connection = 'reconnecting';
        botStatus.lastUpdate = new Date().toISOString();
        startSession(sessionId, phoneNumber);
      }
    }
  });

  // === Pairing Code Login ===
  if (phoneNumber) {
    try {
      const pairingFile = join(publicFolder, 'pairing.txt');
      if (existsSync(pairingFile)) unlinkSync(pairingFile); // clear old code

      console.log(`📲 Generating pairing code for ${phoneNumber}...`);
      const code = await sock.requestPairingCode(phoneNumber);
      writeFileSync(pairingFile, code);
      console.log(`🔗 Pairing code ready: ${code}`);
    } catch (err) {
      console.error('❌ Pairing code generation failed:', err);
    }
  }
}

// === Incoming Messages ===
async function handleIncomingMessage(sock, msg) {
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
    await new Promise(res => setTimeout(res, 1500));
    await sock.sendPresenceUpdate('paused', sender);
  }

  await sock.readMessages([msg.key]);
}

// === Listeners ===
function setupListeners(sock) {
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe) await handleIncomingMessage(sock, msg);
    }
  });

  setInterval(() => {
    sock.sendPresenceUpdate('available');
    console.log('🟢 Bot is online');
  }, 30000);
}