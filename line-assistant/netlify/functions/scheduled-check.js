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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

exports.handler = async () => {
  const users = await getUsers();
  if (users.length === 0) {
    console.log("No users.");
    return { statusCode: 200, body: "No users" };
  }

  // Each person is checked independently, in parallel (scheduled functions
  // have a tight time limit). One person's failure never blocks the others.
  const results = await Promise.all(
    users.map((u) =>
      checkUser(u).catch((err) => {
        console.error(`Check failed for ${u.name}:`, err.message);
        return "error";
      })
    )
  );
  return { statusCode: 200, body: results.join(",") };
};

async function getUsers() {
  const { data, error } = await supabase.from("users").select("*");
  if (error) {
    console.error("Failed to load users:", error.message);
    return [];
  }
  const users = data || [];
  // Owner fallback: before the first chat message creates the owner's row,
  // still run for the owner so nothing is missed.
  if (LINE_USER_ID && !users.some((u) => u.line_user_id === LINE_USER_ID)) {
    users.push({ line_user_id: LINE_USER_ID, name: "Mark", is_owner: true });
  }
  return users;
}

async function checkUser(user) {
  const standingInstructions = await getStandingInstructions(user);
  const calendarEvents = await getUpcomingCalendarEvents(user);
  const sentToday = await getSentToday(user);

  if (standingInstructions.length === 0 && calendarEvents.length === 0) {
    console.log(`${user.name}: nothing to review.`);
    return "no-data";
  }

  const { shouldNotify, message, flaggedSummaries } = await evaluateAndDraft(
    user,
    standingInstructions,
    calendarEvents,
    sentToday
  );

  if (!shouldNotify || !message) {
    console.log(`${user.name}: nothing worth flagging.`);
    return "quiet";
  }

  for (const summary of flaggedSummaries || []) {
    await supabase
      .from("flagged_items")
      .insert({ summary, status: "open", line_user_id: user.line_user_id });
  }

  await supabase.from("conversation_log").insert({
    role: "assistant",
    content: message,
    line_user_id: user.line_user_id,
  });

  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: user.line_user_id,
      messages: [{ type: "text", text: message.slice(0, 4900) }],
    }),
  });

  return "pushed";
}

async function getStandingInstructions(user) {
  const { data, error } = await supabase
    .from("standing_instructions")
    .select("id, instruction")
    .eq("status", "active")
    .or(
      user.is_owner
        ? `line_user_id.eq.${user.line_user_id},line_user_id.is.null`
        : `line_user_id.eq.${user.line_user_id}`
    )
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to load standing instructions:", error.message);
    return [];
  }
  return data || [];
}

// Everything the assistant has already said to Mark since midnight Bangkok
// time, so frequency limits like "once per day" can actually be honored
// (each run is otherwise stateless).
async function getSentToday(user) {
  const day = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Bangkok",
  });
  const since = new Date(`${day}T00:00:00+07:00`).toISOString();
  const { data, error } = await supabase
    .from("conversation_log")
    .select("content, created_at")
    .eq("role", "assistant")
    .eq("line_user_id", user.line_user_id)
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Failed to load today's sent messages:", error.message);
    return [];
  }
  return data || [];
}

async function getUpcomingCalendarEvents(user) {
  const GOOGLE_REFRESH_TOKEN =
    user.google_refresh_token ||
    (user.is_owner ? process.env.GOOGLE_REFRESH_TOKEN : null);
  const GOOGLE_CALENDAR_ID =
    user.google_calendar_id ||
    (user.is_owner ? process.env.GOOGLE_CALENDAR_ID : null) ||
    "primary";

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

async function evaluateAndDraft(user, standingInstructions, calendarEvents, sentToday) {
  const instructionsText =
    standingInstructions.map((i) => `- ${i.instruction}`).join("\n") ||
    "(none)";
  const eventsText =
    calendarEvents
      .map((e) => `- ${e.summary} (${e.start} - ${e.end})${e.location ? ` @ ${e.location}` : ""}`)
      .join("\n") || "(no events in the next 24 hours)";
  const sentText =
    sentToday
      .map(
        (m) =>
          `- [${new Date(m.created_at).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            timeZone: "Asia/Bangkok",
          })}] ${m.content}`
      )
      .join("\n") || "(nothing sent yet today)";

  const nowText = new Date().toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Bangkok",
  });

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
      system: `You review information on ${user.name}'s behalf and decide if anything
needs his attention right now. Be conservative — only flag things that are
genuinely actionable or time-sensitive.

The current date/time in Bangkok is: ${nowText}. Use this to evaluate any
standing instruction that's conditional on a day of week, date, or month
(e.g. "every Thursday", "every July") — only treat it as due if today
actually matches.

This check runs three times a day. Below you're given the messages already
sent to ${user.name} today. Honor any frequency limit in a standing instruction
(e.g. "once per day", "only once", "weekly"): if that reminder already went
out in today's messages, do NOT send it again. In general, never repeat
something already delivered today unless it has materially changed.

Note: this scheduled check runs on a tight time budget (no web search here —
that's only available when ${user.name} messages the bot directly in LINE). Judge
only from the standing instructions and calendar events given below; if a
standing instruction needs a live lookup to evaluate, leave it unflagged
here and let ${user.name} ask about it directly instead.

Write the message in the language ${user.name} normally uses with you (see any
standing instruction or earlier messages; default English).

Reply with ONLY JSON as your final message, no preamble, no markdown fences:
{"shouldNotify": boolean, "message": "the LINE message to send, direct and concise", "flaggedSummaries": ["short summary 1", ...]}`,
      messages: [
        {
          role: "user",
          content: `Standing things ${user.name} has asked you to watch for:
${instructionsText}

Calendar events in the next 24 hours:
${eventsText}

Messages already sent to ${user.name} today (Bangkok time):
${sentText}`,
        },
      ],
    }),
  });

  const data = await response.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  try {
    const raw = textBlock.text;
    return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    return { shouldNotify: false, message: "", flaggedSummaries: [] };
  }
}
