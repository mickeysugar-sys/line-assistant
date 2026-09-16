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

// Google Calendar (OAuth refresh-token flow — same credentials scheduled-check.js uses)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";

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

  const { data: standingInstructions } = await supabase
      .from("standing_instructions")
      .select("id, instruction, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false });

  const history = (recentMessages || [])
      .reverse()
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

  const openItemsText = (openItems || [])
      .map((i) => `- ${i.summary}`)
      .join("\n") || "(none currently open)";

  const standingInstructionsText = (standingInstructions || [])
      .map((i) => `- [#${i.id}] ${i.instruction}`)
      .join("\n") || "(none yet)";

  // 3b. Pull upcoming calendar events too, so Mark can ask about his
  // schedule directly instead of only hearing about it from the scheduled
  // push. Wider window than the scheduled check (7 days, not 24h) since
  // a direct question like "what's this week look like" needs more range.
  const calendarEvents = await getUpcomingCalendarEvents();
    const calendarEventsText =
          calendarEvents
        .map((e) => `- ${e.summary} (${e.start} - ${e.end})${e.location ? ` @ ${e.location}` : ""}`)
      .join("\n") || "(no events in the next 7 days, or calendar not connected)";

  // 4. Ask Claude for a reply, plus a structured decision on whether this
  // message adds, removes, or doesn't touch a standing instruction.
  const { reply, newInstruction, removeInstructionId } = await callClaude(
        history,
        userText,
        openItemsText,
        standingInstructionsText,
        calendarEventsText
      );

  // 5. Log the assistant's reply
  await supabase.from("conversation_log").insert({
        role: "assistant",
        content: reply,
        line_user_id: userId,
  });

  // 5b. Save a new standing instruction if Claude identified one
  if (newInstruction) {
        await supabase.from("standing_instructions").insert({
                instruction: newInstruction,
                status: "active",
        });
  }

  // 5c. Retire a standing instruction if the user asked to stop watching it
  if (removeInstructionId) {
        await supabase
          .from("standing_instructions")
          .update({ status: "retired" })
          .eq("id", removeInstructionId);
  }

  // 6. Send it back via the free Reply API (uses replyToken, not push)
  await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
                replyToken,
                messages: [{ type: "text", text: reply }],
        }),
  });
}

async function getUpcomingCalendarEvents() {
    // Calendar is optional — if credentials aren't set up, skip quietly
  // rather than failing the whole message.
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
        return [];
  }

  try {
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

async function callClaude(history, userText, openItemsText, standingInstructionsText, calendarEventsText) {
    const systemPrompt = `You are Mark's personal assistant, talking to him over LINE.
    Be direct and concise — match his preference for short, clear replies, no fluff.

    Currently open/flagged items you raised earlier:
    ${openItemsText}

    Standing instructions Mark has given you to watch for on an ongoing basis
    (each has an id in brackets, e.g. [#3]):
    ${standingInstructionsText}

    Calendar events in the next 7 days (Moto Lessons calendar):
    ${calendarEventsText}

    Recent conversation:
    ${history}

    Reply with ONLY a JSON object, no preamble, no markdown fences:
    {
      "reply": "the message to send back to Mark on LINE",
        "new_instruction": "a short standing instruction to save, or null if this message wasn't asking you to watch/remember something new",
          "remove_instruction_id": the numeric id to retire if Mark asked you to stop watching something, or null
          }

          Only set new_instruction when Mark is clearly giving you something to track
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
                max_tokens: 1500,
                system: systemPrompt,
                messages: [{ role: "user", content: userText }],
                tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
  });

  const data = await response.json();
    // With web search enabled, the response can include search/tool blocks
  // before the final answer — take the LAST text block, which is Claude's
  // final reply after any searching is done.
  const textBlocks = (data.content || []).filter((b) => b.type === "text");
    const textBlock = textBlocks[textBlocks.length - 1];

  if (!textBlock) {
        return { reply: "Sorry, I hit an error processing that.", newInstruction: null, removeInstructionId: null };
  }

  try {
        const parsed = JSON.parse(textBlock.text);
        return {
                reply: parsed.reply || "Got it.",
                newInstruction: parsed.new_instruction || null,
                removeInstructionId: parsed.remove_instruction_id || null,
        };
  } catch {
        // Fallback: if Claude didn't return valid JSON, just use the raw text as the reply
      return { reply: textBlock.text, newInstruction: null, removeInstructionId: null };
  }
}
