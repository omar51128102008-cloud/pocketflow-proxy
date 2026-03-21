const express = require("express");
const cors = require("cors");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const Stripe = require("stripe");
const { Resend } = require("resend");

const app = express();
app.use(cors());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE; // e.g. +12015551234
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

const stripe = Stripe(STRIPE_SECRET_KEY);
const resend = new Resend(RESEND_API_KEY);

// ── TWILIO HELPER ─────────────────────────────────────────────────────────────
async function sendSMS(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE) {
    console.warn("Twilio not configured — skipping SMS");
    return { ok: false, reason: "not_configured" };
  }
  let phone = to.replace(/\D/g, "");
  if (phone.length === 10) phone = "1" + phone;
  if (!phone.startsWith("+")) phone = "+" + phone;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: TWILIO_PHONE, To: phone, Body: body }).toString(),
  });
  const data = await res.json();
  if (!res.ok) { console.error("Twilio error:", data); return { ok: false, error: data.message }; }
  console.log(`SMS sent to ${phone}: ${data.sid}`);
  return { ok: true, sid: data.sid };
}

// ── SUPABASE HELPER: Get owner email from auth ──────────────────────────────
async function getOwnerEmail(owner_id) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !owner_id) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${owner_id}`, {
      headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user?.email || null;
  } catch (e) { console.error("getOwnerEmail error:", e.message); return null; }
}

// ── WEBHOOK (must be before express.json()) ───────────────────────────────────
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;
  switch (event.type) {
    case "customer.subscription.created":
      console.log("Subscription created:", obj.id, obj.status);
      break;
    case "customer.subscription.updated":
      console.log("Subscription updated:", obj.id, "status:", obj.status, "cancel_at_period_end:", obj.cancel_at_period_end);
      break;
    case "customer.subscription.deleted":
      console.log("Subscription cancelled:", obj.id);
      break;
    case "invoice.payment_failed":
      console.log("Payment failed for customer:", obj.customer);
      break;
    default:
      console.log("Unhandled event:", event.type);
  }

  res.json({ received: true });
});

// ── JSON parsing (after webhook) ──────────────────────────────────────────────
app.use(express.json());

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", service: "pocketflow-proxy" }));

// ── AI CHAT ───────────────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  try {
    const { model, messages, max_tokens } = req.body;
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({ model: model || "llama-3.3-70b-versatile", messages, max_tokens: max_tokens || 300 }),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TEXT TO SPEECH ────────────────────────────────────────────────────────────
app.post("/speak", async (req, res) => {
  try {
    const { text } = req.body;
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "xi-api-key": ELEVENLABS_API_KEY },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.4, similarity_boost: 0.8, speed: 1.1 },
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error("ElevenLabs error:", response.status, errText);
      return res.status(500).json({ error: "TTS failed", details: errText });
    }
    const buffer = await response.arrayBuffer();
    res.set("Content-Type", "audio/mpeg");
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: CREATE PAYMENT INTENT (booking deposits) ─────────────────────────
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency, metadata } = req.body;
    if (!amount || amount < 50) {
      return res.status(400).json({ error: "Amount must be at least $0.50 (50 cents)." });
    }
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: currency || "usd",
      metadata: metadata || {},
    });
    res.json({ client_secret: paymentIntent.client_secret });
  } catch (err) {
    console.error("create-payment-intent error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: SUBSCRIPTION STATUS ───────────────────────────────────────────────
app.post("/subscription-status", async (req, res) => {
  try {
    const { email } = req.body;
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return res.json({ plan: "free" });

    const customer = customers.data[0];
    let subs = await stripe.subscriptions.list({ customer: customer.id, status: "active", limit: 1 });
    let sub = subs.data[0];
    let status = "active";

    if (!sub) {
      subs = await stripe.subscriptions.list({ customer: customer.id, status: "trialing", limit: 1 });
      sub = subs.data[0];
      status = "trialing";
    }

    if (!sub) return res.json({ plan: "free" });

    const priceId = sub.items.data[0].price.id;
    const plan = priceId === "price_1T8qP5RxHDrhPBhiNqLYFViQ" ? "starter" : "pro";

    res.json({
      plan, status,
      current_period_end: sub.current_period_end,
      cancel_at_period_end: sub.cancel_at_period_end,
      subscription_id: sub.id,
    });
  } catch (err) {
    console.error("subscription-status error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: CREATE CHECKOUT ───────────────────────────────────────────────────
app.post("/create-checkout", async (req, res) => {
  try {
    const { plan, price_id, user_id, email, success_url, cancel_url } = req.body;

    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({ email, metadata: { user_id } });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{ price: price_id, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14,
        metadata: { user_id, plan },
      },
      success_url: success_url + "&session_id={CHECKOUT_SESSION_ID}",
      cancel_url,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("create-checkout error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: CANCEL SUBSCRIPTION ───────────────────────────────────────────────
app.post("/cancel-subscription", async (req, res) => {
  try {
    const { email } = req.body;
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return res.json({ ok: false });

    const subs = await stripe.subscriptions.list({
      customer: customers.data[0].id, status: "active", limit: 1,
    });
    if (!subs.data.length) return res.json({ ok: false });

    await stripe.subscriptions.update(subs.data[0].id, { cancel_at_period_end: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: RESUME SUBSCRIPTION ───────────────────────────────────────────────
app.post("/resume-subscription", async (req, res) => {
  try {
    const { email } = req.body;
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return res.json({ ok: false });

    const subs = await stripe.subscriptions.list({
      customer: customers.data[0].id, status: "active", limit: 1,
    });
    if (!subs.data.length) return res.json({ ok: false });

    await stripe.subscriptions.update(subs.data[0].id, { cancel_at_period_end: false });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: BILLING PORTAL ────────────────────────────────────────────────────
app.post("/billing-portal", async (req, res) => {
  try {
    const { email, return_url } = req.body;
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return res.json({ ok: false });

    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post("/notify-booking", async (req, res) => {
  try {
    const { owner_email, owner_id, client_name, client_phone, client_email, booking_ref, service, date, time, phone, deposit, total, biz_name, note } = req.body;
    const clientPhone = client_phone || phone;
    const manageUrl = booking_ref ? `https://omar51128102008-cloud.github.io/pocketflow/book?manage=${booking_ref}` : null;
    console.log(`NEW BOOKING: ${client_name} → ${service} on ${date} at ${time}`);

    // Look up owner email from Supabase if not provided
    const ownerEmail = owner_email || await getOwnerEmail(owner_id);

    // Email to owner (best-effort)
    if (ownerEmail) {
      try {
        await resend.emails.send({
          from: "onboarding@resend.dev",
          to: ownerEmail,
          subject: `📅 New Booking — ${client_name}`,
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0f0f14;color:#fff;border-radius:16px;overflow:hidden;">
              <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px 28px 24px;">
                <div style="font-size:28px;margin-bottom:8px;font-weight:800">spool</div>
                <div style="font-size:22px;font-weight:800;margin-bottom:4px;">New Booking!</div>
                <div style="font-size:14px;opacity:0.8;">${biz_name}</div>
              </div>
              <div style="padding:28px;">
                <table style="width:100%;border-collapse:collapse;">
                  <tr><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;color:#888;font-size:13px;width:40%">Client</td><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;font-weight:700;font-size:14px;">${client_name}</td></tr>
                  <tr><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;color:#888;font-size:13px;">Phone</td><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;font-size:14px;">${clientPhone || "—"}</td></tr>
                  <tr><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;color:#888;font-size:13px;">Service</td><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;font-size:14px;">${service}</td></tr>
                  <tr><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;color:#888;font-size:13px;">Date</td><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;font-size:14px;">${date}</td></tr>
                  <tr><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;color:#888;font-size:13px;">Time</td><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;font-size:14px;">${time}</td></tr>
                  <tr><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;color:#888;font-size:13px;">Deposit</td><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;font-size:14px;color:#10b981;font-weight:700;">${deposit}</td></tr>
                  ${note ? `<tr><td style="padding:10px 0;color:#888;font-size:13px;">Note</td><td style="padding:10px 0;font-size:14px;">${note}</td></tr>` : ""}
                </table>
                <div style="margin-top:24px;padding:14px;background:#1e1e2e;border-radius:10px;font-size:12px;color:#888;text-align:center;">
                  Open spool to manage this appointment
                </div>
              </div>
            </div>
          `,
        });
      } catch (emailErr) {
        console.error("Owner email failed:", emailErr.message);
      }
    } else {
      console.warn("No owner email found — skipping owner notification email");
    }

    // Receipt email to client (best-effort)
    if (client_email) {
      try {
        await resend.emails.send({
          from: "onboarding@resend.dev",
          to: client_email,
          subject: `Your booking at ${biz_name} is confirmed!`,
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0f0f14;color:#fff;border-radius:16px;overflow:hidden;">
              <div style="background:linear-gradient(135deg,#10b981,#059669);padding:32px 28px 24px;">
                <div style="font-size:28px;margin-bottom:8px;">✓</div>
                <div style="font-size:22px;font-weight:800;margin-bottom:4px;">Booking Confirmed!</div>
                <div style="font-size:14px;opacity:0.8;">${biz_name}</div>
              </div>
              <div style="padding:28px;">
                <table style="width:100%;border-collapse:collapse;">
                  <tr><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;color:#888;font-size:13px;width:40%">Service</td><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;font-size:14px;font-weight:700">${service}</td></tr>
                  <tr><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;color:#888;font-size:13px;">Date</td><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;font-size:14px;">${date}</td></tr>
                  <tr><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;color:#888;font-size:13px;">Time</td><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;font-size:14px;">${time}</td></tr>
                  <tr><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;color:#888;font-size:13px;">Deposit Paid</td><td style="padding:10px 0;border-bottom:1px solid #1e1e2e;font-size:14px;color:#10b981;font-weight:700">${deposit}</td></tr>
                  ${total ? `<tr><td style="padding:10px 0;color:#888;font-size:13px;">Balance Due</td><td style="padding:10px 0;font-size:14px;">Remaining at appointment</td></tr>` : ""}
                </table>
                <div style="margin-top:24px;padding:14px;background:#1e1e2e;border-radius:10px;font-size:12px;color:#888;text-align:center;">
                  We look forward to seeing you! Save this email as your receipt.
                  ${manageUrl ? `<br/><a href="${manageUrl}" style="color:#a78bfa;font-weight:700;text-decoration:none;margin-top:8px;display:inline-block">Cancel or reschedule your booking</a>` : ""}
                </div>
              </div>
            </div>
          `,
        });
        console.log(`Receipt sent to ${client_email}`);
      } catch (receiptErr) {
        console.error("Client receipt email failed:", receiptErr.message);
      }
    }

    // SMS confirmation to client
    if (clientPhone) {
      const smsText = manageUrl
        ? `Hi ${client_name}! Your ${service} at ${biz_name} is confirmed for ${date} at ${time}. Manage your booking: ${manageUrl}`
        : `Hi ${client_name}! Your ${service} at ${biz_name} is confirmed for ${date} at ${time}. See you then!`;
      await sendSMS(clientPhone, smsText);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("notify-booking error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── APPOINTMENT REMINDER (24h before — call this from a cron job or manually) ─
app.post("/send-reminder", async (req, res) => {
  try {
    const { client_name, client_phone, service, date, time, biz_name } = req.body;
    console.log(`REMINDER: ${client_name} has ${service} on ${date} at ${time} at ${biz_name}`);

    if (!client_phone) return res.json({ ok: false, reason: "no_phone" });

    const result = await sendSMS(client_phone,
      `Hi ${client_name}! Reminder: you have a ${service} appointment at ${biz_name} tomorrow, ${date} at ${time}. Reply STOP to opt out.`
    );
    res.json(result);
  } catch (err) {
    console.error("send-reminder error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AUTO REMINDERS: Find tomorrow's appointments and send SMS ────────────────
const CRON_SECRET = process.env.CRON_SECRET;

async function runRemindersLogic() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { ok: false, reason: "supabase_not_configured" };
  }

  // Build tomorrow's date string like "Wed Jul 9"
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayStr = `${days[tomorrow.getDay()]} ${months[tomorrow.getMonth()]} ${tomorrow.getDate()}`;

  console.log(`Running reminders for: ${dayStr}`);

  // Fetch tomorrow's confirmed appointments
  const apptRes = await fetch(
    `${SUPABASE_URL}/rest/v1/appointments?select=client_name,client_phone,service,time,day,owner_id&day=eq.${encodeURIComponent(dayStr)}&status=eq.confirmed`,
    { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const appointments = await apptRes.json();
  if (!appointments || !Array.isArray(appointments) || appointments.length === 0) {
    console.log("No appointments tomorrow.");
    return { ok: true, sent: 0 };
  }

  let sent = 0;
  for (const appt of appointments) {
    // Use phone from appointment if available, otherwise look up from clients table
    let phone = appt.client_phone;
    if (!phone) {
      const clientRes = await fetch(
        `${SUPABASE_URL}/rest/v1/clients?select=phone&owner_id=eq.${appt.owner_id}&name=eq.${encodeURIComponent(appt.client_name)}&limit=1`,
        { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
      );
      const clients = await clientRes.json();
      phone = clients?.[0]?.phone;
    }
    if (!phone) { console.log(`No phone for ${appt.client_name}, skipping`); continue; }

    // Look up biz name
    const bizRes = await fetch(
      `${SUPABASE_URL}/rest/v1/business_profiles?select=biz_name&user_id=eq.${appt.owner_id}&limit=1`,
      { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const bizData = await bizRes.json();
    const bizName = bizData?.[0]?.biz_name || "your stylist";

    const result = await sendSMS(phone,
      `Hi ${appt.client_name}! Reminder: you have a ${appt.service} appointment at ${bizName} tomorrow, ${appt.day} at ${appt.time}. Reply STOP to opt out.`
    );
    if (result.ok) sent++;
  }

  console.log(`Reminders sent: ${sent}/${appointments.length}`);
  return { ok: true, sent, total: appointments.length };
}

app.post("/run-reminders", async (req, res) => {
  try {
    const reminderResult = await runRemindersLogic();
    const rebookResult = await runRebookLogic();
    const reviewResult = await runReviewRequests();
    const weeklyResult = await runWeeklySummary();
    res.json({ reminders: reminderResult, rebook: rebookResult, reviews: reviewResult, weekly: weeklyResult });
  }
  catch (err) { console.error("run-reminders error:", err.message); res.status(500).json({ error: err.message }); }
});

// GET so a cron service (e.g. cron-job.org) can hit: GET /run-reminders?key=YOUR_CRON_SECRET
app.get("/run-reminders", async (req, res) => {
  if (CRON_SECRET && req.query.key !== CRON_SECRET) {
    return res.status(403).json({ error: "Invalid key" });
  }
  try {
    const reminderResult = await runRemindersLogic();
    const rebookResult = await runRebookLogic();
    const reviewResult = await runReviewRequests();
    const weeklyResult = await runWeeklySummary();
    res.json({ reminders: reminderResult, rebook: rebookResult, reviews: reviewResult, weekly: weeklyResult });
  }
  catch (err) { console.error("run-reminders error:", err.message); res.status(500).json({ error: err.message }); }
});

// ── REBOOK REMINDERS: Nudge clients 3 days after their appointment ───────────
async function runRebookLogic() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { ok: false, reason: "supabase_not_configured" };

  try {
    // Build date string for 3 days ago like "Wed Jul 9"
    const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const target = new Date();
    target.setDate(target.getDate() - 3);
    const dayStr = `${days[target.getDay()]} ${months[target.getMonth()]} ${target.getDate()}`;

    console.log(`Running rebook nudges for appointments on: ${dayStr}`);

    const apptRes = await fetch(
      `${SUPABASE_URL}/rest/v1/appointments?select=client_name,client_phone,service,day,owner_id&day=eq.${encodeURIComponent(dayStr)}&status=eq.confirmed`,
      { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const appointments = await apptRes.json();
    if (!appointments || !Array.isArray(appointments) || appointments.length === 0) {
      console.log("No rebook candidates.");
      return { ok: true, sent: 0 };
    }

    let sent = 0;
    for (const appt of appointments) {
      let phone = appt.client_phone;
      if (!phone) {
        const clientRes = await fetch(
          `${SUPABASE_URL}/rest/v1/clients?select=phone&owner_id=eq.${appt.owner_id}&name=eq.${encodeURIComponent(appt.client_name)}&limit=1`,
          { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
        );
        const clients = await clientRes.json();
        phone = clients?.[0]?.phone;
      }
      if (!phone) continue;

      const bizRes = await fetch(
        `${SUPABASE_URL}/rest/v1/business_profiles?select=biz_name&user_id=eq.${appt.owner_id}&limit=1`,
        { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
      );
      const bizData = await bizRes.json();
      const bizName = bizData?.[0]?.biz_name || "your stylist";

      const result = await sendSMS(phone,
        `Hi ${appt.client_name}! Hope you loved your ${appt.service} at ${bizName}! Ready to book your next appointment? Reply or visit our booking page anytime.`
      );
      if (result.ok) sent++;
    }

    console.log(`Rebook nudges sent: ${sent}/${appointments.length}`);
    return { ok: true, sent, total: appointments.length };
  } catch (err) {
    console.error("runRebookLogic error:", err.message);
    return { ok: false, error: err.message };
  }
}


// ── REVIEW REQUESTS: Send "How was your visit?" 2h after appointment ─────────
async function runReviewRequests() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { ok: false, reason: "supabase_not_configured" };
  try {
    // Find appointments from today that are confirmed and time was 2+ hours ago
    const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const now = new Date();
    const todayStr = `${days[now.getDay()]} ${months[now.getMonth()]} ${now.getDate()}`;

    const apptRes = await fetch(
      `${SUPABASE_URL}/rest/v1/appointments?select=client_name,client_phone,service,time,booking_ref,owner_id,review_requested&day=eq.${encodeURIComponent(todayStr)}&status=eq.confirmed`,
      { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const appointments = await apptRes.json();
    if (!appointments || !Array.isArray(appointments) || appointments.length === 0) {
      return { ok: true, sent: 0 };
    }

    let sent = 0;
    for (const appt of appointments) {
      if (appt.review_requested) continue;
      if (!appt.client_phone || !appt.booking_ref) continue;

      // Check if appointment time was 2+ hours ago
      try {
        const tp = appt.time.match(/(\d+):(\d+)\s*(AM|PM)/i);
        if (!tp) continue;
        let h = parseInt(tp[1]);
        if (tp[3].toUpperCase() === "PM" && h < 12) h += 12;
        if (tp[3].toUpperCase() === "AM" && h === 12) h = 0;
        const apptTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, parseInt(tp[2]));
        const hoursSince = (now - apptTime) / 3600000;
        if (hoursSince < 2 || hoursSince > 8) continue; // Only send 2-8h after
      } catch { continue; }

      // Get biz name
      const bizRes = await fetch(
        `${SUPABASE_URL}/rest/v1/business_profiles?select=biz_name&user_id=eq.${appt.owner_id}&limit=1`,
        { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
      );
      const bizData = await bizRes.json();
      const bizName = bizData?.[0]?.biz_name || "your stylist";
      const reviewUrl = `https://omar51128102008-cloud.github.io/pocketflow/book?review=${appt.booking_ref}`;

      const result = await sendSMS(appt.client_phone,
        `Hi ${appt.client_name.split(" ")[0]}! How was your ${appt.service} at ${bizName}? We'd love your feedback! Leave a quick review: ${reviewUrl}`
      );

      if (result.ok) {
        sent++;
        // Mark as review requested
        await fetch(
          `${SUPABASE_URL}/rest/v1/appointments?booking_ref=eq.${appt.booking_ref}`,
          {
            method: "PATCH",
            headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ review_requested: true }),
          }
        );
      }
    }

    console.log(`Review requests sent: ${sent}`);
    return { ok: true, sent };
  } catch (err) {
    console.error("runReviewRequests error:", err.message);
    return { ok: false, error: err.message };
  }
}

// ── WEEKLY SUMMARY: Send every Monday morning ────────────────────────────────
async function runWeeklySummary() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { ok: false, reason: "supabase_not_configured" };
  // Only run on Mondays
  if (new Date().getDay() !== 1) return { ok: true, skipped: "not_monday" };

  try {
    // Get all business owners
    const profRes = await fetch(
      `${SUPABASE_URL}/rest/v1/business_profiles?select=user_id,biz_name`,
      { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const profiles = await profRes.json();
    if (!profiles || !Array.isArray(profiles)) return { ok: true, sent: 0 };

    let sent = 0;
    for (const prof of profiles) {
      // Get last 7 days of appointments
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);

      const apptRes = await fetch(
        `${SUPABASE_URL}/rest/v1/appointments?select=price,status,client_name,created_at&owner_id=eq.${prof.user_id}&created_at=gte.${weekAgo.toISOString()}`,
        { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
      );
      const appts = await apptRes.json();
      if (!appts || !Array.isArray(appts) || appts.length === 0) continue;

      const confirmed = appts.filter(a => a.status === "confirmed");
      const revenue = confirmed.reduce((s, a) => s + (parseInt((a.price || "0").replace(/\D/g, "")) || 0), 0);
      const newClients = [...new Set(appts.map(a => a.client_name))].length;
      const cancelled = appts.filter(a => a.status === "cancelled").length;

      // Get owner email
      const ownerEmail = await getOwnerEmail(prof.user_id);
      if (!ownerEmail) continue;

      try {
        await resend.emails.send({
          from: "onboarding@resend.dev",
          to: ownerEmail,
          subject: `📊 Your Weekly Summary — ${prof.biz_name}`,
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0f0f14;color:#fff;border-radius:16px;overflow:hidden;">
              <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px 28px 24px;">
                <div style="font-size:14px;opacity:0.8;margin-bottom:4px">Weekly Summary</div>
                <div style="font-size:22px;font-weight:800">${prof.biz_name}</div>
              </div>
              <div style="padding:28px;">
                <div style="display:flex;gap:16px;margin-bottom:24px;">
                  <div style="flex:1;background:#1e1e2e;border-radius:12px;padding:16px;text-align:center">
                    <div style="font-size:28px;font-weight:800;color:#fbbf24">$${revenue}</div>
                    <div style="font-size:12px;color:#888;margin-top:4px">Revenue</div>
                  </div>
                  <div style="flex:1;background:#1e1e2e;border-radius:12px;padding:16px;text-align:center">
                    <div style="font-size:28px;font-weight:800;color:#c4b5fd">${confirmed.length}</div>
                    <div style="font-size:12px;color:#888;margin-top:4px">Appointments</div>
                  </div>
                </div>
                <div style="display:flex;gap:16px;margin-bottom:24px;">
                  <div style="flex:1;background:#1e1e2e;border-radius:12px;padding:16px;text-align:center">
                    <div style="font-size:28px;font-weight:800;color:#4ade80">${newClients}</div>
                    <div style="font-size:12px;color:#888;margin-top:4px">Clients</div>
                  </div>
                  <div style="flex:1;background:#1e1e2e;border-radius:12px;padding:16px;text-align:center">
                    <div style="font-size:28px;font-weight:800;color:#fb7185">${cancelled}</div>
                    <div style="font-size:12px;color:#888;margin-top:4px">Cancelled</div>
                  </div>
                </div>
                <div style="text-align:center;font-size:14px;color:#888;padding:12px;background:#1e1e2e;border-radius:10px;">
                  Open spool to see your full dashboard ✦
                </div>
              </div>
            </div>
          `,
        });
        sent++;
      } catch (emailErr) {
        console.error(`Weekly summary email failed for ${prof.user_id}:`, emailErr.message);
      }
    }

    console.log(`Weekly summaries sent: ${sent}`);
    return { ok: true, sent };
  } catch (err) {
    console.error("runWeeklySummary error:", err.message);
    return { ok: false, error: err.message };
  }
}


// ── GOOGLE CALENDAR TOKEN STORAGE (persisted in Supabase) ───────────────────

async function getGoogleToken(owner_id) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/google_tokens?select=access_token,refresh_token,expiry,email&owner_id=eq.${owner_id}&limit=1`,
      { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const rows = await res.json();
    if (!rows || rows.length === 0) return null;
    const token = rows[0];
    // If token expired but we have refresh_token, auto-refresh
    if (token.expiry && Date.now() > token.expiry && token.refresh_token) {
      try {
        const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `grant_type=refresh_token&refresh_token=${token.refresh_token}&client_id=${process.env.GOOGLE_CLIENT_ID || ""}&client_secret=${process.env.GOOGLE_CLIENT_SECRET || ""}`,
        });
        const refreshData = await refreshRes.json();
        if (refreshData.access_token) {
          const newExpiry = Date.now() + (refreshData.expires_in || 3600) * 1000;
          await saveGoogleToken(owner_id, refreshData.access_token, newExpiry, token.email, token.refresh_token);
          return { access_token: refreshData.access_token, expiry: newExpiry, email: token.email };
        }
      } catch (e) { console.error("Token refresh failed:", e.message); }
    }
    return token;
  } catch (e) { console.error("getGoogleToken error:", e.message); return null; }
}

async function saveGoogleToken(owner_id, access_token, expiry, email, refresh_token) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return false;
  try {
    const body = { owner_id, access_token, expiry, email };
    if (refresh_token) body.refresh_token = refresh_token;
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/google_tokens`,
      {
        method: "POST",
        headers: {
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates",
        },
        body: JSON.stringify(body),
      }
    );
    return res.ok;
  } catch (e) { console.error("saveGoogleToken error:", e.message); return false; }
}

app.post("/save-google-token", async (req, res) => {
  try {
    const { owner_id, access_token, expires_in, email } = req.body;
    if (!owner_id || !access_token) return res.status(400).json({ error: "Missing fields" });
    const expiry = Date.now() + (expires_in * 1000);
    const saved = await saveGoogleToken(owner_id, access_token, expiry, email);
    console.log(`Google token saved for owner: ${owner_id} (${email}) — db: ${saved}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/add-to-google-calendar", async (req, res) => {
  try {
    const { owner_id, service, date, time, client_name, biz_name, biz_location, deposit, phone } = req.body;
    const tokenData = await getGoogleToken(owner_id);
    if (!tokenData || !tokenData.access_token) {
      return res.json({ ok: false, reason: "no_token" });
    }

    // Parse date and time
    const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
    const parts = date.split(" ");
    const month = months[parts[1]]; const day = parseInt(parts[2]);
    const year = new Date().getFullYear();
    const tp = time.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!tp) return res.json({ ok: false, reason: "bad_time" });
    let hour = parseInt(tp[1]); const min = parseInt(tp[2]);
    if (tp[3].toUpperCase() === "PM" && hour !== 12) hour += 12;
    if (tp[3].toUpperCase() === "AM" && hour === 12) hour = 0;
    const start = new Date(year, month, day, hour, min);
    const end = new Date(start.getTime() + 60 * 60 * 1000);

    const event = {
      summary: `${service} — ${client_name}`,
      location: biz_location || biz_name || "",
      description: `Client: ${client_name}\nPhone: ${phone || ""}\nDeposit: ${deposit || ""}\nBooked via spool`,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }, { method: "email", minutes: 1440 }] },
    };

    const gcalRes = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { "Authorization": "Bearer " + tokenData.access_token, "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });

    if (!gcalRes.ok) {
      const err = await gcalRes.text();
      console.error("Google Calendar error:", gcalRes.status, err);
      return res.json({ ok: false, reason: "gcal_error", status: gcalRes.status });
    }

    const data = await gcalRes.json();
    console.log(`Calendar event created for ${client_name}: ${data.id}`);
    res.json({ ok: true, event_id: data.id });
  } catch (err) {
    console.error("add-to-google-calendar error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SEND PROMO EMAIL ──────────────────────────────────────────────────────────
app.post("/send-promo", async (req, res) => {
  try {
    const { to_email, subject, html_body, sms_body, to_phone } = req.body;
    let emailOk = false, smsOk = false;

    if (to_email) {
      try {
        await resend.emails.send({ from: "onboarding@resend.dev", to: to_email, subject, html: html_body });
        emailOk = true;
      } catch (e) { console.error("Promo email failed:", e.message); }
    }

    if (to_phone && sms_body) {
      try {
        const result = await sendSMS(to_phone, sms_body);
        smsOk = result.ok;
      } catch (e) { console.error("Promo SMS failed:", e.message); }
    }

    res.json({ ok: emailOk || smsOk, emailOk, smsOk });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── META WEBHOOKS (WhatsApp, Instagram, Messenger) ──────────────────────────
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "spool_webhook_verify_2024";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || "";

// Webhook verification (GET) — Meta sends this to verify your endpoint
app.get("/webhook/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("Meta webhook verified!");
    return res.status(200).send(challenge);
  }
  res.status(403).send("Forbidden");
});

// Webhook receiver (POST) — receives messages from WhatsApp/Instagram/Messenger
app.post("/webhook/meta", async (req, res) => {
  res.status(200).send("EVENT_RECEIVED"); // Respond immediately

  try {
    const body = req.body;
    if (!body || !body.entry) return;

    for (const entry of body.entry) {
      // WhatsApp messages
      if (entry.changes) {
        for (const change of entry.changes) {
          if (change.field === "messages" && change.value?.messages) {
            for (const msg of change.value.messages) {
              const from = msg.from; // phone number
              const text = msg.text?.body || msg.caption || "[media]";
              const contactName = change.value.contacts?.[0]?.profile?.name || from;
              console.log(`WhatsApp from ${contactName} (${from}): ${text}`);

              // Find which business owns this WhatsApp number
              const phoneId = change.value.metadata?.phone_number_id;
              // For now, save to messages table with platform = "whatsapp"
              await saveIncomingMessage(contactName, from, text, "whatsapp", phoneId);
            }
          }
        }
      }

      // Instagram & Messenger messages
      if (entry.messaging) {
        for (const event of entry.messaging) {
          if (event.message) {
            const senderId = event.sender?.id;
            const text = event.message?.text || "[media]";
            const platform = entry.id?.includes("instagram") ? "instagram" : "messenger";
            console.log(`${platform} from ${senderId}: ${text}`);

            // Look up sender name (best effort)
            let senderName = senderId;
            if (META_ACCESS_TOKEN) {
              try {
                const profileRes = await fetch(`https://graph.facebook.com/${senderId}?fields=name&access_token=${META_ACCESS_TOKEN}`);
                const profile = await profileRes.json();
                if (profile.name) senderName = profile.name;
              } catch {}
            }

            await saveIncomingMessage(senderName, senderId, text, platform, null);
          }
        }
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err.message);
  }
});

async function saveIncomingMessage(name, sender_id, text, platform, phone_id) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    // Try to match this to a business owner
    // For WhatsApp: match by phone_id in business_profiles
    // For now: save with a lookup field and the AI will handle routing
    let ownerId = null;

    // Simple lookup: find business with connected WhatsApp (stored in settings)
    if (platform === "whatsapp") {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/business_profiles?select=user_id&limit=1`,
        { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
      );
      const profiles = await res.json();
      if (profiles && profiles[0]) ownerId = profiles[0].user_id;
    }

    if (!ownerId) {
      // Fallback: use first business profile (single-tenant for now)
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/business_profiles?select=user_id&limit=1`,
        { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
      );
      const profiles = await res.json();
      if (profiles && profiles[0]) ownerId = profiles[0].user_id;
    }

    if (!ownerId) { console.log("No business owner found for incoming message"); return; }

    // Save message
    await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        owner_id: ownerId,
        name: name,
        sender_id: sender_id,
        platform: platform,
        preview: text.slice(0, 200),
        full_text: text,
        unread: true,
        handled: false,
      }),
    });

    console.log(`Saved ${platform} message from ${name} for owner ${ownerId}`);

    // Auto-reply if AI auto-reply is enabled
    try {
      const profRes = await fetch(
        `${SUPABASE_URL}/rest/v1/business_profiles?select=settings,biz_name,ai_name&user_id=eq.${ownerId}&limit=1`,
        { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
      );
      const profData = await profRes.json();
      const settings = profData?.[0]?.settings || {};
      const bizName = profData?.[0]?.biz_name || "our business";
      const aiName = profData?.[0]?.ai_name || "Aria";

      if (settings.aiReplies) {
        // Generate AI reply
        const aiReply = await generateAutoReply(text, bizName, aiName, ownerId);
        if (aiReply) {
          // Send reply via the appropriate platform
          if (platform === "whatsapp" && WHATSAPP_PHONE_ID && META_ACCESS_TOKEN) {
            await fetch(`https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${META_ACCESS_TOKEN}`, "Content-Type": "application/json" },
              body: JSON.stringify({ messaging_product: "whatsapp", to: sender_id, text: { body: aiReply } }),
            });
          } else if ((platform === "instagram" || platform === "messenger") && META_ACCESS_TOKEN) {
            await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${META_ACCESS_TOKEN}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ recipient: { id: sender_id }, message: { text: aiReply } }),
            });
          }

          // Mark as handled
          await fetch(`${SUPABASE_URL}/rest/v1/messages?sender_id=eq.${sender_id}&owner_id=eq.${ownerId}&handled=eq.false`, {
            method: "PATCH",
            headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ handled: true, reply: aiReply }),
          });
        }
      }
    } catch (autoErr) {
      console.error("Auto-reply error:", autoErr.message);
    }
  } catch (err) {
    console.error("saveIncomingMessage error:", err.message);
  }
}

async function generateAutoReply(clientMessage, bizName, aiName, ownerId) {
  if (!process.env.GROQ_API_KEY) return null;
  try {
    // Load services for context
    const svcRes = await fetch(
      `${SUPABASE_URL}/rest/v1/services?select=name,price,duration&owner_id=eq.${ownerId}&active=eq.true&limit=10`,
      { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const services = await svcRes.json();
    const svcList = (services || []).map(s => `${s.name} ($${s.price}, ${s.duration})`).join(", ");

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        max_tokens: 150,
        messages: [
          { role: "system", content: `You are ${aiName}, an AI assistant for ${bizName}, a business. Reply to client messages warmly and helpfully. Services: ${svcList || "various services"}. Keep replies short (2-3 sentences). If they want to book, give them the booking link. Be friendly and professional. Never say you're an AI unless asked directly.` },
          { role: "user", content: clientMessage },
        ],
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error("generateAutoReply error:", e.message);
    return null;
  }
}

// ── Reply to a message manually from the app ─────────────────────────────────
app.post("/reply-message", async (req, res) => {
  try {
    const { message_id, sender_id, platform, reply_text } = req.body;
    if (!reply_text || !sender_id) return res.status(400).json({ error: "Missing fields" });

    let sent = false;
    if (platform === "whatsapp" && WHATSAPP_PHONE_ID && META_ACCESS_TOKEN) {
      const r = await fetch(`https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${META_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: sender_id, text: { body: reply_text } }),
      });
      sent = r.ok;
    } else if ((platform === "instagram" || platform === "messenger") && META_ACCESS_TOKEN) {
      const r = await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${META_ACCESS_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: sender_id }, message: { text: reply_text } }),
      });
      sent = r.ok;
    }

    // Update message in DB
    if (message_id && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      await fetch(`${SUPABASE_URL}/rest/v1/messages?id=eq.${message_id}`, {
        method: "PATCH",
        headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ handled: true, unread: false, reply: reply_text }),
      });
    }

    res.json({ ok: true, sent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`spool proxy running on port ${PORT}`));
