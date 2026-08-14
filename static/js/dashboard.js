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
   Cleaner model: virtual parametric oval orbit, drone loops around it at
   constant ground speed, with a fading motion trail and a heading vector.
   Distance accumulates each frame to drive the 里程 (km) odometer.
============================================================================ */
function setupDrone() {
  const canvas = $('#drone-canvas');
  const ctx = canvas.getContext('2d');

  // Virtual orbit geometry
  const ORBIT_LEN_M  = 6800;            // loop length in metres (visual)
  const NOMINAL_SPEED_MS = 28.0;       // ground speed (visible motion)
  const ORBIT_PERIOD = ORBIT_LEN_M / NOMINAL_SPEED_MS;
  const ORBIT = { cx:0.5, cy:0.55, rxFrac:0.42, ryFrac:0.34 };
  const trail = [];                    // {t,x,y,h}
  let lastSampleMs = performance.now();
  let totalDistance = 0;               // cumulative metres
  const odoEl      = $('#d-odo');
  const odoTripsEl = $('#d-odo-trips');

  function fitCanvas() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width  = Math.max(1, Math.round(r.width  * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  fitCanvas();
  window.addEventListener('resize', () => { fitCanvas(); drawScene(); });

  // 0..1 progress → (x, y, heading-deg-cw-from-north) on the oval
  function posOnOrbit(t) {
    const r = canvas.getBoundingClientRect();
    const w = r.width, h = r.height;
    const cx = w * ORBIT.cx, cy = h * ORBIT.cy;
    const rx = w * ORBIT.rxFrac, ry = h * ORBIT.ryFrac;
    const theta = -2 * Math.PI * (t % 1);
    const x  = cx + rx * Math.cos(theta);
    const y  = cy + ry * Math.sin(theta);
    const tx = -rx * Math.sin(theta);
    const ty =  ry * Math.cos(theta);
    let hdg = Math.atan2(tx, -ty) * 180 / Math.PI;
    hdg = (hdg + 360) % 360;
    return { x, y, hdg };
  }

  function drawOrbit() {
    const r = canvas.getBoundingClientRect();
    const w = r.width, h = r.height;
    const cx = w * ORBIT.cx, cy = h * ORBIT.cy;
    const rx = w * ORBIT.rxFrac, ry = h * ORBIT.ryFrac;

    // 1) soft ground gradient inside the oval
    const grd = ctx.createRadialGradient(cx, cy, Math.min(rx, ry)*0.3, cx, cy, Math.max(rx, ry)*1.0);
    grd.addColorStop(0, 'rgba(80,140,180,0.10)');
    grd.addColorStop(1, 'rgba(80,140,180,0.00)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx*0.92, ry*0.92, 0, 0, Math.PI*2);
    ctx.fill();

    // 2) outer fence ring
    ctx.strokeStyle = 'rgba(110,160,200,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI*2);
    ctx.stroke();

    // 3) railway: ballast fill + ties + two rails
    const railGap = 4;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx + railGap + 4, ry + railGap + 4, 0, 0, Math.PI*2);
    ctx.ellipse(cx, cy, rx - railGap - 4, ry - railGap - 4, 0, Math.PI*2, true);
    ctx.fillStyle = 'rgba(180,150,120,0.10)';
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(220,200,170,0.22)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * 2 * Math.PI;
      const x1 = cx + (rx - railGap) * Math.cos(a);
      const y1 = cy + (ry - railGap) * Math.sin(a);
      const x2 = cx + (rx + railGap) * Math.cos(a);
      const y2 = cy + (ry + railGap) * Math.sin(a);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(220,210,200,0.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx + railGap, ry + railGap, 0, 0, Math.PI*2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx - railGap, ry - railGap, 0, 0, Math.PI*2);
    ctx.stroke();

    // 4) start/finish marker at θ=0 (east)
    const sx = cx + rx, sy = cy;
    ctx.fillStyle = 'rgba(140,200,255,0.9)';
    ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = 'rgba(140,200,255,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(sx, sy, 9, 0, Math.PI*2); ctx.stroke();

    // 5) compass
    ctx.fillStyle = 'rgba(140,160,180,0.55)';
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    [['N', cx, cy - ry - 14],
     ['S', cx, cy + ry + 14],
     ['E', cx + rx + 14, cy],
     ['W', cx - rx - 14, cy]].forEach(([t,x,y]) => ctx.fillText(t, x, y));
  }

  function drawTrail() {
    if (trail.length < 2) return;
    const N = trail.length;
    const now = trail[N - 1].t;
    for (let i = 1; i < N; i++) {
      const age = (now - trail[i].t) / 1000;
      const alpha = Math.max(0.06, 1 - age / 8);
      const a = trail[i - 1], b = trail[i];
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(140,210,255,' + (alpha*0.18) + ')';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(140,210,255,' + (alpha*0.9) + ')';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }

  function drawQuadcopter(x, y, hdgDeg) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((hdgDeg - 90) * Math.PI / 180);
    ctx.fillStyle = 'rgba(140,210,255,0.18)';
    ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI*2); ctx.fill();
    // body diamond
    ctx.fillStyle = '#5af';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, -5); ctx.lineTo(8, 0); ctx.lineTo(0, 5); ctx.lineTo(-8, 0);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // 4 motors
    const motors = [[ 22, 22], [ 22, -22], [-22, 22], [-22, -22]];
    for (const [mx, my] of motors) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(mx * 0.5, my * 0.5); ctx.stroke();
      ctx.fillStyle = '#0a0f1a';
      ctx.strokeStyle = '#5af';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(mx, my, 4.5, 0, Math.PI*2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(140,210,255,0.22)';
      ctx.beginPath(); ctx.ellipse(mx, my, 6.5, 1.5, 0, 0, Math.PI*2); ctx.fill();
    }
    // heading vector
    ctx.strokeStyle = '#cfe4ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(34, 0); ctx.stroke();
    ctx.fillStyle = '#cfe4ff';
    ctx.beginPath(); ctx.moveTo(34, 0); ctx.lineTo(28, -4); ctx.lineTo(28, 4); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawScene(t) {
    const r = canvas.getBoundingClientRect();
    const w = r.width, h = r.height;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(120,170,255,0.06)';
    ctx.lineWidth = 1;
    const step = 24;
    for (let x = 0; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

    drawOrbit();
    drawTrail();
    if (t !== undefined) {
      const p = posOnOrbit(t / ORBIT_PERIOD);
      drawQuadcopter(p.x, p.y, p.hdg);
    }
  }

  async function loop() {
    const now = performance.now();
    const dt = (now - lastSampleMs) / 1000;
    lastSampleMs = now;
    totalDistance += NOMINAL_SPEED_MS * dt;
    const progress = (totalDistance / ORBIT_LEN_M) % 1;
    const tWithin = progress * ORBIT_PERIOD;

    if (odoEl)      odoEl.innerHTML      = (totalDistance/1000).toFixed(3) + '<i>km</i>';
    if (odoTripsEl) odoTripsEl.textContent = Math.floor(totalDistance / ORBIT_LEN_M) + ' 趟';

    const p = posOnOrbit(progress);
    if (trail.length === 0 || (now - trail[trail.length - 1].t) > 80) {
      trail.push({ t: now, x: p.x, y: p.y, h: p.hdg });
      if (trail.length > 120) trail.shift();
    }

    try {
      const r = await fetch('/api/drone');
      const d = await r.json();
      $('#d-lat').textContent  = d.lat.toFixed(5);
      $('#d-lon').textContent  = d.lon.toFixed(5);
      $('#d-alt').textContent  = d.alt.toFixed(1);
      $('#d-hdg').textContent  = d.heading.toFixed(0) + '°';
      $('#d-spd').textContent  = d.speed.toFixed(1);
      const bat = Math.max(0, Math.min(100, d.battery));
      $('#d-bat').style.width = bat.toFixed(1) + '%';
      $('#d-bat-text').textContent = bat.toFixed(1) + '%';
      $('#d-gps').textContent = d.gps_fix;
      $('#d-sig').textContent = d.signal;
      $('#d-mode').textContent = d.mode;
    } catch (e) { /* swallow */ }

    drawScene(tWithin);
    requestAnimationFrame(loop);
  }

  drawScene();
  requestAnimationFrame(loop);
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
      'NORMAL':        'ok',
      'UNCONFIRMED':    'warn',
      'SUSPECT':       'suspect',
      'HIGH':          'risk',
    })[j.risk_level] || '';
    const tierParts = [];
    const tc = j.tier_counts || {};
    if (tc.high)        tierParts.push(`<span class="oi risk">HIGH ${tc.high}</span>`);
    if (tc.suspect)     tierParts.push(`<span class="oi suspect">SUSPECT ${tc.suspect}</span>`);
    if (tc.unconfirmed) tierParts.push(`<span class="oi warn">UNCONFIRMED ${tc.unconfirmed}</span>`);
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
      const tier_top = j.risk_level === 'HIGH' ? 'high'
                     : j.risk_level === 'SUSPECT' ? 'suspect'
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
    'hd-status ' + (j.risk_level === 'NORMAL' ? '' : (j.risk_level === 'HIGH' ? 'risk' : 'warn'));
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
