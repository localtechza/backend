// backend/auth.js
// Passwordless "login with your email" for LocalTech.
//
//  • Session tokens are random 32-byte strings handed to the browser; only
//    their SHA-256 hash is stored, so a leaked DB never leaks live tokens.
//  • Sessions created at checkout are "unverified" — they can see only the
//    order they were created with. Entering the emailed 6-digit code proves
//    the customer owns the email address and promotes every unverified
//    session for that email to full access.
//  • Admin sessions are stateless HMAC tokens signed with SESSION_SECRET
//    (12 hours), so the admin page needs no database and the PIN is never
//    stored anywhere — only compared against the ADMIN_PIN env var.

const crypto = require("crypto");
const { collection } = require("./db");
const { Resend } = require("resend");

const CODE_TTL_MINUTES = 10;
const MAX_CODE_SENDS = 3;      // per email, per 15 minutes
const MAX_VERIFY_ATTEMPTS = 5; // wrong-code guesses before the code dies
const VIEWED_CAP = 20;

// ======================================================
// Tokens / signing
// ======================================================
const getSecret = () =>
    process.env.SESSION_SECRET ||
    // Per-boot fallback: sessions survive (they live in Mongo), admin tokens
    // do not — the admin just re-enters the PIN after a redeploy.
    (process.env.__LT_SECRET =
        process.env.__LT_SECRET || crypto.randomBytes(32).toString("hex"));

const hmac = (value) =>
    crypto.createHmac("sha256", getSecret()).update(value).digest("hex");

const hashToken = (token) =>
    crypto.createHash("sha256").update(token).digest("hex");

function newSessionToken() {
    return crypto.randomBytes(32).toString("hex");
}

function makeAdminToken() {
    const exp = Date.now() + 12 * 60 * 60 * 1000; // 12 hours
    return `${exp}.${hmac(`admin:${exp}`)}`;
}

function checkAdminToken(token) {
    if (!token || !token.includes(".")) return false;
    const [expRaw, sig] = token.split(".");
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || Date.now() > exp) return false;
    const expected = hmac(`admin:${exp}`);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function pinMatches(pin) {
    const real = process.env.ADMIN_PIN;
    if (!real) return false;
    const a = Buffer.from(String(pin || ""));
    const b = Buffer.from(String(real));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// ======================================================
// Sessions
// ======================================================
async function issueSession(email, verified, reuseToken = null) {
    const sessions = await collection("sessions");
    if (!sessions) return null;
    const token = reuseToken || newSessionToken();
    const now = new Date();
    await sessions.updateOne(
        { _id: hashToken(token) },
        {
            $set: { email, verified: Boolean(verified), lastSeenAt: now },
            $setOnInsert: { createdAt: now },
        },
        { upsert: true }
    );
    return token;
}

// Promote every "just bought, not yet proven" session for this email.
async function verifySessionsFor(email) {
    const sessions = await collection("sessions");
    if (!sessions) return;
    await sessions.updateMany({ email, verified: false }, { $set: { verified: true } });
}

async function getSession(req) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!token) return null;
    const sessions = await collection("sessions");
    if (!sessions) return null;
    const doc = await sessions.findOne({ _id: hashToken(token) });
    if (!doc) return null;
    // Sliding idle expiry (also mirrored by the TTL index)
    if (doc.lastSeenAt && Date.now() - doc.lastSeenAt.getTime() > 90 * 864e5) {
        await sessions.deleteOne({ _id: doc._id });
        return null;
    }
    sessions
        .updateOne({ _id: doc._id }, { $set: { lastSeenAt: new Date() } })
        .catch(() => {});
    return { token, email: doc.email, verified: Boolean(doc.verified) };
}

async function dropSession(req) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!token) return;
    const sessions = await collection("sessions");
    if (sessions) await sessions.deleteOne({ _id: hashToken(token) }).catch(() => {});
}

// ======================================================
// 6-digit email codes
// ======================================================
function makeCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

// Returns { ok, delivered, message }. The code is emailed to the customer.
async function startLogin(email) {
    const codes = await collection("login_codes");
    if (!codes) {
        return { ok: false, message: "Accounts are temporarily unavailable — try again shortly." };
    }

    const now = Date.now();
    const existing = await codes.findOne({ _id: email });

    // Throttle: max 3 codes per 15 minutes for the same address
    const windowMs = 15 * 60 * 1000;
    let sentCount = existing && existing.windowStart && now - existing.windowStart < windowMs
        ? existing.sentCount || 0
        : 0;
    if (sentCount >= MAX_CODE_SENDS) {
        return {
            ok: false,
            message: "Too many codes requested — wait a few minutes and try again.",
        };
    }

    const code = makeCode();
    const expiresAt = new Date(now + CODE_TTL_MINUTES * 60 * 1000);
    await codes.updateOne(
        { _id: email },
        {
            $set: {
                codeHash: hmac(`${email}:${code}`),
                expiresAt,
                attempts: 0,
                windowStart: now,
                sentCount: sentCount + 1,
            },
            $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
    );

    const { ok, message } = await sendLoginEmail(email, code);
    return { ok: true, delivered: ok, message: message || "", code };
}

async function verifyLogin(email, code) {
    const codes = await collection("login_codes");
    const sessions = await collection("sessions");
    if (!codes || !sessions) {
        return { ok: false, message: "Accounts are temporarily unavailable — try again shortly." };
    }

    const doc = await codes.findOne({ _id: email });
    if (!doc || !doc.expiresAt || doc.expiresAt.getTime() < Date.now()) {
        return { ok: false, message: "That code has expired — request a new one." };
    }
    if ((doc.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
        await codes.deleteOne({ _id: email });
        return { ok: false, message: "Too many wrong attempts — request a new code." };
    }

    const given = hmac(`${email}:${String(code || "").trim()}`);
    const a = Buffer.from(given);
    const b = Buffer.from(doc.codeHash || "");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        await codes.updateOne({ _id: email }, { $inc: { attempts: 1 } });
        return { ok: false, message: "That code is not correct." };
    }

    await codes.deleteOne({ _id: email }); // one-time use
    await ensureAccount(email, { source: "login" });
    await verifySessionsFor(email);
    const token = await issueSession(email, true);
    return { ok: true, token, email };
}

// ======================================================
// Accounts (email is the identity — no passwords, by design)
// ======================================================
async function ensureAccount(email, extra = {}) {
    const accounts = await collection("accounts");
    if (!accounts || !email) return;
    const now = new Date();
    const set = { updatedAt: now };
    const setOnInsert = { createdAt: now, viewed: [] };
    if (extra.name) set.name = extra.name;
    if (extra.source) setOnInsert.source = extra.source;
    await accounts.updateOne({ _id: email }, { $set: set, $setOnInsert: setOnInsert }, { upsert: true });
    if (extra.source) {
        await accounts.updateOne({ _id: email }, { $addToSet: { sources: extra.source } });
    }
}

// Called after contact/booking forms so customers can log in later with
// the same address they already used.
async function captureEmail(email, name, source) {
    try {
        await ensureAccount(email, { name, source });
    } catch (err) {
        console.error("⚠️ Email capture failed:", err.message);
    }
}

// Recently viewed products, newest first, capped, de-duplicated by handle.
async function addViewed(email, product) {
    const accounts = await collection("accounts");
    if (!accounts || !email || !product || !product.handle) return;
    const entry = {
        handle: String(product.handle),
        title: String(product.title || "").slice(0, 200),
        price: Number(product.price) || 0,
        image: String(product.image || "").slice(0, 500),
        at: new Date(),
    };
    await accounts.updateOne(
        { _id: email },
        { $pull: { viewed: { handle: entry.handle } } }
    );
    await accounts.updateOne(
        { _id: email },
        { $push: { viewed: { $each: [entry], $position: 0, $slice: VIEWED_CAP } } }
    );
}

async function getViewed(email) {
    const accounts = await collection("accounts");
    if (!accounts || !email) return [];
    const doc = await accounts.findOne({ _id: email }, { projection: { viewed: 1 } });
    return (doc && doc.viewed) || [];
}

// ======================================================
// Email delivery for login codes
// ======================================================
async function sendLoginEmail(email, code) {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
        console.error("⚠️ RESEND_API_KEY missing - login code:", code, "for", email);
        return { ok: false, message: "Email service is not configured yet." };
    }

    const from = process.env.FROM_EMAIL || "LocalTech <onboarding@resend.dev>";
    const esc = (v) =>
        String(v == null ? "" : v)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");

    try {
        const resend = new Resend(resendKey);
        const result = await resend.emails.send({
            from,
            to: email,
            subject: `Your LocalTech login code: ${code}`,
            html: `
                <p>Enter this code to sign in to your LocalTech account:</p>
                <p style="font-size:30px;font-weight:bold;letter-spacing:8px;margin:20px 0;">${code}</p>
                <p>It expires in ${CODE_TTL_MINUTES} minutes. If you did not request it, you can ignore this email.</p>
                <p>— LocalTech · localtechza@gmail.com · 081 6422 215</p>
            `,
        });
        if (result.error) {
            console.error("❌ LOGIN CODE REJECTED BY RESEND:", JSON.stringify(result.error));
            return {
                ok: false,
                message:
                    "We could not email the code (the sending domain may not be verified yet). Please try again later.",
            };
        }
        return { ok: true };
    } catch (err) {
        console.error("❌ LOGIN CODE EMAIL ERROR:", err.message);
        return {
            ok: false,
            message: "We could not email the code right now — please try again.",
        };
    }
}

module.exports = {
    makeAdminToken,
    checkAdminToken,
    pinMatches,
    issueSession,
    getSession,
    dropSession,
    startLogin,
    verifyLogin,
    ensureAccount,
    captureEmail,
    addViewed,
    getViewed,
    CODE_TTL_MINUTES,
};
