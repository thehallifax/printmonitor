import { failureLabel, groupPrinters, prioritizedHealthStates } from "./view-model.js";

const summaryKeys = ["total", "reachable", "offline", "critical", "warning", "lowConsumables"];
const template = document.querySelector("#printer-card-template");
const statusSections = {
  offline: { section: document.querySelector("#offline-section"), grid: document.querySelector("#offline-grid") },
  critical: { section: document.querySelector("#critical-section"), grid: document.querySelector("#critical-grid") },
  warning: { section: document.querySelector("#warning-section"), grid: document.querySelector("#warning-grid") }
};
const fleetGrid = document.querySelector("#fleet-grid");
const emptyState = document.querySelector("#empty-state");
const errorState = document.querySelector("#error-state");
const syncState = document.querySelector("#sync-state");

function relativeTime(value) {
  if (!value) return "Never seen";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (Math.abs(seconds) < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return `${Math.abs(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${Math.abs(hours)} hr ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function cardFor(printer) {
  const card = template.content.firstElementChild.cloneNode(true);
  const health = printer.normalizedHealth;
  card.dataset.health = health;
  if (printer.reachability.failureKind) card.dataset.failure = printer.reachability.failureKind;
  card.querySelector(".location").textContent = printer.identity.location || "Unassigned location";
  card.querySelector("h3").textContent = printer.identity.displayName;
  card.querySelector(".hostname").textContent = printer.identity.hostname;
  card.querySelector(".status-pill").textContent = health === "offline" ? failureLabel(printer.reachability.failureKind) : health;
  card.querySelector(".device").textContent = [printer.identity.manufacturer, printer.identity.model].filter(Boolean).join(" · ") || "Unknown device";
  card.querySelector(".ip").textContent = printer.identity.resolvedIp || "Not resolved";

  const alerts = card.querySelector(".alerts");
  const messages = printer.alerts.map((alert) => alert.message);
  if (!printer.reachability.reachable && printer.reachability.failureReason) messages.unshift(`Current failure: ${printer.reachability.failureReason}`);
  if (messages.length) {
    alerts.hidden = false;
    messages.slice(0, 3).forEach((message) => { const p = document.createElement("p"); p.textContent = message; alerts.append(p); });
  }

  const knownSupplies = printer.consumables.filter((item) => item.levelPercent != null);
  if (knownSupplies.length) {
    const supplies = card.querySelector(".supplies");
    supplies.hidden = false;
    const list = supplies.querySelector(".supply-list");
    knownSupplies.slice(0, 6).forEach((supply) => {
      const row = document.createElement("div");
      row.className = `supply-row ${supply.levelPercent <= 5 ? "critical" : supply.levelPercent <= 20 ? "low" : ""}`;
      const name = document.createElement("span"); name.className = "supply-name"; name.textContent = supply.colour || supply.description;
      const track = document.createElement("span"); track.className = "supply-track";
      const bar = document.createElement("span"); bar.className = "supply-bar"; bar.style.width = `${supply.levelPercent}%`;
      track.append(bar);
      const level = document.createElement("span"); level.className = "supply-level"; level.textContent = `${supply.levelPercent}%`;
      row.append(name, track, level); list.append(row);
    });
  }

  card.querySelector(".reachability").textContent = printer.reachability.reachable ? `Reachable${printer.reachability.latencyMs != null ? ` · ${printer.reachability.latencyMs} ms` : ""}` : `Offline · polled ${relativeTime(printer.reachability.lastAttempt)}`;
  const time = card.querySelector("time");
  const timestamp = printer.reachability.lastSeen;
  time.dateTime = timestamp || printer.collectedAt;
  time.textContent = `Last seen ${relativeTime(timestamp)}`;
  return card;
}

function render(data) {
  document.querySelectorAll("#summary-grid strong").forEach((element, index) => { element.textContent = String(data.summary[summaryKeys[index]] ?? 0); });
  Object.values(statusSections).forEach(({ grid }) => grid.replaceChildren());
  fleetGrid.replaceChildren();
  const grouped = groupPrinters(data.printers);
  for (const health of prioritizedHealthStates) {
    const printers = grouped[health];
    printers.forEach((printer) => statusSections[health].grid.append(cardFor(printer)));
    statusSections[health].section.hidden = printers.length === 0;
  }
  grouped.fleet.forEach((printer) => fleetGrid.append(cardFor(printer)));
  emptyState.hidden = data.printers.length !== 0;
}

async function loadFleet() {
  try {
    const response = await fetch("/api/fleet", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
    errorState.hidden = true;
    syncState.classList.remove("error");
    syncState.querySelector("span:last-child").textContent = `Stored state updated ${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date())}`;
  } catch (_error) {
    errorState.hidden = false;
    syncState.classList.add("error");
    syncState.querySelector("span:last-child").textContent = "API unavailable";
  }
}

document.querySelector("#retry-button").addEventListener("click", loadFleet);
loadFleet();
setInterval(loadFleet, 60_000);
