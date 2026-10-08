// netlify/functions/research-background.js
//
// Background function (15 min budget, web search enabled). Handles the standing
// instructions that need live research or are date-specific: monthly business
// searches, trade-show reminders, etc. Runs daily; Claude decides whether
// anything research-type is actually due today, and only pushes to LINE if so.

const { createClient } = require("@supabase/supabase-js");

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
  );

exports.handler = async () => {
  const { data: instructions, error } = await supabase
  .from("standing_instructions")
  .select("id, instruction")
  .eq("status", "active")
  .order("created_at", { ascending: false });
  if (error || !instructions || instructions.length === 0) {
    console.log("No standing instructions to review.");
    return;
  }

  // What research we've already reported recently, so we don't repeat or
  // re-send the monthly report twice in one month.
  const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  const { data: past } = await supabase
  .from("flagged_items")
  .select("summary, created_at")
  .like("summary", "[research]%")
  .gte("created_at", since)
  .order("created_at", { ascending: false });

  const nowText = new Date().toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Bangkok",
  });

  const instructionsText = instructions
  .map((i) => `- ${i.instruction}`)
  .join("\n");
  const pastText =
    (past || [])
  .map((p) => `- (${String(p.created_at).slice(0, 10)}) ${p.summary}`)
  .join("\n") || "(nothing reported in the last 45 days)";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      system: `You run Mark's research-type standing instructions. The current date/time in Bangkok is: ${nowText}.

      Go through the standing instructions and handle ONLY those that need live research or are tied to a specific calendar date/period (e.g. a monthly business-opportunity search, trade-show reminders such as "every July" or "the day before the show"). Ignore simple recurring chores (e.g. garbage day) and anything scoped to "when Mark messages in" — other systems handle those.

      For each research-type instruction, decide whether it is due TODAY:
      - Monthly reports: due if nothing was reported for it in the past 45 days list below, or the last report was in a previous calendar month. Never send the same monthly report twice in one month.
      - Date-specific reminders: due only if today actually matches (right month, or exactly the day before an event). If due, use web search to confirm exact dates/venues.

      If nothing is due, do NOT use web search; reply shouldNotify false. If something is due, do the research, and write ONE concise LINE message (plain text, no markdown) with the findings. Don't repeat items already reported.

      Reply with ONLY JSON as your final message, no preamble, no code fences:
      {"shouldNotify": boolean, "message": "LINE message", "flaggedSummaries": ["short summary, e.g. which franchises were reported"]}`,
      messages: [
        {
          role: "user",
          content: `Standing instructions:\n${instructionsText}\n\nResearch already reported in the last 45 days:\n${pastText}`,
        },
        ],
    }),
  });

  const data = await response.json();
  const texts = (data.content || []).filter((b) => b.type === "text");
  const raw = texts.length ? texts[texts.length - 1].text : "";
  let result = { shouldNotify: false, message: "", flaggedSummaries: [] };
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    result = JSON.parse(raw.slice(start, end + 1));
  } catch {
    console.error("Could not parse research result:", raw.slice(0, 300));
    return;
  }

  if (!result.shouldNotify || !result.message) {
    console.log("Nothing research-related due today.");
    return;
  }

  for (const s of result.flaggedSummaries || []) {
    await supabase
    .from("flagged_items")
    .insert({ summary: `[research] ${s}`, status: "open" });
  }
  await supabase.from("conversation_log").insert({
    role: "assistant",
    content: result.message,
    line_user_id: LINE_USER_ID,
  });
  const push = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: LINE_USER_ID,
      messages: [{ type: "text", text: result.message.slice(0, 4900) }],
    }),
  });
  console.log("Research pushed to LINE, status:", push.status);
};
