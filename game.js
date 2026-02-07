(() => {
  // ===== Canvas (base resolution for pixel look) =====
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const hudEl = document.getElementById("hud");

  const W = canvas.width;   // 320
  const H = canvas.height;  // 180

  // ===== Controls =====
  const keys = new Set();
  const pressed = new Set(); // edge-triggered
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    keys.add(k);
    pressed.add(k);
    // prevent page scrolling with arrows/space
    if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(e.key.toLowerCase()) || e.code === "Space") {
      e.preventDefault();
    }
  }, { passive: false });

  window.addEventListener("keyup", (e) => {
    keys.delete(e.key.toLowerCase());
  });

  function wasPressed(k) {
    return pressed.has(k);
  }

  // ===== Utility =====
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const irand = (a, b) => Math.floor(rand(a, b + 1));

  function aabb(a, b) {
    return (
      a.x < b.x + b.w &&
      a.x + a.w > b.x &&
      a.y < b.y + b.h &&
      a.y + a.h > b.y
    );
  }

  // ===== World settings =====
  const GRAVITY = 900;      // px/s^2
  const JUMP_V = 320;       // px/s
  const MOVE_AIR = 0.92;
  const MOVE_GROUND = 0.84;

  // Scrolling speed baseline (increases over time)
  let baseScroll = 90;      // px/s

  // ===== Game entities =====
  const player = {
    x: 70,
    y: 40,
    w: 10,
    h: 18,
    vx: 0,
    vy: 0,
    onGround: false,
    hasSword: false,
    swordUntil: 0,
    attackUntil: 0,
    attackDir: "right", // "left" | "right" | "up" | "down"
  };

  const ghost = {
    // ghost position is tracked in screen-space
    x: -40,
    y: 60,
    w: 34,
    h: 44,
    speed: 0,      // set each frame from difficulty
    rage: 0,       // increases over time for subtle speed-up
    pushedBackUntil: 0,
  };

  // Platforms exist in "world X" coordinates (they scroll left as camera moves right)
  let camX = 0; // world camera x
  const platforms = [];
  const groundY = 150;

  // Sword spawn object
  let sword = null; // {x,y,w,h,active,nextSpawnAt}
  let nextSwordSpawnAt = 0;

  // Score/time
  let startedAt = performance.now();
  let now = startedAt;
  let last = startedAt;
  let gameOver = false;
  let best = 0;
  let ghostsRepelled = 0;

  // ===== Procedural platform generation =====
  function seedWorld() {
    platforms.length = 0;
    camX = 0;
    baseScroll = 90;
    ghostsRepelled = 0;

    // Ground segments (big)
    platforms.push({ x: -200, y: groundY, w: 2000, h: 30, type: "ground" });

    // Starter platforms
    let x = 120;
    for (let i = 0; i < 10; i++) {
      addPlatformChunk(x);
      x += irand(60, 110);
    }

    sword = null;
    nextSwordSpawnAt = 0; // spawn quickly at start
  }

  function addPlatformChunk(atX) {
    // platform width and height
    const w = irand(28, 70);
    const y = irand(70, 135);

    const yy = clamp(y, 60, groundY - 12);

    platforms.push({
      x: atX,
      y: yy,
      w,
      h: 10,
      type: "plat",
    });
  }

  function ensurePlatformsAhead() {
    // Find farthest platform end
    let far = 0;
    for (const p of platforms) far = Math.max(far, p.x + p.w);
    // Ensure at least one screen + buffer ahead
    while (far < camX + W + 260) {
      const nextX = far + irand(50, 120);
      addPlatformChunk(nextX);
      far = nextX + platforms[platforms.length - 1].w;
    }

    // Cleanup far-behind platforms (except the long ground)
    for (let i = platforms.length - 1; i >= 0; i--) {
      const p = platforms[i];
      if (p.type === "plat" && p.x + p.w < camX - 200) platforms.splice(i, 1);
    }
  }

  // ===== Sword spawns every 20 seconds =====
  function maybeSpawnSword(tSec) {
    if (tSec < nextSwordSpawnAt) return;
    // Place sword on a random platform slightly ahead
    const candidates = platforms.filter(p => p.type === "plat" && p.x > camX + 80 && p.x < camX + W + 260);
    const p = candidates.length ? candidates[irand(0, candidates.length - 1)] : null;

    const sx = p ? (p.x + p.w * 0.5 - 4) : (camX + W + 120);
    const sy = p ? (p.y - 10) : (groundY - 40);

    sword = { x: sx, y: sy, w: 8, h: 10, active: true };
    nextSwordSpawnAt = tSec + 20; // every 20 seconds
  }

  // ===== Physics & collisions =====
  function step(dt) {
    if (gameOver) return;

    // Difficulty: scroll gets faster slowly
    const tSec = (now - startedAt) / 1000;
    baseScroll = 90 + tSec * 2.2 + ghostsRepelled * 0.8;

    // Ghost speed slightly faster than scroll (so it pressures you)
    ghost.speed = baseScroll * (1.02 + Math.min(0.18, tSec / 120));

    // Sword spawn timing
    maybeSpawnSword(tSec);

    // Player input
    const jumpPressed = wasPressed(" ") || wasPressed("arrowup");
    const attackPressed = wasPressed("x");
    const restartPressed = wasPressed("r");

    if (restartPressed) restart();

    // Jump
    if (jumpPressed && player.onGround) {
      player.vy = -JUMP_V;
      player.onGround = false;
    }

    // Attack (directional toward ghost)
    if (attackPressed && player.hasSword) {
      player.attackUntil = now + 140;

      // Determine attack direction toward ghost (screen-space)
      const px = player.x + player.w / 2;
      const py = player.y + player.h / 2;
      const gx = ghost.x + ghost.w / 2;
      const gy = ghost.y + ghost.h / 2;

      const dx = gx - px;
      const dy = gy - py;

      if (Math.abs(dx) > Math.abs(dy)) {
        player.attackDir = dx > 0 ? "right" : "left";
      } else {
        player.attackDir = dy > 0 ? "down" : "up";
      }
    }

    // Let player "run" with slight control
    const right = keys.has("arrowright") || keys.has("d");
    const left  = keys.has("arrowleft") || keys.has("a");

    const ax = 240;
    if (right) player.vx += ax * dt;
    if (left)  player.vx -= ax * dt;
    player.vx *= player.onGround ? MOVE_GROUND : MOVE_AIR;
    player.vx = clamp(player.vx, -120, 140);

    // Apply gravity
    player.vy += GRAVITY * dt;

    // Integrate
    player.x += player.vx * dt;
    player.y += player.vy * dt;

    // Keep player in a “runner” band on screen
    player.x = clamp(player.x, 40, 150);

    // Collide with platforms (simple vertical collision)
    player.onGround = false;
    const worldPlayer = { x: player.x + camX, y: player.y, w: player.w, h: player.h };

    for (const p of platforms) {
      const plat = { x: p.x, y: p.y, w: p.w, h: p.h };
      // Only consider if overlapping in X
      if (worldPlayer.x + worldPlayer.w > plat.x && worldPlayer.x < plat.x + plat.w) {
        // coming down onto platform
        const prevY = player.y - player.vy * dt;
        const wasAbove = (prevY + player.h) <= plat.y + 1;
        const isFalling = player.vy >= 0;
        const hitsTop = (player.y + player.h) >= plat.y && (player.y + player.h) <= plat.y + 10;

        if (wasAbove && isFalling && hitsTop) {
          player.y = plat.y - player.h;
          player.vy = 0;
          player.onGround = true;
          worldPlayer.y = player.y;
        }
      }
    }

    // Fall below screen => game over
    if (player.y > H + 40) {
      triggerGameOver("You fell!");
    }

    // Scroll camera forward continuously
    camX += baseScroll * dt;

    // Sword pickup
    if (sword && sword.active) {
      const swordBox = { x: sword.x - camX, y: sword.y, w: sword.w, h: sword.h };
      const playerBox = { x: player.x, y: player.y, w: player.w, h: player.h };
      if (aabb(playerBox, swordBox)) {
        sword.active = false;
        player.hasSword = true;
        player.swordUntil = now + 6000; // sword lasts 6 seconds after pickup
      }
    }

    // Sword expiry
    if (player.hasSword && now > player.swordUntil) {
      player.hasSword = false;
      player.attackUntil = 0;
    }

    // Ghost position: it moves right in screen space chasing player
    if (now < ghost.pushedBackUntil) {
      ghost.x -= 60 * dt;
    } else {
      ghost.x += (ghost.speed - baseScroll) * dt + 14 * dt; // net gain
    }

    // Keep ghost y hovering
    ghost.y = 62 + Math.sin(tSec * 3.3) * 3;

    // Player attack hitbox and ghost collision
    const ghostBox = { x: ghost.x, y: ghost.y, w: ghost.w, h: ghost.h };
    const attackActive = player.attackUntil > now;

    if (attackActive) {
      let hit;

      switch (player.attackDir) {
        case "right":
          hit = { x: player.x + player.w, y: player.y + 4, w: 14, h: 8 };
          break;
        case "left":
          hit = { x: player.x - 14, y: player.y + 4, w: 14, h: 8 };
          break;
        case "up":
          hit = { x: player.x + 2, y: player.y - 14, w: 6, h: 14 };
          break;
        case "down":
          hit = { x: player.x + 2, y: player.y + player.h, w: 6, h: 14 };
          break;
      }

      if (aabb(hit, ghostBox)) {
        ghostsRepelled++;
        ghost.x -= 70; // shove left
        ghost.pushedBackUntil = now + 700; // short grace period
      }
    }

    // Ghost catches player
    const playerBox = { x: player.x, y: player.y, w: player.w, h: player.h };
    if (aabb(playerBox, ghostBox)) {
      triggerGameOver("The ghost caught you!");
    }

    ensurePlatformsAhead();
  }

  function triggerGameOver(reason) {
    gameOver = true;
    const t = (now - startedAt) / 1000;
    best = Math.max(best, t);
    gameOverReason = reason;
  }

  // ===== Rendering =====
  let gameOverReason = "";

  function draw() {
    // Clear
    ctx.clearRect(0, 0, W, H);

    // Background: simple pixel layers
    drawBackground();

    // Platforms
    for (const p of platforms) {
      const sx = Math.floor(p.x - camX);
      if (sx + p.w < -40 || sx > W + 40) continue;
      drawPlatform(sx, p.y, p.w, p.h, p.type);
    }

    // Sword
    if (sword && sword.active) {
      drawSword(Math.floor(sword.x - camX), sword.y);
    }

    // Ghost
    drawGhost(Math.floor(ghost.x), ghost.y);

    // Player
    drawStickman(player.x, player.y, player.hasSword);

    // Attack effect (directional)
    if (player.attackUntil > now) {
      drawSlash(player, player.attackDir);
    }

    // HUD
    const tSec = (now - startedAt) / 1000;
    const swordIn = Math.max(0, nextSwordSpawnAt - tSec);
    const swordLine = sword && sword.active ? "Sword: ON MAP" : `Next sword: ${swordIn.toFixed(1)}s`;

    let status = `Time: ${tSec.toFixed(2)}s\nBest: ${best.toFixed(2)}s\nGhost repelled: ${ghostsRepelled}\n${swordLine}\n`;
    if (player.hasSword) {
      const left = Math.max(0, (player.swordUntil - now) / 1000);
      status += `Sword power: ${left.toFixed(1)}s\nAttack: X\nAim: ${player.attackDir.toUpperCase()}`;
    } else {
      status += `No sword`;
    }

    if (gameOver) {
      drawGameOver(tSec);
      status += `\n\nGAME OVER\n${gameOverReason}\nPress R`;
    }

    hudEl.textContent = status;
  }

  function drawBackground() {
    // Sky
    ctx.fillStyle = "#070a14";
    ctx.fillRect(0, 0, W, H);

    // Stars
    ctx.fillStyle = "#1b2447";
    for (let i = 0; i < 35; i++) {
      const x = (i * 37 + Math.floor(camX * 0.3)) % (W + 20) - 10;
      const y = (i * 19) % 90;
      ctx.fillRect(x, y, 1, 1);
    }

    // Distant city silhouettes (parallax)
    const px = Math.floor(camX * 0.35);
    ctx.fillStyle = "#0e1430";
    for (let i = -2; i < 16; i++) {
      const x = i * 34 - (px % 34);
      const h = 20 + ((i * 13) % 18);
      ctx.fillRect(x, 110 - h, 22, h);
    }

    // Mist band
    ctx.fillStyle = "rgba(120,140,255,0.06)";
    ctx.fillRect(0, 96, W, 44);
  }

  function drawPlatform(x, y, w, h, type) {
    // Pixelated tiles
    if (type === "ground") {
      ctx.fillStyle = "#1a2a20";
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "#223827";
      for (let i = 0; i < w; i += 6) ctx.fillRect(x + i, y + 2, 3, 2);
      ctx.fillStyle = "#0e1912";
      ctx.fillRect(x, y + h - 6, w, 6);
    } else {
      ctx.fillStyle = "#2a2f4a";
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "#3c4167";
      for (let i = 0; i < w; i += 8) ctx.fillRect(x + i, y + 2, 4, 2);
      ctx.fillStyle = "#171a2b";
      ctx.fillRect(x, y + h - 3, w, 3);
    }
  }

  function drawStickman(x, y, hasSword) {
    // Stickman in pixel strokes
    ctx.fillStyle = "#e8eefc";

    // Head
    ctx.fillRect(Math.floor(x + 3), Math.floor(y), 4, 4);

    // Body
    ctx.fillRect(Math.floor(x + 4), Math.floor(y + 4), 2, 7);

    // Arms
    ctx.fillRect(Math.floor(x + 1), Math.floor(y + 6), 3, 1);
    ctx.fillRect(Math.floor(x + 6), Math.floor(y + 6), 3, 1);

    // Legs
    ctx.fillRect(Math.floor(x + 3), Math.floor(y + 11), 1, 6);
    ctx.fillRect(Math.floor(x + 6), Math.floor(y + 11), 1, 6);

    // Sword indicator (tiny)
    if (hasSword) {
      ctx.fillStyle = "#d7d7ff";
      ctx.fillRect(Math.floor(x + 9), Math.floor(y + 6), 1, 8);
      ctx.fillStyle = "#c2a84b";
      ctx.fillRect(Math.floor(x + 8), Math.floor(y + 10), 3, 1);
    }
  }

  function drawGhost(x, y) {
    // Giant ghost: big rounded pixel blob with face
    const w = ghost.w, h = ghost.h;

    // Body
    ctx.fillStyle = "rgba(210,220,255,0.85)";
    ctx.fillRect(x, Math.floor(y), w, h);

    // Jagged bottom pixels
    ctx.fillStyle = "rgba(170,185,255,0.70)";
    for (let i = 0; i < w; i += 4) {
      const hh = 3 + ((i * 7) % 6);
      ctx.fillRect(x + i, Math.floor(y) + h - hh, 2, hh);
    }

    // Outline-ish shadow
    ctx.fillStyle = "rgba(50,70,150,0.18)";
    ctx.fillRect(x + 1, Math.floor(y) + 1, w - 2, h - 2);

    // Eyes
    ctx.fillStyle = "#0b1020";
    ctx.fillRect(x + 10, Math.floor(y) + 14, 4, 6);
    ctx.fillRect(x + 20, Math.floor(y) + 14, 4, 6);

    // Mouth
    ctx.fillRect(x + 14, Math.floor(y) + 26, 8, 3);
  }

  function drawSword(x, y) {
    // Pixel sword pickup
    ctx.fillStyle = "#e8eefc";
    ctx.fillRect(x + 3, y, 2, 8);  // blade
    ctx.fillStyle = "#c2a84b";
    ctx.fillRect(x + 1, y + 7, 6, 2); // hilt
    ctx.fillStyle = "#7e5f2a";
    ctx.fillRect(x + 3, y + 9, 2, 1); // pommel
  }

  function drawSlash(player, dir) {
    ctx.fillStyle = "rgba(230,240,255,0.9)";

    const x = player.x;
    const y = player.y;

    switch (dir) {
      case "right":
        ctx.fillRect(Math.floor(x + player.w), Math.floor(y + 7), 12, 1);
        ctx.fillRect(Math.floor(x + player.w + 2), Math.floor(y + 6), 10, 1);
        ctx.fillRect(Math.floor(x + player.w + 4), Math.floor(y + 8), 8, 1);
        break;

      case "left":
        ctx.fillRect(Math.floor(x - 12), Math.floor(y + 7), 12, 1);
        ctx.fillRect(Math.floor(x - 10), Math.floor(y + 6), 10, 1);
        ctx.fillRect(Math.floor(x - 8), Math.floor(y + 8), 8, 1);
        break;

      case "up":
        ctx.fillRect(Math.floor(x + 4), Math.floor(y - 12), 1, 12);
        ctx.fillRect(Math.floor(x + 3), Math.floor(y - 10), 1, 10);
        ctx.fillRect(Math.floor(x + 5), Math.floor(y - 8), 1, 8);
        break;

      case "down":
        ctx.fillRect(Math.floor(x + 4), Math.floor(y + player.h), 1, 12);
        ctx.fillRect(Math.floor(x + 3), Math.floor(y + player.h + 2), 1, 10);
        ctx.fillRect(Math.floor(x + 5), Math.floor(y + player.h + 4), 1, 8);
        break;
    }
  }

  function drawGameOver(tSec) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#e8eefc";
    ctx.font = "bold 16px ui-monospace, monospace";
    ctx.fillText("GAME OVER", 98, 70);

    ctx.font = "12px ui-monospace, monospace";
    ctx.fillText(`Survived: ${tSec.toFixed(2)}s`, 95, 92);
    ctx.fillText("Press R to restart", 82, 112);
  }

  // ===== Loop =====
  function restart() {
    gameOver = false;
    gameOverReason = "";
    player.x = 70;
    player.y = 40;
    player.vx = 0;
    player.vy = 0;
    player.onGround = false;
    player.hasSword = false;
    player.swordUntil = 0;
    player.attackUntil = 0;
    player.attackDir = "right";

    ghost.x = -40;
    ghost.y = 60;
    ghost.pushedBackUntil = 0;

    startedAt = performance.now();
    now = startedAt;
    last = startedAt;

    seedWorld();
  }

  function frame(t) {
    now = t;
    const dt = Math.min(0.033, (t - last) / 1000);
    last = t;

    step(dt);
    draw();

    pressed.clear();
    requestAnimationFrame(frame);
  }

  // Start
  seedWorld();
  requestAnimationFrame(frame);
})();
