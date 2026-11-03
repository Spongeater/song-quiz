'use strict';
/* Song Quiz — static site, host-authoritative multiplayer over WebRTC (PeerJS). */

const PFX = 'songquiz-', CLIP = 30, REVEAL = 8000, NORM_REF = -14, SIM_ALBUM = 12, SIM_ARTIST = 6, HARD_ALBUM = 60, HARD_ARTIST = 25;
// Wrong-option weights (an unrelated song = 1; higher = more likely to be picked). SIM_* is the normal mode, HARD_* is hard mode.   // NORM_REF: loudness (dB) that louder tracks are turned down to
const ICE = { config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] } };
const PROMPT = { title: "What's the title of this song?", artist: 'Who performs this song?', album: 'Which album is this song from?', cover: 'Which album cover belongs to this song?' };
const SIL = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAABErAAABAAgAZGF0YQAAAAA=';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const el = (t, txt, cls) => { const n = document.createElement(t); if (txt != null) n.textContent = txt; if (cls) n.className = cls; return n; };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const norm = s => (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]|\s-\s.*$/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const safe = u => /^https?:\/\//.test(u || '') ? u : '';
let cur = 'home';
const show = id => { $$('.screen').forEach(s => s.hidden = s.id !== id); cur = id; };
const status = (t, bad) => { const s = $('#status'); s.textContent = t || ''; s.style.color = bad ? 'var(--bad)' : ''; };

/* ---------------- Deezer (JSONP: the Deezer API has no CORS) ---------------- */
let jc = 0;
function jsonp(url) {
  return new Promise((res, rej) => {
    const cb = '__dz' + Date.now() + (jc++), s = document.createElement('script');
    const done = () => { clearTimeout(t); delete window[cb]; s.remove(); };
    const t = setTimeout(() => { done(); rej(new Error('Deezer timed out')); }, 12000);
    window[cb] = d => { done(); res(d); };
    s.onerror = () => { done(); rej(new Error('Could not reach Deezer')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + cb;
    document.head.append(s);
  });
}
const dz = t => ({ id: 'd' + t.id, src: 'dz', dz: t.id, title: t.title_short || t.title, artist: t.artist?.name || '', album: t.album?.title || '', cover: t.album?.cover_medium || t.album?.cover || '', url: t.preview });
async function playlist(id) {
  const out = [];
  for (let i = 0; out.length < 2000; i += 100) {
    const d = await jsonp(`https://api.deezer.com/playlist/${id}/tracks?limit=100&index=${i}`);
    if (d.error) throw new Error(`Playlist ${id}: ${d.error.message || 'not found or private'}`);
    (d.data || []).forEach(t => t.preview && out.push(dz(t)));
    if (!d.next || !(d.data || []).length) break;
  }
  return out;
}

/* ---------------- Custom songs from the repo (custom-songs.json) ---------------- */
async function custom() {
  const r = await fetch('custom-songs.json', { cache: 'no-store' });
  if (!r.ok) throw new Error('custom-songs.json not found');
  return (await r.json()).filter(s => s && s.title && s.file).map((s, i) => ({
    id: 'c' + i, src: 'c', title: s.title, artist: s.artist || '', album: s.album || '',
    cover: s.cover ? new URL(s.cover, location.href).href : '',
    url: new URL(s.file, location.href).href, start: typeof s.start === 'number' ? s.start : null
  }));
}

/* ---------------- Artist aliases (artist-aliases.json) ----------------
   { "ye": "Kanye West" } renames that artist for every song (Deezer and custom) before the game uses it.
   The whole artist name must match, ignoring capitalization, accents and extra spaces. */
const akey = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
async function aliases() {
  const r = await fetch('artist-aliases.json', { cache: 'no-store' }).catch(() => null);
  if (!r || !r.ok) return {};                       // file is optional
  let o; try { o = await r.json(); } catch { throw new Error('artist-aliases.json is not valid JSON.'); }
  const m = {};
  for (const k in o) if (typeof o[k] === 'string' && o[k].trim()) m[akey(k)] = o[k].trim();
  return m;
}

/* ---------------- Host state ---------------- */
const G = { players: new Map(), conns: new Map(), pool: [], key: null, info: '', st: {}, phase: 'lobby', qs: [], qi: -1, r: null, code: '' };
const me = { id: null, name: '', host: false };
let peer, guest, leaving = false, tm, rt, ans = false, qo = {};   // qo = current question's options (to show wrong picks)

const readSt = () => ({ source: $('#source').value, pl: $('#pl').value, rounds: Math.max(1, parseInt($('#rounds').value) || 10), secs: +$('#secs').value, types: $$('.qt:checked').map(c => c.value), hard: $('#hard').checked, norm: $('#norm').checked });

async function loadPool(st) {
  let songs = [], nd = 0, nc = 0;
  if (st.source !== 'custom') {
    const ids = [...st.pl.matchAll(/playlist\/(\d+)|^\s*(\d{4,})\s*$/gm)].map(m => m[1] || m[2]);
    if (!ids.length && st.source === 'playlist') throw new Error('Paste a full Deezer playlist URL (deezer.com/…/playlist/ID). Short share links are not supported.');
    for (const id of ids) { status(`Loading playlist ${id}…`); songs.push(...await playlist(id)); }
    nd = songs.length;
  }
  if (st.source !== 'playlist') {
    try { const c = await custom(); songs.push(...c); nc = c.length; } catch (e) { if (st.source === 'custom') throw e; }
  }
  const al = await aliases();
  songs.forEach(s => { const a = al[akey(s.artist)]; if (a) s.artist = a; });
  const seen = new Set();
  songs = songs.filter(s => { const k = norm(s.title) + '|' + norm(s.artist); return !seen.has(k) && seen.add(k); });
  if (songs.length < 4) throw new Error('Need at least 4 songs in the pool.');
  songs.forEach(s => { s._a = norm(s.artist); s._b = s.album ? s._a + '|' + norm(s.album) : ''; }); G.pool = songs; G.key = st.source + st.pl; G.info = `${songs.length} songs (${nd} Deezer, ${nc} custom)`;
}

/* ---------------- Question building ---------------- */
function distract(song, t, pool, hard) {
  const seen = new Set([norm(song[t])]), out = [];
  let list;
  if (t !== 'artist' && song._a) {
    // Weighted random order: same-album songs (title questions only) and same-artist songs/albums/covers get a
    // higher chance of landing early, but nothing is guaranteed (Efraimidis-Spirakis weighted shuffle).
    // Hard mode just uses much bigger weights.
    const [wAlb, wArt] = hard ? [HARD_ALBUM, HARD_ARTIST] : [SIM_ALBUM, SIM_ARTIST];
    const w = s => t === 'title' && song._b && s._b === song._b ? wAlb : s._a === song._a ? wArt : 1;
    list = pool.map(s => ({ s, k: Math.random() ** (1 / w(s)) })).sort((a, b) => b.k - a.k).map(x => x.s);
  } else list = shuffle(pool.slice());
  for (const s of list) {
    const v = s[t];
    if (!v || seen.has(norm(v))) continue;
    seen.add(norm(v)); out.push(v);
    if (out.length === 3) return out;
  }
  return null;
}
function pick(pool, st, n) {
  const out = [], used = {}; st.types.forEach(t => used[t] = 0);
  for (const s of shuffle(pool.slice())) {
    if (out.length >= n) break;
    const ts = shuffle(st.types.filter(t => s[t])).sort((a, b) => used[a] - used[b]);
    for (const t of ts) {
      const d = distract(s, t, pool, st.hard); if (!d) continue;
      const o = shuffle([s[t], ...d]);
      out.push({ song: s, type: t, options: o, correct: o.indexOf(s[t]) }); used[t]++; break;
    }
  }
  return out;
}
async function prep(q) {            // fresh Deezer preview URL / random 30s window for custom files
  const s = q.song; q.url = s.url; q.start = 0; q.gain = null;
  if (s.src === 'dz') { try { const d = await jsonp('https://api.deezer.com/track/' + s.dz); if (d.preview) q.url = d.preview; if (G.st.norm && typeof d.gain === 'number') q.gain = d.gain; } catch { } return q; }
  const dur = await new Promise(r => {
    const a = new Audio(); a.preload = 'metadata';
    const t = setTimeout(() => r(null), 8000);
    a.onloadedmetadata = () => { clearTimeout(t); r(a.duration || 0); };
    a.onerror = () => { clearTimeout(t); r(null); };
    a.src = s.url;
  });
  if (dur === null) return null;    // missing/broken file: drop it
  q.start = s.start != null ? s.start : dur > CLIP + 10 ? Math.round(dur * .1 + Math.random() * Math.max(0, dur - CLIP - 5 - dur * .1)) : 0;
  if (G.st.norm) q.gain = await loud(s.url, q.start);
  return q;
}

/* Approximate loudness (RMS dB) of a custom file's clip. Runs one file at a time to limit memory. */
let actx, lq = Promise.resolve();
const loud = (url, start) => { const job = lq.then(() => loudness(url, start)); lq = job.catch(() => { }); return job; };
async function loudness(url, start) {
  try {
    const buf = await (await fetch(url)).arrayBuffer();
    if (buf.byteLength > 30e6) return null;
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const ab = await actx.decodeAudioData(buf), sr = ab.sampleRate, a = Math.floor(start * sr), b = Math.min(ab.length, a + CLIP * sr);
    let sum = 0, n = 0;
    for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = a; i < b; i++) sum += d[i] * d[i]; n += Math.max(0, b - a); }
    return n && sum ? 10 * Math.log10(sum / n) : null;
  } catch { return null; }
}

/* ---------------- Host networking & game flow ---------------- */
const send = (c, m) => c.open && c.send(m);
function all(m) { G.conns.forEach(c => send(c, m)); onMsg(m); }
function lobbyMsg() {
  const { source, rounds, secs, types, hard, norm } = G.st;
  return { t: 'lobby', code: G.code, phase: G.phase, st: { source, rounds, secs, types, hard, norm }, info: G.info,
    players: [...G.players.values()].map(p => ({ name: p.name, host: p.id === 'host', gone: !!p.gone })) };
}
function startHost(code) {
  G.code = code; me.id = 'host'; me.host = true; G.st = readSt();
  G.players.set('host', { id: 'host', name: me.name, score: 0 });
  peer.on('connection', c => { c.on('data', m => hostMsg(c, m)); c.on('close', () => drop(c)); c.on('error', () => drop(c)); });
  peer.on('disconnected', () => peer.reconnect());
  $('#host').hidden = false; $('#guestInfo').hidden = true;
  all(lobbyMsg());
}
function hostMsg(c, m) {
  const id = c.peer;
  if (m.t === 'join' && !G.players.has(id)) {
    if (G.players.size >= 12) { send(c, { t: 'no', why: 'Room is full.' }); return; }
    const n = String(m.name || 'Player').slice(0, 20); let k = n, i = 2;
    while ([...G.players.values()].some(p => p.name === k)) k = n + ' ' + i++;
    G.conns.set(id, c); G.players.set(id, { id, name: k, score: 0 });
    send(c, { t: 'hi' }); all(lobbyMsg());
  } else if (m.t === 'ans') answer(id, m.n, m.c);
}
function drop(c) {
  const p = G.players.get(c.peer); G.conns.delete(c.peer);
  if (!p) return;
  if (G.phase === 'lobby') G.players.delete(c.peer); else p.gone = 1;
  all(lobbyMsg()); chk();
}
const act = () => [...G.players.values()].filter(p => p.act && !p.gone);
const prog = () => ({ t: 'prog', done: act().filter(p => p.a).length, total: act().length });
function chk() { if (G.phase === 'playing' && G.r && !G.r.done && act().every(p => p.a)) setTimeout(endR, 500); }

async function startGame() {
  const b = $('#start'); b.disabled = true;
  try {
    G.st = readSt();
    if (!G.st.types.length) throw new Error('Pick at least one question type.');
    if (!G.pool.length || G.key !== G.st.source + G.st.pl) await loadPool(G.st);
    G.st.rounds = Math.min(G.st.rounds, G.pool.length); $('#rounds').value = G.st.rounds; $('#rounds').max = G.pool.length;
    const c = pick(G.pool, G.st, G.st.rounds + 6), ready = [];
    for (let i = 0; i < c.length && ready.length < G.st.rounds; i += 4) {
      const part = c.slice(i, i + 4), msg = `Preparing questions… ${Math.min(i + 4, c.length)}/${c.length}`;
      status(msg); all({ t: 'note', text: msg });
      (await Promise.all(part.map(prep))).forEach(q => q && ready.push(q));
      if (part.some(q => q.song.src === 'dz')) await new Promise(r => setTimeout(r, 450));   // stay under Deezer's rate limit
    }
    G.qs = ready.slice(0, G.st.rounds);
    if (!G.qs.length) throw new Error('Not enough songs with distinct titles/artists/albums for these question types.');
    G.paused = null; G.players.forEach(p => p.score = 0); G.phase = 'playing'; G.qi = -1; status(''); nextQ();
  } catch (e) { status(e.message, 1); all(lobbyMsg()); }
  b.disabled = false;
}
function nextQ() {
  if (++G.qi >= G.qs.length) return fin();
  const q = G.qs[G.qi];
  G.players.forEach(p => { p.a = 0; p.c = null; p.pts = 0; p.act = !p.gone; });
  G.r = { t0: Date.now(), done: false };
  all({ t: 'q', n: G.qi + 1, total: G.qs.length, prompt: PROMPT[q.type], kind: q.type, gain: q.gain, who: act().length, opts: q.options, url: q.url, start: q.start, secs: G.st.secs,
    board: [...G.players.values()].map(p => ({ id: p.id, name: p.name, score: p.score, gone: !!p.gone })).sort((a, b) => b.score - a.score) });
  G.r.timer = setTimeout(endR, G.st.secs * 1000 + 700);
}
function answer(id, n, c) {
  const p = G.players.get(id), q = G.qs[G.qi];
  if (G.paused || !p || !G.r || G.r.done || n !== G.qi + 1 || !p.act || p.a || !Number.isInteger(c) || c < 0 || c >= q.options.length) return;
  const e = Date.now() - G.r.t0, T = G.st.secs * 1000;
  if (e > T + 500) return;
  p.a = 1; p.c = c; p.pts = c === q.correct ? Math.round(500 + 500 * Math.max(0, 1 - e / T)) : 0;   // 500–1000, faster = more
  all(prog()); chk();
}
function endR() {
  if (!G.r || G.r.done || G.paused) return;
  G.r.done = true; clearTimeout(G.r.timer);
  const q = G.qs[G.qi], s = q.song;
  G.players.forEach(p => p.score += p.pts || 0);
  const res = [...G.players.values()].map(p => ({ id: p.id, name: p.name, c: p.a ? p.c : null, pts: p.pts || 0, score: p.score, gone: !!p.gone })).sort((a, b) => b.score - a.score);
  all({ t: 'rev', correct: q.correct, song: { title: s.title, artist: s.artist, album: s.album, cover: s.cover, src: s.src }, res, last: G.qi === G.qs.length - 1, ms: REVEAL });
  G.r.revealEnd = Date.now() + REVEAL; G.r.timer = setTimeout(nextQ, REVEAL);
}
/* Pause / resume (host only): freezes the question timer or the between-questions countdown for everyone */
function pauseGame() {
  if (G.phase !== 'playing' || !G.r || G.paused) return;
  clearTimeout(G.r.timer);
  const end = G.r.done ? G.r.revealEnd : G.r.t0 + G.st.secs * 1000 + 700;
  G.paused = { at: Date.now(), left: Math.max(0, end - Date.now()) };
  all({ t: 'pause', on: true });
}
function resumeGame() {
  if (!G.paused) return;
  const { at, left } = G.paused; G.paused = null;
  if (G.r.done) { G.r.revealEnd = Date.now() + left; G.r.timer = setTimeout(nextQ, left); }
  else { G.r.t0 += Date.now() - at; G.r.timer = setTimeout(endR, left); }   // paused time doesn't count against anyone
  all({ t: 'pause', on: false });
}
function fin() {
  G.phase = 'done';
  all({ t: 'fin', rank: [...G.players.values()].map(p => ({ name: p.name, score: p.score, gone: !!p.gone })).sort((a, b) => b.score - a.score) });
}

/* ---------------- Audio ---------------- */
const au = $('#player'); let tok = 0;
const go = () => au.play().then(() => $('#tap').hidden = true).catch(() => $('#tap').hidden = false);
function unlock() { au.src = SIL; au.play().catch(() => { }); }
function stop() { tok++; au.pause(); au.onloadedmetadata = au.ontimeupdate = null; }
function play(url, start) {
  stop(); const t = tok; $('#tap').hidden = true;
  au.onloadedmetadata = () => { if (t !== tok) return; if (start) au.currentTime = start; go(); };
  au.ontimeupdate = () => { if (au.currentTime >= start + CLIP) au.pause(); };
  au.src = url; au.load();
}
$('#tap').onclick = go;

/* Volume control (slider + mute), remembered in localStorage */
const vol = $('#vol'); let muted = false, nf = 1;   // nf = per-song loudness factor (<= 1)
vol.value = localStorage.sqvol != null ? localStorage.sqvol : 70;
function applyVol() {
  au.volume = Math.min(1, vol.value / 100 * nf); au.muted = muted;
  $('#volPct').textContent = muted ? 'Muted' : vol.value + '%';
  $('#mute').textContent = muted || +vol.value === 0 ? '🔇' : vol.value < 40 ? '🔉' : '🔊';
  localStorage.sqvol = vol.value;
}
vol.oninput = () => { muted = false; applyVol(); };
$('#mute').onclick = () => { muted = !muted; applyVol(); };
applyVol();

/* ---------------- Client: handle messages from the host (host handles its own too) ---------------- */
function onMsg(m) {
  switch (m.t) {
    case 'no': home(m.why); break;
    case 'note': status(m.text); break;
    case 'lobby': if (cur === 'home' || m.phase === 'lobby') lobbyUI(m); break;
    case 'q': question(m); break;
    case 'prog': $('#done').textContent = `${m.done}/${m.total}`; break;
    case 'pause': setPause(m.on); break;
    case 'rev': reveal(m); break;
    case 'fin': final(m); break;
  }
}
function lobbyUI(m) {
  stop(); show('lobby'); $('#roomCode').textContent = m.code;
  const ul = $('#players'); ul.replaceChildren();
  m.players.forEach(p => ul.append(el('li', (p.host ? '👑 ' : '') + p.name, p.gone ? 'gone' : '')));
  $('#pcount').textContent = `${m.players.length} / 12`;
  if (!me.host) {
    const s = m.st, T = { title: 'Title', artist: 'Artist', album: 'Album', cover: 'Album art' };
    const P = { both: 'Playlist + custom songs', playlist: 'Playlist only', custom: 'Custom songs only' };
    $('#guestInfo').hidden = false;
    $('#guestInfo').textContent = `Questions: ${s.rounds}\nTime per question: ${s.secs}s\nQuestion types: ${s.types.map(t => T[t]).join(', ') || 'none'}\nSong pool: ${P[s.source]}${m.info ? ' · ' + m.info : ''}\nHard mode: ${s.hard ? 'on' : 'off'}\nLoudness leveling: ${s.norm ? 'on' : 'off'}`;
    status(m.phase === 'lobby' ? 'Waiting for the host to start…' : 'A game is in progress — you will join from the next question.');
  } else if (m.phase === 'lobby' && G.info) status(G.info);
}
const lock = () => $$('#opts .opt').forEach(b => b.disabled = true);
function side(list) {   // sidebar standings + your score/rank tiles
  const ol = $('#side'); ol.replaceChildren();
  list.forEach((r, i) => {
    ol.append(el('li', `${r.name} — ${r.score}`, r.gone ? 'gone' : r.id === me.id ? 'me' : ''));
    if (r.id === me.id) { $('#myScore').textContent = r.score; $('#myRank').textContent = `#${i + 1} of ${list.length}`; }
  });
}
/* Client-side timers and pause handling */
let tcfg = null, rleft = 0, paused = false, pausedAt = 0, wasPlaying = false;
function startTimer(secs, t0) {
  clearInterval(tm); tcfg = { secs, t0 }; const f = $('#fill');
  tm = setInterval(() => {
    const l = Math.max(0, secs - (performance.now() - tcfg.t0) / 1000);
    f.style.width = l / secs * 100 + '%'; $('#timeLeft').textContent = Math.ceil(l) + 's';
    if (!l) { clearInterval(tm); lock(); }
  }, 100);
}
function countdown() {
  clearInterval(rt); const info = $('#nextIn'); info.textContent = `Next in ${rleft}s`;
  rt = setInterval(() => { info.textContent = --rleft > 0 ? `Next in ${rleft}s` : ''; }, 1000);
}
function setPause(on) {
  if (on === paused) return;
  paused = on; $('#pausedBanner').hidden = !on; $('#pause').textContent = on ? '▶ Resume' : '⏸ Pause';
  $('#game').classList.toggle('isPaused', on);
  if (on) {
    pausedAt = performance.now(); wasPlaying = !au.paused && !au.ended; au.pause();
    clearInterval(tm); clearInterval(rt);
  } else {
    if (wasPlaying) go();
    if (!$('#reveal').hidden) countdown();
    else if (tcfg) { tcfg.t0 += performance.now() - pausedAt; startTimer(tcfg.secs, tcfg.t0); }
  }
}
function question(m) {
  show('game'); clearInterval(tm); clearInterval(rt); ans = false;
  paused = false; $('#game').classList.remove('isPaused'); $('#pausedBanner').hidden = true; $('#pause').hidden = !me.host; $('#pause').textContent = '⏸ Pause';
  $('#reveal').hidden = true; $('#done').textContent = `0/${m.who}`;
  $('#qn').textContent = `${m.n} / ${m.total}`; $('#prompt').textContent = m.prompt;
  $('#opts').className = m.kind === 'cover' ? 'art' : ''; side(m.board); qo = { opts: m.opts, kind: m.kind };
  const o = $('#opts'); o.replaceChildren();
  m.opts.forEach((t, i) => {
    const b = el('button', m.kind === 'cover' ? null : t, 'opt');
    if (m.kind === 'cover') { const im = el('img'); im.src = safe(t); im.alt = 'Album cover option ' + (i + 1); b.append(im); }
    b.onclick = () => {
      if (ans || paused) return; ans = true; lock(); b.classList.add('pick');
      me.host ? answer('host', m.n, i) : guest.send({ t: 'ans', n: m.n, c: i });
    };
    o.append(b);
  });
  startTimer(m.secs, performance.now());
  nf = m.gain == null ? 1 : Math.max(0.15, Math.min(1, 10 ** ((NORM_REF - m.gain) / 20))); applyVol();
  play(safe(m.url), m.start || 0);
}
function reveal(m) {
  clearInterval(tm); lock();
  const mine = m.res.find(r => r.id === me.id), got = m.res.filter(r => r.c === m.correct).length;
  $('#result').textContent = !mine ? '' : mine.c === null ? `No answer. ${got}/${m.res.length} got it.`
    : mine.c === m.correct ? `Correct! +${mine.pts} points (${got}/${m.res.length} got it)` : `Wrong. ${got}/${m.res.length} got it.`;
  $('#result').className = 'result ' + (mine && mine.c === m.correct ? 'good' : 'miss');
  side(m.res);
  $$('#opts .opt').forEach((b, i) => { b.classList.toggle('ok', i === m.correct); b.classList.toggle('bad', !!mine && mine.c === i && i !== m.correct); });
  $('#reveal').hidden = false;
  const s = m.song; $('#sTitle').textContent = s.title; $('#sArtist').textContent = s.artist; $('#sAlbum').textContent = s.album || 'Unknown album'; $('#sSrc').textContent = s.src === 'c' ? 'Custom song' : 'Deezer preview';
  const cv = $('#cover'); cv.src = safe(s.cover); cv.hidden = !s.cover;
  const bd = $('#board'); bd.replaceChildren();
  const hd = el('tr'); ['#', 'Player', '', 'Wrong pick', 'Pts', 'Total'].forEach(v => hd.append(el('th', v))); bd.append(hd);
  m.res.forEach((r, i) => {
    const tr = el('tr', null, r.gone ? 'gone' : r.id === me.id ? 'me' : '');
    [i + 1, r.name, r.c === null ? '–' : r.c === m.correct ? '✓' : '✗'].forEach(v => tr.append(el('td', v)));
    const pk = el('td'), pick = r.c !== null && r.c !== m.correct ? (qo.opts || [])[r.c] : null;   // what a wrong player chose
    if (pick) {
      if (qo.kind === 'cover') { const im = el('img', null, 'pickimg'); im.src = safe(pick); im.alt = 'Picked cover'; pk.append(im); }
      else { pk.textContent = pick; pk.title = pick; }
    } else if (r.c === null) pk.textContent = 'no answer';
    tr.append(pk);
    [r.pts ? '+' + r.pts : '', r.score].forEach(v => tr.append(el('td', v)));
    bd.append(tr);
  });
  const nx = $('#next'); nx.hidden = !me.host; nx.textContent = m.last ? 'Final results ▶' : 'Next ▶';
  rleft = Math.round(m.ms / 1000); if (!paused) countdown();
}
function final(m) {
  clearInterval(tm); clearInterval(rt); stop(); paused = false; show('final');
  const l = $('#rank'); l.replaceChildren();
  m.rank.forEach((r, i) => l.append(el('li', `${['🥇', '🥈', '🥉'][i] || (i + 1) + '.'} ${r.name} — ${r.score}`, r.gone ? 'gone' : '')));
  $('#again').hidden = !me.host;
  $('#winner').textContent = m.rank[0] ? `🏆 ${m.rank[0].name} wins with ${m.rank[0].score} points!` : '';
}

/* ---------------- UI wiring ---------------- */
function home(msg) { leaving = true; sessionStorage.sqerr = msg || ''; try { peer && peer.destroy(); } catch { } location.href = location.pathname; }
function getName() {
  const n = $('#name').value.trim().slice(0, 20);
  if (!n) { $('#err').textContent = 'Enter a name first.'; return null; }
  localStorage.sqname = n; me.name = n; unlock(); return n;
}
function mk(a) {
  const code = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.random() * 32 | 0]).join('');
  peer = new Peer(PFX + code, ICE);
  peer.on('open', () => startHost(code));
  peer.on('error', e => { if (e.type === 'unavailable-id' && a < 5) mk(a + 1); else home('Connection error: ' + e.type); });
}
$('#create').onclick = () => { if (getName()) mk(0); };
$('#join').onclick = () => {
  const c = $('#code').value.trim().toUpperCase();
  if (!getName()) return;
  if (!c) { $('#err').textContent = 'Enter a room code.'; return; }
  peer = new Peer(ICE);
  peer.on('open', id => {
    me.id = id; guest = peer.connect(PFX + c, { reliable: true, serialization: 'json' });
    const to = setTimeout(() => { if (!guest.open) home('Could not connect to that room.'); }, 12000);
    guest.on('open', () => { clearTimeout(to); guest.send({ t: 'join', name: me.name }); });
    guest.on('data', onMsg);
    guest.on('close', () => !leaving && home('Disconnected from the host.'));
  });
  peer.on('error', e => home(e.type === 'peer-unavailable' ? 'Room not found.' : 'Connection error: ' + e.type));
};
$('#start').onclick = startGame;
$('#load').onclick = async () => {
  const b = $('#load'); b.disabled = true;
  try {
    G.st = readSt(); status('Loading songs…'); await loadPool(G.st);
    $('#rounds').max = G.pool.length; all(lobbyMsg()); status(`${G.info}. You can play up to ${G.pool.length} questions.`);
  } catch (e) { status(e.message, 1); }
  b.disabled = false;
};
$('#pause').onclick = () => G.paused ? resumeGame() : pauseGame();
$('#next').onclick = () => { if (G.r && G.r.done && !G.paused) { clearTimeout(G.r.timer); nextQ(); } };
$('#again').onclick = () => { G.players.forEach((p, id) => p.gone && G.players.delete(id)); G.phase = 'lobby'; G.paused = null; all(lobbyMsg()); };
$('#host').addEventListener('change', () => { G.st = readSt(); all(lobbyMsg()); localStorage.sqpl = $('#pl').value; });
$('#copy').onclick = () => {
  const u = location.origin + location.pathname + '?room=' + $('#roomCode').textContent;
  navigator.clipboard ? navigator.clipboard.writeText(u).then(() => $('#copy').textContent = 'Copied!') : prompt('Invite link', u);
};
window.addEventListener('beforeunload', () => { leaving = true; try { peer && peer.destroy(); } catch { } });

$('#name').value = localStorage.sqname || '';
$('#pl').value = localStorage.sqpl || '';
$('#code').value = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
$('#err').textContent = sessionStorage.sqerr || ''; sessionStorage.removeItem('sqerr');
