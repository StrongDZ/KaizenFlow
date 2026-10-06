// Commissioning page: draws on a camera frame, edits a draft station config,
// previews readings through config-api and saves with PUT /v1/stations.
"use strict";

const $ = (id) => document.getElementById(id);
const frameCanvas = $("frame"), frameCtx = frameCanvas.getContext("2d");
const rectCanvas = $("rect"), rectCtx = rectCanvas.getContext("2d");
const CORNERS = ["TL", "TR", "BR", "BL"];
const PICK_COLORS = { center: "#ffd400", min_pt: "#2ecc71", max_pt: "#ff4d4d" };

const state = {
  config: { machine_id: "", plant: "", line: "", camera: { url: "", sample_fps: 2 }, window_sec: 1, gauges: [] },
  frame: null,        // { img, b64, width, height }
  selected: -1,       // index in config.gauges
  drag: null,         // { kind: "new", x0, y0 } | { kind: "corner", i }
  pick: null,         // "center" | "min_pt" | "max_pt"
  rectImg: null,      // rectified image of the selected dial
  readings: [],
  liveTimer: null,
  acceptance: [],     // per-gauge verdicts of the machine, from config-api
};

function status(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = data.details ? ": " + data.details.join("; ") : "";
    throw new Error((data.error || res.statusText) + details);
  }
  return data;
}

function loadImage(b64) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = "data:image/jpeg;base64," + b64;
  });
}

// ------------------------------------------------------------ config ----

function gauge() { return state.config.gauges[state.selected]; }

// Quad as [{x, y}] (proto JSON); roi is its integer bounding box.
function setQuad(g, points) {
  g.quad = points.map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }));
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x = Math.max(0, Math.floor(Math.min(...xs))), y = Math.max(0, Math.floor(Math.min(...ys)));
  g.roi = [x, y, Math.ceil(Math.max(...xs)) - x, Math.ceil(Math.max(...ys)) - y];
  g.rect_size = g.rect_size || 256;
  state.rectImg = null;
}

function quadPoints(g) {
  if (g.quad && g.quad.length === 4) return g.quad.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p));
  if (g.roi && g.roi.length === 4) {
    const [x, y, w, h] = g.roi;
    return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  }
  return null;
}

function newGauge(id, type) {
  const calib = type === "analog_dial" ? { sweep: "cw", scale: "linear" }
    : type === "timer_mmss" ? { digits: 4, colon_after: 2 }
    : type === "seg7" ? { digits: 3, decimal_pos: 3, color: "red_led" }
    : { digits: 6, decimal_digits: 1 };
  const rules = type === "rolling_counter" ? { monotonic: true } : {};
  return { gauge_id: id, type, unit: "", roi: [], calib, rules };
}

function syncHeader() {
  const c = state.config;
  c.machine_id = $("machine").value.trim();
  c.plant = $("plant").value.trim();
  c.line = $("line").value.trim();
  c.camera.url = $("url").value.trim();
  c.camera.sample_fps = Number($("fps").value) || 2;
}

function fillHeader() {
  const c = state.config;
  $("machine").value = c.machine_id || "";
  $("plant").value = c.plant || "";
  $("line").value = c.line || "";
  $("url").value = (c.camera && c.camera.url) || "";
  $("fps").value = (c.camera && c.camera.sample_fps) || 2;
}

// Draft as sent to config-api: empty optional numbers are left out.
function draft() {
  syncHeader();
  return JSON.parse(JSON.stringify(state.config));
}

// ------------------------------------------------------------- render ----

function renderList() {
  const ul = $("gauges");
  ul.innerHTML = "";
  state.config.gauges.forEach((g, i) => {
    const li = document.createElement("li");
    li.textContent = `${g.gauge_id} (${g.type})` + (g.roi && g.roi.length === 4 ? "" : " – chưa khoanh vùng");
    li.className = i === state.selected ? "selected" : "";
    li.onclick = () => select(i);
    ul.appendChild(li);
  });
  $("json").textContent = JSON.stringify(draft(), null, 2);
}

function renderEditor() {
  const g = gauge();
  $("editor").hidden = !g;
  if (!g) return;
  $("editor-title").textContent = `${g.gauge_id} – ${g.type}`;
  document.querySelectorAll("[data-for]").forEach((el) => {
    el.hidden = !el.dataset.for.split(" ").includes(g.type);
  });
  document.querySelectorAll("[data-f]").forEach((el) => { el.value = g[el.dataset.f] ?? ""; });
  document.querySelectorAll("[data-c]").forEach((el) => { el.value = g.calib[el.dataset.c] ?? ""; });
  document.querySelectorAll("[data-r]").forEach((el) => {
    const v = (g.rules || {})[el.dataset.r];
    if (el.type === "checkbox") el.checked = !!v; else el.value = v ?? "";
  });
  drawRect();
}

function drawFrame() {
  if (!state.frame) return;
  const { img, width, height } = state.frame;
  frameCanvas.width = width;
  frameCanvas.height = height;
  frameCtx.drawImage(img, 0, 0);
  const lw = Math.max(2, width / 600);
  state.config.gauges.forEach((g, i) => {
    const q = quadPoints(g);
    if (!q) return;
    frameCtx.strokeStyle = i === state.selected ? "#1a6ed8" : "#ffd400";
    frameCtx.lineWidth = lw;
    frameCtx.beginPath();
    q.forEach((p, k) => (k ? frameCtx.lineTo(p.x, p.y) : frameCtx.moveTo(p.x, p.y)));
    frameCtx.closePath();
    frameCtx.stroke();
    frameCtx.fillStyle = frameCtx.strokeStyle;
    frameCtx.font = `${12 * lw}px sans-serif`;
    frameCtx.fillText(g.gauge_id, q[0].x, q[0].y - 4 * lw);
    if (i === state.selected) {
      q.forEach((p, k) => {
        frameCtx.fillRect(p.x - 4 * lw, p.y - 4 * lw, 8 * lw, 8 * lw);
        frameCtx.fillText(CORNERS[k], p.x + 5 * lw, p.y + 12 * lw);
      });
    }
    const r = state.readings.find((x) => x.gauge_id === g.gauge_id);
    if (r && r.keypoints && r.keypoints.length === 5) {
      const [c, , , , tip] = r.keypoints;
      frameCtx.strokeStyle = "#ff4d4d";
      frameCtx.beginPath();
      frameCtx.moveTo(c[0], c[1]);
      frameCtx.lineTo(tip[0], tip[1]);
      frameCtx.stroke();
    }
  });
  if (state.drag && state.drag.kind === "new" && state.drag.x1 !== undefined) {
    const d = state.drag;
    frameCtx.strokeStyle = "#1a6ed8";
    frameCtx.strokeRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
  }
}

function drawRect() {
  const g = gauge();
  rectCtx.clearRect(0, 0, rectCanvas.width, rectCanvas.height);
  if (!g || g.type !== "analog_dial") return;
  const size = g.rect_size || 256;
  rectCanvas.width = rectCanvas.height = size;
  if (state.rectImg) rectCtx.drawImage(state.rectImg, 0, 0, size, size);
  for (const key of ["center", "min_pt", "max_pt"]) {
    const p = g.calib[key];
    if (!p || p.length !== 2) continue;
    rectCtx.fillStyle = PICK_COLORS[key];
    rectCtx.beginPath();
    rectCtx.arc(p[0], p[1], 4, 0, 2 * Math.PI);
    rectCtx.fill();
    if (key !== "center" && g.calib.center && g.calib.center.length === 2) {
      rectCtx.strokeStyle = PICK_COLORS[key];
      rectCtx.beginPath();
      rectCtx.moveTo(g.calib.center[0], g.calib.center[1]);
      rectCtx.lineTo(p[0], p[1]);
      rectCtx.stroke();
    }
  }
}

function renderReadings() {
  const body = $("readings").querySelector("tbody");
  body.innerHTML = "";
  for (const r of state.readings) {
    const tr = document.createElement("tr");
    const value = r.value === undefined || r.value === null ? "–" : `${+r.value.toFixed(3)} ${r.unit || ""}`;
    const note = r.error || (r.flags || []).map((f) => f.replace("FLAG_", "")).join(", ");
    tr.innerHTML = `<td>${r.gauge_id}</td><td>${value}</td><td>${r.error ? "" : r.quality.toFixed(2)}</td><td class="${r.error ? "bad" : ""}"></td>`;
    tr.lastChild.textContent = note;
    body.appendChild(tr);
  }
  drawFrame();
}

// --------------------------------------------------------- acceptance ----

const VERDICTS = { accepted: "ĐẠT", rejected: "KHÔNG ĐẠT", incomplete: "Chưa đủ mẫu" };

function formatNumber(v) { return v === undefined || v === null ? "–" : String(+Number(v).toFixed(4)); }

function renderAcceptance() {
  const body = $("acceptance").querySelector("tbody");
  body.innerHTML = "";
  for (const g of state.acceptance) {
    const notes = [];
    if (g.verdict === "incomplete") notes.push(`cần thêm ${g.needed} mẫu đạt`);
    if (g.verdict === "rejected") notes.push("chỉnh lại vùng/calib, xóa mẫu rồi nghiệm thu lại");
    if (g.low_quality) notes.push(`${g.low_quality} mẫu đọc đúng nhưng quality thấp: dữ liệu sẽ bị loại khỏi gauge_1m`);
    const tr = document.createElement("tr");
    for (const text of [g.gauge_id, VERDICTS[g.verdict] || g.verdict, g.passed, g.failed, notes.join("; ")]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    tr.children[1].className = "verdict " + g.verdict;
    body.appendChild(tr);
  }
  const g = gauge();
  const mine = g && state.acceptance.find((a) => a.gauge_id === g.gauge_id);
  const rows = $("samples").querySelector("tbody");
  rows.innerHTML = "";
  for (const s of (mine ? mine.samples : [])) {
    const tr = document.createElement("tr");
    const cells = [
      new Date(s.ts_ms).toLocaleTimeString(), formatNumber(s.truth), formatNumber(s.value),
      s.passed ? formatNumber(s.error) : (s.reason || "sai"), s.quality.toFixed(2),
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    tr.children[3].className = s.passed ? "ok" : "bad";
    const link = document.createElement("a");
    link.href = `/v1/commissioning/acceptance/${encodeURIComponent(s.machine_id)}/${encodeURIComponent(s.gauge_id)}/${s.id}.jpg`;
    link.target = "_blank";
    link.textContent = "ảnh";
    const td = document.createElement("td");
    td.appendChild(link);
    tr.appendChild(td);
    rows.appendChild(tr);
  }
}

function showAcceptance(res) {
  state.acceptance = res.gauges || [];
  if (res.rules) {
    $("accept-rule").textContent = `Đồng hồ kim: lệch tối đa ${+(res.rules.dial_tolerance * 100).toFixed(2)}% toàn thang; ` +
      `màn hình số: phải đúng từng chữ số. Cần ${res.rules.min_samples} mẫu đạt và không mẫu nào sai.`;
  }
  renderAcceptance();
}

async function loadAcceptance() {
  const id = $("machine").value.trim();
  if (!id) return;
  try {
    showAcceptance(await api("GET", `/v1/commissioning/acceptance/${encodeURIComponent(id)}`));
  } catch (err) {
    status(`Không tải được kết quả nghiệm thu: ${err.message}`, "error");
  }
}

function renderAll() { renderList(); renderEditor(); drawFrame(); renderAcceptance(); }

function select(i) {
  state.selected = i;
  state.rectImg = null;
  state.pick = null;
  document.querySelectorAll(".pick").forEach((b) => b.classList.remove("active"));
  renderAll();
}

// ------------------------------------------------------------- events ----

function framePoint(ev) {
  const r = frameCanvas.getBoundingClientRect();
  return { x: ((ev.clientX - r.left) * frameCanvas.width) / r.width, y: ((ev.clientY - r.top) * frameCanvas.height) / r.height };
}

frameCanvas.addEventListener("mousedown", (ev) => {
  const g = gauge();
  if (!g || !state.frame) return;
  const p = framePoint(ev);
  const q = quadPoints(g);
  const near = Math.max(12, state.frame.width / 80);
  const corner = q ? q.findIndex((c) => Math.hypot(c.x - p.x, c.y - p.y) < near) : -1;
  state.drag = corner >= 0 ? { kind: "corner", i: corner } : { kind: "new", x0: p.x, y0: p.y };
});
frameCanvas.addEventListener("mousemove", (ev) => {
  const d = state.drag;
  if (!d) return;
  const p = framePoint(ev);
  if (d.kind === "corner") {
    const q = quadPoints(gauge());
    q[d.i] = p;
    setQuad(gauge(), q);
  } else {
    d.x1 = p.x;
    d.y1 = p.y;
  }
  drawFrame();
});
window.addEventListener("mouseup", () => {
  const d = state.drag;
  state.drag = null;
  if (!d) return;
  if (d.kind === "new" && d.x1 !== undefined && Math.abs(d.x1 - d.x0) > 5 && Math.abs(d.y1 - d.y0) > 5) {
    const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
    setQuad(gauge(), [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]);
  }
  renderAll();
});

rectCanvas.addEventListener("click", (ev) => {
  const g = gauge();
  if (!g || !state.pick) return;
  const r = rectCanvas.getBoundingClientRect();
  const x = ((ev.clientX - r.left) * rectCanvas.width) / r.width, y = ((ev.clientY - r.top) * rectCanvas.height) / r.height;
  g.calib[state.pick] = [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
  renderList();
  drawRect();
});

document.querySelectorAll(".pick").forEach((b) => {
  b.onclick = () => {
    state.pick = b.dataset.pick;
    document.querySelectorAll(".pick").forEach((x) => x.classList.toggle("active", x === b));
  };
});

function bindInputs(selector, attr, target) {
  document.querySelectorAll(selector).forEach((el) => {
    el.addEventListener("change", () => {
      const g = gauge();
      if (!g) return;
      const obj = target(g);
      const key = el.dataset[attr];
      if (el.type === "checkbox") {
        if (el.checked) obj[key] = true; else delete obj[key];
      } else if (el.value === "") {
        delete obj[key];
      } else {
        obj[key] = el.type === "number" ? Number(el.value) : el.value;
      }
      renderList();
    });
  });
}
bindInputs("[data-f]", "f", (g) => g);
bindInputs("[data-c]", "c", (g) => g.calib);
bindInputs("[data-r]", "r", (g) => (g.rules = g.rules || {}));
["machine", "plant", "line", "url", "fps"].forEach((id) => $(id).addEventListener("change", renderList));

$("add").onclick = () => {
  const id = $("new-id").value.trim();
  if (!id) return status("Nhập mã đồng hồ trước", "error");
  if (state.config.gauges.some((g) => g.gauge_id === id)) return status(`Đã có đồng hồ ${id}`, "error");
  state.config.gauges.push(newGauge(id, $("new-type").value));
  $("new-id").value = "";
  select(state.config.gauges.length - 1);
};

$("remove").onclick = () => {
  const g = gauge();
  if (!g || !confirm(`Xóa đồng hồ ${g.gauge_id} khỏi bản nháp?`)) return;
  state.config.gauges.splice(state.selected, 1);
  select(-1);
};

$("load").onclick = async () => {
  const id = $("machine").value.trim();
  if (!id) return status("Nhập mã máy", "error");
  try {
    const view = await api("GET", `/v1/stations/${encodeURIComponent(id)}`);
    state.config = view.config;
    state.config.camera = state.config.camera || { url: "", sample_fps: 2 };
    state.config.gauges = state.config.gauges || [];
    for (const g of state.config.gauges) { g.calib = g.calib || {}; g.rules = g.rules || {}; }
    fillHeader();
    select(-1);
    status(`Đã tải config phiên bản ${view.config_version}`, "ok");
    loadAcceptance();
  } catch (err) {
    status(`Không tải được config: ${err.message} (bắt đầu config mới)`, "error");
  }
};

async function showFrame(b64) {
  const img = await loadImage(b64);
  state.frame = { img, b64, width: img.naturalWidth, height: img.naturalHeight };
  drawFrame();
}

$("grab").onclick = async () => {
  syncHeader();
  status("Đang lấy frame…");
  try {
    const body = state.config.camera.url ? { url: state.config.camera.url } : { machine_id: state.config.machine_id };
    const res = await api("POST", "/v1/commissioning/frame", body);
    await showFrame(res.frame_jpeg);
    status(`Frame ${res.width}×${res.height}`, "ok");
  } catch (err) {
    status(`Không lấy được frame: ${err.message}`, "error");
  }
};

$("rectify").onclick = async () => {
  const g = gauge();
  const q = g && quadPoints(g);
  if (!state.frame || !q) return status("Cần frame và vùng đồng hồ trước", "error");
  try {
    const res = await api("POST", "/v1/commissioning/rectify", { frame_jpeg: state.frame.b64, quad: q, size: g.rect_size || 256 });
    state.rectImg = await loadImage(res.image_jpeg);
    drawRect();
  } catch (err) {
    status(`Không chỉnh thẳng được: ${err.message}`, "error");
  }
};

async function runPreview(fresh) {
  try {
    const body = { config: draft() };
    if (!fresh) {
      if (!state.frame) return status("Lấy frame trước", "error");
      body.frame_jpeg = state.frame.b64;
    }
    const res = await api("POST", "/v1/commissioning/preview", body);
    if (res.frame_jpeg) await showFrame(res.frame_jpeg);
    state.readings = res.gauges || [];
    renderReadings();
    status(`Đã đọc lúc ${new Date(res.ts_ms).toLocaleTimeString()}`, "ok");
  } catch (err) {
    status(`Xem trước thất bại: ${err.message}`, "error");
  }
}

$("preview").onclick = () => runPreview(false);
$("live").onchange = () => {
  clearTimeout(state.liveTimer);
  const loop = async () => {
    if (!$("live").checked) return;
    await runPreview(true);
    state.liveTimer = setTimeout(loop, 2000);
  };
  loop();
};

$("accept").onclick = async () => {
  const g = gauge();
  if (!g) return status("Chọn đồng hồ cần nghiệm thu", "error");
  if ($("truth").value === "") return status("Nhập giá trị đang thấy trên đồng hồ", "error");
  const cfg = draft();
  if (!cfg.machine_id) return status("Nhập mã máy", "error");
  status("Đang lấy frame và đọc…");
  try {
    // No frame_jpeg: the reading must be of the moment the value was typed.
    const res = await api("POST", "/v1/commissioning/acceptance", { config: cfg, gauge_id: g.gauge_id, truth: Number($("truth").value) });
    showAcceptance(res);
    const s = res.sample;
    if (s.passed) status(`Mẫu đạt: đọc ${formatNumber(s.value)}, thật ${formatNumber(s.truth)}`, "ok");
    else status(`Mẫu KHÔNG đạt: ${s.reason}`, "error");
  } catch (err) {
    status(`Không ghi được mẫu: ${err.message}`, "error");
  }
};

$("accept-clear").onclick = async () => {
  const g = gauge(), id = $("machine").value.trim();
  if (!g || !id || !confirm(`Xóa mọi mẫu nghiệm thu của ${g.gauge_id}?`)) return;
  try {
    showAcceptance(await api("DELETE", `/v1/commissioning/acceptance/${encodeURIComponent(id)}/${encodeURIComponent(g.gauge_id)}`));
    status(`Đã xóa mẫu của ${g.gauge_id}`, "ok");
  } catch (err) {
    status(`Không xóa được: ${err.message}`, "error");
  }
};

$("save").onclick = async () => {
  const cfg = draft();
  if (!cfg.machine_id) return status("Nhập mã máy", "error");
  try {
    const view = await api("PUT", `/v1/stations/${encodeURIComponent(cfg.machine_id)}`, cfg);
    state.config.config_version = view.config_version;
    status(`Đã lưu phiên bản ${view.config_version}; edge sẽ nạp lại khi nhận config mới`, "ok");
  } catch (err) {
    status(`Không lưu được: ${err.message}`, "error");
  }
};

renderAll();

// Deep link: /commissioning/?machine=<id> opens that station.
const linked = new URLSearchParams(location.search).get("machine");
if (linked) {
  $("machine").value = linked;
  $("load").click();
}
