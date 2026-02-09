// Improved game.js — sprite animations, parallax, particles, better ghost AI, directional attacks
(() => {
  // ---------------- Canvas ----------------
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const W = canvas.width, H = canvas.height;
  const hudEl = document.getElementById("hud");

  // --------------- Input -------------------
  const keys = new Set();
  const pressed = new Set();
  window.addEventListener("keydown", (e) => {
    keys.add(e.key.toLowerCase());
    pressed.add(e.key.toLowerCase());
    if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(e.key.toLowerCase()) || e.code === "Space") e.preventDefault();
  }, { passive: false });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

  function wasPressed(k){ return pressed.has(k); }

  // --------------- Utility -----------------
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const irand = (a,b) => Math.floor(a + Math.random()*(b-a+1));
  function aabb(a,b){ return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }

  // --------------- Time & State ------------
  let now = performance.now(), last = now;
  let startedAt = now, gameOver = false, best = 0;
  let camX = 0;
  let baseScroll = 90;
  let ghostsRepelled = 0;

  // --------------- Assets & Loader ----------
  const assetList = {
    player: "assets/player.png",
    ghost: "assets/ghost.png",
    tiles: "assets/tiles.png",
    sword: "assets/sword.png",
    bg_far: "assets/bg_far.png",
    bg_mid: "assets/bg_mid.png",
    bg_near: "assets/bg_near.png",
    sfx_jump: "assets/sfx_jump.wav",
    sfx_hit: "assets/sfx_hit.wav",
    sfx_pick: "assets/sfx_pickup.wav",
    music: "assets/music_loop.mp3"
  };
  const AS = {};
  let assetsToLoad = Object.keys(assetList).length;
  function loadAssets(cb){
    let count = 0;
    function done(){ count++; if(count===assetsToLoad) cb(); }
    for(const k in assetList){
      if(assetList[k].match(/\.(png|jpg|jpeg)$/i)){
        const img = new Image();
        img.src = assetList[k];
        img.onload = done;
        img.onerror = done;
        AS[k]=img;
      } else {
        // audio
        const a = new Audio();
        a.src = assetList[k];
        a.oncanplaythrough = done;
        a.onerror = done;
        AS[k]=a;
      }
    }
  }

  // --------------- Particles ----------------
  const particles = [];
  function spawnParticles(x,y,count=8,color="#e8eefc"){
    for(let i=0;i<count;i++){
      particles.push({
        x, y,
        vx: (Math.random()*2-1)*80,
        vy: (Math.random()*-1.5-0.2)*100,
        life: 0.5 + Math.random()*0.4,
        age: 0,
        color,
        size: 1 + Math.random()*2
      });
    }
  }
  function updateParticles(dt){
    for(let i=particles.length-1;i>=0;i--){
      const p = particles[i];
      p.age += dt;
      if(p.age >= p.life) { particles.splice(i,1); continue; }
      p.vy += 300 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }
  function drawParticles(){
    ctx.fillStyle = "#fff";
    for(const p of particles){
      const alpha = 1 - (p.age / p.life);
      ctx.fillStyle = `rgba(230,240,255,${alpha})`;
      ctx.fillRect(Math.floor(p.x), Math.floor(p.y), Math.ceil(p.size), Math.ceil(p.size));
    }
  }

  // --------------- Animation helper ----------
  class SpriteAnim {
    constructor(img, frameW, frameH, rows){
      this.img = img;
      this.fw = frameW; this.fh = frameH; this.rows = rows || 1;
      this.cols = Math.floor(img.width / frameW);
      this.anim = { row:0, from:0, to:this.cols-1, fps:8, time:0 };
    }
    set(row, from, to, fps){
      this.anim = { row, from, to, fps, time:0 };
    }
    step(dt){
      this.anim.time += dt;
      const frameCount = this.anim.to - this.anim.from + 1;
      const idx = Math.floor(this.anim.time * this.anim.fps) % frameCount;
      return this.anim.from + idx;
    }
    draw(ctx, sx, sy, scale=1, flip=false){
      const frame = this.step(0); // note: used only to compute width in some calls; we will instead compute dynamically when drawing
    }
    drawFrame(ctx, frameIndex, row, dx, dy, scale=1){
      const sx = frameIndex * this.fw;
      const sy = row * this.fh;
      ctx.drawImage(this.img, sx, sy, this.fw, this.fh, Math.floor(dx), Math.floor(dy), this.fw*scale, this.fh*scale);
    }
    currentFrame(dt){
      this.anim.time += dt;
      const frameCount = this.anim.to - this.anim.from + 1;
      const idx = Math.floor(this.anim.time * this.anim.fps) % frameCount;
      return this.anim.from + idx;
    }
  }

  // --------------- Entities -----------------
  const groundY = 140;
  const platforms = [];
  function addPlatform(x,y,w){ platforms.push({x,y,w,h:10}); }
  function seedWorld(){
    platforms.length = 0;
    camX = 0; baseScroll = 90; ghostsRepelled = 0;
    platforms.push({x:-300,y:groundY,w:3000,h:40});
    let x = 140;
    for(let i=0;i<12;i++){ addPlatform(x, irand(72,120), irand(28,84)); x += irand(60,140); }
    sword = null; nextSwordSpawnAt = 0;
  }

  const player = {
    x:70, y:40, w:12, h:20,
    vx:0, vy:0, onGround:false,
    hasSword:false, swordUntil:0,
    attackUntil:0, attackDir:"right",
    sprite: null, // SpriteAnim filled on load
    facing: "right",
    coyote: 0, // coyote time
    jumpBuffer: 0
  };

  const ghost = {
    x:-60, y:60, w:48, h:64,
    speed:0, pushedBackUntil:0,
    sprite: null, state:"calm", stateTime:0
  };

  let sword = null, nextSwordSpawnAt = 0;

  // --------------- Sword spawn & pickup -------------
  function maybeSpawnSword(tSec){
    if(tSec < nextSwordSpawnAt) return;
    const candidates = platforms.filter(p => p.x > camX + 80 && p.x < camX + W + 260 && p.y < groundY);
    const p = candidates.length ? candidates[irand(0,candidates.length-1)] : null;
    const sx = p ? (p.x + p.w*0.5 - 4) : (camX + W + 120);
    const sy = p ? (p.y - 12) : (groundY - 38);
    sword = {x:sx, y:sy, w:10, h:12, active:true};
    nextSwordSpawnAt = tSec + 20;
  }

  // --------------- Gameplay tuning -------------
  const GRAVITY = 1100;
  const JUMP_V = 380;
  const MOVE_AIR = 0.95, MOVE_GROUND = 0.82;
  const COYOTE_TIME = 0.12; // sec
  const JUMP_BUFFER = 0.12;

  // --------------- Ghost AI ------------------
  function updateGhost(dt, tSec){
    ghost.stateTime += dt;
    // difficulty increases
    baseScroll = 90 + tSec * 2.2 + ghostsRepelled * 0.8;
    ghost.speed = baseScroll * (1.05 + Math.min(0.35, tSec/80));

    // Simple phased AI
    if(tSec > 45 && ghost.state !== "lunge" && Math.random() < 0.002){ ghost.state = "lunge"; ghost.stateTime = 0; }
    if(ghost.state === "lunge"){
      // aggressive push when close
      if(ghost.stateTime < 0.6) ghost.x += (ghost.speed*1.6 - baseScroll) * dt + 26*dt;
      else ghost.state = "calm";
    } else {
      // calm hover + net gain
      if(now < ghost.pushedBackUntil) ghost.x -= 120 * dt;
      else ghost.x += (ghost.speed - baseScroll) * dt + 14*dt;
    }
    ghost.y = 62 + Math.sin(tSec * 3.1 + (Math.floor(tSec) % 5)) * 4;
  }

  // --------------- Collision helpers ---------
  function worldPlayerBox(){
    return { x: player.x + camX, y: player.y, w: player.w, h: player.h };
  }

  // --------------- Rendering helpers ----------
  function drawParallax(){
    if(AS.bg_far){
      const px = Math.floor(camX * 0.18);
      ctx.drawImage(AS.bg_far, - (px % AS.bg_far.width), 0, AS.bg_far.width, H);
      ctx.drawImage(AS.bg_far, - (px % AS.bg_far.width) + AS.bg_far.width, 0, AS.bg_far.width, H);
    }
    if(AS.bg_mid){
      const px = Math.floor(camX * 0.35);
      ctx.drawImage(AS.bg_mid, - (px % AS.bg_mid.width), 0, AS.bg_mid.width, H);
      ctx.drawImage(AS.bg_mid, - (px % AS.bg_mid.width) + AS.bg_mid.width, 0, AS.bg_mid.width, H);
    }
    if(AS.bg_near){
      const px = Math.floor(camX * 0.7);
      ctx.drawImage(AS.bg_near, - (px % AS.bg_near.width), 0, AS.bg_near.width, H);
      ctx.drawImage(AS.bg_near, - (px % AS.bg_near.width) + AS.bg_near.width, 0, AS.bg_near.width, H);
    }
  }

  function drawTilePlatform(p){
    const sx = Math.floor(p.x - camX);
    // draw base tile repeated across width using tileset (8x8)
    if(AS.tiles){
      const tw = 8, th = 8;
      const cols = Math.ceil(p.w / tw);
      for(let i=0;i<cols;i++){
        const dx = sx + i*tw;
        ctx.drawImage(AS.tiles, 0, 0, tw, th, dx, p.y, tw, th); // simple tile usage
      }
      // top stripe
      ctx.fillStyle = "#2a2f4a";
      ctx.fillRect(sx, p.y+2, p.w, 2);
    } else {
      ctx.fillStyle = "#2a2f4a";
      ctx.fillRect(sx, p.y, p.w, p.h);
    }
  }

  function drawPlayer(dt){
    // choose animation row based on state
    let row = 0, frame = 0;
    if(player.attackUntil > now) row = 3;
    else if(!player.onGround) row = 2;
    else if(Math.abs(player.vx) > 20) row = 1;
    else row = 0;

    // draw sprite if available
    if(AS.player){
      // assume sheet: rows: 0 idle,1 run,2 jump,3 attack; each 3-6 frames; frame size 48x48
      const fw = 48, fh = 48, scale = 1;
      const cols = Math.floor(AS.player.width / fw);
      // compute frame index using time
      const fps = row === 1 ? 12 : 8;
      const animTime = (now/1000) * fps;
      const frameIndex = Math.floor(animTime) % cols;
      const dy = Math.floor(player.y - (fh - player.h)); // align bottom
      const dx = Math.floor(player.x);
      ctx.drawImage(AS.player, frameIndex*fw, row*fh, fw, fh, dx-6, dy, fw*scale, fh*scale);
    } else {
      // fallback stickman
      ctx.fillStyle = "#e8eefc";
      ctx.fillRect(Math.floor(player.x+3), Math.floor(player.y), 4, 4);
      ctx.fillRect(Math.floor(player.x+4), Math.floor(player.y+4), 2, 7);
      ctx.fillRect(Math.floor(player.x+1), Math.floor(player.y+6), 3, 1);
      ctx.fillRect(Math.floor(player.x+6), Math.floor(player.y+6), 3, 1);
      ctx.fillRect(Math.floor(player.x+3), Math.floor(player.y+11), 1, 6);
      ctx.fillRect(Math.floor(player.x+6), Math.floor(player.y+11), 1, 6);
    }
  }

  function drawGhostSprite(){
    if(AS.ghost){
      const fw = 64, fh = 64, scale=1;
      const cols = Math.floor(AS.ghost.width/fw);
      const fps = ghost.state === "lunge" ? 10 : 6;
      const animTime = (now/1000) * fps;
      const frameIndex = Math.floor(animTime) % cols;
      ctx.globalAlpha = 0.95;
      ctx.drawImage(AS.ghost, frameIndex*fw, 0, fw, fh, Math.floor(ghost.x), Math.floor(ghost.y), fw*scale, fh*scale);
      ctx.globalAlpha = 1;
    } else {
      // fallback rectangle ghost
      ctx.fillStyle = "rgba(210,220,255,0.85)";
      ctx.fillRect(Math.floor(ghost.x), Math.floor(ghost.y), ghost.w, ghost.h);
    }
  }

  function drawSwordPickup(){
    if(sword && sword.active){
      if(AS.sword) ctx.drawImage(AS.sword, Math.floor(sword.x - camX), Math.floor(sword.y));
      else {
        ctx.fillStyle = "#e8eefc";
        ctx.fillRect(Math.floor(sword.x - camX)+3, Math.floor(sword.y), 2, 8);
      }
    }
  }

  function drawAttackEffect(){
    if(player.attackUntil <= now) return;
    const dir = player.attackDir;
    ctx.fillStyle = "rgba(230,240,255,0.98)";
    const x = player.x, y = player.y;
    if(dir === "right"){
      ctx.fillRect(x + player.w, y + 7, 14, 2);
      ctx.fillRect(x + player.w + 4, y + 5, 10, 2);
    } else if(dir === "left"){
      ctx.fillRect(x - 14, y + 7, 14, 2);
      ctx.fillRect(x - 10, y + 5, 10, 2);
    } else if(dir === "up"){
      ctx.fillRect(x + 4, y - 14, 2, 14);
      ctx.fillRect(x + 2, y - 10, 2, 10);
    } else {
      ctx.fillRect(x + 4, y + player.h, 2, 14);
      ctx.fillRect(x + 2, y + player.h + 4, 2, 10);
    }
  }

  function drawHUD(tSec){
    const swordIn = Math.max(0, nextSwordSpawnAt - tSec);
    const swordLine = sword && sword.active ? "Sword: ON MAP" : `Next sword: ${swordIn.toFixed(1)}s`;
    let status = `Time: ${tSec.toFixed(2)}s\nBest: ${best.toFixed(2)}s\nRepels: ${ghostsRepelled}\n${swordLine}\n`;
    if(player.hasSword){
      const left = Math.max(0, (player.swordUntil - now)/1000);
      status += `Sword: ${left.toFixed(1)}s  Aim: ${player.attackDir.toUpperCase()}`;
    } else status += "No sword";
    if(gameOver) status += `\n\nGAME OVER\n${gameOverReason}\nPress R`;
    hudEl.textContent = status;
  }

  // --------------- Physics & step -------------
  function step(dt){
    if(gameOver) return;
    const tSec = (now - startedAt)/1000;
    maybeSpawnSword(tSec);

    // input & buffers
    const jumpPressed = wasPressed(" ") || wasPressed("arrowup");
    const attackPressed = wasPressed("x");
    const restartPressed = wasPressed("r");
    if(restartPressed) restart();

    // coyote & buffer timers in seconds
    player.coyote -= dt;
    player.jumpBuffer -= dt;
    if(jumpPressed) player.jumpBuffer = JUMP_BUFFER;

    // horizontal
    const right = keys.has("arrowright") || keys.has("d");
    const left = keys.has("arrowleft") || keys.has("a");
    const ax = 900;
    if(right) player.vx += ax * dt;
    if(left) player.vx -= ax * dt;
    player.vx *= player.onGround ? MOVE_GROUND : MOVE_AIR;
    player.vx = clamp(player.vx, -160, 180);

    // gravity & integrate
    player.vy += GRAVITY * dt;
    player.x += player.vx * dt;
    player.y += player.vy * dt;

    // horizontal clamp on screen
    player.x = clamp(player.x, 36, 160);

    // platform collision (vertical)
    player.onGround = false;
    const worldP = worldPlayerBox();
    for(const p of platforms){
      const plat = { x: p.x, y: p.y, w: p.w, h: p.h };
      if(worldP.x + worldP.w > plat.x && worldP.x < plat.x + plat.w){
        const prevY = player.y - player.vy*dt;
        const wasAbove = (prevY + player.h) <= plat.y + 1;
        const isFalling = player.vy >= 0;
        const hitsTop = (player.y + player.h) >= plat.y && (player.y + player.h) <= (plat.y + 12);
        if(wasAbove && isFalling && hitsTop){
          player.y = plat.y - player.h;
          player.vy = 0;
          player.onGround = true;
          player.coyote = COYOTE_TIME;
        }
      }
    }

    // falling off bottom
    if(player.y > H + 40) triggerGameOver("You fell!");

    // jumps (coyote + buffer)
    if(player.jumpBuffer > 0 && player.coyote > 0){
      player.vy = -JUMP_V;
      player.onGround = false;
      player.coyote = 0;
      player.jumpBuffer = 0;
      if(AS.sfx_jump) { try{ AS.sfx_jump.currentTime = 0; AS.sfx_jump.play(); }catch(e){} }
    }

    // attacks (directional)
    if(attackPressed && player.hasSword && player.attackUntil <= now){
      player.attackUntil = now + 140;
      // compute screen-space midpoints
      const px = player.x + player.w/2;
      const py = player.y + player.h/2;
      const gx = ghost.x + ghost.w/2;
      const gy = ghost.y + ghost.h/2;
      const dx = gx - px, dy = gy - py;
      if(Math.abs(dx) > Math.abs(dy)) player.attackDir = dx > 0 ? "right" : "left";
      else player.attackDir = dy > 0 ? "down" : "up";
    }

    // sword pickup
    if(sword && sword.active){
      const swordBox = { x: sword.x - camX, y: sword.y, w: sword.w, h: sword.h };
      const playerBox = { x: player.x, y: player.y, w: player.w, h: player.h };
      if(aabb(playerBox, swordBox)){
        sword.active = false; player.hasSword = true;
        player.swordUntil = now + 6000;
        if(AS.sfx_pick) try{ AS.sfx_pick.currentTime = 0; AS.sfx_pick.play(); }catch(e){}
      }
    }
    if(player.hasSword && now > player.swordUntil){ player.hasSword = false; player.attackUntil = 0; }

    // ghost movement
    updateGhost(dt, tSec);

    // attack hit detection
    const ghostBox = { x: ghost.x, y: ghost.y, w: ghost.w, h: ghost.h };
    if(player.attackUntil > now){
      let hit;
      switch(player.attackDir){
        case "right": hit = { x: player.x + player.w, y: player.y + 4, w: 18, h: 10 }; break;
        case "left":  hit = { x: player.x - 18, y: player.y + 4, w: 18, h: 10 }; break;
        case "up":    hit = { x: player.x + 3, y: player.y - 18, w: 8, h: 18 }; break;
        case "down":  hit = { x: player.x + 3, y: player.y + player.h, w: 8, h: 18 }; break;
      }
      if(hit && aabb(hit, ghostBox)){
        ghostsRepelled++;
        // stronger knockback in opposite direction of hit vector
        const kb = 130;
        if(player.attackDir === "right") ghost.x += kb;
        else if(player.attackDir === "left") ghost.x -= kb;
        else if(player.attackDir === "up") ghost.y -= 18;
        else ghost.y += 18;
        ghost.pushedBackUntil = now + 700;
        spawnParticles(ghost.x + ghost.w*0.5, ghost.y + ghost.h*0.5, 14, "#dfe8ff");
        if(AS.sfx_hit) try{ AS.sfx_hit.currentTime = 0; AS.sfx_hit.play(); }catch(e){}
      }
    }

    // ghost catches player?
    const playerBox = { x: player.x, y: player.y, w: player.w, h: player.h };
    if(aabb(playerBox, ghostBox)) triggerGameOver("The ghost caught you!");

    // camera progression
    camX += baseScroll * dt;
    ensurePlatformsAhead();
  }

  // --------------- platform generation -------------
  function ensurePlatformsAhead(){
    let far = 0;
    for(const p of platforms) far = Math.max(far, p.x + p.w);
    while(far < camX + W + 260){
      const nextX = far + irand(60,140);
      addPlatform(nextX, irand(72,128), irand(28,80));
      far = nextX + platforms[platforms.length-1].w;
    }
    for(let i=platforms.length-1;i>=0;i--){
      const p = platforms[i];
      if(p.x + p.w < camX - 300 && p.x > -1000) platforms.splice(i,1);
    }
  }

  // --------------- Game over -------------
  let gameOverReason = "";
  function triggerGameOver(reason){
    gameOver = true;
    const t = (now - startedAt)/1000;
    best = Math.max(best, t);
    gameOverReason = reason;
    // small screen flash (we'll just spawn heavy particles)
    for(let i=0;i<40;i++) spawnParticles(player.x+10, player.y+6, 1, "#ffdddd");
  }

  // --------------- Draw all -------------
  function draw(dt){
    // background
    ctx.fillStyle = "#070a14";
    ctx.fillRect(0,0,W,H);
    drawParallax();

    // mid ground (mist)
    ctx.fillStyle = "rgba(120,140,255,0.03)";
    ctx.fillRect(0,92,W,46);

    // platforms
    for(const p of platforms){
      const sx = Math.floor(p.x - camX);
      if(sx + p.w < -100 || sx > W + 100) continue;
      drawTilePlatform(p);
    }

    // sword
    drawSwordPickup();

    // ghost
    drawGhostSprite();

    // player
    drawPlayer(dt);

    // attack effect
    drawAttackEffect();

    // particles
    drawParticles();

    // HUD
    const tSec = (now - startedAt)/1000;
    drawHUD(tSec);
  }

  // --------------- Restart -------------
  function restart(){
    gameOver = false;
    gameOverReason = "";
    player.x = 70; player.y = 40; player.vx = 0; player.vy = 0; player.onGround = false; player.coyote = 0; player.jumpBuffer = 0;
    player.hasSword = false; player.swordUntil = 0; player.attackUntil = 0; player.attackDir = "right";
    ghost.x = -60; ghost.y = 60; ghost.pushedBackUntil = 0; ghost.state = "calm"; ghost.stateTime = 0;
    startedAt = performance.now(); now = startedAt; last = startedAt;
    seedWorld();
  }

  // --------------- Main loop -------------
  function frame(t){
    now = t;
    const dt = Math.min(0.033, (t - last)/1000);
    last = t;
    step(dt);
    updateParticles(dt);
    draw(dt);
    pressed.clear();
    requestAnimationFrame(frame);
  }

  // --------------- Start loading & boot -------------
  // wire audio references to AS names for convenience
  function wireAudio(){
    if(AS.sfx_jump) AS.sfx_jump = AS.sfx_jump;
    if(AS.sfx_hit) AS.sfx_hit = AS.sfx_hit;
    if(AS.sfx_pick) AS.sfx_pick = AS.sfx_pick;
  }

  loadAssets(() => {
    // assign sprite anim trackers if images exist (we use image directly in drawing)
    wireAudio();
    seedWorld();
    requestAnimationFrame(frame);
    // try playing a looping music if available
    if(AS.music){ try{ AS.music.loop = true; AS.music.volume = 0.18; AS.music.play(); }catch(e){} }
  });

})();
