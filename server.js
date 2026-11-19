const crypto = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL_MS = 30 * 60 * 1000;
const RECONNECT_GRACE_MS = 90 * 1000;
const rooms = new Map();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));
app.get('*path', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function newRoomId() {
  let id;
  do {
    id = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  } while (rooms.has(id));
  return id;
}

function cleanName(value, fallback) {
  const name = String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16);
  return name || fallback;
}

function createPlayer(index, name) {
  return {
    token: crypto.randomBytes(24).toString('hex'),
    socketId: null,
    online: false,
    disconnectedAt: null,
    name: cleanName(name, `玩家 ${index === 0 ? 'A' : 'B'}`),
    secret: null,
    locked: false,
    dice: null,
    rematch: false,
  };
}

function makeRoom(id, player) {
  return {
    id,
    players: [player, null],
    phase: 'waiting',
    turnIndex: null,
    winner: null,
    scores: [0, 0],
    history: [],
    notice: null,
    noticeId: null,
    diceTie: false,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    timers: new Map(),
  };
}

function touch(room) {
  room.lastActivity = Date.now();
}

function onlineCount(room) {
  return room.players.filter((player) => player?.online).length;
}

function publicState(room, token) {
  const selfIndex = room.players.findIndex((player) => player?.token === token);
  return {
    roomId: room.id,
    phase: room.phase,
    notice: room.notice,
    noticeId: room.noticeId,
    paused: room.players.some((player) => player && !player.online) && !['waiting', 'finished'].includes(room.phase),
    turnIndex: room.turnIndex,
    winner: room.winner,
    scores: [...room.scores],
    diceTie: room.diceTie,
    onlineCount: onlineCount(room),
    selfIndex,
    players: room.players.map((player, index) => player ? ({
      index,
      name: player.name,
      online: player.online,
      locked: player.locked,
      hasSecret: Boolean(player.secret),
      dice: player.dice,
      rematch: player.rematch,
    }) : null),
    history: room.history,
  };
}

async function broadcast(room) {
  const sockets = await io.in(room.id).fetchSockets();
  for (const socket of sockets) {
    socket.emit('room:state', publicState(room, socket.data.playerToken));
  }
}

function findPlayer(room, socket) {
  const index = room.players.findIndex((player) => player?.token === socket.data.playerToken && player.socketId === socket.id);
  return index < 0 ? null : { index, player: room.players[index] };
}

function clearTimer(room, token) {
  const timer = room.timers.get(token);
  if (timer) clearTimeout(timer);
  room.timers.delete(token);
}

function resetMatch(room, phase = 'setup') {
  room.phase = phase;
  room.turnIndex = null;
  room.winner = null;
  room.history = [];
  room.diceTie = false;
  for (const player of room.players) {
    if (!player) continue;
    player.secret = null;
    player.locked = false;
    player.dice = null;
    player.rematch = false;
  }
}

function resetForWaiting(room) {
  resetMatch(room, 'waiting');
  room.scores = [0, 0];
}

function beginReconnectExpiry(roomId, token) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTimer(room, token);
  const timer = setTimeout(async () => {
    const current = rooms.get(roomId);
    if (!current) return;
    const index = current.players.findIndex((player) => player?.token === token && !player.online);
    if (index < 0) return;
    const departedName = current.players[index].name;
    current.players[index] = null;
    current.notice = `${departedName} 重连超时，本局已结束；等待新对手加入`;
    current.noticeId = crypto.randomUUID();
    resetForWaiting(current);
    clearTimer(current, token);
    touch(current);
    await broadcast(current);
  }, RECONNECT_GRACE_MS);
  room.timers.set(token, timer);
}

function acknowledge(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

function reject(ack, error, message) {
  acknowledge(ack, { ok: false, error, message });
}

io.on('connection', (socket) => {
  socket.on('room:create', async (payload = {}, ack) => {
    const roomId = newRoomId();
    const player = createPlayer(0, payload?.name);
    player.online = true;
    player.socketId = socket.id;
    const room = makeRoom(roomId, player);
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerToken = player.token;
    touch(room);
    acknowledge(ack, { ok: true, roomId, token: player.token, state: publicState(room, player.token), message: '房间创建成功' });
  });

  socket.on('room:join', async (payload = {}, ack) => {
    const id = String(payload?.roomId ?? '').trim();
    if (!/^\d{4,6}$/.test(id)) return reject(ack, 'invalid_room_id', '房间号需为 4–6 位数字');
    const room = rooms.get(id);
    if (!room) return reject(ack, 'not_found', '房间不存在，请检查房间号或让好友重新创建');

    const token = String(payload?.token ?? '');
    let index = token ? room.players.findIndex((player) => player?.token === token) : -1;
    let player;
    if (index >= 0) {
      player = room.players[index];
      if (player.socketId && player.socketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(player.socketId);
        if (oldSocket) oldSocket.disconnect(true);
      }
      clearTimer(room, player.token);
      player.online = true;
      player.socketId = socket.id;
      player.disconnectedAt = null;
      room.notice = null;
      room.noticeId = null;
    } else {
      index = room.players.findIndex((seat) => seat === null);
      if (index < 0) return reject(ack, 'full', '房间已满，最多只能有 2 位玩家');
      if (onlineCount(room) === 0 && room.phase !== 'waiting') resetForWaiting(room);
      player = createPlayer(index, payload?.name);
      player.online = true;
      player.socketId = socket.id;
      room.players[index] = player;
      room.notice = null;
      room.noticeId = null;
      room.scores = [0, 0];
      if (room.players.every(Boolean) && room.phase === 'waiting') resetMatch(room, 'setup');
    }

    socket.join(id);
    socket.data.roomId = id;
    socket.data.playerToken = player.token;
    touch(room);
    acknowledge(ack, { ok: true, roomId: id, token: player.token, state: publicState(room, player.token), message: '已进入房间' });
    await broadcast(room);
  });

  socket.on('secret:set', async (payload = {}, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return reject(ack, 'not_in_room', '你已离开房间，请重新加入');
    const secret = String(payload?.secret ?? '');
    if (!/^\d{3}$/.test(secret)) return reject(ack, 'invalid_secret', '密码必须是完整的 3 位数字');
    if (!['setup', 'dice'].includes(room.phase)) return reject(ack, 'wrong_phase', '当前阶段不能修改密码');
    if (room.phase === 'dice' && room.players.some((player) => player?.dice !== null)) {
      return reject(ack, 'dice_started', '已经有人掷骰，密码不能再修改');
    }
    found.player.secret = secret;
    found.player.locked = true;
    found.player.dice = null;
    room.phase = room.players.every((seat) => seat?.online && seat.locked && seat.secret) ? 'dice' : 'setup';
    touch(room);
    acknowledge(ack, { ok: true, message: '密码已锁定，等待对手' });
    await broadcast(room);
  });

  socket.on('secret:unlock', async (_payload, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return reject(ack, 'not_in_room', '你已离开房间，请重新加入');
    if (!['setup', 'dice'].includes(room.phase) || room.players.some((player) => player?.dice !== null)) {
      return reject(ack, 'wrong_phase', '当前阶段不能修改密码');
    }
    found.player.secret = null;
    found.player.locked = false;
    room.phase = 'setup';
    touch(room);
    acknowledge(ack, { ok: true, message: '密码已解锁，请重新设置' });
    await broadcast(room);
  });

  socket.on('dice:roll', async (_payload, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return reject(ack, 'not_in_room', '你已离开房间，请重新加入');
    if (room.phase !== 'dice' || room.diceTie || !room.players.every((player) => player?.online && player.locked && player.secret)) {
      return reject(ack, 'wrong_phase', '双方锁定密码后才能掷骰');
    }
    if (found.player.dice !== null) return reject(ack, 'already_rolled', '你已经掷过骰子，请等待对手');
    found.player.dice = crypto.randomInt(1, 7);
    if (room.players.every((player) => player?.dice !== null)) {
      if (room.players[0].dice === room.players[1].dice) {
        room.diceTie = true;
        const roomId = room.id;
        setTimeout(async () => {
          const current = rooms.get(roomId);
          if (!current || current.phase !== 'dice' || !current.diceTie) return;
          current.players.forEach((player) => { if (player) player.dice = null; });
          current.diceTie = false;
          touch(current);
          await broadcast(current);
        }, 1800);
      } else {
        room.phase = 'playing';
        room.turnIndex = room.players[0].dice > room.players[1].dice ? 0 : 1;
      }
    }
    touch(room);
    acknowledge(ack, { ok: true, message: '骰子结果已同步' });
    await broadcast(room);
  });

  socket.on('guess:submit', async (payload = {}, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return reject(ack, 'not_in_room', '你已离开房间，请重新加入');
    const guess = String(payload?.guess ?? '');
    if (!/^\d{3}$/.test(guess)) return reject(ack, 'invalid_guess', '猜测必须是完整的 3 位数字');
    if (room.phase !== 'playing' || room.turnIndex !== found.index || room.players.some((player) => !player?.online)) {
      return reject(ack, 'not_your_turn', '现在不是你的回合，或对手已断线');
    }
    const target = room.players[1 - found.index];
    if (!target?.secret) return reject(ack, 'target_missing', '对手密码暂不可用，请稍后重试');

    let hits = 0;
    for (let i = 0; i < 3; i += 1) if (guess[i] === target.secret[i]) hits += 1;
    room.history.push({ id: crypto.randomUUID(), playerIndex: found.index, guess, hits, at: Date.now() });
    if (hits === 3) {
      room.phase = 'finished';
      room.winner = found.index;
      room.scores[found.index] += 1;
    } else {
      room.turnIndex = 1 - found.index;
    }
    touch(room);
    acknowledge(ack, { ok: true, message: '猜测已提交，结果已同步' });
    await broadcast(room);
  });

  socket.on('match:rematch', async (_payload, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return reject(ack, 'not_in_room', '你已离开房间，请重新加入');
    if (room.phase !== 'finished' || room.players.some((player) => !player?.online)) {
      return reject(ack, 'wrong_phase', '双方在线并且本局结束后才能再来一局');
    }
    if (found.player.rematch) return reject(ack, 'duplicate', '你已经准备好了，正在等待对手');
    found.player.rematch = true;
    if (room.players.every((player) => player?.rematch)) resetMatch(room, 'setup');
    touch(room);
    acknowledge(ack, { ok: true, message: '已准备好，等待对手确认' });
    await broadcast(room);
  });

  socket.on('room:leave', async (_payload, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return acknowledge(ack, { ok: true, message: '已离开房间' });
    clearTimer(room, found.player.token);
    room.notice = `${found.player.name} 离开了房间`;
    room.noticeId = crypto.randomUUID();
    room.players[found.index] = null;
    resetForWaiting(room);
    socket.leave(room.id);
    socket.data.roomId = null;
    socket.data.playerToken = null;
    touch(room);
    acknowledge(ack, { ok: true, message: '已离开房间' });
    await broadcast(room);
  });

  socket.on('disconnect', async () => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return;
    found.player.online = false;
    found.player.socketId = null;
    found.player.disconnectedAt = Date.now();
    room.notice = `${found.player.name} 网络断开，正在等待重连`;
    room.noticeId = crypto.randomUUID();
    touch(room);
    beginReconnectExpiry(room.id, found.player.token);
    await broadcast(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (onlineCount(room) === 0 && now - room.lastActivity > ROOM_TTL_MS) {
      for (const timer of room.timers.values()) clearTimeout(timer);
      rooms.delete(id);
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`对位猜数字已启动，监听端口 ${PORT}`));

