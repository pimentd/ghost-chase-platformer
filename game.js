// game.js — Ghost Chase Platformer (v2)
// - Procedural Alan Becker–style stickman with run/jump animations
// - Random player color on spawn; 1% chance "RAINBOW POWER" variant
// - Ghost spawn animation + sound; ghost starts slow and ramps faster over time
// - Soft intro ramp, extra juice (dust, land burst, lunge flash), improved sword combat
// - Best score saved to localStorage

(() => {
  // ===================== Canvas =====================
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const W = canvas.width, H = canvas.height;
  const hudEl = document.getElementById("hud");

  // ===================== Input ======================
  const keys = new Set();
  const pressed = new Set();

  window.addEventListener(
    "keydown",
    (e) => {
      const k = e.key.toLowerCase();
      keys.add(k);
      pressed.add(k);
      if (
        [" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k) ||
        e.code === "Space"
      ) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  const wasPressed = (k) => pressed.has(k);

  // ===================== Utils ======================
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const irand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const aabb = (a, b) =>
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y;

  function hsl(h, s, l) { return `hsl(${h} ${s}% ${l}%)`; }

  // ===================== Time/State =================
  let now = performance.now(), last = now;

  let startedAt = now;
  let started = false;

  let gameOver = false;
  let gameOverReason = "";

  // "best" is localStorage-backed
  let best = 0;
  try { best = Number(localStorage.getItem("gc_best") || "0") || 0; } catch {}

  let camX = 0;

  // Soft intro ramp: world starts slower and eases to target scroll
  let baseScroll = 0;
  let targetScroll = 90;

  let ghostsRepelled = 0;

  // Screen shake / flashes
  let shakeT = 0;
  let shakeMag = 0;
  let flashT = 0;          // white flash for hit / lunge
  let lungeTintT = 0;      // subtle red/purple tint on lunge moments

  function addShake(mag, time = 0.12) {
    shakeMag = Math.max(shakeMag, mag);
    shakeT = Math.max(shakeT, time);
  }
  function addFlash(time = 0.08) {
    flashT = Math.max(flashT, time);
  }
  function addLungeTint(time = 0.12) {
    lungeTintT = Math.max(lungeTintT, time);
  }

  // ===================== WebAudio (SFX + Music) =====================
  let audioCtx = null;
  let audioEnabled = false;

  let musicOn = false;
  let musicGain = null;
  let musicTempo = 118;
  let musicStep = 0;
  let nextMusicAt = 0;

  const musicPattern = [0, -1, 2, -1, 4, -1, 2, -1];
  const musicScale = [261.63, 293.66, 329.63, 392.0, 523.25];

  async function ensureAudio() {
    try {
      if (!audioCtx)
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") await audioCtx.resume();
      audioEnabled = true;

      if (!musicGain) {
        musicGain = audioCtx.createGain();
        musicGain.gain.value = 0.02;
        musicGain.connect(audioCtx.destination);
      }

      if (!musicOn) {
        musicOn = true;
        musicStep = 0;
        nextMusicAt = audioCtx.currentTime + 0.05;
      }
    } catch (e) {
      console.warn("Audio enable failed:", e);
      audioEnabled = false;
    }
  }

  window.addEventListener("pointerdown", ensureAudio, { once: true });
  window.addEventListener("keydown", ensureAudio, { once: true });

  function sfx(type) {
    if (!audioCtx || !audioEnabled) return;
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});

    const t0 = audioCtx.currentTime;

    // helper
    const make = (oscType, f0, f1, dur, gPeak = 0.14) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(gPeak, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      osc.type = oscType;
      osc.frequency.setValueAtTime(f0, t0);
      if (f1 !== null) osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.85);

      osc.start(t0);
      osc.stop(t0 + dur + 0.01);
    };

    if (type === "jump") {
      make("square", 260, 520, 0.12, 0.12);
      return;
    }
    if (type === "hit") {
      make("sawtooth", 180, 90, 0.10, 0.16);
      return;
    }
    if (type === "pickup") {
      const freqs = [330, 415, 523];
      freqs.forEach((f, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = "triangle";
        o.frequency.setValueAtTime(f, t0 + i * 0.06);
        g.gain.setValueAtTime(0.0001, t0 + i * 0.06);
        g.gain.exponentialRampToValueAtTime(0.11, t0 + i * 0.06 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.06 + 0.055);
        o.connect(g);
        g.connect(audioCtx.destination);
        o.start(t0 + i * 0.06);
        o.stop(t0 + i * 0.06 + 0.06);
      });
      return;
    }
    if (type === "ghostspawn") {
      // spooky swoop: downward pitch + noise-ish tremolo
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.type = "triangle";
      osc.frequency.setValueAtTime(520, t0);
      osc.frequency.exponentialRampToValueAtTime(130, t0 + 0.35);

      // tremolo
      const lfo = audioCtx.createOscillator();
      const lfoG = audioCtx.createGain();
      lfo.type = "square";
      lfo.frequency.setValueAtTime(18, t0);
      lfoG.gain.setValueAtTime(0.035, t0);
      lfo.connect(lfoG);
      lfoG.connect(gain.gain);

      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.38);

      lfo.start(t0);
      osc.start(t0);
      lfo.stop(t0 + 0.4);
      osc.stop(t0 + 0.41);
      return;
    }
    if (type === "gameover") {
      make("triangle", 220, 110, 0.30, 0.15);
      return;
    }
  }

  function tickMusic() {
    if (!musicOn || !audioCtx || !audioEnabled || !musicGain) return;
    if (audioCtx.state === "suspended") return;

    const t = audioCtx.currentTime;
    const stepDur = 60 / musicTempo / 2;

    while (nextMusicAt <= t + 0.05) {
      const degree = musicPattern[musicStep % musicPattern.length];
      if (degree !== -1) {
        const freq = musicScale[degree % musicScale.length];

        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = "square";
        o.frequency.setValueAtTime(freq, nextMusicAt);

        g.gain.setValueAtTime(0.0001, nextMusicAt);
        g.gain.exponentialRampToValueAtTime(0.06, nextMusicAt + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, nextMusicAt + stepDur * 0.85);

        o.connect(g);
        g.connect(musicGain);
        o.start(nextMusicAt);
        o.stop(nextMusicAt + stepDur);
      }

      musicStep++;
      nextMusicAt += stepDur;
    }
  }

  // ===================== Assets =====================
  const assetList = {
    ghost: "assets/ghost.png",
    tiles: "assets/tiles.png",
    sword: "assets/sword.png",
    bg_far: "assets/bg_far.png",
    bg_mid: "assets/bg_mid.png",
    bg_near: "assets/bg_near.png",
  };

  const AS = {};
  const assetOK = {};
  function loadAssets(cb) {
    const names = Object.keys(assetList);
    let doneCount = 0;

    function done(name, ok) {
      assetOK[name] = ok;
      doneCount++;
      if (doneCount === names.length) cb();
    }

    for (const name of names) {
      const img = new Image();
      img.onload = () => done(name, true);
      img.onerror = () => {
        console.warn("Failed to load:", assetList[name]);
        done(name, false);
      };
      img.src = assetList[name];
      AS[name] = img;
    }
  }
  function assetSummary() {
    const needed = Object.keys(assetList);
    const ok = needed.filter((k) => assetOK[k]).length;
    return `${ok}/${needed.length} loaded`;
  }

  // ===================== Particles =====================
  const particles = [];
  function spawnParticles(x, y, count = 10, opts = {}) {
    const {
      color = "rgba(230,240,255,1)",
      vx = 90,
      vy = 120,
      lifeMin = 0.35,
      lifeMax = 0.65,
      sizeMin = 1,
      sizeMax = 2.6,
      grav = 320,
    } = opts;

    for (let i = 0; i < count; i++) {
      particles.push({
        x,
        y,
        vx: (Math.random() * 2 - 1) * vx,
        vy: (Math.random() * -1.0 - 0.2) * vy,
        life: lifeMin + Math.random() * (lifeMax - lifeMin),
        age: 0,
        size: sizeMin + Math.random() * (sizeMax - sizeMin),
        grav,
        color,
      });
    }
  }
  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        particles.splice(i, 1);
        continue;
      }
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }
  function drawParticles() {
    for (const p of particles) {
      const a = 1 - p.age / p.life;
      ctx.fillStyle = p.color.startsWith("hsl(") ? p.color : p.color.replace(/rgba\(([^)]+)\)/, `rgba($1,${a})`);
      if (p.color.startsWith("hsl(")) ctx.globalAlpha = a;
      ctx.fillRect(Math.floor(p.x), Math.floor(p.y), Math.ceil(p.size), Math.ceil(p.size));
      ctx.globalAlpha = 1;
    }
  }

  // ===================== World =====================
  const groundY = 140;

  const ground = [];     // segments at y=groundY
  const platforms = [];  // upper platforms (y < groundY)

  function addGroundSeg(x, w) { ground.push({ x, y: groundY, w, h: 40 }); }
  function addPlatform(x, y, w) { platforms.push({ x, y, w, h: 10 }); }

  // Ground generation: mostly continuous with occasional gaps to jump.
  const GROUND_GAP_CHANCE = 0.14;
  const GROUND_SEG_W_MIN = 220;
  const GROUND_SEG_W_MAX = 420;
  const GROUND_GAP_MIN = 70;
  const GROUND_GAP_MAX = 150;

  // Upper platform generator mood
  let genMode = "easy";
  let genModeLeft = 6;
  let lastPlatY = 110;

  function pickGenMode() {
    const r = Math.random();
    if (r < 0.55) return "easy";
    if (r < 0.8) return "stairs";
    return "gaps";
  }

  function seedWorld() {
    camX = 0;
    baseScroll = 0;
    targetScroll = 90;
    ghostsRepelled = 0;

    ground.length = 0;
    platforms.length = 0;

    // Start with a long stable ground so you can breathe
    addGroundSeg(-600, 2600);

    // Seed some initial upper platforms
    let x = 160;
    for (let i = 0; i < 10; i++) {
      addPlatform(x, irand(78, 120), irand(56, 110));
      x += irand(90, 160);
    }

    sword = null;
    nextSwordSpawnAt = 3;

    genMode = "easy";
    genModeLeft = irand(4, 7);
    lastPlatY = irand(92, 118);
  }

  function ensureGroundAhead() {
    let far = -Infinity;
    for (const g of ground) far = Math.max(far, g.x + g.w);
    if (far === -Infinity) far = camX - 500;

    while (far < camX + W + 600) {
      const makeGap = Math.random() < GROUND_GAP_CHANCE;
      if (makeGap) {
        far += irand(GROUND_GAP_MIN, GROUND_GAP_MAX);
      } else {
        const w = irand(GROUND_SEG_W_MIN, GROUND_SEG_W_MAX);
        addGroundSeg(far, w);
        far += w;
      }
    }

    for (let i = ground.length - 1; i >= 0; i--) {
      const g = ground[i];
      if (g.x + g.w < camX - 900) ground.splice(i, 1);
    }
  }

  function ensurePlatformsAhead() {
    let far = 0;
    for (const p of platforms) far = Math.max(far, p.x + p.w);

    while (far < camX + W + 420) {
      if (genModeLeft <= 0) {
        genMode = pickGenMode();
        genModeLeft = genMode === "easy" ? irand(5, 9) : irand(4, 7);
      }
      genModeLeft--;

      let gap = 0, w = 0, y = lastPlatY;

      if (genMode === "easy") {
        gap = irand(70, 120); w = irand(56, 110);
        y = clamp(lastPlatY + irand(-10, 10), 76, 124);
      } else if (genMode === "stairs") {
        gap = irand(70, 110); w = irand(50, 90);
        y = clamp(lastPlatY + irand(-18, 18), 68, 124);
      } else {
        gap = irand(110, 165); w = irand(44, 84);
        y = clamp(lastPlatY + irand(-14, 14), 70, 124);
      }

      const nextX = far + gap;
      addPlatform(nextX, y, w);
      lastPlatY = y;
      far = nextX + w;
    }

    for (let i = platforms.length - 1; i >= 0; i--) {
      const p = platforms[i];
      if (p.x + p.w < camX - 600) platforms.splice(i, 1);
    }
  }

  // ===================== Entities =====================
  const player = {
    x: 70,
    y: 40,
    w: 12,
    h: 20,
    vx: 0,
    vy: 0,
    onGround: false,
    hasSword: false,
    swordUntil: 0,
    attackUntil: 0,
    attackDir: "right",
    coyote: 0,
    jumpBuffer: 0,

    // cosmetic / power
    color: "#e8eefc",
    rainbow: false,
    power: 1.0,      // rainbow = 1.25
    sprinting: false,
    combo: 0,
    comboUntil: 0,
  };

  const ghost = {
    x: -90,
    y: 60,
    w: 48,
    h: 64,
    speed: 0,
    pushedBackUntil: 0,
    state: "spawn", // spawn -> calm/lunge
    stateTime: 0,
    spawnedAt: 0,
  };

  // ===================== Player appearance (Alan Becker stickman) =====================
  function rollPlayerStyle() {
    const rainbow = Math.random() < 0.01;
    player.rainbow = rainbow;
    player.power = rainbow ? 1.25 : 1.0;

    if (rainbow) {
      player.color = "#ffffff";
    } else {
      const hue = irand(0, 359);
      // saturated, readable on dark bg
      player.color = hsl(hue, 90, 68);
    }
  }

  // ===================== Sword spawn =====================
  let sword = null, nextSwordSpawnAt = 0;

  function maybeSpawnSword(tSec) {
    if (tSec < nextSwordSpawnAt) return;

    const candidates = platforms.filter(
      (p) => p.x > camX + 90 && p.x < camX + W + 420
    );
    const p = candidates.length ? candidates[irand(0, candidates.length - 1)] : null;

    const sx = p ? p.x + p.w * 0.5 - 4 : camX + W + 140;
    const sy = p ? p.y - 12 : groundY - 22;

    sword = { x: sx, y: sy, w: 10, h: 12, active: true, bob: 0 };
    nextSwordSpawnAt = tSec + 20;
  }

  // ===================== Feel tuning =====================
  const GRAVITY = 1100;
  const JUMP_V = 380;
  const MOVE_AIR = 0.95, MOVE_GROUND = 0.82;
  const COYOTE_TIME = 0.12;
  const JUMP_BUFFER = 0.12;
  const JUMP_CUT = 0.55;

  // sprint toggle: hold Shift for extra speed (and a clearer run animation)
  const SPRINT_MULT = 1.35;

  // ===================== Ghost AI (phases + ramp) =====================
  // Ghost starts slow, then ramps to scary-fast over time, with phases.
  // Phase thresholds in seconds:
  const PH1 = 18, PH2 = 45, PH3 = 90;

  function ghostChaseFactor(tSec) {
    // Start under-speed, ramp over time.
    // 0s: 0.78x, 90s+: 1.45x
    const t = clamp(tSec / 90, 0, 1);
    return lerp(0.78, 1.45, t);
  }

  function updateGhost(dt, tSec) {
    ghost.stateTime += dt;

    // Soft intro scroll ramp (world speed)
    targetScroll = 90 + tSec * 2.0 + ghostsRepelled * 0.8;
    // ease baseScroll toward target
    baseScroll = lerp(baseScroll, targetScroll, 1 - Math.pow(0.001, dt)); // frame-rate independent easing

    // Phase-based spice:
    const phase = tSec < PH1 ? 1 : tSec < PH2 ? 2 : tSec < PH3 ? 3 : 4;

    // relative ghost speed factor ramps
    const chase = ghostChaseFactor(tSec) * (phase === 1 ? 0.95 : phase === 2 ? 1.02 : phase === 3 ? 1.08 : 1.14);
    ghost.speed = baseScroll * chase;

    // State machine
    if (ghost.state === "spawn") {
      const p = clamp((tSec - ghost.spawnedAt) / 1.0, 0, 1); // 1s spawn anim
      // drift into view
      ghost.x = lerp(-120, -30, p);
      if (p >= 1) {
        ghost.state = "calm";
        ghost.stateTime = 0;
      }
    } else {
      // Random lunges increase in frequency by phase
      const lungeChance = phase === 1 ? 0.0009 : phase === 2 ? 0.0016 : phase === 3 ? 0.0026 : 0.0032;

      if (ghost.state !== "lunge" && tSec > 10 && Math.random() < lungeChance) {
        ghost.state = "lunge";
        ghost.stateTime = 0;
        addLungeTint(0.18);
      }

      if (ghost.state === "lunge") {
        // short, sharp burst
        if (ghost.stateTime < 0.55) {
          ghost.x += (ghost.speed * (phase >= 3 ? 1.85 : 1.7) - baseScroll) * dt + 40 * dt;
        } else {
          ghost.state = "calm";
          ghost.stateTime = 0;
        }
      } else {
        // normal chase, with knockback window
        if (now < ghost.pushedBackUntil) ghost.x -= (phase >= 4 ? 150 : 120) * dt;
        else ghost.x += (ghost.speed - baseScroll) * dt + (phase >= 3 ? 18 : 14) * dt;

        // Phase 4: occasional tiny "blink" (micro-teleport) but not unfair
        if (phase === 4 && Math.random() < 0.0009 && ghost.x < 30) {
          ghost.x += 14;
          spawnParticles(ghost.x + ghost.w * 0.5, ghost.y + 30, 10, { vx: 80, vy: 120, color: "rgba(190,210,255,1)" });
          addFlash(0.05);
        }
      }
    }

    ghost.y = 62 + Math.sin(tSec * 3.1) * 4;
  }

  // ===================== Game over / restart =====================
  function triggerGameOver(reason) {
    if (gameOver) return;
    gameOver = true;
    gameOverReason = reason;
    const t = (now - startedAt) / 1000;
    best = Math.max(best, t);
    try { localStorage.setItem("gc_best", String(best)); } catch {}
    sfx("gameover");
    addShake(8, 0.25);
    addFlash(0.12);
  }

  function restart() {
    gameOver = false;
    gameOverReason = "";
    started = false;

    player.x = 70;
    player.y = 40;
    player.vx = 0;
    player.vy = 0;
    player.onGround = false;
    player.coyote = 0;
    player.jumpBuffer = 0;
    player.hasSword = false;
    player.swordUntil = 0;
    player.attackUntil = 0;
    player.attackDir = "right";
    player.combo = 0;
    player.comboUntil = 0;

    rollPlayerStyle();

    ghost.x = -120;
    ghost.y = 60;
    ghost.pushedBackUntil = 0;
    ghost.state = "spawn";
    ghost.stateTime = 0;
    ghost.spawnedAt = 0;

    startedAt = performance.now();
    now = startedAt;
    last = startedAt;

    seedWorld();
  }

  // ===================== Rendering =====================
  function drawTiled(img, speed) {
    if (!img || !img.width) return;
    const px = Math.floor(camX * speed) % img.width;
    // a little vertical offset for parallax depth
    const y = speed < 0.25 ? 0 : speed < 0.5 ? 3 : 6;
    ctx.drawImage(img, -px, y);
    ctx.drawImage(img, -px + img.width, y);
  }

  function drawBackground(tSec) {
    ctx.fillStyle = "#070a14";
    ctx.fillRect(0, 0, W, H);

    // Slightly more dramatic parallax (near layer can feel faster than world scroll)
    drawTiled(AS.bg_far, 0.14);
    drawTiled(AS.bg_mid, 0.33);
    drawTiled(AS.bg_near, 0.78);

    // mist band
    ctx.fillStyle = "rgba(120,140,255,0.035)";
    ctx.fillRect(0, 92, W, 46);

    // subtle vignette
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(0, 0, W, 10);
    ctx.fillRect(0, H - 12, W, 12);

    // lunge tint overlay
    if (lungeTintT > 0) {
      const a = clamp(lungeTintT / 0.18, 0, 1) * 0.18;
      ctx.fillStyle = `rgba(120,60,190,${a})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function drawTilesBar(x, y, w, h) {
    if (AS.tiles && AS.tiles.width) {
      const tw = 8, th = 8;
      const cols = Math.ceil(w / tw);
      for (let i = 0; i < cols; i++) {
        const dx = x + i * tw;
        ctx.drawImage(AS.tiles, 0, 0, tw, th, dx, y, tw, th);
      }
      if (h > th) {
        ctx.fillStyle = "rgba(18,22,44,0.8)";
        ctx.fillRect(x, y + th, w, h - th);
      }
    } else {
      ctx.fillStyle = "#2a2f4a";
      ctx.fillRect(x, y, w, h);
    }
  }

  function drawGroundSeg(g) {
    const sx = Math.floor(g.x - camX);
    drawTilesBar(sx, g.y, g.w, g.h);
  }

  function drawPlatform(p) {
    const sx = Math.floor(p.x - camX);
    drawTilesBar(sx, p.y, p.w, p.h);
  }

  function drawSwordPickup(tSec) {
    if (!sword || !sword.active) return;
    sword.bob += 0.08;
    const bob = Math.sin(sword.bob) * 1.5;

    const x = Math.floor(sword.x - camX);
    const y = Math.floor(sword.y + bob);

    // glow
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = "rgba(230,240,255,1)";
    ctx.fillRect(x - 2, y - 2, 14, 16);
    ctx.globalAlpha = 1;

    if (AS.sword && AS.sword.width) ctx.drawImage(AS.sword, x, y);
    else {
      ctx.fillStyle = "#e8eefc";
      ctx.fillRect(x + 7, y + 1, 2, 10);
      ctx.fillRect(x + 3, y + 10, 10, 2);
    }
  }

  // Alan Becker-esque stickman: thick head, simple limbs, energetic poses.
  function drawStickman(px, py, tSec) {
    const x = Math.floor(px);
    const y = Math.floor(py);

    // Rainbow variant: animate hue
    let col = player.color;
    if (player.rainbow) {
      const hue = Math.floor((tSec * 180) % 360);
      col = hsl(hue, 95, 70);
    }

    // pose parameters
    const speed = Math.abs(player.vx);
    const runT = (now / 1000) * (player.sprinting ? 14 : 10);
    const runSwing = Math.sin(runT) * clamp(speed / 140, 0, 1);
    const runSwing2 = Math.sin(runT + Math.PI) * clamp(speed / 140, 0, 1);

    const jumping = !player.onGround;
    const attacking = player.attackUntil > now;

    // head
    const headR = 4;
    const headX = x + 6;
    const headY = y + 4;

    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = col;

    // body / spine
    const torsoTopY = headY + headR + 1;
    const torsoBotY = y + 14;

    // slight lean forward when sprinting
    const lean = (player.sprinting ? 0.9 : 0.5) * clamp(speed / 150, 0, 1);
    const leanX = lean * 2.0;

    // Head fill (Alan Becker style is usually solid colored stickman)
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(headX + leanX, headY, headR, 0, Math.PI * 2);
    ctx.fill();

    // torso
    ctx.beginPath();
    ctx.moveTo(headX + leanX, torsoTopY);
    ctx.lineTo(headX + leanX, torsoBotY);
    ctx.stroke();

    // hips
    const hipX = headX + leanX;
    const hipY = torsoBotY;

    // shoulders
    const shX = headX + leanX;
    const shY = torsoTopY + 3;

    // Arms
    const armLen = 8;

    let a1 = -0.9 + runSwing * 0.9;
    let a2 = 0.9 + runSwing2 * 0.9;

    if (jumping) { a1 = -1.1; a2 = -0.2; } // jump pose
    if (attacking) {
      // swing toward attackDir
      if (player.attackDir === "right") { a1 = 0.1; a2 = 0.3; }
      if (player.attackDir === "left")  { a1 = Math.PI - 0.2; a2 = Math.PI - 0.4; }
      if (player.attackDir === "up")    { a1 = -1.5; a2 = -1.2; }
      if (player.attackDir === "down")  { a1 = 1.4; a2 = 1.2; }
    }

    const arm = (ang, flip = 1) => {
      const ex = shX + Math.cos(ang) * armLen;
      const ey = shY + Math.sin(ang) * armLen;
      const hx = ex + Math.cos(ang + 0.6 * flip) * (armLen * 0.6);
      const hy = ey + Math.sin(ang + 0.6 * flip) * (armLen * 0.6);
      ctx.beginPath();
      ctx.moveTo(shX, shY);
      ctx.lineTo(ex, ey);
      ctx.lineTo(hx, hy);
      ctx.stroke();
    };

    arm(a1, 1);
    arm(a2, -1);

    // Legs
    const legLen = 9;
    let l1 = 0.9 + runSwing * 1.0;
    let l2 = 0.9 + runSwing2 * 1.0;

    if (jumping) { l1 = 1.35; l2 = 0.55; } // tuck one leg
    const leg = (ang, flip = 1) => {
      const ex = hipX + Math.cos(ang) * legLen;
      const ey = hipY + Math.sin(ang) * legLen;
      const fx = ex + Math.cos(ang + 0.4 * flip) * (legLen * 0.5);
      const fy = ey + Math.sin(ang + 0.4 * flip) * (legLen * 0.5);
      ctx.beginPath();
      ctx.moveTo(hipX, hipY);
      ctx.lineTo(ex, ey);
      ctx.lineTo(fx, fy);
      ctx.stroke();
    };

    leg(l1, 1);
    leg(l2, -1);

    // Sword (when held): tiny line from hand in attack direction
    if (player.hasSword) {
      ctx.lineWidth = 1.5;
      const handX = shX + Math.cos(a1) * armLen;
      const handY = shY + Math.sin(a1) * armLen;
      let dx = 1, dy = 0;
      if (player.attackDir === "left") { dx = -1; dy = 0; }
      else if (player.attackDir === "up") { dx = 0; dy = -1; }
      else if (player.attackDir === "down") { dx = 0; dy = 1; }
      ctx.beginPath();
      ctx.moveTo(handX, handY);
      ctx.lineTo(handX + dx * 10, handY + dy * 10);
      ctx.stroke();
      ctx.lineWidth = 2;
    }

    // "Power" aura for rainbow
    if (player.rainbow) {
      ctx.globalAlpha = 0.18;
      const hue = Math.floor((tSec * 180 + 120) % 360);
      ctx.fillStyle = hsl(hue, 95, 70);
      ctx.fillRect(x - 2, y - 2, 16, 24);
      ctx.globalAlpha = 1;
    }
  }

  function drawPlayer(tSec) {
    drawStickman(player.x, player.y, tSec);
  }

  function drawGhost(tSec) {
    // spawn animation: scale + fade in
    let alpha = 0.95;
    let scale = 1.0;
    if (ghost.state === "spawn") {
      const p = clamp((tSec - ghost.spawnedAt) / 1.0, 0, 1);
      alpha = lerp(0.0, 0.95, p);
      scale = lerp(0.72, 1.0, p);
    }

    const gx = Math.floor(ghost.x + ghost.w * (1 - scale) * 0.5);
    const gy = Math.floor(ghost.y + ghost.h * (1 - scale) * 0.5);
    const gw = Math.floor(ghost.w * scale);
    const gh = Math.floor(ghost.h * scale);

    if (AS.ghost && AS.ghost.width) {
      const fw = 64, fh = 64;
      const cols = Math.max(1, Math.floor(AS.ghost.width / fw));
      const fps = ghost.state === "lunge" ? 10 : 6;
      const frame = Math.floor((now / 1000) * fps) % cols;

      ctx.globalAlpha = alpha;
      ctx.drawImage(AS.ghost, frame * fw, 0, fw, fh, gx, gy, 64 * scale, 64 * scale);
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "rgba(210,220,255,0.85)";
      ctx.fillRect(gx, gy, gw, gh);
      ctx.globalAlpha = 1;
    }

    // simple "whoosh" ring on spawn
    if (ghost.state === "spawn") {
      const p = clamp((tSec - ghost.spawnedAt) / 1.0, 0, 1);
      ctx.globalAlpha = (1 - p) * 0.35;
      ctx.strokeStyle = "rgba(190,210,255,1)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(gx + gw * 0.5, gy + gh * 0.55, 4 + p * 26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawAttackEffect() {
    if (player.attackUntil <= now) return;
    const x = player.x, y = player.y;
    ctx.fillStyle = "rgba(230,240,255,0.98)";
    if (player.attackDir === "right") ctx.fillRect(x + player.w, y + 7, 18, 2);
    else if (player.attackDir === "left") ctx.fillRect(x - 18, y + 7, 18, 2);
    else if (player.attackDir === "up") ctx.fillRect(x + 5, y - 18, 2, 18);
    else ctx.fillRect(x + 5, y + player.h, 2, 18);
  }

  function drawHUD(tSec) {
    const swordIn = Math.max(0, nextSwordSpawnAt - tSec);
    const swordLine = sword && sword.active ? "Sword: ON MAP" : `Next sword: ${swordIn.toFixed(1)}s`;

    const phase = tSec < PH1 ? 1 : tSec < PH2 ? 2 : tSec < PH3 ? 3 : 4;

    let status =
      `Time: ${started ? tSec.toFixed(2) : "0.00"}s\n` +
      `Best: ${best.toFixed(2)}s\n` +
      `Repels: ${ghostsRepelled}\n` +
      `${swordLine}\n`;

    status += player.hasSword
      ? `Sword: ${Math.max(0, (player.swordUntil - now) / 1000).toFixed(1)}s  Combo: ${player.combo}`
      : "No sword";

    status += `\nPhase: ${phase}  Ghost: ${ghost.state.toUpperCase()}`;
    status += `\nPlayer: ${player.rainbow ? "RAINBOW POWER (1%)" : "Normal"}`;
    status += `\nAssets: ${assetSummary()}`;
    status += `\nSound: ${audioEnabled ? "ON" : "OFF (click game / press key)"}`;

    if (!started && !gameOver) status += `\n\nPress SPACE / ↑ to start`;
    if (gameOver) status += `\n\nGAME OVER\n${gameOverReason}\nPress R`;

    hudEl.textContent = status;
  }

  // ===================== Physics collision =====================
  function landOn(p, impactVy) {
    player.y = p.y - player.h;
    player.vy = 0;
    player.onGround = true;
    player.coyote = COYOTE_TIME;

    // landing juice (only if you were falling fast enough)
    if (impactVy > 320) {
      spawnParticles(player.x + 6, player.y + player.h, 10, {
        vx: 120, vy: 140, grav: 520,
        color: player.rainbow ? "hsl(200 95% 70%)" : "rgba(230,240,255,1)"
      });
      addShake(2, 0.08);
    }
  }

  // ===================== Step =====================
  function step(dt) {
    tickMusic();
    const tSec = (now - startedAt) / 1000;

    ensureGroundAhead();
    ensurePlatformsAhead();
    maybeSpawnSword(tSec);

    if (wasPressed("r")) restart();

    if (!started && !gameOver) {
      const startPressed = wasPressed(" ") || wasPressed("arrowup") || wasPressed("d") || wasPressed("arrowright");
      if (startPressed) {
        started = true;
        ensureAudio();

        // ghost spawn sfx + particles
        ghost.state = "spawn";
        ghost.stateTime = 0;
        ghost.spawnedAt = tSec;
        sfx("ghostspawn");
        spawnParticles(18, 92, 22, { vx: 120, vy: 150, grav: 420, color: "rgba(190,210,255,1)" });
        addFlash(0.08);
      } else {
        return;
      }
    }
    if (gameOver) return;

    // Handle flash/tint timers
    if (flashT > 0) flashT = Math.max(0, flashT - dt);
    if (lungeTintT > 0) lungeTintT = Math.max(0, lungeTintT - dt);

    const jumpPressed = wasPressed(" ") || wasPressed("arrowup");
    const attackPressed = wasPressed("x");

    // coyote/buffer
    player.coyote -= dt;
    player.jumpBuffer -= dt;
    if (jumpPressed) player.jumpBuffer = JUMP_BUFFER;

    // sprinting
    player.sprinting = keys.has("shift");

    // horizontal
    const right = keys.has("arrowright") || keys.has("d");
    const left = keys.has("arrowleft") || keys.has("a");
    const ax = 900 * (player.sprinting ? 1.08 : 1.0);
    if (right) player.vx += ax * dt;
    if (left) player.vx -= ax * dt;

    const moveDamp = player.onGround ? MOVE_GROUND : MOVE_AIR;
    player.vx *= moveDamp;

    const speedCap = (player.sprinting ? 220 : 180) * player.power;
    player.vx = clamp(player.vx, -speedCap * 0.9, speedCap);

    // integrate
    const preVy = player.vy;
    player.vy += GRAVITY * dt;
    player.x += player.vx * dt;
    player.y += player.vy * dt;

    // keep in lane (intentionally a "runner" lane)
    player.x = clamp(player.x, 30, 175);

    // collisions: ground + platforms
    player.onGround = false;

    const worldP = { x: player.x + camX, y: player.y, w: player.w, h: player.h };
    const prevY = player.y - player.vy * dt;
    const wasAbove = prevY + player.h;

    const skin = 6;
    let landed = false;

    // ---- land on ground segments ----
    for (const g of ground) {
      if (worldP.x + worldP.w > g.x && worldP.x < g.x + g.w) {
        const wasAboveGround = wasAbove <= g.y + 1;
        const isFalling = player.vy >= 0;
        const hitsTop = player.y + player.h >= g.y && player.y + player.h <= g.y + skin;
        if (wasAboveGround && isFalling && hitsTop) {
          landOn(g, preVy);
          landed = true;
          break;
        }
      }
    }

    // ---- land on platforms ----
    if (!landed) {
      for (const p of platforms) {
        if (worldP.x + worldP.w > p.x && worldP.x < p.x + p.w) {
          const wasAbovePlat = wasAbove <= p.y + 1;
          const isFalling = player.vy >= 0;
          const hitsTop = player.y + player.h >= p.y && player.y + player.h <= p.y + skin;
          if (wasAbovePlat && isFalling && hitsTop) {
            landOn(p, preVy);
            landed = true;
            break;
          }
        }
      }
    }

    // fall death
    if (player.y > H + 60) triggerGameOver("You fell!");

    // jump (with dust)
    if (player.jumpBuffer > 0 && player.coyote > 0) {
      // dust at feet
      spawnParticles(player.x + 6, player.y + player.h, 8, {
        vx: 90, vy: 120, grav: 520,
        color: player.rainbow ? "hsl(60 95% 70%)" : "rgba(230,240,255,1)"
      });

      player.vy = -JUMP_V * player.power;
      player.onGround = false;
      player.coyote = 0;
      player.jumpBuffer = 0;
      sfx("jump");
    }

    // variable jump
    const jumpHeld = keys.has(" ") || keys.has("arrowup");
    if (!jumpHeld && player.vy < 0) player.vy *= JUMP_CUT;

    // Attack direction toward ghost
    if (attackPressed && player.hasSword && player.attackUntil <= now) {
      player.attackUntil = now + 140;

      const px = player.x + player.w / 2, py = player.y + player.h / 2;
      const gx = ghost.x + ghost.w / 2, gy = ghost.y + ghost.h / 2;
      const dx = gx - px, dy = gy - py;

      if (Math.abs(dx) > Math.abs(dy)) player.attackDir = dx > 0 ? "right" : "left";
      else player.attackDir = dy > 0 ? "down" : "up";
    }

    // pickup sword
    if (sword && sword.active) {
      const swordBox = { x: sword.x - camX, y: sword.y, w: sword.w, h: sword.h };
      const playerBox = { x: player.x, y: player.y, w: player.w, h: player.h };
      if (aabb(playerBox, swordBox)) {
        sword.active = false;
        player.hasSword = true;

        // Rainbow power: longer sword duration + a bit more jump
        const dur = player.rainbow ? 9500 : 6500;
        player.swordUntil = now + dur;

        // combo reset
        player.combo = 0;
        player.comboUntil = 0;

        sfx("pickup");
        addFlash(0.06);
      }
    }

    // sword expires
    if (player.hasSword && now > player.swordUntil) {
      player.hasSword = false;
      player.attackUntil = 0;
      player.combo = 0;
      player.comboUntil = 0;
    }

    // ghost
    updateGhost(dt, tSec);

    // hit detect
    const ghostBox = { x: ghost.x, y: ghost.y, w: ghost.w, h: ghost.h };

    // Combo window: chain hits within 1.2s
    if (player.combo > 0 && now > player.comboUntil) player.combo = 0;

    if (player.attackUntil > now) {
      let hit;
      switch (player.attackDir) {
        case "right": hit = { x: player.x + player.w, y: player.y + 4, w: 20, h: 10 }; break;
        case "left":  hit = { x: player.x - 20, y: player.y + 4, w: 20, h: 10 }; break;
        case "up":    hit = { x: player.x + 3, y: player.y - 20, w: 8, h: 20 }; break;
        case "down":  hit = { x: player.x + 3, y: player.y + player.h, w: 8, h: 20 }; break;
      }

      if (hit && aabb(hit, ghostBox)) {
        ghostsRepelled++;

        // combo logic
        player.combo = clamp(player.combo + 1, 1, 12);
        player.comboUntil = now + 1200;

        // pushback scales with combo
        const push = 150 + player.combo * 14 + (player.rainbow ? 40 : 0);
        ghost.x -= push;
        ghost.pushedBackUntil = now + (750 + player.combo * 30);

        spawnParticles(ghost.x + ghost.w * 0.5, ghost.y + ghost.h * 0.5, 18, {
          vx: 120, vy: 140, grav: 420,
          color: "rgba(230,240,255,1)"
        });
        sfx("hit");
        addShake(5, 0.12);
        addFlash(0.06);
      }
    }

    // caught
    const playerBox = { x: player.x, y: player.y, w: player.w, h: player.h };
    if (aabb(playerBox, ghostBox)) triggerGameOver("The ghost caught you!");

    // camera scroll
    camX += baseScroll * dt;
  }

  // ===================== Draw =====================
  function draw() {
    const tSec = (now - startedAt) / 1000;

    // shake offset
    let ox = 0, oy = 0;
    if (shakeT > 0) {
      shakeT = Math.max(0, shakeT - (1 / 60));
      const a = shakeT / 0.25;
      const mag = shakeMag * clamp(a, 0, 1);
      ox = (Math.random() * 2 - 1) * mag;
      oy = (Math.random() * 2 - 1) * mag;
      if (shakeT <= 0) shakeMag = 0;
    }

    ctx.save();
    ctx.translate(ox, oy);

    drawBackground(tSec);

    // draw ground
    for (const g of ground) {
      const sx = Math.floor(g.x - camX);
      if (sx + g.w < -150 || sx > W + 150) continue;
      drawGroundSeg(g);
    }

    // draw platforms
    for (const p of platforms) {
      const sx = Math.floor(p.x - camX);
      if (sx + p.w < -150 || sx > W + 150) continue;
      drawPlatform(p);
    }

    drawSwordPickup(tSec);
    drawGhost(tSec);
    drawPlayer(tSec);
    drawAttackEffect();
    drawParticles();

    // flash overlay
    if (flashT > 0) {
      const a = clamp(flashT / 0.12, 0, 1) * 0.22;
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.restore();

    drawHUD(tSec);

    if (gameOver) {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ===================== Loop =====================
  function frame(t) {
    now = t;
    const dt = Math.min(0.033, (t - last) / 1000);
    last = t;

    step(dt);
    updateParticles(dt);
    draw();

    pressed.clear();
    requestAnimationFrame(frame);
  }

  // ===================== Boot =====================
  loadAssets(() => {
    restart();
    started = false;
    gameOver = false;
    gameOverReason = "";
    requestAnimationFrame(frame);
  });
})();
