// Brimwood hero aurora — brand-kit discipline:
// "Subtle and purposeful… premium, calm, and confident… nothing loud."
// Large soft blooms of brand emerald drift very slowly behind the content,
// with a whisper of cursor parallax. No dots, no lines, no sparks.
// Blobs are pre-rendered sprites; per frame is a handful of drawImages.
(function(){
  const canvas = document.getElementById('stars');
  const hero = document.getElementById('hero');
  if (!canvas || !hero) return;
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, blobs = [], ripples = [];
  const pointer = { x: -9999, y: -9999 };
  const par = { x: 0, y: 0 }; // smoothed parallax offset

  function makeBlob(rgb){
    const s = document.createElement('canvas');
    s.width = s.height = 256;
    const c = s.getContext('2d');
    const g = c.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, 'rgba(' + rgb + ',0.85)');
    g.addColorStop(0.55, 'rgba(' + rgb + ',0.35)');
    g.addColorStop(1, 'rgba(' + rgb + ',0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 256, 256);
    return s;
  }

  // [rgb, baseX, baseY (fractions of hero), size px, alpha, orbitRX, orbitRY, periodS, phase, depth]
  const DEFS = [
    ['21,181,122',  .22, .28, 760, .34, .10, .08, 38, 0.0, 26],  // bright emerald
    ['7,94,64',     .80, .75, 860, .50, .08, .10, 46, 1.7, 18],  // deep emerald
    ['10,61,43',    .55, .95, 640, .42, .12, .06, 34, 3.1, 22],  // forest
    ['221,245,233', .85, .15, 520, .10, .07, .09, 30, 4.4, 34],  // mint whisper
    ['21,181,122',  .12, .80, 580, .20, .09, .07, 42, 5.6, 24],  // emerald low
  ];

  function resize(){
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = hero.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    blobs = DEFS.map(d => ({
      sprite: makeBlob(d[0]), bx: d[1], by: d[2], size: d[3],
      alpha: d[4], rx: d[5], ry: d[6], per: d[7], ph: d[8], depth: d[9]
    }));
    if (reduced) draw(0);
  }

  hero.addEventListener('pointermove', e => {
    const r = hero.getBoundingClientRect();
    pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top;
  });
  hero.addEventListener('pointerleave', () => { pointer.x = -9999; pointer.y = -9999; });
  hero.addEventListener('pointerdown', e => {
    const r = hero.getBoundingClientRect();
    ripples.push({ x: e.clientX - r.left, y: e.clientY - r.top, r: 8, alpha: .22 });
  });

  function draw(tSec){
    ctx.clearRect(0, 0, W, H);
    // ease parallax toward cursor
    const tx = pointer.x > -9999 ? (pointer.x - W / 2) / (W / 2) : 0;
    const ty = pointer.y > -9999 ? (pointer.y - H / 2) / (H / 2) : 0;
    par.x += (tx - par.x) * .03;
    par.y += (ty - par.y) * .03;
    for (const b of blobs){
      const ox = Math.sin(tSec * (6.2832 / b.per) + b.ph) * b.rx * W;
      const oy = Math.cos(tSec * (6.2832 / b.per) * .83 + b.ph * 1.7) * b.ry * H;
      const x = b.bx * W + ox + par.x * b.depth;
      const y = b.by * H + oy + par.y * b.depth;
      ctx.globalAlpha = b.alpha;
      ctx.drawImage(b.sprite, x - b.size / 2, y - b.size / 2, b.size, b.size);
    }
    ctx.globalAlpha = 1;
    for (const rp of ripples){
      ctx.strokeStyle = 'rgba(221,245,233,' + rp.alpha.toFixed(3) + ')';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(rp.x, rp.y, rp.r, 0, 6.2832); ctx.stroke();
    }
  }

  function update(dt){
    for (let i = ripples.length - 1; i >= 0; i--){
      ripples[i].r += 90 * dt; ripples[i].alpha -= .3 * dt;
      if (ripples[i].alpha <= 0) ripples.splice(i, 1);
    }
  }

  let raf = 0, last = 0, running = false, dtS = 1 / 60;
  function frame(now){
    if (!running) return;
    let dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0) || dt > .1) dt = dtS;
    dtS = dtS * .9 + dt * .1;
    update(Math.min(dtS, .05));
    draw(now / 1000);
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
