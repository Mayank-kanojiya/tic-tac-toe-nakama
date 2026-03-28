import { useEffect, useRef, useState } from 'react'
import type { MatchData } from '@heroiclabs/nakama-js'
import './App.css'
import { connectNakama } from './nakama'
import type { NakamaConnection } from './nakama'

function decodeNakamaData(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
  return String(data)
}

type MatchStatePayload = {
  board: string[]
  symbols: Record<string, string>
  names: Record<string, string>
  turn: string
  status: string
  winner?: string
  turnEndsAt?: number
  turnRemainingMs?: number
  mode?: string
  round?: number
  scores?: Record<string, number>
  nextRoundVotes?: Record<string, boolean>
  bot?: boolean
}

type LeaderboardEntry = { username: string; score: number; rank: number }

const OPCODE_STATE      = 1
const OPCODE_MOVE       = 2
const OPCODE_ERROR      = 3
const OPCODE_NEXT_ROUND = 4
const OPCODE_EXIT       = 5
const TOTAL_ROUNDS      = 3

function cellLabel(v: string) { return v === 'X' || v === 'O' ? v : '' }

function safeObject<T extends object>(v: unknown): T {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v as T : {} as T
}

function resolveWinnerName(winner: string, names: Record<string, string>, symbols: Record<string, string>) {
  if (winner === 'draw') return 'Draw'
  if (winner === 'opponent_left') return 'Opponent left'
  const uid = Object.keys(symbols).find(id => symbols[id] === winner)
  return (uid && names[uid]) || winner
}

export default function App() {
  const [username, setUsername] = useState('')
  const [conn, setConn] = useState<NakamaConnection | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [matchId, setMatchId] = useState('')
  const [joinedMatchId, setJoinedMatchId] = useState<string | null>(null)

  const [board, setBoard] = useState<string[]>(Array(9).fill(''))
  const [symbols, setSymbols] = useState<Record<string, string>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [turn, setTurn] = useState('X')
  const [status, setStatus] = useState('disconnected')
  const [winner, setWinner] = useState<string | null>(null)
  const [mySymbol, setMySymbol] = useState<string | null>(null)
  const [round, setRound] = useState(1)
  const [scores, setScores] = useState<Record<string, number>>({})
  const [nextRoundVotes, setNextRoundVotes] = useState<Record<string, boolean>>({})

  const [secondsLeft, setSecondsLeft] = useState(0)
  const [isTimed, setIsTimed] = useState(false)

  const [showPopup, setShowPopup] = useState(false)
  const [iVoted, setIVoted] = useState<'next' | 'exit' | null>(null)

  // Matchmaking
  const [matchmaking, setMatchmaking] = useState(false)
  const mmTicketRef = useRef<string | null>(null)
  const mmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Leaderboard
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [showLeaderboard, setShowLeaderboard] = useState(false)

  // Quick Match Stats
  const [qmStats, setQmStats] = useState<{ queueWaiting: number; activePlayers: number }>({ queueWaiting: 0, activePlayers: 0 })

  const [mode, setMode] = useState<'classic' | 'timed'>('timed')
  const [botDifficulty, setBotDifficulty] = useState<'easy' | 'medium' | 'hard'>('hard')

  const myUserIdRef    = useRef<string | null>(null)
  const turnEndsAtRef  = useRef(0)
  const statusRef      = useRef('disconnected')
  const isTimedRef     = useRef(false)
  const exitTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exitToLobbyRef = useRef<() => void>(() => {})

  myUserIdRef.current = conn?.session?.user_id ?? null

  function exitToLobby() {
    if (exitTimerRef.current) { clearTimeout(exitTimerRef.current); exitTimerRef.current = null }
    setShowPopup(false)
    setJoinedMatchId(null)
    setBoard(Array(9).fill(''))
    setWinner(null)
    setIVoted(null)
    setRound(1)
    setScores({})
    setNextRoundVotes({})
    setStatus('connected')
  }
  exitToLobbyRef.current = exitToLobby

  // ── Socket handler ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!conn) return

    conn.socket.onmatchdata = (md: MatchData) => {
      if (md.op_code === OPCODE_ERROR) {
        try { setError(JSON.parse(decodeNakamaData(md.data))?.message || 'Error') }
        catch { setError('Unknown error') }
        return
      }
      if (md.op_code !== OPCODE_STATE) return
      try {
        const p = JSON.parse(decodeNakamaData(md.data)) as MatchStatePayload

        if (Array.isArray(p.board) && p.board.length === 9) setBoard(p.board)
        if (p.turn) setTurn(p.turn)
        if (typeof p.status === 'string') {
          setStatus(p.status)
          statusRef.current = p.status
        }

        const timed = p.mode === 'timed'
        setIsTimed(timed)
        isTimedRef.current = timed

        // Use turnRemainingMs (server-computed at broadcast time) to set a local
        // deadline — this avoids client/server clock skew entirely
        if (timed && typeof p.turnRemainingMs === 'number' && p.turnRemainingMs > 0) {
          turnEndsAtRef.current = Date.now() + p.turnRemainingMs
        } else if (timed && typeof p.turnEndsAt === 'number' && p.turnEndsAt > 0) {
          turnEndsAtRef.current = p.turnEndsAt
        } else {
          turnEndsAtRef.current = 0
        }

        const syms = safeObject<Record<string, string>>(p.symbols)
        setSymbols(syms)
        const uid = myUserIdRef.current
        if (uid) setMySymbol(syms[uid] ?? null)

        let parsedNames = safeObject<Record<string, string>>(p.names)
        if (typeof p.names === 'string') {
          try { parsedNames = JSON.parse(p.names) } catch { parsedNames = {} }
        }
        setNames(parsedNames)

        if (typeof p.round === 'number') setRound(p.round)
        if (p.scores) setScores(safeObject<Record<string, number>>(p.scores))
        if (p.nextRoundVotes) setNextRoundVotes(safeObject<Record<string, boolean>>(p.nextRoundVotes))

        if (p.winner) {
          setWinner(prev => {
            if (prev !== p.winner) setIVoted(null)
            return p.winner!
          })
          setShowPopup(true)
        }

        if (p.status === 'playing' && !p.winner) {
          setShowPopup(false)
          setIVoted(null)
          setWinner(null)
        }

        if (p.status === 'series_over' || p.status === 'exited') {
          exitToLobbyRef.current()
        }
      } catch {
        setError('Failed to parse match state')
      }
    }

    // Nakama matchmaker found a match — auto-join it
    ;(conn.socket as any).onmatchmakermatched = async () => {
      // Not used anymore - quick match uses RPC instead
    }
  }, [conn])

  // ── Timer interval ────────────────────────────────────────────────────────────
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!isTimedRef.current || !turnEndsAtRef.current || statusRef.current !== 'playing') {
        setSecondsLeft(0); return
      }
      setSecondsLeft(Math.max(0, Math.ceil((turnEndsAtRef.current - Date.now()) / 1000)))
    }, 200)
    return () => window.clearInterval(id)
  }, [])

  // Fetch quick match stats every 2 seconds
  useEffect(() => {
    if (!conn) return
    const interval = setInterval(fetchQuickMatchStats, 2000)
    fetchQuickMatchStats() // Fetch immediately
    return () => clearInterval(interval)
  }, [conn])

  // ── Actions ───────────────────────────────────────────────────────────────────
  async function handleConnect() {
    setError(null); setConnecting(true)
    try {
      const c = await connectNakama(username.trim() || 'Player')
      setConn(c); setStatus('connected')
    } catch (e: any) { setError(e?.message ?? String(e)) }
    finally { setConnecting(false) }
  }

  async function createMatch() {
    if (!conn) return; setError(null)
    try {
      const res = await conn.client.rpc(conn.session, 'create_ttt_match', { mode })
      const data = parseRpcPayload(res)
      if (!data.matchId) { setError('Failed to create match'); return }
      setMatchId(data.matchId); await doJoinMatch(data.matchId)
    } catch (e: any) { setError(e?.message ?? String(e)) }
  }

  async function createBotMatch() {
    if (!conn) return; setError(null)
    try {
      const res = await conn.client.rpc(conn.session, 'create_bot_match', { mode, difficulty: botDifficulty })
      const data = parseRpcPayload(res)
      if (!data.matchId) { setError('Failed to create bot match'); return }
      setMatchId(data.matchId); await doJoinMatch(data.matchId)
    } catch (e: any) { setError(e?.message ?? String(e)) }
  }

  async function doJoinMatch(id: string) {
    if (!conn) return; setError(null)
    const trimmed = id.trim(); if (!trimmed) return
    try {
      await conn.socket.joinMatch(trimmed)
      setJoinedMatchId(trimmed); setWinner(null); setShowPopup(false); setStatus('joining')
    } catch (e: any) { setError(e?.message ?? String(e)) }
  }

  async function startQuickMatch() {
    if (!conn || matchmaking) return; setError(null)
    setMatchmaking(true)
    
    const tryMatch = async (attempt: number = 1) => {
      try {
        const res = await conn!.client.rpc(conn!.session, 'quick_match', { name: username || 'Player' })
        const data = parseRpcPayload(res)
        
        if (data.matched && data.matchId) {
          // Matched! Join the match
          await doJoinMatch(data.matchId)
          setMatchmaking(false)
        } else if (attempt < 15) {
          // Not matched yet - retry after 2 seconds (handles race conditions with concurrent joins)
          mmTimeoutRef.current = setTimeout(() => {
            tryMatch(attempt + 1)
          }, 2000)
        } else {
          // Give up after 15 retries (30 seconds total)
          setMatchmaking(false)
          setError('No opponent found. Try again later.')
        }
      } catch (e: any) {
        setMatchmaking(false)
        setError(e?.message ?? String(e))
      }
    }
    
    tryMatch()
  }

  async function cancelQuickMatch() {
    if (mmTimeoutRef.current) {
      clearTimeout(mmTimeoutRef.current)
      mmTimeoutRef.current = null
    }
    mmTicketRef.current = null
    setMatchmaking(false)
  }

  async function fetchQuickMatchStats() {
    if (!conn) return
    try {
      const res = await conn.client.rpc(conn.session, 'get_quick_match_stats', {})
      const data = parseRpcPayload(res)
      if (data.queueWaiting !== undefined) {
        setQmStats({
          queueWaiting: data.queueWaiting || 0,
          activePlayers: data.activePlayers || 0
        })
      }
    } catch (e: any) {
      console.warn('Stats fetch error:', e)
    }
  }

  async function sendMove(index: number) {
    if (!conn || !joinedMatchId || winner || status !== 'playing' || !mySymbol || mySymbol !== turn || board[index]) return
    try { await conn.socket.sendMatchState(joinedMatchId, OPCODE_MOVE, JSON.stringify({ index })) }
    catch (e: any) { setError(e?.message ?? String(e)) }
  }

  async function sendNextRound() {
    if (!conn || !joinedMatchId || iVoted) return
    setIVoted('next')
    try { await conn.socket.sendMatchState(joinedMatchId, OPCODE_NEXT_ROUND, '{}') }
    catch (e: any) { setError(e?.message ?? String(e)) }
  }

  async function sendExit() {
    if (!conn || !joinedMatchId || iVoted) return
    setIVoted('exit')
    try { await conn.socket.sendMatchState(joinedMatchId, OPCODE_EXIT, '{}') }
    catch (e: any) { setError(e?.message ?? String(e)) }
    exitTimerRef.current = setTimeout(() => exitToLobbyRef.current(), 2000)
  }

  async function fetchLeaderboard() {
    if (!conn) return
    try {
      const res = await conn.client.rpc(conn.session, 'get_leaderboard', '' as any)
      const data = parseRpcPayload(res) as any
      const records: LeaderboardEntry[] = (data.records ?? []).map((r: any, i: number) => ({
        username: r.username ?? r.ownerId ?? 'Unknown',
        score: r.score ?? 0,
        rank: r.rank ?? i + 1,
      }))
      setLeaderboard(records)
      setShowLeaderboard(true)
    } catch (e: any) { setError(e?.message ?? String(e)) }
  }

  function parseRpcPayload(res: any): any {
    const p = res?.payload
    return (p && typeof p === 'object') ? p : JSON.parse(String(p || '{}'))
  }

  // ── Derived display values ────────────────────────────────────────────────────
  const myUserId = myUserIdRef.current
  const safeNames = safeObject<Record<string, string>>(names)
  const myName = (myUserId && typeof safeNames[myUserId] === 'string' && safeNames[myUserId]) || username || 'You'
  const opponentEntry = myUserId
    ? Object.entries(safeNames).find(([uid]) => uid !== myUserId)
    : Object.entries(safeNames)[0]
  const opponentName = opponentEntry?.[1] ?? 'Opponent'
  const opponentId   = opponentEntry?.[0] ?? ''

  const myTurn      = status === 'playing' && !!mySymbol && mySymbol === turn
  const winnerName  = winner ? resolveWinnerName(winner, safeNames, symbols) : ''
  const myScore     = (myUserId && scores[myUserId]) ?? 0
  const oppScore    = (opponentId && scores[opponentId]) ?? 0
  const timerUrgent = isTimed && secondsLeft > 0 && secondsLeft <= 10
  const opponentVotedNext = opponentId ? !!nextRoundVotes[opponentId] : false

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <header className="header">
        <div className="title">Tic-Tac-Toe</div>
        {joinedMatchId && (
          <div className="subtitle">Round {round} / {TOTAL_ROUNDS}{isTimed ? ' · Timed' : ' · Classic'}</div>
        )}
      </header>

      <main className="card">
        {!conn ? (
          <div className="stack">
            <div className="login-title">Who are you?</div>
            <input className="input" value={username}
              onChange={e => {
                const val = e.target.value
                setUsername(val)
                localStorage.setItem('ttt.username', val)
              }}
              onKeyDown={e => e.key === 'Enter' && handleConnect()}
              placeholder="Enter your name" autoComplete="off" autoFocus />
            <button className="button" onClick={handleConnect} disabled={connecting}>
              {connecting ? 'Connecting…' : 'Play'}
            </button>
          </div>

        ) : !joinedMatchId ? (
          <div className="stack">
            <div className="lobby-header">
              <div className="lobby-name">👋 {username || 'Player'}</div>
              <button className="lb-btn" onClick={fetchLeaderboard}>🏆 Leaderboard</button>
            </div>

            <div className="mode-row">
              <span className="mode-label">Mode</span>
              <div className="mode-toggle">
                <button className={`mode-btn${mode === 'classic' ? ' active' : ''}`} onClick={() => setMode('classic')}>Classic</button>
                <button className={`mode-btn${mode === 'timed' ? ' active' : ''}`} onClick={() => setMode('timed')}>Timed 30s</button>
              </div>
            </div>

            {/* Quick Match */}
            {matchmaking ? (
              <div className="matchmaking-box">
                <div className="matchmaking-spinner" />
                <span>Finding opponent…</span>
                <div style={{ fontSize: '12px', color: '#888', marginTop: '8px' }}>
                  ⏳ Waiting: {qmStats.queueWaiting} | 👥 Playing: {qmStats.activePlayers}
                </div>
                <button className="button secondary" onClick={cancelQuickMatch}>Cancel</button>
              </div>
            ) : (
              <div>
                <button className="button full" onClick={startQuickMatch}>⚡ Quick Match</button>
                <div style={{ fontSize: '12px', color: '#666', marginTop: '6px', textAlign: 'center' }}>
                  ⏳ Queue: {qmStats.queueWaiting} | 👥 Playing: {qmStats.activePlayers}
                </div>
              </div>
            )}

            <div className="lobby-section">
              <button className="button secondary full" onClick={createMatch}>Create Private Match</button>
              {matchId ? (
                <div className="match-id-box">
                  <span className="match-id-label">Share this ID:</span>
                  <span className="match-id-value">{matchId}</span>
                </div>
              ) : null}
            </div>

            <div className="lobby-section">
              <input className="input" value={matchId} onChange={e => setMatchId(e.target.value)} placeholder="Paste Match ID to join" />
              <button className="button secondary full" onClick={() => doJoinMatch(matchId)}>Join Match</button>
            </div>

            <div className="divider">or</div>

            <div className="lobby-section">
              <div className="mode-row">
                <span className="mode-label">Bot</span>
                <div className="mode-toggle">
                  {(['easy', 'medium', 'hard'] as const).map(d => (
                    <button key={d} className={`mode-btn${botDifficulty === d ? ' active' : ''}`} onClick={() => setBotDifficulty(d)}>
                      {d[0].toUpperCase() + d.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <button className="button bot-btn full" onClick={createBotMatch}>Play vs Bot</button>
            </div>
          </div>

        ) : (
          <div className="stack">
            <div className="scoreboard">
              <div className={`player-score${myTurn ? ' active-player' : ''}`}>
                <span className="player-symbol">{mySymbol ?? '?'}</span>
                <span className="player-name">{myName}</span>
                <span className="player-pts">{myScore} pts</span>
                {isTimed && myTurn && status === 'playing' && secondsLeft > 0 && (
                  <div className={`player-timer${timerUrgent ? ' urgent' : ''}`}>{secondsLeft}s</div>
                )}
              </div>
              <div className="score-divider">VS</div>
              <div className={`player-score${!myTurn && status === 'playing' ? ' active-player' : ''}`}>
                <span className="player-symbol">{mySymbol === 'X' ? 'O' : 'X'}</span>
                <span className="player-name">{opponentName}</span>
                <span className="player-pts">{oppScore} pts</span>
                {isTimed && !myTurn && status === 'playing' && secondsLeft > 0 && (
                  <div className={`player-timer${timerUrgent ? ' urgent' : ''}`}>{secondsLeft}s</div>
                )}
              </div>
            </div>

            {status === 'playing' && !winner && (
              <div className="turn-indicator">
                {myTurn ? `🟢 Your turn` : `⏳ ${opponentName}'s turn`}
                {isTimed && secondsLeft > 0 && (
                  <span className={`turn-timer${timerUrgent ? ' urgent' : ''}`}> ({secondsLeft}s)</span>
                )}
              </div>
            )}
            {status === 'waiting' && <div className="turn-indicator waiting">Waiting for opponent…</div>}

            {isTimed && status === 'playing' && secondsLeft > 0 && (
              <div className="central-timer">
                <div className={`timer-display${timerUrgent ? ' urgent' : ''}`}>{secondsLeft}</div>
                <div className="timer-label">seconds left</div>
              </div>
            )}

            <div className="board" aria-label="Tic-tac-toe board">
              {board.map((v, idx) => (
                <button key={idx}
                  className={`cell${v === 'X' ? ' x' : v === 'O' ? ' o' : ''}${myTurn && !v ? ' playable' : ''}`}
                  onClick={() => sendMove(idx)}
                  disabled={!myTurn || !!v || status !== 'playing' || !!winner}>
                  {cellLabel(v)}
                </button>
              ))}
            </div>

            <div className="match-id-small">Match: {joinedMatchId}</div>
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </main>

      {/* ── Win Popup ── */}
      {showPopup && (
        <div className="popup-overlay">
          <div className="popup">
            {winner === 'draw' ? (
              <><div className="popup-symbol">🤝</div><div className="popup-title">It's a Draw!</div></>
            ) : winner === 'opponent_left' ? (
              <><div className="popup-symbol">🏆</div><div className="popup-title">You Win!</div><div className="popup-sub">Opponent disconnected</div></>
            ) : (
              <><div className="popup-symbol">{winner}</div><div className="popup-title">{winnerName} Wins!</div><div className="popup-points">+10 points</div></>
            )}

            <div className="popup-scores">
              <div className="popup-score-row"><span>{myName}</span><span className="popup-score-val">{myScore} pts</span></div>
              <div className="popup-score-row"><span>{opponentName}</span><span className="popup-score-val">{oppScore} pts</span></div>
            </div>

            {iVoted === 'next' && !opponentVotedNext && <div className="popup-waiting">Waiting for {opponentName}…</div>}
            {opponentVotedNext && !iVoted && <div className="popup-waiting">{opponentName} wants to continue!</div>}
            {iVoted === 'exit' && <div className="popup-waiting">Leaving…</div>}

            {!iVoted && (
              <div className="popup-actions">
                {round < TOTAL_ROUNDS ? (
                  <button className="button full" onClick={sendNextRound}>Next Round ({round + 1}/{TOTAL_ROUNDS})</button>
                ) : (
                  <>
                    <div className="popup-final">
                      {myScore > oppScore ? '🎉 You won the series!' : myScore < oppScore ? `${opponentName} won the series` : 'Series tied!'}
                    </div>
                    <button className="button full" onClick={sendNextRound}>Play Again</button>
                  </>
                )}
                <button className="button secondary full" onClick={sendExit}>Exit to Lobby</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Leaderboard Modal ── */}
      {showLeaderboard && (
        <div className="popup-overlay" onClick={() => setShowLeaderboard(false)}>
          <div className="popup" onClick={e => e.stopPropagation()}>
            <div className="popup-title">🏆 Leaderboard</div>
            {leaderboard.length === 0 ? (
              <div className="popup-sub">No records yet. Play some games!</div>
            ) : (
              <div className="lb-table">
                <div className="lb-row lb-header">
                  <span>#</span><span>Player</span><span>Score</span>
                </div>
                {leaderboard.map((e, i) => (
                  <div key={i} className={`lb-row${e.username === username ? ' lb-me' : ''}`}>
                    <span>{e.rank}</span>
                    <span>{e.username}</span>
                    <span>{e.score}</span>
                  </div>
                ))}
              </div>
            )}
            <button className="button secondary full" onClick={() => setShowLeaderboard(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
