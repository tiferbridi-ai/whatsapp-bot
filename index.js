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
  const reply = body ? `You said: ${body}` : "Send a message like: Spent 12 on lunch";

  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Message>${reply}</Message>
    </Response>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
