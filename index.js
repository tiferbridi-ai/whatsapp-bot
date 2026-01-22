import express from "express";
import https from "https";

const app = express();
app.use(express.urlencoded({ extended: false }));

// ✅ Your Google Apps Script Web App URL
const SHEETS_WEBAPP_URL =
  "https://script.google.com/macros/s/AKfycbyhwVt31Ew4gNjMDn_UvFoJTVSPBK6dLDM7X800GRz46T_bpScdr2CtsOQfYIuzFohj/exec";

// Simple in-memory store (temporary). Resets when Render restarts.
// userState: Map<userId, { dailyLimit: number|null, spentToday: number, lastDate: string }>
const userState = new Map();

function todayKey() {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (server time)
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
  if (!match) return null;
  return Number(match[1]);
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
  const safe = String(msg)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `
<Response>
  <Message>${safe}</Message>
</Response>
`.trim();
}

// ---- Google Sheets logger (POST JSON to Apps Script) ----
function postJson(urlString, data) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlString);
      const payload = JSON.stringify(data);

      const options = {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      };

      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });

      req.on("error", reject);
      req.write(payload);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// fire-and-forget (don’t block WhatsApp reply)
function logToSheets(row) {
  postJson(SHEETS_WEBAPP_URL, row).catch((err) => {
    console.log("Sheets log error:", String(err));
  });
}

// ---- Onboarding text ----
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

app.get("/", (req, res) => {
  res.send("OK - bot is running");
});

app.get("/webhook", (req, res) => {
  res.send("Webhook is ready. Twilio must POST here.");
});

app.post("/webhook", (req, res) => {
  const body = (req.body.Body || "").trim();
  const from = req.body.From || "unknown";

  const state = getOrCreateState(from);

  // Empty message -> onboarding
  if (!body) {
    res.set("Content-Type", "text/xml");
    return res.send(twimlMessage(onboarding));
  }

  const text = body.toLowerCase();

  // 1) Set daily limit
  if (isSetDailyLimit(text)) {
    const limitValue = extractNumber(text);
    if (limitValue == null) {
      res.set("Content-Type", "text/xml");
      return res.send(twimlMessage(`❌ I couldn't find a number. Try: Daily limit 60`));
    }

    state.dailyLimit = limitValue;

    // Optional: log limit set (type=setting)
    logToSheets({
      timestamp: new Date().toISOString(),
      user: from,
      type: "setting_daily_limit",
      amount: limitValue,
      category: "",
      dailyLimit: state.dailyLimit,
      spentToday: state.spentToday,
    });

    res.set("Content-Type", "text/xml");
    return res.send(twimlMessage(`✅ Daily limit set: $${limitValue}`));
  }

  // 2) Balance today
  if (isBalance(text)) {
    const spent = state.spentToday || 0;
    const limit = state.dailyLimit;

    let msg = `Today: $${spent} spent`;
    if (limit != null) {
      const left = Math.max(0, Number((limit - spent).toFixed(2)));
      msg += ` · $${left} left (limit $${limit})`;
    } else {
      msg += ` · No daily limit set`;
    }

    res.set("Content-Type", "text/xml");
    return res.send(twimlMessage(msg));
  }

  // 3) Income
  if (isIncome(text)) {
    const amount = extractNumber(text);
    if (amount == null) {
      res.set("Content-Type", "text/xml");
      return res.send(twimlMessage(`❌ I couldn't understand this. Try: Got paid 800 today`));
    }

    // Log income to Sheets
    logToSheets({
      timestamp: new Date().toISOString(),
      user: from,
      type: "income",
      amount,
      category: "Income",
      dailyLimit: state.dailyLimit,
      spentToday: state.spentToday,
    });

    res.set("Content-Type", "text/xml");
    return res.send(twimlMessage(`✅ Saved: $${amount} — Income`));
  }

  // 4) Expense (fallback)
  if (isExpense(text) || extractNumber(text) != null) {
    const amount = extractNumber(text);
    if (amount == null) {
      res.set("Content-Type", "text/xml");
      return res.send(twimlMessage(`❌ I couldn't understand this. Try: Spent 12 on lunch`));
    }

    const category = detectCategory(text);
    state.spentToday = Number((state.spentToday + amount).toFixed(2));

    // Log expense to Sheets
    logToSheets({
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

      const usedPct = state.dailyLimit > 0 ? state.spentToday / state.dailyLimit : 0;
      if (usedPct >= 1) {
        msg += `\n🚫 Daily limit reached ($${state.dailyLimit}).`;
      } else if (usedPct >= 0.8) {
        msg += `\n⚠️ You’ve used 80% of your daily limit ($${state.spentToday} of $${state.dailyLimit}).`;
      }
    }

    res.set("Content-Type", "text/xml");
    return res.send(twimlMessage(msg));
  }

  // Default: onboarding
  res.set("Content-Type", "text/xml");
  return res.send(twimlMessage(onboarding));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
