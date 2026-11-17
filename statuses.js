// backend/statuses.js
// The customer-facing order pipeline. KEEP IN SYNC with
// src/pages/Profile.js and src/pages/Admin.js on the website (the frontend
// keeps its own copy so it can render instantly without an API round-trip).

const ORDER_STATUSES = [
    "Awaiting payment",
    "Payment confirmed",
    "Packing",
    "Ready for pickup",
    "Shipped",
    "Delivered",
    "Cancelled",
];

// Steps a normal order walks through (Cancelled can happen from any stage,
// so it is tracked separately and never part of the progress bar).
const STATUS_FLOW = [
    "Awaiting payment",
    "Payment confirmed",
    "Packing",
    "Ready for pickup",
    "Shipped",
    "Delivered",
];

// Every order starts here: the customer has placed it but we have not seen
// the money yet (EFT waiting on the transfer, card waiting on the Paystack
// redirect + verification). "Payment confirmed" is set by Paystack
// verification or by you in the admin page.
function initialStatus() {
    return "Awaiting payment";
}

function isValidStatus(status) {
    return ORDER_STATUSES.includes(status);
}

module.exports = { ORDER_STATUSES, STATUS_FLOW, initialStatus, isValidStatus };
