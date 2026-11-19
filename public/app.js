const app = document.getElementById('app');
const networkPill = document.getElementById('network-status');
const networkLabel = document.getElementById('network-label');
const toastNode = document.getElementById('toast');
const socket = io({ autoConnect: true, reconnection: true, reconnectionAttempts: Infinity });

let roomState = null;
let activeRoomId = '';
let playerToken = '';
let toastTimer = null;
let toastError = false;
let pendingRoll = false;
let rollTimer = null;
let joining = false;
let homeError = '';
let lastNoticeId = '';

const params = new URLSearchParams(location.search);
const requestedRoom = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
if (requestedRoom) {
  activeRoomId = requestedRoom;
  playerToken = localStorage.getItem(`duiwei-token:${requestedRoom}`) || '';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function showToast(message, error = false) {
  toastNode.textContent = message;
  toastNode.classList.toggle('error', error);
  toastNode.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove('show'), 2500);
}

function setNetwork(state) {
  networkPill.classList.toggle('online', state === 'online');
  networkPill.classList.toggle('offline', state === 'offline');
  networkLabel.textContent = state === 'online' ? '在线' : state === 'offline' ? '正在重连' : '正在连接';
}

function saveRoom(roomId, token) {
  activeRoomId = roomId;
  playerToken = token;
  localStorage.setItem(`duiwei-token:${roomId}`, token);
  const url = new URL(location.href);
  url.searchParams.set('room', roomId);
  history.replaceState({}, '', url);
}

function clearRoomUrl() {
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState({}, '', url);
}

function requestRoomJoin(roomId) {
  if (!roomId || joining || !socket.connected) return;
  joining = true;
  app.innerHTML = '<section class="loading-view"><div class="loader"></div><p>正在进入房间…</p></section>';
  socket.emit('room:join', {
    roomId,
    token: playerToken || localStorage.getItem(`duiwei-token:${roomId}`) || '',
    name: localStorage.getItem('duiwei-name') || '',
  }, (result) => {
    joining = false;
    if (!result?.ok) {
      const reason = result?.error === 'full' ? '这个房间已经坐满啦（最多 2 人）' : '没有找到这个房间，请检查房间码或让好友重新创建。';
      activeRoomId = '';
      roomState = null;
      clearRoomUrl();
      homeError = reason;
      renderHome();
      showToast(result?.error === 'full' ? '房间已满' : '房间不存在', true);
      return;
    }
    saveRoom(result.roomId, result.token);
    roomState = result.state;
    homeError = '';
    renderGame();
  });
}

function createRoom(name) {
  if (!socket.connected) return showToast('网络连接中，请稍等片刻', true);
  socket.emit('room:create', { name }, (result) => {
    if (!result?.ok) return showToast('创建房间失败，请重试', true);
    if (name) localStorage.setItem('duiwei-name', name);
    saveRoom(result.roomId, result.token);
    roomState = result.state;
    homeError = '';
    renderGame();
    showToast('房间创建成功，分享链接邀请好友吧');
  });
}

function joinRoom(roomId, name) {
  const cleanId = String(roomId || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (cleanId.length !== 6) {
    homeError = '房间码需要是 6 位字母或数字。';
    renderHome();
    return;
  }
  if (!socket.connected) return showToast('网络连接中，请稍等片刻', true);
  if (name) localStorage.setItem('duiwei-name', name);
  activeRoomId = cleanId;
  playerToken = localStorage.getItem(`duiwei-token:${cleanId}`) || '';
  requestRoomJoin(cleanId);
}

async function copyRoomLink() {
  const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(activeRoomId)}`;
  try {
    await navigator.clipboard.writeText(link);
    showToast('链接已复制，发给好友吧');
  } catch {
    const input = document.createElement('textarea');
    input.value = link;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    showToast('链接已复制，发给好友吧');
  }
}

function getRoomLink() {
  return `${location.origin}${location.pathname}?room=${encodeURIComponent(activeRoomId)}`;
}

function renderHome() {
  app.innerHTML = `
    <section class="home-layout">
      <div class="hero-copy">
        <div class="eyebrow"><span class="eyebrow-mark"></span> FRIENDS · QUICK DUEL</div>
        <h1>猜中每一位，<br><span class="title-accent">赢下这一局。</span></h1>
        <p>设置你的三位数字密码，和好友轮流猜测。<br class="home-copy-break">位置全中，就能拿下胜利。</p>
        <div class="feature-row">
          <span class="feature"><span class="feature-icon">✦</span>无需注册</span>
          <span class="feature"><span class="feature-icon">⌁</span>好友实时联机</span>
          <span class="feature"><span class="feature-icon">◷</span>一局约 3 分钟</span>
        </div>
      </div>
      <div class="home-card">
        <h2 class="card-heading">开始一场对战</h2>
        <p class="card-subheading">创建房间，或加入好友的房间</p>
        <label class="field-label" for="nickname">你的昵称 <span style="font-weight:400;color:#a1adbc">· 可选</span></label>
        <input id="nickname" class="text-input" maxlength="16" placeholder="比如：小蓝" value="${escapeHtml(localStorage.getItem('duiwei-name') || '')}">
        <div style="height:13px"></div>
        <button class="primary-button full-width" id="create-room"><span class="button-icon">✦</span>创建新房间</button>
        <div class="divider">或者加入好友</div>
        <label class="field-label" for="room-code-input">输入 6 位房间码</label>
        <div class="join-row">
          <input id="room-code-input" class="text-input code-input" maxlength="6" autocomplete="off" placeholder="例如 K7S9P2">
          <button class="primary-button" id="join-room">加入房间</button>
        </div>
        <div class="error-line">${escapeHtml(homeError)}</div>
        <div class="rules-strip"><span class="rule-chip">3 位数字密码</span><span class="rule-chip">可重复 · 可 0 开头</span><span class="rule-chip">只计算对位命中</span></div>
      </div>
    </section>`;
  document.getElementById('create-room').addEventListener('click', () => {
    const name = document.getElementById('nickname').value.trim().slice(0, 16);
    createRoom(name);
  });
  document.getElementById('join-room').addEventListener('click', () => {
    const name = document.getElementById('nickname').value.trim().slice(0, 16);
    joinRoom(document.getElementById('room-code-input').value, name);
  });
  document.getElementById('room-code-input').addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  document.getElementById('room-code-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') document.getElementById('join-room').click();
  });
}

function phaseText(state) {
  if (state.paused) return ['对手暂时离线', '对局已暂停，正在为好友保留重连时间'];
  if (state.phase === 'waiting') return ['等待对手加入', '把房间链接发给好友，准备开始这场对决'];
  if (state.phase === 'setup') return ['设置秘密数字', '双方都锁定密码后，即可掷骰决定先手'];
  if (state.phase === 'dice') return ['掷骰决定先手', '两人各掷一次，点数较大的一方先猜'];
  if (state.phase === 'playing') {
    const turn = state.players[state.turnIndex]?.name || '玩家';
    return [state.turnIndex === state.selfIndex ? '轮到你猜了' : `等待 ${turn} 猜测`, state.turnIndex === state.selfIndex ? '输入你猜测的三位数，看看命中几个位置' : '对手正在思考，请稍候'];
  }
  if (state.phase === 'finished') return ['本局已结束', '再开一局，看看谁能先猜中'];
  return ['游戏进行中', ''];
}

function renderPlayerCard(player, state, index) {
  const isSelf = index === state.selfIndex;
  const active = state.phase === 'playing' && state.turnIndex === index && !state.paused;
  const displayName = player ? escapeHtml(player.name) : '等待对手';
  const label = player ? (isSelf ? '你' : '') : '';
  let sub;
  if (!player) sub = '分享房间码，邀请好友加入';
  else if (!player.online) sub = '断线 · 等待重新连接';
  else if (active) sub = '正在猜测';
  else if (state.phase === 'finished' && state.winner === index) sub = '本局获胜';
  else if (state.phase === 'playing') sub = '等待回合';
  else if (player.locked) sub = '密码已锁定';
  else sub = '已连接';
  let right;
  if (!player) right = '<span class="player-lock">空位</span>';
  else if (state.phase === 'dice') right = `<span class="player-lock">${player.dice ? `🎲 ${player.dice} 点` : '尚未掷骰'}</span>`;
  else if (state.phase === 'setup') right = `<span class="player-lock ${player.locked ? 'lock-ok' : ''}">${player.locked ? '✓ 已锁定' : '设置中'}</span>`;
  else if (state.phase === 'playing') right = `<span class="player-lock ${active ? 'lock-ok' : ''}">${active ? '● 当前回合' : '○ 等待中'}</span>`;
  else if (state.phase === 'finished' && player.rematch) right = '<span class="player-lock lock-ok">✓ 准备再来</span>';
  else right = `<span class="player-state"><i class="state-dot ${player.online ? '' : 'offline'}"></i>${player.online ? '在线' : '离线'}</span>`;
  const die = player?.dice ? ['⚀','⚁','⚂','⚃','⚄','⚅'][player.dice - 1] : '·';
  const dice = state.phase === 'dice' ? `<span class="die ${pendingRoll && isSelf ? 'rolling' : ''} ${player?.dice ? 'rolled' : ''}">${pendingRoll && isSelf ? '🎲' : die}</span>` : '';
  return `<article class="player-card ${active ? 'active' : ''}"><div class="player-row"><div class="avatar">${player ? (index === 0 ? 'A' : 'B') : '+'}</div><div style="min-width:0"><div class="player-name">${displayName}${label ? `<span class="player-you">${label}</span>` : ''}</div><div class="player-sub">${escapeHtml(sub)}</div></div>${dice}${right}</div></article>`;
}

function renderStage(state) {
  if (state.paused) {
    const disconnected = state.players.find((player) => player && !player.online);
    return `<section class="stage-card"><div class="paused-note"><span>◌</span><span><strong>${escapeHtml(disconnected?.name || '对手')}掉线了</strong><br>对局已暂停，等待对方重新连接。重连时间为 90 秒。</span></div></section>`;
  }
  if (state.phase === 'waiting') {
    return `<section class="stage-card"><h3 class="stage-heading"><span class="stage-heading-icon">⌁</span>房间已准备好</h3><p class="stage-copy">好友加入后，双方就可以分别设置秘密数字。房间会一直为你保留。</p><button class="secondary-button" data-action="copy"><span class="button-icon">↗</span>复制邀请链接</button></section>`;
  }
  if (state.phase === 'setup') {
    const self = state.players[state.selfIndex];
    const other = state.players[1 - state.selfIndex];
    if (!self) return '';
    if (self.locked) {
      return `<section class="stage-card"><h3 class="stage-heading"><span class="stage-heading-icon">▣</span>秘密数字已锁定</h3><p class="stage-copy">${other?.locked ? '双方都已准备，马上开始掷骰。' : `等待 ${escapeHtml(other?.name || '对手')} 锁定密码。`}</p><div class="locked-state"><div class="locked-message"><span class="checkmark">✓</span>密码已安全保存，不会显示给对手</div><button class="soft-button" data-action="unlock">修改密码</button></div></section>`;
    }
    return `<section class="stage-card"><h3 class="stage-heading"><span class="stage-heading-icon">▣</span>设置你的秘密数字</h3><p class="stage-copy">输入任意三位数字，可重复、可用 0 开头。锁定后对手无法看到。</p><form class="secret-form" id="secret-form"><div><label class="field-label" for="secret-input">秘密密码</label><input id="secret-input" class="text-input secret-entry" type="password" inputmode="numeric" autocomplete="new-password" maxlength="3" pattern="[0-9]{3}" placeholder="•••" required></div><button class="primary-button" type="submit">锁定密码 <span aria-hidden="true">→</span></button></form><div class="error-line" id="stage-error"></div></section>`;
  }
  if (state.phase === 'dice') {
    const self = state.players[state.selfIndex];
    const button = self?.dice !== null && self?.dice !== undefined
      ? `<button class="soft-button full-width dice-action" disabled>已掷出，等待对方</button>`
      : `<button class="primary-button full-width dice-action" data-action="roll" ${pendingRoll ? 'disabled' : ''}>${pendingRoll ? '掷骰中…' : '掷出我的骰子　🎲'}</button>`;
    return `<section class="stage-card"><h3 class="stage-heading"><span class="stage-heading-icon">⚄</span>${state.diceTie ? '点数相同，重新来过' : '掷骰决定先手'}</h3><p class="stage-copy">每人掷一次，点数更大的一方获得先手。骰子结果会同步展示给双方。</p><div class="dice-row">${state.players.map((player, index) => `<div class="dice-box"><div class="die ${player?.dice ? 'rolled' : ''}">${player?.dice ? ['⚀','⚁','⚂','⚃','⚄','⚅'][player.dice - 1] : '·'}</div><div class="dice-info"><div class="dice-name">${escapeHtml(player?.name || (index ? '玩家 B' : '玩家 A'))}${index === state.selfIndex ? ' · 你' : ''}</div><div class="dice-status">${player?.dice ? `${player.dice} 点` : '等待投掷'}</div></div></div>`).join('')}</div>${button}</section>`;
  }
  if (state.phase === 'playing') {
    const selfTurn = state.turnIndex === state.selfIndex;
    return `<section class="stage-card"><h3 class="stage-heading"><span class="stage-heading-icon">⌖</span>${selfTurn ? '猜猜对方的密码' : '等待对方提交'}</h3><p class="turn-hint">${selfTurn ? '只显示对位完全正确的数量，不会提示具体位置。' : `现在是 ${escapeHtml(state.players[state.turnIndex]?.name || '对手')} 的回合。`}</p>${selfTurn ? `<form class="guess-form" id="guess-form"><input id="guess-input" class="text-input guess-entry" type="text" inputmode="numeric" autocomplete="off" maxlength="3" pattern="[0-9]{3}" placeholder="输入 3 位数字" required><button class="primary-button" type="submit">提交猜测　→</button></form><div class="error-line" id="stage-error"></div>` : '<div class="locked-state"><div class="locked-message"><span class="checkmark">⌁</span>请保持耐心，轮到你时输入框会自动开启</div></div>'}</section>`;
  }
  if (state.phase === 'finished') {
    const isWinner = state.winner === state.selfIndex;
    const already = state.players[state.selfIndex]?.rematch;
    return `<section class="stage-card"><div class="winner-panel"><div class="winner-cup">${isWinner ? '🏆' : '✨'}</div><div class="winner-title">${isWinner ? '漂亮，猜中了！' : `${escapeHtml(state.players[state.winner]?.name || '对手')} 获胜！`}</div><div class="winner-desc">${isWinner ? '三位数字全部对位命中，你赢下了这场对决。' : '再来一局，换个密码继续挑战吧。'}</div><div class="winner-actions"><button class="primary-button" data-action="rematch" ${already ? 'disabled' : ''}>${already ? '已准备，等待好友…' : '再来一局　↻'}</button><button class="secondary-button" data-action="copy">分享房间链接</button></div></div></section>`;
  }
  return '';
}

function renderHistory(state) {
  const history = [...state.history].reverse();
  return `<section class="history-card"><div class="history-title-row"><div class="history-title">对局记录</div><div class="history-count">${state.history.length} 次猜测</div></div>${history.length ? `<div class="history-list">${history.map((item) => `<div class="history-item ${item.hits === 3 ? 'winning' : ''}"><div class="history-who"><strong>${escapeHtml(state.players[item.playerIndex]?.name || `玩家 ${item.playerIndex ? 'B' : 'A'}`)}</strong> 猜测</div><div class="guess-code">${escapeHtml(item.guess)}</div><div class="hit-count"><strong>${item.hits}</strong> 位命中</div></div>`).join('')}</div>` : '<div class="history-empty">还没有猜测记录，第一回合即将开始</div>'}</section>`;
}

function renderGame() {
  if (!roomState) return;
  const state = roomState;
  const [title, subtitle] = phaseText(state);
  app.innerHTML = `
    <div class="game-wrap">
      <div class="room-topline"><div><div class="room-label">ROOM CODE</div><div style="margin-top:7px"><span class="room-code">${escapeHtml(state.roomId)}</span></div></div><div class="room-actions"><button class="tiny-button" data-action="copy">↗ 分享</button><button class="tiny-button" data-action="leave">离开房间</button></div></div>
      <section class="status-banner"><div><div class="status-title">${escapeHtml(title)}</div><div class="status-subtitle">${escapeHtml(subtitle)}</div></div><div class="status-icon">${state.paused ? '◌' : state.phase === 'playing' ? '⌖' : state.phase === 'dice' ? '⚄' : state.phase === 'finished' ? '✦' : '⌁'}</div></section>
      <div class="players-grid">${state.players.map((player, index) => renderPlayerCard(player, state, index)).join('')}</div>
      ${renderStage(state)}
      ${renderHistory(state)}
      <footer class="game-footer"><div class="footer-tip"><span>ⓘ</span>只计算数字与位置同时正确的命中数</div><div class="footer-actions"><button class="tiny-button" data-action="home">返回首页</button></div></footer>
    </div>`;
  app.querySelectorAll('[data-action="copy"]').forEach((button) => button.addEventListener('click', copyRoomLink));
  app.querySelectorAll('[data-action="leave"], [data-action="home"]').forEach((button) => button.addEventListener('click', leaveRoom));
  const unlockButton = app.querySelector('[data-action="unlock"]');
  if (unlockButton) unlockButton.addEventListener('click', unlockSecret);
  const rollButton = app.querySelector('[data-action="roll"]');
  if (rollButton) rollButton.addEventListener('click', rollDice);
  const rematchButton = app.querySelector('[data-action="rematch"]');
  if (rematchButton) rematchButton.addEventListener('click', requestRematch);
  const secretForm = document.getElementById('secret-form');
  if (secretForm) secretForm.addEventListener('submit', submitSecret);
  const guessForm = document.getElementById('guess-form');
  if (guessForm) {
    const input = document.getElementById('guess-input');
    input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 3); });
    guessForm.addEventListener('submit', submitGuess);
    input.focus({ preventScroll: true });
  }
  const secretInput = document.getElementById('secret-input');
  if (secretInput) secretInput.addEventListener('input', () => { secretInput.value = secretInput.value.replace(/\D/g, '').slice(0, 3); });
}

function showStageError(message) {
  const node = document.getElementById('stage-error');
  if (node) node.textContent = message;
  const form = node?.parentElement;
  if (form) {
    form.classList.remove('shake');
    void form.offsetWidth;
    form.classList.add('shake');
  }
}

function submitSecret(event) {
  event.preventDefault();
  const secret = document.getElementById('secret-input').value;
  if (!/^\d{3}$/.test(secret)) return showStageError('请输入完整的 3 位数字（0–9）。');
  socket.emit('secret:set', { secret }, (result) => {
    if (!result?.ok) return showToast(result?.error === 'dice_started' ? '已有玩家掷骰，密码不能再修改' : '暂时无法锁定密码', true);
    showToast('密码已锁定，只有你自己知道');
  });
}

function unlockSecret() {
  socket.emit('secret:unlock', {}, (result) => {
    if (!result?.ok) return showToast('现在不能修改密码', true);
    showToast('可以重新设置密码了');
  });
}

function rollDice() {
  if (pendingRoll) return;
  pendingRoll = true;
  renderGame();
  socket.emit('dice:roll', {}, (result) => {
    if (!result?.ok) {
      pendingRoll = false;
      renderGame();
      return showToast('现在还不能掷骰，请稍后重试', true);
    }
    clearTimeout(rollTimer);
    rollTimer = setTimeout(() => {
      pendingRoll = false;
      renderGame();
    }, 720);
  });
}

function submitGuess(event) {
  event.preventDefault();
  const guess = document.getElementById('guess-input').value;
  if (!/^\d{3}$/.test(guess)) return showStageError('请输入完整的 3 位数字。');
  socket.emit('guess:submit', { guess }, (result) => {
    if (!result?.ok) {
      const messages = { invalid_guess: '请输入 3 位数字。', not_your_turn: '现在还不是你的回合。' };
      return showToast(messages[result?.error] || '猜测没有提交成功，请重试', true);
    }
    showToast(result.hits === 3 ? '全部命中！' : `本次对位命中 ${result.hits} 位`);
  });
}

function requestRematch() {
  socket.emit('match:rematch', {}, (result) => {
    if (!result?.ok) return showToast('好友在线后才能开始新一局', true);
    showToast('已准备好，等待好友确认');
  });
}

function leaveRoom() {
  if (!activeRoomId) return renderHome();
  const oldId = activeRoomId;
  socket.emit('room:leave', {}, () => {
    localStorage.removeItem(`duiwei-token:${oldId}`);
    activeRoomId = '';
    playerToken = '';
    roomState = null;
    clearRoomUrl();
    homeError = '';
    renderHome();
  });
}

socket.on('connect', () => {
  setNetwork('online');
  if (activeRoomId) {
    joining = false;
    requestRoomJoin(activeRoomId);
  } else if (!roomState) {
    renderHome();
  }
});
socket.on('disconnect', () => {
  setNetwork('offline');
  if (roomState) renderGame();
});
socket.on('connect_error', () => setNetwork('offline'));
socket.on('room:state', (state) => {
  if (!activeRoomId || state.roomId !== activeRoomId) return;
  roomState = state;
  if (state.selfIndex < 0) return;
  if (state.notice && state.noticeId && state.noticeId !== lastNoticeId) {
    lastNoticeId = state.noticeId;
    showToast(state.notice, true);
  }
  renderGame();
});

if (!requestedRoom) renderHome();

