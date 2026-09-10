import { compactAlerts, failureLabel, filterFleet, groupPrinters, loadViewMode, maintenanceSummary, persistViewMode, tonerChannels } from "./view-model.js";

const summaryKeys = ["total", "reachable", "offline", "critical", "warning", "pending", "healthy", "lowConsumables", "stale"];
const template = document.querySelector("#printer-card-template");
const compactTemplate = document.querySelector("#compact-card-template");
const statusSections = {
  offline: { section: document.querySelector("#offline-section"), grid: document.querySelector("#offline-grid") },
  critical: { section: document.querySelector("#critical-section"), grid: document.querySelector("#critical-grid") },
  warning: { section: document.querySelector("#warning-section"), grid: document.querySelector("#warning-grid") },
  pending: { section: document.querySelector("#pending-section"), grid: document.querySelector("#pending-grid") },
  healthy: { section: document.querySelector("#healthy-section"), grid: document.querySelector("#healthy-grid") }
};
const emptyState = document.querySelector("#empty-state");
const noResultsState = document.querySelector("#no-results-state");
const errorState = document.querySelector("#error-state");
const syncState = document.querySelector("#sync-state");
const searchFilter = document.querySelector("#search-filter");
const siteFilter = document.querySelector("#site-filter");
const stateFilter = document.querySelector("#state-filter");
const detailDialog = document.querySelector("#printer-detail");
const detailContent = document.querySelector("#detail-content");
const operationalView = document.querySelector("#operational-view");
const compactView = document.querySelector("#compact-view");
const compactGrid = document.querySelector("#compact-grid");
const viewButtons = [...document.querySelectorAll("[data-view]")];
let fleetData = { summary: {}, printers: [] };
const preferenceStorage = (() => { try { return window.localStorage; } catch { return null; } })();
let viewMode = loadViewMode(preferenceStorage);

function relativeTime(value) {
  if (!value) return "Never";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Unknown";
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (Math.abs(seconds) < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return minutes < 0 ? `in ${Math.abs(minutes)} min` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return hours < 0 ? `in ${Math.abs(hours)} hr` : `${hours} hr ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tonerVisual(consumables, { attentionOnly = false, compact = false } = {}) {
  const channels = tonerChannels(consumables).filter((channel) => !attentionOnly || ["low", "critical"].includes(channel.attention));
  if (!channels.length) return null;
  const container = element("div", `toner-visual${compact ? " compact" : ""}`);
  container.setAttribute("aria-label", "Toner and ink levels");
  for (const channel of channels) {
    const value = channel.displayValue;
    const accessibleAttention = channel.attention === "normal" ? "normal" : channel.attention === "unknown" ? "unknown" : channel.attention;
    const tile = element("div", `toner-channel ${channel.attention}`);
    tile.setAttribute("aria-label", `${channel.label} ${channel.supply.type}, ${channel.levelPercent == null ? "unknown level" : `${channel.levelPercent} percent`}, ${accessibleAttention}`);
    const label = element("span", "toner-label", channel.shortLabel);
    const track = element("span", "toner-track");
    const fill = element("span", "toner-fill");
    if (channel.levelPercent != null) fill.style.width = `${Math.max(0, Math.min(100, channel.levelPercent))}%`;
    fill.style.backgroundColor = channel.colour;
    track.append(fill);
    tile.append(label, track, element("strong", "toner-value", value));
    container.append(tile);
  }
  return container;
}

function cardFor(printer) {
  const card = template.content.firstElementChild.cloneNode(true);
  const pending = printer.operationalState === "pending";
  const health = printer.normalizedHealth;
  card.dataset.health = printer.operationalState;
  if (printer.reachability?.failureKind) card.dataset.failure = printer.reachability.failureKind;
  card.querySelector(".location").textContent = [printer.site?.name, printer.identity.location].filter(Boolean).join(" · ") || "Unassigned location";
  card.querySelector("h3").textContent = printer.identity.displayName || printer.identity.hostname;
  card.querySelector(".hostname").textContent = printer.identity.hostname;
  card.querySelector(".status-pill").textContent = pending ? "Pending" : printer.reachability.reachable ? health : failureLabel(printer.reachability.failureKind);
  card.querySelector(".device").textContent = pending ? "Never collected" : [printer.identity.manufacturer, printer.identity.model].filter(Boolean).join(" · ") || "Unknown device";
  card.querySelector(".ip").textContent = pending ? "No collection attempt" : printer.identity.resolvedIp || "Not resolved";
  card.querySelector(".stale-badge").hidden = !printer.isStale;
  card.querySelector(".last-known-badge").hidden = !printer.lastKnownData;

  const alerts = card.querySelector(".alerts");
  const alertItems = [...printer.alerts].sort((a, b) => Number(a.severity === "info") - Number(b.severity === "info"));
  if (printer.reachability && !printer.reachability.reachable && printer.reachability.failureReason) alertItems.unshift({ severity: "critical", message: `Current failure: ${printer.reachability.failureReason}` });
  if (alertItems.length) {
    alerts.hidden = false;
    alertItems.slice(0, 2).forEach((alert) => alerts.append(element("p", alert.severity === "info" ? "informational" : "", alert.message)));
  }

  const tonerAttention = tonerVisual(printer.consumables, { attentionOnly: true });
  const maintenanceAttention = printer.consumables.filter((item) => !["toner", "ink"].includes(item.type) && item.levelPercent != null && item.levelPercent <= 20).sort((a, b) => a.levelPercent - b.levelPercent);
  if (tonerAttention || maintenanceAttention.length) {
    const supplies = card.querySelector(".supplies");
    supplies.hidden = false;
    supplies.querySelector(".mini-heading").textContent = printer.lastKnownData ? "Last-known supply attention" : "Supply attention";
    const list = supplies.querySelector(".supply-list");
    if (tonerAttention) list.append(tonerAttention);
    maintenanceAttention.slice(0, 3).forEach((supply) => {
      const row = element("div", `supply-row ${supply.levelPercent <= 5 ? "critical" : "low"}`);
      const name = element("span", "supply-name", supply.colour || supply.description);
      const track = element("span", "supply-track");
      const bar = element("span", "supply-bar"); bar.style.width = `${supply.levelPercent}%`; track.append(bar);
      row.append(name, track, element("span", "supply-level", `${supply.levelPercent}%`)); list.append(row);
    });
  }

  card.querySelector(".reachability").textContent = pending ? "Configured · Never collected" : printer.reachability.reachable ? `Reachable${printer.reachability.latencyMs != null ? ` · ${printer.reachability.latencyMs} ms` : ""}` : `Offline · attempted ${relativeTime(printer.reachability.lastAttempt)}`;
  const time = card.querySelector("time");
  time.dateTime = printer.reachability?.lastSeen || printer.collectedAt || printer.configuredAt;
  time.textContent = pending ? `Configured ${relativeTime(printer.configuredAt)}` : printer.reachability.lastSeen ? `Last seen ${relativeTime(printer.reachability.lastSeen)}` : "Never successfully seen";
  card.querySelector(".page-count").textContent = printer.counters.total == null ? "Page count unavailable" : `${printer.counters.total.toLocaleString()} pages`;
  card.querySelector(".detail-button").addEventListener("click", () => void showDetails(printer.identity.inventoryId));
  return card;
}

function compactCardFor(printer) {
  const card = compactTemplate.content.firstElementChild.cloneNode(true);
  const pending = printer.operationalState === "pending";
  card.dataset.health = printer.operationalState;
  card.setAttribute("aria-label", `Open details for ${printer.identity.displayName || printer.identity.hostname}, ${pending ? "pending, never collected" : printer.operationalState}`);
  card.querySelector(".location").textContent = [printer.site?.name, printer.identity.location].filter(Boolean).join(" · ") || "Unassigned";
  card.querySelector("h3").textContent = printer.identity.displayName || printer.identity.hostname;
  card.querySelector(".status-pill").textContent = pending ? "Pending" : printer.reachability?.reachable ? printer.normalizedHealth : "Offline";
  card.querySelector(".compact-device").textContent = pending ? "Never collected" : [printer.identity.manufacturer, printer.identity.model].filter(Boolean).join(" · ") || "Device model unavailable";
  card.querySelector(".compact-target").textContent = printer.identity.resolvedIp || printer.identity.hostname;
  const toner = tonerVisual(printer.consumables, { compact: true });
  if (toner) card.querySelector(".compact-toner").append(toner);
  else card.querySelector(".compact-toner").append(element("span", "compact-empty", pending ? "No collection data" : "Toner levels unavailable"));

  const maintenance = maintenanceSummary(printer.consumables);
  if (maintenance.count) {
    const wording = `+${maintenance.count} maintenance item${maintenance.count === 1 ? "" : "s"}${maintenance.attentionCount ? ` · ${maintenance.attentionCount} need attention` : ""}`;
    card.querySelector(".compact-toner").append(element("span", maintenance.attentionCount ? "maintenance-note attention" : "maintenance-note", wording));
  }
  const alertItems = [...printer.alerts].sort((a, b) => Number(a.severity === "info") - Number(b.severity === "info"));
  if (printer.reachability && !printer.reachability.reachable && printer.reachability.failureReason) alertItems.unshift({ severity: "critical", message: printer.reachability.failureReason });
  const alertSummary = compactAlerts(alertItems);
  if (alertSummary.visible.length) {
    const alerts = card.querySelector(".compact-alerts"); alerts.hidden = false;
    alertSummary.visible.forEach((alert) => alerts.append(element("p", "", alert.message)));
    if (alertSummary.additional) alerts.append(element("p", "more", `+${alertSummary.additional} more`));
  }
  card.querySelector(".page-count").textContent = printer.counters.total == null ? "Pages —" : `${printer.counters.total.toLocaleString()} pages`;
  card.querySelector(".last-seen").textContent = pending ? "Never collected" : printer.isStale ? `Stale · ${relativeTime(printer.latestAttemptAt)}` : printer.reachability?.lastSeen ? `Seen ${relativeTime(printer.reachability.lastSeen)}` : "Never successfully seen";
  const open = () => void showDetails(printer.identity.inventoryId);
  card.addEventListener("click", open);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
  });
  return card;
}

function renderFleet() {
  const filtered = filterFleet(fleetData.printers, { search: searchFilter.value, site: siteFilter.value, state: stateFilter.value });
  const grouped = groupPrinters(filtered);
  for (const [health, { section, grid }] of Object.entries(statusSections)) {
    grid.replaceChildren(...grouped[health].map(cardFor));
    section.hidden = grouped[health].length === 0;
  }
  compactGrid.replaceChildren(...filtered.map(compactCardFor));
  emptyState.hidden = fleetData.printers.length !== 0;
  noResultsState.hidden = fleetData.printers.length === 0 || filtered.length !== 0;
}

function setViewMode(value, persist = true) {
  viewMode = persist ? persistViewMode(preferenceStorage, value) : value;
  operationalView.hidden = viewMode !== "operational";
  compactView.hidden = viewMode !== "compact";
  viewButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === viewMode)));
  document.body.dataset.view = viewMode;
}

function populateSites(printers) {
  const selected = siteFilter.value;
  const sites = [...new Map(printers.map((printer) => [printer.site?.id, printer.site]).filter(([id]) => id)).values()].sort((a, b) => a.name.localeCompare(b.name));
  siteFilter.replaceChildren(new Option("All sites", ""), ...sites.map((site) => new Option(site.name, site.id)));
  siteFilter.value = sites.some((site) => site.id === selected) ? selected : "";
}

function factList(items) {
  const list = element("dl", "detail-facts");
  for (const [label, value] of items) {
    const wrapper = element("div"); wrapper.append(element("dt", "", label), element("dd", "", value ?? "Unavailable")); list.append(wrapper);
  }
  return list;
}

function detailTable(headers, rows) {
  const table = element("table", "detail-table");
  const head = element("thead"); const headingRow = element("tr"); headers.forEach((header) => headingRow.append(element("th", "", header))); head.append(headingRow);
  const body = element("tbody"); rows.forEach((values) => { const row = element("tr"); values.forEach((value) => row.append(element("td", "", String(value ?? "—")))); body.append(row); });
  table.append(head, body); return table;
}

async function showDetails(id) {
  detailContent.replaceChildren(element("p", "detail-loading", "Loading stored printer details…"));
  detailDialog.showModal();
  try {
    const [detailResponse, historyResponse] = await Promise.all([fetch(`/api/printers/${encodeURIComponent(id)}`), fetch(`/api/printers/${encodeURIComponent(id)}/history?limit=30`)]);
    if (!detailResponse.ok || !historyResponse.ok) throw new Error("Stored detail is unavailable");
    const printer = await detailResponse.json(); const history = (await historyResponse.json()).history;
    const title = element("h2", "", printer.identity.displayName || printer.identity.hostname);
    const pending = printer.operationalState === "pending";
    const subtitle = element("p", "detail-subtitle", pending ? "Configured · Never collected" : [printer.identity.manufacturer, printer.identity.model].filter(Boolean).join(" · ") || "Unknown device");
    const badges = element("div", "state-badges"); badges.append(element("span", `status-pill ${printer.reachability && !printer.reachability.reachable ? "offline" : ""}`, pending ? "pending" : printer.reachability.reachable ? printer.normalizedHealth : "offline"));
    if (printer.isStale) badges.append(element("span", "stale-badge", "Stale"));
    if (printer.lastKnownData) badges.append(element("span", "last-known-badge", "Supplies and counters are last known"));
    const identity = factList([["Hostname", printer.identity.hostname], ["Site", printer.site?.name], ["Location", printer.identity.location], ["Serial", printer.identity.serialNumber], ["Adapter", printer.provenance?.adapter]]);
    const current = factList([["State", pending ? "Never collected" : printer.operationalState], ["Reachability", pending ? "Not yet attempted" : printer.reachability.reachable ? "Reachable" : failureLabel(printer.reachability.failureKind)], ["Health", printer.normalizedHealth], ["Completeness", printer.provenance?.collectionStatus], ["Latest attempt", printer.reachability ? relativeTime(printer.reachability.lastAttempt) : "Never"], ["Last successful collection", relativeTime(printer.lastSuccessfulCollectionAt)], ["Last seen", printer.reachability ? relativeTime(printer.reachability.lastSeen) : "Never"], ["Collection duration", printer.collectionDurationMs == null ? undefined : `${printer.collectionDurationMs} ms`], ["Failure", printer.reachability?.failureReason]]);
    const supplies = detailTable(["Supply", "Category", "Level", "Raw"], printer.consumables.map((supply) => [supply.description, supply.type, supply.levelPercent == null ? "—" : `${supply.levelPercent}%`, supply.levelPercent == null ? `${supply.rawLevel ?? "?"} / ${supply.rawMaximum ?? "?"}` : "—"]));
    const toner = tonerVisual(printer.consumables) || element("p", "detail-empty", "Toner levels unavailable.");
    const alerts = printer.alerts.length ? detailTable(["Severity", "Alert"], printer.alerts.map((alert) => [alert.severity, alert.message])) : element("p", "detail-empty", "No current alerts.");
    const counters = factList(Object.entries(printer.counters).map(([name, value]) => [name, value?.toLocaleString()]));
    const recent = history.length ? detailTable(["Collected", "Reachability", "Health", "Pages", "Supply snapshot"], history.map((entry) => [relativeTime(entry.collectedAt), entry.reachable ? "reachable" : "offline", entry.health, entry.totalPages?.toLocaleString(), entry.supplies.map((supply) => `${supply.colour || supply.description} ${supply.levelPercent}%`).slice(0, 4).join(", ")])) : element("p", "detail-empty", "No collection history yet.");
    detailContent.replaceChildren(title, subtitle, badges, element("h3", "", "Identity"), identity, element("h3", "", "Current state"), current, element("h3", "", "Toner / ink"), toner, element("h3", "", "Complete supply evidence"), supplies, element("h3", "", "Alerts"), alerts, element("h3", "", "Counters"), counters, element("h3", "", "Recent history"), recent);
  } catch (error) {
    detailContent.replaceChildren(element("p", "error-state", error instanceof Error ? error.message : "Stored detail is unavailable"));
  }
}

async function loadFleet() {
  try {
    const [response, healthResponse] = await Promise.all([
      fetch("/api/fleet", { headers: { accept: "application/json" } }),
      fetch("/api/health", { headers: { accept: "application/json" } })
    ]);
    if (!response.ok || !healthResponse.ok) throw new Error(`HTTP ${response.ok ? healthResponse.status : response.status}`);
    fleetData = await response.json();
    const health = await healthResponse.json();
    document.querySelectorAll("#summary-grid strong").forEach((node, index) => { node.textContent = String(fleetData.summary[summaryKeys[index]] ?? 0); });
    populateSites(fleetData.printers);
    renderFleet();
    errorState.hidden = true;
    syncState.classList.remove("error");
    const collector = health.collector;
    const collectorLabel = collector.status === "running" ? "Collector running" : collector.status === "stale" ? "Collector stale" : collector.status === "stopped" ? "Collector stopped" : "Collector unavailable";
    const nextPoll = collector.nextScheduledRunAt ? ` · Next poll ${relativeTime(collector.nextScheduledRunAt)}` : "";
    syncState.querySelector("span:last-child").textContent = `${collectorLabel}${nextPoll}`;
  } catch (_error) {
    errorState.hidden = false;
    syncState.classList.add("error");
    syncState.querySelector("span:last-child").textContent = "API unavailable";
  }
}

for (const control of [searchFilter, siteFilter, stateFilter]) control.addEventListener("input", renderFleet);
viewButtons.forEach((button) => button.addEventListener("click", () => setViewMode(button.dataset.view)));
document.querySelector("#clear-filters").addEventListener("click", () => { searchFilter.value = ""; siteFilter.value = ""; stateFilter.value = ""; renderFleet(); });
document.querySelector("#retry-button").addEventListener("click", loadFleet);
document.querySelector(".dialog-close").addEventListener("click", () => detailDialog.close());
detailDialog.addEventListener("click", (event) => { if (event.target === detailDialog) detailDialog.close(); });
setViewMode(viewMode, false);
loadFleet();
setInterval(loadFleet, 60_000);
