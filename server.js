require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const { Resend } = require("resend");
const { getNextInvoiceNumber, formatInvoiceDate, buildInvoiceHtml } = require("./invoice");

const app = express();
const PORT = process.env.PORT || 10000;

// ========================
// Middleware
// ========================
app.use(express.json());
app.use(cors());

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

    try {
        const result = await resend.emails.send({
            from: FROM_EMAIL,
            to: ADMIN_EMAIL,
            subject: `Contact Form - ${name}`,
            html: `
                <h2>New Contact Message</h2>
                <p><b>Name:</b> ${name}</p>
                <p><b>Email:</b> ${email}</p>
                <p><b>Message:</b><br>${message}</p>
            `,
        });

        console.log("✅ CONTACT EMAIL SENT:", result);
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
    const { email, amount } = req.body;

    try {
        const response = await axios.post(
            "https://api.paystack.co/transaction/initialize",
            {
                email,
                amount: amount * 100,
                currency: "ZAR",
            },
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
    try {
        const response = await axios.get(
            `https://api.paystack.co/transaction/verify/${req.params.reference}`,
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                },
            }
        );

        res.json(response.data);

    } catch (err) {
        console.error("❌ VERIFY ERROR:", err.response?.data || err);
        res.status(500).json({ error: "Verification failed" });
    }
});

// ======================================================
// 5. CHECKOUT (BULLETPROOF FIXED VERSION)
// ======================================================
app.post("/checkout", async (req, res) => {
    const { name, email, phone, cart, total, address, shippingOption, paymentMethod } = req.body;

    console.log("🧾 CHECKOUT RECEIVED:", req.body);

    if (!name || !Array.isArray(cart) || cart.length === 0 || !total || !address || !shippingOption) {
        return res.status(400).json({ error: "Invalid checkout request" });
    }

    const safeEmail =
        email && email.trim().length > 0
            ? email
            : null;

    const transactionId = `TXN-${Date.now()}`;

    // Amounts are calculated from the cart so the invoice always matches
    // what the client was charged at checkout (subtotal + shipping).
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const shippingFee = shippingOption === "courier" ? 120 : 0;
    const grandTotal = subtotal + shippingFee;

    // Sequential invoice number (200, 201, 202, ...) — see invoice.js
    const invoiceNumber = getNextInvoiceNumber();
    const invoiceDate = formatInvoiceDate();

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
        });

    } catch (err) {
        console.error("❌ CHECKOUT ERROR:", err);
        res.status(500).json({ error: "Checkout failed" });
    }
});

// ========================
// START SERVER
// ========================
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});