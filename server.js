require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const { Resend } = require("resend");
const { getNextInvoiceNumber, formatInvoiceDate, buildInvoiceHtml } = require("./invoice");
const { ORDER_STATUSES, initialStatus, isValidStatus } = require("./statuses");
const {
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
} = require("./auth");
const { dbReady, collection } = require("./db");

const app = express();
const PORT = process.env.PORT || 10000;

// Where the customer lands after Paystack (HashRouter deep link)
const SITE_URL = (process.env.SITE_URL || "https://localtechza.github.io").replace(/\/+$/, "");

// ========================
// Middleware
// ========================
app.use(express.json());
app.use(cors());

// Small in-memory rate limiter (no dependencies) — protects the login-code
// endpoint from being used to spam an inbox.
const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
        rateBuckets.set(key, { start: now, count: 1 });
        return true;
    }
    bucket.count += 1;
    if (rateBuckets.size > 5000) rateBuckets.clear(); // safety valve
    return bucket.count <= max;
}
const clientIp = (req) =>
    (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();

// ========================
// Debug
// ========================
console.log("Resend Loaded:", !!process.env.RESEND_API_KEY);
console.log("Paystack Loaded:", !!process.env.PAYSTACK_SECRET_KEY);

// ========================
// Services
// ========================
const resend = new Resend(process.env.RESEND_API_KEY);
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// 📧 Admin notification email (set ADMIN_EMAIL in .env)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";

// Brand name used in the "from" field of outgoing emails
const FROM_EMAIL = process.env.FROM_EMAIL || "LocalTech <onboarding@resend.dev>";

// 🖼️ Logo embedded in every invoice email (backend/logo.png)
//    Loaded once at startup; invoices still send if the file is missing.
const LOGO_PATH = path.join(__dirname, "logo.png");
let invoiceAttachments = [];
let hasLogo = false;
try {
    if (fs.existsSync(LOGO_PATH)) {
        invoiceAttachments = [
            {
                content: fs.readFileSync(LOGO_PATH),
                filename: "logo.png",
                contentId: "localtech-logo",
            },
        ];
        hasLogo = true;
        console.log("🖼️ Invoice logo loaded");
    } else {
        console.log("⚠️ logo.png not found - invoices will send without the logo");
    }
} catch (err) {
    console.log("⚠️ Could not load logo.png:", err.message);
}

// ========================
// ROOT
// ========================
app.get("/", (req, res) => {
    res.send("✅ LocalTech Backend is running");
});

// ======================================================
// 1. CONTACT EMAIL
// ======================================================
app.post("/send-email", async (req, res) => {
    const { name, email, message } = req.body;

    if (!name || !email || !message) {
        return res.status(400).json({ error: "Missing fields" });
    }

    // Escape user input so it can't break the email HTML
    const esc = (v) => String(v == null ? "" : v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    try {
        const result = await resend.emails.send({
            from: FROM_EMAIL,
            to: ADMIN_EMAIL,
            replyTo: email,
            subject: `Contact Form - ${name}`,
            html: `
                <h2>New Contact Message</h2>
                <p><b>Name:</b> ${esc(name)}</p>
                <p><b>Email:</b> ${esc(email)}</p>
                <p><b>Message:</b><br>${esc(message).replace(/\n/g, "<br>")}</p>
            `,
        });

        // The SDK returns { data, error } instead of throwing — check it,
        // otherwise rejections get logged as success.
        if (result.error) {
            console.error("❌ CONTACT EMAIL REJECTED BY RESEND:", JSON.stringify(result.error));
            return res.status(502).json({ error: "Email rejected by provider" });
        }

        console.log("✅ CONTACT EMAIL SENT:", result.data);
        captureEmail(email, name, "contact"); // so they can log in with this address
        res.json({ success: true });

    } catch (err) {
        console.error("❌ CONTACT ERROR:", err);
        res.status(500).json({ error: "Contact failed" });
    }
});

// ======================================================
// 2. BOOKING EMAIL
// ======================================================
app.post("/book-service", async (req, res) => {
    const { service, date, name, email, phone, address, notes } = req.body;

    if (!service || !date || !name || !email || !phone || !address) {
        return res.status(400).json({ error: "Missing booking fields" });
    }

    try {
        const result = await resend.emails.send({
            from: FROM_EMAIL,
            to: ADMIN_EMAIL,
            subject: `Booking - ${name}`,
            html: `
                <h2>New Booking</h2>
                <p><b>Service:</b> ${service}</p>
                <p><b>Date:</b> ${date}</p>
                <p><b>Name:</b> ${name}</p>
                <p><b>Email:</b> ${email}</p>
                <p><b>Phone:</b> ${phone}</p>
                <p><b>Address:</b> ${address}</p>
                <p><b>Notes:</b> ${notes || "None"}</p>
            `,
        });

        console.log("✅ BOOKING EMAIL SENT:", result);
        captureEmail(email, name, "booking"); // PC repair customers can log in too
        res.json({ success: true });

    } catch (err) {
        console.error("❌ BOOKING ERROR:", err);
        res.status(500).json({ error: "Booking failed" });
    }
});

// ======================================================
// 3. PAYSTACK INIT
// ======================================================
app.post("/initialize-payment", async (req, res) => {
    const { email, amount, reference } = req.body;

    // Keeps someone from pointing this at Paystack in a loop
    if (!rateLimit(`pay-init:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
        return res.status(429).json({ error: "Too many payment attempts — try again later." });
    }

    try {
        const payload = {
            email,
            amount: amount * 100,
            currency: "ZAR",
            // Land back on the site's payment-result page after paying
            callback_url: `${SITE_URL}/#/checkout-result`,
        };
        // Use OUR reference (the order's TXN id) so the verification step can
        // find the order again. Paystack allows A-Z a-z 0-9 - _ . up to 50.
        if (reference && /^[A-Za-z0-9._-]{1,50}$/.test(reference)) {
            payload.reference = reference;
        }

        const response = await axios.post(
            "https://api.paystack.co/transaction/initialize",
            payload,
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                },
            }
        );

        res.json(response.data);

    } catch (err) {
        console.error("❌ PAYSTACK INIT ERROR:", err.response?.data || err);
        res.status(500).json({ error: "Payment init failed" });
    }
});

// ======================================================
// 4. PAYSTACK VERIFY
// ======================================================
app.get("/verify-payment/:reference", async (req, res) => {
    if (!rateLimit(`pay-verify:${clientIp(req)}`, 60, 60 * 60 * 1000)) {
        return res.status(429).json({ error: "Too many verification requests — try again later." });
    }
    try {
        const response = await axios.get(
            `https://api.paystack.co/transaction/verify/${req.params.reference}`,
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                },
            }
        );

        // Paid? Move the order from "Awaiting payment" -> "Payment confirmed"
        // (only if you haven't already moved it by hand in the admin page).
        const psData = response.data && response.data.data;
        if (psData && psData.status === "success") {
            await confirmOrderPayment(psData.reference || req.params.reference);
        }

        res.json(response.data);

    } catch (err) {
        console.error("❌ VERIFY ERROR:", err.response?.data || err);
        res.status(500).json({ error: "Verification failed" });
    }
});

// Flip a stored order to "Payment confirmed" when Paystack says the money
// arrived. Never downgrades an order you already advanced by hand.
async function confirmOrderPayment(transactionId) {
    try {
        const orders = await collection("orders");
        if (!orders || !transactionId) return;
        const now = new Date();
        const result = await orders.updateOne(
            { transactionId, status: "Awaiting payment" },
            {
                $set: { status: "Payment confirmed", updatedAt: now },
                $push: {
                    history: { status: "Payment confirmed", at: now, by: "Paystack" },
                },
            }
        );
        if (result.matchedCount) {
            console.log(`✅ Payment confirmed for order ${transactionId}`);
        }
    } catch (err) {
        console.error("⚠️ Order status update failed:", err.message);
    }
}

// ======================================================
// 5. CHECKOUT (BULLETPROOF FIXED VERSION)
// ======================================================
app.post("/checkout", async (req, res) => {
    const { name, email, phone, cart, total, address, shippingOption, paymentMethod } = req.body;
    // Optional client-supplied reference so Paystack and the order can share
    // the same id (must match what Paystack allows: A-Z a-z 0-9 . _ -)
    const clientTxn =
        typeof req.body.transactionId === "string" &&
        /^[A-Za-z0-9._-]{1,50}$/.test(req.body.transactionId)
            ? req.body.transactionId
            : null;

    console.log("🧾 CHECKOUT RECEIVED:", req.body);

    if (!name || !Array.isArray(cart) || cart.length === 0 || !total || !address || !shippingOption) {
        return res.status(400).json({ error: "Invalid checkout request" });
    }

    const safeEmail =
        email && email.trim().length > 0
            ? email
            : null;

    const transactionId = clientTxn || `TXN-${Date.now()}`;

    // Amounts are calculated from the cart so the invoice always matches
    // what the client was charged at checkout (subtotal + shipping).
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const shippingFee = shippingOption === "courier" ? 120 : 0;
    const grandTotal = subtotal + shippingFee;

    // Retry safety: if this reference was already booked (e.g. the payment
    // page opened after a slow first attempt), reuse that order instead of
    // minting a second invoice number.
    let duplicateOrder = null;
    try {
        const existingOrders = await collection("orders");
        if (existingOrders) {
            duplicateOrder = await existingOrders.findOne(
                { transactionId },
                { projection: { invoiceNumber: 1 } }
            );
        }
    } catch (dupErr) {
        console.error("⚠️ Duplicate-order check failed:", dupErr.message);
    }

    // Sequential invoice number (200, 201, 202, ...) — MongoDB-backed now,
    // so it survives Render restarts (await: the counter is async).
    const invoiceNumber = duplicateOrder
        ? duplicateOrder.invoiceNumber
        : await getNextInvoiceNumber();
    const invoiceDate = formatInvoiceDate();
    const emailNorm = safeEmail ? safeEmail.trim().toLowerCase() : null;

    // ---------------------------------------------------------------
    // Save the order + sign the buyer in on this browser.
    // Wrapped so a storage problem can NEVER fail a checkout — the
    // invoices below are the important part.
    // ---------------------------------------------------------------
    let sessionToken = null;
    let sessionVerified = false;
    try {
        if (emailNorm) {
            await ensureAccount(emailNorm, { name, source: "checkout" });
        }

        const existing = await getSession(req); // already signed in on this device?
        if (existing && (!emailNorm || existing.email === emailNorm)) {
            sessionToken = existing.token;
            sessionVerified = existing.verified;
        } else if (emailNorm) {
            sessionToken = await issueSession(emailNorm, false); // unverified until the emailed code is entered
            sessionVerified = false;
        }

        const orders = await collection("orders");
        if (orders && duplicateOrder) {
            console.log(`↩️ Retried checkout ${transactionId} - reusing order #${invoiceNumber}`);
        } else if (orders) {
            const now = new Date();
            await orders.insertOne({
                invoiceNumber,
                transactionId,
                name,
                email: emailNorm,
                phone: phone || "",
                address,
                items: cart.map((item) => ({
                    handle: item.handle || "",
                    title: item.title || item.name || "",
                    price: Number(item.price) || 0,
                    quantity: Number(item.quantity) || 1,
                    image: item.image || (item.images && Object.values(item.images)[0]) || "",
                })),
                subtotal,
                shippingFee,
                total: grandTotal,
                shippingOption,
                paymentMethod: paymentMethod || "EFT",
                status: initialStatus(),
                history: [{ status: initialStatus(), at: now, by: "System" }],
                sourceToken: sessionToken,
                createdAt: now,
            });
            console.log(`🧾 Order #${invoiceNumber} stored`);
        } else {
            console.log("⚠️ No database connected - order was emailed but not stored");
        }
    } catch (storeErr) {
        console.error("⚠️ Order storage failed (checkout continues):", storeErr.message);
        sessionToken = null;
        sessionVerified = false;
    }

    const invoiceHtml = buildInvoiceHtml({
        invoiceNumber,
        date: invoiceDate,
        customer: { name, email, phone, address },
        cart,
        shippingOption,
        subtotal,
        shippingFee,
        total: grandTotal,
        paymentMethod,
        transactionId,
        hasLogo,
    });

    try {
        // 1. ALWAYS SEND ADMIN EMAIL (GUARANTEED DELIVERY)
        const adminResult = await resend.emails.send({
            from: FROM_EMAIL,
            to: ADMIN_EMAIL,
            subject: `Invoice #${invoiceNumber} - ${name} (${transactionId})`,
            html: invoiceHtml,
            attachments: invoiceAttachments,
        });

        console.log("✅ ADMIN INVOICE SENT:", adminResult);

        // 2. CUSTOMER EMAIL ONLY IF VALID
        //    Kept in its own try/catch: while the Resend domain is unverified,
        //    sends to customers are rejected — that must never fail the checkout
        //    (the admin copy + invoice number are already done at this point).
        if (safeEmail) {
            try {
                const customerResult = await resend.emails.send({
                    from: FROM_EMAIL,
                    to: safeEmail,
                    subject: `Your LocalTech Invoice #${invoiceNumber}`,
                    html: invoiceHtml,
                    attachments: invoiceAttachments,
                });

                console.log("✅ CUSTOMER INVOICE SENT:", customerResult);
            } catch (custErr) {
                console.error("⚠️ Customer invoice failed (admin copy was sent):", custErr.message);
            }
        } else {
            console.log("⚠️ No customer email provided - skipped");
        }

        res.json({
            success: true,
            transactionId,
            invoiceNumber,
            // Lets the browser sign the buyer in automatically so they can
            // track this order (no password — email-only accounts).
            token: sessionToken,
            verified: sessionVerified,
        });

    } catch (err) {
        console.error("❌ CHECKOUT ERROR:", err);
        res.status(500).json({ error: "Checkout failed" });
    }
});

// ======================================================
// 6. ACCOUNTS — email-only login (no passwords, by design)
// ======================================================
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw) {
    const email = String(raw || "").trim().toLowerCase();
    return EMAIL_RE.test(email) ? email : null;
}

// Customer-facing view of an order (admin adds email on top of this)
function publicOrder(o) {
    return {
        invoiceNumber: o.invoiceNumber,
        transactionId: o.transactionId,
        status: o.status,
        history: (o.history || []).map((h) => ({
            status: h.status,
            at: h.at,
            by: h.by,
            note: h.note || "",
        })),
        items: (o.items || []).map((i) => ({
            title: i.title,
            price: i.price,
            quantity: i.quantity,
            image: i.image || "",
        })),
        subtotal: o.subtotal,
        shippingFee: o.shippingFee,
        total: o.total,
        shippingOption: o.shippingOption,
        paymentMethod: o.paymentMethod,
        name: o.name,
        address: o.address,
        phone: o.phone,
        createdAt: o.createdAt,
    };
}

// 6a. Customer asks for a login code (sent to their email)
app.post("/auth/start", async (req, res) => {
    const email = normalizeEmail(req.body.email);
    if (!email) {
        return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (!rateLimit(`start-ip:${clientIp(req)}`, 15, 60 * 60 * 1000)) {
        return res.status(429).json({ error: "Too many attempts — try again later." });
    }
    if (!rateLimit(`start-mail:${email}`, 5, 60 * 60 * 1000)) {
        return res.status(429).json({ error: "Too many attempts — try again later." });
    }

    try {
        const result = await startLogin(email);
        if (!result.ok) {
            return res.status(429).json({ error: result.message });
        }
        res.json({
            success: true,
            delivered: result.delivered,
            message: result.message || "",
            // Handy for local testing; never sent to production browsers
            devCode: process.env.NODE_ENV !== "production" ? result.code : undefined,
        });
    } catch (err) {
        console.error("❌ AUTH START ERROR:", err);
        res.status(500).json({ error: "Could not start sign-in" });
    }
});

// 6b. Customer enters the 6-digit code -> session token
app.post("/auth/verify", async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || "").trim();
    if (!email || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: "Enter the 6-digit code from your email." });
    }
    if (!rateLimit(`verify-ip:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
        return res.status(429).json({ error: "Too many attempts — try again later." });
    }

    try {
        const result = await verifyLogin(email, code);
        if (!result.ok) {
            return res.status(401).json({ error: result.message });
        }
        res.json({ success: true, token: result.token, email: result.email, verified: true });
    } catch (err) {
        console.error("❌ AUTH VERIFY ERROR:", err);
        res.status(500).json({ error: "Could not complete sign-in" });
    }
});

// 6c. Who am I? (used by the header/profile on page load)
app.get("/auth/me", async (req, res) => {
    try {
        const session = await getSession(req);
        if (!session) return res.status(401).json({ error: "Not signed in" });
        res.json({ email: session.email, verified: session.verified });
    } catch (err) {
        console.error("❌ AUTH ME ERROR:", err);
        res.status(500).json({ error: "Could not read account" });
    }
});

app.post("/auth/logout", async (req, res) => {
    try {
        await dropSession(req);
    } catch (err) {
        console.error("⚠️ Logout error:", err.message);
    }
    res.json({ success: true });
});

// 6d. The signed-in customer's orders.
//     Verified sessions see every order for their email; unverified ones
//     (created at checkout, before the emailed code was entered) see only
//     the order they were created with.
app.get("/auth/orders", async (req, res) => {
    try {
        const session = await getSession(req);
        if (!session) return res.status(401).json({ error: "Not signed in" });

        const orders = await collection("orders");
        if (!orders) return res.json({ orders: [], verified: session.verified });

        const query = session.verified
            ? { email: session.email }
            : { sourceToken: session.token };
        const docs = await orders
            .find(query)
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();

        res.json({
            orders: docs.map(publicOrder),
            verified: session.verified,
        });
    } catch (err) {
        console.error("❌ AUTH ORDERS ERROR:", err);
        res.status(500).json({ error: "Could not load orders" });
    }
});

// 6e. Recently viewed products, stored on the account so they follow the
//     customer to any device (verified sessions only).
app.get("/auth/viewed", async (req, res) => {
    try {
        const session = await getSession(req);
        if (!session) return res.status(401).json({ error: "Not signed in" });
        if (!session.verified) return res.json({ viewed: [] });
        res.json({ viewed: await getViewed(session.email) });
    } catch (err) {
        console.error("❌ VIEWED GET ERROR:", err);
        res.status(500).json({ error: "Could not load viewed products" });
    }
});

app.post("/auth/viewed", async (req, res) => {
    try {
        const session = await getSession(req);
        if (!session) return res.status(401).json({ error: "Not signed in" });
        if (!session.verified) {
            return res
                .status(403)
                .json({ error: "Verify your email to sync viewed products" });
        }
        await addViewed(session.email, req.body || {});
        res.json({ success: true });
    } catch (err) {
        console.error("❌ VIEWED POST ERROR:", err);
        res.status(500).json({ error: "Could not save viewed product" });
    }
});

// ======================================================
// 7. ADMIN — the hidden #/admin page (never linked from the site).
//    Signs in with the ADMIN_PIN env var; returns a 12-hour HMAC token.
// ======================================================
function requireAdmin(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!checkAdminToken(token)) {
        return res.status(401).json({ error: "Admin sign-in required" });
    }
    next();
}

app.post("/admin/login", (req, res) => {
    if (!process.env.ADMIN_PIN) {
        return res
            .status(503)
            .json({ error: "ADMIN_PIN is not set on the server yet (Render → Environment)." });
    }
    if (!pinMatches(req.body.pin)) {
        if (!rateLimit(`admin-pin:${clientIp(req)}`, 8, 15 * 60 * 1000)) {
            return res.status(429).json({ error: "Too many attempts — wait 15 minutes." });
        }
        return res.status(401).json({ error: "Wrong PIN" });
    }
    res.json({ success: true, token: makeAdminToken() });
});

app.get("/admin/orders", requireAdmin, async (req, res) => {
    try {
        const orders = await collection("orders");
        if (!orders) {
            return res.json({ orders: [], statuses: ORDER_STATUSES, stored: false });
        }
        const docs = await orders.find({}).sort({ createdAt: -1 }).limit(300).toArray();
        res.json({
            orders: docs.map((o) => ({ ...publicOrder(o), email: o.email || "" })),
            statuses: ORDER_STATUSES,
            stored: true,
        });
    } catch (err) {
        console.error("❌ ADMIN ORDERS ERROR:", err);
        res.status(500).json({ error: "Could not load orders" });
    }
});

app.put("/admin/orders/:invoiceNumber/status", requireAdmin, async (req, res) => {
    const invoiceNumber = parseInt(req.params.invoiceNumber, 10);
    const status = String((req.body && req.body.status) || "");
    const note = String((req.body && req.body.note) || "").slice(0, 300);

    if (!Number.isInteger(invoiceNumber)) {
        return res.status(400).json({ error: "Bad order number" });
    }
    if (!isValidStatus(status)) {
        return res.status(400).json({ error: "Unknown status", statuses: ORDER_STATUSES });
    }

    try {
        const orders = await collection("orders");
        if (!orders) return res.status(503).json({ error: "No database connected" });

        const now = new Date();
        const historyEntry = { status, at: now, by: "Admin" };
        if (note) historyEntry.note = note;

        const result = await orders.updateOne(
            { invoiceNumber },
            {
                $set: { status, updatedAt: now },
                $push: { history: historyEntry },
            }
        );
        if (!result.matchedCount) {
            return res.status(404).json({ error: "Order not found" });
        }
        console.log(`🛠️ Order #${invoiceNumber} -> ${status}`);
        res.json({ success: true, invoiceNumber, status });
    } catch (err) {
        console.error("❌ ADMIN STATUS ERROR:", err);
        res.status(500).json({ error: "Could not update order" });
    }
});

// Every email address we've collected (checkout, contact form, bookings…)
app.get("/admin/customers", requireAdmin, async (req, res) => {
    try {
        const accounts = await collection("accounts");
        if (!accounts) return res.json({ customers: [], stored: false });

        const docs = await accounts
            .find({}, { projection: { name: 1, sources: 1, createdAt: 1 } })
            .sort({ createdAt: -1 })
            .limit(500)
            .toArray();

        res.json({
            customers: docs.map((d) => ({
                email: d._id,
                name: d.name || "",
                sources: d.sources || (d.source ? [d.source] : []),
                createdAt: d.createdAt,
            })),
            stored: true,
        });
    } catch (err) {
        console.error("❌ ADMIN CUSTOMERS ERROR:", err);
        res.status(500).json({ error: "Could not load customers" });
    }
});

// ========================
// START SERVER
// ========================
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});