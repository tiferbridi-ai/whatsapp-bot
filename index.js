import express from "express";

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => {
  res.send("OK - bot is running");
});

app.post("/webhook", (req, res) => {
  // Twilio manda a mensagem em req.body.Body
  const body = (req.body.Body || "").trim();

  // Resposta mínima para testar
  const onboarding =
  `Hi! 👋\n` +
  `I help you organize your money.\n\n` +
  `Send messages like:\n` +
  `• Spent 12 on lunch\n` +
  `• Got paid 800 today\n\n` +
  `You can also send voice messages.\n` +
  `Let’s start 🙂`;

const reply = onboarding;

  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Message>${reply}</Message>
    </Response>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
