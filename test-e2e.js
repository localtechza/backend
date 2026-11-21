// backend/test-e2e.js
// End-to-end test for LocalTech's order storage, email-code login, admin
// status updates and (most importantly) invoice numbering ACROSS A SERVER
// RESTART — the "reverts to 200" regression.
//
// Run:  npm test          (spins up an in-memory MongoDB, no Atlas needed)

const { MongoMemoryServer } = require("mongodb-memory-server");
const { spawn } = require("child_process");
const path = require("path");

const PORT = 10999;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PIN = "481902";

let passed = 0;
let failed = 0;
function check(label, condition, extra) {
    if (condition) {
        passed += 1;
        console.log(`  PASS ${label}`);
    } else {
        failed += 1;
        console.log(`  FAIL ${label}${extra ? " — " + extra : ""}`);
    }
}

async function req(method, route, body, token) {
    const res = await fetch(BASE + route, {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
        json = await res.json();
    } catch (_) {
        /* no body */
    }
    return { status: res.status, json };
}

function startServer(env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
            env: { ...process.env, ...env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let started = false;
        const onData = (buf) => {
            const text = buf.toString();
            if (!started && text.includes("Server running")) {
                started = true;
                resolve(child);
            }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", (b) => process.stdout.write(`[server] ${b}`));
        child.on("error", reject);
        setTimeout(() => (started ? null : reject(new Error("server start timeout"))), 30000);
    });
}

function stopServer(child) {
    return new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill();
        setTimeout(resolve, 3000);
    });
}

async function waitForServer() {
    for (let i = 0; i < 40; i++) {
        try {
            const r = await req("GET", "/");
            if (r.status === 200) return;
        } catch (_) {
            /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("server never came up");
}

async function checkout(email, label) {
    return req("POST", "/checkout", {
        name: "Test Buyer",
        email,
        phone: "0810000000",
        cart: [{ handle: "hp-prodesk-400-g6", title: "HP ProDesk 400 G6", price: 4999, quantity: 1 }],
        total: 4999,
        address: "1 Test Street, Cape Town",
        shippingOption: "pickup",
        paymentMethod: label || "EFT",
    });
}

(async () => {
    console.log("Starting in-memory MongoDB…");
    const mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();

    const env = {
        MONGO_URI: uri,
        MONGO_DB: "localtech_test",
        PORT: String(PORT),
        ADMIN_PIN,
        SESSION_SECRET: "test-secret-do-not-use-in-prod",
        NODE_ENV: "test", // lets the test read devCode instead of an inbox
        INVOICE_START: "200",
    };

    let server = await startServer(env);
    await waitForServer();

    try {
        // ---------------------------------------------------------
        console.log("\n1) Invoice numbers increment…");
        let r = await checkout("buyer@test.com");
        check("checkout 1 ok", r.status === 200 && r.json.success, JSON.stringify(r.json));
        check("first invoice = 200", r.json.invoiceNumber === 200, `got ${r.json.invoiceNumber}`);
        const token1 = r.json.token;
        check("buyer signed in (token returned)", Boolean(token1));
        check("checkout session is unverified", r.json.verified === false);

        r = await checkout("buyer@test.com");
        check("second invoice = 201", r.json.invoiceNumber === 201, `got ${r.json.invoiceNumber}`);
        r = await checkout("buyer@test.com");
        check("third invoice = 202", r.json.invoiceNumber === 202, `got ${r.json.invoiceNumber}`);

        // ---------------------------------------------------------
        console.log("\n2) RESTART the server (simulates Render restart/spin-down)…");
        await stopServer(server);
        server = await startServer(env);
        await waitForServer();

        r = await checkout("buyer@test.com");
        check("fourth invoice = 203 after restart", r.json.invoiceNumber === 203, `got ${r.json.invoiceNumber}`);
        const token4 = r.json.token;

        // ---------------------------------------------------------
        console.log("\n3) Orders STACK for the customer (every order, newest first)…");
        r = await req("GET", "/auth/orders", null, token1);
        check("orders fetch ok", r.status === 200, String(r.status));
        check("unverified -> all 4 orders stack",
            r.json.orders && r.json.orders.length === 4,
            `got ${r.json.orders && r.json.orders.length}`);
        check("newest order listed first",
            r.json.orders[0] && r.json.orders[0].invoiceNumber === 203,
            `got ${r.json.orders[0] && r.json.orders[0].invoiceNumber}`);
        check("oldest order still listed",
            r.json.orders.some((o) => o.invoiceNumber === 200));
        check("flagged unverified", r.json.verified === false);

        // A different customer must never see someone else's orders
        const other = await checkout("other@test.com");
        check("second buyer checkout ok", other.status === 200, JSON.stringify(other.json));
        r = await req("GET", "/auth/orders", null, other.json.token);
        check("other buyer sees only their own order",
            r.json.orders && r.json.orders.length === 1 && r.json.orders[0].invoiceNumber === 204,
            JSON.stringify(r.json.orders && r.json.orders.map((o) => o.invoiceNumber)));
        r = await req("GET", "/auth/orders", null, token1);
        check("first buyer still sees exactly their 4 orders",
            r.json.orders && r.json.orders.length === 4,
            `got ${r.json.orders && r.json.orders.length}`);

        r = await req("GET", "/auth/orders", null, "not-a-real-token");
        check("bogus token rejected", r.status === 401, String(r.status));

        // ---------------------------------------------------------
        console.log("\n4) Email code login…");
        r = await req("POST", "/auth/start", { email: "buyer@test.com" });
        check("code requested", r.status === 200 && r.json.success, JSON.stringify(r.json));
        check("devCode returned in test mode", /^\d{6}$/.test(r.json.devCode || ""), String(r.json.devCode));
        const code = r.json.devCode;

        r = await req("POST", "/auth/verify", { email: "buyer@test.com", code: "000000" });
        check("wrong code rejected", r.status === 401, String(r.status));

        r = await req("POST", "/auth/verify", { email: "buyer@test.com", code });
        check("correct code accepted", r.status === 200 && r.json.verified === true, JSON.stringify(r.json));
        const verifiedToken = r.json.token;

        r = await req("POST", "/auth/verify", { email: "buyer@test.com", code });
        check("code is one-time use", r.status === 401, String(r.status));

        // ---------------------------------------------------------
        console.log("\n5) Verified session sees ALL its orders…");
        r = await req("GET", "/auth/orders", null, verifiedToken);
        check("verified -> 4 orders", r.json.orders && r.json.orders.length === 4, `got ${r.json.orders && r.json.orders.length}`);
        check("flagged verified", r.json.verified === true);
        const orderFields = r.json.orders[0];
        check("order has items/total/status/history",
            orderFields && orderFields.items && orderFields.items.length === 1 &&
            orderFields.total && orderFields.status === "Awaiting payment" &&
            Array.isArray(orderFields.history),
            JSON.stringify(orderFields && { status: orderFields.status, history: orderFields.history }));
        check("checkout token also promoted to verified",
            (await req("GET", "/auth/me", null, token4)).json.verified === true);

        // ---------------------------------------------------------
        console.log("\n6) Admin page: PIN, orders, status updates…");
        r = await req("POST", "/admin/login", { pin: "wrong" });
        check("wrong PIN rejected", r.status === 401, String(r.status));
        r = await req("POST", "/admin/login", { pin: ADMIN_PIN });
        check("correct PIN accepted", r.status === 200 && Boolean(r.json.token), JSON.stringify(r.json));
        const adminToken = r.json.token;

        r = await req("GET", "/admin/orders", null, adminToken);
        check("admin sees all 5 orders", r.json.orders && r.json.orders.length === 5, `got ${r.json.orders && r.json.orders.length}`);
        check("admin sees customer email",
            r.json.orders.some((o) => o.email === "buyer@test.com") &&
            r.json.orders.some((o) => o.email === "other@test.com"),
            JSON.stringify(r.json.orders.map((o) => o.email)));
        check("status list published", r.json.statuses && r.json.statuses.includes("Ready for pickup"));

        r = await req("GET", "/admin/orders");
        check("admin orders needs token", r.status === 401, String(r.status));

        r = await req("PUT", "/admin/orders/201/status", { status: "Ready for pickup", note: "Courier booked" }, adminToken);
        check("status updated", r.status === 200 && r.json.status === "Ready for pickup", JSON.stringify(r.json));

        r = await req("PUT", "/admin/orders/201/status", { status: "Flying away" }, adminToken);
        check("invalid status rejected", r.status === 400, String(r.status));

        r = await req("PUT", "/admin/orders/999/status", { status: "Shipped" }, adminToken);
        check("unknown order rejected", r.status === 404, String(r.status));

        r = await req("GET", "/auth/orders", null, verifiedToken);
        const updated = r.json.orders.find((o) => o.invoiceNumber === 201);
        check("customer sees new status", updated && updated.status === "Ready for pickup", updated && updated.status);
        check("customer sees the note", updated && updated.history.slice(-1)[0].note === "Courier booked",
            updated && JSON.stringify(updated.history.slice(-1)[0]));

        // ---------------------------------------------------------
        console.log("\n7) Recently viewed products on the account…");
        // A brand-new checkout = a genuinely unverified session (the ones
        // from earlier were promoted when buyer@test.com verified their code)
        const fresh = await checkout("fresh@test.com");
        const freshToken = fresh.json.token;
        check("fresh checkout session is unverified", fresh.json.verified === false);

        r = await req("POST", "/auth/viewed", { handle: "hp-prodesk-400-g6", title: "HP ProDesk 400 G6", price: 4999, image: "x.jpg" }, freshToken);
        check("unverified cannot sync viewed", r.status === 403, String(r.status));

        for (const h of ["dell-optiplex-3080", "hp-prodesk-400-g6", "samsung-monitor"]) {
            await req("POST", "/auth/viewed", { handle: h, title: h, price: 100, image: "i.jpg" }, verifiedToken);
        }
        r = await req("GET", "/auth/viewed", null, verifiedToken);
        check("viewed list has 3 unique items", r.json.viewed && r.json.viewed.length === 3, `got ${r.json.viewed && r.json.viewed.length}`);
        check("newest viewed first", r.json.viewed[0].handle === "samsung-monitor", r.json.viewed[0] && r.json.viewed[0].handle);
        r = await req("GET", "/auth/viewed", null, freshToken);
        check("unverified session gets empty viewed list", r.json.viewed && r.json.viewed.length === 0, JSON.stringify(r.json.viewed));

        // ---------------------------------------------------------
        console.log("\n8) Email capture from forms (contact/booking)…");
        process.env.MONGO_URI = uri;
        process.env.MONGO_DB = "localtech_test"; // same DB the server uses
        const authMod = require("./auth");
        await require("./db").dbReady();
        await authMod.captureEmail("repairs@test.com", "Repair Client", "booking");
        r = await req("GET", "/admin/customers", null, adminToken);
        const emails = r.json.customers.map((c) => c.email);
        check("captured email listed for admin", emails.includes("repairs@test.com"), JSON.stringify(emails));
        check("checkout email also listed", emails.includes("buyer@test.com"), JSON.stringify(emails));
        r = await req("POST", "/auth/start", { email: "repairs@test.com" });
        check("captured email can request a login code", r.status === 200 && r.json.success, JSON.stringify(r.json));

        // ---------------------------------------------------------
        console.log("\n9) Paystack initialisation accepts our reference + callback…");
        if (process.env.PAYSTACK_SECRET_KEY || require("dotenv").config().parsed?.PAYSTACK_SECRET_KEY) {
            r = await req("POST", "/initialize-payment", {
                email: "buyer@test.com",
                amount: 100,
                reference: `TXN-E2E-${Date.now()}`,
            });
            check("Paystack accepted reference + callback_url",
                r.status === 200 && r.json.data && r.json.data.authorization_url,
                JSON.stringify(r.json).slice(0, 300));
        } else {
            console.log("  SKIP no Paystack key available");
        }

        // ---------------------------------------------------------
        console.log("\n10) Logout…");
        r = await req("POST", "/auth/logout", null, verifiedToken);
        check("logout ok", r.status === 200, String(r.status));
        r = await req("GET", "/auth/me", null, verifiedToken);
        check("token dead after logout", r.status === 401, String(r.status));

        // ---------------------------------------------------------
        console.log("\n11) Graceful degradation: server with NO database…");
        await stopServer(server);
        const noDbEnv = { ...env, MONGO_URI: "" }; // "" overrides the value the child would inherit
        server = await startServer(noDbEnv);
        await waitForServer();
        r = await checkout("nodb@test.com");
        check("checkout still succeeds without a DB", r.status === 200 && r.json.success, JSON.stringify(r.json));
        check("invoice number still returned", Number.isInteger(r.json.invoiceNumber) && r.json.invoiceNumber >= 200,
            String(r.json.invoiceNumber));
        check("no session token without storage", r.json.token === null, String(r.json.token));
        r = await req("POST", "/auth/start", { email: "nodb@test.com" });
        check("login endpoint reports unavailable instead of crashing",
            r.status === 429 || r.status === 503, String(r.status));

    } catch (err) {
        failed += 1;
        console.error("\nTEST CRASHED:", err);
    } finally {
        await stopServer(server);
        await mongod.stop();
    }

    console.log(`\n=============================\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
