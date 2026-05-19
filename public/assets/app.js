const dataBase = location.pathname.includes("/public/") ? "../data" : "data";
const networkUrl = `${dataBase}/current/network.json`;
const historyUrl = `${dataBase}/history/summary.csv`;

let network = null;
let history = [];
let filteredRelays = [];

const number = new Intl.NumberFormat("en-US");
const countryCenters = {
  AL: { lat: 41, lon: 20, scale: 5.5 }, AT: { lat: 47.6, lon: 14.3, scale: 5.5 },
  AU: { lat: -25, lon: 134, scale: 2.2 }, BE: { lat: 50.7, lon: 4.6, scale: 6 },
  BG: { lat: 42.7, lon: 25.5, scale: 5.5 }, BR: { lat: -10, lon: -52, scale: 2.5 },
  CA: { lat: 56, lon: -106, scale: 1.9 }, CH: { lat: 46.8, lon: 8.2, scale: 6 },
  CZ: { lat: 49.8, lon: 15.4, scale: 5.5 }, DE: { lat: 51, lon: 10, scale: 4.4 },
  DK: { lat: 56, lon: 10, scale: 5.5 }, EE: { lat: 58.7, lon: 25, scale: 5.5 },
  ES: { lat: 40, lon: -4, scale: 4.2 }, FI: { lat: 64, lon: 26, scale: 3.4 },
  FR: { lat: 46, lon: 2, scale: 4 }, GB: { lat: 54, lon: -2, scale: 4.4 },
  GR: { lat: 39, lon: 22, scale: 4.8 }, HR: { lat: 45, lon: 16, scale: 5.5 },
  HU: { lat: 47, lon: 19, scale: 5.5 }, IE: { lat: 53, lon: -8, scale: 5.3 },
  IS: { lat: 65, lon: -18, scale: 4.2 }, IT: { lat: 43, lon: 12, scale: 4.2 },
  LT: { lat: 55, lon: 24, scale: 5.5 }, LU: { lat: 49.8, lon: 6.1, scale: 6 },
  MD: { lat: 47, lon: 29, scale: 5.5 }, MK: { lat: 41.6, lon: 21.7, scale: 6 },
  NL: { lat: 52.2, lon: 5.3, scale: 6 }, NO: { lat: 61, lon: 8, scale: 3.8 },
  PL: { lat: 52, lon: 19, scale: 4.6 }, PT: { lat: 39, lon: -8, scale: 4.8 },
  RO: { lat: 46, lon: 25, scale: 4.8 }, SC: { lat: -4.6, lon: 55.5, scale: 6 },
  SE: { lat: 62, lon: 15, scale: 3.6 }, UA: { lat: 49, lon: 31, scale: 4 },
  US: { lat: 39, lon: -98, scale: 2.4 },
};

function fmt(value) {
  return number.format(value || 0);
}

function fmtBandwidth(value) {
  const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
  let n = Number(value || 0);
  let idx = 0;
  while (n >= 1024 && idx < units.length - 1) {
    n /= 1024;
    idx += 1;
  }
  return `${n.toFixed(idx ? 1 : 0)} ${units[idx]}`;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(headers.map((key, index) => [key, cells[index] ?? ""]));
  });
}

async function load() {
  const [networkResponse, historyResponse] = await Promise.all([
    fetch(networkUrl, { cache: "no-store" }),
    fetch(historyUrl, { cache: "no-store" }).catch(() => null),
  ]);
  network = await networkResponse.json();
  history = historyResponse && historyResponse.ok ? parseCsv(await historyResponse.text()) : [];
  populateFilters();
  render();
}

function populateFilters() {
  const countries = [...new Map(network.relays.map((r) => [r.country, r.countryName])).entries()]
    .sort((a, b) => a[0].localeCompare(b[0]));
  const asns = [...new Map(network.relays.map((r) => [r.asn, r.asName])).entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  fillSelect("country-filter", countries, ([code, name]) => [code, `${code} ${shorten(name, 22)}`]);
  fillSelect("asn-filter", asns.slice(0, 800), ([asn, name]) => [asn, `${asn} ${shorten(name, 34)}`]);
}

function fillSelect(id, rows, mapper) {
  const select = document.getElementById(id);
  const first = select.firstElementChild.outerHTML;
  select.innerHTML = first + rows.map((row) => {
    const [value, label] = mapper(row);
    return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  }).join("");
}

function currentFilters() {
  return {
    role: document.getElementById("global-role").value,
    country: document.getElementById("country-filter").value,
    asn: document.getElementById("asn-filter").value,
    query: document.getElementById("search").value.trim().toLowerCase(),
    mapMetric: document.getElementById("map-metric").value,
  };
}

function applyFilters(includeQuery = true) {
  const filters = currentFilters();
  return network.relays
    .filter((relay) => filters.role === "all" || relay.role === filters.role)
    .filter((relay) => filters.country === "all" || relay.country === filters.country)
    .filter((relay) => filters.asn === "all" || relay.asn === filters.asn)
    .filter((relay) => {
      if (!includeQuery || !filters.query) return true;
      return [
        relay.fingerprint,
        relay.nickname,
        relay.country,
        relay.countryName,
        relay.asn,
        relay.asName,
        relay.ips.join(" "),
      ].join(" ").toLowerCase().includes(filters.query);
    });
}

function render() {
  filteredRelays = applyFilters();
  document.getElementById("generated-at").textContent = `Updated ${network.generatedAt}`;
  renderMetrics();
  renderInsights();
  renderBars("asn-bars", aggregate(filteredRelays, "asn", "bandwidth"), "bandwidth", "asn-filter");
  renderBars("country-bars", aggregate(filteredRelays, "country", "count"), "count", "country-filter");
  renderMap();
  renderComposition();
  renderTable();
}

function renderMetrics() {
  const roleCounts = countBy(filteredRelays, "role");
  const countries = new Set(filteredRelays.map((r) => r.country));
  const asns = new Set(filteredRelays.map((r) => r.asn));
  const bandwidth = filteredRelays.reduce((sum, row) => sum + row.bandwidth, 0);
  const metrics = [
    ["Relays", fmt(filteredRelays.length)],
    ["Exits", fmt(roleCounts.exit || 0)],
    ["Guards", fmt(roleCounts.guard || 0)],
    ["Countries", fmt(countries.size)],
    ["ASNs", fmt(asns.size)],
    ["Bandwidth", fmtBandwidth(bandwidth)],
  ];
  document.getElementById("metrics").innerHTML = metrics
    .map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function renderInsights() {
  const rows = [...network.insights];
  document.getElementById("insights").innerHTML = rows.slice(0, 4)
    .map((item) => `
      <div class="insight">
        <span>${escapeHtml(item.title)}</span>
        <strong>${escapeHtml(item.value)}</strong>
        <p>${escapeHtml(item.detail)}</p>
      </div>
    `)
    .join("");
}

function aggregate(rows, key, mode) {
  const map = new Map();
  for (const row of rows) {
    const id = row[key] || "unknown";
    const item = map.get(id) || {
      key: id,
      count: 0,
      bandwidth: 0,
      exits: 0,
      guards: 0,
      label: key === "country" ? row.countryName : row.asName,
    };
    item.count += 1;
    item.bandwidth += row.bandwidth;
    if (row.role === "exit") item.exits += 1;
    if (row.role === "guard") item.guards += 1;
    map.set(id, item);
  }
  return [...map.values()].sort((a, b) => b[mode] - a[mode]).slice(0, 20);
}

function countBy(rows, key) {
  return rows.reduce((acc, row) => {
    acc[row[key]] = (acc[row[key]] || 0) + 1;
    return acc;
  }, {});
}

function renderBars(id, rows, valueKey, targetSelect) {
  const max = Math.max(...rows.map((row) => Number(row[valueKey] || 0)), 1);
  document.getElementById(id).innerHTML = rows.slice(0, 12).map((row) => {
    const value = Number(row[valueKey] || 0);
    const label = valueKey === "bandwidth" ? fmtBandwidth(value) : fmt(value);
    return `
      <div class="bar-row" data-target="${targetSelect}" data-value="${escapeHtml(row.key)}">
        <span><code>${escapeHtml(row.key)}</code> ${label}</span>
        <div class="bar-line"><div class="bar-fill" style="width:${(value / max) * 100}%"></div></div>
      </div>
    `;
  }).join("");
  document.querySelectorAll(`#${id} .bar-row`).forEach((row) => {
    row.addEventListener("click", () => {
      document.getElementById(row.dataset.target).value = row.dataset.value;
      render();
    });
  });
}

function renderMap() {
  const metric = currentFilters().mapMetric;
  const rows = aggregate(filteredRelays, "country", metric).filter((row) => /^[A-Z]{2}$/.test(row.key));
  document.getElementById("map-note").textContent = `${fmt(filteredRelays.length)} relays in current filter`;
  if (!window.Plotly) {
    document.getElementById("map").textContent = "Map library unavailable";
    return;
  }
  const values = rows.map((row) => Number(row[metric] || 0));
  const labels = rows.map((row) => {
    const value = metric === "bandwidth" ? fmtBandwidth(row[metric]) : fmt(row[metric]);
    return `${row.key}<br>${escapeHtml(row.label || "")}<br>${value}`;
  });
  Plotly.react("map", [{
    type: "choropleth",
    locationmode: "ISO-3",
    locations: rows.map((row) => iso2ToIso3(row.key)),
    z: values,
    text: labels,
    hovertemplate: "%{text}<extra></extra>",
    colorscale: [
      [0, "#e9f2ec"],
      [0.45, "#87cfa8"],
      [1, "#20865a"],
    ],
    marker: { line: { color: "#ffffff", width: 0.5 } },
    colorbar: { thickness: 12, outlinewidth: 0 },
  }], {
    margin: { l: 0, r: 0, t: 0, b: 0 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    geo: {
      projection: { type: "natural earth" },
      ...selectedCountryGeo(),
      showframe: false,
      showcoastlines: true,
      coastlinecolor: "#b8c8be",
      showcountries: true,
      countrycolor: "#ffffff",
      showland: true,
      landcolor: "#eef4ef",
      showocean: true,
      oceancolor: "#f8fbf9",
      bgcolor: "rgba(0,0,0,0)",
    },
  }, {
    displayModeBar: false,
    responsive: true,
  });
}

function selectedCountryGeo() {
  const country = currentFilters().country;
  if (country === "all") {
    return {};
  }
  const center = countryCenters[country];
  if (!center) {
    return {};
  }
  return {
    fitbounds: "locations",
    center: { lon: center.lon, lat: center.lat },
    projection: { type: "natural earth", scale: center.scale || 3.2 },
  };
}

function renderComposition() {
  const canvas = document.getElementById("composition");
  const ctx = setupCanvas(canvas);
  const { width, height } = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, width, height);
  const counts = countBy(filteredRelays, "role");
  const rows = [
    ["guard", counts.guard || 0, "#20865a"],
    ["middle", counts.middle || 0, "#087d8f"],
    ["exit", counts.exit || 0, "#c83b47"],
  ];
  const total = Math.max(filteredRelays.length, 1);
  let start = -Math.PI / 2;
  const cx = Math.min(width * 0.32, 150);
  const cy = height / 2;
  const radius = Math.min(height * 0.34, 82);
  for (const [, value, color] of rows) {
    const angle = (value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.fillStyle = color;
    ctx.arc(cx, cy, radius, start, start + angle);
    ctx.closePath();
    ctx.fill();
    start += angle;
  }
  ctx.beginPath();
  ctx.fillStyle = "#fff";
  ctx.arc(cx, cy, radius * 0.58, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#17231d";
  ctx.font = "700 22px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(fmt(total), cx, cy + 8);
  ctx.textAlign = "left";
  rows.forEach(([name, value, color], index) => {
    const y = 54 + index * 44;
    ctx.fillStyle = color;
    ctx.fillRect(width * 0.55, y - 12, 14, 14);
    ctx.fillStyle = "#17231d";
    ctx.font = "700 14px system-ui";
    ctx.fillText(`${name.toUpperCase()} ${fmt(value)}`, width * 0.55 + 24, y);
  });
}

function setupCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.parentElement.clientWidth;
  const height = Number(canvas.getAttribute("height"));
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

function renderTable() {
  const rows = filteredRelays.slice(0, 500);
  document.getElementById("relay-table").innerHTML = rows.map((relay) => `
    <tr>
      <td>
        <strong>${escapeHtml(relay.nickname || "Unnamed")}</strong><br>
        <code>${relay.fingerprint || ""}</code><br>
        <span>${relay.ips.slice(0, 3).join(", ")}</span>
      </td>
      <td><span class="pill ${relay.role}">${relay.role}</span></td>
      <td><code>${relay.country}</code><br><span>${escapeHtml(relay.countryName)}</span></td>
      <td><code>${relay.asn}</code><br><span>${escapeHtml(relay.asName)}</span></td>
      <td>${fmtBandwidth(relay.bandwidth)}</td>
      <td>${relay.flags.slice(0, 7).map((flag) => `<span>${flag}</span>`).join(", ")}</td>
    </tr>
  `).join("");
}

function iso2ToIso3(code) {
  const map = {
    AL: "ALB", AT: "AUT", AU: "AUS", BE: "BEL", BG: "BGR", BR: "BRA", CA: "CAN", CH: "CHE",
    CZ: "CZE", DE: "DEU", DK: "DNK", EE: "EST", ES: "ESP", FI: "FIN", FR: "FRA", GB: "GBR",
    GR: "GRC", HR: "HRV", HU: "HUN", IE: "IRL", IS: "ISL", IT: "ITA", LT: "LTU", LU: "LUX",
    MD: "MDA", MK: "MKD", NL: "NLD", NO: "NOR", PL: "POL", PT: "PRT", RO: "ROU", SC: "SYC",
    SE: "SWE", UA: "UKR", US: "USA", RU: "RUS", TR: "TUR", IL: "ISR", AE: "ARE", IN: "IND",
    SG: "SGP", JP: "JPN", KR: "KOR", HK: "HKG", TW: "TWN", NZ: "NZL", ZA: "ZAF", AR: "ARG",
    CL: "CHL", CN: "CHN", MX: "MEX", CO: "COL", RS: "SRB", SK: "SVK", SI: "SVN", LV: "LVA",
    BY: "BLR", KZ: "KAZ", VN: "VNM", TH: "THA", ID: "IDN", MY: "MYS", PH: "PHL",
  };
  return map[code] || code;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
  });
}

function shorten(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

["global-role", "country-filter", "asn-filter", "map-metric"].forEach((id) => {
  document.getElementById(id).addEventListener("change", render);
});
document.getElementById("search").addEventListener("input", render);
window.addEventListener("resize", render);

load().catch((error) => {
  document.getElementById("generated-at").textContent = "Failed to load data";
  document.getElementById("status-dot").style.background = "var(--red)";
  console.error(error);
});
