// backend/invoice.js
// Invoice numbering + HTML invoice builder for LocalTech order emails.
//
// The invoice number is sequential and starts at 200 (or the INVOICE_START
// env var if it is set higher).
//
// Storage order of preference:
//   1. MongoDB counter (data/invoice-counter collection) — survives Render
//      redeploys, restarts AND the 15-minute spin-down, and is atomic, so
//      two checkouts at the same instant can never share a number.
//   2. data/invoice-counter.json — local/dev fallback only. On Render's free
//      plan this file is wiped on every restart (that is why numbers used to
//      snap back to 200), so INVOICE_START acts as a floor there: after a
//      wipe set INVOICE_START to the next number you need.
//
// getNextInvoiceNumber() is ASYNC — always await it.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const COUNTER_FILE = path.join(DATA_DIR, "invoice-counter.json");

// ========================
// Invoice numbers
// ========================
async function getNextInvoiceNumber() {
    const seed = parseInt(process.env.INVOICE_START || "200", 10) || 200;

    // 1) MongoDB — the real fix for the "reverts to 200" bug
    try {
        const { dbReady } = require("./db");
        const db = await dbReady();
        if (db) {
            const result = await db.collection("counters").findOneAndUpdate(
                { _id: "invoice" },
                [
                    {
                        $set: {
                            last: {
                                $max: [
                                    { $add: [{ $ifNull: ["$last", seed - 1] }, 1] },
                                    seed,
                                ],
                            },
                        },
                    },
                ],
                { upsert: true, returnDocument: "after" }
            );
            const doc = result && result.value !== undefined ? result.value : result;
            if (doc && Number.isInteger(doc.last)) return doc.last;
        }
    } catch (err) {
        console.error("⚠️ MongoDB invoice counter failed, using file:", err.message);
    }

    // 2) File fallback (local development, or Atlas not configured yet)
    let next = seed;
    try {
        if (fs.existsSync(COUNTER_FILE)) {
            const saved = JSON.parse(fs.readFileSync(COUNTER_FILE, "utf8"));
            if (saved && Number.isInteger(saved.next)) {
                next = saved.next;
            }
        }

        // The env var acts as a floor if the file was ever lost
        next = Math.max(next, seed);

        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(
            COUNTER_FILE,
            JSON.stringify({ next: next + 1, updatedAt: new Date().toISOString() }, null, 2)
        );
    } catch (err) {
        console.error("⚠️ Invoice counter error:", err.message);
    }

    return next;
}

// ========================
// Helpers
// ========================
function formatInvoiceDate(d = new Date()) {
    return d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

// Escape user-supplied text so it can't break the invoice layout
function esc(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

const rands = (amount) => `R${Number(amount).toFixed(2)}`;

// ========================
// Invoice HTML builder
// ========================
// All styles are inline so every email client renders the same layout.
function buildInvoiceHtml({
    invoiceNumber,
    date,
    customer = {},
    cart = [],
    shippingOption,
    subtotal,
    shippingFee,
    total,
    paymentMethod,
    transactionId,
    hasLogo = false,
}) {
    const hasBooking = cart.some((item) => item.booking);

    // ---------- Header: logo + invoice meta ----------
    const headerLeft = hasLogo
        ? `<img src="cid:localtech-logo" alt="LocalTech" style="height:70px; display:block;" />`
        : `<div style="font-size:26px; font-weight:bold; color:#111827;">LocalTech</div>`;

    const header = `
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr>
                <td style="padding-bottom:18px;">${headerLeft}</td>
                <td align="right" style="padding-bottom:18px; font-family:Arial,Helvetica,sans-serif; color:#6b7280; font-size:13px;">
                    <div style="font-size:14px; letter-spacing:2px; color:#2563EB; font-weight:bold;">INVOICE</div>
                    <div style="font-size:24px; font-weight:bold; color:#111827;">#${esc(invoiceNumber)}</div>
                    <div>Date: ${esc(date)}</div>
                </td>
            </tr>
        </table>
        <div style="border-top:3px solid #2563EB; margin-bottom:20px;"></div>`;

    // ---------- Bill-to ----------
    const billTo = `
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-bottom:22px;">
            <tr>
                <td style="padding-right:20px; vertical-align:top; width:50%;">
                    <div style="font-size:12px; text-transform:uppercase; letter-spacing:1px; color:#9ca3af; margin-bottom:4px;">Invoice To</div>
                    <div style="font-weight:bold; color:#111827;">${esc(customer.name)}</div>
                    ${customer.email ? `<div style="color:#374151; font-size:14px;">${esc(customer.email)}</div>` : ""}
                    ${customer.phone ? `<div style="color:#374151; font-size:14px;">${esc(customer.phone)}</div>` : ""}
                    ${customer.address ? `<div style="color:#374151; font-size:14px;">${esc(customer.address)}</div>` : ""}
                </td>
                <td style="vertical-align:top;">
                    <div style="font-size:12px; text-transform:uppercase; letter-spacing:1px; color:#9ca3af; margin-bottom:4px;">Transaction</div>
                    <div style="color:#374151; font-size:14px;">${esc(transactionId)}</div>
                    <div style="color:#374151; font-size:14px;">Payment: ${esc(paymentMethod || "N/A")}</div>
                </td>
            </tr>
        </table>`;

    // ---------- Items table ----------
    const itemRows = cart
        .map((item) => {
            const lineTotal = item.price * item.quantity;
            let description = `<div style="font-weight:bold; color:#111827;">${esc(item.title)}</div>`;

            if (item.color) {
                description += `<div style="color:#6b7280; font-size:12px;">Colour: ${esc(item.color)}</div>`;
            }
            if (item.size) {
                description += `<div style="color:#6b7280; font-size:12px;">Size: ${esc(item.size)}</div>`;
            }
            if (item.booking) {
                const b = item.booking;
                description += `
                    <div style="color:#6b7280; font-size:12px; margin-top:4px;">
                        Includes courier collection &amp; return (2 trips)<br>
                        Service: ${esc(b.service)}<br>
                        Preferred date: ${esc(b.date)}${b.time ? ` at ${esc(b.time)}` : ""}<br>
                        Phone: ${esc(b.phone)}<br>
                        Collection address: ${esc(b.address)}
                        ${b.notes ? `<br>Reported problem: ${esc(b.notes)}` : ""}
                    </div>`;
            }

            return `
                <tr>
                    <td style="padding:10px 8px; border-bottom:1px solid #e5e7eb; vertical-align:top;">${description}</td>
                    <td style="padding:10px 8px; border-bottom:1px solid #e5e7eb; text-align:center; vertical-align:top;">${esc(item.quantity)}</td>
                    <td style="padding:10px 8px; border-bottom:1px solid #e5e7eb; text-align:right; vertical-align:top;">${rands(item.price)}</td>
                    <td style="padding:10px 8px; border-bottom:1px solid #e5e7eb; text-align:right; vertical-align:top; font-weight:bold;">${rands(lineTotal)}</td>
                </tr>`;
        })
        .join("");

    const itemsTable = `
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-bottom:20px;">
            <tr style="background-color:#2563EB; color:#ffffff;">
                <th align="left" style="padding:10px 8px; font-size:13px; text-transform:uppercase;">Description</th>
                <th align="center" style="padding:10px 8px; font-size:13px; text-transform:uppercase; width:50px;">Qty</th>
                <th align="right" style="padding:10px 8px; font-size:13px; text-transform:uppercase; width:90px;">Price</th>
                <th align="right" style="padding:10px 8px; font-size:13px; text-transform:uppercase; width:100px;">Amount</th>
            </tr>
            ${itemRows}
        </table>`;

    // ---------- Totals ----------
    const deliveryLabel =
        shippingOption === "courier"
            ? "Courier delivery"
            : hasBooking
            ? "No additional delivery charge"
            : "Pickup from workshop";

    const totals = `
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-bottom:20px;">
            <tr>
                <td style="padding:6px 8px; color:#374151;" align="right">Subtotal</td>
                <td style="padding:6px 8px; width:120px; text-align:right; color:#374151;">${rands(subtotal)}</td>
            </tr>
            <tr>
                <td style="padding:6px 8px; color:#374151;" align="right">${deliveryLabel}</td>
                <td style="padding:6px 8px; text-align:right; color:#374151;">${rands(shippingFee)}</td>
            </tr>
            <tr>
                <td style="padding:12px 8px; border-top:2px solid #111827; font-size:18px; font-weight:bold; color:#111827;" align="right">TOTAL</td>
                <td style="padding:12px 8px; border-top:2px solid #111827; text-align:right; font-size:18px; font-weight:bold; color:#2563EB;">${rands(total)}</td>
            </tr>
        </table>`;

    // ---------- Notes / payment ----------
    let paymentNote = "";
    if (paymentMethod && paymentMethod.toUpperCase() === "EFT") {
        paymentNote = `<p style="margin:0 0 8px; color:#374151; font-size:14px;">
            <strong>Payment due via EFT.</strong> Please email proof of payment to
            localtechza@gmail.com and quote <strong>${esc(invoiceNumber)}</strong> as your reference.
        </p>`;
    } else {
        paymentNote = `<p style="margin:0 0 8px; color:#374151; font-size:14px;">
            <strong>Payment:</strong> ${esc(paymentMethod || "N/A")} — thank you, we'll start on your order right away.
        </p>`;
    }

    const bookingNote = hasBooking
        ? `<p style="margin:0 0 8px; color:#374151; font-size:14px;">
            We'll inspect your PC on arrival and contact you with a quote for any parts or
            further repair work <em>before</em> proceeding.
          </p>`
        : "";

    // ---------- Footer ----------
    // TODO: Replace [YOUR BUSINESS ADDRESS] below with your real business address
    const footer = `
        <div style="border-top:1px solid #e5e7eb; padding-top:14px; font-family:Arial,Helvetica,sans-serif; color:#9ca3af; font-size:12px; text-align:center; line-height:1.7;">
            <strong style="color:#2563EB;">LocalTech</strong> — Chosen Thoughtfully<br>
            081 6422 215 &nbsp;·&nbsp; localtechza@gmail.com &nbsp;·&nbsp; [YOUR BUSINESS ADDRESS]<br>
            Invoice #${esc(invoiceNumber)} · ${esc(date)} · ${esc(transactionId)}
        </div>`;

    return `
        <div style="max-width:640px; margin:0 auto; font-family:Arial,Helvetica,sans-serif; color:#111827; background-color:#ffffff;">
            ${header}
            ${billTo}
            ${itemsTable}
            ${totals}
            ${paymentNote}
            ${bookingNote}
            <div style="background-color:#f9fafb; border-radius:8px; padding:14px 16px; margin-bottom:20px;">
                <p style="margin:0; color:#374151; font-size:14px; line-height:1.6;">
                    Thank you for choosing LocalTech! If you have any questions about this
                    invoice, just reply to this email or contact us.
                </p>
            </div>
            ${footer}
        </div>`;
}

module.exports = { getNextInvoiceNumber, formatInvoiceDate, buildInvoiceHtml };
