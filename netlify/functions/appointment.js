const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const TO_EMAIL = process.env.APPT_TO_EMAIL;        // office inbox
const FROM_EMAIL = process.env.APPT_FROM_EMAIL;    // verified sender in SendGrid

function bad(statusCode, msg) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: msg }),
  };
}

function ok(obj) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  };
}

// Simple per-IP throttle (good starter for low traffic)
const memoryRateLimit = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000; // 10 minutes
  const limit = 5;

  const entry = memoryRateLimit.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count += 1;
  memoryRateLimit.set(ip, entry);

  return entry.count <= limit;
}

function clean(str, max) {
  if (!str) return "";
  return String(str).trim().slice(0, max);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "Method not allowed");

  if (!SENDGRID_API_KEY || !TO_EMAIL || !FROM_EMAIL) {
    return bad(500, "Server not configured");
  }

  const ip =
    event.headers["x-nf-client-connection-ip"] ||
    event.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    "unknown";

  if (!rateLimit(ip)) return bad(429, "Too many requests. Try again later.");

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return bad(400, "Invalid JSON");
  }

  // Honeypot: if filled, quietly accept (bot)
  if (payload.company) return ok({ status: "ok" });

  const name = clean(payload.name, 80);
  const phone = clean(payload.phone, 30);
  const email = clean(payload.email, 120);
  const availability = clean(payload.availability, 200);
  const type = clean(payload.type, 60);
  const notes = clean(payload.notes, 400);

  if (!name || !phone || !availability || !type) {
    return bad(400, "Missing required fields");
  }

  const subject = `Appointment request: ${name} (${type})`;
  const text = [
    "New appointment request",
    "",
    `Name: ${name}`,
    `Phone: ${phone}`,
    `Email: ${email || "(not provided)"}`,
    `Type: ${type}`,
    `Availability: ${availability}`,
    `Notes: ${notes || "(none)"}`,
    "",
    `IP: ${ip}`,
    `Time: ${new Date().toISOString()}`,
  ].join("\n");

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: TO_EMAIL }] }],
      from: { email: FROM_EMAIL },
      reply_to: email ? { email } : undefined,
      subject,
      content: [{ type: "text/plain", value: text }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("SendGrid error", res.status, errText);
    return bad(502, "Email service error");
  }

  return ok({ status: "ok" });
};
