const crypto = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL_MS = 30 * 60 * 1000;
const RECONNECT_GRACE_MS = 90 * 1000;
const DIGNITY_OFFER_MS = 30 * 1000;
const rooms = new Map();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { transports: ['websocket', 'polling'] });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));
app.get('*path', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function newRoomId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('');
  } while (rooms.has(id));
  return id;
}

function validName(value) {
  if (value == null || value === '') return true;
  const name = String(value);
  return [...name].length <= 4 && /^[\p{Script=Han}A-Za-z0-9]+$/u.test(name);
}

function cleanName(value, index) {
  if (value == null || value === '') return `玩家 ${index === 0 ? 'A' : 'B'}`;
  return String(value);
}

function createPlayer(index, name) {
  return {
    token: crypto.randomBytes(24).toString('hex'),
    socketId: null,
    online: false,
    disconnectedAt: null,
    name: cleanName(name, index),
    secret: null,
    locked: false,
    dice: null,
    rematch: false,
    lastDignityRequestId: null,
  };
}

function makeRoom(id, player) {
  return {
    id,
    players: [player, null],
    hostToken: player.token,
    phase: 'waiting',
    mode: null,
    turnIndex: null,
    winner: null,
    outcome: null,
    scores: [0, 0],
    history: [],
    notice: null,
    noticeId: null,
    caption: '',
    captionId: null,
    diceTie: false,
    normalWinner: null,
    normalLoser: null,
    normalGuessCount: 0,
    dignityAttempts: 0,
    offerBy: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    reconnectTimers: new Map(),
    diceTimer: null,
    offerTimer: null,
  };
}

function touch(room) { room.lastActivity = Date.now(); }
function onlineCount(room) { return room.players.filter((player) => player?.online).length; }
function allOnline(room) { return room.players.length === 2 && room.players.every((player) => player?.online); }
function setNotice(room, message) {
  room.notice = message;
  room.noticeId = crypto.randomUUID();
}
function setCaption(room, message) {
  room.caption = message;
  room.captionId = crypto.randomUUID();
}
function publicState(room, token) {
  const selfIndex = room.players.findIndex((player) => player?.token === token);
  return {
    roomId: room.id,
    phase: room.phase,
    mode: room.mode,
    isHost: selfIndex >= 0 && room.players[selfIndex]?.token === room.hostToken,
    notice: room.notice,
    noticeId: room.noticeId,
    caption: room.caption,
    captionId: room.captionId,
    paused: room.players.some((player) => player && !player.online) && room.phase !== 'waiting' && room.phase !== 'finished',
    turnIndex: room.turnIndex,
    winner: room.winner,
    outcome: room.outcome,
    normalWinner: room.normalWinner,
    normalLoser: room.normalLoser,
    normalGuessCount: room.normalGuessCount,
    dignityAttempts: room.dignityAttempts,
    offerBy: room.offerBy,
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
    history: room.history.map((item) => ({ ...item })),
    // 密码只在最终结算阶段公开；正常阶段永远不会进入广播状态。
    publicSecrets: room.phase === 'finished' ? room.players.map((player) => player?.secret ?? null) : null,
  };
}

async function broadcast(room) {
  const sockets = await io.in(room.id).fetchSockets();
  for (const socket of sockets) socket.emit('room:state', publicState(room, socket.data.playerToken));
}

function findPlayer(room, socket) {
  const index = room.players.findIndex((player) => player?.token === socket.data.playerToken && player.socketId === socket.id);
  return index < 0 ? null : { index, player: room.players[index] };
}

function clearReconnectTimer(room, token) {
  const timer = room.reconnectTimers.get(token);
  if (timer) clearTimeout(timer);
  room.reconnectTimers.delete(token);
}
function clearOfferTimer(room) {
  if (room.offerTimer) clearTimeout(room.offerTimer);
  room.offerTimer = null;
}
function clearDiceTimer(room) {
  if (room.diceTimer) clearTimeout(room.diceTimer);
  room.diceTimer = null;
}

function resetMatch(room, phase = 'setup') {
  clearOfferTimer(room);
  clearDiceTimer(room);
  room.phase = phase;
  room.mode = null;
  room.turnIndex = null;
  room.winner = null;
  room.outcome = null;
  room.history = [];
  room.diceTie = false;
  room.normalWinner = null;
  room.normalLoser = null;
  room.normalGuessCount = 0;
  room.dignityAttempts = 0;
  room.offerBy = null;
  room.caption = '';
  room.captionId = null;
  for (const player of room.players) {
    if (!player) continue;
    player.lastDignityRequestId = null;
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

function finishMatch(room, outcome) {
  clearOfferTimer(room);
  room.phase = 'finished';
  room.outcome = outcome;
  room.winner = outcome === 'tie' ? null : room.normalWinner;
  room.turnIndex = null;
  room.offerBy = null;
  if (outcome === 'tie') setCaption(room, '平局！尊严挽回到位');
  else if (room.dignityAttempts >= 2 && room.normalWinner != null) setCaption(room, `尊严之战失败，${room.players[room.normalWinner]?.name || '对手'} 获胜`);
  else setCaption(room, `${room.players[room.normalWinner]?.name || '玩家'} 获胜！`);
  if (outcome === 'win' && room.normalWinner != null) room.scores[room.normalWinner] += 1;
}

function startOfferTimer(room) {
  clearOfferTimer(room);
  room.offerTimer = setTimeout(async () => {
    if (room.phase !== 'dignity_offer') return;
    setNotice(room, '尊严之战等待超时，维持原判');
    finishMatch(room, 'win');
    touch(room);
    await broadcast(room);
  }, DIGNITY_OFFER_MS);
  room.offerTimer.unref?.();
}

function beginReconnectExpiry(roomId, token) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearReconnectTimer(room, token);
  const timer = setTimeout(async () => {
    const current = rooms.get(roomId);
    if (!current) return;
    const index = current.players.findIndex((player) => player?.token === token && !player.online);
    if (index < 0) return;
    const departedName = current.players[index].name;
    clearOfferTimer(current);
    clearDiceTimer(current);
    current.players[index] = null;
    if (current.players[0] == null && current.players[1]) {
      current.players[0] = current.players[1];
      current.players[1] = null;
      current.hostToken = current.players[0].token;
    } else if (current.players[0]) {
      current.hostToken = current.players[0].token;
    }
    setNotice(current, `${departedName} 重连超时，本局已结束；等待新对手加入`);
    resetForWaiting(current);
    clearReconnectTimer(current, token);
    touch(current);
    await broadcast(current);
  }, RECONNECT_GRACE_MS);
  room.reconnectTimers.set(token, timer);
}

function acknowledge(ack, payload) { if (typeof ack === 'function') ack(payload); }
function reject(ack, error, message) { acknowledge(ack, { ok: false, error, message }); }
function validationName(payload) {
  if (!validName(payload?.name)) return '名字仅限 4 字以内，不能含特殊字符';
  return null;
}

io.on('connection', (socket) => {
  socket.on('room:create', async (payload = {}, ack) => {
    const invalidName = validationName(payload);
    if (invalidName) return reject(ack, 'invalid_name', invalidName);
    if (socket.data.roomId) return reject(ack, 'already_in_room', '你已经在一个房间里，请先返回首页');
    const roomId = newRoomId();
    const player = createPlayer(0, payload.name);
    player.online = true;
    player.socketId = socket.id;
    const room = makeRoom(roomId, player);
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerToken = player.token;
    touch(room);
    acknowledge(ack, { ok: true, roomId, token: player.token, message: '房间创建成功' });
    await broadcast(room);
  });

  socket.on('room:join', async (payload = {}, ack) => {
    const invalidName = validationName(payload);
    if (invalidName) return reject(ack, 'invalid_name', invalidName);
    if (socket.data.roomId && socket.data.roomId !== String(payload.roomId || '').toUpperCase()) {
      return reject(ack, 'already_in_room', '你已经在一个房间里，请先返回首页');
    }
    const roomId = String(payload.roomId || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,6}$/.test(roomId)) return reject(ack, 'invalid_room', '房间号应为 4–6 位字母或数字');
    const room = rooms.get(roomId);
    if (!room) return reject(ack, 'not_found', '房间不存在，请检查房间号或创建新房间');

    const token = String(payload.token || '');
    let index = room.players.findIndex((player) => player?.token === token && token.length > 0);
    if (index < 0) {
      index = room.players.findIndex((player) => !player);
      if (index < 0) return reject(ack, 'full', '房间已满，最多只能有 2 位玩家');
      const player = createPlayer(index, payload.name);
      room.players[index] = player;
      if (index === 0 && room.phase === 'waiting') room.hostToken = player.token;
      if (room.phase === 'waiting') room.phase = 'setup';
      index = room.players.indexOf(player);
    }

    const player = room.players[index];
    if (player.online && player.socketId && player.socketId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(player.socketId);
      if (previousSocket) {
        previousSocket.leave(room.id);
        previousSocket.data.roomId = null;
        previousSocket.data.playerToken = null;
      }
    }
    clearReconnectTimer(room, player.token);
    player.online = true;
    player.socketId = socket.id;
    player.disconnectedAt = null;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerToken = player.token;
    if (room.phase === 'dignity_offer' && allOnline(room)) startOfferTimer(room);
    if (room.players[0] && room.players[1] && room.phase === 'waiting') room.phase = 'setup';
    setNotice(room, `${player.name} 已加入房间`);
    touch(room);
    acknowledge(ack, { ok: true, roomId, token: player.token, message: '已加入房间' });
    await broadcast(room);
  });

  socket.on('mode:set', async (payload = {}, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return reject(ack, 'not_in_room', '你已离开房间，请重新加入');
    if (found.index !== 0 || found.player.token !== room.hostToken) return reject(ack, 'not_host', '只有房主可以选择模式');
    if (room.phase !== 'setup' || !allOnline(room) || room.mode !== null || room.players.some((player) => player?.secret || player?.locked)) return reject(ack, 'wrong_phase', '双方在线后才能选择模式；本局模式锁定后不能更改');
    const mode = Number(payload.mode);
    if (mode !== 3 && mode !== 4) return reject(ack, 'invalid_mode', '请选择 3 位或 4 位模式');
    room.mode = mode;
    setNotice(room, `房主选择了 ${mode} 位模式`);
    touch(room);
    acknowledge(ack, { ok: true, message: `已选择 ${mode} 位模式` });
    await broadcast(room);
  });

  socket.on('secret:set', async (payload = {}, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return reject(ack, 'not_in_room', '你已离开房间，请重新加入');
    if (room.phase !== 'setup' || !allOnline(room)) return reject(ack, 'wrong_phase', '请等待双方在线后再设置密码');
    if (!room.mode) return reject(ack, 'mode_required', '请等待房主选择 3 位或 4 位模式');
    const secret = String(payload.secret ?? '');
    if (!new RegExp(`^\\d{${room.mode}}$`).test(secret)) return reject(ack, 'invalid_secret', `密码必须是完整的 ${room.mode} 位数字`);
    if (found.player.locked) return reject(ack, 'already_locked', '密码已锁定；双方开始掷骰后不能修改');
    found.player.secret = secret;
    found.player.locked = true;
    if (room.players.every((player) => player?.locked && player.secret)) {
      room.phase = 'dice';
      setNotice(room, '双方密码已锁定，可以掷骰决定先手');
    } else {
      setNotice(room, `${found.player.name} 已锁定密码，等待对方设置`);
    }
    touch(room);
    acknowledge(ack, { ok: true, message: '密码已锁定' });
    await broadcast(room);
  });

  socket.on('secret:unlock', async (_payload, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return reject(ack, 'not_in_room', '你已离开房间，请重新加入');
    if (room.phase !== 'setup' || !found.player.locked) return reject(ack, 'wrong_phase', '当前不能修改密码');
    found.player.secret = null;
    found.player.locked = false;
    setNotice(room, `${found.player.name} 正在修改密码，请等待重新锁定`);
    touch(room);
    acknowledge(ack, { ok: true, message: '密码已解锁，请重新设置' });
    await broadcast(room);
  });

  socket.on('dice:roll', async (_payload, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return reject(ack, 'not_in_room', '你已离开房间，请重新加入');
    if (room.phase !== 'dice' || !room.mode || !allOnline(room) || !room.players.every((player) => player?.locked && player.secret)) {
      return reject(ack, 'wrong_phase', '双方锁定密码后才能掷骰');
    }
    if (found.player.dice !== null) return reject(ack, 'already_rolled', '你已经掷过骰子，请等待对手');
    found.player.dice = crypto.randomInt(1, 7);
    if (room.players.every((player) => player?.dice !== null)) {
      if (room.players[0].dice === room.players[1].dice) {
        room.diceTie = true;
        setCaption(room, '骰子平局，请重新掷骰');
        clearDiceTimer(room);
        room.diceTimer = setTimeout(async () => {
          if (room.phase !== 'dice' || !room.diceTie) return;
          room.players.forEach((player) => { if (player) player.dice = null; });
          room.diceTie = false;
          setNotice(room, '骰子点数相同，请双方重新掷骰');
          touch(room);
          await broadcast(room);
        }, 1800);
        room.diceTimer.unref?.();
      } else {
        room.phase = 'playing';
        room.turnIndex = room.players[0].dice > room.players[1].dice ? 0 : 1;
        setCaption(room, `对局开始！${room.mode} 位模式，${room.players[room.turnIndex].name} 先手`);
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
    if (!room.mode || !new RegExp(`^\\d{${room.mode}}$`).test(guess)) return reject(ack, 'invalid_guess', `猜测必须是完整的 ${room.mode || 'N'} 位数字`);
    if (room.phase !== 'playing' || room.turnIndex !== found.index || !allOnline(room)) return reject(ack, 'not_your_turn', '现在不是你的回合，或对手已断线');
    const target = room.players[1 - found.index];
    if (!target?.secret) return reject(ack, 'target_missing', '对手密码暂不可用，请稍后重试');
    const hits = [...guess].reduce((sum, digit, index) => sum + (digit === target.secret[index] ? 1 : 0), 0);
    room.history.push({ id: crypto.randomUUID(), playerIndex: found.index, name: found.player.name, guess, hits, at: Date.now(), kind: 'normal' });
    if (hits === room.mode) {
      room.phase = 'normal_finished';
      room.normalWinner = found.index;
      room.normalLoser = 1 - found.index;
      room.winner = found.index;
      room.normalGuessCount = room.history.filter((item) => item.kind === 'normal').length;
      room.turnIndex = null;
      setCaption(room, `${found.player.name} 获胜！`);
    } else {
      room.turnIndex = 1 - found.index;
      setCaption(room, `轮到 ${room.players[room.turnIndex].name} 猜数字`);
    }
    touch(room);
    acknowledge(ack, { ok: true, message: `猜对 ${hits} 个` });
    await broadcast(room);
  });

  socket.on('dignity:offer', async (_payload, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return reject(ack, 'not_in_room', '你已离开房间，请重新加入');
    if (room.phase !== 'normal_finished' || found.index !== room.normalLoser || !allOnline(room)) return reject(ack, 'not_allowed', '只有本局败方可以发起尊严之战');
    room.phase = 'dignity_offer';
    room.offerBy = found.index;
    setNotice(room, `${found.player.name} 想发起尊严之战，请获胜方决定是否同意`);
    startOfferTimer(room);
    touch(room);
    acknowledge(ack, { ok: true, message: '尊严之战请求已发送' });
    await broadcast(room);
  });

  socket.on('dignity:respond', async (payload = {}, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return reject(ack, 'not_in_room', '你已离开房间，请重新加入');
    if (room.phase !== 'dignity_offer' || found.index !== room.normalWinner || !allOnline(room)) return reject(ack, 'not_allowed', '当前没有等待你处理的尊严之战请求');
    clearOfferTimer(room);
    if (payload.accept === true) {
      room.phase = 'dignity';
      room.dignityAttempts = 0;
      room.turnIndex = room.normalLoser;
      setCaption(room, '尊严之战！败方有两次机会争取平局');
      setNotice(room, '双方已同意尊严之战；败方可猜测两次');
      touch(room);
      acknowledge(ack, { ok: true, message: '已同意，尊严之战开始' });
    } else {
      setNotice(room, '获胜方拒绝尊严之战，维持原判');
      finishMatch(room, 'win');
      touch(room);
      acknowledge(ack, { ok: true, message: '已拒绝，进入最终结算' });
    }
    await broadcast(room);
  });

  socket.on('dignity:submit', async (payload = {}, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return reject(ack, 'not_in_room', '你已离开房间，请重新加入');
    const guess = String(payload?.guess ?? '');
    if (!room.mode || !new RegExp(`^\\d{${room.mode}}$`).test(guess)) return reject(ack, 'invalid_guess', `猜测必须是完整的 ${room.mode || 'N'} 位数字`);
    if (room.phase !== 'dignity' || found.index !== room.normalLoser || !allOnline(room)) return reject(ack, 'not_allowed', '只有败方可以在尊严之战中猜测');
    const requestId = String(payload?.requestId || '');
    if (requestId && requestId === found.player.lastDignityRequestId) return reject(ack, 'duplicate', '这次猜测已提交，请等待结果');
    if (requestId) found.player.lastDignityRequestId = requestId;
    const target = room.players[room.normalWinner];
    if (!target?.secret) return reject(ack, 'target_missing', '目标密码暂不可用');
    const hits = [...guess].reduce((sum, digit, index) => sum + (digit === target.secret[index] ? 1 : 0), 0);
    room.dignityAttempts += 1;
    room.history.push({ id: crypto.randomUUID(), playerIndex: found.index, name: found.player.name, guess, hits, at: Date.now(), kind: 'dignity', attempt: room.dignityAttempts });
    if (hits === room.mode) {
      finishMatch(room, 'tie');
    } else if (room.dignityAttempts >= 2) {
      finishMatch(room, 'win');
    } else {
      setNotice(room, `尊严之战第 1 次猜测未能全部命中，还剩 1 次机会`);
    }
    touch(room);
    acknowledge(ack, { ok: true, message: `猜对 ${hits} 个` });
    await broadcast(room);
  });

  socket.on('match:decline', async (_payload, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return reject(ack, 'not_in_room', '你已离开房间，请重新加入');
    if (room.phase !== 'normal_finished' || found.index !== room.normalLoser || !allOnline(room)) return reject(ack, 'not_allowed', '当前不能执行该操作，或对手已断线');
    setNotice(room, '败方选择不发起尊严之战，正在公布双方数字');
    finishMatch(room, 'win');
    touch(room);
    acknowledge(ack, { ok: true, message: '进入最终结算' });
    await broadcast(room);
  });

  socket.on('match:rematch', async (_payload, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return reject(ack, 'not_in_room', '你已离开房间，请重新加入');
    if (room.phase !== 'finished' || !allOnline(room)) return reject(ack, 'wrong_phase', '双方在线并且本局结算后才能再来一局');
    if (found.player.rematch) return reject(ack, 'duplicate', '你已经准备好了，正在等待对手');
    found.player.rematch = true;
    if (room.players.every((player) => player?.rematch)) {
      resetMatch(room, 'setup');
      setNotice(room, '新一局已准备好，请房主重新选择模式');
    }
    touch(room);
    acknowledge(ack, { ok: true, message: '已准备好，等待对手确认' });
    await broadcast(room);
  });

  socket.on('room:leave', async (_payload, ack) => {
    const room = rooms.get(socket.data.roomId);
    const found = room && findPlayer(room, socket);
    if (!found) return acknowledge(ack, { ok: true, message: '已离开房间' });
    clearReconnectTimer(room, found.player.token);
    clearOfferTimer(room);
    clearDiceTimer(room);
    setNotice(room, `${found.player.name} 离开了房间`);
    room.players[found.index] = null;
    if (found.index === 0 && room.players[1]) {
      room.players[0] = room.players[1];
      room.players[1] = null;
    }
    if (room.players[0]) room.hostToken = room.players[0].token;
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
    setNotice(room, `${found.player.name} 网络断开，正在等待重连`);
    clearOfferTimer(room);
    touch(room);
    beginReconnectExpiry(room.id, found.player.token);
    await broadcast(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (onlineCount(room) === 0 && now - room.lastActivity > ROOM_TTL_MS) {
      for (const timer of room.reconnectTimers.values()) clearTimeout(timer);
      clearOfferTimer(room);
      clearDiceTimer(room);
      rooms.delete(id);
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`对位猜数字已启动，监听端口 ${PORT}`));

