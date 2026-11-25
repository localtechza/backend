// One-off setup for Stitch Express: registers the redirect URL and webhook
// through the API so the onboarding checklist ticks automatically, then
// prints the webhook signing secret. Stitch shows that secret only once.
//
// Run locally with the test credentials already in backend/.env:
//     node register-stitch.js
//
// Then copy the printed whsec_... value into STITCH_WEBHOOK_SECRET in both
// backend/.env and the Render environment, and restart/redeploy the backend.
require("dotenv").config();
const axios = require("axios");

const API = "https://express.stitch.money";
const REDIRECT_URL = "https://localtechza.co.za/checkout-result";
const WEBHOOK_URL = `${process.env.BACKEND_PUBLIC_URL || "https://localtech-backend.onrender.com"}/api/webhooks/stitch`;

async function main() {
    const clientId = process.env.STITCH_CLIENT_ID;
    const clientSecret = process.env.STITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error("STITCH_CLIENT_ID / STITCH_CLIENT_SECRET missing from .env");
    }

    const tokenRes = await axios.post(`${API}/api/v1/token`, {
        clientId,
        clientSecret,
        scope: "client_paymentrequest",
    });
    const token = tokenRes.data && tokenRes.data.data && tokenRes.data.data.accessToken;
    if (!token) throw new Error("Could not get a Stitch access token");
    const auth = { Authorization: `Bearer ${token}` };

    try {
        const redirect = await axios.post(
            `${API}/api/v1/redirect-urls`,
            { redirectUrl: REDIRECT_URL },
            { headers: auth }
        );
        console.log("✅ Redirect URL registered:", REDIRECT_URL);
        console.log("   Registered URLs:", JSON.stringify(redirect.data?.data?.redirectUrls || []));
    } catch (err) {
        if (err.response?.status === 409) {
            console.log("ℹ️ Redirect URL already registered:", REDIRECT_URL);
        } else {
            throw err;
        }
    }

    try {
        const webhook = await axios.post(
            `${API}/api/v1/webhook`,
            { url: WEBHOOK_URL },
            { headers: auth }
        );
        console.log("✅ Webhook registered:", WEBHOOK_URL);
        console.log("");
        console.log("=== COPY THIS INTO STITCH_WEBHOOK_SECRET ===");
        console.log(webhook.data?.data?.secret || "(no secret returned)");
        console.log("===========================================");
        console.log("Stitch will not show this secret again.");
    } catch (err) {
        if (err.response?.status === 409) {
            console.log("ℹ️ Webhook already registered:", WEBHOOK_URL);
            console.log("   If you lost the secret, delete the endpoint in the dashboard and run this again.");
        } else {
            throw err;
        }
    }
}

main().catch((err) => {
    console.error("❌ Stitch setup failed:", err.response?.data || err.message);
    process.exitCode = 1;
});
