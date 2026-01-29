/**
 * MoneyBot, WhatsApp (Twilio) plus Audio Transcription plus Reply
 * Node.js, Express, Render friendly
 *
 * Required env vars:
 * OPENAI_API_KEY
 * TWILIO_ACCOUNT_SID
 * TWILIO_AUTH_TOKEN
 *
 * Optional (Google Sheets logging):
 * GOOGLE_SHEETS_SPREADSHEET_ID
 * GOOGLE_SHEETS_SHEET_NAME
 * GOOGLE_SERVICE_ACCOUNT_JSON
 */

import express from "express";
import axios from "axios";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import OpenAI from "openai";
import { google } from "googleapis";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  GOOGLE_SHEETS_SPREADSHEET_ID,
  GOOGLE_SHEETS_SHEET_NAME,
  GOOGLE_SERVICE_ACCOUNT_JSON
} = process.env;

function fatalIfMissing(name, value) {
  if (!value || String(value).trim() === "") {
    console.error(`FATAL, missing env var: ${name}`);
    process.exit(1);
  }
}

fatalIfMissing("OPENAI_API_KEY", OPENAI_API_KEY);
fatalIfMissing("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID);
fatalIfMissing("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const VALID_AUDIO_TYPES = new Set([
  "audio/ogg",
  "application/ogg",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/mp4",
  "audio/aac",
  "audio/amr"
]);

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

async function getSheetsClientIfConfigured() {
  if (!GOOGLE_SHEETS_SPREADSHEET_ID || !GOOGLE_SERVICE_ACCOUNT_JSON) return null;

  const creds = safeJsonParse(GOOGLE_SERVICE_ACCOUNT_JSON);
  if (!creds || !creds.client_email || !creds.private_key) {
    console.warn("Sheets logging disabled, GOOGLE_SERVICE_ACCOUNT_JSON is invalid");
    return null;
  }

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  return google.sheets({ version: "v4", auth });
}

async function appendToSheet(row) {
  const sheets = await getSheetsClientIfConfigured();
  if (!sheets) return;

  const sheetName = GOOGLE_SHEETS_SHEET_NAME || "Logs";
  const range = `${sheetName}!A1`;

  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] }
  });
}

function xmlEscape(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlMessage(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${xmlEscape(text)}</Message>
</Response>`;
}

async function downloadTwilioMediaToBuffer(mediaUrl) {
  const res = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    auth: {
      username: TWILIO_ACCOUNT_SID,
      password: TWILIO_AUTH_TOKEN
    },
    timeout: 30000,
    validateStatus: () => true
  });

  const contentType =
    (res.headers && (res.headers["content-type"] || res.headers["Content-Type"])) || "";
  const ct = String(contentType).toLowerCase();
  const buf = Buffer.from(res.data);

  if (res.status < 200 || res.status >= 300) {
    const text = ct.includes("xml") || ct.includes("text") ? buf.toString("utf8") : `[binary ${buf.length} bytes]`;
    throw new Error(`Twilio media download failed, status ${res.status}, content-type ${ct}, body ${text.slice(0, 800)}`);
  }

  if (ct.includes("xml")) {
    const text = buf.toString("utf8");
    throw new Error(`Twilio returned XML instead of audio, status ${res.status}, body ${text.slice(0, 800)}`);
  }

  return { buffer: buf, contentType: ct };
}

function pickExtensionFromContentType(contentType) {
  if (!contentType) return "bin";
  if (contentType.includes("ogg")) return "ogg";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "mp3";
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("mp4")) return "mp4";
  if (contentType.includes("aac")) return "aac";
  if (contentType.includes("amr")) return "amr";
  return "bin";
}

async function transcribeAudioFile(tempFilePath) {
  const result = await openai.audio.transcriptions.create({
    file: fs.createReadStream(tempFilePath),
    model: "gpt-4o-transcribe"
  });

  const text = result && result.text ? String(result.text).trim() : "";
  return text;
}

async function generateBotReply(userText) {
  console.log("USANDO PROMPT NOVO v3");

  const prompt = `
You are MoneyBot.
Always respond in the SAME language as the user.
Never give generic advice.
Be specific, short, and actionable.

Output exactly 5 lines, no extra lines:
1) Understood: <one short sentence summarizing what the user said>
2) Category: <one of: Food, Transport, Housing, Bills, Health, Leisure, Shopping, Education, Work, Other>
3) Subcategory: <one short label>
4) Action: <one concrete next step>
5) Question: <ask ONE short question only if something important is missing, otherwise write "ok">

If there is a money amount, repeat it in the Understood line.
If the amount is missing, ask for it in Question.
If the merchant or place is missing, ask for it in Question.
Prefer asking only one thing.

User input:
${userText}
`.trim();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You must follow the exact 5 line format, no extra text." },
      { role: "user", content: prompt }
    ],
    temperature: 0.5
  });

  const reply = completion?.choices?.[0]?.message?.content
    ? String(completion.choices[0].message.content).trim()
    : "";

  return reply || "Understood: I received your message, Category: Other, Subcategory: Other, Action: tell me the amount and merchant, Question: what was the amount";
}

app.get("/", (req, res) => {
  res.status(200).send("MoneyBot is running");
});

app.post("/twilio/whatsapp", async (req, res) => {
  const nowIso = new Date().toISOString();
  const from = req.body.From || "";
  const body = String(req.body.Body || "").trim();
  const numMedia = Number(req.body.NumMedia || 0);

  console.log("Incoming message", { from, numMedia, body: body ? body.slice(0, 160) : "" });

  try {
    let transcriptText = "";
    let mediaInfo = null;

    if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0 || "";
      const declaredType = String(req.body.MediaContentType0 || "").toLowerCase();

      mediaInfo = { mediaUrl, declaredType };
      console.log("Media info", mediaInfo);

      if (!mediaUrl) {
        const msg = "I received media but no audio link, please resend the voice message.";
        res.set("Content-Type", "text/xml").status(200).send(twimlMessage(msg));
        await appendToSheet([nowIso, from, "media_missing_url", "", declaredType, "", msg]);
        return;
      }

      const declaredOk = declaredType ? VALID_AUDIO_TYPES.has(declaredType) : true;

      const { buffer, contentType } = await downloadTwilioMediaToBuffer(mediaUrl);
      const detectedOk = contentType ? VALID_AUDIO_TYPES.has(contentType) : declaredOk;

      if (!declaredOk && !detectedOk) {
        const msg = "I received media but it does not look like supported audio, please send a voice message.";
        res.set("Content-Type", "text/xml").status(200).send(twimlMessage(msg));
        await appendToSheet([nowIso, from, "unsupported_media", "", `${declaredType}|${contentType}`, "", msg]);
        return;
      }

      const ext = pickExtensionFromContentType(contentType || declaredType);
      const fileName = `audio_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${ext}`;
      const tempFilePath = path.join(os.tmpdir(), fileName);

      fs.writeFileSync(tempFilePath, buffer);

      console.log("Audio saved", { tempFilePath, size: buffer.length, contentType, declaredType });

      transcriptText = await transcribeAudioFile(tempFilePath);

      try {
        fs.unlinkSync(tempFilePath);
      } catch {
      }

      console.log("Transcript length", transcriptText.length);
      console.log("Transcript preview", transcriptText.slice(0, 160));

      if (!transcriptText) {
        const msg = "I received your audio but the transcription was empty, please speak closer to the mic and resend.";
        res.set("Content-Type", "text/xml").status(200).send(twimlMessage(msg));
        await appendToSheet([nowIso, from, "transcript_empty", "", `${declaredType}|${contentType}`, "", msg]);
        return;
      }
    }

    const userText = transcriptText || body;

    if (!userText) {
      const msg = "I received your message but it was empty, please send text or audio again.";
      res.set("Content-Type", "text/xml").status(200).send(twimlMessage(msg));
      await appendToSheet([nowIso, from, "empty_input", "", "", "", msg]);
      return;
    }

    const reply = await generateBotReply(userText);

    res.set("Content-Type", "text/xml").status(200).send(twimlMessage(reply));

    await appendToSheet([
      nowIso,
      from,
      transcriptText ? "audio" : "text",
      userText,
      mediaInfo ? mediaInfo.declaredType : "",
      mediaInfo ? mediaInfo.mediaUrl : "",
      reply
    ]);
  } catch (err) {
    const errMsg =
      err?.message
        ? String(err.message)
        : (err?.response?.data ? String(err.response.data) : String(err));

    console.error("Error handling webhook", errMsg);

    const msg = "I had an error processing your message, please try again.";
    res.set("Content-Type", "text/xml").status(200).send(twimlMessage(msg));

    try {
      await appendToSheet([nowIso, from, "error", "", "", "", errMsg]);
    } catch {
    }
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`MoneyBot listening on port ${port}`);
});
