'use strict';
/* ============================================================
   Mia · 随时英语老师
   纯前端 PWA · Gemini API · 数据全部保存在本机 localStorage
   ============================================================ */

const $ = s => document.querySelector(s);

/* ---------------- 存储 ---------------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('本地存储已满,建议导出后清理旧数据'); } },
};

const DEFAULTS = {
  apiKey: '', model: 'gemini-3.5-flash', customModel: '',
  autoSpeak: true, handsfree: true, rate: 0.95,
  level: 'B2', interests: '', mode: -1,
};
let S = Object.assign({}, DEFAULTS, store.get('et_settings', {}));
let profile = store.get('et_profile', { level: S.level, weaknesses: [], interests: [], recycle: [] });
let days = store.get('et_days', {});  // { 'YYYY-MM-DD': {msgs, notes, summary, topics} }

const saveS = () => store.set('et_settings', S);
const saveProfile = () => store.set('et_profile', profile);
const saveDays = () => store.set('et_days', days);

const fmtKey = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const todayKey = () => fmtKey(new Date());
function day(k) {
  k = k || todayKey();
  if (!days[k]) days[k] = { msgs: [], notes: [], summary: '', topics: [] };
  return days[k];
}

/* ---------------- 小工具 ---------------- */
let toastTimer = null;
function toast(msg, ms) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms || 2800);
}

const READY_TXT = '点 🎤 开始聊天';
function setState(state, txt) {
  document.body.dataset.state = state;
  const map = { idle: READY_TXT, listening: '我在听…', thinking: '正在思考…', speaking: '正在说话…' };
  $('#status').textContent = txt || map[state] || '';
}

function looseJson(s) {
  s = String(s).trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (e) { return { __raw: s }; }
}

/* ---------------- 语音朗读 (TTS) ---------------- */
const tts = {
  voice: null, unlocked: false, onDone: null,
  init() {
    const pick = () => {
      const vs = (speechSynthesis.getVoices() || []);
      if (!vs.length) return;
      const pref = ['Google US English', 'Samantha', 'Aria', 'Jenny', 'Ava', 'Allison', 'Karen', 'Daniel'];
      let v = null;
      for (const p of pref) { v = vs.find(x => x.name && x.name.indexOf(p) >= 0 && x.lang.indexOf('en') === 0); if (v) break; }
      if (!v) v = vs.find(x => /^en[-_](US|GB)/i.test(x.lang)) || vs.find(x => x.lang && x.lang.indexOf('en') === 0);
      this.voice = v || null;
    };
    pick();
    if (window.speechSynthesis) speechSynthesis.onvoiceschanged = pick;
  },
  unlock() {  // iOS 需要在用户手势内先“激活”一次
    if (this.unlocked || !window.speechSynthesis) return;
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); this.unlocked = true; } catch (e) {}
  },
  speakable(t) {
    // 去掉中文与全角符号,TTS 只读英文部分
    return String(t)
      .replace(/[　-〿一-鿿＀-￯“”‘’…—·]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  },
  speak(text, onDone) {
    this.stop();
    this.onDone = onDone || null;
    const sp = this.speakable(text);
    if (!window.speechSynthesis || sp.length < 2) { this.finish(); return; }
    const parts = sp.match(/[^.!?]+[.!?]*\s*/g) || [sp];
    const chunks = []; let cur = '';
    for (const p of parts) {
      if ((cur + p).length > 180) { if (cur.trim()) chunks.push(cur); cur = p; }
      else cur += p;
    }
    if (cur.trim()) chunks.push(cur);
    let i = 0;
    const next = () => {
      if (i >= chunks.length) { this.finish(); return; }
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      if (this.voice) u.voice = this.voice;
      u.lang = (this.voice && this.voice.lang) || 'en-US';
      u.rate = S.rate;
      u.onend = next; u.onerror = next;
      speechSynthesis.speak(u);
    };
    setState('speaking');
    next();
  },
  finish() {
    if (document.body.dataset.state === 'speaking') setState('idle');
    const cb = this.onDone; this.onDone = null;
    if (cb) cb();
  },
  stop() { this.onDone = null; try { speechSynthesis.cancel(); } catch (e) {} },
};

/* ---------------- 录音 (WAV) ---------------- */
const rec = {
  stream: null, ctx: null, node: null, srcNode: null, gain: null,
  chunks: [], sampleRate: 48000, active: false, spoke: false,
  lastLoud: 0, startT: 0, vadOn: false,
  async start() {
    this.chunks = []; this.spoke = false;
    this.startT = performance.now(); this.lastLoud = this.startT;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    await this.ctx.resume();
    this.sampleRate = this.ctx.sampleRate;
    this.srcNode = this.ctx.createMediaStreamSource(this.stream);

    const onChunk = data => {
      if (!this.active) return;
      this.chunks.push(data);
      let s = 0, n = 0;
      for (let i = 0; i < data.length; i += 16) { s += data[i] * data[i]; n++; }
      const rms = Math.sqrt(s / Math.max(1, n));
      const now = performance.now();
      if (rms > 0.022) { this.spoke = true; this.lastLoud = now; }
      document.documentElement.style.setProperty('--lvl', Math.min(1, rms * 9).toFixed(2));
      if (this.vadOn) {
        if (this.spoke && now - this.lastLoud > 1500) { stopAndSend(); return; }
        if (!this.spoke && now - this.startT > 8000) { cancelRec('我没听到声音,点 🎤 再试一次'); return; }
      }
      if (now - this.startT > 60000) stopAndSend();
    };

    let ok = false;
    try {
      const code = "class Cap extends AudioWorkletProcessor{process(inputs){const c=inputs[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('cap',Cap)";
      await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
      this.node = new AudioWorkletNode(this.ctx, 'cap');
      this.node.port.onmessage = e => onChunk(e.data);
      ok = true;
    } catch (e) { /* 回退到 ScriptProcessor */ }
    if (!ok) {
      const sp = this.ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = e => onChunk(e.inputBuffer.getChannelData(0).slice(0));
      this.node = sp;
    }
    this.gain = this.ctx.createGain(); this.gain.gain.value = 0;
    this.srcNode.connect(this.node);
    this.node.connect(this.gain);
    this.gain.connect(this.ctx.destination);
    this.active = true;
  },
  teardown() {
    this.active = false;
    try { this.srcNode && this.srcNode.disconnect(); } catch (e) {}
    try { this.node && this.node.disconnect(); } catch (e) {}
    try { this.gain && this.gain.disconnect(); } catch (e) {}
    try { this.stream && this.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    try { this.ctx && this.ctx.close(); } catch (e) {}
    this.stream = this.ctx = this.node = this.srcNode = this.gain = null;
    document.documentElement.style.setProperty('--lvl', 0);
  },
  finish() {  // -> {b64, sec} | null
    const chunks = this.chunks; this.chunks = [];
    const srcRate = this.sampleRate;
    this.teardown();
    const total = chunks.reduce((a, c) => a + c.length, 0);
    if (!total) return null;
    let pcm = new Float32Array(total); let o = 0;
    for (const c of chunks) { pcm.set(c, o); o += c.length; }
    const target = 16000;
    let rate = Math.round(srcRate);
    if (srcRate > target + 50) {  // 线性重采样到 16k,减小体积
      const ratio = srcRate / target, n = Math.floor(pcm.length / ratio), out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = i * ratio, i0 = Math.floor(x), frac = x - i0;
        const a = pcm[i0], b = pcm[Math.min(i0 + 1, pcm.length - 1)];
        out[i] = a + (b - a) * frac;
      }
      pcm = out; rate = target;
    }
    const sec = pcm.length / rate;
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const wstr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    wstr(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    let off = 44;
    for (let i = 0; i < pcm.length; i++, off += 2) {
      const x = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
    }
    const bytes = new Uint8Array(buf);
    let bin = ''; const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return { b64: btoa(bin), sec };
  },
};

/* ---------------- Gemini API ---------------- */
const API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const modelName = () => (S.model === 'custom' ? (S.customModel || 'gemini-3.5-flash') : S.model);

const TURN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING' },
    reply: { type: 'STRING' },
    fix: { type: 'OBJECT', properties: { orig: { type: 'STRING' }, better: { type: 'STRING' }, zh: { type: 'STRING' } } },
    notes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { term: { type: 'STRING' }, type: { type: 'STRING' }, zh: { type: 'STRING' }, example: { type: 'STRING' } },
        required: ['term', 'zh'],
      },
    },
  },
  required: ['transcript', 'reply', 'notes'],
};

const SUM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    topics: { type: 'ARRAY', items: { type: 'STRING' } },
    profile: {
      type: 'OBJECT',
      properties: {
        level: { type: 'STRING' },
        weaknesses: { type: 'ARRAY', items: { type: 'STRING' } },
        interests: { type: 'ARRAY', items: { type: 'STRING' } },
        recycle: { type: 'ARRAY', items: { type: 'STRING' } },
      },
    },
  },
  required: ['summary', 'topics'],
};

// 不同时期的 API 对结构化输出的字段名不同,逐个尝试并记住可用的那种
function genCfg(mode, schema) {
  if (mode === 0) return { responseFormat: { text: { mimeType: 'application/json' } }, responseSchema: schema, temperature: 0.8 };
  if (mode === 1) return { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.8 };
  return { temperature: 0.8 };
}

async function gemini(systemText, contents, schema) {
  if (!S.apiKey) { const e = new Error('NOKEY'); e.code = 'NOKEY'; throw e; }
  const order = S.mode >= 0 ? [S.mode, 0, 1, 2].filter((m, i, a) => a.indexOf(m) === i) : [0, 1, 2];
  let lastErr = null;
  for (const m of order) {
    const body = {
      systemInstruction: { parts: [{ text: systemText }] },
      contents,
      generationConfig: genCfg(m, schema),
    };
    let res;
    try {
      res = await fetch(API + modelName() + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': S.apiKey },
        body: JSON.stringify(body),
      });
    } catch (e) { const er = new Error('NET'); er.code = 'NET'; throw er; }
    if (res.status === 400) {
      const j = await res.json().catch(() => ({}));
      const msg = (j.error && j.error.message) || '';
      if (/api key/i.test(msg)) { const er = new Error('KEY'); er.code = 'KEY'; throw er; }
      lastErr = new Error(msg || 'BAD'); lastErr.code = 'BAD';
      continue;  // 换一种 generationConfig 写法再试
    }
    if (res.status === 401 || res.status === 403) { const er = new Error('KEY'); er.code = 'KEY'; throw er; }
    if (res.status === 404) { const er = new Error('MODEL'); er.code = 'MODEL'; throw er; }
    if (res.status === 429) { const er = new Error('RATE'); er.code = 'RATE'; throw er; }
    if (!res.ok) { lastErr = new Error('HTTP ' + res.status); lastErr.code = 'HTTP'; continue; }
    const j = await res.json();
    const cand = (j.candidates || [])[0] || {};
    const txt = ((cand.content || {}).parts || []).map(p => p.text || '').join('');
    if (!txt) {
      const er = new Error(cand.finishReason === 'SAFETY' ? 'SAFETY' : 'EMPTY');
      er.code = er.message; throw er;
    }
    if (S.mode !== m) { S.mode = m; saveS(); }
    return looseJson(txt);
  }
  throw lastErr || Object.assign(new Error('FAIL'), { code: 'FAIL' });
}

function handleErr(e) {
  const c = e.code || e.message || '';
  if (c === 'NOKEY') { toast('请先在设置里填入 Gemini API Key'); openSettings(); }
  else if (c === 'KEY') { toast('API Key 无效,请在设置里检查'); openSettings(); }
  else if (c === 'RATE') toast('免费额度限速了,歇 20 秒再说一句 🙂 (若整天受限,设置里换 flash-lite 模型)', 4200);
  else if (c === 'MODEL') toast('当前模型不可用,去设置里换一个模型');
  else if (c === 'NET') toast('网络不通,请检查网络');
  else if (c === 'SAFETY') toast('这句被安全策略拦下了,换个说法试试');
  else toast('出错了: ' + (e.message || c));
  setState('idle');
}

/* ---------------- 上下文构建 ---------------- */
function recentSummaries() {
  const keys = Object.keys(days).filter(k => k !== todayKey() && days[k].summary).sort().slice(-2);
  return keys.map(k => '- ' + k + ': ' + days[k].summary).join('\n') || 'none yet';
}

function buildSystem() {
  const recycle = (profile.recycle || []).slice(0, 6).join(', ') || 'none yet';
  const weak = (profile.weaknesses || []).slice(0, 5).join('; ') || 'not known yet';
  const ints = S.interests || (profile.interests || []).join(', ') || 'not specified';
  return [
    'You are Mia, a warm, endlessly patient English tutor inside a voice-chat app. The learner is a native Chinese speaker, CEFR level ' + S.level + '.',
    '',
    'RULES',
    '1. Chat in natural everyday English, calibrated slightly above the learner\'s level. Keep replies SHORT: 2-4 spoken-style sentences, then exactly ONE question to keep the conversation going.',
    '2. If the learner speaks Chinese (usually asking how to express something, or about a word/grammar), answer that question first - explain briefly, Chinese allowed for the explanation - give the English expression and one example sentence, then steer back to English conversation.',
    '3. When the learner makes a meaningful mistake, recast it naturally in the "fix" field (orig = what they said, better = natural version, zh = one short Chinese note on why). Do not nitpick small slips. Otherwise omit "fix" or set it to null.',
    '4. Teach actively: each turn, put at most 3 genuinely useful items you used or discussed into "notes" (new words, collocations, phrases, grammar points at their level). No trivial words.',
    '5. Naturally recycle these earlier items when it fits: ' + recycle + '.',
    '6. Learner profile - interests: ' + ints + '; recurring weaknesses: ' + weak + '.',
    '   Recent sessions:\n' + recentSummaries(),
    '   Build on previous sessions, do not repeat them. Vary topics; follow the learner\'s lead.',
    '7. The latest user turn may be AUDIO. Transcribe it verbatim into "transcript" (keep Chinese parts in Chinese). If typed text, copy it into "transcript". If audio is empty or unintelligible, set transcript to "" and kindly ask them to say it again.',
    '',
    'OUTPUT: strict JSON only, no markdown, exactly this shape:',
    '{"transcript": string, "reply": string, "fix": {"orig": string, "better": string, "zh": string} | null, "notes": [{"term": string, "type": "word"|"phrase"|"grammar", "zh": string, "example": string}]}',
    '"reply" is read aloud by TTS: plain words only - no markdown, no emoji, no stage directions. Chinese inside "reply" only when rule 2 applies, kept brief.',
  ].join('\n');
}

function buildContents(userParts) {
  const t = day();
  const hist = t.msgs.slice(-16);
  const contents = [];
  for (const m of hist) contents.push({ role: m.r === 'u' ? 'user' : 'model', parts: [{ text: m.t }] });
  contents.push({ role: 'user', parts: userParts });
  return contents;
}

/* ---------------- 聊天界面 ---------------- */
function addBubble(role, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.textContent = text;
  if (role === 't') {
    el.title = '点一下重新朗读';
    el.addEventListener('click', () => { tts.unlock(); tts.speak(el.dataset.full || el.textContent, afterSpeakManual); });
  }
  $('#chat').appendChild(el);
  $('#chat').scrollTop = $('#chat').scrollHeight;
  return el;
}
function setBubbleText(el, t) { el.textContent = t; }
function attachFix(el, fix) {
  const d = document.createElement('div');
  d.className = 'fix';
  d.textContent = '✏️ ' + fix.better;
  const z = document.createElement('div');
  z.className = 'zhline'; z.textContent = fix.zh || '';
  d.appendChild(z);
  d.addEventListener('click', ev => { ev.stopPropagation(); tts.unlock(); tts.speak(fix.better); });
  el.appendChild(d);
  $('#chat').scrollTop = $('#chat').scrollHeight;
}
function sysline(t) {
  const el = document.createElement('div');
  el.className = 'sysline'; el.textContent = t;
  $('#chat').appendChild(el);
  $('#chat').scrollTop = $('#chat').scrollHeight;
}

function renderChat() {
  const c = $('#chat'); c.innerHTML = '';
  const t = day();
  for (const m of t.msgs) {
    const el = addBubble(m.r, m.t);
    if (m.r === 'u' && m.fix && m.fix.better) attachFix(el, m.fix);
  }
}

/* ---------------- 笔记 ---------------- */
function normType(t) {
  t = String(t || '').toLowerCase();
  if (t.indexOf('gram') >= 0) return 'grammar';
  if (t.indexOf('phr') >= 0 || t.indexOf('expr') >= 0 || t.indexOf('idiom') >= 0 || t.indexOf('coll') >= 0) return 'phrase';
  return 'word';
}
function chipEl(n) {
  const b = document.createElement('button');
  b.className = 'chip';
  const dot = document.createElement('span');
  dot.className = 'dot ' + n.type;
  b.appendChild(dot);
  b.appendChild(document.createTextNode(n.term));
  b.addEventListener('click', () => showSheet(n));
  return b;
}
function renderNotesToday() {
  const t = day();
  const wrap = $('#notesChips'); wrap.innerHTML = '';
  if (!t.notes.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = '聊天中提到的词汇、表达和语法会自动记在这里,点一下可以看解释。';
    wrap.appendChild(d);
  } else {
    for (let i = t.notes.length - 1; i >= 0; i--) wrap.appendChild(chipEl(t.notes[i]));
  }
  $('#notesCount').textContent = t.notes.length;
}
function addNotes(arr) {
  if (!Array.isArray(arr)) return;
  const t = day();
  for (const n of arr) {
    const term = n && n.term && String(n.term).trim();
    if (!term) continue;
    if (t.notes.some(x => x.term.toLowerCase() === term.toLowerCase())) continue;
    t.notes.push({ term, type: normType(n.type), zh: String(n.zh || '').trim(), example: String(n.example || '').trim() });
  }
  renderNotesToday();
}

let sheetNote = null;
function showSheet(n) {
  sheetNote = n;
  $('#shTerm').textContent = n.term;
  $('#shType').textContent = { word: '单词', phrase: '短语 / 表达', grammar: '语法' }[n.type] || n.type;
  $('#shZh').textContent = n.zh || '(暂无中文释义)';
  $('#shExample').textContent = n.example ? '例句: ' + n.example : '';
  $('#sheet').hidden = false;
}

/* ---------------- 发送一轮对话 ---------------- */
let busy = false;
function updateMicUI() {
  $('#micIcon').textContent = rec.active ? '⏹' : (busy ? '…' : '🎤');
}

async function sendTurn(userParts, echoText) {
  if (busy) return;
  busy = true; updateMicUI();
  setState('thinking');
  const uBubble = addBubble('u', echoText != null ? echoText : '🎙️ …');
  try {
    const r0 = await gemini(buildSystem(), buildContents(userParts), TURN_SCHEMA);
    const r = r0.__raw ? { transcript: '', reply: String(r0.__raw), notes: [], fix: null } : r0;
    const userText = echoText != null ? echoText : String(r.transcript || '').trim();
    setBubbleText(uBubble, userText || '(没听清)');
    const hasFix = r.fix && r.fix.better;
    if (hasFix) attachFix(uBubble, r.fix);
    const reply = String(r.reply || '...').trim();
    const t = day();
    t.msgs.push({ r: 'u', t: userText || '(unclear audio)', fix: hasFix ? r.fix : undefined });
    t.msgs.push({ r: 't', t: reply });
    addBubble('t', reply);
    addNotes(r.notes);
    saveDays(); renderStreak();
    busy = false; updateMicUI();
    if (S.autoSpeak) { tts.speak(reply, afterSpeakAuto); }
    else setState('idle');
  } catch (e) {
    if (echoText == null) setBubbleText(uBubble, '🎙️ (未发送)');
    busy = false; updateMicUI();
    handleErr(e);
  }
}

function afterSpeakAuto() {
  if (S.handsfree && !document.hidden && !busy) startListening(true);
}
function afterSpeakManual() { /* 手动点朗读后不自动开麦 */ }

/* ---------------- 录音控制 ---------------- */
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
function releaseAwake() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }

async function startListening(auto) {
  if (busy || rec.active) return;
  tts.stop(); tts.unlock();
  if (document.body.dataset.state === 'speaking') setState('idle');
  rec.vadOn = !!S.handsfree;
  try {
    setState('listening', S.handsfree ? '我在听… 说完停顿一下就会发送' : '我在听… 再点一下 ⏹ 发送');
    await rec.start();
    updateMicUI();
    keepAwake();
  } catch (e) {
    setState('idle');
    toast('无法使用麦克风,请在浏览器里允许麦克风权限');
  }
}
function stopAndSend() {
  if (!rec.active) return;
  const spoke = rec.spoke;
  const r = rec.finish();
  updateMicUI(); releaseAwake();
  if (!r || r.sec < 0.4 || !spoke) { setState('idle'); toast('没听到声音'); return; }
  sendTurn([{ inlineData: { mimeType: 'audio/wav', data: r.b64 } }]);
}
function cancelRec(msg) {
  if (!rec.active) return;
  rec.finish(); updateMicUI(); releaseAwake();
  setState('idle');
  if (msg) toast(msg);
}

/* ---------------- 每日总结 & 自适应画像 ---------------- */
async function maybeSummarize() {
  if (!S.apiKey || !navigator.onLine) return;
  const keys = Object.keys(days)
    .filter(k => k < todayKey() && days[k].msgs.length > 1 && !days[k].summary)
    .sort().slice(-3);
  for (const k of keys) {
    const d = days[k];
    const convo = d.msgs.map(m => (m.r === 'u' ? 'Learner: ' : 'Mia: ') + m.t).join('\n').slice(0, 12000);
    const noted = d.notes.map(n => n.term).join(', ');
    const sys = 'You are an English-learning coach. Analyze one day of conversation between tutor Mia and a Chinese learner. Output strict JSON only, no markdown.';
    const prompt = 'Conversation on ' + k + ':\n' + convo +
      '\n\nVocabulary noted that day: ' + (noted || 'none') +
      '\nCurrent learner profile: ' + JSON.stringify(profile) +
      '\n\nReturn JSON exactly: {"summary": "1-2 sentences in simple English: what we talked about + what was practiced", "topics": ["2-4 short topic tags in English"], "profile": {"level": "CEFR e.g. B2", "weaknesses": ["up to 5 short notes on recurring mistakes"], "interests": ["topics the learner enjoys"], "recycle": ["8-12 words or phrases worth weaving into future chats"]}}';
    try {
      const r = await gemini(sys, [{ role: 'user', parts: [{ text: prompt }] }], SUM_SCHEMA);
      if (r.__raw) continue;
      d.summary = String(r.summary || '');
      d.topics = Array.isArray(r.topics) ? r.topics.slice(0, 5) : [];
      if (r.profile && typeof r.profile === 'object') {
        profile = Object.assign({}, profile, r.profile);
        saveProfile();
      }
      saveDays();
    } catch (e) { break; }  // 安静失败,下次再试
  }
}

/* ---------------- 连续天数 ---------------- */
function streakCount() {
  let n = 0;
  const d = new Date();
  const t = days[todayKey()];
  if (!(t && t.msgs.length)) d.setDate(d.getDate() - 1);
  for (;;) {
    const k = fmtKey(d);
    if (days[k] && days[k].msgs.length) { n++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return n;
}
function renderStreak() {
  const n = streakCount();
  const el = $('#streak');
  el.hidden = n < 1;
  el.textContent = '🔥' + n;
}

/* ---------------- 学习记录页 ---------------- */
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function renderHistory() {
  const wrap = $('#histList'); wrap.innerHTML = '';
  const keys = Object.keys(days).filter(k => days[k].msgs.length).sort().reverse();
  if (!keys.length) {
    const d = document.createElement('div');
    d.className = 'empty'; d.textContent = '还没有记录,先去和 Mia 聊几句吧。';
    wrap.appendChild(d); return;
  }
  for (const k of keys) {
    const d = days[k];
    const card = document.createElement('div'); card.className = 'dayCard';
    const date = new Date(k + 'T12:00:00');
    const dt = document.createElement('div'); dt.className = 'dt';
    dt.innerHTML = '';
    const left = document.createElement('span');
    left.textContent = k.slice(5).replace('-', '月') + '日 ' + WEEK[date.getDay()];
    const right = document.createElement('small');
    right.textContent = Math.ceil(d.msgs.length / 2) + ' 轮 · ' + d.notes.length + ' 条笔记';
    dt.appendChild(left); dt.appendChild(right);
    card.appendChild(dt);
    if (d.topics && d.topics.length) {
      const tp = document.createElement('div'); tp.className = 'topics';
      for (const x of d.topics) { const s = document.createElement('span'); s.className = 'topic'; s.textContent = x; tp.appendChild(s); }
      card.appendChild(tp);
    }
    if (d.summary) {
      const p = document.createElement('p'); p.className = 'sm'; p.textContent = d.summary;
      card.appendChild(p);
    }
    if (d.notes.length) {
      const ch = document.createElement('div'); ch.className = 'chips';
      for (const n of d.notes) ch.appendChild(chipEl(n));
      card.appendChild(ch);
    }
    if (d.msgs.length) {
      const det = document.createElement('details');
      const sum = document.createElement('summary'); sum.textContent = '查看对话记录';
      det.appendChild(sum);
      const tr = document.createElement('div'); tr.className = 'transcript';
      for (const m of d.msgs) {
        const line = document.createElement('div');
        const who = document.createElement('span');
        who.className = m.r === 'u' ? 'tu' : 'tt';
        who.textContent = (m.r === 'u' ? '我: ' : 'Mia: ');
        line.appendChild(who);
        line.appendChild(document.createTextNode(m.t));
        tr.appendChild(line);
      }
      det.appendChild(tr);
      card.appendChild(det);
    }
    wrap.appendChild(card);
  }
}

/* ---------------- 设置 ---------------- */
function fillSettings() {
  $('#stKey').value = S.apiKey;
  const sel = $('#stModel');
  const known = [...sel.options].some(o => o.value === S.model);
  sel.value = known ? S.model : 'custom';
  $('#stCustomRow').hidden = sel.value !== 'custom';
  $('#stCustom').value = S.customModel || (known ? '' : S.model);
  $('#stLevel').value = S.level;
  $('#stInterests').value = S.interests;
  $('#stAutoSpeak').checked = S.autoSpeak;
  $('#stHandsfree').checked = S.handsfree;
  $('#stRate').value = S.rate;
  $('#stRateVal').textContent = Number(S.rate).toFixed(2);
}
function openSettings() { fillSettings(); $('#settings').hidden = false; }
function saveSettings() {
  S.apiKey = $('#stKey').value.trim();
  S.model = $('#stModel').value;
  S.customModel = $('#stCustom').value.trim();
  S.level = $('#stLevel').value;
  S.interests = $('#stInterests').value.trim();
  S.autoSpeak = $('#stAutoSpeak').checked;
  S.handsfree = $('#stHandsfree').checked;
  S.rate = parseFloat($('#stRate').value) || 0.95;
  S.mode = -1;  // 模型可能换了,重新探测配置
  saveS();
  $('#settings').hidden = true;
  toast('已保存');
}

async function testKey(keyVal, msgEl) {
  msgEl.className = 'testmsg'; msgEl.textContent = '测试中…';
  try {
    const res = await fetch(API + modelName(), { headers: { 'x-goog-api-key': keyVal } });
    if (res.ok) { msgEl.className = 'testmsg ok'; msgEl.textContent = '✓ 连接成功'; }
    else if (res.status === 400 || res.status === 401 || res.status === 403) { msgEl.className = 'testmsg bad'; msgEl.textContent = '✗ Key 无效'; }
    else if (res.status === 404) { msgEl.className = 'testmsg bad'; msgEl.textContent = '✗ 模型名不存在'; }
    else { msgEl.className = 'testmsg bad'; msgEl.textContent = '✗ HTTP ' + res.status; }
  } catch (e) { msgEl.className = 'testmsg bad'; msgEl.textContent = '✗ 网络不通'; }
}

function exportData() {
  const data = { settings: S, profile, days, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mia-backup-' + todayKey() + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出(包含你的 API Key,请妥善保管)');
}
function importData(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const d = JSON.parse(fr.result);
      if (d.settings) store.set('et_settings', Object.assign({}, DEFAULTS, d.settings));
      if (d.profile) store.set('et_profile', d.profile);
      if (d.days) store.set('et_days', d.days);
      location.reload();
    } catch (e) { toast('导入失败:文件格式不对'); }
  };
  fr.readAsText(file);
}

/* ---------------- 开场白 ---------------- */
const CANNED_GREETS = [
  "Hey, good to see you! I'm Mia. So - how's your day going so far?",
  "Hi there! Ready for a little English chat? Tell me one thing you did today.",
  "Welcome back! I was just thinking about you. What's new today?",
];
async function maybeGreet() {
  const t = day();
  if (t.msgs.length || busy || !S.apiKey) return;
  busy = true; updateMicUI(); setState('thinking');
  try {
    const hidden = '(The learner just opened the app. Greet them warmly in 1-2 short sentences and start a conversation - pick something fresh based on their profile and recent sessions. This instruction is not from the learner; set "transcript" to "".)';
    const r = await gemini(buildSystem(), [{ role: 'user', parts: [{ text: hidden }] }], TURN_SCHEMA);
    const reply = r.__raw ? String(r.__raw).trim() : String(r.reply || '').trim();
    const text = reply || CANNED_GREETS[Math.floor(Math.random() * CANNED_GREETS.length)];
    t.msgs.push({ r: 't', t: text });
    addBubble('t', text);
    if (!r.__raw) addNotes(r.notes);
    saveDays();
    busy = false; updateMicUI();
    if (S.autoSpeak) tts.speak(text, afterSpeakAuto); else setState('idle');
  } catch (e) {
    const text = CANNED_GREETS[Math.floor(Math.random() * CANNED_GREETS.length)];
    t.msgs.push({ r: 't', t: text });
    addBubble('t', text);
    saveDays();
    busy = false; updateMicUI(); setState('idle');
  }
}

/* ---------------- 事件绑定 ---------------- */
function bindUI() {
  $('#btnMic').addEventListener('click', () => {
    tts.unlock();
    if (rec.active) { stopAndSend(); return; }
    if (busy) return;
    startListening(false);
  });

  $('#btnKb').addEventListener('click', () => {
    const row = $('#textRow');
    row.hidden = !row.hidden;
    if (!row.hidden) $('#txt').focus();
  });
  const sendText = () => {
    const v = $('#txt').value.trim();
    if (!v || busy) return;
    $('#txt').value = '';
    tts.unlock(); tts.stop();
    if (rec.active) cancelRec();
    sendTurn([{ text: v }], v);
  };
  $('#btnSend').addEventListener('click', sendText);
  $('#txt').addEventListener('keydown', e => { if (e.key === 'Enter') sendText(); });

  $('#btnReplay').addEventListener('click', () => {
    const t = day();
    for (let i = t.msgs.length - 1; i >= 0; i--) {
      if (t.msgs[i].r === 't') { tts.unlock(); tts.speak(t.msgs[i].t, afterSpeakManual); return; }
    }
    toast('还没有可以重听的内容');
  });

  $('#notesHead').addEventListener('click', () => $('#notes').classList.toggle('open'));

  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnCloseSettings').addEventListener('click', () => { $('#settings').hidden = true; });
  $('#stModel').addEventListener('change', () => { $('#stCustomRow').hidden = $('#stModel').value !== 'custom'; });
  $('#stRate').addEventListener('input', () => { $('#stRateVal').textContent = Number($('#stRate').value).toFixed(2); });
  $('#stSave').addEventListener('click', saveSettings);
  $('#stTest').addEventListener('click', () => testKey($('#stKey').value.trim(), $('#stTestMsg')));
  $('#stExport').addEventListener('click', exportData);
  $('#stImportBtn').addEventListener('click', () => $('#stImport').click());
  $('#stImport').addEventListener('change', e => { if (e.target.files[0]) importData(e.target.files[0]); });
  $('#stClear').addEventListener('click', () => {
    if (confirm('确定清空所有聊天记录、笔记和设置吗?此操作不可恢复。')) {
      localStorage.removeItem('et_settings');
      localStorage.removeItem('et_profile');
      localStorage.removeItem('et_days');
      location.reload();
    }
  });

  $('#btnHistory').addEventListener('click', () => { renderHistory(); $('#history').hidden = false; });
  $('#btnCloseHistory').addEventListener('click', () => { $('#history').hidden = true; });

  $('#btnCloseSheet').addEventListener('click', () => { $('#sheet').hidden = true; });
  $('#sheet').querySelector('.sheetMask').addEventListener('click', () => { $('#sheet').hidden = true; });
  $('#shSpeak').addEventListener('click', () => {
    if (!sheetNote) return;
    tts.unlock();
    tts.speak(sheetNote.term + '. ' + (sheetNote.example || ''));
  });

  // 首次设置
  $('#suTest').addEventListener('click', () => {
    const k = $('#suKey').value.trim();
    if (!k) { $('#suTestMsg').className = 'testmsg bad'; $('#suTestMsg').textContent = '先粘贴 Key'; return; }
    testKey(k, $('#suTestMsg'));
  });
  $('#suStart').addEventListener('click', () => {
    const k = $('#suKey').value.trim();
    if (!k) { toast('需要先填入 API Key 才能开始'); return; }
    S.apiKey = k;
    S.level = $('#suLevel').value;
    S.interests = $('#suInterests').value.trim();
    saveS();
    $('#setup').hidden = true;
    tts.unlock();
    maybeGreet();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (rec.active) cancelRec(); tts.stop(); if (document.body.dataset.state !== 'idle') setState('idle'); }
  });
}

/* ---------------- 启动 ---------------- */
function init() {
  tts.init();
  bindUI();
  renderChat();
  renderNotesToday();
  renderStreak();
  setState('idle');
  if (!S.apiKey) {
    $('#suLevel').value = S.level;
    $('#setup').hidden = false;
  } else {
    maybeSummarize().then(renderStreak);
    maybeGreet();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
init();
