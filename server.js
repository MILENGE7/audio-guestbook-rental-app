const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { Pool, types } = require("pg");

types.setTypeParser(1082, (value) => value);

const ROOT = __dirname;
const SCHEMA_FILE = path.join(ROOT, "db", "schema.sql");
loadEnvFile(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/audio_guestbook";
const PGSSL = process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined;
const sessions = new Map();
const pool = new Pool({ connectionString: DATABASE_URL, ssl: PGSSL });

const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const packages = [
  {
    id: "classic",
    name: "IMPUNDU",
    price: 350000,
    deposit: 75,
    description: "A refined single-phone rental for intimate events and elegant welcome tables.",
    includes: ["Vintage rotary telephone", "Custom greeting setup", "Up to 5 rental hours", "Digital audio delivery"],
    events: ["Weddings", "Showers", "Birthdays"]
  },
  {
    id: "signature",
    name: "IJURU RITO",
    price: 600000,
    deposit: 120,
    description: "A full event setup with styling support, signage, and extended recording time.",
    includes: ["Styled telephone table kit", "Framed instruction card", "Up to 8 rental hours", "Priority audio processing"],
    events: ["Weddings", "Corporate", "Graduations"]
  },
  {
    id: "keepsake",
    name: "Keepsake Weekend",
    price: 800000,
    deposit: 180,
    description: "A premium weekend rental for multi-day celebrations with recording handoff support.",
    includes: ["Weekend rental window", "Backup recording device", "Custom greeting review", "Edited keepsake archive"],
    events: ["Destination", "Memorials", "Private estates"]
  }
];
const galleryItems = [
    { title: "Welcome table", text: "A clean telephone station with florals, framed instructions, and room for guest flow.", image: "gallery-welcome.jpg" },
    { title: "Reception corner", text: "A warm setup that feels like part of the venue instead of a separate booth.", image: "gallery-reception.jpg" },
    { title: "Brand event", text: "A compact guest message point for launches, anniversaries, and client activations.", image: "gallery-brand.jpg" }
  ];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const index = trimmed.indexOf("=");
    if (index === -1) return;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), String(salt), 100000, 32, "sha256");
}

function passwordMatches(password, hash, salt) {
  const actual = hashPassword(password, salt);
  const expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function initDatabase() {
  const schema = await fsp.readFile(SCHEMA_FILE, "utf8");
  await pool.query(schema);
}

function getPackage(id) {
  return packages.find((item) => item.id === id) || packages[0];
}

function todayISO() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function toISO(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function paymentStatus(amountPaid, total) {
  if (Number(amountPaid || 0) >= total) return "Paid";
  if (Number(amountPaid || 0) > 0) return "Partial";
  return "Pending";
}

function makeRef(eventDate) {
  const datePart = eventDate ? String(eventDate).replaceAll("-", "").slice(2) : Date.now().toString().slice(-6);
  return `AGB-${datePart}-${crypto.randomInt(1000, 10000)}`;
}

function makeReceiptId(date = new Date().toISOString()) {
  return `RCT-${date.replace(/\D/g, "").slice(0, 14)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

function normalizePayment(payment) {
  return {
    amount: Number(payment.amount || 0),
    method: payment.method,
    note: payment.note || "",
    receiptId: payment.receiptId || payment.receipt_id,
    recordedAt: toISO(payment.recordedAt || payment.recorded_at)
  };
}

function normalizeRecording(recording) {
  return {
    fileName: recording.fileName || recording.file_name,
    note: recording.note || "",
    uploadedAt: toISO(recording.uploadedAt || recording.uploaded_at)
  };
}

function mapBooking(row) {
  return {
    ref: row.ref,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    eventType: row.event_type,
    eventDate: row.event_date,
    venue: row.venue,
    notes: row.notes || "",
    packageId: row.package_id,
    status: row.status,
    amountPaid: Number(row.amount_paid || 0),
    payments: (row.payments || []).map(normalizePayment),
    recordings: (row.recordings || []).map(normalizeRecording),
    createdAt: toISO(row.created_at)
  };
}

async function listBookings(whereSql = "", params = []) {
  const result = await pool.query(`
    SELECT
      b.ref,
      b.full_name,
      b.phone,
      b.email,
      b.event_type,
      b.event_date,
      b.venue,
      b.notes,
      b.package_id,
      b.status,
      b.amount_paid::double precision AS amount_paid,
      b.created_at,
      COALESCE(payments.items, '[]'::json) AS payments,
      COALESCE(recordings.items, '[]'::json) AS recordings
    FROM bookings b
    LEFT JOIN LATERAL (
      SELECT json_agg(
        json_build_object(
          'amount', p.amount::double precision,
          'method', p.method,
          'note', p.note,
          'receiptId', p.receipt_id,
          'recordedAt', p.recorded_at
        ) ORDER BY p.recorded_at DESC
      ) AS items
      FROM payments p
      WHERE p.booking_ref = b.ref
    ) payments ON true
    LEFT JOIN LATERAL (
      SELECT json_agg(
        json_build_object(
          'fileName', r.file_name,
          'note', r.note,
          'uploadedAt', r.uploaded_at
        ) ORDER BY r.uploaded_at DESC
      ) AS items
      FROM recordings r
      WHERE r.booking_ref = b.ref
    ) recordings ON true
    ${whereSql}
    ORDER BY b.created_at DESC
  `, params);
  return result.rows.map(mapBooking);
}

async function getBookingByRef(ref) {
  const bookings = await listBookings("WHERE b.ref = $1", [ref]);
  return bookings[0] || null;
}

async function listBlockedDates() {
  const result = await pool.query("SELECT unavailable_date AS date, reason FROM blocked_dates ORDER BY unavailable_date ASC");
  return result.rows.map((row) => ({ date: row.date, reason: row.reason }));
}

async function findBlockedDate(date, client = pool) {
  const result = await client.query("SELECT unavailable_date AS date, reason FROM blocked_dates WHERE unavailable_date = $1", [date]);
  return result.rows[0] || null;
}

async function findActiveBookingOnDate(date, excludeRef, client = pool) {
  const params = excludeRef ? [date, excludeRef] : [date];
  const condition = excludeRef ? "AND ref <> $2" : "";
  const result = await client.query(`
    SELECT ref, status
    FROM bookings
    WHERE event_date = $1
      AND status IN ('Pending', 'Confirmed')
      ${condition}
    LIMIT 1
  `, params);
  return result.rows[0] || null;
}

async function availabilityFor(date, excludeRef, client = pool) {
  if (!date) return { available: false, reason: "Choose a date first." };

  const block = await findBlockedDate(date, client);
  if (block) {
    return { available: false, reason: `Unavailable: ${block.reason || "blocked by administrator"}.` };
  }

  const booking = await findActiveBookingOnDate(date, excludeRef, client);
  if (booking) {
    return { available: false, reason: `Unavailable: ${booking.ref} is already ${String(booking.status).toLowerCase()}.` };
  }

  return { available: true, reason: "Available for booking." };
}

function publicBooking(booking) {
  const total = getPackage(booking.packageId).price;
  return {
    ref: booking.ref,
    fullName: booking.fullName,
    email: booking.email,
    eventType: booking.eventType,
    eventDate: booking.eventDate,
    packageId: booking.packageId,
    status: booking.status,
    amountPaid: Number(booking.amountPaid || 0),
    paymentStatus: paymentStatus(booking.amountPaid, total),
    total,
    recordings: booking.status === "Completed" ? booking.recordings || [] : []
  };
}

function collectReports(bookings) {
  const revenue = bookings.reduce((sum, booking) => sum + Number(booking.amountPaid || 0), 0);
  const upcoming = bookings
    .filter((booking) => booking.eventDate >= todayISO() && ["Pending", "Confirmed"].includes(booking.status))
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  const completed = bookings.filter((booking) => booking.status === "Completed").length;
  const counts = bookings.reduce((map, booking) => {
    map.set(booking.eventType, (map.get(booking.eventType) || 0) + 1);
    return map;
  }, new Map());
  const popular = Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { revenue, upcoming, completed, popular };
}

async function listPayments() {
  const result = await pool.query(`
    SELECT
      p.amount::double precision AS amount,
      p.method,
      p.note,
      p.receipt_id AS "receiptId",
      p.recorded_at AS "recordedAt",
      b.ref,
      b.full_name AS "fullName"
    FROM payments p
    JOIN bookings b ON b.ref = p.booking_ref
    ORDER BY p.recorded_at DESC
  `);
  return result.rows.map((row) => ({ ...row, amount: Number(row.amount), recordedAt: toISO(row.recordedAt) }));
}

async function listRecordings() {
  const result = await pool.query(`
    SELECT
      r.file_name AS "fileName",
      r.note,
      r.uploaded_at AS "uploadedAt",
      b.ref,
      b.full_name AS "fullName"
    FROM recordings r
    JOIN bookings b ON b.ref = r.booking_ref
    ORDER BY r.uploaded_at DESC
  `);
  return result.rows.map((row) => ({ ...row, uploadedAt: toISO(row.uploadedAt) }));
}

async function adminPayload() {
  const [bookings, blockedDates, payments, recordings] = await Promise.all([
    listBookings(),
    listBlockedDates(),
    listPayments(),
    listRecordings()
  ]);
  const reports = collectReports(bookings);

  return {
    packages,
    galleryItems,
    bookings,
    blockedDates,
    payments,
    recordings,
    metrics: {
      bookings: bookings.length,
      upcoming: reports.upcoming.length,
      revenue: reports.revenue,
      pending: bookings.filter((booking) => booking.status === "Pending").length
    },
    reports
  };
}

function parseCookies(req) {
  return String(req.headers.cookie || "").split(";").reduce((cookies, item) => {
    const index = item.indexOf("=");
    if (index > -1) cookies[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1));
    return cookies;
  }, {});
}

async function isAdmin(req) {
  const sid = parseCookies(req).agb_session;
  const session = sid ? sessions.get(sid) : null;
  if (!session) return false;
  if (Date.now() - session.createdAt > 1000 * 60 * 60 * 8) {
    sessions.delete(sid);
    return false;
  }
  const result = await pool.query("SELECT 1 FROM admin_users WHERE email = $1", [session.email]);
  if (!result.rowCount) {
    sessions.delete(sid);
    return false;
  }
  return true;
}

async function requireAdmin(req, res) {
  if (await isAdmin(req)) return true;
  sendJSON(res, 401, { error: "Administrator login required." });
  return false;
}

function getClientIP(req) {
  return req.socket.remoteAddress || "unknown";
}

function checkLoginRateLimit(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return { limited: false };
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    return { limited: true, retryAfterSeconds: Math.ceil((LOGIN_WINDOW_MS - (Date.now() - entry.windowStart)) / 1000) };
  }
  return { limited: false };
}

function recordLoginFailure(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: Date.now() });
  } else {
    entry.count += 1;
  }
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

function sendJSON(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(data));
}

function sendNoContent(res, headers = {}) {
  res.writeHead(204, headers);
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error("Request body too large."));
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function getRequiredString(body, key) {
  const value = String(body[key] || "").trim();
  if (!value) {
    const error = new Error(`${key} is required.`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

async function insertBookingWithPayment(client, booking, payment) {
  await client.query(`
    INSERT INTO bookings (
      ref, full_name, phone, email, event_type, event_date, venue, notes, package_id, status, amount_paid, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  `, [
    booking.ref,
    booking.fullName,
    booking.phone,
    booking.email,
    booking.eventType,
    booking.eventDate,
    booking.venue,
    booking.notes || "",
    booking.packageId,
    booking.status,
    Number(booking.amountPaid || 0),
    booking.createdAt || new Date().toISOString()
  ]);

  if (payment) {
    await client.query(`
      INSERT INTO payments (booking_ref, amount, method, note, receipt_id, recorded_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [booking.ref, payment.amount, payment.method, payment.note || "", payment.receiptId, payment.recordedAt]);
  }
}

async function handleAPI(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    return sendJSON(res, 200, { packages, galleryItems });
  }

  if (req.method === "GET" && url.pathname === "/api/availability") {
    return sendJSON(res, 200, await availabilityFor(url.searchParams.get("date")));
  }

  if (req.method === "POST" && url.pathname === "/api/bookings") {
    const body = await readBody(req);
    const packageItem = getPackage(getRequiredString(body, "packageId"));
    const eventDate = getRequiredString(body, "eventDate");
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const availability = await availabilityFor(eventDate, null, client);
      if (!availability.available) {
        await client.query("ROLLBACK");
        return sendJSON(res, 409, { error: availability.reason });
      }

      let ref = makeRef(eventDate);
      while ((await client.query("SELECT 1 FROM bookings WHERE ref = $1", [ref])).rowCount) ref = makeRef(eventDate);

      const amountPaid = body.paymentChoice === "full" ? packageItem.price : body.paymentChoice === "deposit" ? packageItem.deposit : 0;
      const now = new Date().toISOString();
      const booking = {
        ref,
        fullName: getRequiredString(body, "fullName"),
        phone: getRequiredString(body, "phone"),
        email: getRequiredString(body, "email"),
        eventType: getRequiredString(body, "eventType"),
        eventDate,
        venue: getRequiredString(body, "venue"),
        notes: String(body.notes || "").trim(),
        packageId: packageItem.id,
        status: "Pending",
        amountPaid,
        createdAt: now
      };
      const payment = amountPaid > 0 ? {
        amount: amountPaid,
        method: body.paymentChoice === "full" ? "Full payment" : "Deposit",
        note: "Simulated customer payment",
        receiptId: makeReceiptId(now),
        recordedAt: now
      } : null;

      await insertBookingWithPayment(client, booking, payment);
      await client.query("COMMIT");
      return sendJSON(res, 201, { booking: publicBooking(await getBookingByRef(ref)) });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error.code === "23505") return sendJSON(res, 409, { error: "Unavailable: that date already has an active booking." });
      throw error;
    } finally {
      client.release();
    }
  }

  if (req.method === "GET" && url.pathname === "/api/bookings/status") {
    const lookup = String(url.searchParams.get("lookup") || "").trim().toLowerCase();
    const matches = await listBookings("WHERE lower(b.ref) = $1 OR lower(b.email) = $1", [lookup]);
    return sendJSON(res, 200, { matches: matches.map(publicBooking) });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const ip = getClientIP(req);
    const limit = checkLoginRateLimit(ip);
    if (limit.limited) {
      return sendJSON(res, 429, { error: `Too many login attempts. Try again in ${limit.retryAfterSeconds} seconds.` }, { "Retry-After": String(limit.retryAfterSeconds) });
    }

    const body = await readBody(req);
    const result = await pool.query("SELECT email, password_hash, password_salt FROM admin_users WHERE email = $1", [String(body.email || "")]);
    const user = result.rows[0];
    if (!user || !passwordMatches(body.password || "", user.password_hash, user.password_salt)) {
      recordLoginFailure(ip);
      return sendJSON(res, 401, { error: "Incorrect email or password." });
    }
    clearLoginAttempts(ip);
    const sid = crypto.randomBytes(24).toString("hex");
    sessions.set(sid, { email: user.email, createdAt: Date.now() });
    return sendJSON(res, 200, { authenticated: true }, { "Set-Cookie": `agb_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800` });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/logout") {
    const sid = parseCookies(req).agb_session;
    if (sid) sessions.delete(sid);
    return sendNoContent(res, { "Set-Cookie": "agb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/session") {
    return sendJSON(res, 200, { authenticated: await isAdmin(req) });
  }

  if (url.pathname.startsWith("/api/admin/")) {
    if (!(await requireAdmin(req, res))) return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/dashboard") {
    return sendJSON(res, 200, await adminPayload());
  }

  const bookingMatch = url.pathname.match(/^\/api\/admin\/bookings\/([^/]+)$/);
  if (bookingMatch && req.method === "PATCH") {
    const ref = decodeURIComponent(bookingMatch[1]);
    const body = await readBody(req);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const current = await client.query("SELECT ref, event_date FROM bookings WHERE ref = $1", [ref]);
      if (!current.rowCount) {
        await client.query("ROLLBACK");
        return sendJSON(res, 404, { error: "Booking not found." });
      }

      if (body.action === "approve") {
        const availability = await availabilityFor(current.rows[0].event_date, ref, client);
        if (!availability.available) {
          await client.query("ROLLBACK");
          return sendJSON(res, 409, { error: availability.reason });
        }
        await client.query("UPDATE bookings SET status = 'Confirmed' WHERE ref = $1", [ref]);
      } else if (body.action === "complete") {
        await client.query("UPDATE bookings SET status = 'Completed' WHERE ref = $1", [ref]);
      } else if (body.action === "cancel" || body.action === "reject") {
        await client.query("UPDATE bookings SET status = 'Cancelled' WHERE ref = $1", [ref]);
      } else {
        const eventDate = getRequiredString(body, "eventDate");
        const availability = await availabilityFor(eventDate, ref, client);
        if (!availability.available) {
          await client.query("ROLLBACK");
          return sendJSON(res, 409, { error: availability.reason });
        }
        await client.query(`
          UPDATE bookings
          SET full_name = $2, phone = $3, email = $4, event_date = $5, event_type = $6, venue = $7, notes = $8
          WHERE ref = $1
        `, [
          ref,
          getRequiredString(body, "fullName"),
          getRequiredString(body, "phone"),
          getRequiredString(body, "email"),
          eventDate,
          getRequiredString(body, "eventType"),
          getRequiredString(body, "venue"),
          String(body.notes || "").trim()
        ]);
      }

      await client.query("COMMIT");
      return sendJSON(res, 200, await adminPayload());
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error.code === "23505") return sendJSON(res, 409, { error: "Unavailable: that date already has an active booking." });
      throw error;
    } finally {
      client.release();
    }
  }

  if (req.method === "POST" && url.pathname === "/api/admin/blocked-dates") {
    const body = await readBody(req);
    const date = getRequiredString(body, "date");
    const active = await findActiveBookingOnDate(date);
    if (active) return sendJSON(res, 409, { error: `Cannot block ${date}; booking ${active.ref} is active on that date.` });

    await pool.query(`
      INSERT INTO blocked_dates (unavailable_date, reason)
      VALUES ($1, $2)
      ON CONFLICT (unavailable_date) DO UPDATE SET reason = EXCLUDED.reason
    `, [date, String(body.reason || "Unavailable").trim() || "Unavailable"]);
    return sendJSON(res, 200, await adminPayload());
  }

  const blockMatch = url.pathname.match(/^\/api\/admin\/blocked-dates\/([^/]+)$/);
  if (blockMatch && req.method === "DELETE") {
    const date = decodeURIComponent(blockMatch[1]);
    await pool.query("DELETE FROM blocked_dates WHERE unavailable_date = $1", [date]);
    return sendJSON(res, 200, await adminPayload());
  }

  if (req.method === "POST" && url.pathname === "/api/admin/payments") {
    const body = await readBody(req);
    const amount = Number(body.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) return sendJSON(res, 400, { error: "Amount must be greater than 0." });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const exists = await client.query("SELECT ref FROM bookings WHERE ref = $1", [body.ref]);
      if (!exists.rowCount) {
        await client.query("ROLLBACK");
        return sendJSON(res, 404, { error: "Booking not found." });
      }
      const now = new Date().toISOString();
      await client.query(`
        INSERT INTO payments (booking_ref, amount, method, note, receipt_id, recorded_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [body.ref, amount, String(body.method || "Cash"), String(body.note || "").trim(), makeReceiptId(now), now]);
      await client.query(`
        UPDATE bookings
        SET amount_paid = COALESCE((SELECT SUM(amount) FROM payments WHERE booking_ref = $1), 0)
        WHERE ref = $1
      `, [body.ref]);
      await client.query("COMMIT");
      return sendJSON(res, 200, await adminPayload());
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  if (req.method === "POST" && url.pathname === "/api/admin/recordings") {
    const body = await readBody(req);
    const exists = await pool.query("SELECT ref FROM bookings WHERE ref = $1", [body.ref]);
    if (!exists.rowCount) return sendJSON(res, 404, { error: "Booking not found." });

    await pool.query(`
      INSERT INTO recordings (booking_ref, file_name, note, uploaded_at)
      VALUES ($1, $2, $3, now())
    `, [body.ref, String(body.fileName || `recording-${body.ref}.mp3`).trim(), String(body.note || "").trim()]);
    return sendJSON(res, 200, await adminPayload());
  }

  if (req.method === "POST" && url.pathname === "/api/admin/seed") {
    const client = await pool.connect();
    const now = new Date().toISOString();
    const samples = [
      {
        ref: makeRef("2026-08-24"), fullName: "Maya Collins", phone: "555-0138", email: "maya@example.com", eventType: "Wedding", eventDate: "2026-08-24", venue: "Oak Hall", notes: "Ivory and deep green styling.", packageId: "signature", status: "Confirmed", amountPaid: 120, createdAt: now,
        payment: { amount: 120, method: "Deposit", note: "Sample", receiptId: makeReceiptId(now), recordedAt: now }
      },
      {
        ref: makeRef("2026-10-03"), fullName: "Andre Stone", phone: "555-0171", email: "andre@example.com", eventType: "Corporate event", eventDate: "2026-10-03", venue: "Foundry Studio", notes: "Brand launch reception.", packageId: "classic", status: "Pending", amountPaid: 0, createdAt: now,
        payment: null
      }
    ];

    try {
      await client.query("BEGIN");
      for (const sample of samples) {
        const availability = await availabilityFor(sample.eventDate, null, client);
        if (availability.available) await insertBookingWithPayment(client, sample, sample.payment);
      }
      await client.query("COMMIT");
      return sendJSON(res, 200, await adminPayload());
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error.code === "23505") return sendJSON(res, 409, { error: "One of the sample dates is already active." });
      throw error;
    } finally {
      client.release();
    }
  }

  sendJSON(res, 404, { error: "API route not found." });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8"
  }[ext] || "application/octet-stream";
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.join(ROOT, pathname);
  const relative = path.relative(ROOT, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleAPI(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendJSON(res, error.statusCode || 500, { error: error.message || "Unexpected server error." });
  }
});

initDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Audio Guestbook app running at http://localhost:${PORT}`);
    console.log(`PostgreSQL connection: ${DATABASE_URL.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@")}`);
  });
}).catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
