(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const W = canvas.width, H = canvas.height;
  const hudEl = document.getElementById("hud");

  const keys = new Set();
  const pressed = new Set();
  window.addEventListener("keydown", (e) => {
    keys.add(e.key.toLowerCase());
    pressed.add(e.key.toLowerCase());
    if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(e.key.toLowerCase()) || e.code === "Space") e.preventDefault();
  }, { passive: false });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  const wasPressed = (k) => pressed.has(k);

  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const irand = (a,b) => Math.floor(a + Math.random()*(b-a+1));
  const aabb = (a,b) => (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);

  let now = performance.now(), last = now;
  let startedAt = now, gameOver = false, best = 0;
  let camX = 0;
  let baseScroll = 90;
  let ghostsRepelled = 0;

  // ---- Assets (IMAGES ONLY) ----
  const assetList = {
    player: "assets/player.png",
    ghost:  "assets/ghost.png",
    tiles:  "assets/tiles.png",
    sword:  "assets/sword.png",
    bg_far: "assets/bg_far.png",
    bg_mid: "assets/bg_mid.png",
    bg_near:"assets/bg_near.png",
  };
  const AS = {};
  function loadAssets(cb){
    const keys = Object.keys(assetList);
    let loaded = 0;
    const total = keys.length;

    function done(){
      loaded++;
      if(loaded === total) cb();
    }

    for(const k of keys){
      const img = new Image();
      img.src = assetList[k];
      img.onload = done;
      img.onerror = () => {
        console.warn("Failed to load image:", assetList[k]);
        done();
      };
      AS[k] = img;
    }
  }

  // ---- Particles ----
  const particles = [];
  function spawnParticles(x,y,count=8){
    for(let i=0;i<count;i++){
      particles.push({
        x, y,
        vx:(Math.random()*2-1)*80,
        vy:(Math.random()*-1.5-0.2)*100,
        life:0.5+Math.random()*0.4,
        age:0,
        size:1+Math.random()*2
      });
    }
  }
  function updateParticles(dt){
    for(let i=particles.length-1;i>=0;i--){
      const p = particles[i];
      p.age += dt;
      if(p.age >= p.life){ particles.splice(i,1); continue; }
      p.vy += 300*dt;
      p.x += p.vx*dt;
      p.y += p.vy*dt;
    }
  }
  function drawParticles(){
    for(const p of particles){
      const a = 1 - p.age/p.life;
      ctx.fillStyle = `rgba(230,240,255,${a})`;
      ctx.fillRect(Math.floor(p.x), Math.floor(p.y), Math.ceil(p.size), Math.ceil(p.size));
    }
  }

  // ---- World ----
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

  // ---- Player / Ghost ----
  const player = {
    x:70,y:40,w:12,h:20,vx:0,vy:0,onGround:false,
    hasSword:false,swordUntil:0,attackUntil:0,attackDir:"right",
    coyote:0,jumpBuffer:0
  };
  const ghost = { x:-60,y:60,w:48,h:64,speed:0,pushedBackUntil:0,state:"calm",stateTime:0 };

  // ---- Sword spawn ----
  let sword = null, nextSwordSpawnAt = 0;
  function maybeSpawnSword(tSec){
    if(tSec < nextSwordSpawnAt) return;
    const candidates = platforms.filter(p => p.x > camX + 80 && p.x < camX + W + 260 && p.y < groundY);
    const p = candidates.length ? candidates[irand(0,candidates.length-1)] : null;
    const sx = p ? (p.x + p.w*0.5 - 4) : (camX + W + 120);
    const sy = p ? (p.y - 12) : (groundY - 38);
    sword = {x:sx,y:sy,w:10,h:12,active:true};
    nextSwordSpawnAt = tSec + 20;
  }

  // ---- Feel tuning ----
  const GRAVITY = 1100;
  const JUMP_V = 380;
  const MOVE_AIR = 0.95, MOVE_GROUND = 0.82;
  const COYOTE_TIME = 0.12;
  const JUMP_BUFFER = 0.12;

  function updateGhost(dt, tSec){
    ghost.stateTime += dt;
    baseScroll = 90 + tSec * 2.2 + ghostsRepelled * 0.8;
    ghost.speed = baseScroll * (1.05 + Math.min(0.35, tSec/80));

    if(tSec > 45 && ghost.state !== "lunge" && Math.random() < 0.002){
      ghost.state = "lunge"; ghost.stateTime = 0;
    }
    if(ghost.state === "lunge"){
      if(ghost.stateTime < 0.6) ghost.x += (ghost.speed*1.6 - baseScroll) * dt + 26*dt;
      else ghost.state = "calm";
    } else {
      if(now < ghost.pushedBackUntil) ghost.x -= 120 * dt;
      else ghost.x += (ghost.speed - baseScroll) * dt + 14*dt;
    }
    ghost.y = 62 + Math.sin(tSec * 3.1) * 4;
  }

  let gameOverReason = "";
  function triggerGameOver(reason){
    gameOver = true;
    const t = (now - startedAt)/1000;
    best = Math.max(best, t);
    gameOverReason = reason;
  }

  function restart(){
    gameOver = false;
    gameOverReason = "";
    player.x=70; player.y=40; player.vx=0; player.vy=0; player.onGround=false;
    player.coyote=0; player.jumpBuffer=0;
    player.hasSword=false; player.swordUntil=0; player.attackUntil=0; player.attackDir="right";
    ghost.x=-60; ghost.y=60; ghost.pushedBackUntil=0; ghost.state="calm"; ghost.stateTime=0;
    startedAt = performance.now(); now = startedAt; last = startedAt;
    seedWorld();
  }

  function drawParallax(){
    ctx.fillStyle="#070a14";
    ctx.fillRect(0,0,W,H);
    const drawTiled = (img, speed) => {
      if(!img || !img.width) return;
      const px = Math.floor(camX * speed) % img.width;
      ctx.drawImage(img, -px, 0);
      ctx.drawImage(img, -px + img.width, 0);
    };
    drawTiled(AS.bg_far, 0.18);
    drawTiled(AS.bg_mid, 0.35);
    drawTiled(AS.bg_near, 0.7);
  }

  function drawPlatform(p){
    const sx = Math.floor(p.x - camX);
    if(AS.tiles && AS.tiles.width){
      const tw=8, th=8;
      const cols = Math.ceil(p.w / tw);
      for(let i=0;i<cols;i++){
        const dx = sx + i*tw;
        ctx.drawImage(AS.tiles, 0, 0, tw, th, dx, p.y, tw, th);
      }
    } else {
      ctx.fillStyle="#2a2f4a";
      ctx.fillRect(sx, p.y, p.w, p.h);
    }
  }

  function drawSwordPickup(){
    if(!sword || !sword.active) return;
    const x = Math.floor(sword.x - camX), y = Math.floor(sword.y);
    if(AS.sword && AS.sword.width) ctx.drawImage(AS.sword, x, y);
    else { ctx.fillStyle="#e8eefc"; ctx.fillRect(x+3,y,2,8); }
  }

  function drawPlayer(){
    if(AS.player && AS.player.width){
      const fw=48, fh=48;
      const cols = Math.floor(AS.player.width/fw) || 1;
      let row=0;
      if(player.attackUntil > now) row=3;
      else if(!player.onGround) row=2;
      else if(Math.abs(player.vx)>20) row=1;
      const fps = row===1 ? 12 : 8;
      const frameIndex = Math.floor((now/1000)*fps) % cols;
      const dx = Math.floor(player.x-6);
      const dy = Math.floor(player.y-(fh-player.h));
      ctx.drawImage(AS.player, frameIndex*fw, row*fh, fw, fh, dx, dy, fw, fh);
    } else {
      ctx.fillStyle="#e8eefc";
      ctx.fillRect(player.x+3, player.y, 4, 4);
      ctx.fillRect(player.x+4, player.y+4, 2, 7);
    }
  }

  function drawGhost(){
    if(AS.ghost && AS.ghost.width){
      const fw=64, fh=64;
      const cols = Math.floor(AS.ghost.width/fw) || 1;
      const fps = ghost.state==="lunge" ? 10 : 6;
      const frameIndex = Math.floor((now/1000)*fps) % cols;
      ctx.globalAlpha=0.95;
      ctx.drawImage(AS.ghost, frameIndex*fw, 0, fw, fh, Math.floor(ghost.x), Math.floor(ghost.y), fw, fh);
      ctx.globalAlpha=1;
    } else {
      ctx.fillStyle="rgba(210,220,255,0.85)";
      ctx.fillRect(ghost.x, ghost.y, ghost.w, ghost.h);
    }
  }

  function drawAttackEffect(){
    if(player.attackUntil <= now) return;
    const x=player.x, y=player.y;
    ctx.fillStyle="rgba(230,240,255,0.98)";
    if(player.attackDir==="right") ctx.fillRect(x+player.w, y+7, 16, 2);
    else if(player.attackDir==="left") ctx.fillRect(x-16, y+7, 16, 2);
    else if(player.attackDir==="up") ctx.fillRect(x+4, y-16, 2, 16);
    else ctx.fillRect(x+4, y+player.h, 2, 16);
  }

  function drawHUD(tSec){
    const swordIn = Math.max(0, nextSwordSpawnAt - tSec);
    const swordLine = sword && sword.active ? "Sword: ON MAP" : `Next sword: ${swordIn.toFixed(1)}s`;
    let status = `Time: ${tSec.toFixed(2)}s\nBest: ${best.toFixed(2)}s\nRepels: ${ghostsRepelled}\n${swordLine}\n`;
    if(player.hasSword){
      const left = Math.max(0,(player.swordUntil-now)/1000);
      status += `Sword: ${left.toFixed(1)}s  Aim: ${player.attackDir.toUpperCase()}`;
    } else status += "No sword";
    if(gameOver) status += `\n\nGAME OVER\n${gameOverReason}\nPress R`;
    hudEl.textContent = status;
  }

  function step(dt){
    if(gameOver) return;
    const tSec = (now-startedAt)/1000;
    maybeSpawnSword(tSec);

    const restartPressed = wasPressed("r");
    if(restartPressed) restart();

    const jumpPressed = wasPressed(" ") || wasPressed("arrowup");
    const attackPressed = wasPressed("x");

    player.coyote -= dt;
    player.jumpBuffer -= dt;
    if(jumpPressed) player.jumpBuffer = JUMP_BUFFER;

    const right = keys.has("arrowright") || keys.has("d");
    const left  = keys.has("arrowleft") || keys.has("a");
    const ax=900;
    if(right) player.vx += ax*dt;
    if(left) player.vx -= ax*dt;
    player.vx *= player.onGround ? MOVE_GROUND : MOVE_AIR;
    player.vx = clamp(player.vx, -160, 180);

    player.vy += GRAVITY*dt;
    player.x += player.vx*dt;
    player.y += player.vy*dt;
    player.x = clamp(player.x, 36, 160);

    player.onGround=false;
    const worldP = {x:player.x+camX,y:player.y,w:player.w,h:player.h};
    for(const p of platforms){
      if(worldP.x+worldP.w>p.x && worldP.x<p.x+p.w){
        const prevY = player.y - player.vy*dt;
        const wasAbove = (prevY+player.h) <= p.y+1;
        const isFalling = player.vy >= 0;
        const hitsTop = (player.y+player.h) >= p.y && (player.y+player.h) <= (p.y+12);
        if(wasAbove && isFalling && hitsTop){
          player.y = p.y - player.h;
          player.vy = 0;
          player.onGround = true;
          player.coyote = COYOTE_TIME;
        }
      }
    }

    if(player.y > H+40) triggerGameOver("You fell!");

    if(player.jumpBuffer > 0 && player.coyote > 0){
      player.vy = -JUMP_V;
      player.onGround=false;
      player.coyote=0;
      player.jumpBuffer=0;
    }

    if(attackPressed && player.hasSword && player.attackUntil <= now){
      player.attackUntil = now + 140;
      const px=player.x+player.w/2, py=player.y+player.h/2;
      const gx=ghost.x+ghost.w/2,  gy=ghost.y+ghost.h/2;
      const dx=gx-px, dy=gy-py;
      if(Math.abs(dx) > Math.abs(dy)) player.attackDir = dx>0 ? "right" : "left";
      else player.attackDir = dy>0 ? "down" : "up";
    }

    if(sword && sword.active){
      const swordBox = {x:sword.x-camX,y:sword.y,w:sword.w,h:sword.h};
      const playerBox = {x:player.x,y:player.y,w:player.w,h:player.h};
      if(aabb(playerBox, swordBox)){
        sword.active=false;
        player.hasSword=true;
        player.swordUntil = now + 6000;
      }
    }
    if(player.hasSword && now>player.swordUntil){ player.hasSword=false; player.attackUntil=0; }

    updateGhost(dt, tSec);

    const ghostBox = {x:ghost.x,y:ghost.y,w:ghost.w,h:ghost.h};
    if(player.attackUntil > now){
      let hit;
      switch(player.attackDir){
        case "right": hit={x:player.x+player.w,y:player.y+4,w:18,h:10}; break;
        case "left":  hit={x:player.x-18,y:player.y+4,w:18,h:10}; break;
        case "up":    hit={x:player.x+3,y:player.y-18,w:8,h:18}; break;
        case "down":  hit={x:player.x+3,y:player.y+player.h,w:8,h:18}; break;
      }
      if(hit && aabb(hit, ghostBox)){
        ghostsRepelled++;
        ghost.x -= 120;
        ghost.pushedBackUntil = now + 700;
        spawnParticles(ghost.x + ghost.w*0.5, ghost.y + ghost.h*0.5, 14);
      }
    }

    const playerBox = {x:player.x,y:player.y,w:player.w,h:player.h};
    if(aabb(playerBox, ghostBox)) triggerGameOver("The ghost caught you!");

    camX += baseScroll*dt;
    ensurePlatformsAhead();
  }

  function draw(){
    const tSec = (now-startedAt)/1000;
    drawParallax();

    for(const p of platforms){
      const sx = Math.floor(p.x - camX);
      if(sx+p.w < -100 || sx > W+100) continue;
      drawPlatform(p);
    }

    drawSwordPickup();
    drawGhost();
    drawPlayer();
    drawAttackEffect();
    drawParticles();
    drawHUD(tSec);

    if(gameOver){
      ctx.fillStyle="rgba(0,0,0,0.45)";
      ctx.fillRect(0,0,W,H);
    }
  }

  function frame(t){
    now=t;
    const dt = Math.min(0.033,(t-last)/1000);
    last=t;
    step(dt);
    updateParticles(dt);
    draw();
    pressed.clear();
    requestAnimationFrame(frame);
  }

  loadAssets(() => {
    seedWorld();
    requestAnimationFrame(frame);
  });
})();
