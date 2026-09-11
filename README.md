# Audio Guestbook Rental Web Application

This is a PostgreSQL-backed MVP for the Audio Guestbook Rental SRS.

## Requirements

- Node.js
- PostgreSQL, or Docker Desktop for the included Postgres container

## Setup

```powershell
cd "D:\AUDIO GUESTBOOK"
npm install
```

If you have Docker Desktop, start the included Postgres service:

```powershell
npm run db:up
```

If you are using your own Postgres server, create a database named `audio_guestbook`, then copy `.env.example` to `.env` and adjust `DATABASE_URL`:

```powershell
copy .env.example .env
```

Default local connection string:

```text
postgres://postgres:postgres@localhost:5432/audio_guestbook
```

Initialize the database schema:

```powershell
npm run db:migrate
```

## Run

```powershell
npm start
```

Then open:

`http://localhost:3000`

## Admin Access

The admin dashboard is a separate, unlinked page (not reachable from the public site nav or search engines). Create your own admin login with:

```powershell
npm run admin:set -- youremail@example.com
```

This prompts for a password (input is hidden) and stores it, replacing any previous admin account. Keep the admin page's URL private — treat it like a credential, not a public link.

## Storage

The app uses PostgreSQL tables for bookings, blocked dates, payments, recordings, and admin users. The schema lives at:

`D:\AUDIO GUESTBOOK\db\schema.sql`

The old JSON file storage is no longer used by the application.

Payments, email, WhatsApp, and actual audio delivery are simulated for the MVP. The app includes backend APIs, session-based admin login, database-level active-date double-booking prevention, generated booking references, and receipt records.
