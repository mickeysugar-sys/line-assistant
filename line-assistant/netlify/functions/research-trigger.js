// netlify/functions/research-trigger.js
//
// Scheduled daily (see netlify.toml). Scheduled functions are capped at ~30s,
// too short for web research, so this just kicks off research-background
// (a Netlify background function: returns 202 instantly, runs up to 15 min).

exports.handler = async () => {
  const base = process.env.URL || "https://lineassistant.netlify.app";
  try {
    const res = await fetch(`${base}/.netlify/functions/research-background`, {
      method: "POST",
    });
    console.log("Triggered research-background, status:", res.status);
  } catch (err) {
    console.error("Failed to trigger research-background:", err.message);
  }
  return { statusCode: 200, body: "Triggered" };
};
