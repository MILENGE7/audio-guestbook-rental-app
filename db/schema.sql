CREATE TABLE IF NOT EXISTS admin_users (
  email TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bookings (
  ref TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_date DATE NOT NULL,
  venue TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  package_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Pending', 'Confirmed', 'Cancelled', 'Completed')),
  amount_paid NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_active_event_date
  ON bookings (event_date)
  WHERE status IN ('Pending', 'Confirmed');

CREATE INDEX IF NOT EXISTS bookings_email_idx ON bookings (lower(email));
CREATE INDEX IF NOT EXISTS bookings_event_date_idx ON bookings (event_date);
CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings (status);

CREATE TABLE IF NOT EXISTS blocked_dates (
  unavailable_date DATE PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'Unavailable',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  booking_ref TEXT NOT NULL REFERENCES bookings(ref) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  receipt_id TEXT NOT NULL UNIQUE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_booking_ref_idx ON payments (booking_ref);
CREATE INDEX IF NOT EXISTS payments_recorded_at_idx ON payments (recorded_at DESC);

CREATE TABLE IF NOT EXISTS recordings (
  id BIGSERIAL PRIMARY KEY,
  booking_ref TEXT NOT NULL REFERENCES bookings(ref) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recordings_booking_ref_idx ON recordings (booking_ref);
CREATE INDEX IF NOT EXISTS recordings_uploaded_at_idx ON recordings (uploaded_at DESC);

INSERT INTO blocked_dates (unavailable_date, reason)
VALUES
  ('2026-08-16', 'Private event'),
  ('2026-09-05', 'Maintenance')
ON CONFLICT (unavailable_date) DO NOTHING;
