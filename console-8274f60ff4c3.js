(function () {
  "use strict";

  let state = {
    packages: [],
    bookings: [],
    blockedDates: [],
    payments: [],
    recordings: [],
    metrics: null,
    reports: null,
    admin: false
  };

  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => Array.from(parent.querySelectorAll(selector));

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    setDateMinimums();
    bindAdminFlows();
    await refreshAdmin();
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });

    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  function formatMoney(value) {
    return new Intl.NumberFormat("en-RW", {
      style: "currency",
      currency: "RWF",
      currencyDisplay: "code",
      maximumFractionDigits: 0
    }).format(value || 0);
  }

  function formatDate(value) {
    if (!value) return "Not set";
    const source = String(value).slice(0, 10);
    const [year, month, day] = source.split("-").map(Number);
    return new Intl.DateTimeFormat("en-RW", {
      month: "short",
      day: "numeric",
      year: "numeric"
    }).format(new Date(year, month - 1, day));
  }

  function todayISO() {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    return new Date(now.getTime() - offset * 60000).toISOString().slice(0, 10);
  }

  function setDateMinimums() {
    const today = todayISO();
    $$("input[type='date']").forEach((input) => {
      input.min = today;
    });
  }

  function getPackage(id) {
    return state.packages.find((item) => item.id === id) || state.packages[0] || { id: "", name: "Package", price: 0, deposit: 0, includes: [], events: [] };
  }

  function paymentStatus(amountPaid, total) {
    if (Number(amountPaid || 0) >= total) return "Paid";
    if (Number(amountPaid || 0) > 0) return "Partial";
    return "Pending";
  }

  function showMessage(target, text, type) {
    target.className = `message ${type === "error" ? "error" : type === "warning" ? "warning" : ""}`;
    target.textContent = text;
  }

  function bindAdminFlows() {
    $("#admin-login-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget).entries());
      const message = $("#admin-login-message");
      try {
        await api("/api/admin/login", { method: "POST", body: JSON.stringify(data) });
        message.classList.add("hidden");
        await refreshAdmin();
      } catch (error) {
        showMessage(message, error.message, "error");
      }
    });

    $("#admin-logout").addEventListener("click", async () => {
      await api("/api/admin/logout", { method: "POST" });
      state.admin = false;
      renderAdminAuth();
    });

    $$(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = tab.dataset.adminTab;
        $$(".tab").forEach((item) => {
          const active = item === tab;
          item.classList.toggle("active", active);
          item.setAttribute("aria-selected", String(active));
        });
        $$(".admin-section").forEach((section) => section.classList.toggle("active", section.id === `admin-tab-${target}`));
      });
    });

    $("#seed-demo").addEventListener("click", () => {
      if (!state.bookings.length) return seedDemoBookings();
      $("#seed-confirm").classList.remove("hidden");
    });
    $("#seed-confirm-yes").addEventListener("click", () => {
      $("#seed-confirm").classList.add("hidden");
      seedDemoBookings();
    });
    $("#seed-confirm-no").addEventListener("click", () => {
      $("#seed-confirm").classList.add("hidden");
    });
    $("#admin-edit-form").addEventListener("submit", saveBookingEdits);
    $("#cancel-edit").addEventListener("click", () => $("#admin-edit-form").classList.add("hidden"));
    $("#block-date-form").addEventListener("submit", blockDate);
    $("#payment-form").addEventListener("submit", recordPayment);
    $("#recording-form").addEventListener("submit", recordAudio);
  }

  function showAdminNotice(message, type = "error") {
    const el = $("#admin-notice");
    el.className = `message ${type === "error" ? "error" : type === "warning" ? "warning" : ""}`;
    el.textContent = message;
    el.classList.remove("hidden");
  }

  function hideAdminNotice() {
    $("#admin-notice").classList.add("hidden");
  }

  async function refreshAdmin() {
    try {
      const session = await api("/api/admin/session");
      state.admin = Boolean(session.authenticated);
      renderAdminAuth();
      if (!state.admin) return;
      const data = await api("/api/admin/dashboard");
      applyAdminPayload(data);
      renderAdminDashboard();
    } catch (error) {
      state.admin = false;
      renderAdminAuth();
    }
  }

  function applyAdminPayload(data) {
    state.packages = data.packages || state.packages;
    state.bookings = data.bookings || [];
    state.blockedDates = data.blockedDates || [];
    state.payments = data.payments || [];
    state.recordings = data.recordings || [];
    state.metrics = data.metrics || null;
    state.reports = data.reports || null;
  }

  function renderAdminAuth() {
    $("#admin-login-panel").classList.toggle("hidden", state.admin);
    $("#admin-dashboard").classList.toggle("hidden", !state.admin);
  }

  function renderAdminDashboard() {
    renderMetrics();
    renderBookingTable();
    renderBlockedDates();
    renderBookingSelects();
    renderPaymentLog();
    renderRecordingList();
    renderReports();
  }

  function renderMetrics() {
    const metrics = state.metrics || { bookings: 0, upcoming: 0, revenue: 0, pending: 0 };
    $("#admin-metrics").innerHTML = [
      ["Bookings", metrics.bookings],
      ["Upcoming", metrics.upcoming],
      ["Revenue", formatMoney(metrics.revenue)],
      ["Pending", metrics.pending]
    ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
  }

  function renderBookingTable() {
    const target = $("#booking-table");
    if (!state.bookings.length) {
      target.innerHTML = `<p class="empty-state">No bookings yet. Load sample bookings or submit a customer booking.</p>`;
      return;
    }

    target.innerHTML = `
      <table>
        <thead><tr><th>Reference</th><th>Customer</th><th>Event</th><th>Package</th><th>Status</th><th>Payment</th><th>Actions</th></tr></thead>
        <tbody>${state.bookings.map(renderBookingRow).join("")}</tbody>
      </table>
    `;

    $$(".booking-action", target).forEach((button) => {
      button.addEventListener("click", () => handleBookingAction(button.dataset.ref, button.dataset.action));
    });
  }

  function renderBookingRow(booking) {
    const packageItem = getPackage(booking.packageId);
    const total = packageItem.price;
    const paidStatus = paymentStatus(booking.amountPaid, total);
    return `
      <tr>
        <td><strong>${escapeHTML(booking.ref)}</strong><br><span>${formatDate(booking.createdAt)}</span></td>
        <td>${escapeHTML(booking.fullName)}<br><span>${escapeHTML(booking.email)}</span></td>
        <td>${escapeHTML(booking.eventType)}<br><span>${formatDate(booking.eventDate)}</span></td>
        <td>${escapeHTML(packageItem.name)}</td>
        <td><span class="badge ${booking.status.toLowerCase()}">${booking.status}</span></td>
        <td><span class="badge ${paidStatus.toLowerCase()}">${paidStatus}</span><br><span>${formatMoney(booking.amountPaid)} / ${formatMoney(total)}</span></td>
        <td><div class="row-actions">
          <button class="mini-button booking-action" type="button" data-action="approve" data-ref="${booking.ref}">Approve</button>
          <button class="mini-button booking-action" type="button" data-action="edit" data-ref="${booking.ref}">Edit</button>
          <button class="mini-button booking-action" type="button" data-action="complete" data-ref="${booking.ref}">Complete</button>
          <button class="mini-button danger booking-action" type="button" data-action="reject" data-ref="${booking.ref}">Reject</button>
          <button class="mini-button danger booking-action" type="button" data-action="cancel" data-ref="${booking.ref}">Cancel</button>
        </div></td>
      </tr>
    `;
  }

  async function handleBookingAction(ref, action) {
    const booking = state.bookings.find((item) => item.ref === ref);
    if (!booking) return;

    if (action === "edit") {
      openEditForm(booking);
      return;
    }

    try {
      const data = await api(`/api/admin/bookings/${encodeURIComponent(ref)}`, { method: "PATCH", body: JSON.stringify({ action }) });
      hideAdminNotice();
      applyAdminPayload(data);
      renderAdminDashboard();
    } catch (error) {
      showAdminNotice(error.message);
    }
  }

  function openEditForm(booking) {
    const form = $("#admin-edit-form");
    form.classList.remove("hidden");
    form.elements.ref.value = booking.ref;
    form.elements.fullName.value = booking.fullName;
    form.elements.phone.value = booking.phone;
    form.elements.email.value = booking.email;
    form.elements.eventDate.value = booking.eventDate;
    form.elements.eventType.value = booking.eventType;
    form.elements.venue.value = booking.venue;
    form.elements.notes.value = booking.notes || "";
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function saveBookingEdits(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const ref = data.ref;

    try {
      const payload = await api(`/api/admin/bookings/${encodeURIComponent(ref)}`, { method: "PATCH", body: JSON.stringify(data) });
      hideAdminNotice();
      applyAdminPayload(payload);
      form.classList.add("hidden");
      renderAdminDashboard();
    } catch (error) {
      showAdminNotice(error.message);
    }
  }

  async function blockDate(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const payload = await api("/api/admin/blocked-dates", { method: "POST", body: JSON.stringify(data) });
      hideAdminNotice();
      applyAdminPayload(payload);
      renderAdminDashboard();
      form.reset();
    } catch (error) {
      showAdminNotice(error.message);
    }
  }

  function renderBlockedDates() {
    const target = $("#blocked-list");
    if (!state.blockedDates.length) {
      target.innerHTML = `<p class="empty-state">No blocked dates.</p>`;
      return;
    }

    target.innerHTML = state.blockedDates.map((item) => `
      <div class="list-item">
        <div><strong>${formatDate(item.date)}</strong><span>${escapeHTML(item.reason || "Unavailable")}</span></div>
        <button class="mini-button" type="button" data-unblock="${item.date}">Unblock</button>
      </div>
    `).join("");

    $$(`[data-unblock]`, target).forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          const payload = await api(`/api/admin/blocked-dates/${encodeURIComponent(button.dataset.unblock)}`, { method: "DELETE" });
          hideAdminNotice();
          applyAdminPayload(payload);
          renderAdminDashboard();
        } catch (error) {
          showAdminNotice(error.message);
        }
      });
    });
  }

  function renderBookingSelects() {
    const options = state.bookings.length
      ? state.bookings.map((booking) => `<option value="${booking.ref}">${booking.ref} - ${escapeHTML(booking.fullName)}</option>`).join("")
      : "<option value=''>No bookings available</option>";
    $("#payment-booking-select").innerHTML = options;
    $("#recording-booking-select").innerHTML = options;
  }

  async function recordPayment(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const payload = await api("/api/admin/payments", { method: "POST", body: JSON.stringify(data) });
      hideAdminNotice();
      applyAdminPayload(payload);
      renderAdminDashboard();
      form.reset();
    } catch (error) {
      showAdminNotice(error.message);
    }
  }

  function renderPaymentLog() {
    const target = $("#payment-log");
    if (!state.payments.length) {
      target.innerHTML = `<h3>Receipts</h3><p class="empty-state">No payments recorded yet.</p>`;
      return;
    }

    target.innerHTML = `<h3>Receipts</h3>${state.payments.map((payment) => `
      <div class="receipt"><dl class="receipt-list">
        <div><dt>Receipt</dt><dd>${escapeHTML(payment.receiptId || "Receipt")}</dd></div>
        <div><dt>Booking</dt><dd>${escapeHTML(payment.ref)}</dd></div>
        <div><dt>Amount</dt><dd>${formatMoney(payment.amount)}</dd></div>
        <div><dt>Method</dt><dd>${escapeHTML(payment.method)}</dd></div>
        <div><dt>Date</dt><dd>${formatDate(payment.recordedAt)}</dd></div>
      </dl></div>
    `).join("")}`;
  }

  async function recordAudio(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    const payload = {
      ref: data.get("ref"),
      fileName: file && file.name ? file.name : "",
      note: data.get("note")
    };

    try {
      const result = await api("/api/admin/recordings", { method: "POST", body: JSON.stringify(payload) });
      hideAdminNotice();
      applyAdminPayload(result);
      renderAdminDashboard();
      form.reset();
    } catch (error) {
      showAdminNotice(error.message);
    }
  }

  function renderRecordingList() {
    const target = $("#recording-list");
    if (!state.recordings.length) {
      target.innerHTML = `<h3>Recording library</h3><p class="empty-state">No recordings attached yet.</p>`;
      return;
    }

    target.innerHTML = `
      <h3>Recording library</h3>
      <div class="list-stack">${state.recordings.map((recording) => `
        <div class="list-item">
          <div><strong>${escapeHTML(recording.fileName)}</strong><span>${escapeHTML(recording.ref)} - ${escapeHTML(recording.note || "No note")}</span></div>
          <span>${formatDate(recording.uploadedAt)}</span>
        </div>
      `).join("")}</div>
    `;
  }

  function renderReports() {
    const reports = state.reports || { revenue: 0, upcoming: [], completed: 0, popular: [] };
    $("#reports-panel").innerHTML = `
      <div class="metric"><span>Total revenue</span><strong>${formatMoney(reports.revenue)}</strong></div>
      <div class="metric"><span>Upcoming events</span><strong>${reports.upcoming.length}</strong></div>
      <div class="metric"><span>Completed</span><strong>${reports.completed}</strong></div>
      <div class="metric"><span>Top event type</span><strong>${escapeHTML(reports.popular[0]?.label || "None")}</strong></div>
      <div class="panel report-card"><h3>Upcoming schedule</h3>${reports.upcoming.length ? `<div class="list-stack">${reports.upcoming.slice(0, 6).map((booking) => `
        <div class="list-item"><div><strong>${formatDate(booking.eventDate)}</strong><span>${escapeHTML(booking.ref)} - ${escapeHTML(booking.fullName)}</span></div><span>${booking.status}</span></div>
      `).join("")}</div>` : `<p class="empty-state">No upcoming bookings.</p>`}</div>
      <div class="panel report-card"><h3>Popular event types</h3>${reports.popular.length ? `<div class="list-stack">${reports.popular.map((item) => `
        <div class="list-item"><strong>${escapeHTML(item.label)}</strong><span>${item.count} booking${item.count === 1 ? "" : "s"}</span></div>
      `).join("")}</div>` : `<p class="empty-state">No event type data yet.</p>`}</div>
    `;
  }

  async function seedDemoBookings() {
    try {
      const payload = await api("/api/admin/seed", { method: "POST" });
      hideAdminNotice();
      applyAdminPayload(payload);
      renderAdminDashboard();
    } catch (error) {
      showAdminNotice(error.message);
    }
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();
