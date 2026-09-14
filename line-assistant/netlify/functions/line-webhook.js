// netlify/functions/line-webhook.js
//
// Receives incoming messages from your LINE Official Account.
// Verifies the request really came from LINE, pulls recent context from
// Supabase, asks Claude what to say, and replies via LINE's free Reply API.

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// LINE requires a fast 200 OK response (it times out around a few seconds),
// so we ack immediately and let the actual work run before responding —
// on Netlify Functions this just means keeping the handler lean and fast.
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Netlify sometimes delivers the raw request body base64-encoded
  // (depending on content-type handling). Decode it first so the
  // signature is computed over the exact bytes LINE originally sent.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  // 1. Verify the request signature (protects against spoofed webhooks)
  const signature = event.headers["x-line-signature"];
  const expected = crypto
    .createHmac("SHA256", LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");

  if (signature !== expected) {
    console.error("Invalid LINE signature");
    return { statusCode: 401, body: "Invalid signature" };
  }

  const body = JSON.parse(rawBody);

  // Process each event (usually just one per webhook call)
  for (const lineEvent of body.events || []) {
    if (lineEvent.type === "message" && lineEvent.message.type === "text") {
      await handleTextMessage(lineEvent);
    }
    // Extend here later: postback events for quick-reply buttons, etc.
  }

  return { statusCode: 200, body: "OK" };
};

async function handleTextMessage(lineEvent) {
  const userId = lineEvent.source.userId;
  const userText = lineEvent.message.text;
  const replyToken = lineEvent.replyToken;

  // 2. Log the incoming message
  await supabase.from("conversation_log").insert({
    role: "user",
    content: userText,
    line_user_id: userId,
  });

  // 3. Pull recent context: last N turns + any open items the scheduled
  // check flagged, so the reply is grounded in what's actually pending.
  const { data: recentMessages } = await supabase
    .from("conversation_log")
    .select("role, content, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  const { data: openItems } = await supabase
    .from("flagged_items")
    .select("summary, created_at")
    .eq("status", "open")
    .order("created_at", { ascending: false });

  const history = (recentMessages || [])
    .reverse()
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const openItemsText = (openItems || [])
    .map((i) => `- ${i.summary}`)
    .join("\n") || "(none currently open)";

  // 4. Ask Claude for a reply
  const claudeReply = await callClaude(history, userText, openItemsText);

  // 5. Log the assistant's reply
  await supabase.from("conversation_log").insert({
    role: "assistant",
    content: claudeReply,
    line_user_id: userId,
  });

  // 6. Send it back via the free Reply API (uses replyToken, not push)
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: claudeReply }],
    }),
  });
}

async function callClaude(history, userText, openItemsText) {
  const systemPrompt = `You are Mark's personal assistant, talking to him over LINE.
Be direct and concise — match his preference for short, clear replies, no fluff.

Currently open/flagged items you raised earlier:
${openItemsText}

Recent conversation:
${history}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
    }),
  });

  const data = await response.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return textBlock ? textBlock.text : "Sorry, I hit an error processing that.";
}
