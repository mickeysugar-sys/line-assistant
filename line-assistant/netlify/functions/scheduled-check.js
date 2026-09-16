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

// Google Calendar (OAuth refresh-token flow — see README for setup)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

exports.handler = async () => {
  // 1. Gather source data: standing instructions + calendar (extend here
  // with more sources later — Gmail, other connectors, etc).
  const standingInstructions = await getStandingInstructions();
  const calendarEvents = await getUpcomingCalendarEvents();

  if (standingInstructions.length === 0 && calendarEvents.length === 0) {
    console.log("Nothing to review this run.");
    return { statusCode: 200, body: "No data" };
  }

  // 2. Ask Claude what's worth flagging
  const { shouldNotify, message, flaggedSummaries } = await evaluateAndDraft(
    standingInstructions,
    calendarEvents
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

async function getStandingInstructions() {
  const { data, error } = await supabase
    .from("standing_instructions")
    .select("id, instruction")
    .eq("status", "active")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to load standing instructions:", error.message);
    return [];
  }
  return data || [];
}

async function getUpcomingCalendarEvents() {
  // Calendar is optional — if credentials aren't set up yet, skip quietly
  // rather than failing the whole run.
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    return [];
  }

  try {
    // 1. Exchange the long-lived refresh token for a short-lived access token
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: GOOGLE_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });
    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      console.error("Failed to get Google access token:", JSON.stringify(tokenData));
      return [];
    }

    // 2. Fetch events from now through the next 24 hours
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: in24h.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
    });

    const eventsResponse = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
        GOOGLE_CALENDAR_ID
      )}/events?${params}`,
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );
    const eventsData = await eventsResponse.json();

    return (eventsData.items || []).map((e) => ({
      summary: e.summary || "(no title)",
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      location: e.location || null,
    }));
  } catch (err) {
    console.error("Calendar fetch failed:", err.message);
    return [];
  }
}

async function evaluateAndDraft(standingInstructions, calendarEvents) {
  const instructionsText =
    standingInstructions.map((i) => `- ${i.instruction}`).join("\n") ||
    "(none)";
  const eventsText =
    calendarEvents
      .map((e) => `- ${e.summary} (${e.start} - ${e.end})${e.location ? ` @ ${e.location}` : ""}`)
      .join("\n") || "(no events in the next 24 hours)";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: `You review information on Mark's behalf and decide if anything
needs his attention right now. Be conservative — only flag things that are
genuinely actionable or time-sensitive. You have a web search tool — use it
if a standing instruction asks you to research or check on something that
requires current information. Reply with ONLY JSON as your final message,
no preamble, no markdown fences:
{"shouldNotify": boolean, "message": "the LINE message to send, direct and concise", "flaggedSummaries": ["short summary 1", ...]}`,
      messages: [
        {
          role: "user",
          content: `Standing things Mark has asked you to watch for:
${instructionsText}

Calendar events in the next 24 hours:
${eventsText}`,
        },
      ],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });

  const data = await response.json();
  const textBlocks = (data.content || []).filter((b) => b.type === "text");
  const textBlock = textBlocks[textBlocks.length - 1];
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return { shouldNotify: false, message: "", flaggedSummaries: [] };
  }
}
