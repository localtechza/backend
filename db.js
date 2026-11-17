// backend/db.js
// MongoDB (Atlas free tier) connection for LocalTech.
//
// Holds: orders, customer accounts (email + viewed products), login sessions,
// email login codes and the invoice counter.
//
// EVERYTHING DEGRADES GRACEFULLY: if MONGO_URI is not set (or Atlas is
// unreachable) the API keeps running — emails still send, checkout still
// works — only persistence is skipped. Callers use dbReady()/getDb() and
// treat a null db as "no storage available".
//
// Render env vars needed:  MONGO_URI   mongodb+srv://user:pass@cluster/...
//                          MONGO_DB    optional, defaults to "localtech"

const { MongoClient } = require("mongodb");

let client = null;
let db = null;
let connectPromise = null;
let indexesDone = false;

function isEnabled() {
    return Boolean(process.env.MONGO_URI);
}

async function dbReady() {
    if (!isEnabled()) return null;
    if (db) return db;
    if (!connectPromise) {
        connectPromise = (async () => {
            const c = new MongoClient(process.env.MONGO_URI, {
                serverSelectionTimeoutMS: 8000,
                retryWrites: true,
            });
            await c.connect();
            client = c;
            db = c.db(process.env.MONGO_DB || "localtech");
            console.log("🗄️ MongoDB connected");
            await ensureIndexes();
            return db;
        })().catch((err) => {
            connectPromise = null; // allow a retry on the next request
            console.error("⚠️ MongoDB unavailable:", err.message);
            return null;
        });
    }
    return connectPromise;
}

function getDb() {
    return db;
}

// Speeds up order lookups by customer email; TTL keeps login codes tidy.
async function ensureIndexes() {
    if (indexesDone || !db) return;
    try {
        await db.collection("orders").createIndex({ email: 1, createdAt: -1 });
        await db.collection("orders").createIndex({ sourceToken: 1 });
        await db.collection("orders").createIndex({ transactionId: 1 });
        await db.collection("login_codes").createIndex(
            { expiresAt: 1 },
            { expireAfterSeconds: 0 }
        );
        await db.collection("sessions").createIndex(
            { lastSeenAt: 1 },
            { expireAfterSeconds: 90 * 24 * 60 * 60 } // sessions age out after 90 idle days
        );
        indexesDone = true;
    } catch (err) {
        console.error("⚠️ Index creation failed:", err.message);
    }
}

async function collection(name) {
    const d = await dbReady();
    return d ? d.collection(name) : null;
}

async function close() {
    if (client) await client.close().catch(() => {});
    client = null;
    db = null;
    connectPromise = null;
    indexesDone = false;
}

module.exports = { isEnabled, dbReady, getDb, collection, close };
