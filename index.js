/**
 * MoneyBot, WhatsApp (Twilio) + Audio Transcription + Reply
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

if (!OPENAI_API_KEY) console.warn("Missing OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID) console.warn("Missing TWILIO_ACCOUNT_SID");
if (!TWILIO_AUTH_TOKEN) console.warn("Missing TWILIO_AUTH_TOKEN");

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
    console.warn("GOOGLE_SERVICE_ACCOUNT_JSON is invalid, skipping Sheets logging");
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
  try {
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
  } catch (err) {
    throw err;
  }
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
  const prompt = `
Você é o MoneyBot. Sua resposta tem que ser útil e específica, nunca genérica.

Regras obrigatórias
1. Comece com "Entendi:" e resuma em 1 linha o que a pessoa disse.
2. Se tiver um valor, repita o valor. Se não tiver, pergunte o valor.
3. Dê Categoria e Subcategoria.
4. Dê 1 ação objetiva de 1 linha.
5. Faça 1 pergunta curta para completar o registro, apenas se faltar um dado importante.

Formato obrigatório
Entendi: ...
Categoria: ...
Subcategoria: ...
Ação: ...
Pergunta: ... (se necessário, se não for necessário, escreva "Pergunta: ok")

Categorias permitidas
Alimentação, Transporte, Moradia, Contas, Saúde, Lazer, Compras, Educação, Trabalho, Outros

Entrada do usuário:
${userText}
`.trim();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Responda sempre no formato obrigatório, sem respostas genéricas." },
      { role: "user", content: prompt }
    ],
    temperature: 0.4
  });

  const reply = completion?.choices?.[0]?.message?.content
    ? String(completion.choices[0].message.content).trim()
    : "";

  return reply || "Entendi: sua mensagem, Categoria: Outros, Subcategoria: Outros, Ação: me diga o valor e o local, Pergunta: qual foi o valor";
}
