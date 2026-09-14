// netlify/functions/scheduled-check.js
//
// Runs a few times a day (configured in netlify.toml as a scheduled function).
// Gathers whatever the assistant is meant to review, asks Claude to decide
// what's worth flagging, and pushes a message to Mark's LINE if there's
// something worth surfacing. Silent if there's nothing to report.

const { createClient } = require("@supabase/supabase-js");

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID; // Mark's personal LINE user ID
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

exports.handler = async () => {
  // 1. Gather source data.
  // Placeholder — wire this up to whatever the assistant should actually
  // review each run (email via Gmail API, calendar, a Supabase table fed
  // by another process, etc). Keeping this isolated makes it easy to swap
  // or extend sources without touching the push/reply logic.
  const sourceData = await gatherInformation();

  if (!sourceData || sourceData.length === 0) {
    console.log("Nothing to review this run.");
    return { statusCode: 200, body: "No data" };
  }

  // 2. Ask Claude what's worth flagging
  const { shouldNotify, message, flaggedSummaries } = await evaluateAndDraft(
    sourceData
  );

  if (!shouldNotify) {
    console.log("Nothing worth flagging this run.");
    return { statusCode: 200, body: "Nothing to flag" };
  }

  // 3. Record flagged items so the webhook function has context if Mark
  // replies to follow up later
  for (const summary of flaggedSummaries) {
    await supabase
      .from("flagged_items")
      .insert({ summary, status: "open" });
  }

  // 4. Log and push the message
  await supabase.from("conversation_log").insert({
    role: "assistant",
    content: message,
    line_user_id: LINE_USER_ID,
  });

  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: LINE_USER_ID,
      messages: [{ type: "text", text: message }],
    }),
  });

  return { statusCode: 200, body: "Pushed" };
};

async function gatherInformation() {
  // TODO: replace with real sources (Gmail, calendar, Supabase-fed data
  // from another process, etc). Return an array of items to review.
  return [];
}

async function evaluateAndDraft(sourceData) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: `You review information on Mark's behalf and decide if anything
needs his attention right now. Be conservative — only flag things that are
genuinely actionable or time-sensitive. Reply ONLY with JSON, no preamble:
{"shouldNotify": boolean, "message": "the LINE message to send, direct and concise", "flaggedSummaries": ["short summary 1", ...]}`,
      messages: [
        { role: "user", content: JSON.stringify(sourceData) },
      ],
    }),
  });

  const data = await response.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return { shouldNotify: false, message: "", flaggedSummaries: [] };
  }
}
