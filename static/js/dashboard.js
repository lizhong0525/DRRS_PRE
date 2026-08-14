/* ===========================================================================
   Dashboard frontend
   - SSE console
   - Drone telemetry polling + canvas
   - Image list → detection
   - Stats / history / class histogram
   - Expand overlay
   ========================================================================== */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ----- global state ----- */
const state = {
  images: [],
  history: [],
  selected: null,
  detectCount: 0,
  totalImg: 0,
  last: null,
  classes: {},
  stats: { total: 0, risk: 0, normal: 0, ms: 0 },
  drone: { trail: [], trailMax: 200 },
  running: false,
  abort: null,
};

/* ============================================================================
   1) SSE console
============================================================================ */
function setupConsole() {
  const log = $('#console-log');
  let buf = [];
  let pending = null;

  const flush = () => {
    pending = null;
    if (!buf.length) return;
    const frag = document.createDocumentFragment();
    for (const ln of buf) {
      const m = document.createElement('div');
      m.className = 'ln ' + (ln.startsWith('  ↳') ? 'det-sub'
                          : ln.includes('detect:') ? 'detect'
                          : ln.includes('drone:')  ? 'drone'
                          : ln.includes('system:') ? 'system'
                          : ln.includes('link:')   ? 'link'
                          : ln.includes('WARN') || ln.includes('error') ? 'warn'
                          : '');
      m.textContent = ln;
      frag.appendChild(m);
    }
    log.appendChild(frag);
    buf.length = 0;
    // auto-scroll
    log.scrollTop = log.scrollHeight;
  };
  const enqueue = (ln) => {
    buf.push(ln);
    if (!pending) pending = setTimeout(flush, 40);
  };

  if (window.EventSource) {
    const es = new EventSource('/api/console');
    es.onmessage = (e) => enqueue(e.data);
    es.onerror   = () => {
      enqueue('[error] console stream lost');
    };
  } else {
    enqueue('[warn] EventSource not supported in this browser');
  }
}

/* ============================================================================
   2) Drone telemetry
   The canvas follows a fixed, smoothed railway corridor fetched from /api/path.
   The drone is drawn over the corridor as a moving marker.
============================================================================ */
function setupDrone() {
  const canvas = $('#drone-canvas');
  const ctx = canvas.getContext('2d');

  function fitCanvas() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width  = Math.max(1, Math.round(r.width  * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  fitCanvas();
  window.addEventListener('resize', () => { fitCanvas(); drawDrone(); });

  // Pre-fetch the static path; without it we have nothing to draw.
  async function fetchPath() {
    const r = await fetch('/api/path');
    const j = await r.json();
    state.drone.path = j.points;
    // compute stable bounds
    let mnLat =  Infinity, mxLat = -Infinity, mnLon =  Infinity, mxLon = -Infinity;
    for (const p of j.points) {
      if (p.lat < mnLat) mnLat = p.lat;
      if (p.lat > mxLat) mxLat = p.lat;
      if (p.lon < mnLon) mnLon = p.lon;
      if (p.lon > mxLon) mxLon = p.lon;
    }
    const padLat = Math.max(1e-5, (mxLat - mnLat) * 0.18);
    const padLon = Math.max(1e-5, (mxLon - mnLon) * 0.18);
    state.drone.bbox = {
      minLat: mnLat - padLat, maxLat: mxLat + padLat,
      minLon: mnLon - padLon, maxLon: mxLon + padLon,
    };
  }

  function latLonToXY(lat, lon) {
    const { minLat, maxLat, minLon, maxLon } = state.drone.bbox;
    const r = canvas.getBoundingClientRect();
    const u = (lon - minLon) / (maxLon - minLon);
    const v = 1 - (lat - minLat) / (maxLat - minLat);
    return { x: u * r.width, y: v * r.height };
  }

  // unit normal at point i along the smoothed path (used for parallel rails)
  function normalAt(i) {
    const pts = state.drone.path;
    const n = pts.length;
    const a = pts[(i - 1 + n) % n];
    const b = pts[(i + 1) % n];
    const dx = b.lon - a.lon;
    const dy = b.lat - a.lat;  // (lat, lon) -> (y, x) in screen terms
    const len = Math.hypot(dx, dy) || 1;
    // left perpendicular in lon/lat space: (-dy, dx)/len
    return { nx: -dy / len, ny: dx / len };
  }

  function pathToCanvasOffsets(offsetMeters) {
    // convert a perpendicular offset (meters) into approximate lat/lon delta
    const offset = offsetMeters / 111320.0;
    const out = [];
    for (let i = 0; i < state.drone.path.length; i++) {
      const p = state.drone.path[i];
      const nm = normalAt(i);
      out.push({
        lat: p.lat + nm.ny * offset,
        lon: p.lon + nm.nx * offset,
      });
    }
    return out;
  }

  function drawStaticRailway() {
    if (!state.drone.path || !state.drone.bbox) return;
    const r = canvas.getBoundingClientRect();
    const w = r.width, h = r.height;

    // 1) railway background (dim) — two parallel rails offset 0.7 m either side
    const railOffset = 0.7;  // meters
    const upper = pathToCanvasOffsets( railOffset);
    const lower = pathToCanvasOffsets(-railOffset);
    const path  = state.drone.path;

    // soft fill band between rails (ballast bed)
    ctx.beginPath();
    const p0 = latLonToXY(upper[0].lat, upper[0].lon);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < upper.length; i++) {
      const p = latLonToXY(upper[i].lat, upper[i].lon);
      ctx.lineTo(p.x, p.y);
    }
    for (let i = lower.length - 1; i >= 0; i--) {
      const p = latLonToXY(lower[i].lat, lower[i].lon);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(180,150,120,.10)';
    ctx.fill();

    // ties (sleepers) — short perpendiculars every ~12 m along the path
    ctx.strokeStyle = 'rgba(220,200,170,.18)';
    ctx.lineWidth = 1.2;
    // sample ties every Nth path vertex; the smoothed path has 24*14 ≈ 336 pts
    const step = 8;
    for (let i = 0; i < path.length; i += step) {
      const u = latLonToXY(upper[i].lat, upper[i].lon);
      const l = latLonToXY(lower[i].lat, lower[i].lon);
      ctx.beginPath();
      ctx.moveTo(u.x, u.y);
      ctx.lineTo(l.x, l.y);
      ctx.stroke();
    }

    // rails themselves (two bright strokes)
    ctx.strokeStyle = 'rgba(220,210,200,.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    upper.forEach((pt, i) => {
      const p = latLonToXY(pt.lat, pt.lon);
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.beginPath();
    lower.forEach((pt, i) => {
      const p = latLonToXY(pt.lat, pt.lon);
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    });
    ctx.stroke();
  }

  function drawDrone() {
    const r = canvas.getBoundingClientRect();
    const w = r.width, h = r.height;
    ctx.clearRect(0, 0, w, h);

    // background grid
    ctx.strokeStyle = 'rgba(120,170,255,.06)';
    ctx.lineWidth = 1;
    const gridStep = 24;
    for (let x = 0; x < w; x += gridStep) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += gridStep) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    drawStaticRailway();

    // live trail (last few seconds of flight)
    if (state.drone.trail.length > 1 && state.drone.bbox) {
      const pts = state.drone.trail.map(p => latLonToXY(p.lat, p.lon));
      // soft glow underlay
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(120,200,255,.25)';
      ctx.beginPath();
      pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      // bright trail
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(120,200,255,.85)';
      ctx.beginPath();
      pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();

      // drone marker
      const head = pts[pts.length - 1];
      // halo
      const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 22);
      g.addColorStop(0, 'rgba(120,200,255,.7)');
      g.addColorStop(1, 'rgba(120,200,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(head.x, head.y, 22, 0, 2*Math.PI); ctx.fill();
      // triangle pointing heading
      ctx.save();
      ctx.translate(head.x, head.y);
      // canvas y is inverted vs lat (north is up), so we rotate by -heading - 90
      // heading 0 = north = up; we want a triangle to point along the heading.
      ctx.rotate((state.drone.heading - 90) * Math.PI / 180);
      ctx.fillStyle = '#5af';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, -11);
      ctx.lineTo(8, 9);
      ctx.lineTo(0, 5);
      ctx.lineTo(-8, 9);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }

  async function poll() {
    try {
      if (!state.drone.bbox) await fetchPath();
      const r = await fetch('/api/drone');
      const d = await r.json();

      state.drone.trail.push({ lat: d.lat, lon: d.lon, h: d.heading });
      if (state.drone.trail.length > state.drone.trailMax) state.drone.trail.shift();

      // update fields
      $('#d-lat').innerHTML  = d.lat.toFixed(5);
      $('#d-lon').innerHTML  = d.lon.toFixed(5);
      $('#d-alt').innerHTML  = d.alt.toFixed(1) + '<i>m</i>';
      $('#d-hdg').innerHTML  = d.heading.toFixed(0) + '<i>°</i>';
      $('#d-spd').innerHTML  = d.speed.toFixed(1) + '<i>m/s</i>';
      const bat = Math.max(0, Math.min(100, d.battery));
      $('#d-bat').style.width = bat.toFixed(1) + '%';
      $('#d-bat-text').textContent = bat.toFixed(1) + '%';
      $('#d-gps').textContent = d.gps_fix;
      $('#d-sig').textContent = d.signal;
      $('#d-mode').textContent = d.mode;

      state.drone.heading = d.heading;
      drawDrone();
    } catch (e) {
      // ignore
    } finally {
      setTimeout(poll, 500);
    }
  }

  fetchPath().then(() => { drawDrone(); poll(); });
}

/* ============================================================================
   3) Image list + detection
   Patrol sequence: every slot looks identical initially. Only after inference
   confirms mud_pumping does the UI retroactively flag that slot red.
============================================================================ */
async function loadImages() {
  const r = await fetch('/api/images');
  const d = await r.json();
  state.images = d.images;
  state.totalImg = d.images.length;
  state.detectCount = 0;
  state.discoveredRisks = [];

  const ul = $('#img-patrol');
  ul.innerHTML = '';
  for (const img of state.images) {
    const li = document.createElement('li');
    li.className = '';
    li.dataset.id  = img.id;
    li.dataset.idx = img.index;
    li.innerHTML = `
      <span class="idx">#${String(img.index).padStart(2,'0')}</span>
      <span class="name" title="${img.name}">${img.name}</span>
      <span class="badge pending">待检测</span>
    `;
    li.addEventListener('click', () => selectImage(img));
    ul.appendChild(li);
  }
  $('#detect-count').textContent = `0 / ${state.totalImg}`;
  $('#seq-total').textContent = state.totalImg;
  $('#seq-done').textContent  = 0;
}

function selectImage(img) {
  state.selected = img;
  $$('.img-list li').forEach(el => el.classList.toggle('active', el.dataset.id === img.id));
  const stage = $('#detect-stage');
  stage.classList.remove('empty');
  stage.innerHTML = '';
  const imgEl = document.createElement('img');
  imgEl.src = `/static/original/${img.name}`;
  imgEl.alt = img.name;
  stage.appendChild(imgEl);
  const ovr = document.createElement('div');
  ovr.className = 'overlay-info';
  ovr.innerHTML = `
    <span class="oi">#${String(img.index).padStart(2,'0')} · ${img.name}</span>
    <span class="oi">待检测样本</span>
    <span class="oi">未确认</span>
  `;
  stage.appendChild(ovr);
}

function setSlotState(img, outcome, tier) {
  // outcome: 'pending' | 'ok' | 'risk'
  // tier:    'high' | 'suspect' | 'unconfirmed' | undefined  (only when outcome==='risk')
  const li = $(`.img-list li[data-id="${img.id}"]`);
  if (!li) return;
  li.classList.remove('detected-ok', 'detected-risk');
  const badge = li.querySelector('.badge');
  if (outcome === 'ok') {
    li.classList.add('detected-ok');
    badge.className = 'badge ok';
    badge.textContent = '正常';
  } else if (outcome === 'risk') {
    li.classList.add('detected-risk');
    badge.className = `badge ${tier || 'risk'}`;
    const label = tier === 'high' ? '高危' : tier === 'suspect' ? '疑似' : '待确认';
    badge.textContent = `⚠ ${label}`;
  } else {
    badge.className = 'badge pending';
    badge.textContent = '待检测';
  }
}

// Show / hide the persistent alarm banner; reflect count + tier breakdown.
function updateRiskBanner() {
  const banner = $('#risk-banner');
  if (!banner) return;
  const risks = state.discoveredRisks || [];
  const total = risks.length;
  // aggregate tier counts across all risk discoveries
  let high = 0, suspect = 0, unconfirmed = 0;
  for (const r of risks) {
    if (r.tier_counts) {
      high         += r.tier_counts.high         || 0;
      suspect      += r.tier_counts.suspect      || 0;
      unconfirmed  += r.tier_counts.unconfirmed  || 0;
    } else if (r.tier_top) {
      if (r.tier_top === 'high')         high++;
      if (r.tier_top === 'suspect')      suspect++;
      if (r.tier_top === 'unconfirmed')  unconfirmed++;
    }
  }
  $('#risk-banner-count').textContent = total;
  $('#risk-banner-high').textContent        = high;
  $('#risk-banner-suspect').textContent     = suspect;
  $('#risk-banner-unconfirmed').textContent = unconfirmed;
  banner.classList.toggle('show', total > 0);
}

async function runDetection(img, opts = {}) {
  const stage = $('#detect-stage');
  const tags = $('#detect-tags');
  const li = $(`.img-list li[data-id="${img.id}"]`);
  if (li) li.classList.add('running');

  // show loading state in stage
  stage.classList.remove('empty');
  stage.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'placeholder';
  wrap.innerHTML = `<div class="ph-icon">⌛</div><div class="ph-text">推理中… #${String(img.index).padStart(2,'0')} · ${img.name}</div>`;
  stage.appendChild(wrap);

  const t0 = performance.now();
  try {
    const ctrl = new AbortController();
    state.abort = ctrl;
    const r = await fetch('/api/detect', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ id: img.id }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'detect failed');

    // render annotated image
    stage.innerHTML = '';
    const out = document.createElement('img');
    out.src = j.annotated_url + '?t=' + Date.now();
    out.alt = img.name;
    stage.appendChild(out);

    const ovr = document.createElement('div');
    ovr.className = 'overlay-info';
    const lvlCls = ({
      '正常':    'ok',
      '待确认':  'warn',
      '疑似':    'suspect',
      '高危':    'risk',
    })[j.risk_level] || '';
    const tierParts = [];
    const tc = j.tier_counts || {};
    if (tc.high)        tierParts.push(`<span class="oi risk">高危 ${tc.high}</span>`);
    if (tc.suspect)     tierParts.push(`<span class="oi suspect">疑似 ${tc.suspect}</span>`);
    if (tc.unconfirmed) tierParts.push(`<span class="oi warn">待确认 ${tc.unconfirmed}</span>`);
    ovr.innerHTML = `
      <span class="oi ${lvlCls}">风险等级: ${j.risk_level}</span>
      ${tierParts.join('')}
      <span class="oi">检测 ${j.n} 个目标</span>
      <span class="oi">${j.inference_ms.toFixed(0)} ms</span>
    `;
    stage.appendChild(ovr);

    // tags (each detection colored by its tier)
    tags.innerHTML = '';
    if (j.detections.length === 0) {
      const t = document.createElement('span');
      t.className = 'tag ok'; t.textContent = '无检出';
      tags.appendChild(t);
    } else {
      for (const d of j.detections) {
        const t = document.createElement('span');
        const cls = d.tier === 'high' ? 'risk' : d.tier === 'suspect' ? 'suspect' : 'warn';
        t.className = `tag ${cls}`;
        t.textContent = `${d.tier_cn} · ${d.class_cn} · ${(d.conf*100).toFixed(1)}%`;
        tags.appendChild(t);
      }
    }

    // discovery: only NOW mark the slot — coloured by highest tier in image
    if (j.n > 0) {
      const tier_top = j.risk_level === '高危' ? 'high'
                     : j.risk_level === '疑似' ? 'suspect'
                     : 'unconfirmed';
      setSlotState(img, 'risk', tier_top);
      state.discoveredRisks.push({
        idx: img.index,
        name: img.name,
        tier_top,
        tier_counts: j.tier_counts,
        confs: j.detections.map(x=>x.conf),
      });
      updateRiskBanner();
    } else {
      setSlotState(img, 'ok');
    }

    // update last + history
    state.last = j;
    state.history.push({
      id: img.id,
      name: img.name,
      idx: img.index,
      n: j.n,
      confs: j.detections.map(x => x.conf),
      ms: j.inference_ms,
      ts: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      risk_level: j.risk_level,
    });
    if (state.history.length > 24) state.history.shift();

    refreshStatsLocal(j);

    // update counter
    state.detectCount = Math.min(state.totalImg, state.detectCount + 1);
    $('#detect-count').textContent = `${state.detectCount} / ${state.totalImg}`;
    $('#seq-done').textContent = state.detectCount;

    refreshStats();

    console.info('detected', img.name, j);
    return j;
  } catch (e) {
    stage.innerHTML = '';
    const wrap2 = document.createElement('div');
    wrap2.className = 'placeholder';
    wrap2.innerHTML = `<div class="ph-icon" style="color:#ffb1bb">✕</div><div class="ph-text">失败: ${e.message}</div>`;
    stage.appendChild(wrap2);
    throw e;
  } finally {
    if (li) li.classList.remove('running');
  }
}

function refreshStatsLocal(j) {
  // already updated by server; this is for the live UI before next poll
  document.querySelector('#risk-badge').textContent = j.risk_level;
  document.querySelector('#risk-badge').className =
    'hd-status ' + (j.risk_level === '正常' ? '' : (j.risk_level === '高危' ? 'risk' : 'warn'));
}

async function refreshStats() {
  try {
    const r = await fetch('/api/stats');
    const d = await r.json();
    const s = d.stats;
    $('#kpi-total').textContent  = s.total_detections;
    $('#kpi-risk').textContent   = s.risk_detections;
    $('#kpi-normal').textContent = s.normal_detections;
    $('#kpi-ms').innerHTML       = s.avg_inference_ms.toFixed(1) + '<i>ms</i>';
    const rate = s.total_detections > 0 ? (s.risk_detections / s.total_detections * 100) : 0;
    $('#kpi-rate').innerHTML     = rate.toFixed(0) + '<i>%</i>';

    // last detection block
    const lastEl = $('#last-detection');
    if (d.history.length) {
      const h = d.history[d.history.length - 1];
      lastEl.innerHTML = `
        <div class="last-row">
          <span class="kind ${h.kind}">${h.kind === 'normal' ? '正常样本' : '风险样本'}</span>
          <span class="name">${h.id.split('/').pop()}</span>
        </div>
        <div class="last-row">
          <span>检测数</span><b>${h.n}</b>
          <span>用时</span><b>${h.ms} ms</b>
        </div>
        <div class="last-row">
          <span>置信度</span><b>${
            h.confs.length ? h.confs.map(c => (c*100).toFixed(1)+'%').join(' / ') : '—'
          }</b>
        </div>`;
    }

    // class histogram
    const histEl = $('#class-hist');
    const byClass = s.by_class || {};
    const totalClass = Object.values(byClass).reduce((a,b)=>a+b,0);
    if (totalClass === 0) {
      histEl.innerHTML = `<div class="empty">暂无数据</div>`;
    } else {
      const clsLabel = { mud_pumping: '路基翻浆冒泥' };
      histEl.innerHTML = Object.entries(byClass)
        .sort((a,b) => b[1]-a[1])
        .map(([cls, n]) => {
          const pct = (n / totalClass * 100).toFixed(1);
          return `<div class="bar-row">
            <div class="bar-label"><span>${clsLabel[cls] || cls}</span><b>${n} · ${pct}%</b></div>
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          </div>`;
        }).join('');
    }

    // history list
    const histList = $('#history-list');
    if (!d.history.length) {
      histList.innerHTML = `<li class="empty">暂无记录</li>`;
    } else {
      histList.innerHTML = d.history.slice().reverse().map(h => `
        <li>
          <span class="ts">${h.ts}</span>
          <span class="kind ${h.kind}">${h.kind === 'normal' ? '正常' : '风险'}</span>
          <span class="name" title="${h.id}">${h.id.split('/').pop()}</span>
          <span class="n ${h.n === 0 ? 'zero' : 'has'}">×${h.n}</span>
          <span class="ms">${h.ms}ms</span>
        </li>
      `).join('');
    }
  } catch (e) {
    /* ignore */
  }
}

/* ============================================================================
   4) Auto-run "discovery" patrol: walks the patrol sequence top-to-bottom,
      logs each step on the SSE console, and reports an ALARM only when the
      model actually finds mud_pumping (i.e. at slot #15 in the demo set).
============================================================================ */
async function autoRun() {
  if (state.running) return;
  state.running = true;
  const btn = $('#auto-run-btn');
  btn.disabled = true;
  btn.textContent = '巡检中…';

  // walk through the sequence as ordered by the server (1..N, with #15 hidden
  // inside). the UI doesn't know in advance which one is the risk slot.
  for (const img of state.images) {
    try {
      selectImage(img);
      const j = await runDetection(img);
      // optional extra SSE-side console hint (server already logged the result,
      // but we can add a client-side "patrol step" line for the running log)
      pushClientLog(`patrol:  飞行至 #${String(img.index).padStart(2,'0')}  ${j.n > 0 ? '⚠ 发现翻浆冒泥' : '通过'}  (${j.inference_ms.toFixed(0)} ms)`);
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      console.warn(e);
    }
  }

  pushClientLog(`patrol:  巡检完成 · 共发现 ${state.discoveredRisks.length} 处异常`);

  state.running = false;
  btn.disabled = false;
  btn.textContent = '▶ 自动巡检（发现式）';
}

// append a line into the SSE console buffer locally (used when the server
// hasn't pushed anything yet). matches the visual styling of the SSE feed.
function pushClientLog(line) {
  const log = $('#console-log');
  if (!log) return;
  // route via the same coloring rule the SSE handler uses
  const cls =
       line.startsWith('  ↳')           ? 'det-sub'
     : line.includes('detect:')          ? 'detect'
     : line.includes('drone:')           ? 'drone'
     : line.includes('system:')          ? 'system'
     : line.includes('link:')            ? 'link'
     : line.includes('patrol:') || line.includes('⚠') || line.includes('ALARM') ? 'warn'
     : '';
  const m = document.createElement('div');
  m.className = 'ln ' + cls;
  m.textContent = line;
  log.appendChild(m);
  log.scrollTop = log.scrollHeight;
}

/* ============================================================================
   5) Init
============================================================================ */
async function init() {
  $('#console-log').textContent = '';
  setupConsole();
  setupDrone();
  await loadImages();
  await refreshStats();
  // refresh stats periodically as fallback
  setInterval(refreshStats, 4000);

  $('#auto-run-btn').addEventListener('click', autoRun);
  $('#clear-btn').addEventListener('click', () => {
    state.last = null;
    state.detectCount = 0;
    state.discoveredRisks = [];
    $('#detect-count').textContent = `0 / ${state.totalImg}`;
    $('#seq-done').textContent = 0;
    $('#last-detection').innerHTML = `<div class="empty">尚未执行检测。选择下方图像开始识别 →</div>`;
    $('#detect-stage').classList.add('empty');
    $('#detect-stage').innerHTML = `
      <div class="placeholder">
        <div class="ph-icon">⌖</div>
        <div class="ph-text">选择左侧图像进行 YOLOv11 翻浆冒泥检测</div>
        <div class="ph-hint">支持鼠标拖拽 / 滚轮缩放查看结果</div>
      </div>`;
    $('#detect-tags').innerHTML = '';
    // reset all patrol slots to pending
    $$('.img-list li').forEach(el => {
      el.classList.remove('active', 'detected-ok', 'detected-risk', 'running');
      const b = el.querySelector('.badge');
      if (b) {
        b.className = 'badge pending';
        b.textContent = '待检测';
      }
    });
    updateRiskBanner();
    });
  });

  // expand
  $('#expand-btn').addEventListener('click', openExpand);
  $('#expand-close').addEventListener('click', closeExpand);
  $('#expand-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'expand-overlay') closeExpand();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeExpand();
  });
}

function openExpand() {
  const stage = $('#detect-stage');
  const img = stage.querySelector('img');
  if (!img) return;
  const ex = $('#expand-overlay');
  const exStage = $('#expand-stage');
  const big = document.createElement('img');
  big.src = img.src;
  exStage.innerHTML = '';
  exStage.appendChild(big);
  $('#expand-title').textContent = state.selected ? state.selected.name : '预览';
  ex.classList.remove('hidden');
}
function closeExpand() {
  $('#expand-overlay').classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  // surface any startup failure visibly so the page can self-diagnose
  init().catch((err) => {
    console.error('init() crashed:', err);
    const log = document.querySelector('#console-log');
    if (log) {
      const m = document.createElement('div');
      m.className = 'ln warn';
      m.textContent = '[JS ERROR] init() 失败: ' + (err && err.message ? err.message : String(err));
      log.appendChild(m);
    }
    const title = document.querySelector('.title');
    if (title) title.style.color = '#ff5d6e';
  });
});
