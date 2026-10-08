import type { AgvMap, MapKeepout, MapLane, Pt } from '../api/types'
import { nextId } from './mapGeom'
import { pointInPolygon, segmentEntersPolygon } from './zones'

/**
 * Dò đường từ ảnh mặt bằng: ảnh → vùng đi được → co lại theo bề rộng xe → đường xương (skeleton) → đồ thị ngã tư/đường → bản nháp bản đồ.
 * Thuần tính toán (không đụng DOM) nên chạy được trong test với ảnh tổng hợp. Chỉ tốt với ảnh sạch (tường tối, sàn sáng hoặc ngược lại);
 * kết quả luôn là bản nháp để người dùng xem và sửa, không tự lưu.
 */

export type Gray = { w: number; h: number; data: Uint8Array }

export type TraceOptions = {
  /** mét mỗi pixel của ảnh đang phân tích (đã tính cả việc thu nhỏ ảnh) */
  mPerPx: number
  /** toạ độ (mét) của góc trên trái ảnh (khi chưa xoay) */
  origin: Pt
  /** góc xoay ảnh nền (độ, chiều kim đồng hồ) quanh tâm ảnh, như `bg.rot`; bỏ trống là ảnh thẳng */
  rotDeg?: number
  /** sàn đi được là vùng sáng hay vùng tối */
  freeIs: 'light' | 'dark'
  /** ngưỡng sáng/tối 0..255; bỏ trống thì tự chọn (Otsu) */
  threshold?: number
  /** lối đi hẹp hơn bề rộng này (mét) không dành cho xe nên bị bỏ */
  minWidthM: number
  /** nhánh cụt ngắn hơn (mét) bị cắt */
  spurM: number
  /** sai số khi đơn giản hoá đường (mét) */
  simplifyM: number
  /** bỏ phần ngoài tường ngoài (vùng đi được chạm mép ảnh) */
  excludeOutside: boolean
  keepouts?: MapKeepout[]
  /** bỏ các cụm đường rời nhau mà tổng chiều dài (mét) nhỏ hơn mức này; ảnh nhiều ký hiệu hay sinh ra nhiều mảnh vụn. 0 hoặc bỏ trống là giữ hết */
  minComponentM?: number
  /** mảng vật cản nhỏ hơn số pixel này (chữ, nét mảnh, ký hiệu) coi như không có */
  minSpeckPx?: number
}

export type TraceNode = { id: number; x: number; y: number }
export type TraceEdge = { a: number; b: number; via: Pt[]; lengthM: number; widthM: number }
export type Trace = { nodes: TraceNode[]; edges: TraceEdge[]; note?: string }

// --- ảnh xám, ngưỡng, đơn giản hoá ------------------------------------------------------------

/** RGBA → xám theo độ sáng cảm nhận; điểm ảnh trong suốt được trộn lên nền trắng. */
export function grayFromRGBA(px: Uint8ClampedArray, w: number, h: number): Gray {
  const data = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const a = px[i * 4 + 3] / 255
    const l = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]
    data[i] = Math.round(l * a + 255 * (1 - a))
  }
  return { w, h, data }
}

/** Ngưỡng Otsu: chia ảnh làm hai nhóm sáng/tối sao cho phương sai giữa hai nhóm lớn nhất (các điểm ảnh ≤ ngưỡng là nhóm tối). */
export function otsu(g: Gray): number {
  const hist = new Array<number>(256).fill(0)
  for (const v of g.data) hist[v]++
  const total = g.data.length
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let wB = 0, sumB = 0, best = 0, bestT = 0
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; bestT = t }
  }
  return bestT
}

/** Ramer–Douglas–Peucker (không đệ quy): giữ các điểm lệch khỏi đường nối quá `tol`. */
export function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length > 0) {
    const [a, b] = stack.pop()!
    let far = -1, farD = tol
    const dx = pts[b].x - pts[a].x, dy = pts[b].y - pts[a].y
    const len = Math.hypot(dx, dy)
    for (let i = a + 1; i < b; i++) {
      const d = len === 0 ? Math.hypot(pts[i].x - pts[a].x, pts[i].y - pts[a].y) : Math.abs(dy * (pts[i].x - pts[a].x) - dx * (pts[i].y - pts[a].y)) / len
      if (d > farD) { far = i; farD = d }
    }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]) }
  }
  return pts.filter((_, i) => keep[i] === 1)
}

// --- phân tích mặt nạ -----------------------------------------------------------------------------

const N8: [number, number][] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]  // theo chiều kim đồng hồ, bắt đầu từ trên

/** Lật các mảng giá trị `value` nhỏ hơn `maxSize` pixel (không chạm mép) sang giá trị ngược lại. */
function flipSmall(mask: Uint8Array, W: number, H: number, value: number, maxSize: number, eight: boolean): void {
  const seen = new Uint8Array(W * H)
  const queue = new Int32Array(W * H)
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || mask[s] !== value) continue
    let head = 0, tail = 0, border = false
    queue[tail++] = s
    seen[s] = 1
    while (head < tail) {
      const i = queue[head++]
      const x = i % W, y = (i / W) | 0
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true
      for (let k = 0; k < 8; k += eight ? 1 : 2) {
        const nx = x + N8[k][0], ny = y + N8[k][1]
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const j = ny * W + nx
        if (!seen[j] && mask[j] === value) { seen[j] = 1; queue[tail++] = j }
      }
    }
    if (!border && tail < maxSize) for (let q = 0; q < tail; q++) mask[queue[q]] = 1 - value
  }
}

/** Mọi điểm đi được nối (4 hướng) với mép ảnh thật (không tính viền đệm) coi là bên ngoài. Trả số điểm bị loại. */
function dropOutside(free: Uint8Array, W: number, H: number): number {
  const queue = new Int32Array(W * H)
  let head = 0, tail = 0
  const push = (x: number, y: number) => { const i = y * W + x; if (free[i]) { free[i] = 0; queue[tail++] = i } }
  for (let x = 1; x < W - 1; x++) { push(x, 1); push(x, H - 2) }
  for (let y = 1; y < H - 1; y++) { push(1, y); push(W - 2, y) }
  while (head < tail) {
    const i = queue[head++]
    const x = i % W, y = (i / W) | 0
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1)
  }
  return tail
}

/** Khoảng cách tới vật cản gần nhất (đơn vị 1/3 pixel, chamfer 3-4); vật cản = 0. */
function chamfer(free: Uint8Array, W: number, H: number): Int32Array {
  const INF = 1 << 28
  const d = new Int32Array(W * H)
  for (let i = 0; i < d.length; i++) d[i] = free[i] ? INF : 0
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      if (!d[i]) continue
      d[i] = Math.min(d[i], d[i - 1] + 3, d[i - W - 1] + 4, d[i - W] + 3, d[i - W + 1] + 4)
    }
  }
  for (let y = H - 2; y >= 1; y--) {
    for (let x = W - 2; x >= 1; x--) {
      const i = y * W + x
      if (!d[i]) continue
      d[i] = Math.min(d[i], d[i + 1] + 3, d[i + W + 1] + 4, d[i + W] + 3, d[i + W - 1] + 4)
    }
  }
  return d
}

/** Số mảng liền nhau của các điểm lân cận (số lần chuyển 0→1 quanh điểm) và số điểm lân cận. */
function around(img: Uint8Array, i: number, W: number): { a: number; b: number } {
  let a = 0, b = 0
  let prev = img[i + N8[7][0] + N8[7][1] * W]
  for (let k = 0; k < 8; k++) {
    const v = img[i + N8[k][0] + N8[k][1] * W]
    if (v && !prev) a++
    if (v) b++
    prev = v
  }
  return { a, b }
}

/** Làm mảnh Zhang–Suen: lột dần mép cho tới khi còn nét một pixel, rồi bỏ các điểm góc thừa (bậc thang) mà không làm đứt nét. */
function thin(img: Uint8Array, W: number, H: number): void {
  const del: number[] = []
  let changed = true
  while (changed) {
    changed = false
    for (let step = 0; step < 2; step++) {
      del.length = 0
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x
          if (!img[i]) continue
          const p2 = img[i - W], p4 = img[i + 1], p6 = img[i + W], p8 = img[i - 1]
          const { a, b } = around(img, i, W)
          if (b < 2 || b > 6 || a !== 1) continue
          if (step === 0 ? p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0 : p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue
          del.push(i)
        }
      }
      for (const i of del) img[i] = 0
      if (del.length > 0) changed = true
    }
  }
  // Điểm có ≥ 2 lân cận liền một mảng là thừa (bỏ đi nét vẫn liền): dọn cho tới khi hết.
  do {
    changed = false
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x
        if (!img[i]) continue
        const { a, b } = around(img, i, W)
        if (a === 1 && b >= 2) { img[i] = 0; changed = true }
      }
    }
  } while (changed)
}

// --- đồ thị -----------------------------------------------------------------------------------------

type GEdge = { a: number; b: number; px: number[]; dead?: boolean }
type Graph = { nodes: { x: number; y: number }[]; edges: GEdge[] }

function pathLenPx(g: Graph, e: GEdge, W: number): number {
  const pts = [g.nodes[e.a], ...e.px.map((i) => ({ x: i % W, y: (i / W) | 0 })), g.nodes[e.b]]
  let n = 0
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return n
}

/** Từ nét một pixel dựng đồ thị: ngã rẽ (cụm điểm ngã rẽ) và đầu cụt là nút, các điểm giữa là đường. */
function buildGraph(sk: Uint8Array, W: number, H: number): Graph {
  const nodeAt = new Int32Array(W * H).fill(-1)
  const nodes: { x: number; y: number }[] = []
  const clusters: number[][] = []
  const kind = new Int8Array(W * H)  // 1 đầu cụt, 2 đường, 3 ngã rẽ
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      if (!sk[i]) continue
      const { a, b } = around(sk, i, W)
      if (b === 0) continue
      kind[i] = a >= 3 ? 3 : a === 2 ? 2 : 1
    }
  }
  for (let s = 0; s < W * H; s++) {
    if (nodeAt[s] >= 0 || (kind[s] !== 1 && kind[s] !== 3)) continue
    const id = nodes.length
    const members: number[] = [s]
    nodeAt[s] = id
    for (let q = 0; q < members.length && kind[s] === 3; q++) {
      const i = members[q]
      for (const [dx, dy] of N8) {
        const j = i + dx + dy * W
        if (kind[j] === 3 && nodeAt[j] < 0) { nodeAt[j] = id; members.push(j) }
      }
    }
    clusters.push(members)
    nodes.push({ x: members.reduce((a, i) => a + (i % W), 0) / members.length, y: members.reduce((a, i) => a + ((i / W) | 0), 0) / members.length })
  }
  const edges: GEdge[] = []
  const visited = new Uint8Array(W * H)
  // Đi từ điểm `origin` của nút `from` qua điểm `start` cho tới khi gặp nút khác (hoặc quay về chính nút đó thì thành vòng).
  const walk = (from: number, origin: number, start: number): void => {
    let prev = origin, cur = start
    const px: number[] = []
    for (;;) {
      if (nodeAt[cur] >= 0) { edges.push({ a: from, b: nodeAt[cur], px }); return }
      visited[cur] = 1
      px.push(cur)
      let next = -1
      for (const [dx, dy] of N8) {
        const j = cur + dx + dy * W
        if (!sk[j] || j === prev || (visited[j] && nodeAt[j] < 0)) continue
        if (px.length <= 2 && nodeAt[j] === from) continue  // ngay sau khi rời nút, đừng quay lại điểm khác của cùng nút (cụm điểm ngã rẽ)
        if (nodeAt[j] >= 0) { next = j; break }  // gặp nút thì dừng ở nút, không rẽ sang nhánh kề bên
        if (next < 0) next = j
      }
      if (next < 0) {  // cụt bất ngờ giữa đường: lấy chính điểm này làm đầu cụt
        const id = nodes.length
        nodeAt[cur] = id
        nodes.push({ x: cur % W, y: (cur / W) | 0 })
        px.pop()
        edges.push({ a: from, b: id, px })
        return
      }
      prev = cur
      cur = next
    }
  }
  const direct = new Set<string>()
  for (let id = 0; id < clusters.length; id++) {
    for (const i of clusters[id]) {
      for (const [dx, dy] of N8) {
        const j = i + dx + dy * W
        if (!sk[j] || nodeAt[j] === id) continue
        if (nodeAt[j] >= 0) {  // hai nút kề nhau
          const key = `${Math.min(id, nodeAt[j])}_${Math.max(id, nodeAt[j])}`
          if (!direct.has(key)) { direct.add(key); edges.push({ a: id, b: nodeAt[j], px: [] }) }
        } else if (!visited[j]) walk(id, i, j)
      }
    }
  }
  // vòng khép kín không có ngã rẽ nào: lấy một điểm làm nút rồi đi hết vòng
  for (let s = 0; s < W * H; s++) {
    if (!sk[s] || visited[s] || nodeAt[s] >= 0 || kind[s] !== 2) continue
    const id = nodes.length
    nodeAt[s] = id
    nodes.push({ x: s % W, y: (s / W) | 0 })
    for (const [dx, dy] of N8) {
      const j = s + dx + dy * W
      if (sk[j] && !visited[j] && nodeAt[j] < 0) { walk(id, s, j); break }
    }
  }
  return { nodes, edges }
}

/** Cạnh quay về chính nút của nó (vòng): chẻ đôi bằng một nút ở giữa để mọi làn nối hai điểm khác nhau; vòng quá ngắn thì bỏ. */
function splitLoops(g: Graph, W: number): void {
  for (const e of [...g.edges]) {
    if (e.a !== e.b) continue
    if (e.px.length < 3) { e.dead = true; continue }
    const m = e.px.length >> 1
    const mid = e.px[m]
    const id = g.nodes.length
    g.nodes.push({ x: mid % W, y: (mid / W) | 0 })
    const tail = e.px.slice(m + 1)
    e.px = e.px.slice(0, m)
    e.b = id
    g.edges.push({ a: id, b: e.a, px: tail })
  }
}

const live = (g: Graph) => g.edges.filter((e) => !e.dead)

function degrees(g: Graph): number[] {
  const d = new Array<number>(g.nodes.length).fill(0)
  for (const e of live(g)) { d[e.a]++; d[e.b]++ }
  return d
}

/**
 * Cắt nhánh cụt ngắn (một đầu là đầu cụt), gộp hai ngã rẽ nằm sát nhau (chỗ hai hành lang cắt nhau hay tách thành hai ngã ba cách vài pixel)
 * thành một, rồi nối các nút chỉ có hai đường thành một đường; lặp tới khi không còn gì đổi.
 */
function pruneAndMerge(g: Graph, W: number, spurPx: number, joinPx: number): void {
  for (let changed = true; changed;) {
    changed = false
    const deg = degrees(g)
    for (const e of live(g)) {
      if ((deg[e.a] === 1 || deg[e.b] === 1) && pathLenPx(g, e, W) < spurPx) { e.dead = true; changed = true }
    }
    if (changed) continue
    for (const e of live(g)) {
      if (e.a === e.b || deg[e.a] < 3 || deg[e.b] < 3 || pathLenPx(g, e, W) >= joinPx) continue
      const A = g.nodes[e.a], B = g.nodes[e.b]
      g.nodes[e.a] = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 }
      for (const o of g.edges) {
        if (o === e || o.dead) continue
        if (o.a === e.b) o.a = e.a
        if (o.b === e.b) o.b = e.a
      }
      e.dead = true
      splitLoops(g, W)
      changed = true
      break
    }
    if (changed) continue
    for (let n = 0; n < g.nodes.length; n++) {
      if (deg[n] !== 2) continue
      const inc = live(g).filter((e) => e.a === n || e.b === n)
      if (inc.length !== 2) continue
      const [e1, e2] = inc
      const o1 = e1.a === n ? e1.b : e1.a
      const o2 = e2.a === n ? e2.b : e2.a
      if (o1 === o2) continue  // nối lại sẽ thành vòng quay về chính nó
      const p1 = e1.b === n ? e1.px : [...e1.px].reverse()  // o1 → n
      const p2 = e2.a === n ? e2.px : [...e2.px].reverse()  // n → o2
      const nodeIdx = Math.round(g.nodes[n].y) * W + Math.round(g.nodes[n].x)
      e1.dead = e2.dead = true
      g.edges.push({ a: o1, b: o2, px: [...p1, nodeIdx, ...p2] })
      changed = true
      break
    }
  }
}

/** Bỏ các cụm đường nối liền nhau có tổng chiều dài nhỏ hơn `minPx`. */
function dropSmallComponents(g: Graph, W: number, minPx: number): void {
  const parent = g.nodes.map((_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  const edges = live(g)
  for (const e of edges) parent[find(e.a)] = find(e.b)
  const total = new Map<number, number>()
  for (const e of edges) total.set(find(e.a), (total.get(find(e.a)) ?? 0) + pathLenPx(g, e, W))
  for (const e of edges) if ((total.get(find(e.a)) ?? 0) < minPx) e.dead = true
}

// --- chạy cả quy trình -------------------------------------------------------------------------------

export function traceFree(g: Gray, o: TraceOptions): Trace {
  const W = g.w + 2, H = g.h + 2
  const thr = o.threshold ?? otsu(g)
  const free = new Uint8Array(W * H)
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const v = g.data[y * g.w + x]
      free[(y + 1) * W + x + 1] = (o.freeIs === 'light' ? v > thr : v <= thr) ? 1 : 0
    }
  }
  const count = (m: Uint8Array) => m.reduce((a, v) => a + v, 0)
  if (o.minSpeckPx && o.minSpeckPx > 0) flipSmall(free, W, H, 0, o.minSpeckPx, true)
  const before = count(free)
  let outside = 0
  if (o.excludeOutside) outside = dropOutside(free, W, H)
  // pixel (u, v) của ảnh ↔ mét trên bản đồ, kể cả khi ảnh xoay quanh tâm
  const ang = ((o.rotDeg ?? 0) * Math.PI) / 180, cos = Math.cos(ang), sin = Math.sin(ang)
  const cx = o.origin.x + (g.w * o.mPerPx) / 2, cy = o.origin.y + (g.h * o.mPerPx) / 2
  const pxM = (u: number, v: number): Pt => {
    const dx = (u - g.w / 2) * o.mPerPx, dy = (v - g.h / 2) * o.mPerPx
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
  }
  const mPx = (q: Pt): Pt => {
    const dx = q.x - cx, dy = q.y - cy
    return { x: (dx * cos + dy * sin) / o.mPerPx + g.w / 2, y: (-dx * sin + dy * cos) / o.mPerPx + g.h / 2 }
  }
  for (const k of o.keepouts ?? []) {
    const inPx = k.poly.map(mPx)
    const xs = inPx.map((q) => q.x), ys = inPx.map((q) => q.y)
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1), x1 = Math.min(g.w - 1, Math.ceil(Math.max(...xs)) + 1)
    const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1), y1 = Math.min(g.h - 1, Math.ceil(Math.max(...ys)) + 1)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (pointInPolygon(pxM(x + 0.5, y + 0.5), k.poly)) free[(y + 1) * W + x + 1] = 0
      }
    }
  }
  const none = (note: string): Trace => ({ nodes: [], edges: [], note })
  if (count(free) === 0) {
    return none(outside > 0 && outside === before
      ? 'Ảnh không tìm thấy lối đi nào bên trong: tường ngoài có thể chưa khép kín nên cả sàn bị coi là bên ngoài. Tắt "Bỏ phần ngoài tường" rồi dò lại.'
      : 'Ảnh không tìm thấy lối đi nào: thử đổi "Đường là vùng sáng/tối" hoặc chỉnh ngưỡng sáng tối.')
  }
  const dt = chamfer(free, W, H)
  const rPx = Math.max(1, o.minWidthM / 2 / o.mPerPx)
  const core = new Uint8Array(W * H)
  for (let i = 0; i < core.length; i++) core[i] = dt[i] >= rPx * 3 ? 1 : 0
  if (count(core) === 0) return none(`Ảnh không tìm thấy lối đi nào rộng từ ${o.minWidthM} m: giảm bề rộng tối thiểu của xe hoặc kiểm tra lại tỉ lệ ảnh.`)
  thin(core, W, H)

  const graph = buildGraph(core, W, H)
  splitLoops(graph, W)
  pruneAndMerge(graph, W, o.spurM / o.mPerPx, Math.max(3, rPx * 2))

  if (o.minComponentM && o.minComponentM > 0) dropSmallComponents(graph, W, o.minComponentM / o.mPerPx)
  const edgesAll = live(graph)
  if (edgesAll.length === 0) return none('Ảnh không tìm thấy đường nào đủ dài sau khi cắt nhánh cụt: giảm "Bỏ nhánh cụt ngắn hơn".')
  const toM = (x: number, y: number): Pt => pxM(x - 1 + 0.5, y - 1 + 0.5)
  const tol = Math.min(o.simplifyM, 0.6 * (o.minWidthM / 2))  // nhỏ hơn khoảng hở tới vật cản để đường đơn giản hoá không chạm vật cản
  const used = new Map<number, number>()
  const outNodes: TraceNode[] = []
  const nodeId = (n: number) => {
    if (!used.has(n)) { used.set(n, outNodes.length); outNodes.push({ id: outNodes.length, ...toM(graph.nodes[n].x, graph.nodes[n].y) }) }
    return used.get(n)!
  }
  const edges: TraceEdge[] = edgesAll.map((e) => {
    const pts = [toM(graph.nodes[e.a].x, graph.nodes[e.a].y), ...e.px.map((i) => toM(i % W, (i / W) | 0)), toM(graph.nodes[e.b].x, graph.nodes[e.b].y)]
    const s = simplify(pts, tol)
    let len = 0
    for (let i = 1; i < s.length; i++) len += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y)
    const widthPx = e.px.length > 0 ? (e.px.reduce((a, i) => a + dt[i], 0) / e.px.length / 3) * 2 : rPx * 2
    return { a: nodeId(e.a), b: nodeId(e.b), via: s.slice(1, -1), lengthM: len, widthM: widthPx * o.mPerPx }
  })
  return { nodes: outNodes, edges }
}

/**
 * Thêm kết quả dò vào bản đồ: mỗi cạnh thành một đường hai chiều giữa hai ngã tư mới (kiểu junction), sức chứa 2 nếu lối rộng từ 1,8 m, không thì 1.
 * Đường cắt vùng cấm có sẵn của bản đồ bị bỏ (đếm ở `dropped`). Kết quả rỗng thì trả nguyên bản đồ.
 */
export function traceToMap(m: AgvMap, t: Trace): { map: AgvMap; added: number; dropped: number } {
  if (t.edges.length === 0) return { map: m, added: 0, dropped: 0 }
  const nodeAt = new Map(t.nodes.map((n) => [n.id, n]))
  const bad = (a: Pt, via: Pt[], b: Pt) => {
    const poly = [a, ...via, b]
    return (m.keepouts ?? []).some((k) => poly.some((_, i) => i > 0 && segmentEntersPolygon(poly[i - 1], poly[i], k.poly)))
  }
  let map: AgvMap = m
  const ids = new Map<number, string>()
  const pointOf = (id: number): string => {
    if (!ids.has(id)) {
      const pid = nextId('J', map.points.map((p) => p.id))
      const n = nodeAt.get(id)!
      map = { ...map, points: [...map.points, { id: pid, x: Math.round(n.x * 100) / 100, y: Math.round(n.y * 100) / 100, kind: 'junction' }] }
      ids.set(id, pid)
    }
    return ids.get(id)!
  }
  let added = 0, dropped = 0
  const laneIds = map.lanes.map((l) => l.id)
  const newLanes: MapLane[] = []
  for (const e of t.edges) {
    const a = nodeAt.get(e.a)!, b = nodeAt.get(e.b)!
    if (bad(a, e.via, b)) { dropped++; continue }
    const from = pointOf(e.a), to = pointOf(e.b)
    const cap = e.widthM >= 1.8 ? 2 : 1
    const via = e.via.map((q) => ({ x: Math.round(q.x * 100) / 100, y: Math.round(q.y * 100) / 100 }))
    // Hai đường song song giữa cùng hai nút (vd. nửa vòng) là hợp lệ nên không dùng addLane (nó bỏ làn trùng đầu cuối).
    const lane = (f: string, tt: string, path: Pt[]): MapLane => {
      const id = nextId('L', laneIds)
      laneIds.push(id)
      return { id, from: f, to: tt, capacity: cap, ...(path.length > 0 ? { path } : {}) }
    }
    newLanes.push(lane(from, to, via), lane(to, from, [...via].reverse()))
    added++
  }
  if (newLanes.length > 0) map = { ...map, lanes: [...map.lanes, ...newLanes] }
  return { map, added, dropped }
}
