import express from "express";

const app = express();
app.use(express.urlencoded({ extended: false }));

// ✅ Google Apps Script Web App URL
const SHEETS_WEBAPP_URL =
  "https://script.google.com/macros/s/AKfycbyhwVt31Ew4gNjMDn_UvFoJTVSPBK6dLDM7X800GRz46T_bpScdr2CtsOQfYIuzFohj/exec";

// In-memory state (temporary)
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
  `Let’s start 🙂`;

// ✅ Sheets logger (with logs for debugging)
async function logToSheets(row) {
  try {
    const r = await fetch(SHEETS_WEBAPP_URL, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    });
    const txt = await r.text();
    console.log("Sheets status:", r.status, "body:", txt.slice(0, 200));
  } catch (err) {
    console.log("Sheets log error:", String(err));
  }
}

app.get("/", (req, res) => res.send("OK - bot is running"));
app.get("/webhook", (req, res) => res.send("Webhook is ready. Twilio must POST here."));

app.post("/webhook", async (req, res) => {
  const body = (req.body.Body || "").trim();
  const from = req.body.From || "unknown";
  const state = getOrCreateState(from);

  if (!body) {
    res.set("Content-Type", "text/xml");
    return res.send(twimlMessage(onboarding));
  }

  const text = body.toLowerCase();

  // Daily limit
  if (isSetDailyLimit(text)) {
    const limitValue = extractNumber(text);
    if (limitValue == null) {
      res.set("Content-Type", "text/xml");
      return res.send(twimlMessage("❌ Try: Daily limit 60"));
    }

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

    res.set("Content-Type", "text/xml");
    return res.send(twimlMessage(`✅ Daily limit set: $${limitValue}`));
  }

  // Balance
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

  // Income
  if (isIncome(text)) {
    const amount = extractNumber(text);
    if (amount == null) {
      res.set("Content-Type", "text/xml");
      return res.send(twimlMessage("❌ Try: Got paid 800"));
    }

    await logToSheets({
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

  // Expense
  if (isExpense(text) || extractNumber(text) != null) {
    const amount = extractNumber(text);
    if (amount == null) {
      res.set("Content-Type", "text/xml");
      return res.send(twimlMessage("❌ Try: Spent 12 on lunch"));
    }

    const category = detectCategory(text);
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

    res.set("Content-Type", "text/xml");
    return res.send(twimlMessage(msg));
  }

  res.set("Content-Type", "text/xml");
  return res.send(twimlMessage(onboarding));
});

// ✅ ONLY ONE PORT DECLARATION HERE
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
