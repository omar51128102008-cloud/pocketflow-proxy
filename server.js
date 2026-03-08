const express = require("express");
const cors = require("cors");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const Stripe = require("stripe");

const app = express();
app.use(cors());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

const stripe = Stripe(STRIPE_SECRET_KEY);

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
        model_id: "eleven_turbo_v2",
        voice_settings: { stability: 0.4, similarity_boost: 0.8, speed: 1.1 },
      }),
    });
    if (!response.ok) return res.status(500).json({ error: "TTS failed" });
    const buffer = await response.arrayBuffer();
    res.set("Content-Type", "audio/mpeg");
    res.send(Buffer.from(buffer));
  } catch (err) {
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Pocketflow proxy running on port ${PORT}`));
