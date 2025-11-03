// -----------------------------------------------------------------------------
// 🌐 DansDan WhatsApp Bot — Express Dashboard (Render Compatible)
// -----------------------------------------------------------------------------

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { startSession, botStatus } from "./botManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const publicPath = path.join(process.cwd(), "public");

if (!existsSync(publicPath)) mkdirSync(publicPath);

app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicPath));

// === 🧠 Dashboard UI ===
app.get("/", (req, res) => {
  let pairingCode = "";
  const pairingFile = path.join(publicPath, "pairing.txt");
  if (existsSync(pairingFile)) pairingCode = readFileSync(pairingFile, "utf8").trim();

  const statusColors = {
    connected: "green",
    connecting: "orange",
    reconnecting: "gold",
    disconnected: "red",
    idle: "gray"
  };

  const color = statusColors[botStatus.connection] || "gray";
  const emoji =
    botStatus.connection === "connected"
      ? "🟢"
      : botStatus.connection === "reconnecting"
      ? "🟡"
      : botStatus.connection === "connecting"
      ? "🟠"
      : botStatus.connection === "disconnected"
      ? "🔴"
      : "⚪";

  res.send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <title>DansBot Dashboard</title>
      </head>
      <body style="text-align:center; padding:40px; font-family: Arial, sans-serif;">
        <h1>🤖 DansDan WhatsApp Bot Dashboard</h1>
        <h2>Status: ${emoji} 
          <span style="color:${color};">${botStatus.connection.toUpperCase()}</span>
        </h2>
        <p>Last Update: ${new Date(botStatus.lastUpdate).toLocaleString()}</p>
        <hr/>
        <div style="margin:30px;">
          <h3>Pairing Code</h3>
          <p style="font-size:22px; color:green;">
            ${pairingCode || "⌛ Waiting for code..."}
          </p>
        </div>
        <div style="margin:30px;">
          <h3>QR Code Login</h3>
          <img src="/qr.png" width="250" style="border:1px solid #ccc;">
        </div>
        <div style="margin-top:30px;">
          <form method="POST" action="/generate">
            <input type="text" name="phone" placeholder="e.g. 254712345678" style="padding:8px;" required>
            <button type="submit" style="padding:8px 16px;">Generate Pairing Code</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

// === 🧩 Generate Pairing Code ===
app.post("/generate", async (req, res) => {
  try {
    const phoneNumber = req.body.phone?.trim();
    if (!phoneNumber) {
      return res.send('<p>❌ Please provide a valid phone number.</p><a href="/">Go back</a>');
    }

    console.log(`📱 Generating new pairing code for: ${phoneNumber}`);
    await startSession("main", phoneNumber);
    res.redirect("/");
  } catch (err) {
    console.error("❌ Error generating pairing code:", err);
    res.status(500).send("<p>⚠️ Failed to generate pairing code. Check logs.</p>");
  }
});

// === 🛰️ Status Endpoint ===
app.get("/status", (req, res) => res.json(botStatus));

// === ❤️ Health Check (Render requirement) ===
app.get("/health", (req, res) => res.json({ status: "ok" }));

// === 🚀 Start Server & Bot Session ===
app.listen(PORT, async () => {
  console.log(`🌍 Server running at http://localhost:${PORT}`);
  console.log("🤖 Starting WhatsApp session...");
  try {
    await startSession("main");
  } catch (err) {
    console.error("❌ Failed to start WhatsApp session:", err);
  }
});