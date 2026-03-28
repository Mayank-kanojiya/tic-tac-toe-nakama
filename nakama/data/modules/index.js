var OPCODE_STATE      = 1;
var OPCODE_MOVE       = 2;
var OPCODE_ERROR      = 3;
var OPCODE_NEXT_ROUND = 4;
var OPCODE_EXIT       = 5;

var TOTAL_ROUNDS = 3;
var LEADERBOARD_ID = 'ttt_wins';

// ── RPC ───────────────────────────────────────────────────────────────────────

function rpcCreateTttMatch(ctx, logger, nk, payload) {
  var p = parsePayload(nk, payload);
  var params = { mode: p.mode || 'classic' };
  return JSON.stringify({ matchId: nk.matchCreate('ttt_match', params) });
}

function rpcCreateBotMatch(ctx, logger, nk, payload) {
  var p = parsePayload(nk, payload);
  var params = { mode: p.mode || 'classic', bot: true, difficulty: p.difficulty || 'hard' };
  return JSON.stringify({ matchId: nk.matchCreate('ttt_match', params) });
}

// RPC: return top-20 leaderboard records
function rpcGetLeaderboard(ctx, logger, nk, payload) {
  try {
    var result = nk.leaderboardRecordsList(LEADERBOARD_ID, [], 20, null, 0);
    return JSON.stringify({ records: (result && result.records) || [] });
  } catch (e) {
    logger.warn('rpcGetLeaderboard: ' + String(e));
    return JSON.stringify({ records: [] });
  }
}

var QUICK_MATCH_COLLECTION = 'quick_match';
var QUICK_MATCH_KEY = 'queue';
var SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

// RPC: Quick match - join queue and match if possible
function rpcQuickMatch(ctx, logger, nk, payload) {
  try {
    var p = parsePayload(nk, payload);
    var userId = ctx.userId;
    var userName = p.name || 'Player';
    var mode = p.mode || 'classic';
    var now = Date.now();

    logger.info('Quick match request from: ' + userId + ' (' + userName + ')');

    // Read queue
    var queueData = { players: [] };
    try {
      var reads = nk.storageRead([{ collection: QUICK_MATCH_COLLECTION, key: QUICK_MATCH_KEY, userId: SYSTEM_USER_ID }]);
      if (reads && reads.length > 0 && reads[0].value) {
        queueData = reads[0].value;
      }
    } catch (e) { logger.warn('Queue read: ' + String(e)); }

    if (!queueData || !queueData.players) queueData = { players: [] };

    logger.info('Queue size before: ' + queueData.players.length);

    // Remove stale and self, build new array
    var fresh = [];
    for (var i = 0; i < queueData.players.length; i++) {
      var e = queueData.players[i];
      if (e && e.userId && e.userId !== userId && (now - e.joinedAt) < 60000) fresh.push(e);
    }

    logger.info('Queue size after cleanup: ' + fresh.length);

    if (fresh.length > 0) {
      var opponent = fresh[0];
      var remaining = [];
      for (var j = 1; j < fresh.length; j++) remaining.push(fresh[j]);
      try {
        nk.storageWrite([{ collection: QUICK_MATCH_COLLECTION, key: QUICK_MATCH_KEY, userId: SYSTEM_USER_ID, value: { players: remaining }, permissionRead: 0, permissionWrite: 0 }]);
      } catch (e) { logger.warn('Queue write: ' + String(e)); }
      logger.info('Matched ' + opponent.userId + ' vs ' + userId + ' matchId=' + opponent.matchId);
      return JSON.stringify({ matched: true, matchId: opponent.matchId });
    }

    // No one waiting - create match and queue self
    var newMatchId = nk.matchCreate('ttt_match', { mode: mode });
    var entry = { userId: userId, name: userName, joinedAt: now, matchId: newMatchId };
    fresh.push(entry);
    try {
      nk.storageWrite([{ collection: QUICK_MATCH_COLLECTION, key: QUICK_MATCH_KEY, userId: SYSTEM_USER_ID, value: { players: fresh }, permissionRead: 0, permissionWrite: 0 }]);
    } catch (e) {
      logger.error('Queue write error: ' + String(e));
      return JSON.stringify({ error: String(e), matched: false });
    }
    logger.info('Queued ' + userId + ' matchId=' + newMatchId + ' queueSize=' + fresh.length);
    return JSON.stringify({ matched: false, queued: true, matchId: newMatchId });
  } catch (e) {
    logger.error('rpcQuickMatch error: ' + String(e));
    return JSON.stringify({ error: String(e), matched: false });
  }
}

function parsePayload(nk, payload) {
  try {
    var raw = '';
    if (typeof payload === 'string' && payload.length > 0) {
      raw = payload;
    } else if (payload && typeof payload === 'object') {
      raw = JSON.stringify(payload);
    } else {
      return {};
    }
    var parsed = JSON.parse(raw);
    // Return a plain copy so callers can safely mutate it
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      var copy = {};
      var keys = Object.keys(parsed);
      for (var i = 0; i < keys.length; i++) copy[keys[i]] = parsed[keys[i]];
      return copy;
    }
  } catch (e) {}
  return {};
}

// ── Match lifecycle ───────────────────────────────────────────────────────────

function matchInit(ctx, logger, nk, params) {
  var mode = (params && typeof params.mode === 'string') ? params.mode : 'classic';
  var state = {
    board: ['','','','','','','','',''],
    players: {}, symbols: {}, names: {},
    turn: 'X', status: 'waiting',
    turnEndsAt: 0, winner: null,
    mode: mode, turnTimeMs: mode === 'timed' ? 30000 : 0,
    bot: !!(params && params.bot),
    botDifficulty: (params && params.difficulty) || 'hard',
    lastBotJoinAt: 0,
    round: 1,
    scores: {},          // { userId: points }
    nextRoundVotes: {},  // { userId: true } — collected after a round ends
    exitVotes: {}        // { userId: true }
  };
  return { state: state, tickRate: 5, label: 'ttt' };
}

function matchJoinAttempt(ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
  if (state.players[presence.userId]) return { state: state, accept: true };
  if (Object.keys(state.players).length >= 2) return { state: state, accept: false, rejectMessage: 'Match is full' };
  return { state: state, accept: true };
}

function matchJoin(ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var p = presences[i];
    state.players[p.userId] = p;
    state.names[p.userId] = p.displayName || p.username || p.userId;
    if (!state.scores[p.userId]) state.scores[p.userId] = 0;
  }
  var ids = Object.keys(state.players);
  if (ids.length === 1) {
    state.symbols[ids[0]] = 'X';
    state.status = 'waiting'; state.turn = 'X'; state.turnEndsAt = 0; state.winner = null;
  }
  if (ids.length === 2) {
    assignSymbols(state, ids);
    state.status = 'playing'; state.turn = 'X';
    state.turnEndsAt = state.turnTimeMs ? Date.now() + state.turnTimeMs : 0;
    state.winner = null;
  }
  dispatcher.broadcastMessage(OPCODE_STATE, JSON.stringify(buildPayload(state)), null, null);
  return { state: state };
}

function matchLeave(ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var p = presences[i];
    delete state.players[p.userId];
    delete state.symbols[p.userId];
    delete state.nextRoundVotes[p.userId];
    delete state.exitVotes[p.userId];
  }
  var ids = Object.keys(state.players);
  // If already exited/series_over, don't overwrite — just broadcast current state
  if (state.status === 'exited' || state.status === 'series_over') {
    dispatcher.broadcastMessage(OPCODE_STATE, JSON.stringify(buildPayload(state)), null, null);
    return { state: state };
  }
  if (state.status === 'playing' && ids.length < 2) {
    state.status = 'finished'; state.winner = 'opponent_left'; state.turnEndsAt = 0;
  } else if (state.status === 'finished' && ids.length < 2) {
    state.status = 'exited';
  } else if (ids.length < 2) {
    state.status = 'waiting';
  }
  dispatcher.broadcastMessage(OPCODE_STATE, JSON.stringify(buildPayload(state)), null, null);
  return { state: state };
}

// ── Match loop ────────────────────────────────────────────────────────────────

function matchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
  // Timer expiry
  if (state.status === 'playing' && state.turnEndsAt && Date.now() >= state.turnEndsAt) {
    state.status = 'finished';
    state.winner = state.turn === 'X' ? 'O' : 'X';
    state.turnEndsAt = 0;
    awardPoints(state, state.winner);
    dispatcher.broadcastMessage(OPCODE_STATE, JSON.stringify(buildPayload(state)), null, null);
    return { state: state };
  }

  // Bot joins
  if (state.bot && state.status === 'waiting' && Object.keys(state.players).length === 1 && (tick - (state.lastBotJoinAt || 0) > 10)) {
    state.players['bot'] = { userId: 'bot', sessionId: null };
    state.symbols['bot'] = 'O';
    state.names['bot'] = 'Bot (' + state.botDifficulty + ')';
    state.scores['bot'] = state.scores['bot'] || 0;
    state.status = 'playing'; state.turn = 'X';
    state.turnEndsAt = state.turnTimeMs ? Date.now() + state.turnTimeMs : 0;
    state.lastBotJoinAt = tick;
    dispatcher.broadcastMessage(OPCODE_STATE, JSON.stringify(buildPayload(state)), null, null);
  }

  // Process messages
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    var senderId = m.sender && m.sender.userId ? m.sender.userId : null;
    if (!senderId) continue;

    if (m.opCode === OPCODE_NEXT_ROUND) {
      handleNextRoundVote(state, dispatcher, nk, logger, senderId);
      continue;
    }
    if (m.opCode === OPCODE_EXIT) {
      handleExitVote(state, dispatcher, nk, logger, senderId);
      continue;
    }
    if (m.opCode !== OPCODE_MOVE) continue;
    if (state.status !== 'playing') continue;

    var symbol = state.symbols[senderId];
    if (symbol !== 'X' && symbol !== 'O') {
      dispatcher.broadcastMessage(OPCODE_ERROR, JSON.stringify({ message: 'You are not a player.' }), [m.sender], null);
      continue;
    }
    if (symbol !== state.turn) {
      dispatcher.broadcastMessage(OPCODE_ERROR, JSON.stringify({ message: 'Not your turn.' }), [m.sender], null);
      continue;
    }

    var raw = decodeMessageData(nk, m.data);
    var move;
    try { move = JSON.parse(raw); } catch (e) { continue; }

    var index = (move && typeof move.index === 'number') ? move.index : -1;
    if (index < 0 || index > 8 || state.board[index]) {
      dispatcher.broadcastMessage(OPCODE_ERROR, JSON.stringify({ message: 'Invalid move.' }), [m.sender], null);
      continue;
    }

    state.board[index] = symbol;

    var w = computeWinner(state.board);
    if (w) {
      state.status = 'finished'; state.winner = w; state.turnEndsAt = 0;
      awardPoints(state, w);
      dispatcher.broadcastMessage(OPCODE_STATE, JSON.stringify(buildPayload(state)), null, null);
      continue;
    }
    if (isBoardFull(state.board)) {
      state.status = 'finished'; state.winner = 'draw'; state.turnEndsAt = 0;
      dispatcher.broadcastMessage(OPCODE_STATE, JSON.stringify(buildPayload(state)), null, null);
      continue;
    }

    state.turn = symbol === 'X' ? 'O' : 'X';
    state.turnEndsAt = state.turnTimeMs ? Date.now() + state.turnTimeMs : 0;

    // Bot move — handles both 'O' (default) and 'X' (after symbol swap)
    if (state.bot && state.turn === state.symbols['bot']) {
      var botIdx = botPickMove(state.board, state.botDifficulty);
      state.board[botIdx] = state.symbols['bot'];
      var w2 = computeWinner(state.board);
      if (w2) {
        state.status = 'finished'; state.winner = w2; state.turnEndsAt = 0;
        awardPoints(state, w2);
      } else if (isBoardFull(state.board)) {
        state.status = 'finished'; state.winner = 'draw'; state.turnEndsAt = 0;
      } else {
        state.turn = state.symbols['bot'] === 'X' ? 'O' : 'X';
        state.turnEndsAt = state.turnTimeMs ? Date.now() + state.turnTimeMs : 0;
      }
    }

    dispatcher.broadcastMessage(OPCODE_STATE, JSON.stringify(buildPayload(state)), null, null);
  }

  return { state: state };
}

// ── Vote handlers ─────────────────────────────────────────────────────────────

function handleNextRoundVote(state, dispatcher, nk, logger, senderId) {
  // Only valid after a round has finished
  if (state.status !== 'finished') return;

  state.nextRoundVotes[senderId] = true;

  var humanIds = Object.keys(state.players).filter(function(id) { return id !== 'bot'; });
  var allVoted = humanIds.every(function(id) { return state.nextRoundVotes[id]; });

  if (!allVoted) {
    // Broadcast a "waiting" signal so the other player's popup updates
    dispatcher.broadcastMessage(OPCODE_STATE, JSON.stringify(buildPayload(state)), null, null);
    return;
  }

  // Both voted next — start next round
  if (state.round >= TOTAL_ROUNDS) {
    state.status = 'series_over';
    state.nextRoundVotes = {};
    persistScores(nk, logger, state);
    dispatcher.broadcastMessage(OPCODE_STATE, JSON.stringify(buildPayload(state)), null, null);
    return;
  }

  state.round += 1;
  state.board = ['','','','','','','','',''];
  state.winner = null;
  state.nextRoundVotes = {};
  state.exitVotes = {};
  // Swap symbols each round so it's fair
  var ids = Object.keys(state.players);
  for (var i = 0; i < ids.length; i++) {
    state.symbols[ids[i]] = state.symbols[ids[i]] === 'X' ? 'O' : 'X';
  }
  state.turn = 'X';
  state.status = 'playing';
  state.turnEndsAt = state.turnTimeMs ? Date.now() + state.turnTimeMs : 0;

  // If the bot now has 'X' it goes first — make its move immediately
  if (state.bot && state.symbols['bot'] === 'X') {
    var botIdx = botPickMove(state.board, state.botDifficulty);
    state.board[botIdx] = 'X';
    var bw = computeWinner(state.board);
    if (bw) {
      state.status = 'finished'; state.winner = bw; state.turnEndsAt = 0;
      awardPoints(state, bw);
    } else if (isBoardFull(state.board)) {
      state.status = 'finished'; state.winner = 'draw'; state.turnEndsAt = 0;
    } else {
      state.turn = 'O';
      state.turnEndsAt = state.turnTimeMs ? Date.now() + state.turnTimeMs : 0;
    }
  }

  dispatcher.broadcastMessage(OPCODE_STATE, JSON.stringify(buildPayload(state)), null, null);
}

function handleExitVote(state, dispatcher, nk, logger, senderId) {
  state.exitVotes[senderId] = true;
  state.status = 'exited';
  state.nextRoundVotes = {};
  persistScores(nk, logger, state);
  dispatcher.broadcastMessage(OPCODE_STATE, JSON.stringify(buildPayload(state)), null, null);
}

// ── Persist scores to Nakama leaderboard ─────────────────────────────────────

function persistScores(nk, logger, state) {
  var ids = Object.keys(state.players).filter(function(id) { return id !== 'bot'; });
  for (var i = 0; i < ids.length; i++) {
    var uid = ids[i];
    var pts = state.scores[uid] || 0;
    if (pts <= 0) continue;
    try {
      // Ensure leaderboard exists before writing (idempotent)
      try { nk.leaderboardCreate(LEADERBOARD_ID, false, 'desc', 'incr', '', {}); } catch (ce) {}
      nk.leaderboardRecordWrite(LEADERBOARD_ID, uid, state.names[uid] || uid, pts, 0, {});
    } catch (e) {
      logger.warn('persistScores uid=' + uid + ': ' + String(e));
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function awardPoints(state, winnerSymbol) {
  var winnerUid = Object.keys(state.symbols).find(function(id) { return state.symbols[id] === winnerSymbol; });
  if (winnerUid) state.scores[winnerUid] = (state.scores[winnerUid] || 0) + 10;
}

function assignSymbols(state, ids) {
  if (!state.symbols[ids[0]] && !state.symbols[ids[1]]) {
    state.symbols[ids[0]] = 'X'; state.symbols[ids[1]] = 'O';
  } else if (state.symbols[ids[0]] && !state.symbols[ids[1]]) {
    state.symbols[ids[1]] = state.symbols[ids[0]] === 'X' ? 'O' : 'X';
  } else if (!state.symbols[ids[0]] && state.symbols[ids[1]]) {
    state.symbols[ids[0]] = state.symbols[ids[1]] === 'X' ? 'O' : 'X';
  }
}

function buildPayload(state) {
  // Send both the absolute deadline and the remaining ms so clients
  // can use whichever is more reliable given clock skew
  var remaining = 0;
  if (state.turnEndsAt && state.status === 'playing') {
    remaining = Math.max(0, state.turnEndsAt - Date.now());
  }
  return {
    board: state.board,
    symbols: state.symbols,
    names: state.names,
    turn: state.turn,
    status: state.status,
    winner: state.winner,
    turnEndsAt: state.turnEndsAt,
    turnRemainingMs: remaining,
    mode: state.mode,
    bot: state.bot,
    botDifficulty: state.botDifficulty,
    round: state.round,
    scores: state.scores,
    nextRoundVotes: state.nextRoundVotes
  };
}

function decodeMessageData(nk, data) {
  if (typeof data === 'string') return data;
  try { return nk.binaryToString(data); } catch (e) { return ''; }
}

function computeWinner(board) {
  var lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (var i = 0; i < lines.length; i++) {
    var a = lines[i][0], b = lines[i][1], c = lines[i][2];
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

function isBoardFull(board) {
  for (var i = 0; i < board.length; i++) { if (!board[i]) return false; }
  return true;
}

// ── Bot logic ─────────────────────────────────────────────────────────────────

function botPickMove(board, difficulty) {
  if (difficulty === 'easy') return botEasy(board);
  if (difficulty === 'medium') return botMedium(board);
  return botHard(board);
}

function emptyIndices(board) {
  var e = [];
  for (var i = 0; i < board.length; i++) { if (!board[i]) e.push(i); }
  return e;
}

function botEasy(board) {
  var e = emptyIndices(board);
  return e[Math.floor(Math.random() * e.length)];
}

function botMedium(board) {
  var win = findWinningMove(board, 'O'); if (win !== -1) return win;
  var block = findWinningMove(board, 'X'); if (block !== -1) return block;
  return botEasy(board);
}

function findWinningMove(board, symbol) {
  var lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (var i = 0; i < lines.length; i++) {
    var a = lines[i][0], b = lines[i][1], c = lines[i][2];
    var cnt = 0, empty = -1;
    [a,b,c].forEach(function(idx) { if (board[idx] === symbol) cnt++; else if (!board[idx]) empty = idx; });
    if (cnt === 2 && empty !== -1) return empty;
  }
  return -1;
}

function botHard(board) {
  var best = -Infinity, bestIdx = -1;
  var e = emptyIndices(board);
  for (var i = 0; i < e.length; i++) {
    board[e[i]] = 'O';
    var score = minimax(board, 0, false);
    board[e[i]] = '';
    if (score > best) { best = score; bestIdx = e[i]; }
  }
  return bestIdx;
}

function minimax(board, depth, isMax) {
  var w = computeWinner(board);
  if (w === 'O') return 10 - depth;
  if (w === 'X') return depth - 10;
  if (isBoardFull(board)) return 0;
  var e = emptyIndices(board);
  if (isMax) {
    var best = -Infinity;
    for (var i = 0; i < e.length; i++) { board[e[i]] = 'O'; best = Math.max(best, minimax(board, depth+1, false)); board[e[i]] = ''; }
    return best;
  } else {
    var best2 = Infinity;
    for (var j = 0; j < e.length; j++) { board[e[j]] = 'X'; best2 = Math.min(best2, minimax(board, depth+1, true)); board[e[j]] = ''; }
    return best2;
  }
}

// ── Matchmaker ────────────────────────────────────────────────────────────────

// Global matchmaking queue
var matchmakingQueue = []

function matchmakerMatched(ctx, logger, nk, matches) {
  logger.info('Matchmaker matched players: ' + JSON.stringify(matches))

  if (matches.length >= 2) {
    // Take first two players from matches
    var player1 = matches[0]
    var player2 = matches[1]

    // Create a new match
    var matchId = nk.matchCreate('ttt_match', { mode: 'timed' })
    logger.info('Created match: ' + matchId + ' for players: ' + player1.presence.userId + ' vs ' + player2.presence.userId)

    // The match will handle player joining in matchJoin
  }
}

// RPC: Get quick match stats
function rpcGetQuickMatchStats(ctx, logger, nk, payload) {
  try {
    var queueSize = 0;
    try {
      var reads = nk.storageRead([{ collection: QUICK_MATCH_COLLECTION, key: QUICK_MATCH_KEY, userId: SYSTEM_USER_ID }]);
      if (reads && reads.length > 0 && reads[0].value && reads[0].value.players) {
        queueSize = reads[0].value.players.length;
      }
    } catch (e) {}
    var matchesResult = nk.matchList(100, true, null, null, null, null);
    var matches = (matchesResult && matchesResult.matches) ? matchesResult.matches : [];
    var activePlayers = 0;
    for (var i = 0; i < matches.length; i++) {
      if (matches[i].presences) activePlayers += matches[i].presences.length;
    }
    return JSON.stringify({ queueWaiting: queueSize, activePlayers: activePlayers, activeMatches: matches.length });
  } catch (e) {
    return JSON.stringify({ queueWaiting: 0, activePlayers: 0, activeMatches: 0 });
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

function matchTerminate(ctx, logger, nk, dispatcher, tick, state, graceSeconds) { return { state: state }; }
function matchSignal(ctx, logger, nk, dispatcher, tick, state, data) { return { state: state, data: data }; }

var tttMatch = { matchInit: matchInit, matchJoinAttempt: matchJoinAttempt, matchJoin: matchJoin, matchLeave: matchLeave, matchLoop: matchLoop, matchTerminate: matchTerminate, matchSignal: matchSignal };

function InitModule(ctx, logger, nk, initializer) {
  initializer.registerMatch('ttt_match', tttMatch);
  initializer.registerRpc('create_ttt_match', rpcCreateTttMatch);
  initializer.registerRpc('create_bot_match', rpcCreateBotMatch);
  initializer.registerRpc('get_leaderboard', rpcGetLeaderboard);
  initializer.registerRpc('quick_match', rpcQuickMatch);
  initializer.registerRpc('get_quick_match_stats', rpcGetQuickMatchStats);
  logger.info('ttt module loaded');
}

this.InitModule = InitModule;
