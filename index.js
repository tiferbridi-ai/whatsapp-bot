import express from "express";

const app = express();
app.use(express.urlencoded({ extended: false }));

// ✅ Google Apps Script Web App URL
const SHEETS_WEBAPP_URL =
  "https://script.google.com/macros/s/AKfycbyhwVt31Ew4gNjMDn_UvFoJTVSPBK6dLDM7X800GRz46T_bpScdr2CtsOQfYIuzFohj/exec";

// ✅ Secrets (set on Render)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

// Transcription model
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe"; // fast/cheap

// In-memory daily state (temporary)
const userState = new Map();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
function getOrCreateState(userId) {
  const key = todayKey();
  if (!userState.has(userId)) {
    userState.set(userId, { dailyLimit: null, spentToday: 0, lastDate: key });
    return userState.get(userId);
  }
  const state = userState.get(userId);
  if (state.lastDate !== key) {
    state.spentToday = 0;
    state.lastDate = key;
  }
  return state;
}

function extractNumber(text) {
  const match = text.match(/(\d+(\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function detectCategory(text) {
  const t = text.toLowerCase();
  const hasAny = (arr) => arr.some((w) => t.includes(w));

  if (hasAny(["coffee", "lunch", "dinner", "breakfast", "food", "restaurant", "pizza", "burger", "grocer", "grocery"]))
    return "Food";
  if (hasAny(["rent", "housing", "mortgage", "lease"])) return "Housing";
  if (hasAny(["gas", "uber", "lyft", "bus", "train", "metro", "transport", "parking"])) return "Transport";
  if (hasAny(["amazon", "clothes", "shopping", "shoes", "store"])) return "Shopping";
  if (hasAny(["netflix", "spotify", "subscription", "prime", "hulu", "disney"])) return "Subscriptions";
  if (hasAny(["doctor", "pharmacy", "hospital", "health", "medicine"])) return "Health";
  if (hasAny(["movie", "bar", "entertainment", "concert", "game"])) return "Entertainment";

  return "Other";
}

function isSetDailyLimit(text) {
  return /daily\s*limit/i.test(text) && /(\d+(\.\d+)?)/.test(text);
}
function isBalance(text) {
  const t = text.toLowerCase();
  return t.includes("balance") || t.includes("left today") || t.includes("how much left");
}
function isIncome(text) {
  const t = text.toLowerCase();
  return t.includes("got paid") || t.includes("received") || t.includes("income") || t.includes("earned");
}
function isExpense(text) {
  const t = text.toLowerCase();
  return t.includes("spent") || t.includes("paid") || t.includes("bought") || t.includes("cost");
}

function twimlMessage(msg) {
  const safe = String(msg).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<Response><Message>${safe}</Message></Response>`;
}

const onboarding =
  `Hi! 👋\n` +
  `I help you organize your money.\n\n` +
  `Send messages like:\n` +
  `• Spent 12 on lunch\n` +
  `• Paid 45 for gas\n` +
  `• Got paid 800 today\n\n` +
  `Commands:\n` +
  `• Daily limit 60\n` +
  `• Balance today\n\n` +
  `You can also send voice messages.\n` +
  `Let’s start 🙂`;

// ✅ Sheets logger
async function logToSheets(row) {
  try {
    const r = await fetch(SHEETS_WEBAPP_URL, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    });
    const txt = await r.text();
    console.log("Sheets status:", r.status, "body:", txt.slice(0, 120));
  } catch (err) {
    console.log("Sheets log error:", String(err));
  }
}

// ✅ Twilio media download (Basic Auth)
async function downloadTwilioMedia(mediaUrl) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in env.");
  }
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const r = await fetch(mediaUrl, {
    method: "GET",
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Twilio media download failed: ${r.status} ${t.slice(0, 200)}`);
  }
  const contentType = r.headers.get("content-type") || "application/octet-stream";
  const arrayBuffer = await r.arrayBuffer();
  return { contentType, arrayBuffer };
}

// ✅ OpenAI transcription
async function transcribeAudio({ arrayBuffer, contentType }) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY in env.");

  const ext =
    contentType.includes("ogg") ? "ogg" :
    contentType.includes("webm") ? "webm" :
    contentType.includes("wav") ? "wav" :
    contentType.includes("mpeg") || contentType.includes("mp3") ? "mp3" :
    "bin";

  const blob = new Blob([arrayBuffer], { type: contentType });
  const form = new FormData();
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "json");
  form.append("file", blob, `voice.${ext}`);

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`OpenAI transcription failed: ${r.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return (json.text || "").trim();
}

// ✅ Unified text handler (typed OR transcribed)
async function handleTextMessage({ from, text }) {
  const state = getOrCreateState(from);
  const lower = (text || "").trim().toLowerCase();
  if (!lower) return onboarding;

  if (isSetDailyLimit(lower)) {
    const limitValue = extractNumber(lower);
    if (limitValue == null) return `❌ I couldn't find a number. Try: Daily limit 60`;

    state.dailyLimit = limitValue;

    await logToSheets({
      timestamp: new Date().toISOString(),
      user: from,
      type: "setting_daily_limit",
      amount: limitValue,
      category: "",
      dailyLimit: state.dailyLimit,
      spentToday: state.spentToday,
    });

    return `✅ Daily limit set: $${limitValue}`;
  }

  if (isBalance(lower)) {
    const spent = state.spentToday || 0;
    const limit = state.dailyLimit;

    let msg = `Today: $${spent} spent`;
    if (limit != null) {
      const left = Math.max(0, Number((limit - spent).toFixed(2)));
      msg += ` · $${left} left (limit $${limit})`;
    } else {
      msg += ` · No daily limit set`;
    }
    return msg;
  }

  if (isIncome(lower)) {
    const amount = extractNumber(lower);
    if (amount == null) return `❌ Try: Got paid 800 today`;

    await logToSheets({
      timestamp: new Date().toISOString(),
      user: from,
      type: "income",
      amount,
      category: "Income",
      dailyLimit: state.dailyLimit,
      spentToday: state.spentToday,
    });

    return `✅ Saved: $${amount} — Income`;
  }

  if (isExpense(lower) || extractNumber(lower) != null) {
    const amount = extractNumber(lower);
    if (amount == null) return `❌ Try: Spent 12 on lunch`;

    const category = detectCategory(lower);
    state.spentToday = Number((state.spentToday + amount).toFixed(2));

    await logToSheets({
      timestamp: new Date().toISOString(),
      user: from,
      type: "expense",
      amount,
      category,
      dailyLimit: state.dailyLimit,
      spentToday: state.spentToday,
    });

    let msg = `✅ Saved: $${amount} — ${category}`;
    if (state.dailyLimit != null) {
      const left = Math.max(0, Number((state.dailyLimit - state.spentToday).toFixed(2)));
      msg += ` · $${left} left today`;
    }
    return msg;
  }

  return onboarding;
}

app.get("/", (req, res) => res.send("OK - bot is running"));
app.get("/webhook", (req, res) => res.send("Webhook is ready. Twilio must POST here."));

app.post("/webhook", async (req, res) => {
  try {
    const from = req.body.From || "unknown";
    const typedBody = (req.body.Body || "").trim();
    const numMedia = Number(req.body.NumMedia || 0);

    console.log("Incoming message:", { from, numMedia, typedBody });

    let finalText = typedBody;

    if (numMedia > 0) {
      const mediaUrl0 = req.body.MediaUrl0;
      const mediaType0 = (req.body.MediaContentType0 || "").toLowerCase();

      console.log("Media info:", { mediaUrl0, mediaType0 });

      const looksLikeAudio =
        mediaType0.includes("audio") ||
        mediaType0.includes("ogg") ||
        mediaType0.includes("opus") ||
        mediaType0.includes("application");

      if (mediaUrl0 && looksLikeAudio) {
        const { contentType, arrayBuffer } = await downloadTwilioMedia(mediaUrl0);
        console.log("Downloaded media content-type:", contentType);

        const transcript = await transcribeAudio({ arrayBuffer, contentType });
        console.log("Transcript:", transcript);

        finalText = transcript;
      }
    }

    const reply = await handleTextMessage({ from, text: finalText });

    res.set("Content-Type", "text/xml");
    return res.send(twimlMessage(reply));
  } catch (err) {
    console.log("Webhook error:", String(err));
    res.set("Content-Type", "text/xml");
    return res.send(twimlMessage("❌ Sorry — I had trouble processing that voice message. Try sending text."));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
