// 티켓베이 좌석(등급)별 최저가를 15초마다 조회해 1분봉으로 누적한다.
// GitHub Actions 잡 하나가 RUN_MIN분 동안 계속 돌고, 2분마다 data 브랜치에 커밋/푸시한다.
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const API = 'https://www.ticketbay.co.kr/ticketbayApi/product/v1/public/products';
const CATS = [6950]; // 한국시리즈 3차전 [대구]
const QTYS = ['2', 'all']; // 2매 연석 / 전체 수량
const INTERVAL = 15000;
const FLUSH_MS = 120000;
const RUN_MS = (Number(process.env.RUN_MIN) || 70) * 60000;
const STOP_AT = Date.parse('2026-11-06T09:30:00Z'); // 경기 시작(18:30 KST)
const KEEP_MS = 4 * 24 * 3600 * 1000;
const DIR = process.env.DATA_DIR || 'datawt';
const ALL = '★ 전체';
const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Origin': 'https://www.ticketbay.co.kr',
  'Referer': 'https://www.ticketbay.co.kr/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fpath = (c, q) => `${DIR}/${c}-${q}.json`;

function load(c, q) {
  try {
    const j = JSON.parse(fs.readFileSync(fpath(c, q), 'utf8'));
    if (j && j.bars) return j;
  } catch (e) { /* 새로 시작 */ }
  return { v: 1, bars: {} };
}

async function fetchAll(cat, qty) {
  const out = [];
  const seen = new Set();
  for (let p = 0; p < 10; p++) {
    const body = { category_id: String(cat), page: String(p), size: 100, offset: 0, depth1_id: 5 };
    if (qty !== 'all') { body.sale_quantity = qty; body.is_together = 'YES'; }
    const r = await fetch(API, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = (await r.json()).data;
    for (const x of d.content) if (!seen.has(x.id)) { seen.add(x.id); out.push(x); }
    if (d.last || p + 1 >= d.totalPages) break;
  }
  return out;
}

// 샘플 하나를 1분봉에 반영: bar[grade] = [시가, 고가, 저가, 종가, 매물수]
function addSample(data, t, g) {
  const m = Math.floor(t / 60000) * 60000;
  const bar = data.bars[m] || (data.bars[m] = {});
  for (const k of Object.keys(g)) {
    const [v, n] = g[k];
    const e = bar[k];
    if (!e) bar[k] = [v, v, v, v, n];
    else { e[1] = Math.max(e[1], v); e[2] = Math.min(e[2], v); e[3] = v; e[4] = n; }
  }
}

function summarize(items) {
  const by = {};
  let all = Infinity;
  for (const x of items) {
    const k = x.grade || '기타';
    const e = by[k] || (by[k] = [Infinity, 0]);
    e[0] = Math.min(e[0], x.price);
    e[1] += 1;
    all = Math.min(all, x.price);
  }
  if (items.length) by[ALL] = [all, items.length];
  return by;
}

function git(cmd) {
  return execSync(cmd, { cwd: DIR, stdio: 'pipe' }).toString();
}

function flush(store, msg) {
  const cutoff = Date.now() - KEEP_MS;
  for (const key of Object.keys(store)) {
    const data = store[key];
    for (const m of Object.keys(data.bars)) if (Number(m) < cutoff) delete data.bars[m];
    fs.writeFileSync(`${DIR}/${key}.json`, JSON.stringify(data));
  }
  try {
    git('git add -A');
    try { git('git diff --cached --quiet'); return; } catch (e) { /* 변경 있음 */ }
    git(`git commit -q -m "${msg}"`);
    git('git push -q origin HEAD:data');
    console.log(new Date().toISOString(), 'pushed');
  } catch (e) {
    console.log('git error:', String(e.stderr || e.message).slice(0, 300));
  }
}

async function main() {
  if (Date.now() >= STOP_AT) { console.log('경기 시작 이후라 수집 종료'); return; }
  const store = {};
  for (const c of CATS) for (const q of QTYS) store[`${c}-${q}`] = load(c, q);
  const t0 = Date.now();
  let lastFlush = t0;
  let fails = 0, ok = 0;
  while (Date.now() - t0 < RUN_MS && Date.now() < STOP_AT) {
    const tick = Date.now();
    for (const c of CATS) {
      for (const q of QTYS) {
        try {
          const items = await fetchAll(c, q);
          addSample(store[`${c}-${q}`], Date.now(), summarize(items));
          ok++; fails = 0;
        } catch (e) {
          fails++;
          console.log('fetch error', c, q, String(e.message));
        }
      }
    }
    if (Date.now() - lastFlush >= FLUSH_MS) { flush(store, 'data ' + new Date().toISOString()); lastFlush = Date.now(); }
    if (fails >= 40) { console.log('연속 실패 40회, 중단'); process.exitCode = 1; break; }
    await sleep(Math.max(1000, INTERVAL - (Date.now() - tick)));
  }
  flush(store, 'data ' + new Date().toISOString());
  console.log('done. ok samples:', ok);
}

main();
