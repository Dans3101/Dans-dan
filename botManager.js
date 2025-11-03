// -----------------------------------------------------------------------------
// 📱 DansDan WhatsApp Bot — Baileys v7+ Compatible
// -----------------------------------------------------------------------------

import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import dotenv from "dotenv";

dotenv.config();

// === Global Bot Status ===
export let botStatus = {
  connection: "idle", // idle | connecting | connected | disconnected | reconnecting
  lastUpdate: new Date().toISOString(),
  phoneNumber: null
};

// === Directories ===
const __dirname = process.cwd();
const authFolder = path.join(__dirname, "auth");
const publicFolder = path.join(__dirname, "public");
if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder);
if (!fs.existsSync(publicFolder)) fs.mkdirSync(publicFolder);

// === Config Files ===
const blocklistPath = path.join(__dirname, "blocklist.json");
const featuresPath = path.join(__dirname, "features.json");

// === Load Data ===
let blocklist = fs.existsSync(blocklistPath)
  ? JSON.parse(fs.readFileSync(blocklistPath))
  : [];

let features = fs.existsSync(featuresPath)
  ? JSON.parse(fs.readFileSync(featuresPath))
  : { autoview: true, faketyping: true };

// ============================================================================
// 🟢 START SESSION
// ============================================================================
export async function startSession(sessionId, phoneNumber = null) {
  botStatus.connection = "connecting";
  botStatus.lastUpdate = new Date().toISOString();
  botStatus.phoneNumber = phoneNumber || null;

  const { state, saveCreds } = await useMultiFileAuthState(path.join(authFolder, sessionId));
  const { version } = await fetchLatestBaileysVersion();

  console.log(`📦 Baileys version: ${version.join(".")}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["DansBot", "Chrome", "122"]
  });

  sock.ev.on("creds.update", saveCreds);

  // === CONNECTION HANDLER ===
  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;

    // Show QR for manual login
    if (qr && !phoneNumber) {
      const qrPath = path.join(publicFolder, "qr.png");
      QRCode.toFile(qrPath, qr, (err) => {
        if (err) console.error("❌ Failed to save QR code:", err);
        else console.log(`✅ QR code saved at ${qrPath}`);
      });
    }

    // Handle connection state changes
    if (connection === "connecting") {
      botStatus.connection = "connecting";
      botStatus.lastUpdate = new Date().toISOString();
    }

    if (connection === "open") {
      botStatus.connection = "connected";
      botStatus.lastUpdate = new Date().toISOString();
      console.log(`✅ WhatsApp session "${sessionId}" connected`);
      setupListeners(sock);
    }

    if (connection === "close") {
      const reason =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : "unknown";

      console.log(`❌ Disconnected. Reason code: ${reason}`);
      botStatus.connection = "disconnected";
      botStatus.lastUpdate = new Date().toISOString();

      if (reason !== DisconnectReason.loggedOut) {
        console.log("🔁 Reconnecting...");
        botStatus.connection = "reconnecting";
        botStatus.lastUpdate = new Date().toISOString();
        startSession(sessionId, phoneNumber);
      }
    }
  });

  // === PAIRING CODE LOGIN ===
  if (phoneNumber) {
    try {
      const pairingFile = path.join(publicFolder, "pairing.txt");
      if (fs.existsSync(pairingFile)) fs.unlinkSync(pairingFile);

      console.log(`📲 Requesting pairing code for ${phoneNumber}...`);
      const code = await sock.requestPairingCode(phoneNumber);
      fs.writeFileSync(pairingFile, code);
      console.log(`🔗 Pairing code generated: ${code}`);
    } catch (err) {
      console.error("❌ Failed to generate pairing code:", err);
    }
  }
}

// ============================================================================
// 💬 MESSAGE HANDLER
// ============================================================================
async function handleIncomingMessage(sock, msg) {
  const sender = msg.key.remoteJid;
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    "";
  const command = text.trim().toLowerCase();

  if (blocklist.includes(sender)) return;

  const commands = {
    ".ping": "🏓 Pong!",
    ".alive": "✅ DansBot is alive and running!",
    ".status": `📊 Status:\n${Object.entries(features)
      .map(([k, v]) => `• ${k}: ${v ? "✅" : "❌"}`)
      .join("\n")}`,
    ".menu":
      "📜 Menu:\n• .ping\n• .alive\n• .status\n• .menu\n• .block <number>\n• .unblock <number>\n• .toggle <feature>"
  };

  if (commands[command]) {
    await sock.sendMessage(sender, { text: commands[command] }, { quoted: msg });
    return;
  }

  if (command.startsWith(".") && !commands[command]) {
    await sock.sendMessage(
      sender,
      {
        text: `❓ Unknown command: ${command}\nType .menu to see available commands.`
      },
      { quoted: msg }
    );
  }

  // Fake typing (optional)
  if (features.faketyping) {
    await sock.sendPresenceUpdate("composing", sender);
    await new Promise((r) => setTimeout(r, 1200));
    await sock.sendPresenceUpdate("paused", sender);
  }

  // Auto-view
  if (features.autoview) {
    await sock.readMessages([msg.key]);
  }
}

// ============================================================================
// 📡 SETUP LISTENERS
// ============================================================================
function setupListeners(sock) {
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe) await handleIncomingMessage(sock, msg);
    }
  });

  // Keep connection alive
  setInterval(() => {
    sock.sendPresenceUpdate("available");
    console.log("🟢 Bot heartbeat: still online");
  }, 30000);
}