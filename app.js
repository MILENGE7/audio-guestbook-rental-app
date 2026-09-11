(function () {
  "use strict";

  let state = {
    packages: [],
    galleryItems: []
  };

  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => Array.from(parent.querySelectorAll(selector));

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    setDateMinimums();
    bindNavigation();
    bindCustomerFlows();
    await loadBootstrap();
    hydratePackageSelect();
    renderPackages();
    renderGallery();
    updateBookingSummary();
    routeFromHash();
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

  async function loadBootstrap() {
    const data = await api("/api/bootstrap");
    state.packages = data.packages || [];
    state.galleryItems = data.galleryItems || [];
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

  function renderPackages() {
    const grid = $("#packages-grid");
    const template = $("#package-template");
    grid.innerHTML = "";

    state.packages.forEach((item) => {
      const node = template.content.firstElementChild.cloneNode(true);
      node.querySelector(".package-top").insertAdjacentHTML("beforebegin", `<img src="assets/package-${item.id}.jpg" alt="${item.name}" class="package-photo">`);
      $("h3", node).textContent = item.name;
      $(".price", node).textContent = formatMoney(item.price);
      $(".description", node).textContent = item.description;
      $(".includes", node).innerHTML = item.includes.map((entry) => `<li>${escapeHTML(entry)}</li>`).join("");
      $(".tag-row", node).innerHTML = item.events.map((entry) => `<span class="tag">${escapeHTML(entry)}</span>`).join("");
      $(".choose-package", node).addEventListener("click", () => {
        $("#package-select").value = item.id;
        showView("booking");
        updateBookingSummary();
        $("#booking-form [name='fullName']").focus();
      });
      grid.appendChild(node);
    });
  }

  function renderGallery() {
    $("#gallery-grid").innerHTML = state.galleryItems.map((item) => `
      <figure class="gallery-card">
        <img src="assets/${escapeHTML(item.image)}" alt="${escapeHTML(item.title)} audio guestbook setup">
        <figcaption><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.text)}</p></figcaption>
      </figure>
    `).join("");
  }

  function hydratePackageSelect() {
    $("#package-select").innerHTML = state.packages.map((item) => {
      return `<option value="${item.id}">${escapeHTML(item.name)} - ${formatMoney(item.price)}</option>`;
    }).join("");
  }

  function bindNavigation() {
    $$(".site-nav a, [data-view-link]").forEach((link) => {
      link.addEventListener("click", (event) => {
        const view = link.dataset.viewLink;
        if (!view) return;
        event.preventDefault();
        showView(view);
      });
    });

    $(".nav-toggle").addEventListener("click", () => {
      const nav = $("#site-nav");
      const isOpen = nav.classList.toggle("open");
      $(".nav-toggle").setAttribute("aria-expanded", String(isOpen));
    });

    window.addEventListener("hashchange", routeFromHash);
  }

  function routeFromHash() {
    const view = (location.hash || "#home").slice(1);
    if (["home", "gallery", "booking", "status"].includes(view)) showView(view, false);
  }

  function showView(view, pushHash = true) {
    $$(".view").forEach((section) => section.classList.toggle("active", section.id === view));
    $$(".site-nav a").forEach((link) => link.classList.toggle("active", link.dataset.viewLink === view));
    $("#site-nav").classList.remove("open");
    $(".nav-toggle").setAttribute("aria-expanded", "false");
    if (pushHash && location.hash !== `#${view}`) history.pushState(null, "", `#${view}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function bindCustomerFlows() {
    $("#home-availability-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      await renderAvailabilityResult(new FormData(event.currentTarget).get("date"));
    });

    $("#booking-form").addEventListener("input", updateBookingSummary);
    $("#booking-form").addEventListener("change", updateBookingSummary);
    $("#booking-form").addEventListener("submit", createBooking);

    $("#status-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const lookup = new FormData(event.currentTarget).get("lookup").trim();
      try {
        const data = await api(`/api/bookings/status?lookup=${encodeURIComponent(lookup)}`);
        renderStatusResult(data.matches || []);
      } catch (error) {
        renderInlineError($("#status-result"), error.message);
      }
    });
  }

  async function renderAvailabilityResult(date) {
    const box = $("#home-availability-result");
    box.className = "status-card neutral";
    box.textContent = "Checking availability...";

    try {
      const result = await api(`/api/availability?date=${encodeURIComponent(date)}`);
      box.className = `status-card ${result.available ? "available" : "unavailable"}`;
      box.textContent = date ? `${formatDate(date)}: ${result.reason}` : result.reason;
    } catch (error) {
      box.className = "status-card unavailable";
      box.textContent = error.message;
    }
  }

  function updateBookingSummary() {
    const form = $("#booking-form");
    const data = new FormData(form);
    const packageItem = getPackage(data.get("packageId"));
    const choice = data.get("paymentChoice") || "deposit";
    const dueToday = choice === "full" ? packageItem.price : choice === "deposit" ? packageItem.deposit : 0;
    const date = data.get("eventDate");
    const availabilityText = date ? "Date will be checked by the server before booking." : "Select a date to check availability.";

    $("#booking-summary").innerHTML = `
      <dl class="summary-list">
        <div><dt>Package</dt><dd>${escapeHTML(packageItem.name)}</dd></div>
        <div><dt>Total</dt><dd>${formatMoney(packageItem.price)}</dd></div>
        <div><dt>Due today</dt><dd>${formatMoney(dueToday)}</dd></div>
        <div><dt>Date</dt><dd>${date ? formatDate(date) : "Not selected"}</dd></div>
        <div><dt>Availability</dt><dd>${escapeHTML(availabilityText)}</dd></div>
      </dl>
    `;
  }

  async function createBooking(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const message = $("#booking-message");

    try {
      const result = await api("/api/bookings", { method: "POST", body: JSON.stringify(data) });
      const booking = result.booking;
      form.reset();
      hydratePackageSelect();
      updateBookingSummary();
      showMessage(message, `Booking ${booking.ref} received. Confirmation is shown here and the email/WhatsApp notice is simulated for the MVP.`, "success");
    } catch (error) {
      showMessage(message, error.message, "error");
    }
  }

  function showMessage(target, text, type) {
    target.className = `message ${type === "error" ? "error" : type === "warning" ? "warning" : ""}`;
    target.textContent = text;
  }

  function renderStatusResult(matches) {
    const result = $("#status-result");
    if (!matches.length) {
      result.innerHTML = `<h3>Status result</h3><p class="empty-state">No booking found for that reference or email.</p>`;
      return;
    }

    result.innerHTML = matches.map((booking) => {
      const packageItem = getPackage(booking.packageId);
      const recordings = booking.recordings || [];
      const recordingMarkup = recordings.length
        ? recordings.map((item) => `<li>${escapeHTML(item.fileName)} - ${escapeHTML(item.note || "Ready to share")}</li>`).join("")
        : "<li>Audio access opens after event completion.</li>";

      return `
        <article class="status-card neutral">
          <div>
            <h3>${escapeHTML(booking.ref)}</h3>
            <dl class="facts-list">
              <div><dt>Status</dt><dd><span class="badge ${booking.status.toLowerCase()}">${booking.status}</span></dd></div>
              <div><dt>Event</dt><dd>${escapeHTML(booking.eventType)} on ${formatDate(booking.eventDate)}</dd></div>
              <div><dt>Package</dt><dd>${escapeHTML(packageItem.name)}</dd></div>
              <div><dt>Payment</dt><dd><span class="badge ${booking.paymentStatus.toLowerCase()}">${booking.paymentStatus}</span> ${formatMoney(booking.amountPaid)} / ${formatMoney(booking.total)}</dd></div>
            </dl>
            <h3 class="recording-heading">Recordings</h3>
            <ul>${recordingMarkup}</ul>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderInlineError(target, message) {
    target.innerHTML = `<h3>Status result</h3><p class="empty-state">${escapeHTML(message)}</p>`;
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
