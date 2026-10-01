// Brimwood hero particle field — brand-kit discipline:
// "Subtle and purposeful… premium, calm, and confident… nothing loud."
// White/mint dots glide smoothly (sine wander, zero per-frame jitter) and
// breathe gently; whisper-faint links; rare slow light-pulses along a link.
// Rendering uses one pre-baked glow sprite for all dots (no per-frame
// gradients) so motion stays at a smooth 60fps on phones too.
(function(){
  const canvas = document.getElementById('stars');
  const hero = document.getElementById('hero');
  if (!canvas || !hero) return;
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const LINK = 130, MINT = '221,245,233', LINK2 = LINK * LINK;
  let W = 0, H = 0, parts = [], pulses = [], ripples = [];
  let nextPulse = 0, dtS = 1 / 60;
  const pointer = { x: -9999, y: -9999 };

  // One glow stamp, reused for every dot — the perf win.
  const glowSprite = (function(){
    const s = document.createElement('canvas');
    s.width = s.height = 64;
    const c = s.getContext('2d');
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.35, 'rgba(221,245,233,0.30)');
    g.addColorStop(1, 'rgba(221,245,233,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
    return s;
  })();

  function resize(){
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = hero.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
    if (reduced) drawStatic();
  }

  function seed(){
    const n = Math.max(48, Math.min(84, Math.floor(W * H / 19000)));
    parts = [];
    for (let i = 0; i < n; i++){
      const ang = Math.random() * Math.PI * 2;
      const spd = 6 + Math.random() * 8;
      parts.push({
        x: Math.random() * W, y: Math.random() * H,
        vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
        // smooth organic wander (sine-based, no random jitter)
        wob: .25 + Math.random() * .45,
        wobAmp: 4 + Math.random() * 5,
        wobPh: Math.random() * Math.PI * 2,
        r: 1.3 + Math.random() * 1.3,
        a: .22 + Math.random() * .28,
        phase: Math.random() * Math.PI * 2,
        breath: .35 + Math.random() * .5,
        boost: 0
      });
    }
  }

  function nearest(x, y, maxD){
    let best = null, bd = maxD;
    for (const p of parts){
      const dx = p.x - x, dy = p.y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bd && d > 1){ bd = d; best = p; }
    }
    return best;
  }

  function spawnPulse(now){
    if (pulses.length > 2) return;
    const a = parts[(Math.random() * parts.length) | 0];
    if (!a) return;
    const b = nearest(a.x, a.y, LINK);
    if (!b) return;
    pulses.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, t: 0, dur: 1.8 + Math.random() * .8 });
    nextPulse = now + 4000 + Math.random() * 3000;
  }

  hero.addEventListener('pointermove', e => {
    const r = hero.getBoundingClientRect();
    pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top;
  });
  hero.addEventListener('pointerleave', () => { pointer.x = -9999; pointer.y = -9999; });
  hero.addEventListener('pointerdown', e => {
    const r = hero.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    ripples.push({ x, y, r: 6, alpha: .35 });
    for (const p of parts){
      const dx = p.x - x, dy = p.y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 200) p.boost = Math.max(p.boost, 1 - d / 200);
    }
  });

  function update(dt, now, tSec){
    if (now > nextPulse) spawnPulse(now);
    for (const p of parts){
      // constant-velocity glide + smooth sinusoidal wander
      const wobX = Math.sin(tSec * p.wob + p.wobPh) * p.wobAmp;
      const wobY = Math.cos(tSec * p.wob * .9 + p.wobPh) * p.wobAmp;
      p.x += (p.vx + wobX) * dt;
      p.y += (p.vy + wobY) * dt;
      const pdx = pointer.x - p.x, pdy = pointer.y - p.y;
      const pd = Math.sqrt(pdx * pdx + pdy * pdy);
      if (pd < 160 && pd > 4){ p.vx += (pdx / pd) * 8 * dt; p.vy += (pdy / pd) * 8 * dt; }
      if (p.x < -20) p.x = W + 20; else if (p.x > W + 20) p.x = -20;
      if (p.y < -20) p.y = H + 20; else if (p.y > H + 20) p.y = -20;
      p.phase += p.breath * dt;
      p.boost *= Math.pow(.3, dt);
    }
    for (let i = pulses.length - 1; i >= 0; i--){
      pulses[i].t += dt;
      if (pulses[i].t >= pulses[i].dur) pulses.splice(i, 1);
    }
    for (let i = ripples.length - 1; i >= 0; i--){
      ripples[i].r += 110 * dt; ripples[i].alpha -= .4 * dt;
      if (ripples[i].alpha <= 0) ripples.splice(i, 1);
    }
  }

  function draw(){
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1;
    for (let i = 0; i < parts.length; i++){
      const a = parts[i];
      for (let j = i + 1; j < parts.length; j++){
        const b = parts[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < LINK2){
          const d = Math.sqrt(d2);
          ctx.strokeStyle = 'rgba(' + MINT + ',' + ((1 - d / LINK) * .16).toFixed(3) + ')';
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    for (const p of parts){
      const breathe = .55 + .45 * Math.sin(p.phase);
      const pdx = p.x - pointer.x, pdy = p.y - pointer.y;
      const pd = Math.sqrt(pdx * pdx + pdy * pdy);
      const near = pd < 160 ? (1 - pd / 160) * .6 : 0;
      const al = Math.min(1, p.a * breathe + near + p.boost * .5);
      const r = p.r * (1 + (near + p.boost) * .3);
      const sz = r * 7;
      ctx.globalAlpha = al;
      ctx.drawImage(glowSprite, p.x - sz / 2, p.y - sz / 2, sz, sz);
      ctx.globalAlpha = Math.min(1, al + .15);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const s of pulses){
      const k = s.t / s.dur;
      const x = s.ax + (s.bx - s.ax) * k, y = s.ay + (s.by - s.ay) * k;
      const fade = Math.sin(k * Math.PI) * .45;
      ctx.strokeStyle = 'rgba(255,255,255,' + (fade * .5).toFixed(3) + ')';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(s.ax, s.ay); ctx.lineTo(x, y); ctx.stroke();
      const sz = 22;
      ctx.globalAlpha = fade;
      ctx.drawImage(glowSprite, x - sz / 2, y - sz / 2, sz, sz);
      ctx.globalAlpha = 1;
    }
    for (const rp of ripples){
      ctx.strokeStyle = 'rgba(221,245,233,' + rp.alpha.toFixed(3) + ')';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(rp.x, rp.y, rp.r, 0, 6.2832); ctx.stroke();
    }
  }

  function drawStatic(){
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1;
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++){
      const a = parts[i], b = parts[j];
      const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
      if (d2 < LINK2){
        const d = Math.sqrt(d2);
        ctx.strokeStyle = 'rgba(' + MINT + ',' + ((1 - d / LINK) * .16).toFixed(3) + ')';
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    for (const p of parts){
      const sz = p.r * 7;
      ctx.globalAlpha = p.a;
      ctx.drawImage(glowSprite, p.x - sz / 2, p.y - sz / 2, sz, sz);
      ctx.globalAlpha = 1;
    }
  }

  let raf = 0, last = 0, running = false;
  function frame(now){
    if (!running) return;
    let dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0) || dt > .1) dt = dtS;      // ignore tab-switch gaps
    dtS = dtS * .9 + dt * .1;                // smoothed step
    dt = Math.min(dtS, .05);
    update(dt, now, now / 1000);
    draw();
    raf = requestAnimationFrame(frame);
  }
  function start(){ if (!running && !reduced){ running = true; last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop(){ running = false; cancelAnimationFrame(raf); }
  document.addEventListener('visibilitychange', () => document.hidden ? stop() : start());

  let rT;
  window.addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(resize, 150); });

  resize();
  start();
})();
