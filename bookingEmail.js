// backend/bookingEmail.js
// Branded HTML for drop-off booking emails, styled to match the invoice emails.

function esc(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function row(label, value) {
    if (!value) return "";
    return `
        <tr>
            <td style="padding:6px 0; color:#6b7280; font-size:13px; width:140px; vertical-align:top;">${label}</td>
            <td style="padding:6px 0; color:#111827; font-size:14px; vertical-align:top;">${esc(value)}</td>
        </tr>`;
}

// audience = "customer" (confirmation) or "admin" (notification)
function buildBookingHtml({
    name,
    email,
    phone,
    address,
    service,
    date,
    notes,
    delivery,
    audience = "customer",
}) {
    const isAdmin = audience === "admin";
    const title = isAdmin ? "NEW BOOKING" : "BOOKING CONFIRMATION";
    const heading = isAdmin
        ? `New booking — ${esc(name)}`
        : `Thanks ${esc(name)}, your PC is booked in`;
    const intro = isAdmin
        ? "A customer has requested a PC service booking. Their details are below."
        : "We've received your booking request. We'll contact you to confirm your drop-off time.";

    const deliveryText =
        delivery === "courier"
            ? "Courier collection &amp; return (2 trips)"
            : "Drop it off personally — no charge";

    const details = `
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-bottom:18px;">
            ${row("Service", service)}
            ${row("Preferred date", date)}
            ${row("How it gets to us", delivery === "courier" ? "Courier collection & return" : "Drop it off personally")}
            ${row("Name", name)}
            ${row("Phone", phone)}
            ${row("Email", email)}
            ${row("Address", address)}
            ${row("Notes", notes || "None")}
        </table>`;

    const nextSteps = isAdmin
        ? `<p style="margin:0 0 8px; color:#374151; font-size:14px; line-height:1.6;">
             You can contact the customer on <strong>${esc(phone)}</strong> or
             <a href="mailto:${esc(email)}" style="color:#2563EB;">${esc(email)}</a>.
           </p>`
        : `<p style="margin:0 0 8px; color:#374151; font-size:14px; line-height:1.6;">
             <strong>What happens next:</strong> Bring your PC to our workshop at
             <strong>44 Kundalila Road, Waterfall, KZN</strong> on your chosen date. We'll inspect it
             first and contact you with a quote for any parts or further repair work
             <em>before</em> we proceed.
           </p>
           <p style="margin:0; color:#374151; font-size:14px; line-height:1.6;">
             Dropping it off is free — any repair work is quoted separately. Questions?
             Call <strong>081 6422 215</strong> or email
             <a href="mailto:localtechza@gmail.com" style="color:#2563EB;">localtechza@gmail.com</a>.
           </p>`;

    const footer = `
        <div style="border-top:1px solid #e5e7eb; padding-top:14px; font-family:Arial,Helvetica,sans-serif; color:#9ca3af; font-size:12px; text-align:center; line-height:1.7;">
            <strong style="color:#2563EB;">LocalTech</strong> — Chosen Thoughtfully<br>
            081 6422 215 &nbsp;·&nbsp; localtechza@gmail.com &nbsp;·&nbsp; 44 Kundalila Road, Waterfall, KZN
        </div>`;

    return `
        <div style="max-width:640px; margin:0 auto; font-family:Arial,Helvetica,sans-serif; color:#111827; background-color:#ffffff;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <tr>
                    <td style="padding-bottom:18px;">
                        <div style="font-size:26px; font-weight:bold; color:#111827;">LocalTech</div>
                    </td>
                    <td align="right" style="padding-bottom:18px; font-family:Arial,Helvetica,sans-serif; color:#6b7280; font-size:13px;">
                        <div style="font-size:14px; letter-spacing:2px; color:#2563EB; font-weight:bold;">${title}</div>
                        <div>Date: ${esc(date)}</div>
                    </td>
                </tr>
            </table>
            <div style="border-top:3px solid #2563EB; margin-bottom:20px;"></div>

            <h1 style="font-size:22px; color:#111827; margin:0 0 10px;">${heading}</h1>
            <p style="margin:0 0 20px; color:#374151; font-size:14px; line-height:1.6;">${intro}</p>

            <div style="font-size:12px; text-transform:uppercase; letter-spacing:1px; color:#9ca3af; margin-bottom:4px;">
                Booking details
            </div>
            <div style="background-color:#f9fafb; border-radius:8px; padding:14px 16px; margin-bottom:20px;">
                ${details}
            </div>

            <div style="background-color:#eff6ff; border-left:4px solid #2563EB; border-radius:8px; padding:14px 16px; margin-bottom:20px;">
                ${nextSteps}
            </div>

            <p style="margin:0 0 20px; color:#374151; font-size:14px;">
                <strong>Collection/drop-off:</strong> ${deliveryText}
            </p>

            ${footer}
        </div>`;
}

module.exports = { buildBookingHtml };
