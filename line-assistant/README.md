# Personal LINE Assistant

## Environment variables (set in Netlify site settings, not committed)

```
LINE_CHANNEL_SECRET=          # Basic settings tab, LINE Developers Console
LINE_CHANNEL_ACCESS_TOKEN=    # Messaging API tab, issue a long-lived token
LINE_USER_ID=                 # Your personal LINE user ID (see below)
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=         # service_role key, not anon — functions run server-side
```

## One-time console setup (LINE Developers Console)

1. developers.line.biz/console → create a Provider (or reuse an existing one)
2. Create a Channel → Messaging API type → name it, e.g. "Mark's Assistant"
3. Messaging API tab → issue Channel Access Token (long-lived) → copy to `LINE_CHANNEL_ACCESS_TOKEN`
4. Basic settings tab → copy Channel Secret → `LINE_CHANNEL_SECRET`
5. Messaging API tab → turn OFF auto-reply messages and greeting messages
   (so LINE's defaults don't interfere with Claude's replies)
6. Scan the channel QR code with your personal LINE app to add it as a friend
7. Send it any message ("hi") — this triggers your first webhook event once
   deployed, which will contain your `userId` in `event.source.userId`.
   Easiest way to capture it: temporarily log `event.body` in the webhook
   function and check the Netlify function logs after sending that message.
8. Once deployed, set the Webhook URL (Messaging API tab) to:
   `https://<your-site>.netlify.app/.netlify/functions/line-webhook`
   and toggle "Use webhook" on. Use the "Verify" button to confirm it's reachable.

## Deploy

```bash
npm install
netlify deploy --prod
```

## Wiring up what the scheduled check actually reviews

`scheduled-check.js` has a `gatherInformation()` stub — this is where you'll
plug in the real sources (Gmail API for email, Google Calendar, a Supabase
table fed by another process, etc). Kept isolated so sources can be added
without touching the push/reply logic.
