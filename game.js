// game.js — Ghost Chase Platformer
// Update: "Stable ground lane" always exists (a continuous baseline), while still allowing
// occasional ground gaps to jump. Platforms above remain as before.

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
  const irand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const aabb = (a, b) =>
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y;

  // ===================== Time/State =================
  let now = performance.now(),
    last = now;

  let startedAt = now;
  let started = false;
  let graceUntil = 0;

  let gameOver = false;
  let gameOverReason = "";
  let best = 0;

  let camX = 0;
  let baseScroll = 90;
  let ghostsRepelled = 0;

  // Screen shake
  let shakeT = 0;
  let shakeMag = 0;
  function addShake(mag, time = 0.12) {
    shakeMag = Math.max(shakeMag, mag);
    shakeT = Math.max(shakeT, time);
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
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.14, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);

    if (type === "jump") {
      osc.type = "square";
      osc.frequency.setValueAtTime(260, t0);
      osc.frequency.exponentialRampToValueAtTime(520, t0 + 0.1);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
      osc.start(t0);
      osc.stop(t0 + 0.13);
      return;
    }

    if (type === "hit") {
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(180, t0);
      osc.frequency.exponentialRampToValueAtTime(90, t0 + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
      osc.start(t0);
      osc.stop(t0 + 0.11);
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
        g.gain.exponentialRampToValueAtTime(
          0.0001,
          t0 + i * 0.06 + 0.055
        );
        o.connect(g);
        g.connect(audioCtx.destination);
        o.start(t0 + i * 0.06);
        o.stop(t0 + i * 0.06 + 0.06);
      });
      return;
    }

    if (type === "gameover") {
      osc.type = "triangle";
      osc.frequency.setValueAtTime(220, t0);
      osc.frequency.exponentialRampToValueAtTime(110, t0 + 0.25);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
      osc.start(t0);
      osc.stop(t0 + 0.31);
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
        g.gain.exponentialRampToValueAtTime(
          0.0001,
          nextMusicAt + stepDur * 0.85
        );

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
    player: "assets/player.png",
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
  function spawnParticles(x, y, count = 10) {
    for (let i = 0; i < count; i++) {
      particles.push({
        x,
        y,
        vx: (Math.random() * 2 - 1) * 90,
        vy: (Math.random() * -1.5 - 0.2) * 120,
        life: 0.5 + Math.random() * 0.4,
        age: 0,
        size: 1 + Math.random() * 2,
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
      p.vy += 320 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }
  function drawParticles() {
    for (const p of particles) {
      const a = 1 - p.age / p.life;
      ctx.fillStyle = `rgba(230,240,255,${a})`;
      ctx.fillRect(
        Math.floor(p.x),
        Math.floor(p.y),
        Math.ceil(p.size),
        Math.ceil(p.size)
      );
    }
  }

  // ===================== World =====================
  const groundY = 140;

  // Split into: stable "ground segments" + "upper platforms"
  const ground = [];     // segments at y=groundY
  const platforms = [];  // upper platforms (y < groundY)

  function addGroundSeg(x, w) {
    ground.push({ x, y: groundY, w, h: 40 });
  }
  function addPlatform(x, y, w) {
    platforms.push({ x, y, w, h: 10 });
  }

  // Ground generation settings:
  // Mostly continuous, with occasional gaps.
  const GROUND_GAP_CHANCE = 0.16; // chance a segment is a gap when generating
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
    baseScroll = 90;
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
    nextSwordSpawnAt = 3; // first sword ~3s in

    genMode = "easy";
    genModeLeft = irand(4, 7);
    lastPlatY = irand(92, 118);
  }

  // Ensure ground exists ahead, with occasional gaps
  function ensureGroundAhead() {
    let far = -Infinity;
    for (const g of ground) far = Math.max(far, g.x + g.w);
    if (far === -Infinity) far = camX - 500;

    while (far < camX + W + 600) {
      const makeGap = Math.random() < GROUND_GAP_CHANCE;

      if (makeGap) {
        // advance by gap (no segment)
        far += irand(GROUND_GAP_MIN, GROUND_GAP_MAX);
      } else {
        const w = irand(GROUND_SEG_W_MIN, GROUND_SEG_W_MAX);
        addGroundSeg(far, w);
        far += w;
      }
    }

    // cleanup
    for (let i = ground.length - 1; i >= 0; i--) {
      const g = ground[i];
      if (g.x + g.w < camX - 900) ground.splice(i, 1);
    }
  }

  // Upper platforms generator (independent of ground)
  function ensurePlatformsAhead() {
    let far = 0;
    for (const p of platforms) far = Math.max(far, p.x + p.w);

    while (far < camX + W + 420) {
      if (genModeLeft <= 0) {
        genMode = pickGenMode();
        genModeLeft = genMode === "easy" ? irand(5, 9) : irand(4, 7);
      }
      genModeLeft--;

      let gap = 0;
      let w = 0;
      let y = lastPlatY;

      if (genMode === "easy") {
        gap = irand(70, 120);
        w = irand(56, 110);
        y = clamp(lastPlatY + irand(-10, 10), 76, 124);
      } else if (genMode === "stairs") {
        gap = irand(70, 110);
        w = irand(50, 90);
        y = clamp(lastPlatY + irand(-18, 18), 68, 124);
      } else {
        gap = irand(110, 165);
        w = irand(44, 84);
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
  };

  const ghost = {
    x: -60,
    y: 60,
    w: 48,
    h: 64,
    speed: 0,
    pushedBackUntil: 0,
    state: "calm",
    stateTime: 0,
  };

  // ===================== Sword spawn =====================
  let sword = null,
    nextSwordSpawnAt = 0;

  function maybeSpawnSword(tSec) {
    if (tSec < nextSwordSpawnAt) return;

    // Prefer upper platforms; if none, place slightly above ground
    const candidates = platforms.filter(
      (p) => p.x > camX + 90 && p.x < camX + W + 420
    );
    const p = candidates.length
      ? candidates[irand(0, candidates.length - 1)]
      : null;

    const sx = p ? p.x + p.w * 0.5 - 4 : camX + W + 140;
    const sy = p ? p.y - 12 : groundY - 22;

    sword = { x: sx, y: sy, w: 10, h: 12, active: true };
    nextSwordSpawnAt = tSec + 20;
  }

  // ===================== Feel tuning =====================
  const GRAVITY = 1100;
  const JUMP_V = 380;
  const MOVE_AIR = 0.95,
    MOVE_GROUND = 0.82;
  const COYOTE_TIME = 0.12;
  const JUMP_BUFFER = 0.12;
  const JUMP_CUT = 0.55;

  // ===================== Ghost AI =====================
  function updateGhost(dt, tSec) {
    ghost.stateTime += dt;

    baseScroll = 90 + tSec * 2.0 + ghostsRepelled * 0.8;
    ghost.speed = baseScroll * (1.03 + Math.min(0.35, tSec / 80));

    const inGrace = now < graceUntil;

    if (
      !inGrace &&
      tSec > 45 &&
      ghost.state !== "lunge" &&
      Math.random() < 0.002
    ) {
      ghost.state = "lunge";
      ghost.stateTime = 0;
    }

    if (inGrace) {
      ghost.x = Math.min(ghost.x, 20);
    } else if (ghost.state === "lunge") {
      if (ghost.stateTime < 0.6)
        ghost.x += (ghost.speed * 1.6 - baseScroll) * dt + 26 * dt;
      else ghost.state = "calm";
    } else {
      if (now < ghost.pushedBackUntil) ghost.x -= 120 * dt;
      else ghost.x += (ghost.speed - baseScroll) * dt + 14 * dt;
    }

    ghost.y = 62 + Math.sin(tSec * 3.1) * 4;
  }

  // ===================== Game over / restart =====================
  function triggerGameOver(reason) {
    if (gameOver) return;
    gameOver = true;
    gameOverReason = reason;
    best = Math.max(best, (now - startedAt) / 1000);
    sfx("gameover");
    addShake(8, 0.25);
  }

  function restart() {
    gameOver = false;
    gameOverReason = "";
    started = false;
    graceUntil = 0;

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

    ghost.x = -60;
    ghost.y = 60;
    ghost.pushedBackUntil = 0;
    ghost.state = "calm";
    ghost.stateTime = 0;

    startedAt = performance.now();
    now = startedAt;
    last = startedAt;

    seedWorld();
  }

  // ===================== Rendering =====================
  function drawTiled(img, speed) {
    if (!img || !img.width) return;
    const px = Math.floor(camX * speed) % img.width;
    ctx.drawImage(img, -px, 0);
    ctx.drawImage(img, -px + img.width, 0);
  }

  function drawBackground() {
    ctx.fillStyle = "#070a14";
    ctx.fillRect(0, 0, W, H);

    drawTiled(AS.bg_far, 0.18);
    drawTiled(AS.bg_mid, 0.35);
    drawTiled(AS.bg_near, 0.7);

    ctx.fillStyle = "rgba(120,140,255,0.03)";
    ctx.fillRect(0, 92, W, 46);
  }

  function drawTilesBar(x, y, w, h) {
    // draw using tiles.png if present
    if (AS.tiles && AS.tiles.width) {
      const tw = 8, th = 8;
      const cols = Math.ceil(w / tw);
      for (let i = 0; i < cols; i++) {
        const dx = x + i * tw;
        ctx.drawImage(AS.tiles, 0, 0, tw, th, dx, y, tw, th);
      }
      // thickness fill (optional)
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

  function drawSwordPickup() {
    if (!sword || !sword.active) return;
    const x = Math.floor(sword.x - camX);
    const y = Math.floor(sword.y);
    if (AS.sword && AS.sword.width) ctx.drawImage(AS.sword, x, y);
    else {
      ctx.fillStyle = "#e8eefc";
      ctx.fillRect(x + 7, y + 1, 2, 10);
      ctx.fillRect(x + 3, y + 10, 10, 2);
    }
  }

  function drawStickmanHitboxAligned(px, py) {
    const x = Math.floor(px);
    const y = Math.floor(py);
    ctx.fillStyle = "#e8eefc";
    ctx.fillRect(x + 3, y + 0, 6, 6);
    ctx.fillRect(x + 5, y + 6, 2, 8);
    ctx.fillRect(x + 1, y + 8, 4, 2);
    ctx.fillRect(x + 7, y + 8, 4, 2);
    ctx.fillRect(x + 3, y + 14, 2, 6);
    ctx.fillRect(x + 7, y + 14, 2, 6);
  }

  function drawPlayer() {
    if (AS.player && AS.player.width) {
      const fw = 48, fh = 48;
      const cols = Math.max(1, Math.floor(AS.player.width / fw));
      let row = 0;
      if (player.attackUntil > now) row = 3;
      else if (!player.onGround) row = 2;
      else if (Math.abs(player.vx) > 20) row = 1;

      const fps = row === 1 ? 12 : 8;
      const frame = Math.floor((now / 1000) * fps) % cols;

      const feetY = player.y + player.h;
      const dx = Math.floor(player.x - 18);
      const dy = Math.floor(feetY - fh);

      ctx.drawImage(AS.player, frame * fw, row * fh, fw, fh, dx, dy, fw, fh);
    } else {
      drawStickmanHitboxAligned(player.x, player.y);
    }
  }

  function drawGhost() {
    if (AS.ghost && AS.ghost.width) {
      const fw = 64, fh = 64;
      const cols = Math.max(1, Math.floor(AS.ghost.width / fw));
      const fps = ghost.state === "lunge" ? 10 : 6;
      const frame = Math.floor((now / 1000) * fps) % cols;

      ctx.globalAlpha = 0.95;
      ctx.drawImage(AS.ghost, frame * fw, 0, fw, fh, Math.floor(ghost.x), Math.floor(ghost.y), fw, fh);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = "rgba(210,220,255,0.85)";
      ctx.fillRect(Math.floor(ghost.x), Math.floor(ghost.y), ghost.w, ghost.h);
    }
  }

  function drawAttackEffect() {
    if (player.attackUntil <= now) return;
    const x = player.x, y = player.y;
    ctx.fillStyle = "rgba(230,240,255,0.98)";
    if (player.attackDir === "right") ctx.fillRect(x + player.w, y + 7, 16, 2);
    else if (player.attackDir === "left") ctx.fillRect(x - 16, y + 7, 16, 2);
    else if (player.attackDir === "up") ctx.fillRect(x + 5, y - 16, 2, 16);
    else ctx.fillRect(x + 5, y + player.h, 2, 16);
  }

  function drawHUD(tSec) {
    const swordIn = Math.max(0, nextSwordSpawnAt - tSec);
    const swordLine = sword && sword.active ? "Sword: ON MAP" : `Next sword: ${swordIn.toFixed(1)}s`;

    let status =
      `Time: ${started ? tSec.toFixed(2) : "0.00"}s\n` +
      `Best: ${best.toFixed(2)}s\n` +
      `Repels: ${ghostsRepelled}\n` +
      `${swordLine}\n`;

    status += player.hasSword
      ? `Sword: ${Math.max(0, (player.swordUntil - now) / 1000).toFixed(1)}s  Aim: ${player.attackDir.toUpperCase()}`
      : "No sword";

    status += `\nAssets: ${assetSummary()}`;
    status += `\nSound: ${audioEnabled ? "ON" : "OFF (click game / press key)"}`;

    if (!started && !gameOver) {
      status += `\n\nPress SPACE / ↑ to start`;
    } else if (now < graceUntil && !gameOver) {
      status += `\n\nGrace: ${(Math.max(0, (graceUntil - now) / 1000)).toFixed(1)}s`;
    }

    if (gameOver) status += `\n\nGAME OVER\n${gameOverReason}\nPress R`;
    hudEl.textContent = status;
  }

  // ===================== Physics collision =====================
  function landOn(p) {
    player.y = p.y - player.h;
    player.vy = 0;
    player.onGround = true;
    player.coyote = COYOTE_TIME;
  }

  // ===================== Step =====================
  function step(dt) {
    tickMusic();

    const tSec = (now - startedAt) / 1000;

    // keep world ahead
    ensureGroundAhead();
    ensurePlatformsAhead();
    maybeSpawnSword(tSec);

    if (wasPressed("r")) restart();

    if (!started && !gameOver) {
      const startPressed =
        wasPressed(" ") || wasPressed("arrowup") || wasPressed("d") || wasPressed("arrowright");
      if (startPressed) {
        started = true;
        graceUntil = now + 2000;
        ensureAudio();
      } else {
        return;
      }
    }
    if (gameOver) return;

    const jumpPressed = wasPressed(" ") || wasPressed("arrowup");
    const attackPressed = wasPressed("x");

    // coyote/buffer
    player.coyote -= dt;
    player.jumpBuffer -= dt;
    if (jumpPressed) player.jumpBuffer = JUMP_BUFFER;

    // horizontal
    const right = keys.has("arrowright") || keys.has("d");
    const left = keys.has("arrowleft") || keys.has("a");
    const ax = 900;
    if (right) player.vx += ax * dt;
    if (left) player.vx -= ax * dt;
    player.vx *= player.onGround ? MOVE_GROUND : MOVE_AIR;
    player.vx = clamp(player.vx, -160, 180);

    // integrate
    player.vy += GRAVITY * dt;
    player.x += player.vx * dt;
    player.y += player.vy * dt;

    // keep in lane
    player.x = clamp(player.x, 36, 160);

    // collisions: check ground segments + upper platforms
    player.onGround = false;

    const worldP = { x: player.x + camX, y: player.y, w: player.w, h: player.h };
    const prevY = player.y - player.vy * dt;
    const wasAbove = prevY + player.h;

    const skin = 6;

    // ---- land on ground segments ----
    for (const g of ground) {
      // overlap in X?
      if (worldP.x + worldP.w > g.x && worldP.x < g.x + g.w) {
        const wasAboveGround = wasAbove <= g.y + 1;
        const isFalling = player.vy >= 0;
        const hitsTop = player.y + player.h >= g.y && player.y + player.h <= g.y + skin;
        if (wasAboveGround && isFalling && hitsTop) {
          landOn(g);
          break;
        }
      }
    }

    // ---- land on platforms ----
    if (!player.onGround) {
      for (const p of platforms) {
        if (worldP.x + worldP.w > p.x && worldP.x < p.x + p.w) {
          const wasAbovePlat = wasAbove <= p.y + 1;
          const isFalling = player.vy >= 0;
          const hitsTop = player.y + player.h >= p.y && player.y + player.h <= p.y + skin;
          if (wasAbovePlat && isFalling && hitsTop) {
            landOn(p);
            break;
          }
        }
      }
    }

    // fall death
    if (player.y > H + 60) triggerGameOver("You fell!");

    // jump
    if (player.jumpBuffer > 0 && player.coyote > 0) {
      player.vy = -JUMP_V;
      player.onGround = false;
      player.coyote = 0;
      player.jumpBuffer = 0;
      sfx("jump");
    }

    // variable jump
    const jumpHeld = keys.has(" ") || keys.has("arrowup");
    if (!jumpHeld && player.vy < 0) player.vy *= JUMP_CUT;

    // attack direction toward ghost
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
        player.swordUntil = now + 6000;
        sfx("pickup");
      }
    }

    // sword expires
    if (player.hasSword && now > player.swordUntil) {
      player.hasSword = false;
      player.attackUntil = 0;
    }

    // ghost
    updateGhost(dt, tSec);

    // hit detect
    const ghostBox = { x: ghost.x, y: ghost.y, w: ghost.w, h: ghost.h };

    if (player.attackUntil > now) {
      let hit;
      switch (player.attackDir) {
        case "right": hit = { x: player.x + player.w, y: player.y + 4, w: 18, h: 10 }; break;
        case "left":  hit = { x: player.x - 18, y: player.y + 4, w: 18, h: 10 }; break;
        case "up":    hit = { x: player.x + 3, y: player.y - 18, w: 8, h: 18 }; break;
        case "down":  hit = { x: player.x + 3, y: player.y + player.h, w: 8, h: 18 }; break;
      }

      if (hit && aabb(hit, ghostBox)) {
        ghostsRepelled++;
        ghost.x -= 170;
        ghost.pushedBackUntil = now + 900;

        spawnParticles(ghost.x + ghost.w * 0.5, ghost.y + ghost.h * 0.5, 18);
        sfx("hit");
        addShake(6, 0.14);
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
      shakeT -= Math.min(shakeT, 1 / 60);
      const mag = shakeMag * (shakeT / Math.max(0.001, shakeT + 0.05));
      ox = (Math.random() * 2 - 1) * mag;
      oy = (Math.random() * 2 - 1) * mag;
      if (shakeT <= 0) shakeMag = 0;
    }

    ctx.save();
    ctx.translate(ox, oy);

    drawBackground();

    // draw ground segments first (stable lane)
    for (const g of ground) {
      const sx = Math.floor(g.x - camX);
      if (sx + g.w < -150 || sx > W + 150) continue;
      drawGroundSeg(g);
    }

    // draw upper platforms
    for (const p of platforms) {
      const sx = Math.floor(p.x - camX);
      if (sx + p.w < -150 || sx > W + 150) continue;
      drawPlatform(p);
    }

    drawSwordPickup();
    drawGhost();
    drawPlayer();
    drawAttackEffect();
    drawParticles();

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
    restart(); // seeds world
    // return to title state
    started = false;
    gameOver = false;
    gameOverReason = "";
    requestAnimationFrame(frame);
  });
})();
