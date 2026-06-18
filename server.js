'use strict';

const express = require('express');
const http    = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const rooms   = new Map();
const clients = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}
function uniqueCode() { let c; do { c = genCode(); } while (rooms.has(c)); return c; }

function sendWs(ws, msg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

function sendTo(roomCode, playerId, msg) {
  const p = JSON.stringify(msg);
  for (const [ws, m] of clients)
    if (m.roomCode === roomCode && m.playerId === playerId && ws.readyState === WebSocket.OPEN)
      ws.send(p);
}

function checkSpecialPlayer(room, name) {
  if (name.toLowerCase().trim() === 'dehua') {
    console.log(`[SPECIAL] dehua detected in room ${room.code}, broadcasting video to ${clients.size} clients`);
    setTimeout(() => {
      const payload = JSON.stringify({ type: 'specialEvent', event: 'dehua' });
      let sent = 0;
      for (const [ws2, m2] of clients) {
        if (m2.roomCode === room.code && ws2.readyState === WebSocket.OPEN) {
          ws2.send(payload);
          sent++;
        }
      }
      console.log(`[SPECIAL] sent to ${sent} clients`);
    }, 500);
  }
}

function defaultSettings() {
  return {
    gameName: '',
    hitlerKnowsFascists: false,
    rebalance: false,
    timedMode: false,
    timerSeconds: 90,
  };
}

// ─── ROLE ASSIGNMENT ───────────────────────────────────────
const ROLE_COUNTS = {
  5:  { liberal: 3, fascist: 1, hitler: 1 },
  6:  { liberal: 4, fascist: 1, hitler: 1 },
  7:  { liberal: 4, fascist: 2, hitler: 1 },
  8:  { liberal: 5, fascist: 2, hitler: 1 },
  9:  { liberal: 5, fascist: 3, hitler: 1 },
  10: { liberal: 6, fascist: 3, hitler: 1 },
};

function assignRoles(players) {
  const n = players.length;
  const counts = ROLE_COUNTS[n] || ROLE_COUNTS[10];
  const roles = [];
  for (let i = 0; i < counts.liberal; i++) roles.push('liberal');
  for (let i = 0; i < counts.fascist; i++) roles.push('fascist');
  roles.push('hitler');
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  players.forEach((p, i) => { p.role = roles[i]; });
}

// ─── DECK ──────────────────────────────────────────────────
function buildDeck(room) {
  const totalL = room.settings.rebalance ? 7 : 6;
  const remF = Math.max(0, 11 - room.fasPolicies);
  const remL = Math.max(0, totalL - room.libPolicies);
  const deck = [];
  for (let i = 0; i < remF; i++) deck.push('F');
  for (let i = 0; i < remL; i++) deck.push('L');
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ─── VIEWS ─────────────────────────────────────────────────
function playerView(p, viewerRole, gameEnded) {
  let role = 'unknown';
  if (gameEnded) role = p.role;
  return { id: p.id, name: p.name, nameColor: p.nameColor || null, dead: p.dead, connected: p.connected, role, isBot: !!p.isBot };
}

function roomView(room) {
  return {
    code:             room.code,
    hostId:           room.hostId,
    phase:            room.phase,
    roundPhase:       room.roundPhase,
    numPlayers:       room.numPlayers,
    settings:         room.settings,
    timerDeadline:    room.timerDeadline || null,
    players:          room.players.map(p => playerView(p, null, room.phase === 'ended')),
    log:              room.log,
    libPolicies:      room.libPolicies,
    fasPolicies:      room.fasPolicies,
    electionFails:    room.electionFails,
    presIdx:          room.presIdx,
    chanIdx:          room.chanIdx,
    nomineeIdx:       room.nomineeIdx,
    round:            room.round,
    winner:           room.winner,
    winReason:        room.winReason,
    votes:            room.votes,
    voteRevealed:     room.voteRevealed,
    lastElegiblePres: room.lastElegiblePres,
    lastElegibleChan: room.lastElegibleChan,
    activePower:      room.activePower,
    powerTarget:      room.powerTarget,
  };
}

function personalView(room, playerId) {
  const base = roomView(room);
  const playerIdx = room.players.findIndex(p => p.id === playerId);
  if (playerIdx < 0 || room.phase !== 'active') return base;

  const myRole = room.players[playerIdx].role;

  base.players = room.players.map((p, i) => {
    let role = 'unknown';
    if (room.phase === 'ended') {
      role = p.role;
    } else if (i === playerIdx) {
      role = p.role;
    } else if (myRole === 'fascist' &&
               (p.role === 'fascist' || p.role === 'hitler')) {
      role = p.role;
    } else if (myRole === 'hitler' && room.settings.hitlerKnowsFascists &&
               p.role === 'fascist') {
      role = p.role;
    }
    return { id: p.id, name: p.name, nameColor: p.nameColor || null, dead: p.dead, connected: p.connected, role, isBot: !!p.isBot };
  });

  return base;
}

// ─── BROADCAST ─────────────────────────────────────────────
function broadcastState(room) {
  const presId = room.players[room.presIdx]?.id;
  const chanId = room.chanIdx != null ? room.players[room.chanIdx]?.id : null;

  for (const [ws, m] of clients) {
    if (m.roomCode !== room.code || ws.readyState !== WebSocket.OPEN) continue;

    const playerId = m.playerId;
    const view = personalView(room, playerId);

    if (playerId === presId && room.roundPhase === 'presCards' && room.drawnCards) {
      view.drawnCards = room.drawnCards;
    }
    if (playerId === chanId && room.roundPhase === 'chanCards' && room.passedCards) {
      view.passedCardsPrivate = room.passedCards;
    }

    ws.send(JSON.stringify({ type: 'state', room: view }));
  }
}

// ─── GAME HELPERS ──────────────────────────────────────────
function addLog(room, entry) {
  entry.id    = uuidv4();
  entry.round = entry.round ?? room.round;
  entry.ts    = Date.now();
  room.log.unshift(entry);
  room.lastActive = Date.now();
}

function checkWin(room) {
  if (room.phase === 'ended') return false;
  const totalL = room.settings.rebalance ? 7 : 6;
  if (room.libPolicies >= 5) {
    room.phase = 'ended'; room.winner = 'liberal'; room.winReason = '5 Liberal policies enacted.';
    clearTimer(room); return true;
  }
  if (room.fasPolicies >= 6) {
    room.phase = 'ended'; room.winner = 'fascist'; room.winReason = '6 Fascist policies enacted.';
    clearTimer(room); return true;
  }
  return false;
}

function triggerChaos(room) {
  const deck = buildDeck(room);
  const pol  = deck[0] || 'F';
  if (pol === 'L') room.libPolicies = Math.min(5, room.libPolicies + 1);
  else             room.fasPolicies = Math.min(6, room.fasPolicies + 1);
  room.electionFails = 0;
  addLog(room, {
    type: 'chaos',
    text: `⚠️ 3 failed elections — top card enacted automatically: ${pol === 'L' ? '🕊 Liberal' : '⚡ Fascist'}. Tracker reset.`,
    meta: `ROUND ${room.round} · AUTO`,
  });
  checkWin(room);
}

function getPower(fasPolicies, numPlayers) {
  if (numPlayers <= 6) return { 3:'peek', 4:'execute', 5:'execute' }[fasPolicies] || null;
  if (numPlayers <= 8) return { 2:'investigate', 3:'elect', 4:'execute', 5:'execute' }[fasPolicies] || null;
  return { 1:'investigate', 2:'investigate', 3:'elect', 4:'execute', 5:'execute' }[fasPolicies] || null;
}

function powerName(p) {
  return { peek:'Policy Peek', investigate:'Investigate Loyalty', elect:'Special Election', execute:'Execution' }[p] || p;
}

function advancePresident(room) {
  const n = room.players.length;
  if (room.chanIdx !== null) room.lastElegibleChan = room.chanIdx;
  room.lastElegiblePres = room.presIdx;
  let tries = 0;
  do { room.presIdx = (room.presIdx + 1) % n; tries++; }
  while (room.players[room.presIdx]?.dead && tries < n);
  room.chanIdx    = null;
  room.nomineeIdx = null;
}

function startNomination(room) {
  room.roundPhase   = 'nominate';
  room.votes        = {};
  room.voteRevealed = false;
  room.drawnCards   = null;
  room.passedCards  = null;
  room.activePower  = null;
  room.powerTarget  = null;
  startTimer(room);
}

function autoNextRound(room) {
  advancePresident(room);
  room.round++;
  startNomination(room);
  addLog(room, { type: 'note', text: `Round ${room.round} begins. ${room.players[room.presIdx].name} is President.`, meta: '' });
}

// ─── TIMED MODE ────────────────────────────────────────────
function clearTimer(room) {
  if (room._timerHandle) { clearTimeout(room._timerHandle); room._timerHandle = null; }
  room.timerDeadline = null;
}

function startTimer(room) {
  clearTimer(room);
  if (!room.settings.timedMode || room.phase !== 'active') return;
  const ms = (room.settings.timerSeconds || 90) * 1000;
  room.timerDeadline = Date.now() + ms;
  room._timerHandle = setTimeout(() => timerExpired(room), ms);
}

function timerExpired(room) {
  room._timerHandle = null;
  room.timerDeadline = null;
  if (room.phase !== 'active') return;

  const rp = room.roundPhase;

  if (rp === 'nominate') {
    const pres = room.presIdx;
    const blocked = new Set();
    if (room.players.length > 5) blocked.add(room.lastElegiblePres);
    blocked.add(room.lastElegibleChan);
    const eligible = room.players.map((p, i) => i)
      .filter(i => !room.players[i].dead && i !== pres && !blocked.has(i));
    if (!eligible.length) return;
    const pick = eligible[Math.floor(Math.random() * eligible.length)];
    room.nomineeIdx = pick;
    room.roundPhase = 'vote';
    room.votes = {};
    room.voteRevealed = false;
    addLog(room, { type: 'elect', text: `⏱ ${room.players[pres].name} timed out — auto-nominated ${room.players[pick].name}.`, meta: `ROUND ${room.round}` });
    startTimer(room);
    broadcastState(room);
  }

  else if (rp === 'vote') {
    const alive = room.players.filter(p => !p.dead);
    alive.forEach(p => { if (room.votes[p.id] === undefined) room.votes[p.id] = Math.random() > 0.5 ? 'ja' : 'nein'; });
    room.voteRevealed = true;
    const jas = alive.filter(p => room.votes[p.id] === 'ja').length;
    const neins = alive.length - jas;
    const passed = jas > neins;
    const voteStr = alive.map(p => `${p.name}: ${room.votes[p.id].toUpperCase()}`).join(', ');
    addLog(room, { type: 'elect', text: `⏱ Vote timed out. ${passed ? '✓ JA passed' : '✗ NEIN failed'} (${jas}–${neins}). ${voteStr}.`, meta: `ROUND ${room.round}`, voteResult: passed ? 'ja' : 'nein' });

    if (passed) {
      room.chanIdx = room.nomineeIdx;
      room.electionFails = 0;
      const chan = room.players[room.chanIdx];
      if (room.fasPolicies >= 3 && chan.role === 'hitler') {
        room.phase = 'ended'; room.winner = 'fascist';
        room.winReason = `Hitler elected Chancellor with ${room.fasPolicies} Fascist policies in play!`;
        addLog(room, { type: 'chaos', text: `⚡ FASCISTS WIN — ${room.winReason}`, meta: `ROUND ${room.round}` });
        broadcastState(room); return;
      }
      room.drawnCards = buildDeck(room).slice(0, 3);
      room.roundPhase = 'presCards';
      addLog(room, { type: 'note', text: `Government formed! ${room.players[room.presIdx].name} is picking cards.`, meta: `ROUND ${room.round}` });
    } else {
      room.electionFails = (room.electionFails || 0) + 1;
      addLog(room, { type: 'elect', text: `Election failed. Tracker: ${room.electionFails}/3.`, meta: `ROUND ${room.round} · AUTO` });
      if (room.electionFails >= 3) { broadcastState(room); triggerChaos(room); if (checkWin(room)) { broadcastState(room); return; } }
      autoNextRound(room);
    }
    startTimer(room);
    broadcastState(room);
  }

  else if (rp === 'presCards') {
    const idx = Math.floor(Math.random() * 3);
    const drawn = room.drawnCards;
    room.passedCards = drawn.filter((_, i) => i !== idx);
    room.drawnCards = null;
    room.roundPhase = 'chanCards';
    addLog(room, { type: 'pres', text: `⏱ ${room.players[room.presIdx].name} (Pres.) timed out — auto-discarded.`, meta: `ROUND ${room.round}` });
    startTimer(room);
    broadcastState(room);
  }

  else if (rp === 'chanCards') {
    const idx = Math.floor(Math.random() * 2);
    const enacted = room.passedCards[idx];
    room.passedCards = null;
    if (enacted === 'L') room.libPolicies = Math.min(5, room.libPolicies + 1);
    else room.fasPolicies = Math.min(6, room.fasPolicies + 1);
    room.electionFails = 0;
    addLog(room, { type: 'chan', text: `⏱ ${room.players[room.chanIdx].name} (Chan.) timed out — auto-enacted ${enacted === 'L' ? '🕊 Liberal' : '⚡ Fascist'}.`, meta: `ROUND ${room.round}`, enacted });
    if (checkWin(room)) { broadcastState(room); return; }
    const power = enacted === 'F' ? getPower(room.fasPolicies, room.players.length) : null;
    if (power) { room.activePower = power; room.roundPhase = 'power'; addLog(room, { type: 'note', text: `⚡ Executive power: ${powerName(power)}.`, meta: `ROUND ${room.round}` }); }
    else autoNextRound(room);
    startTimer(room);
    broadcastState(room);
  }

  else if (rp === 'veto') {
    addLog(room, { type: 'veto', text: `⏱ ${room.players[room.presIdx].name} timed out — veto rejected.`, meta: `ROUND ${room.round}` });
    room.roundPhase = 'chanCards';
    startTimer(room);
    broadcastState(room);
  }

  else if (rp === 'power') {
    const pres = room.presIdx;
    if (room.activePower === 'peek') {
      room.activePower = null;
      addLog(room, { type: 'note', text: `⏱ ${room.players[pres].name} timed out — peek skipped.`, meta: `ROUND ${room.round}` });
      autoNextRound(room);
    } else {
      const eligible = room.players.map((p, i) => i).filter(i => !room.players[i].dead && i !== pres);
      if (!eligible.length) return;
      const pick = eligible[Math.floor(Math.random() * eligible.length)];
      const target = room.players[pick];

      if (room.activePower === 'investigate') {
        addLog(room, { type: 'inv', text: `⏱ ${room.players[pres].name} timed out — auto-investigated ${target.name}.`, meta: `ROUND ${room.round}` });
        room.activePower = null;
        autoNextRound(room);
      } else if (room.activePower === 'elect') {
        room.lastElegiblePres = pres;
        room.presIdx = pick;
        room.chanIdx = null;
        room.nomineeIdx = null;
        room.activePower = null;
        addLog(room, { type: 'note', text: `⏱ Timed out — Special Election: ${target.name}.`, meta: `ROUND ${room.round}` });
        room.round++;
        startNomination(room);
        addLog(room, { type: 'note', text: `Round ${room.round} begins. ${room.players[room.presIdx].name} is President.`, meta: '' });
      } else if (room.activePower === 'execute') {
        target.dead = true;
        room.powerTarget = pick;
        addLog(room, { type: 'kill', text: `⏱ ${room.players[pres].name} timed out — auto-executed ${target.name}. 💀`, meta: `ROUND ${room.round}` });
        if (target.role === 'hitler') {
          room.phase = 'ended'; room.winner = 'liberal'; room.winReason = 'Hitler was executed!';
          addLog(room, { type: 'chaos', text: '🕊 LIBERALS WIN — Hitler has been executed!', meta: `ROUND ${room.round}` });
          broadcastState(room); return;
        }
        room.activePower = null;
        autoNextRound(room);
      }
    }
    startTimer(room);
    broadcastState(room);
  }
}

// ─── BOT NAMES ────────────────────────────────────────────
const BOT_NAMES = [
  'Bismarck','Adenauer','Merkel','Brandt','Scholz',
  'Kohl','Schmidt','Engels','Heuss','Weizsäcker',
  'Lübke','Steinmeier','Gauck','Herzog','Rau',
];

function pickBotName(room) {
  const taken = new Set(room.players.map(p => p.name));
  const avail = BOT_NAMES.filter(n => !taken.has(n + ' 🤖'));
  if (avail.length) return avail[Math.floor(Math.random() * avail.length)] + ' 🤖';
  return 'Bot-' + Math.floor(Math.random() * 900 + 100) + ' 🤖';
}

// ─── BOT AI ───────────────────────────────────────────────
function botDelay() { return 1500 + Math.random() * 2500; }

const CLAIM_WINDOW_MS = 10000;

function startClaimWindow(room) {
  clearClaimWindow(room);
  room._claimPending = true;
  room._claimTimer = setTimeout(() => {
    room._claimPending = false;
    room._claimTimer = null;
    triggerBotActions(room);
  }, CLAIM_WINDOW_MS);
}

function clearClaimWindow(room) {
  room._claimPending = false;
  if (room._claimTimer) { clearTimeout(room._claimTimer); room._claimTimer = null; }
}

function scheduleBotAction(room, fn) {
  setTimeout(() => {
    if (!rooms.has(room.code)) return;
    fn();
  }, botDelay());
}

function getBotMemory(room, botId) {
  if (!room._botMemory) room._botMemory = {};
  if (!room._botMemory[botId]) room._botMemory[botId] = {
    suspicion: {},      // playerId -> number (-1 to 1, neg = suspicious)
    knownFascists: [],  // playerIds confirmed fascist
    knownLiberals: [],  // playerIds confirmed liberal
    failedGovs: [],     // {presIdx, chanIdx} that failed
    enacted: [],        // {presIdx, chanIdx, policy} history
  };
  return room._botMemory[botId];
}

function updateBotSuspicions(room) {
  const bots = room.players.filter(p => p.isBot && !p.dead);
  for (const bot of bots) {
    const mem = getBotMemory(room, bot.id);
    for (const entry of room.log) {
      if (entry._botProcessed?.[bot.id]) continue;
      if (!entry._botProcessed) entry._botProcessed = {};
      entry._botProcessed[bot.id] = true;

      if (entry.type === 'chan' && entry.enacted) {
        const presName = room.players[room.presIdx]?.name;
        const chanName = room.chanIdx != null ? room.players[room.chanIdx]?.name : null;
        if (entry.enacted === 'F') {
          room.players.forEach(p => {
            if (p.name === presName || p.name === chanName) {
              mem.suspicion[p.id] = (mem.suspicion[p.id] || 0) - 0.25;
            }
          });
        } else {
          room.players.forEach(p => {
            if (p.name === presName || p.name === chanName) {
              mem.suspicion[p.id] = (mem.suspicion[p.id] || 0) + 0.15;
            }
          });
        }
      }
    }
  }
}

function botShouldVoteJa(room, bot, presIdx, chanIdx) {
  const role = bot.role;
  const mem = getBotMemory(room, bot.id);
  const pres = room.players[presIdx];
  const chan = room.players[chanIdx];

  if (role === 'fascist') {
    if (chan.role === 'hitler' && room.fasPolicies >= 3) return true;
    if (chan.role === 'fascist' || chan.role === 'hitler') return Math.random() > 0.2;
    if (pres.role === 'fascist' || pres.role === 'hitler') return Math.random() > 0.3;
    if (room.electionFails >= 2) return Math.random() > 0.4;
    return Math.random() > 0.55;
  }

  if (role === 'hitler') {
    const presSusp = mem.suspicion[pres.id] || 0;
    const chanSusp = mem.suspicion[chan.id] || 0;
    if (presSusp < -0.3 || chanSusp < -0.3) return Math.random() > 0.65;
    if (room.electionFails >= 2) return Math.random() > 0.3;
    return Math.random() > 0.4;
  }

  // Liberal
  const presSusp = mem.suspicion[pres.id] || 0;
  const chanSusp = mem.suspicion[chan.id] || 0;
  if (mem.knownFascists.includes(pres.id) || mem.knownFascists.includes(chan.id)) return false;
  if (presSusp < -0.4 && chanSusp < -0.4) return Math.random() > 0.85;
  if (presSusp < -0.3 || chanSusp < -0.3) return Math.random() > 0.65;
  if (room.electionFails >= 2) return Math.random() > 0.25;
  return Math.random() > 0.35;
}

function botPickChancellor(room, bot) {
  const role = bot.role;
  const presIdx = room.presIdx;
  const mem = getBotMemory(room, bot.id);
  const blocked = new Set();
  if (room.players.length > 5) blocked.add(room.lastElegiblePres);
  blocked.add(room.lastElegibleChan);

  const eligible = room.players.map((p, i) => ({ p, i }))
    .filter(({ p, i }) => !p.dead && i !== presIdx && !blocked.has(i));

  if (!eligible.length) return null;

  if (role === 'fascist') {
    // Prefer Hitler as chancellor if 3+ fas policies
    if (room.fasPolicies >= 3) {
      const hitlerPick = eligible.find(({ p }) => p.role === 'hitler');
      if (hitlerPick) return hitlerPick.i;
    }
    // Prefer fascist teammates
    const fasTeam = eligible.filter(({ p }) => p.role === 'fascist' || p.role === 'hitler');
    if (fasTeam.length && Math.random() > 0.3) {
      return fasTeam[Math.floor(Math.random() * fasTeam.length)].i;
    }
  }

  if (role === 'liberal') {
    // Avoid suspected fascists
    const scored = eligible.map(({ p, i }) => ({
      i, score: (mem.suspicion[p.id] || 0) + (mem.knownLiberals.includes(p.id) ? 1 : 0)
        + (mem.knownFascists.includes(p.id) ? -5 : 0)
    }));
    scored.sort((a, b) => b.score - a.score);
    // Pick from top half with some randomness
    const topHalf = scored.slice(0, Math.max(1, Math.ceil(scored.length / 2)));
    return topHalf[Math.floor(Math.random() * topHalf.length)].i;
  }

  // Hitler: pick someone who seems trustworthy
  const scored = eligible.map(({ p, i }) => ({
    i, score: (mem.suspicion[p.id] || 0)
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].i;
}

function botPresidentDiscard(room, bot, cards) {
  const role = bot.role;
  const libCount = cards.filter(c => c === 'L').length;
  const fasCount = cards.filter(c => c === 'F').length;

  if (role === 'liberal') {
    // Discard a fascist card if possible
    const fasIdx = cards.indexOf('F');
    if (fasIdx >= 0) return fasIdx;
    return 0;
  }

  if (role === 'fascist') {
    // Discard a liberal card to pass more fascist
    if (libCount >= 1 && fasCount >= 1) {
      const libIdx = cards.indexOf('L');
      if (Math.random() > 0.2) return libIdx;
    }
    // If all same, discard first
    const fasIdx = cards.indexOf('F');
    if (fasIdx >= 0 && libCount >= 2) return fasIdx; // cover: pass 2L when caught
    return cards.indexOf('L') >= 0 ? cards.indexOf('L') : 0;
  }

  // Hitler plays like liberal mostly
  const fasIdx = cards.indexOf('F');
  if (fasIdx >= 0 && Math.random() > 0.15) return fasIdx;
  return 0;
}

function botChancellorEnact(room, bot, cards) {
  const role = bot.role;

  if (role === 'liberal') {
    const libIdx = cards.indexOf('L');
    if (libIdx >= 0) return libIdx;
    return 0;
  }

  if (role === 'fascist') {
    // Enact fascist when possible, but sometimes play liberal to avoid suspicion
    const fasIdx = cards.indexOf('F');
    const libIdx = cards.indexOf('L');
    if (fasIdx >= 0 && libIdx >= 0) {
      // More likely to play fascist as game progresses
      return Math.random() > (0.3 + room.fasPolicies * 0.08) ? libIdx : fasIdx;
    }
    return 0;
  }

  // Hitler: plays mostly liberal
  const libIdx = cards.indexOf('L');
  if (libIdx >= 0 && Math.random() > 0.1) return libIdx;
  const fasIdx = cards.indexOf('F');
  return fasIdx >= 0 ? fasIdx : 0;
}

function botUsePower(room, bot) {
  const role = bot.role;
  const presIdx = room.presIdx;
  const mem = getBotMemory(room, bot.id);
  const power = room.activePower;

  const alive = room.players.map((p, i) => ({ p, i }))
    .filter(({ p, i }) => !p.dead && i !== presIdx);

  if (!alive.length) return null;

  if (power === 'peek') {
    return 0; // just peek
  }

  if (power === 'investigate') {
    if (role === 'liberal') {
      // Investigate most suspicious
      const scored = alive.map(({ p, i }) => ({
        i, score: mem.suspicion[p.id] || 0,
        known: mem.knownLiberals.includes(p.id) || mem.knownFascists.includes(p.id)
      })).filter(s => !s.known);
      if (scored.length) {
        scored.sort((a, b) => a.score - b.score);
        return scored[0].i;
      }
    } else {
      // Fascist: investigate a liberal to potentially lie about them
      const libs = alive.filter(({ p }) => p.role === 'liberal');
      if (libs.length) return libs[Math.floor(Math.random() * libs.length)].i;
    }
    return alive[Math.floor(Math.random() * alive.length)].i;
  }

  if (power === 'execute') {
    if (role === 'liberal') {
      // Kill most suspicious (hopefully fascist)
      const scored = alive.map(({ p, i }) => ({
        i, score: mem.suspicion[p.id] || 0
      }));
      scored.sort((a, b) => a.score - b.score);
      return scored[0].i;
    } else {
      // Fascist: kill a liberal, but not Hitler!
      const targets = alive.filter(({ p }) => p.role !== 'hitler' && p.role !== 'fascist');
      if (targets.length) return targets[Math.floor(Math.random() * targets.length)].i;
      // Fallback: kill anyone non-fascist
      const nonFas = alive.filter(({ p }) => p.role !== 'fascist' && p.role !== 'hitler');
      if (nonFas.length) return nonFas[Math.floor(Math.random() * nonFas.length)].i;
      return alive[Math.floor(Math.random() * alive.length)].i;
    }
  }

  if (power === 'elect') {
    if (role === 'liberal') {
      const scored = alive.map(({ p, i }) => ({
        i, score: (mem.suspicion[p.id] || 0) + (mem.knownLiberals.includes(p.id) ? 1 : 0)
      }));
      scored.sort((a, b) => b.score - a.score);
      return scored[0].i;
    } else {
      // Fascist: elect a teammate
      const team = alive.filter(({ p }) => p.role === 'fascist' || p.role === 'hitler');
      if (team.length && Math.random() > 0.4) return team[Math.floor(Math.random() * team.length)].i;
      return alive[Math.floor(Math.random() * alive.length)].i;
    }
  }

  return alive[Math.floor(Math.random() * alive.length)].i;
}

function botVetoResponse(room, bot) {
  if (bot.role === 'liberal') {
    // Accept veto if we think chancellor is trustworthy and both cards are fascist
    return room.electionFails < 2 && Math.random() > 0.4;
  }
  // Fascist: usually reject (want fascist policies)
  return Math.random() > 0.7;
}

// ─── BOT CHAT ─────────────────────────────────────────────
function botSendChat(room, bot, text) {
  const chatMsg = { type: 'chat', name: bot.name, playerId: bot.id, text, ts: Date.now() };
  const payload = JSON.stringify(chatMsg);
  for (const [ws2, m2] of clients)
    if (m2.roomCode === room.code && ws2.readyState === WebSocket.OPEN)
      ws2.send(payload);
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const BOT_CHAT = {
  gameStart: {
    liberal: [
      'Let\'s find the fascists! :eyes:',
      'Trust no one. :detective:',
      'I\'m liberal, just so everyone knows :dove:',
      'gl hf everyone :thumbsup:',
      'Ready to save democracy :shield:',
      'Let\'s do this! :fire:',
      'Alright, I have a good feeling about this group',
      'I trust... nobody. Yet.',
    ],
    fascist: [
      'I\'m definitely liberal :innocent:',
      'Let\'s find those fascists :detective:',
      'Trust me, I\'m on the good side :dove:',
      'gl everyone! :thumbsup:',
      'Ready to play! Let\'s get those fascists',
      'I have a good feeling about this game :smile:',
    ],
    hitler: [
      'Let\'s play fair everyone :handshake:',
      'Good luck all :thumbsup:',
      'Excited for this game! :party:',
      'May the best team win :star:',
      'I\'m feeling lucky today :smile:',
    ],
  },
  nominated: {
    liberal: [
      'I think {nominee} is a good pick',
      '{nominee} seems trustworthy :thumbsup:',
      'Interesting choice... :thinking:',
      'I\'ll vote based on what I\'ve seen so far',
    ],
    fascist: [
      '{nominee} is solid :thumbsup:',
      'Hmm, not sure about {nominee} :thinking:',
      'Let\'s see how this vote goes',
      'I trust {pres}\'s judgment here',
    ],
    hitler: [
      'Seems like a fair pick :ok:',
      '{nominee}, prove yourself! :point:',
      'Let\'s give them a chance',
    ],
  },
  votePassed: {
    liberal: [
      'Alright, let\'s see some liberal policies :pray:',
      'Don\'t let us down! :point:',
      'Good government, I hope :thinking:',
    ],
    fascist: [
      'Good, good :smirk:',
      'Let\'s see what happens :eyes:',
      'I believe in this government :thumbsup:',
    ],
    hitler: [
      'Nice :thumbsup:',
      'Let\'s hope for the best :pray:',
    ],
  },
  voteFailed: {
    liberal: [
      'Careful with the tracker... :warning:',
      'We need to agree on someone :exclaim:',
      'That\'s {fails}/3, be careful',
    ],
    fascist: [
      'Come on, we need to stop failing :angry:',
      'Tracker is at {fails}/3, dangerous!',
      'Maybe next government will be better',
    ],
    hitler: [
      'We need to work together :handshake:',
      'Can we please agree on something?',
    ],
  },
  enactedLib: {
    liberal: [
      ':dove: Nice! Liberal policy!',
      'Great work team! :clap:',
      'That\'s what I like to see :thumbsup:',
      'Good government! More of this please',
    ],
    fascist: [
      'Good job :thumbsup:',
      ':dove: Liberal, nice!',
      'See? I told you they were fine :smile:',
    ],
    hitler: [
      'Well done! :clap:',
      'Liberal! :dove: Great!',
    ],
  },
  enactedFas: {
    liberal: [
      ':angry: Who played that fascist card?!',
      'That\'s suspicious... :sus:',
      'We need to investigate that government :detective:',
      'Something is wrong here :thinking:',
      'I don\'t trust that government :x:',
      '{pres} or {chan}... one of you is lying :eyes:',
    ],
    fascist: [
      'Must have been forced :shush:',
      '{pres} must have drawn 3 fascist :sweat:',
      'Unlucky draw I think... :thinking:',
      'That\'s suspicious... who did this? :eyes:',
      'Hmm, I wonder what happened there :thinking:',
    ],
    hitler: [
      'That doesn\'t look good :worried:',
      'Someone is lying :thinking:',
      'Be careful everyone :warning:',
    ],
  },
  presidentClaim: {
    liberal_truth: [
      'I drew {cards} — passed the best I could :pray:',
      'Got {cards}. Discarded a fascist',
      'My draw was {cards}, did what I could',
    ],
    liberal_forced: [
      'I drew 3 fascist... nothing I could do :sob:',
      'All fascist cards :cry: sorry team',
      'Worst draw possible — 3F. Passed 2F to chancellor :skull:',
    ],
    fascist_lie: [
      'Drew 3 fascist unfortunately :sweat: nothing I could do',
      'Bad luck — all fascist :sob:',
      'Got {lieCards}, passed what I could',
      'I had no choice, drew mostly fascist :worried:',
    ],
    fascist_truth: [
      'Drew {cards}, passed the best options',
      'Got {cards}. Pretty standard draw',
    ],
  },
  chancellorClaim: {
    liberal_truth: [
      'I got {cards} and played liberal :dove:',
      'Received {cards}, enacted the liberal one :thumbsup:',
      'Both were {cards}, so that\'s what I played',
    ],
    liberal_forced: [
      'Got 2 fascist... had to play it :cry:',
      'President gave me 2F. No choice :angry:',
      'Both cards were fascist :skull: nothing I could do',
    ],
    fascist_lie: [
      'Received 2 fascist, had no choice :sweat:',
      'President passed me 2F :angry:',
      'I was forced! Both cards were fascist',
    ],
    fascist_truth: [
      'Got {cards}, played what seemed right',
      'Received {cards}',
    ],
  },
  accusation: {
    liberal: [
      'I think {target} is fascist :point:',
      '{target} has been suspicious all game :sus:',
      'We should look at {target} :detective:',
      'Something about {target} doesn\'t add up :thinking:',
      'I\'m watching you, {target} :eyes:',
    ],
    fascist: [
      '{target} is definitely suspicious :point:',
      'I don\'t trust {target} at all :angry:',
      'Has anyone else noticed {target} is sketchy? :thinking:',
      '{target} played fascist, I bet they\'re on the other team :sus:',
    ],
  },
  defense: [
    'Wait, I\'m liberal! :exclaim:',
    'Why is everyone suspecting me?? :cry:',
    'I swear I\'m on the good side :pray:',
    'Check my voting record! :point:',
    'I\'ve been playing liberal all game :dove:',
    'That\'s not fair, I was forced :angry:',
  ],
  execution: {
    liberal: [
      'I hope that was the right call :pray:',
      'Had to be done. :dagger:',
      'Justice served... I think :thinking:',
    ],
    fascist: [
      'Good riddance :skull:',
      'Had to be done :dagger:',
      'One less problem :smirk:',
    ],
  },
  chaos: [
    ':warning: Chaos! We need to start working together!',
    'This is bad! :scream: Stop failing elections!',
    'We can\'t keep doing this :angry:',
  ],
  endgame: {
    liberal_winning: [
      'One more liberal policy! :dove: :pray:',
      'We\'re so close! Don\'t mess this up :exclaim:',
      'Almost there, stay focused! :fire:',
    ],
    fascist_winning: [
      'Uh oh, fascists are close :warning:',
      'We need to be very careful now :thinking:',
      'Scary board state... :scream:',
    ],
    fascist_secret: [
      'Almost there... :eyes:',
      'Just a little more :shush:',
    ],
  },
};

function scheduleBotChat(room, event, context) {
  if (!rooms.has(room.code)) return;
  const bots = room.players.filter(p => p.isBot && !p.dead);
  if (!bots.length) return;

  // Not every bot talks every time
  const talkers = bots.filter(() => Math.random() > 0.5);
  if (!talkers.length && bots.length) talkers.push(pick(bots));

  talkers.forEach((bot, i) => {
    const delay = 800 + Math.random() * 3000 + i * 1500;
    setTimeout(() => {
      if (!rooms.has(room.code) || bot.dead) return;
      const text = generateBotChat(room, bot, event, context);
      if (text) botSendChat(room, bot, text);
    }, delay);
  });
}

function generateBotChat(room, bot, event, ctx) {
  const role = bot.role || 'liberal';
  const effectiveRole = (role === 'hitler') ? 'hitler' : role;
  ctx = ctx || {};

  switch (event) {
    case 'gameStart': {
      const pool = BOT_CHAT.gameStart[effectiveRole] || BOT_CHAT.gameStart.liberal;
      return pick(pool);
    }
    case 'nominated': {
      if (Math.random() > 0.6) return null;
      const pool = BOT_CHAT.nominated[effectiveRole] || BOT_CHAT.nominated.liberal;
      return pick(pool)
        .replace('{nominee}', ctx.nominee || 'them')
        .replace('{pres}', ctx.pres || 'the president');
    }
    case 'votePassed': {
      if (Math.random() > 0.5) return null;
      const pool = BOT_CHAT.votePassed[effectiveRole] || BOT_CHAT.votePassed.liberal;
      return pick(pool);
    }
    case 'voteFailed': {
      if (Math.random() > 0.5) return null;
      const pool = BOT_CHAT.voteFailed[effectiveRole] || BOT_CHAT.voteFailed.liberal;
      return pick(pool).replace('{fails}', ctx.fails || '?');
    }
    case 'enactedLib': {
      if (Math.random() > 0.55) return null;
      const pool = BOT_CHAT.enactedLib[effectiveRole] || BOT_CHAT.enactedLib.liberal;
      return pick(pool);
    }
    case 'enactedFas': {
      const pool = BOT_CHAT.enactedFas[effectiveRole] || BOT_CHAT.enactedFas.liberal;
      return pick(pool)
        .replace('{pres}', ctx.pres || 'the president')
        .replace('{chan}', ctx.chan || 'the chancellor');
    }
    case 'presClaim': {
      // Only the bot who was president claims
      if (bot.id !== ctx.botId) return null;
      const drew = ctx.drew;
      const enacted = ctx.enacted;
      const libCount = drew ? drew.filter(c => c === 'L').length : 0;

      if (role === 'liberal') {
        if (libCount === 0) {
          return pick(BOT_CHAT.presidentClaim.liberal_forced);
        }
        const cardStr = drew.map(c => c === 'L' ? '🕊' : '⚡').join('');
        return pick(BOT_CHAT.presidentClaim.liberal_truth).replace('{cards}', cardStr);
      } else {
        // Fascist/Hitler: lie about the draw
        if (enacted === 'F' && libCount > 0) {
          // Lie: claim worse draw than reality
          const lieCards = '⚡⚡⚡';
          return pick(BOT_CHAT.presidentClaim.fascist_lie)
            .replace('{lieCards}', lieCards).replace('{cards}', lieCards);
        }
        const cardStr = drew.map(c => c === 'L' ? '🕊' : '⚡').join('');
        return pick(BOT_CHAT.presidentClaim.fascist_truth).replace('{cards}', cardStr);
      }
    }
    case 'chanClaim': {
      if (bot.id !== ctx.botId) return null;
      const received = ctx.received;
      const enacted = ctx.enacted;

      if (role === 'liberal') {
        if (received && received.every(c => c === 'F')) {
          return pick(BOT_CHAT.chancellorClaim.liberal_forced);
        }
        const cardStr = received ? received.map(c => c === 'L' ? '🕊' : '⚡').join('') : '??';
        return pick(BOT_CHAT.chancellorClaim.liberal_truth).replace('{cards}', cardStr);
      } else {
        // Fascist lied and played fascist when had a choice
        if (enacted === 'F' && received && received.includes('L')) {
          return pick(BOT_CHAT.chancellorClaim.fascist_lie);
        }
        const cardStr = received ? received.map(c => c === 'L' ? '🕊' : '⚡').join('') : '??';
        return pick(BOT_CHAT.chancellorClaim.fascist_truth).replace('{cards}', cardStr);
      }
    }
    case 'accuse': {
      if (Math.random() > 0.35) return null;
      const pool = BOT_CHAT.accusation[effectiveRole === 'hitler' ? 'liberal' : effectiveRole] || BOT_CHAT.accusation.liberal;
      return pick(pool).replace('{target}', ctx.target || 'someone');
    }
    case 'defend': {
      return pick(BOT_CHAT.defense);
    }
    case 'execution': {
      if (Math.random() > 0.5) return null;
      const pool = BOT_CHAT.execution[effectiveRole === 'hitler' ? 'liberal' : effectiveRole] || BOT_CHAT.execution.liberal;
      return pick(pool);
    }
    case 'chaos': {
      if (Math.random() > 0.4) return null;
      return pick(BOT_CHAT.chaos);
    }
    case 'endgame': {
      if (Math.random() > 0.6) return null;
      if (role === 'fascist' && room.fasPolicies >= 4) {
        return pick(BOT_CHAT.endgame.fascist_secret);
      }
      if (room.libPolicies >= 4) {
        return pick(BOT_CHAT.endgame.liberal_winning);
      }
      if (room.fasPolicies >= 4) {
        return pick(BOT_CHAT.endgame.fascist_winning);
      }
      return null;
    }
  }
  return null;
}

function triggerBotActions(room) {
  if (room.phase !== 'active') return;
  // Wait for human claim window before proceeding
  if (room._claimPending) return;
  updateBotSuspicions(room);
  const rp = room.roundPhase;

  // Bots that need to vote
  if (rp === 'vote') {
    const alive = room.players.filter(p => !p.dead);
    alive.forEach(p => {
      if (!p.isBot || room.votes[p.id] !== undefined) return;
      scheduleBotAction(room, () => {
        if (room.roundPhase !== 'vote' || room.votes[p.id] !== undefined) return;
        const ja = botShouldVoteJa(room, p, room.presIdx, room.nomineeIdx);
        room.votes[p.id] = ja ? 'ja' : 'nein';
        room.lastActive = Date.now();

        const allVoted = alive.every(pl => room.votes[pl.id] !== undefined);
        if (allVoted) {
          clearTimer(room);
          room.voteRevealed = true;
          const jas = alive.filter(pl => room.votes[pl.id] === 'ja').length;
          const neins = alive.length - jas;
          const passed = jas > neins;
          const voteStr = alive.map(pl => `${pl.name}: ${room.votes[pl.id].toUpperCase()}`).join(', ');
          addLog(room, { type: 'elect', text: `Vote: ${passed ? '✓ JA passed' : '✗ NEIN failed'} (${jas}–${neins}). ${voteStr}.`, meta: `ROUND ${room.round}`, voteResult: passed ? 'ja' : 'nein' });

          if (passed) {
            room.chanIdx = room.nomineeIdx;
            room.electionFails = 0;
            const chan = room.players[room.chanIdx];
            if (room.fasPolicies >= 3 && chan.role === 'hitler') {
              room.phase = 'ended'; room.winner = 'fascist';
              room.winReason = `Hitler elected Chancellor with ${room.fasPolicies} Fascist policies in play!`;
              addLog(room, { type: 'chaos', text: `⚡ FASCISTS WIN — ${room.winReason}`, meta: `ROUND ${room.round}` });
              broadcastState(room); return;
            }
            room.drawnCards = buildDeck(room).slice(0, 3);
            room.roundPhase = 'presCards';
            addLog(room, { type: 'note', text: `Government formed! ${room.players[room.presIdx].name} is picking cards privately.`, meta: `ROUND ${room.round}` });
            startTimer(room);
            scheduleBotChat(room, 'votePassed');
          } else {
            room.electionFails = (room.electionFails || 0) + 1;
            addLog(room, { type: 'elect', text: `Election failed. Tracker: ${room.electionFails}/3.`, meta: `ROUND ${room.round} · AUTO` });
            if (room.electionFails >= 3) {
              broadcastState(room);
              triggerChaos(room);
              scheduleBotChat(room, 'chaos');
              if (checkWin(room)) { broadcastState(room); return; }
            }
            scheduleBotChat(room, 'voteFailed', { fails: room.electionFails });
            autoNextRound(room);
          }
          broadcastState(room);
          triggerBotActions(room);
        } else {
          broadcastState(room);
        }
      });
    });
    return;
  }

  // Bot is president and needs to nominate
  if (rp === 'nominate') {
    const pres = room.players[room.presIdx];
    if (!pres?.isBot) return;
    scheduleBotAction(room, () => {
      if (room.roundPhase !== 'nominate') return;
      const pick = botPickChancellor(room, pres);
      if (pick == null) return;
      const nominee = room.players[pick];
      room.nomineeIdx = pick;
      room.roundPhase = 'vote';
      room.votes = {};
      room.voteRevealed = false;
      addLog(room, { type: 'elect', text: `${pres.name} nominated ${nominee.name} as Chancellor. Vote now!`, meta: `ROUND ${room.round}` });
      room.lastActive = Date.now();
      startTimer(room);
      broadcastState(room);
      scheduleBotChat(room, 'nominated', { nominee: nominee.name, pres: pres.name });
      triggerBotActions(room);
    });
    return;
  }

  // Bot is president and needs to discard
  if (rp === 'presCards') {
    const pres = room.players[room.presIdx];
    if (!pres?.isBot || !room.drawnCards) return;
    scheduleBotAction(room, () => {
      if (room.roundPhase !== 'presCards' || !room.drawnCards) return;
      clearTimer(room);
      const drawnCopy = [...room.drawnCards];
      const discardIdx = botPresidentDiscard(room, pres, room.drawnCards);
      const drawn = room.drawnCards;
      const passed = drawn.filter((_, i) => i !== discardIdx);
      room.passedCards = passed;
      room.drawnCards = null;
      room._lastPresDrew = drawnCopy;
      room._lastPresId = pres.id;
      room.roundPhase = 'chanCards';
      addLog(room, { type: 'pres', text: `${pres.name} (Pres.) passed 2 cards to ${room.players[room.chanIdx].name} (Chan.) privately.`, meta: `ROUND ${room.round}` });
      room.lastActive = Date.now();
      startTimer(room);
      broadcastState(room);
      triggerBotActions(room);
    });
    return;
  }

  // Bot is chancellor and needs to enact
  if (rp === 'chanCards') {
    const chan = room.chanIdx != null ? room.players[room.chanIdx] : null;
    if (!chan?.isBot || !room.passedCards) return;
    scheduleBotAction(room, () => {
      if (room.roundPhase !== 'chanCards' || !room.passedCards) return;
      clearTimer(room);
      const receivedCopy = [...room.passedCards];
      const enactIdx = botChancellorEnact(room, chan, room.passedCards);
      const enacted = room.passedCards[enactIdx];
      room.passedCards = null;
      if (enacted === 'L') room.libPolicies = Math.min(5, room.libPolicies + 1);
      else room.fasPolicies = Math.min(6, room.fasPolicies + 1);
      room.electionFails = 0;
      addLog(room, { type: 'chan', text: `${chan.name} (Chan.) enacted ${enacted === 'L' ? '🕊 Liberal' : '⚡ Fascist'} policy.`, meta: `ROUND ${room.round}`, enacted });

      // Bot chat: claims and reactions
      const presBot = room.players[room.presIdx];
      const chatCtx = {
        pres: presBot.name,
        chan: chan.name,
        enacted,
      };
      if (enacted === 'L') {
        scheduleBotChat(room, 'enactedLib', chatCtx);
      } else {
        scheduleBotChat(room, 'enactedFas', chatCtx);
        // Bots accuse each other after fascist policy
        const suspectTarget = presBot.isBot ? chan : presBot;
        setTimeout(() => {
          if (!rooms.has(room.code)) return;
          scheduleBotChat(room, 'accuse', { target: suspectTarget.name });
        }, 4000 + Math.random() * 2000);
      }
      // Bot president claims what they drew
      if (presBot.isBot && room._lastPresId === presBot.id) {
        setTimeout(() => {
          if (!rooms.has(room.code)) return;
          scheduleBotChat(room, 'presClaim', { botId: presBot.id, drew: room._lastPresDrew, enacted });
        }, 2000 + Math.random() * 1500);
      }
      // Bot chancellor claims what they received
      setTimeout(() => {
        if (!rooms.has(room.code)) return;
        scheduleBotChat(room, 'chanClaim', { botId: chan.id, received: receivedCopy, enacted });
      }, 3500 + Math.random() * 2000);
      // Endgame commentary
      if (room.libPolicies >= 4 || room.fasPolicies >= 4) {
        scheduleBotChat(room, 'endgame');
      }

      if (checkWin(room)) { broadcastState(room); return; }
      const power = enacted === 'F' ? getPower(room.fasPolicies, room.players.length) : null;
      if (power) {
        room.activePower = power;
        room.roundPhase = 'power';
        addLog(room, { type: 'note', text: `⚡ Executive power: ${powerName(power)}. ${room.players[room.presIdx].name} must use it.`, meta: `ROUND ${room.round}` });
        startTimer(room);
      } else {
        autoNextRound(room);
      }
      room.lastActive = Date.now();
      broadcastState(room);
      triggerBotActions(room);
    });
    return;
  }

  // Bot is president and needs to use power
  if (rp === 'power') {
    const pres = room.players[room.presIdx];
    if (!pres?.isBot) return;
    scheduleBotAction(room, () => {
      if (room.roundPhase !== 'power') return;
      clearTimer(room);
      const targetIdx = botUsePower(room, pres);
      const target = room.players[targetIdx];
      const mem = getBotMemory(room, pres.id);

      switch (room.activePower) {
        case 'peek': {
          const top3 = buildDeck(room).slice(0, 3);
          addLog(room, { type: 'note', text: `${pres.name} peeked at the top 3 policy cards (private).`, meta: `ROUND ${room.round}` });
          // Bot just stores peek info, then finishes
          scheduleBotAction(room, () => {
            room.activePower = null;
            autoNextRound(room);
            room.lastActive = Date.now();
            broadcastState(room);
            triggerBotActions(room);
          });
          broadcastState(room);
          return;
        }
        case 'investigate': {
          const party = target.role === 'liberal' ? 'LIBERAL' : 'FASCIST';
          addLog(room, { type: 'inv', text: `${pres.name} investigated ${target.name} (result private).`, meta: `ROUND ${room.round}`, target: target.name });
          if (party === 'FASCIST') mem.knownFascists.push(target.id);
          else mem.knownLiberals.push(target.id);
          scheduleBotAction(room, () => {
            room.activePower = null;
            autoNextRound(room);
            room.lastActive = Date.now();
            broadcastState(room);
            triggerBotActions(room);
          });
          broadcastState(room);
          return;
        }
        case 'elect': {
          room.lastElegiblePres = room.presIdx;
          room.presIdx = targetIdx;
          room.chanIdx = null;
          room.nomineeIdx = null;
          room.activePower = null;
          addLog(room, { type: 'note', text: `Special Election — ${target.name} becomes next Presidential Candidate.`, meta: `ROUND ${room.round}` });
          room.round++;
          startNomination(room);
          addLog(room, { type: 'note', text: `Round ${room.round} begins. ${room.players[room.presIdx].name} is President.`, meta: '' });
          room.lastActive = Date.now();
          broadcastState(room);
          triggerBotActions(room);
          return;
        }
        case 'execute': {
          target.dead = true;
          room.powerTarget = targetIdx;
          addLog(room, { type: 'kill', text: `${pres.name} executed ${target.name}. 💀`, meta: `ROUND ${room.round}` });
          scheduleBotChat(room, 'execution');
          if (target.role === 'hitler') {
            room.phase = 'ended'; room.winner = 'liberal'; room.winReason = 'Hitler was executed!';
            addLog(room, { type: 'chaos', text: '🕊 LIBERALS WIN — Hitler has been executed!', meta: `ROUND ${room.round}` });
            broadcastState(room); return;
          }
          room.activePower = null;
          autoNextRound(room);
          break;
        }
      }
      room.lastActive = Date.now();
      broadcastState(room);
      triggerBotActions(room);
    });
    return;
  }

  // Bot is president and needs to respond to veto
  if (rp === 'veto') {
    const pres = room.players[room.presIdx];
    if (!pres?.isBot) return;
    scheduleBotAction(room, () => {
      if (room.roundPhase !== 'veto') return;
      clearTimer(room);
      const accept = botVetoResponse(room, pres);
      if (accept) {
        room.passedCards = null;
        room.electionFails = (room.electionFails || 0) + 1;
        addLog(room, { type: 'veto', text: `${pres.name} accepted veto. Both cards discarded. Tracker: ${room.electionFails}/3.`, meta: `ROUND ${room.round}` });
        if (room.electionFails >= 3) { triggerChaos(room); if (checkWin(room)) { broadcastState(room); return; } }
        autoNextRound(room);
      } else {
        addLog(room, { type: 'veto', text: `${pres.name} rejected veto. Chancellor must enact.`, meta: `ROUND ${room.round}` });
        room.roundPhase = 'chanCards';
        startTimer(room);
      }
      room.lastActive = Date.now();
      broadcastState(room);
      triggerBotActions(room);
    });
    return;
  }
}

// ─── WEBSOCKET ─────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.set(ws, { playerId: null, roomCode: null });
  ws.on('message', (raw) => { try { handle(ws, JSON.parse(raw)); } catch {} });
  ws.on('close', () => {
    const m = clients.get(ws);
    if (m?.roomCode && m?.playerId) {
      const room = rooms.get(m.roomCode);
      if (room) {
        const p = room.players.find(p => p.id === m.playerId);
        if (p) { p.connected = false; broadcastState(room); }
      }
    }
    clients.delete(ws);
  });
  ws.on('error', () => clients.delete(ws));
});

// ─── MESSAGE HANDLER ───────────────────────────────────────
function handle(ws, msg) {
  const meta = clients.get(ws);

  switch (msg.type) {

    case 'create': {
      const name = msg.name?.trim();
      if (!name) return sendWs(ws, { type: 'error', text: 'Name required' });
      const code   = uniqueCode();
      const player = { id: uuidv4(), name, nameColor: null, role: 'unknown', dead: false, connected: true, joinedAt: Date.now() };
      const room   = {
        code, hostId: player.id, phase: 'waiting', roundPhase: null,
        numPlayers: 7, players: [player], log: [],
        settings: defaultSettings(),
        libPolicies: 0, fasPolicies: 0, electionFails: 0,
        presIdx: 0, chanIdx: null, nomineeIdx: null,
        round: 1, winner: null, winReason: null,
        votes: {}, voteRevealed: false,
        drawnCards: null, passedCards: null,
        lastElegiblePres: null, lastElegibleChan: null,
        activePower: null, powerTarget: null,
        timerDeadline: null, _timerHandle: null,
        sharedEmotes: [],
        createdAt: Date.now(), lastActive: Date.now(),
      };
      rooms.set(code, room);
      meta.playerId = player.id; meta.roomCode = code;
      sendWs(ws, { type: 'joined', playerId: player.id, room: roomView(room) });
      if (room.sharedEmotes.length) sendWs(ws, { type: '7tv', emotes: room.sharedEmotes });
      checkSpecialPlayer(room, name);
      break;
    }

    case 'join': {
      const name = msg.name?.trim();
      const code = msg.code?.toUpperCase();
      if (!name) return sendWs(ws, { type: 'error', text: 'Name required' });
      const room = rooms.get(code);
      if (!room)                                  return sendWs(ws, { type: 'error', text: 'Room not found' });
      if (room.phase !== 'waiting')                return sendWs(ws, { type: 'error', text: 'Game already started' });
      if (room.players.length >= room.numPlayers) return sendWs(ws, { type: 'error', text: 'Room is full' });
      const player = { id: uuidv4(), name, nameColor: null, role: 'unknown', dead: false, connected: true, joinedAt: Date.now() };
      room.players.push(player);
      room.lastActive = Date.now();
      meta.playerId = player.id; meta.roomCode = code;
      sendWs(ws, { type: 'joined', playerId: player.id, room: roomView(room) });
      if (room.sharedEmotes.length) sendWs(ws, { type: '7tv', emotes: room.sharedEmotes });
      broadcastState(room);
      checkSpecialPlayer(room, name);
      break;
    }

    case 'rejoin': {
      const room = rooms.get(msg.code?.toUpperCase());
      if (!room) return sendWs(ws, { type: 'error', text: 'Room not found' });
      const player = room.players.find(p => p.id === msg.playerId);
      if (!player) return sendWs(ws, { type: 'error', text: 'Player not found' });
      player.connected = true;
      meta.playerId = player.id; meta.roomCode = room.code;
      room.lastActive = Date.now();
      const view = personalView(room, player.id);
      sendWs(ws, { type: 'joined', playerId: player.id, room: view });
      if (room.sharedEmotes.length) sendWs(ws, { type: '7tv', emotes: room.sharedEmotes });
      broadcastState(room);
      break;
    }

    case 'leave': {
      const room = rooms.get(meta.roomCode);
      if (room) {
        const p = room.players.find(p => p.id === meta.playerId);
        if (p) { p.connected = false; addLog(room, { type: 'note', text: `${p.name} left.`, meta: '' }); }
        broadcastState(room);
      }
      meta.playerId = null; meta.roomCode = null;
      sendWs(ws, { type: 'left' });
      break;
    }

    case 'setNameColor': {
      const room = rooms.get(meta.roomCode);
      if (!room) return;
      const player = room.players.find(p => p.id === meta.playerId);
      if (!player) return;
      const color = msg.color?.trim();
      if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return;
      player.nameColor = color;
      broadcastState(room);
      break;
    }

    case 'share7tv': {
      const room = rooms.get(meta.roomCode);
      if (!room) return;
      const { emoteId, emoteName } = msg;
      if (!emoteId || !emoteName || typeof emoteId !== 'string' || typeof emoteName !== 'string') return;
      if (emoteId.length > 30 || emoteName.length > 50) return;
      if (room.sharedEmotes.some(e => e.id === emoteId)) return;
      room.sharedEmotes.push({ id: emoteId, name: emoteName });
      const payload = JSON.stringify({ type: '7tv', emotes: [{ id: emoteId, name: emoteName }] });
      for (const [ws2, m2] of clients)
        if (m2.roomCode === room.code && ws2.readyState === WebSocket.OPEN)
          ws2.send(payload);
      break;
    }

    case 'addBot': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.hostId !== meta.playerId || room.phase !== 'waiting') return;
      if (room.players.length >= room.numPlayers) return sendWs(ws, { type: 'error', text: 'Room is full' });
      const botName = pickBotName(room);
      const bot = { id: uuidv4(), name: botName, role: 'unknown', dead: false, connected: true, joinedAt: Date.now(), isBot: true };
      room.players.push(bot);
      room.lastActive = Date.now();
      broadcastState(room);
      break;
    }

    case 'removeBot': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.hostId !== meta.playerId || room.phase !== 'waiting') return;
      const idx = room.players.findIndex(p => p.isBot && p.id === msg.botId);
      if (idx < 0) return;
      room.players.splice(idx, 1);
      room.lastActive = Date.now();
      broadcastState(room);
      break;
    }

    case 'setCount': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.hostId !== meta.playerId || room.phase !== 'waiting') return;
      const n = parseInt(msg.n);
      if (n < 5 || n > 10) return;
      if (room.players.length > n) return sendWs(ws, { type: 'error', text: `${room.players.length} players already joined` });
      room.numPlayers = n; room.lastActive = Date.now();
      broadcastState(room);
      break;
    }

    case 'setSettings': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.hostId !== meta.playerId || room.phase !== 'waiting') return;
      const s = room.settings;
      if (typeof msg.gameName === 'string') s.gameName = msg.gameName.trim().slice(0, 30);
      if (typeof msg.hitlerKnowsFascists === 'boolean') s.hitlerKnowsFascists = msg.hitlerKnowsFascists;
      if (typeof msg.rebalance === 'boolean') s.rebalance = msg.rebalance;
      if (typeof msg.timedMode === 'boolean') s.timedMode = msg.timedMode;
      if (typeof msg.timerSeconds === 'number') s.timerSeconds = Math.max(30, Math.min(300, Math.round(msg.timerSeconds)));
      room.lastActive = Date.now();
      broadcastState(room);
      break;
    }

    case 'shuffle': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.hostId !== meta.playerId || room.phase !== 'waiting') return;
      const arr = [...room.players];
      for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
      room.players = arr; room.presIdx = 0; room.lastActive = Date.now();
      broadcastState(room);
      break;
    }

    case 'start': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.hostId !== meta.playerId || room.phase !== 'waiting') return;
      if (room.players.length < room.numPlayers)
        return sendWs(ws, { type: 'error', text: `Need ${room.numPlayers - room.players.length} more player(s)` });

      assignRoles(room.players);

      room.phase = 'active'; room.presIdx = 0;
      startNomination(room);
      addLog(room, { type: 'note', text: `Game started! ${room.players.length} players. Round 1 — ${room.players[0].name} is President.`, meta: 'GAME START' });
      room.lastActive = Date.now();

      broadcastState(room);

      room.players.forEach(p => {
        if (p.isBot) return;
        const teammates = room.players
          .filter(t => t.id !== p.id && (t.role === 'fascist' || t.role === 'hitler'))
          .map(t => ({ name: t.name, role: t.role }));
        const knowsTeam = p.role === 'fascist' || (p.role === 'hitler' && room.settings.hitlerKnowsFascists);
        sendTo(room.code, p.id, {
          type: 'roleReveal',
          role: p.role,
          teammates: knowsTeam ? teammates : [],
        });
      });

      // Initialize bot memory with known teammates
      room.players.forEach(p => {
        if (!p.isBot) return;
        const mem = getBotMemory(room, p.id);
        if (p.role === 'fascist') {
          room.players.forEach(t => {
            if (t.id !== p.id && (t.role === 'fascist' || t.role === 'hitler'))
              mem.knownFascists.push(t.id);
          });
        }
      });

      triggerBotActions(room);
      scheduleBotChat(room, 'gameStart');
      break;
    }

    case 'nominate': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.phase !== 'active' || room.roundPhase !== 'nominate') return;
      if (room.players[room.presIdx]?.id !== meta.playerId)
        return sendWs(ws, { type: 'error', text: 'Only the President nominates' });
      const { nomineeIdx } = msg;
      const nominee = room.players[nomineeIdx];
      if (!nominee || nominee.dead) return sendWs(ws, { type: 'error', text: 'Invalid nominee' });
      if (nomineeIdx === room.presIdx) return sendWs(ws, { type: 'error', text: 'Cannot nominate yourself' });
      const blocked = new Set();
      if (room.players.length > 5) blocked.add(room.lastElegiblePres);
      blocked.add(room.lastElegibleChan);
      if (blocked.has(nomineeIdx)) return sendWs(ws, { type: 'error', text: `${nominee.name} is term-limited` });
      room.nomineeIdx   = nomineeIdx;
      room.roundPhase   = 'vote';
      room.votes        = {};
      room.voteRevealed = false;
      addLog(room, { type: 'elect', text: `${room.players[room.presIdx].name} nominated ${nominee.name} as Chancellor. Vote now!`, meta: `ROUND ${room.round}` });
      room.lastActive = Date.now();
      startTimer(room);
      broadcastState(room);
      scheduleBotChat(room, 'nominated', { nominee: nominee.name, pres: room.players[room.presIdx].name });
      triggerBotActions(room);
      break;
    }

    case 'vote': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.phase !== 'active' || room.roundPhase !== 'vote') return;
      const { v } = msg;
      if (v !== 'ja' && v !== 'nein') return;
      const player = room.players.find(p => p.id === meta.playerId);
      if (!player || player.dead) return;
      room.votes[meta.playerId] = v;
      room.lastActive = Date.now();

      const alive    = room.players.filter(p => !p.dead);
      const allVoted = alive.every(p => room.votes[p.id] !== undefined);

      if (allVoted) {
        clearTimer(room);
        room.voteRevealed = true;
        const jas    = alive.filter(p => room.votes[p.id] === 'ja').length;
        const neins  = alive.length - jas;
        const passed = jas > neins;
        const voteStr = alive.map(p => `${p.name}: ${room.votes[p.id].toUpperCase()}`).join(', ');
        addLog(room, { type: 'elect', text: `Vote: ${passed ? '✓ JA passed' : '✗ NEIN failed'} (${jas}–${neins}). ${voteStr}.`, meta: `ROUND ${room.round}`, voteResult: passed ? 'ja' : 'nein' });

        if (passed) {
          room.chanIdx       = room.nomineeIdx;
          room.electionFails = 0;
          const chan = room.players[room.chanIdx];
          if (room.fasPolicies >= 3 && chan.role === 'hitler') {
            room.phase = 'ended'; room.winner = 'fascist';
            room.winReason = `Hitler elected Chancellor with ${room.fasPolicies} Fascist policies in play!`;
            addLog(room, { type: 'chaos', text: `⚡ FASCISTS WIN — ${room.winReason}`, meta: `ROUND ${room.round}` });
            broadcastState(room); return;
          }
          room.drawnCards = buildDeck(room).slice(0, 3);
          room.roundPhase = 'presCards';
          addLog(room, { type: 'note', text: `Government formed! ${room.players[room.presIdx].name} is picking cards privately.`, meta: `ROUND ${room.round}` });
          startTimer(room);
          scheduleBotChat(room, 'votePassed');
        } else {
          room.electionFails = (room.electionFails || 0) + 1;
          addLog(room, { type: 'elect', text: `Election failed. Tracker: ${room.electionFails}/3.`, meta: `ROUND ${room.round} · AUTO` });
          if (room.electionFails >= 3) {
            broadcastState(room);
            triggerChaos(room);
            scheduleBotChat(room, 'chaos');
            if (checkWin(room)) { broadcastState(room); return; }
          }
          scheduleBotChat(room, 'voteFailed', { fails: room.electionFails });
          autoNextRound(room);
        }
      }
      broadcastState(room);
      triggerBotActions(room);
      break;
    }

    case 'presDiscard': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.phase !== 'active' || room.roundPhase !== 'presCards') return;
      if (room.players[room.presIdx]?.id !== meta.playerId)
        return sendWs(ws, { type: 'error', text: 'Only the President picks cards' });
      clearTimer(room);
      const { discardIdx } = msg;
      if (discardIdx < 0 || discardIdx > 2) return sendWs(ws, { type: 'error', text: 'Invalid card index' });
      const drawn  = room.drawnCards;
      const passed = drawn.filter((_, i) => i !== discardIdx);
      room.passedCards = passed;
      room.drawnCards  = null;
      room.roundPhase  = 'chanCards';
      addLog(room, { type: 'pres', text: `${room.players[room.presIdx].name} (Pres.) passed 2 cards to ${room.players[room.chanIdx].name} (Chan.) privately.`, meta: `ROUND ${room.round}` });
      room.lastActive = Date.now();
      startTimer(room);
      broadcastState(room);
      // Give president time to claim before bots act as chancellor
      startClaimWindow(room);
      break;
    }

    case 'chanEnact': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.phase !== 'active' || room.roundPhase !== 'chanCards') return;
      if (room.chanIdx == null || room.players[room.chanIdx]?.id !== meta.playerId)
        return sendWs(ws, { type: 'error', text: 'Only the Chancellor enacts a policy' });
      clearTimer(room);
      const { enactIdx } = msg;
      if (enactIdx !== 0 && enactIdx !== 1) return sendWs(ws, { type: 'error', text: 'Invalid card index' });
      const enacted = room.passedCards[enactIdx];
      room.passedCards = null;

      if (enacted === 'L') room.libPolicies = Math.min(5, room.libPolicies + 1);
      else                  room.fasPolicies = Math.min(6, room.fasPolicies + 1);
      room.electionFails = 0;

      addLog(room, { type: 'chan', text: `${room.players[room.chanIdx].name} (Chan.) enacted ${enacted === 'L' ? '🕊 Liberal' : '⚡ Fascist'} policy.`, meta: `ROUND ${room.round}`, enacted });

      // Bot reactions to human-enacted policy
      const chatCtx2 = { pres: room.players[room.presIdx].name, chan: room.players[room.chanIdx].name, enacted };
      if (enacted === 'L') scheduleBotChat(room, 'enactedLib', chatCtx2);
      else {
        scheduleBotChat(room, 'enactedFas', chatCtx2);
        setTimeout(() => {
          if (!rooms.has(room.code)) return;
          const suspTarget = room.players[room.presIdx];
          scheduleBotChat(room, 'accuse', { target: suspTarget.name });
        }, 4000 + Math.random() * 2000);
      }
      if (room.libPolicies >= 4 || room.fasPolicies >= 4) scheduleBotChat(room, 'endgame');

      if (checkWin(room)) { broadcastState(room); return; }

      const power = enacted === 'F' ? getPower(room.fasPolicies, room.players.length) : null;
      if (power) {
        room.activePower = power;
        room.roundPhase  = 'power';
        addLog(room, { type: 'note', text: `⚡ Executive power: ${powerName(power)}. ${room.players[room.presIdx].name} must use it.`, meta: `ROUND ${room.round}` });
        startTimer(room);
      } else {
        autoNextRound(room);
      }

      room.lastActive = Date.now();
      broadcastState(room);
      // Give chancellor time to claim before bots proceed
      startClaimWindow(room);
      break;
    }

    case 'proposeVeto': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.phase !== 'active' || room.roundPhase !== 'chanCards') return;
      if (room.fasPolicies < 5) return sendWs(ws, { type: 'error', text: 'Veto only after 5 Fascist policies' });
      if (room.players[room.chanIdx]?.id !== meta.playerId) return sendWs(ws, { type: 'error', text: 'Only Chancellor proposes veto' });
      clearTimer(room);
      room.roundPhase = 'veto';
      addLog(room, { type: 'veto', text: `${room.players[room.chanIdx].name} proposes VETO. President must accept or reject.`, meta: `ROUND ${room.round}` });
      startTimer(room);
      broadcastState(room);
      triggerBotActions(room);
      break;
    }

    case 'vetoResponse': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.phase !== 'active' || room.roundPhase !== 'veto') return;
      if (room.players[room.presIdx]?.id !== meta.playerId) return sendWs(ws, { type: 'error', text: 'Only President responds to veto' });
      clearTimer(room);
      if (msg.accept) {
        room.passedCards   = null;
        room.electionFails = (room.electionFails || 0) + 1;
        addLog(room, { type: 'veto', text: `${room.players[room.presIdx].name} accepted veto. Both cards discarded. Tracker: ${room.electionFails}/3.`, meta: `ROUND ${room.round}` });
        if (room.electionFails >= 3) { triggerChaos(room); if (checkWin(room)) { broadcastState(room); return; } }
        autoNextRound(room);
      } else {
        addLog(room, { type: 'veto', text: `${room.players[room.presIdx].name} rejected veto. Chancellor must enact.`, meta: `ROUND ${room.round}` });
        room.roundPhase = 'chanCards';
        startTimer(room);
      }
      room.lastActive = Date.now();
      broadcastState(room);
      triggerBotActions(room);
      break;
    }

    case 'usePower': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.phase !== 'active' || room.roundPhase !== 'power') return;
      if (room.players[room.presIdx]?.id !== meta.playerId) return sendWs(ws, { type: 'error', text: 'Only President uses power' });
      clearTimer(room);
      const { targetIdx } = msg;
      const target = room.players[targetIdx];
      if (!target) return sendWs(ws, { type: 'error', text: 'Invalid target' });

      switch (room.activePower) {
        case 'peek': {
          const top3 = buildDeck(room).slice(0, 3);
          addLog(room, { type: 'note', text: `${room.players[room.presIdx].name} peeked at the top 3 policy cards (private).`, meta: `ROUND ${room.round}` });
          sendTo(room.code, meta.playerId, { type: 'peek', cards: top3 });
          startTimer(room);
          broadcastState(room);
          return;
        }
        case 'investigate': {
          const party = target.role === 'liberal' ? 'LIBERAL' : 'FASCIST';
          addLog(room, { type: 'inv', text: `${room.players[room.presIdx].name} investigated ${target.name} (result private).`, meta: `ROUND ${room.round}`, target: target.name });
          sendTo(room.code, meta.playerId, { type: 'investigate', targetName: target.name, party });
          startTimer(room);
          broadcastState(room);
          return;
        }
        case 'elect': {
          room.lastElegiblePres = room.presIdx;
          room.presIdx    = targetIdx;
          room.chanIdx    = null;
          room.nomineeIdx = null;
          room.activePower = null;
          addLog(room, { type: 'note', text: `Special Election — ${target.name} becomes next Presidential Candidate.`, meta: `ROUND ${room.round}` });
          room.round++;
          startNomination(room);
          addLog(room, { type: 'note', text: `Round ${room.round} begins. ${room.players[room.presIdx].name} is President.`, meta: '' });
          room.lastActive = Date.now();
          broadcastState(room); triggerBotActions(room); return;
        }
        case 'execute': {
          target.dead = true;
          room.powerTarget = targetIdx;
          addLog(room, { type: 'kill', text: `${room.players[room.presIdx].name} executed ${target.name}. 💀`, meta: `ROUND ${room.round}` });
          scheduleBotChat(room, 'execution');
          if (target.role === 'hitler') {
            room.phase = 'ended'; room.winner = 'liberal'; room.winReason = 'Hitler was executed!';
            addLog(room, { type: 'chaos', text: '🕊 LIBERALS WIN — Hitler has been executed!', meta: `ROUND ${room.round}` });
            broadcastState(room); return;
          }
          room.activePower = null;
          autoNextRound(room);
          break;
        }
      }
      room.lastActive = Date.now();
      broadcastState(room);
      triggerBotActions(room);
      break;
    }

    case 'powerDone': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.phase !== 'active' || room.roundPhase !== 'power') return;
      if (room.players[room.presIdx]?.id !== meta.playerId) return;
      clearTimer(room);
      room.activePower = null;
      autoNextRound(room);
      room.lastActive = Date.now();
      broadcastState(room);
      triggerBotActions(room);
      break;
    }

    case 'playAgain': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.phase !== 'ended') return;
      if (room.hostId !== meta.playerId)
        return sendWs(ws, { type: 'error', text: 'Only the host can restart' });
      clearTimer(room);
      clearClaimWindow(room);
      room.phase = 'waiting';
      room.roundPhase = null;
      room.libPolicies = 0;
      room.fasPolicies = 0;
      room.electionFails = 0;
      room.presIdx = 0;
      room.chanIdx = null;
      room.nomineeIdx = null;
      room.round = 1;
      room.winner = null;
      room.winReason = null;
      room.votes = {};
      room.voteRevealed = false;
      room.drawnCards = null;
      room.passedCards = null;
      room.lastElegiblePres = null;
      room.lastElegibleChan = null;
      room.activePower = null;
      room.powerTarget = null;
      room.timerDeadline = null;
      room.log = [];
      room._botMemory = {};
      room.players.forEach(p => { p.role = 'unknown'; p.dead = false; });
      room.lastActive = Date.now();
      broadcastState(room);
      break;
    }

    case 'deleteLog': {
      const room = rooms.get(meta.roomCode);
      if (!room) return;
      room.log = room.log.filter(e => e.id !== msg.id);
      room.lastActive = Date.now();
      broadcastState(room);
      break;
    }

    case 'chat': {
      const room = rooms.get(meta.roomCode);
      if (!room) return;
      const player = room.players.find(p => p.id === meta.playerId);
      if (!player) return;
      const txt = msg.text?.trim();
      if (!txt || txt.length > 300) return;
      const chatMsg = { type: 'chat', name: player.name, nameColor: player.nameColor || null, playerId: player.id, text: txt, ts: Date.now() };
      const payload = JSON.stringify(chatMsg);
      for (const [ws2, m2] of clients)
        if (m2.roomCode === room.code && ws2.readyState === WebSocket.OPEN)
          ws2.send(payload);
      room.lastActive = Date.now();
      break;
    }

    case 'claim': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.phase !== 'active') return;
      const player = room.players.find(p => p.id === meta.playerId);
      if (!player) return;
      const { claimRole, cards } = msg;
      if (claimRole !== 'president' && claimRole !== 'chancellor') return;
      if (!Array.isArray(cards) || cards.length < 1 || cards.length > 3) return;
      if (!cards.every(c => c === 'L' || c === 'F')) return;
      const cardStr = cards.map(c => c === 'L' ? '🕊L' : '⚡F').join(' ');
      const label = claimRole === 'president' ? 'President claims drew' : 'Chancellor claims received';
      addLog(room, { type: 'claim', text: `${player.name} (${claimRole === 'president' ? 'Pres.' : 'Chan.'}): "${label}: ${cardStr}"`, meta: `ROUND ${room.round} · CLAIM` });
      clearClaimWindow(room);
      room.lastActive = Date.now();
      broadcastState(room);
      triggerBotActions(room);
      break;
    }

    case 'skipClaim': {
      const room = rooms.get(meta.roomCode);
      if (!room) return;
      clearClaimWindow(room);
      triggerBotActions(room);
      break;
    }

    case 'addNote': {
      const room = rooms.get(meta.roomCode);
      if (!room || room.phase !== 'active') return;
      const txt = msg.text?.trim();
      if (!txt) return;
      addLog(room, { type: 'note', text: txt, meta: '' });
      room.lastActive = Date.now();
      broadcastState(room);
      break;
    }

    default:
      sendWs(ws, { type: 'error', text: `Unknown: ${msg.type}` });
  }
}

// GC stale rooms
setInterval(() => {
  const cut = Date.now() - 6 * 60 * 60 * 1000;
  for (const [code, room] of rooms) if (room.lastActive < cut) { clearTimer(room); rooms.delete(code); }
}, 30 * 60 * 1000);

app.get('/api/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/room/:code', (req, res) => {
  const r = rooms.get(req.params.code.toUpperCase());
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(roomView(r));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Secret Hitler server on port ${PORT}`));
