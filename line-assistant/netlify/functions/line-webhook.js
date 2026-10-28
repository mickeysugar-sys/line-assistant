// netlify/functions/line-webhook.js
//
// Receives incoming messages from your LINE Official Account (multi-user).
// Verifies the request came from LINE, works out WHO is writing (users table),
// pulls that person's own context from Supabase, asks Claude what to say, and
// replies via LINE's free Reply API.

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OWNER_LINE_USER_ID = process.env.LINE_USER_ID; // Mark (the owner)

// Google OAuth app credentials (shared). Each user's own refresh token lives in
// the users table; the owner falls back to the GOOGLE_REFRESH_TOKEN env var.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  // Verify the request signature (protects against spoofed webhooks)
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

  for (const lineEvent of body.events || []) {
    if (lineEvent.type === "message" && lineEvent.message.type === "text") {
      await handleTextMessage(lineEvent);
    }
  }

  return { statusCode: 200, body: "OK" };
};

async function replyText(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: String(text).slice(0, 4900) }],
    }),
  });
}

// Look up who is writing. The owner (LINE_USER_ID env var) is created
// automatically the first time, and any older single-user data is assigned to
// them. Anyone else must have been added to the users table first.
async function getUser(userId) {
  const { data: found } = await supabase
    .from("users")
    .select("*")
    .eq("line_user_id", userId)
    .maybeSingle();
  if (found) return found;

  if (userId === OWNER_LINE_USER_ID) {
    const { data: created } = await supabase
      .from("users")
      .insert({ line_user_id: userId, name: "Mark", is_owner: true })
      .select()
      .single();
    // Adopt data created before multi-user support existed
    await supabase
      .from("standing_instructions")
      .update({ line_user_id: userId })
      .is("line_user_id", null);
    await supabase
      .from("flagged_items")
      .update({ line_user_id: userId })
      .is("line_user_id", null);
    return created || { line_user_id: userId, name: "Mark", is_owner: true };
  }
  return null;
}

async function handleTextMessage(lineEvent) {
  const userId = lineEvent.source.userId;
  const userText = lineEvent.message.text;
  const replyToken = lineEvent.replyToken;

  const user = await getUser(userId);

  // Not set up yet: don't spend any AI calls, just tell them their ID.
  if (!user) {
    await replyText(
      replyToken,
      `Hi! You're not set up with this assistant yet. Send this ID to Mark so he can add you:\n\n${userId}`
    );
    return;
  }

  // Owner-only admin commands
  if (user.is_owner && /^\/(adduser|removeuser|users)\b/i.test(userText.trim())) {
    await handleAdminCommand(user, userText.trim(), replyToken);
    return;
  }

  // Log the incoming message
  await supabase.from("conversation_log").insert({
    role: "user",
    content: userText,
    line_user_id: userId,
  });

  // Pull THIS person's recent context only
  const { data: recentMessages } = await supabase
    .from("conversation_log")
    .select("role, content, created_at")
    .eq("line_user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);

  const { data: openItems } = await supabase
    .from("flagged_items")
    .select("summary, created_at")
    .eq("status", "open")
    .eq("line_user_id", userId)
    .order("created_at", { ascending: false });

  const { data: standingInstructions } = await supabase
    .from("standing_instructions")
    .select("id, instruction, created_at")
    .eq("status", "active")
    .eq("line_user_id", userId)
    .order("created_at", { ascending: false });

  const history = (recentMessages || [])
    .reverse()
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const openItemsText =
    (openItems || []).map((i) => `- ${i.summary}`).join("\n") ||
    "(none currently open)";

  const standingInstructionsText =
    (standingInstructions || [])
      .map((i) => `- [#${i.id}] ${i.instruction}`)
      .join("\n") || "(none yet)";

  const calendarEvents = await getUpcomingCalendarEvents(user);
  const calendarEventsText =
    calendarEvents
      .map(
        (e) =>
          `- ${e.summary} (${e.start} - ${e.end})${e.location ? ` @ ${e.location}` : ""}`
      )
      .join("\n") ||
    "(no events in the next 7 days, or no calendar connected)";

  const { reply, newInstruction, removeInstructionId } = await callClaude(
    user,
    history,
    userText,
    openItemsText,
    standingInstructionsText,
    calendarEventsText
  );

  await supabase.from("conversation_log").insert({
    role: "assistant",
    content: reply,
    line_user_id: userId,
  });

  if (newInstruction) {
    await supabase.from("standing_instructions").insert({
      instruction: newInstruction,
      status: "active",
      line_user_id: userId,
    });
  }

  // Only ever retire this person's own instructions
  if (removeInstructionId) {
    await supabase
      .from("standing_instructions")
      .update({ status: "retired" })
      .eq("id", removeInstructionId)
      .eq("line_user_id", userId);
  }

  await replyText(replyToken, reply);
}

// /adduser Uxxxxxxxx Name   |   /removeuser Uxxxxxxxx   |   /users
async function handleAdminCommand(owner, text, replyToken) {
  const [cmd, id, ...nameParts] = text.split(/\s+/);
  const name = nameParts.join(" ").trim();
  const c = cmd.toLowerCase();

  if (c === "/users") {
    const { data } = await supabase
      .from("users")
      .select("name, line_user_id, is_owner")
      .order("created_at", { ascending: true });
    const lines = (data || []).map(
      (u) => `- ${u.name}${u.is_owner ? " (owner)" : ""}: ${u.line_user_id}`
    );
    return replyText(replyToken, `Users:\n${lines.join("\n") || "(none)"}`);
  }

  if (!id || !/^U[0-9a-f]{32}$/i.test(id)) {
    return replyText(
      replyToken,
      "Usage:\n/adduser <LINE user ID> <Name>\n/removeuser <LINE user ID>\n/users"
    );
  }

  if (c === "/adduser") {
    if (!name) return replyText(replyToken, "Usage: /adduser <LINE user ID> <Name>");
    const { error } = await supabase
      .from("users")
      .upsert({ line_user_id: id, name, is_owner: false });
    return replyText(
      replyToken,
      error ? `Couldn't add: ${error.message}` : `Added ${name}. They can message the bot now.`
    );
  }

  if (c === "/removeuser") {
    if (id === owner.line_user_id) {
      return replyText(replyToken, "You can't remove the owner.");
    }
    await supabase.from("users").delete().eq("line_user_id", id);
    await supabase
      .from("standing_instructions")
      .update({ status: "retired" })
      .eq("line_user_id", id);
    return replyText(replyToken, "Removed. Their reminders are switched off.");
  }
}

async function getUpcomingCalendarEvents(user) {
  const refreshToken =
    user.google_refresh_token ||
    (user.is_owner ? process.env.GOOGLE_REFRESH_TOKEN : null);
  const calendarId =
    user.google_calendar_id ||
    (user.is_owner ? process.env.GOOGLE_CALENDAR_ID : null) ||
    "primary";

  // Calendar is optional — no token means no calendar, quietly.
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !refreshToken) {
    return [];
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      console.error("Failed to get Google access token:", JSON.stringify(tokenData));
      return [];
    }

    const now = new Date();
    const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: in7days.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
    });

    const eventsResponse = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
        calendarId
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

async function callClaude(
  user,
  history,
  userText,
  openItemsText,
  standingInstructionsText,
  calendarEventsText
) {
  const nowText = new Date().toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Bangkok",
  });

  const systemPrompt = `You are ${user.name}'s personal assistant, talking to them over LINE.
Be direct and concise — short, clear replies, no fluff.

The current date/time in Bangkok is: ${nowText}.

LANGUAGE: Always reply in the language of the person's LATEST message
(English, Thai, or whatever they write in). If they explicitly ask for a
language ("English please", "ตอบเป็นภาษาไทย"), switch immediately and keep using
it until they ask otherwise. Ignore the language of earlier assistant messages
in the conversation history — they must never decide the language of your reply.

Currently open/flagged items you raised earlier:
${openItemsText}

Standing instructions ${user.name} has given you to watch for on an ongoing basis
(each has an id in brackets, e.g. [#3]):
${standingInstructionsText}

Calendar events in the next 7 days:
${calendarEventsText}

Recent conversation:
${history}

Reply with ONLY a JSON object, no preamble, no markdown fences:
{
  "reply": "the message to send back on LINE",
  "new_instruction": "a short standing instruction to save, or null if this message wasn't asking you to watch/remember something new",
  "remove_instruction_id": the numeric id to retire if they asked you to stop watching something, or null
}

Only set new_instruction when ${user.name} is clearly giving you something to track
going forward (e.g. "keep an eye on X", "let me know if Y happens", "remind me about Z").
Ordinary questions or chat should have new_instruction: null.

You have a web search tool — use it whenever answering well requires current
information (news, prices, recent events, anything that could have changed
recently, or anything you're not confident about from memory alone). After
searching, still reply with ONLY the JSON object described above as your
final message — no extra commentary outside it.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });

  const data = await response.json();
  // With web search enabled, take the LAST text block — the final reply.
  const textBlocks = (data.content || []).filter((b) => b.type === "text");
  const textBlock = textBlocks[textBlocks.length - 1];

  if (!textBlock) {
    return {
      reply: "Sorry, I hit an error processing that.",
      newInstruction: null,
      removeInstructionId: null,
    };
  }

  return parseReply(textBlock.text);
}

// Claude is asked for JSON, but sometimes wraps it in fences/commentary or gets
// cut off. Pull the fields out robustly so nobody ever sees raw JSON.
function parseReply(raw) {
  const text = String(raw || "").trim();
  const clean = text.replace(/```(?:json)?/gi, "").trim();
  const candidates = [clean];
  const a = clean.indexOf("{");
  const b = clean.lastIndexOf("}");
  if (a !== -1 && b > a) candidates.push(clean.slice(a, b + 1));
  for (const c of candidates) {
    try {
      const p = JSON.parse(c);
      if (p && typeof p === "object") {
        return {
          reply: p.reply || "Got it.",
          newInstruction: p.new_instruction || null,
          removeInstructionId: p.remove_instruction_id || null,
        };
      }
    } catch {}
  }
  // Truncated or malformed JSON: grab just the reply string.
  const m = clean.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (m) {
    let r = m[1];
    try {
      r = JSON.parse('"' + r + '"');
    } catch {
      r = r.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    return { reply: r, newInstruction: null, removeInstructionId: null };
  }
  // Plain prose: send as-is.
  return { reply: text, newInstruction: null, removeInstructionId: null };
}
