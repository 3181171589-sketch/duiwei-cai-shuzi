'use strict';
const app = document.getElementById('app');
const network = document.getElementById('network');
const captionNode = document.getElementById('caption');
const modalRoot = document.getElementById('modal-root');
const toastRoot = document.getElementById('toast-root');
const socket = io({ reconnection: true, reconnectionAttempts: Infinity, timeout: 10000 });
const EMOTES = { 加油: '📣', 疑惑: '🤔', 恭喜: '🎉', 哈哈: '😂', 哭: '😭' };
const SOUND_KEY = 'duiwei-sound-muted';
let roomState = null, activeRoomId = '', playerToken = '', joining = false, joinedOnThisConnection = false;
let homeError = '', homeName = localStorage.getItem('duiwei-name') || '', homeRoomCode = '';
let linkNameRequired = false, toastTimer = null, captionTimer = null, lastCaptionId = '', lastEmoteId = '';
let lastDignityPrompt = '', previousState = null, soundMuted = localStorage.getItem(SOUND_KEY) === '1';
let turnEndsAt = 0, pausedRemaining = 60000, isTurnPaused = false, reconnectEndsAt = [0, 0];
let audioContext = null, busyGuess = false;
const queryRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
if (queryRoom) {
  activeRoomId = queryRoom; homeRoomCode = queryRoom;
  playerToken = localStorage.getItem(`duiwei-token:${queryRoom}`) || '';
  linkNameRequired = !homeName;
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function validName(value) { return value === '' || ([...value].length <= 4 && /^[\p{Script=Han}A-Za-z0-9]+$/u.test(value)); }
function showToast(message, error = false) {
  toastRoot.innerHTML = `<div class="toast ${error ? 'toast-error' : ''}" role="status">${escapeHtml(message)}</div>`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastRoot.innerHTML = ''; }, 2800);
}
function setNetwork(label, state) {
  if (!network) return;
  network.classList.toggle('is-online', state === 'online');
  network.classList.toggle('is-offline', state === 'offline');
  const text = network.querySelector('span'); if (text) text.textContent = label;
}
function saveRoom(id, token) {
  activeRoomId = id; playerToken = token; localStorage.setItem(`duiwei-token:${id}`, token);
  const url = new URL(location.href); url.searchParams.set('room', id); history.replaceState({}, '', url);
}
function clearRoomUrl() {
  const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState({}, '', url);
  activeRoomId = ''; playerToken = '';
}
function emit(event, payload = {}, done = () => {}) {
  if (!socket.connected) { showToast('网络正在重连，请稍后再试', true); return; }
  socket.emit(event, payload, result => {
    if (!result?.ok) { showToast(result?.message || '操作没有成功，请稍后重试', true); done(null, result); return; }
    done(result);
  });
}
async function copyRoomLink() {
  const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(activeRoomId)}`;
  try { await navigator.clipboard.writeText(link); }
  catch {
    const input = document.createElement('textarea'); input.value = link; input.style.cssText = 'position:fixed;opacity:0';
    document.body.append(input); input.select(); try { document.execCommand('copy'); } catch {} input.remove();
  }
  showToast('链接已复制，发给好友吧 💌');
}
let mascotSequence = 0;
function mascot(state = 'default', size = 112, extraClass = '') {
  const id = `plush-${++mascotSequence}`;
  const openEyes = '<g class="mascot-big-eyes"><ellipse cx="42" cy="55" rx="8.4" ry="10.2" fill="#fff" stroke="#d96b91" stroke-width="1.1"/><ellipse cx="66" cy="55" rx="8.4" ry="10.2" fill="#fff" stroke="#d96b91" stroke-width="1.1"/><ellipse cx="42" cy="56" rx="5.7" ry="7.3" fill="#49313f"/><ellipse cx="66" cy="56" rx="5.7" ry="7.3" fill="#49313f"/><ellipse cx="42" cy="57" rx="3.4" ry="4.8" fill="#201a25"/><ellipse cx="66" cy="57" rx="3.4" ry="4.8" fill="#201a25"/><circle cx="39.8" cy="52.5" r="2.4" fill="#fff"/><circle cx="63.8" cy="52.5" r="2.4" fill="#fff"/><circle cx="44.2" cy="59.2" r="1.1" fill="#fff" opacity=".9"/><circle cx="68.2" cy="59.2" r="1.1" fill="#fff" opacity=".9"/></g>';
  const face = {
    default: `${openEyes}<path d="M49 72 Q54 77 59 72" fill="none" stroke="#75495a" stroke-width="2.6" stroke-linecap="round"/>`,
    expect: `${openEyes}<path d="M49 72 Q54 77 59 72" fill="none" stroke="#75495a" stroke-width="2.6" stroke-linecap="round"/><path d="M30 44l1.5-3 1.5 3 3 .5-2.2 2 .6 3-2.9-1.6-2.7 1.6.5-3-2.2-2zM75 43l1.3-2.7 1.3 2.7 2.7.4-2 1.8.5 2.7-2.5-1.4-2.4 1.4.4-2.7-2-1.8z" fill="#fff8c9" stroke="#f4b9cf" stroke-width=".7"/>`,
    win: '<path d="M34 56 Q42 46 50 56 M58 56 Q66 46 74 56" fill="none" stroke="#75495a" stroke-width="3.5" stroke-linecap="round"/><path d="M45 68 Q54 84 63 68 Q54 73 45 68" fill="#fff" stroke="#75495a" stroke-width="2" stroke-linejoin="round"/><path d="M28 37l3-6 3 6 6 1-5 4 1 6-5-3-5 3 1-6-5-4z" fill="#ffd264"/>',
    sad: `${openEyes}<path d="M35 43 Q42 39 49 44 M59 44 Q66 39 73 43" fill="none" stroke="#75495a" stroke-width="2" stroke-linecap="round"/><path d="M49 75 Q54 69 59 75" fill="none" stroke="#75495a" stroke-width="2.6" stroke-linecap="round"/><path d="M43 64 C39 69 40 74 44 76 C48 74 47 69 43 64Z" fill="#78c8ed"/><path d="M43 67l1 4" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/><rect x="69" y="75" width="15" height="7" rx="3.5" fill="#fff3aa" stroke="#e9c96e" stroke-width=".8" transform="rotate(-18 69 75)"/>`,
    tie: `${openEyes}<path d="M49 72 Q54 77 59 72" fill="none" stroke="#75495a" stroke-width="2.6" stroke-linecap="round"/><path d="M54 81 C48 75 42 80 47 85 L54 91 L61 85 C66 80 60 75 54 81Z" fill="#ff628e" stroke="#fff" stroke-width="1"/>`,
    cheer: `${openEyes}<path d="M49 72 Q54 77 59 72" fill="none" stroke="#75495a" stroke-width="2.6" stroke-linecap="round"/><text x="20" y="39" font-size="13" fill="#9b77d8">♪</text><text x="79" y="41" font-size="13" fill="#9b77d8">♫</text>`
  }[state] || `${openEyes}<path d="M49 72 Q54 77 59 72" fill="none" stroke="#75495a" stroke-width="2.6" stroke-linecap="round"/>`;
  return `<svg class="mascot ${extraClass}" width="${size}" height="${size}" viewBox="0 0 108 108" role="img" aria-label="毛绒粉团子"><defs>
    <linearGradient id="${id}-body" x1=".12" y1=".08" x2=".88" y2=".96"><stop stop-color="#ffe0ec"/><stop offset=".48" stop-color="#ffb6d0"/><stop offset="1" stop-color="#ed709c"/></linearGradient>
    <linearGradient id="${id}-ear" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ffc8dc"/><stop offset="1" stop-color="#ec79a0"/></linearGradient>
    <radialGradient id="${id}-glow" cx=".34" cy=".24" r=".75"><stop stop-color="#fff" stop-opacity=".68"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <pattern id="${id}-pile" width="5.5" height="5.5" patternUnits="userSpaceOnUse"><path d="M.5 1.5q1-1.6 2 .1M3.1 4.6q.8-1.4 1.8-.2" fill="none" stroke="#fff" stroke-opacity=".72" stroke-width="1.05" stroke-linecap="round"/><path d="M2.7 2.7q.7-1 1.3-.1" fill="none" stroke="#c54e7b" stroke-opacity=".2" stroke-width=".8" stroke-linecap="round"/></pattern>
    <filter id="${id}-fuzz" x="-8%" y="-8%" width="116%" height="116%"><feTurbulence type="fractalNoise" baseFrequency=".07" numOctaves="2" seed="7" result="soft-fibers"/><feDisplacementMap in="SourceGraphic" in2="soft-fibers" scale="1.15" xChannelSelector="R" yChannelSelector="G"/></filter>
  </defs>
  <ellipse cx="42" cy="86" rx="10" ry="5.2" fill="url(#${id}-ear)"/><ellipse cx="66" cy="86" rx="10" ry="5.2" fill="url(#${id}-ear)"/>
  <ellipse cx="31" cy="39" rx="9.5" ry="15" fill="url(#${id}-ear)" stroke="#e86f99" stroke-width="1.4" transform="rotate(-12 31 39)"/><ellipse cx="31" cy="39" rx="4.2" ry="9" fill="#ffe3ed" opacity=".72" transform="rotate(-12 31 39)"/>
  <ellipse cx="77" cy="39" rx="9.5" ry="15" fill="url(#${id}-ear)" stroke="#e86f99" stroke-width="1.4" transform="rotate(12 77 39)"/><ellipse cx="77" cy="39" rx="4.2" ry="9" fill="#ffe3ed" opacity=".72" transform="rotate(12 77 39)"/>
  <ellipse cx="17" cy="77" rx="6.5" ry="9" fill="url(#${id}-body)" stroke="#e86f99" stroke-width="1.2" transform="rotate(34 17 77)"/><ellipse cx="91" cy="77" rx="6.5" ry="9" fill="url(#${id}-body)" stroke="#e86f99" stroke-width="1.2" transform="rotate(-34 91 77)"/>
  <ellipse cx="54" cy="58" rx="39" ry="35" fill="url(#${id}-body)" stroke="#e86f99" stroke-width="2" filter="url(#${id}-fuzz)"/>
  <ellipse cx="54" cy="58" rx="38.5" ry="34.5" fill="url(#${id}-pile)" opacity=".58"/>
  <ellipse cx="54" cy="57" rx="35" ry="31" fill="url(#${id}-glow)"/>
  <ellipse cx="33" cy="70" rx="7.4" ry="4.2" fill="#ff829f" opacity=".6"/><ellipse cx="75" cy="70" rx="7.4" ry="4.2" fill="#ff829f" opacity=".6"/>
  ${face}
  <path d="M25 34q2-3 4-.5M79 34q2-3 4-.5M18 60q-3 1-3 4M90 60q3 1 3 4M26 83q2 2 4 1M78 84q2-1 4-3" fill="none" stroke="#fff1f7" stroke-width="1.5" stroke-linecap="round" opacity=".85"/>
  <ellipse cx="43" cy="31" rx="12" ry="4.5" fill="#fff" opacity=".42" transform="rotate(-17 43 31)"/>
  </svg>`;
}
function renderHome() {
  const storedName = localStorage.getItem('duiwei-name') || homeName;
  app.innerHTML = `<section class="home-screen"><div class="hero-card"><div class="hero-art">${mascot('expect', 138)}<span class="sparkle sparkle-one">✦</span><span class="sparkle sparkle-two">♡</span></div><p class="eyebrow">FRIENDS · QUICK DUEL</p><h1>对位猜数字</h1><p class="hero-subtitle">双人在线对战 · 粉团子陪你猜</p><p class="hero-rule">各自设密码，轮流猜数字；只统计数字和位置都正确的命中数。</p></div><section class="home-panel card"><label class="field-label" for="nickname">你的昵称 <small>1–4 个汉字、字母或数字；留空使用默认昵称</small></label><input class="text-input" id="nickname" maxlength="4" autocomplete="nickname" placeholder="例如：小桃" value="${escapeHtml(storedName)}"><p class="field-error" id="nickname-error"></p><button class="btn btn-primary btn-wide" data-action="create">🎲 创建新房间</button><div class="separator"><span>或者加入好友房间</span></div><label class="field-label" for="room-code-input">输入 6 位房间码</label><div class="join-row"><input class="text-input room-code-input" id="room-code-input" maxlength="6" autocomplete="off" autocapitalize="characters" placeholder="例：K7S9P2" value="${escapeHtml(homeRoomCode)}"><button class="btn btn-secondary" data-action="join">加入</button></div><p class="field-error" id="home-error">${escapeHtml(homeError || (linkNameRequired ? '先取个名字再点加入 💗' : ''))}</p><button class="text-button" data-action="rules">❔ 查看完整规则</button></section><div class="home-footnote">免登录 · 房间仅限 2 人 · 分享链接即可开局</div></section>`;
  updateHomeJoinPrompt();
}
function updateHomeJoinPrompt() {
  const hint = document.getElementById('home-error'), nameInput = document.getElementById('nickname'), button = app.querySelector('[data-action="join"]');
  if (!hint || !nameInput || !button) return;
  const invalid = !validName(nameInput.value), needsName = linkNameRequired && !nameInput.value;
  button.disabled = invalid || needsName;
  const error = document.getElementById('nickname-error');
  if (error) error.textContent = invalid ? '名字仅限 4 字以内，不能含特殊字符' : '';
  if (!homeError) hint.textContent = needsName ? '先取个名字再点加入 💗' : '';
}
function requestRoomJoin(roomId) {
  if (!roomId || joining || !socket.connected) return;
  const name = localStorage.getItem('duiwei-name') || homeName;
  if (!name) { linkNameRequired = true; homeRoomCode = roomId; renderHome(); showToast('先取个名字再点加入', true); return; }
  joining = true; homeError = ''; app.innerHTML = '<section class="loading-card"><span class="loader"></span><p>粉团子正在帮你进入房间…</p></section>';
  socket.emit('room:join', { roomId, token: playerToken || localStorage.getItem(`duiwei-token:${roomId}`) || '', name }, result => {
    joining = false;
    if (!result?.ok) {
      const message = result?.message || '房间不存在或已失效';
      if (['not_found', 'full', 'invalid_room'].includes(result?.error)) { localStorage.removeItem(`duiwei-token:${roomId}`); clearRoomUrl(); }
      roomState = null; joinedOnThisConnection = false; homeError = message; renderHome(); showToast(message, true); return;
    }
    localStorage.setItem('duiwei-name', name); homeName = name;
    saveRoom(result.roomId || roomId, result.token); joinedOnThisConnection = true;
    roomState = result.state || roomState; if (roomState) renderGame();
  });
}
function createRoom(name) {
  if (!socket.connected) return showToast('网络连接中，请稍等片刻', true);
  socket.emit('room:create', { name }, result => {
    if (!result?.ok) return showToast(result?.message || '创建房间失败，请重试', true);
    if (name) localStorage.setItem('duiwei-name', name); homeName = name;
    saveRoom(result.roomId, result.token); joinedOnThisConnection = true; roomState = result.state || roomState;
    homeError = ''; if (roomState) renderGame(); showToast('房间创建成功，复制链接邀请好友吧 💌');
  });
}
function namesOf(state) { return [0, 1].map(i => state.players[i]?.name || (i === 0 ? '玩家A' : '玩家B')); }
function moodFor(state, index) {
  if (state.outcome === 'tie' && state.phase === 'finished') return 'tie';
  if (state.phase === 'finished') return index === state.winner ? 'win' : 'sad';
  if (['normal_finished', 'dignity_offer'].includes(state.phase)) return index === state.normalWinner ? 'win' : 'sad';
  if (state.turnIndex === index && ['playing', 'dignity'].includes(state.phase)) return 'expect';
  if (['waiting', 'setup'].includes(state.phase)) return 'cheer';
  return 'default';
}
function reconnectSeconds(player) {
  if (!player || player.online) return 120;
  const left = reconnectEndsAt[player.index] ? Math.max(0, reconnectEndsAt[player.index] - Date.now()) : (player.reconnectRemainingMs || 120000);
  return Math.ceil(left / 1000);
}
function statusCopy(state) {
  const names = namesOf(state), copies = {
    waiting: ['等待好友加入', '复制房间链接发给好友，满 2 人即可开始。'],
    setup: [state.mode ? `${state.mode} 位模式 · 设置密码` : '准备开始', state.mode ? '双方各自设置并锁定密码，密码不会发送给对手。' : '房主先选择本局位数模式。'],
    dice: ['密码已就位 · 掷骰决定先手', '双方各掷一次骰子，点数大的一方先猜。'],
    playing: [`轮到 ${names[state.turnIndex] || '玩家'} 猜数字`, '输入完整数字，看看有几位数字和位置都猜对了。'],
    normal_finished: [`${names[state.normalWinner] || '玩家'} 赢得本局`, '败方可以申请尊严之战，也可以直接公布密码。'],
    dignity_offer: ['尊严之战邀请中', '获胜方可选择同意或拒绝，等待超过 25 秒将按拒绝处理。'],
    dignity: ['尊严之战 · 最后机会', '只有败方可猜两次，猜中全部位置即可争取平局。'],
    finished: [state.outcome === 'tie' ? '这一局是平局！' : `${names[state.winner] || '玩家'} 获胜！`, '本局数字已公开，看看战绩，再来一局吧。'],
  };
  const [title, desc] = copies[state.phase] || ['对局进行中', '粉团子陪你猜。'];
  if (!state.onlineCount && state.players.filter(Boolean).length < 2) return [title, '等待第二位玩家加入。'];
  if (state.paused && state.players.filter(Boolean).length === 2) return [title, `对手掉线了，等待重连（${reconnectSeconds(state.players[1 - state.selfIndex])} 秒）…`];
  return [title, desc];
}
function renderSecretForm(state, player) {
  if (player?.locked) return '<div class="secret-locked"><span>•••••</span><b>已锁定 ✓</b></div>';
  const n = state.mode || 3;
  return `<form class="inline-form secret-form" data-form="secret"><label class="form-caption" for="secret-input">设置你的 ${n} 位密码</label><div class="input-action-row"><input class="digit-input" id="secret-input" name="secret" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="${n}" autocomplete="new-password" placeholder="${'·'.repeat(n)}" required><button class="btn btn-primary" type="submit">锁定</button></div><small class="form-hint">允许重复数字，也可以 0 开头</small><p class="inline-error" id="secret-error"></p></form>`;
}
function renderPlayerColumn(state, index) {
  const player = state.players[index], name = player?.name || (index ? '等待玩家' : '玩家A');
  const history = state.history.filter(item => item.playerIndex === index), recent = history.at(-1);
  const score = state.scores[index] || 0, rival = state.scores[1 - index] || 0;
  const isSelf = state.selfIndex === index, isTurn = state.turnIndex === index && ['playing', 'dignity'].includes(state.phase);
  const recentText = recent ? `${recent.guess} → 猜对 ${recent.hits} 个` : '还没有猜测记录';
  return `<div class="player-column ${isTurn ? 'is-active-turn' : ''}"><section class="player-card card ${isSelf ? 'is-self' : ''}"><div class="player-top"><div class="avatar">${mascot(moodFor(state, index), 44)}</div><div class="player-identity"><div class="name-line"><strong>${escapeHtml(name)}</strong>${isSelf ? '<span class="you-tag">你</span>' : ''}</div><div class="online-state ${player?.online ? 'online' : 'offline'}"><i></i>${player ? (player.online ? '在线' : '重连中') : '等待加入'}</div></div><div class="score-badge"><b>${score}</b><small>胜场</small></div></div><div class="player-tags"><span class="soft-tag">${index === 0 ? 'A 位 · 房主' : 'B 位'}</span>${score - rival >= 3 ? '<span class="genius-tag">🏅 小天才</span>' : ''}${player?.locked && state.phase === 'setup' ? '<span class="locked-tag">密码已锁定 ✓</span>' : ''}</div><div class="player-state">${isTurn ? '<span class="turn-dot"></span>正在思考…' : (player?.locked && state.phase === 'setup' ? '密码已锁定 · •••••' : (player ? '准备就绪' : '把房间链接分享给好友吧'))}</div>${isSelf && state.phase === 'setup' && state.mode && state.players.filter(Boolean).length === 2 ? renderSecretForm(state, player) : ''}${state.phase === 'dice' ? `<div class="dice-readout ${player?.dice != null ? 'has-dice' : ''}"><span>🎲</span>${player?.dice ?? '—'}</div>` : ''}</section><section class="history-card card"><div class="history-head"><h3>✦ 战绩</h3><span class="history-count">${history.length} 次</span></div><p class="recent-line"><b>最近：</b>${escapeHtml(recentText)}</p><div class="history-list">${history.length ? history.slice().reverse().map(item => `<div class="history-item ${item.hits === state.mode ? 'all-hit' : ''}"><code>${escapeHtml(item.guess)}</code><span class="history-kind">${item.kind === 'dignity' ? '尊严' : ''}</span><span class="hit-count">${item.hits === state.mode ? '全中 🎉' : `命中 ${item.hits}`}</span></div>`).join('') : '<div class="history-empty">还没有记录，等你来猜～</div>'}</div></section></div>`;
}
function renderModeChooser(state) {
  if (!state.isHost) return `<div class="mode-readonly">等待房主选择模式 <b>${state.mode ? `· 当前 ${state.mode} 位` : ''}</b></div>`;
  return `<div class="mode-options">${[3, 4, 5].map(n => `<button class="mode-option ${state.mode === n ? 'selected' : ''}" data-action="mode" data-mode="${n}" ${state.phase !== 'setup' || state.onlineCount !== 2 ? 'disabled' : ''}><strong>${n} 位</strong><small>${n === 5 ? '困难挑战' : n === 4 ? '经典进阶' : '轻松入门'}</small></button>`).join('')}</div>`;
}
function renderStage(state) {
  const names = namesOf(state), together = state.players.filter(Boolean).length === 2;
  if (state.phase === 'waiting') return `<section class="stage-card card"><div class="stage-mascot">${mascot('expect', 76)}</div><div><h2>房间准备就绪</h2><p>把 6 位房间码分享给好友，等 TA 加入后就能开始啦。</p><button class="btn btn-primary" data-action="copy">复制邀请链接</button></div></section>`;
  if (state.phase === 'setup') return `<section class="stage-card card"><div class="stage-heading"><span class="step-pill">01 · 开始准备</span><h2>选择位数，设置秘密数字</h2><p>只有房主能切换模式；切换后双方需要重新锁定密码。</p></div>${renderModeChooser(state)}${!together || state.onlineCount < 2 ? '<div class="wait-note">⏳ 等待双方在线后设置密码</div>' : ''}</section>`;
  if (state.phase === 'dice') return `<section class="stage-card card dice-stage"><span class="step-pill">02 · 决定先手</span><h2>${state.diceTie ? '点数相同，再来一次～' : '掷骰子决定谁先猜'}</h2><p>双方各掷一次，点数较大的一方先手。</p><div class="dice-row">${state.players.map((p, i) => `<div class="dice-player ${p?.dice != null ? 'rolled' : ''}"><span>${escapeHtml(names[i])}</span><b>${p?.dice ?? '⚄'}</b>${p?.dice != null ? '<small>已掷出</small>' : ''}</div>`).join('')}</div><button class="btn btn-primary" data-action="roll" ${state.players[state.selfIndex]?.dice != null || state.paused ? 'disabled' : ''}>🎲 ${state.players[state.selfIndex]?.dice != null ? '等待对手掷骰' : '掷骰子'}</button></section>`;
  if (['playing', 'dignity'].includes(state.phase)) {
    const mine = state.turnIndex === state.selfIndex, n = state.mode;
    return `<section class="stage-card card live-stage"><div class="stage-heading"><span class="step-pill">${state.phase === 'dignity' ? '⚔️ 尊严之战' : '03 · 轮流猜测'}</span><h2>${mine ? '轮到你猜啦！' : `等待 ${escapeHtml(names[state.turnIndex] || '对手')} 猜测`}</h2><p>${state.phase === 'dignity' ? `败方还有 ${Math.max(0, 2 - state.dignityAttempts)} 次机会，猜中即可扳平。` : '猜测对方设置的秘密数字，只会告诉你有几位正确。'}</p></div><div class="guess-area">${mine ? `<form class="inline-form guess-form" data-form="guess"><label for="guess-input">输入 ${n} 位数字</label><div class="input-action-row"><input class="digit-input guess-input" id="guess-input" name="guess" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="${n}" autocomplete="off" placeholder="${'0'.repeat(n)}" required ${busyGuess ? 'disabled' : ''}><button class="btn btn-primary" type="submit" ${busyGuess ? 'disabled' : ''}>${busyGuess ? '提交中…' : '提交猜测'}</button></div><p class="inline-error" id="guess-error"></p></form>` : `<div class="waiting-turn">${mascot('expect', 44)}<span>粉团子陪你一起等～</span></div>`}</div></section>`;
  }
  if (state.phase === 'normal_finished') {
    const loser = state.selfIndex === state.normalLoser;
    return `<section class="stage-card card result-pending"><div class="stage-mascot">${mascot('win', 78)}</div><div><span class="step-pill">本局结束</span><h2>${escapeHtml(names[state.normalWinner])} 赢得本局</h2><p>${state.finishReason === 'timeout' ? '对手超时，本局判定弃权。' : '败方可发起尊严之战，胜方同意后还可猜两次。'}</p><div class="stage-actions">${loser ? '<button class="btn btn-secondary" data-action="decline-dignity">直接结束</button><button class="btn btn-primary" data-action="offer-dignity">⚔️ 发起尊严之战</button>' : '<span class="wait-note">等待败方选择，或公布双方数字</span>'}<button class="btn btn-secondary" data-action="publish">公布双方数字</button></div></div></section>`;
  }
  if (state.phase === 'dignity_offer') return `<section class="stage-card card"><div class="stage-mascot">${mascot('expect', 76)}</div><div><span class="step-pill">⚔️ 尊严之战协商</span><h2>${state.selfIndex === state.normalWinner ? `${escapeHtml(names[state.offerBy])} 发起了尊严之战` : '尊严之战请求已发送'}</h2><p>${state.selfIndex === state.normalWinner ? '同意后败方可以再猜两次，也可以拒绝并维持原结果。' : '等待获胜方回应，超时后将按拒绝处理。'}</p>${state.selfIndex === state.normalWinner ? '<div class="stage-actions"><button class="btn btn-secondary" data-action="dignity-reject">拒绝</button><button class="btn btn-primary" data-action="dignity-accept">同意再猜</button></div>' : '<div class="offer-clock">剩余 <strong id="offer-countdown">25</strong> 秒</div>'}</div></section>`;
  if (state.phase === 'finished') return renderSettlement(state);
  return '';
}
function finishReasonLabel(state) {
  return ({ guess: '常规猜测全部命中', timeout: '回合超时，判定弃权', published: '双方主动公布密码', dignity_declined: '尊严之战未进行', dignity_offer_timeout: '尊严之战邀请超时', dignity_tie: '尊严之战猜中，扳为平局', dignity_failed: '尊严之战未能猜中', dignity_timeout: '尊严之战超时' })[state.finishReason] || '对局结束';
}
function renderSettlement(state) {
  const names = namesOf(state), counts = [0, 1].map(i => state.history.filter(x => x.playerIndex === i).length);
  const result = state.outcome === 'tie' ? '平局！' : `${names[state.winner] || '玩家'} 获胜！`;
  return `<section class="settlement-card card"><div class="settlement-mascot">${mascot(state.outcome === 'tie' ? 'tie' : 'win', 92)}</div><span class="step-pill">本局结算</span><h2>${escapeHtml(result)}</h2><p class="settlement-reason">${escapeHtml(finishReasonLabel(state))}</p><div class="secret-reveal">${state.players.map((p, i) => `<div><span>${escapeHtml(names[i])} 的密码</span><code>${escapeHtml(state.publicSecrets?.[i] || '—')}</code></div>`).join('')}</div><div class="match-stats"><div><span>累计比分</span><strong>${state.scores[0]} : ${state.scores[1]}</strong><small>${escapeHtml(names[0])} · ${escapeHtml(names[1])}</small></div>${state.players.map((p, i) => `<div><span>${escapeHtml(names[i])} 本局猜测</span><strong>${counts[i]} 次</strong><small>${state.history.filter(x => x.playerIndex === i && x.kind === 'dignity').length} 次尊严之战</small></div>`).join('')}</div><div class="settlement-actions"><button class="btn btn-primary" data-action="rematch" ${state.paused || state.players[state.selfIndex]?.rematch ? 'disabled' : ''}>🔄 ${state.players[state.selfIndex]?.rematch ? '已准备，等待好友' : '再来一局'}</button><button class="btn btn-secondary" data-action="save-card">📸 保存战绩卡</button><button class="btn btn-secondary" data-action="share-card">📤 分享战绩卡</button><button class="text-button" data-action="leave">返回首页</button></div><canvas id="result-canvas" width="1000" height="1280" class="share-canvas" aria-hidden="true"></canvas></section>`;
}
function renderGame() {
  if (!roomState) return renderHome();
  const s = roomState, [title, desc] = statusCopy(s);
  app.innerHTML = `<div class="game-wrap"><section class="game-head card"><div class="room-meta"><div class="room-symbol">💌</div><div><span class="room-label">房间码</span><strong class="room-code">${escapeHtml(s.roomId)}</strong></div><span class="host-pill">${s.isHost ? '你是房主' : '双人房间'}</span></div><div class="head-actions"><button class="tiny-button" data-action="copy">复制链接</button><button class="tiny-button" data-action="rules">❔ 规则</button><button class="tiny-button sound-toggle" data-action="sound">${soundMuted ? '🔇 静音' : '🔊 音效'}</button><button class="tiny-button leave-button" data-action="leave">离开</button></div></section>${s.paused ? `<div class="reconnect-banner">🔴 对手掉线，等待重连（<b id="reconnect-countdown">${reconnectSeconds(s.players[1 - s.selfIndex])}</b> 秒）<span>回来后本局会继续</span></div>` : ''}<section class="status-banner card"><div><span class="status-kicker">${['playing', 'dignity'].includes(s.phase) ? '现在进行中' : '对局状态'}</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(desc)}</p></div>${['playing', 'dignity'].includes(s.phase) ? '<div class="timer-ring" id="timer-ring"><span id="turn-timer-value">60</span><small>秒</small></div>' : `<div class="status-mascot">${mascot(s.phase === 'finished' && s.outcome === 'tie' ? 'tie' : 'default', 48)}</div>`}</section>${s.notice ? `<div class="notice-line" role="status">${escapeHtml(s.notice)}</div>` : ''}<section class="duo-grid">${renderPlayerColumn(s, 0)}${renderPlayerColumn(s, 1)}</section>${renderStage(s)}<section class="emote-card card"><div><strong>发个表情</strong><small>轻轻互动，不打断对局</small></div><div class="emote-buttons">${Object.entries(EMOTES).map(([name, emoji]) => `<button class="emote-button" data-action="emote" data-emote="${name}" aria-label="发送${name}"><span>${emoji}</span><small>${name}</small></button>`).join('')}</div></section><footer class="game-footer"><span>只计算数字与位置同时正确的命中数</span><button class="text-button" data-action="rules">查看规则</button></footer></div>`;
  if (['playing', 'dignity'].includes(s.phase)) { pausedRemaining = s.turnRemainingMs ?? 60000; isTurnPaused = Boolean(s.paused); turnEndsAt = Date.now() + pausedRemaining; }
  s.players.forEach(p => { if (p && !p.online && p.reconnectRemainingMs != null) reconnectEndsAt[p.index] = Date.now() + p.reconnectRemainingMs; });
  updateClocks(); maybeShowRules(s); maybeShowDignityPrompt(s); playStateSounds(previousState, s);
  if (s.emote?.id && s.emote.id !== lastEmoteId) { lastEmoteId = s.emote.id; showFloatingEmote(s.emote); }
  if (s.captionId && s.captionId !== lastCaptionId) { lastCaptionId = s.captionId; showCaption(s.caption); }
  previousState = s;
}
function showCaption(message) {
  if (!message) return;
  captionNode.textContent = message; captionNode.classList.add('show'); clearTimeout(captionTimer);
  captionTimer = setTimeout(() => captionNode.classList.remove('show'), 2600);
}
function showFloatingEmote(emote) {
  const node = document.createElement('div'); node.className = `float-emote ${emote.playerIndex === 0 ? 'left' : 'right'}`;
  node.innerHTML = `<span>${EMOTES[emote.text] || '✨'}</span><small>${escapeHtml(emote.name)} · ${escapeHtml(emote.text)}</small>`;
  document.body.append(node); setTimeout(() => node.remove(), 1900);
}
function maybeShowRules(s) {
  if (s.phase !== 'setup' || s.players.filter(Boolean).length < 2 || s.onlineCount < 2) return;
  const key = `duiwei-rules-seen:${s.roomId}`; if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, '1'); showRulesModal();
}
function showRulesModal() {
  openModal(`<section class="rules-modal card"><div class="rules-title">${mascot('expect', 62)}<div><span class="step-pill">开局前看一眼</span><h2>对局规则</h2></div></div><ol><li>双方各自设置并锁定秘密数字，房主选择 3、4 或 5 位模式。</li><li>双方掷骰决定先手，然后轮流猜对方的数字。</li><li>只提示数字和位置都正确的个数，不提示数字是否在其他位置。</li><li>每回合限时 60 秒；超时判当前玩家弃权。掉线后可等待重连 120 秒。</li><li>常规胜方计 1 胜；败方可以申请尊严之战，额外猜两次，猜中即可扳平。</li></ol><button class="btn btn-primary btn-wide" data-action="close-modal">知道了，开始准备</button></section>`, true);
}
function openModal(content, dismissible = false) {
  modalRoot.innerHTML = `<div class="modal-backdrop" ${dismissible ? 'data-action="backdrop-close"' : ''}><div class="modal-content" role="dialog" aria-modal="true">${content}</div></div>`;
}
function closeModal() { modalRoot.innerHTML = ''; }
function maybeShowDignityPrompt(s) {
  if (s.phase !== 'dignity_offer' || s.selfIndex !== s.normalWinner) { if (s.phase !== 'dignity_offer') lastDignityPrompt = ''; return; }
  const key = `${s.roomId}:${s.offerBy}`; if (lastDignityPrompt === key) return; lastDignityPrompt = key;
  const names = namesOf(s);
  openModal(`<section class="confirm-modal card"><div class="modal-mascot">${mascot('expect', 82)}</div><span class="step-pill">⚔️ 尊严之战邀请</span><h2>${escapeHtml(names[s.offerBy])} 想发起尊严之战</h2><p>同意后，败方可以再猜两次；猜中即可争取平局。</p><p class="offer-clock">请在 <b id="offer-countdown">25</b> 秒内回应</p><div class="stage-actions"><button class="btn btn-secondary" data-action="dignity-reject">拒绝</button><button class="btn btn-primary" data-action="dignity-accept">同意</button></div></section>`, false);
}
function updateClocks() {
  if (!roomState) return;
  const value = document.getElementById('turn-timer-value'), ring = document.getElementById('timer-ring');
  if (value && ['playing', 'dignity'].includes(roomState.phase)) {
    const ms = isTurnPaused ? pausedRemaining : Math.max(0, turnEndsAt - Date.now()), secs = Math.ceil(ms / 1000);
    value.textContent = String(secs); ring.classList.toggle('is-urgent', secs <= 10);
    ring.style.setProperty('--timer-progress', `${Math.max(0, Math.min(100, ms / 60000 * 100))}%`);
  }
  const reconnect = document.getElementById('reconnect-countdown');
  if (reconnect) reconnect.textContent = String(reconnectSeconds(roomState.players[1 - roomState.selfIndex]));
  const offer = document.getElementById('offer-countdown');
  if (offer && roomState.offerDeadline) offer.textContent = String(Math.max(0, Math.ceil((roomState.offerDeadline - Date.now()) / 1000)));
}
function playTone(frequencies, duration = .12, type = 'sine') {
  if (soundMuted) return;
  try {
    const Context = window.AudioContext || window.webkitAudioContext; if (!Context) return;
    audioContext ||= new Context(); if (audioContext.state === 'suspended') audioContext.resume();
    let offset = 0;
    frequencies.forEach(f => {
      const osc = audioContext.createOscillator(), gain = audioContext.createGain(); osc.type = type; osc.frequency.value = f;
      gain.gain.setValueAtTime(.0001, audioContext.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(.055, audioContext.currentTime + offset + .015);
      gain.gain.exponentialRampToValueAtTime(.0001, audioContext.currentTime + offset + duration);
      osc.connect(gain).connect(audioContext.destination); osc.start(audioContext.currentTime + offset); osc.stop(audioContext.currentTime + offset + duration + .02); offset += duration * .72;
    });
  } catch { /* optional audio */ }
}
function playStateSounds(prev, next) {
  if (!prev) return;
  if (next.phase === 'finished' && prev.phase !== 'finished') {
    playTone(next.outcome === 'tie' ? [660, 660] : (next.winner === next.selfIndex ? [523, 659, 784] : [392, 330]), .17, 'triangle'); return;
  }
  if (next.history.length > prev.history.length) {
    const item = next.history[next.history.length - 1]; playTone(item.hits === next.mode ? [660, 880, 1046] : (item.hits ? [660, 820] : [440]), .11);
  } else if (next.players.some((p, i) => p?.dice !== prev.players?.[i]?.dice && p?.dice != null)) playTone([320, 460], .08, 'square');
}
function handleAction(action, button) {
  if (action === 'rules') return showRulesModal();
  if (action === 'close-modal') return closeModal();
  if (action === 'copy') return copyRoomLink();
  if (action === 'sound') {
    soundMuted = !soundMuted; localStorage.setItem(SOUND_KEY, soundMuted ? '1' : '0');
    if (roomState) renderGame(); else renderHome(); showToast(soundMuted ? '音效已关闭' : '音效已开启'); return;
  }
  if (action === 'create') {
    const name = document.getElementById('nickname')?.value || ''; if (!validName(name)) return updateHomeJoinPrompt();
    homeName = name; createRoom(name); return;
  }
  if (action === 'join') {
    const name = document.getElementById('nickname')?.value || '';
    const code = (document.getElementById('room-code-input')?.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (!validName(name)) return updateHomeJoinPrompt();
    if (code.length !== 6) { homeError = '房间码需要是 6 位字母或数字。'; renderHome(); return; }
    if (linkNameRequired && !name) return showToast('先取个名字再点加入', true);
    homeName = name; homeRoomCode = code; if (name) localStorage.setItem('duiwei-name', name);
    linkNameRequired = false; playerToken = localStorage.getItem(`duiwei-token:${code}`) || ''; activeRoomId = code; requestRoomJoin(code); return;
  }
  if (action === 'mode') return emit('mode:set', { mode: Number(button.dataset.mode) });
  if (action === 'roll') { playTone([260, 390, 540], .07, 'square'); return emit('dice:roll'); }
  if (action === 'offer-dignity') return emit('dignity:offer');
  if (action === 'decline-dignity') return emit('match:decline');
  if (action === 'dignity-accept') return emit('dignity:respond', { accept: true }, r => { if (r) closeModal(); });
  if (action === 'dignity-reject') return emit('dignity:respond', { accept: false }, r => { if (r) closeModal(); });
  if (action === 'publish') return emit('match:publish');
  if (action === 'rematch') return emit('match:rematch');
  if (action === 'emote') return emit('room:emote', { emote: button.dataset.emote });
  if (action === 'save-card') return saveResultCard(false);
  if (action === 'share-card') return saveResultCard(true);
  if (action === 'leave') return leaveRoom();
}
async function leaveRoom() {
  if (!activeRoomId) { roomState = null; renderHome(); return; }
  const id = activeRoomId;
  if (roomState && !['waiting', 'finished'].includes(roomState.phase) && !window.confirm('现在离开会结束当前房间的对局，确定离开吗？')) return;
  socket.emit('room:leave', {}, () => {}); localStorage.removeItem(`duiwei-token:${id}`);
  roomState = null; previousState = null; joinedOnThisConnection = false; closeModal(); clearRoomUrl(); homeError = ''; linkNameRequired = false; renderHome(); showToast('已返回首页');
}
function showInlineError(id, message) {
  const node = document.getElementById(id); if (!node) return showToast(message, true);
  node.textContent = message; const form = node.closest('form'); form?.classList.remove('shake');
  if (form) { void form.offsetWidth; form.classList.add('shake'); }
}
function handleSubmit(event) {
  const form = event.target.closest('form[data-form]'); if (!form) return; event.preventDefault();
  if (form.dataset.form === 'secret') {
    const secret = form.elements.secret.value, mode = roomState?.mode;
    if (!new RegExp(`^\\d{${mode}}$`).test(secret)) return showInlineError('secret-error', `请输入完整的 ${mode} 位数字`);
    emit('secret:set', { secret }, r => { if (r) showToast('密码已锁定，只有你自己知道'); });
  } else if (form.dataset.form === 'guess') {
    if (busyGuess) return;
    const guess = form.elements.guess.value, mode = roomState?.mode;
    if (!new RegExp(`^\\d{${mode}}$`).test(guess)) return showInlineError('guess-error', `请输入完整的 ${mode} 位数字`);
    busyGuess = true;
    const dignity = roomState.phase === 'dignity';
    emit(dignity ? 'dignity:submit' : 'guess:submit', dignity ? { guess, requestId: crypto.randomUUID() } : { guess }, result => {
      busyGuess = false; if (roomState) renderGame(); if (result?.message) showToast(result.message);
    });
  }
}
function handleInput(event) {
  const input = event.target;
  if (input.id === 'nickname') { homeName = input.value; updateHomeJoinPrompt(); }
  if (input.id === 'room-code-input') { const p = input.selectionStart; input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); try { input.setSelectionRange(p, p); } catch {} }
  if (input.classList.contains('digit-input')) input.value = input.value.replace(/\D/g, '').slice(0, input.maxLength || 5);
}
function drawCanvasMascot(ctx, x, y, r, mood) {
  const grad = ctx.createLinearGradient(x - r, y - r, x + r, y + r); grad.addColorStop(0, '#ffc6db'); grad.addColorStop(1, '#f47aa5');
  ctx.fillStyle = '#f69abb'; ctx.beginPath(); ctx.ellipse(x-r*.68,y-r*.45,r*.23,r*.31,-.25,0,Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.ellipse(x+r*.68,y-r*.45,r*.23,r*.31,.25,0,Math.PI*2); ctx.fill();
  ctx.fillStyle = grad; ctx.strokeStyle = '#ed6f9c'; ctx.lineWidth = 4; ctx.beginPath(); ctx.ellipse(x,y,r,r*.88,0,0,Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#ff8cae'; [-1,1].forEach(side=>{ctx.beginPath();ctx.ellipse(x+side*r*.52,y+r*.18,r*.16,r*.09,0,0,Math.PI*2);ctx.fill();});
  if (mood === 'win' || mood === 'expect') { ctx.strokeStyle='#75495a';ctx.lineWidth=5;[-1,1].forEach(side=>{ctx.beginPath();ctx.arc(x+side*r*.31,y-r*.08,r*.09,Math.PI,0);ctx.stroke();}); }
  else { ctx.fillStyle='#75495a';[-1,1].forEach(side=>{ctx.beginPath();ctx.arc(x+side*r*.31,y-r*.1,r*.055,0,Math.PI*2);ctx.fill();}); }
  ctx.strokeStyle='#75495a';ctx.lineWidth=5;ctx.lineCap='round';ctx.beginPath();
  if(mood==='sad')ctx.arc(x,y+r*.39,r*.17,Math.PI*1.15,Math.PI*1.85);else if(mood==='win')ctx.arc(x,y+r*.1,r*.25,0,Math.PI);else ctx.arc(x,y+r*.28,r*.15,.1,Math.PI-.1);ctx.stroke();
  if(mood==='tie'){ctx.font=`${r*.45}px sans-serif`;ctx.fillStyle='#ff628e';ctx.fillText('♥',x-r*.18,y+r*.8);} if(mood==='sad'){ctx.fillStyle='#78c8ed';ctx.beginPath();ctx.ellipse(x-r*.31,y+r*.2,r*.05,r*.1,0,0,Math.PI*2);ctx.fill();}
}
function roundedRect(ctx,x,y,w,h,r){ctx.beginPath();ctx.roundRect(x,y,w,h,r);}
function makeResultCard() {
  const canvas=document.getElementById('result-canvas');if(!canvas||!roomState)return null;
  const ctx=canvas.getContext('2d'),s=roomState,names=namesOf(s),bg=ctx.createLinearGradient(0,0,1000,1280);
  bg.addColorStop(0,'#ffe5ef');bg.addColorStop(.55,'#fff6fa');bg.addColorStop(1,'#ffdce9');ctx.fillStyle=bg;ctx.fillRect(0,0,1000,1280);
  ctx.fillStyle='#fff';ctx.strokeStyle='#ffeaf2';ctx.lineWidth=5;roundedRect(ctx,58,54,884,1170,48);ctx.fill();ctx.stroke();
  ctx.textAlign='center';ctx.fillStyle='#d85382';ctx.font='bold 34px system-ui,sans-serif';ctx.fillText('对位猜数字 · 双人在线对战',500,132);
  drawCanvasMascot(ctx,500,350,126,s.outcome==='tie'?'tie':'win');ctx.fillStyle='#4a3b42';ctx.font='bold 66px system-ui,sans-serif';ctx.fillText(s.outcome==='tie'?'平局！':`${names[s.winner]} 获胜！`,500,555);
  ctx.fillStyle='#a08d96';ctx.font='28px system-ui,sans-serif';ctx.fillText(`房间 ${s.roomId} · ${s.mode} 位模式`,500,606);
  ctx.fillStyle='#fff0f6';ctx.strokeStyle='#ffd6e4';ctx.lineWidth=3;roundedRect(ctx,120,660,760,138,26);ctx.fill();ctx.stroke();
  ctx.fillStyle='#d85382';ctx.font='bold 32px system-ui,sans-serif';ctx.fillText(`累计比分  ${s.scores[0]} : ${s.scores[1]}`,500,716);ctx.fillStyle='#826b75';ctx.font='24px system-ui,sans-serif';ctx.fillText(`${names[0]} · ${names[1]}`,500,764);
  s.players.forEach((p,i)=>{const x=i?700:300;ctx.fillStyle='#fff8fb';ctx.strokeStyle='#ffeaf2';ctx.lineWidth=3;roundedRect(ctx,x-175,838,350,236,24);ctx.fill();ctx.stroke();ctx.fillStyle='#d85382';ctx.font='bold 27px system-ui,sans-serif';ctx.fillText(names[i],x,888);ctx.fillStyle='#4a3b42';ctx.font='bold 40px ui-monospace,monospace';ctx.fillText(`密码 ${s.publicSecrets?.[i]||'—'}`,x,953);const count=s.history.filter(item=>item.playerIndex===i).length;ctx.fillStyle='#826b75';ctx.font='23px system-ui,sans-serif';ctx.fillText(`${count} 次猜测 · ${s.scores[i]} 胜`,x,1018);});
  ctx.fillStyle='#a08d96';ctx.font='22px system-ui,sans-serif';ctx.fillText('粉团子陪你猜 · 邀请好友再战一局',500,1150);return canvas;
}
async function saveResultCard(share) {
  const canvas=makeResultCard();if(!canvas)return showToast('战绩卡暂时无法生成',true);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)return showToast('生成图片失败，请重试',true);
  if(share&&navigator.canShare&&navigator.share){const file=new File([blob],'对位猜数字-战绩卡.png',{type:'image/png'});try{if(navigator.canShare({files:[file]})){await navigator.share({files:[file],title:'对位猜数字战绩卡',text:'来和我再战一局吧！'});return;}}catch(e){if(e?.name==='AbortError')return;}}
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='对位猜数字-战绩卡.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);showToast('战绩卡 PNG 已保存到设备');
}
app.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(!button)return;if(button.dataset.action==='backdrop-close'){if(event.target===button)closeModal();return;}handleAction(button.dataset.action,button);});
app.addEventListener('submit',handleSubmit);app.addEventListener('input',event=>{
  const i=event.target;if(i.id==='nickname'){homeName=i.value;updateHomeJoinPrompt();}
  if(i.id==='room-code-input'){const p=i.selectionStart;i.value=i.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);try{i.setSelectionRange(p,p);}catch{}}
  if(i.classList.contains('digit-input'))i.value=i.value.replace(/\D/g,'').slice(0,i.maxLength||5);
});
modalRoot.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(!button)return;if(button.dataset.action==='backdrop-close'){if(event.target===button)closeModal();return;}handleAction(button.dataset.action,button);});
document.getElementById('header-rules')?.addEventListener('click',showRulesModal);
document.getElementById('header-sound')?.addEventListener('click',()=>{soundMuted=!soundMuted;localStorage.setItem(SOUND_KEY,soundMuted?'1':'0');const b=document.getElementById('header-sound');if(b)b.textContent=soundMuted?'🔇':'🔊';if(roomState)renderGame();showToast(soundMuted?'音效已关闭':'音效已开启');});
socket.on('connect',()=>{setNetwork('在线','online');if(activeRoomId&&playerToken&&!joinedOnThisConnection)requestRoomJoin(activeRoomId);else if(!roomState)renderHome();});
socket.on('disconnect',()=>{joinedOnThisConnection=false;setNetwork('正在重连','offline');});socket.on('connect_error',()=>setNetwork('连接失败','offline'));
socket.on('room:state',s=>{
  if(activeRoomId&&s.roomId!==activeRoomId)return;if(!activeRoomId)activeRoomId=s.roomId;roomState=s;joinedOnThisConnection=true;
  const self=s.players[s.selfIndex];if(self?.name){homeName=self.name;localStorage.setItem('duiwei-name',self.name);}
  if(!playerToken)playerToken=localStorage.getItem(`duiwei-token:${s.roomId}`)||'';renderGame();
});
renderHome();if(soundMuted){const b=document.getElementById('header-sound');if(b)b.textContent='🔇';}
setNetwork(socket.connected?'在线':'连接中',socket.connected?'online':'connecting');setInterval(updateClocks,250);
