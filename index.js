import express from "express";

const app = express();
app.use(express.urlencoded({ extended: false }));

// Simple in-memory store (temporary). Resets when Render restarts.
// userState: Map<userId, { dailyLimit: number|null, spentToday: number, lastDate: string }>
const userState = new Map();

function todayKey() {
  const d = new Date();
  // YYYY-MM-DD in server time (good enough for MVP)
  return d.toISOString().slice(0, 10);
}

function getOrCreateState(userId) {
  const key = todayKey();
  if (!userState.has(userId)) {
    userState.set(userId, { dailyLimit: null, spentToday: 0, lastDate: key });
    return userState.get(userId);
  }
  const state = userState.get(userId);
  // Reset daily spent if day changed
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

  if (hasAny(["coffee", "lunch", "dinner", "breakfast", "food", "restaurant", "pizza", "burger", "grocer", "grocery"])) return "Food";
  if (hasAny(["rent", "housing", "mortgage", "lease"])) return "Housing";
  if (hasAny(["gas", "uber", "lyft", "bus", "train", "metro", "transport", "parking"])) return "Transport";
  if (hasAny(["amazon", "clothes", "shopping", "shoes", "store"])) return "Shopping";
  if (hasAny(["netflix", "spotify", "subscription", "prime", "hulu", "disney"])) return "Subscriptions";
  if (hasAny(["doctor", "pharmacy", "hospital", "health", "medicine"])) return "Health";
  if (hasAny(["movie", "bar", "entertainment", "concert", "game"])) return "Entertainment";

  return "Other";
}

function isSetDailyLimit(text) {
  // Examples: "Daily limit 60" | "Set daily limit 50" | "My daily limit is 80"
  return /daily\s*limit/i.test(text) && /(\d+(\.\d+)?)/.test(text);
}

function isBalance(text) {
  // Examples: "Balance today" | "How much left" | "Left today"
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
  // Basic XML escaping for &, <, >
  const safe = String(msg).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `
<Response>
  <Message>${safe}</Message>
</Response>
`.trim();
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

app.get("/", (req, res) => {
  res.send("OK - bot is running");
});

// Helpful for testing in browser (GET)
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

    res.set("Content-Type", "text/xml");
    return res.send(twimlMessage(`✅ Daily limit set: $${limitValue}`));
  }

  // 2) Balance today
  if (isBalance(text)) {
    const spent = state.spentToday || 0;
    const limit = state.dailyLimit;

    let msg = `Today: $${spent} spent`;
    if (limit != null) {
      const left = Math.max(0, limit - spent);
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
    // MVP: we just confirm income; later we can use it for weekly safe-to-spend
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

    // If daily limit exists, show remaining
    let msg = `✅ Saved: $${amount} — ${category}`;
    if (state.dailyLimit != null) {
      const left = Math.max(0, Number((state.dailyLimit - state.spentToday).toFixed(2)));
      msg += ` · $${left} left today`;

      // Simple alerts at 80% and 100% (MVP: not throttled)
      const usedPct = state.spentToday / state.dailyLimit;
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
