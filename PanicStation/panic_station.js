#!/usr/bin/env node
/*
 * ==========================================================================
 *  PANIC STATION — онлайн-версия для частной игры с друзьями
 * ==========================================================================
 *  Один файл: сервер + клиент. Никаких npm-зависимостей (нужен только Node.js 18+).
 *
 *  Запуск:
 *      node panic_station.js
 *  Затем открыть в браузере:  http://<адрес-сервера>:3000
 *  Можно играть и за одним компьютером — кнопка «Играть за одним компьютером».
 *
 *  Файл ожидает рядом с собой папку  ./assets  (из архива PanicStation_assets.zip):
 *      assets/img/...   — картинки (вырезаны из фото и правил)
 *      assets/docs/...  — оригинальные правила и памятки (PDF)
 *
 *  Переменные окружения (необязательно):
 *      PORT=3000          порт
 *      HOST=0.0.0.0       интерфейс
 *      ASSETS_DIR=./assets  путь к папке с картинками
 *      GAME_PASSWORD=...  если задан — для создания игры нужен этот пароль
 * ==========================================================================
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
//  ДАННЫЕ ИГРЫ
// ---------------------------------------------------------------------------
const COLORS = {
  red:    { hero: 'Billy Jr.', ru: 'красный',    hex: '#d8392b' },
  blue:   { hero: 'Nina',      ru: 'синий',      hex: '#2d8ee6' },
  green:  { hero: 'Jason',     ru: 'зелёный',    hex: '#3fb43a' },
  orange: { hero: 'Raven',     ru: 'оранжевый',  hex: '#f28c1b' },
  purple: { hero: 'Ramirez',   ru: 'фиолетовый', hex: '#9446d1' },
  white:  { hero: 'Doc',       ru: 'белый',      hex: '#e3e3e3' },
};
const COLOR_ORDER = ['red', 'blue', 'green', 'orange', 'purple', 'white'];

// Состав колоды поиска (46 карт вместе с картой Носителя).
// Точный состав коробки в правилах не указан — при желании поправьте числа под свою коробку.
const SEARCH_DECK = {
  gas: 10, alert: 5, ammo: 5, armor: 5, keycard: 3, energy: 3,
  firstaid: 3, grenade: 3, heavygun: 2, scope: 2, knife: 2, scanner: 2,
};
const AMMO_PER_CARD = 4; // на карте патронов цифры 4-3-2-1

const ITEMS = {
  gas:      { ru: 'Канистра',          en: 'Gas Can',        tag: '1×',          desc: 'Отражает попытку заражения при обмене (отдайте её в ответ). Нужно 3 канистры: Штурмовик сжигает ими Улей.' },
  ammo:     { ru: 'Патроны',           en: 'Ammo',           tag: 'на стол',     desc: 'Выложите на стол: 4 патрона для оружия Андроида. Каждый выстрел тратит патрон.' },
  armor:    { ru: 'Бронежилет',        en: 'Armor',          tag: '1×, реакция', desc: 'Играется в ответ на атаку (даже в чужой ход): −1 урон. Если оба ваших персонажа в одной комнате — защищает обоих.' },
  keycard:  { ru: 'Ключ-карта',        en: 'Keycard',        tag: 'на стол',     desc: 'Выложите на стол: ВАШИ персонажи проходят через закрытые двери безопасности.' },
  energy:   { ru: 'Энергетик',         en: 'Energy Boost',   tag: '1×',          desc: '+2 очка действия в этот ход.' },
  firstaid: { ru: 'Аптечка',           en: 'First Aid Kit',  tag: '1×',          desc: 'Вылечить 2 раны своему персонажу или любому в той же комнате (или по 1 двоим).' },
  grenade:  { ru: 'Граната',           en: 'Grenade',        tag: '1×, 1 ОД',    desc: 'Бросьте в соседнюю комнату: 1 рана ВСЕМ паразитам и персонажам там.' },
  heavygun: { ru: 'Тяжёлый автомат',   en: 'Heavy Gun',      tag: 'на стол',     desc: 'Только Андроид. Выстрел (1 ОД) — 2 пули, можно в разные цели.' },
  scope:    { ru: 'Оптический прицел', en: 'Target Scope',   tag: 'на стол',     desc: 'Андроид может стрелять в соседнюю комнату (не сквозь закрытую дверь).' },
  knife:    { ru: 'Боевой нож',        en: 'Combat Knife',   tag: 'на стол, 1 ОД', desc: 'Штурмовик или Андроид атакует цель в своей комнате: D4, на 3+ — 1 рана.' },
  scanner:  { ru: 'Тепловой сканер',   en: 'Heat Scanner',   tag: '1×, 1 ОД',    desc: 'Посмотрите руку игрока, чей персонаж в одной комнате с вашим.' },
  alert:    { ru: 'Тревога: паразит!', en: 'Parasite Alert', tag: 'сразу',       desc: 'Разыгрывается сразу: бросок D4 и появление паразита рядом.' },
  host:     { ru: 'Носитель',          en: 'Host',           tag: 'тайно',       desc: 'Вы — Носитель. Вы заражены. Передавайте при обмене карты заражения СВОЕГО цвета.' },
  infect:   { ru: 'Заражение',         en: 'Infection',      tag: '',            desc: 'Заражённый игрок, отдав при обмене карту СВОЕГО цвета, заражает партнёра (если тот не отдал канистру). Незаражённый не может отдавать карты своего цвета.' },
};
const TABLE_ITEMS = ['keycard', 'scope', 'heavygun', 'knife', 'ammo'];

const ROOM_TYPES = {
  reactor:  { ru: 'Реактор',          icon: null,       desc: 'Старт. Здесь нельзя меняться картами. Цифры 1–4 показывают направления кубика D4.' },
  hive:     { ru: 'Улей',             icon: null,       desc: 'Цель миссии: незаражённый Штурмовик + 3 канистры (1 ОД) — люди побеждают.' },
  empty:    { ru: 'Коридор',          icon: null,       desc: 'Здесь нечего обыскивать.' },
  storage:  { ru: 'Склад',            icon: 'storage',  desc: 'Первый обыск даёт 3 карты, дальше — по 1.' },
  terminal: { ru: 'Терминал',         icon: 'terminal', desc: '1 ОД (раз в ход): тепловое сканирование, открыть все двери до фазы паразитов или показать новую локацию.' },
  search:   { ru: 'Совместный обыск', icon: 'search',   desc: 'Можно обыскать вместе с другим игроком: 2 карты раздаются случайно.' },
  run:      { ru: 'Бег',              icon: 'run',      desc: 'Если в комнате нет чужих персонажей — 1 бесплатное перемещение дальше. Обыск отменяет.' },
  sickbay:  { ru: 'Лазарет',          icon: 'sickbay',  desc: '1 ОД: вылечить 2 раны (или по 1 обоим своим персонажам).' },
  parasite: { ru: 'Тревога',          icon: 'parasite', desc: 'Каждый вход в комнату привлекает паразита (бросок D4).' },
};

// Карты исследования. e = стены: t(верх) r(право) b(низ) l(лево).
// 'D' — открытый проход, 'W' — стена, 'S' — закрытая дверь безопасности.
// Для карт с двумя комнатами (верх/низ) у боковых сторон 2 слота: [верхняя комната, нижняя комната].
// Расположение дверей придумано по мотивам оригинала (по фото не видно) — при желании поправьте.
const EXPLORATION = [
  { id: 'reactor', rooms: ['reactor'],           e: { t: 'D', r: 'D', b: 'D', l: 'D' }, art: 'room_reactor' },
  { id: 'hive',    rooms: ['hive'],              e: { t: 'W', r: 'D', b: 'D', l: 'W' }, art: 'room_hive' },
  { id: 'term1',   rooms: ['terminal'],          e: { t: 'D', r: 'W', b: 'D', l: 'D' }, openTerminal: true },
  { id: 'term2',   rooms: ['terminal', 'empty'], e: { t: 'D', r: ['S', 'W'], b: 'D', l: ['W', 'D'] } },
  { id: 'stor1',   rooms: ['storage'],           e: { t: 'D', r: 'D', b: 'W', l: 'D' } },
  { id: 'stor2',   rooms: ['storage'],           e: { t: 'W', r: 'D', b: 'D', l: 'D' } },
  { id: 'srch1',   rooms: ['search'],            e: { t: 'D', r: 'W', b: 'D', l: 'D' } },
  { id: 'srch2',   rooms: ['search'],            e: { t: 'S', r: 'D', b: 'D', l: 'W' } },
  { id: 'srch3',   rooms: ['search'],            e: { t: 'D', r: 'D', b: 'D', l: 'D' } },
  { id: 'srch4',   rooms: ['search', 'empty'],   e: { t: 'D', r: ['W', 'D'], b: 'D', l: ['D', 'W'] } },
  { id: 'run1',    rooms: ['run'],               e: { t: 'D', r: 'D', b: 'D', l: 'D' } },
  { id: 'run2',    rooms: ['run'],               e: { t: 'D', r: 'W', b: 'D', l: 'W' } },
  { id: 'run3',    rooms: ['run'],               e: { t: 'D', r: 'D', b: 'W', l: 'D' } },
  { id: 'sick1',   rooms: ['empty', 'sickbay'],  e: { t: 'S', r: ['D', 'W'], b: 'D', l: ['W', 'D'] } },
  { id: 'para1',   rooms: ['parasite'],          e: { t: 'D', r: 'W', b: 'D', l: 'D' } },
  { id: 'para2',   rooms: ['parasite'],          e: { t: 'W', r: 'D', b: 'D', l: 'D' } },
  { id: 'para3',   rooms: ['parasite'],          e: { t: 'D', r: 'W', b: 'D', l: 'S' } },
  { id: 'para4',   rooms: ['parasite'],          e: { t: 'D', r: 'D', b: 'W', l: 'W' } },
  { id: 'hall1',   rooms: ['empty'],             e: { t: 'D', r: 'S', b: 'D', l: 'D' } },
  { id: 'hall2',   rooms: ['empty'],             e: { t: 'S', r: 'D', b: 'D', l: 'D' } },
];
const EXP_BY_ID = Object.fromEntries(EXPLORATION.map(d => [d.id, d]));

// Кубик D4 по шаблону Реактора: 1 — вверх, 2 — вправо, 3 — вниз, 4 — влево
const D4_DIR = { 1: 'up', 2: 'right', 3: 'down', 4: 'left' };
const DIRS = {
  up:    { dx: 0,  dy: -1, side: 't', opp: 'b', ru: 'вверх' },
  right: { dx: 1,  dy: 0,  side: 'r', opp: 'l', ru: 'вправо' },
  down:  { dx: 0,  dy: 1,  side: 'b', opp: 't', ru: 'вниз' },
  left:  { dx: -1, dy: 0,  side: 'l', opp: 'r', ru: 'влево' },
};
const KIND_RU = { trooper: 'Штурмовик', android: 'Андроид' };

// ---------------------------------------------------------------------------
//  ВСПОМОГАТЕЛЬНОЕ
// ---------------------------------------------------------------------------
const rnd = n => crypto.randomInt(n);
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const isWall = s => s === 'W';
function normEdges(e) {
  return { t: e.t, b: e.b, l: Array.isArray(e.l) ? e.l.slice() : [e.l, e.l], r: Array.isArray(e.r) ? e.r.slice() : [e.r, e.r] };
}
function orient(def, rot) {
  const e = normEdges(def.e);
  const rooms = def.rooms.slice();
  if (rot === 180) return { rooms: rooms.reverse(), e: { t: e.b, b: e.t, l: [e.r[1], e.r[0]], r: [e.l[1], e.l[0]] } };
  return { rooms, e };
}
function agg(arr) { return arr.includes('S') ? 'S' : (arr.includes('D') ? 'D' : 'W'); }
function pairBad(a, b) { return isWall(a) !== isWall(b) || (a === 'S' && b === 'S'); }
class GameError extends Error {}
function must(cond, msg) { if (!cond) throw new GameError(msg); }
const apOf = hp => (hp >= 3 ? 2 : hp >= 1 ? 1 : 0);

// ---------------------------------------------------------------------------
//  ИГРА
// ---------------------------------------------------------------------------
class Game {
  constructor(code, onChange) {
    this.code = code;
    this.onChange = onChange || (() => {});
    this.phase = 'lobby';
    this.local = false;           // все игроки за одним устройством (передают его по очереди)
    this.players = [];            // порядок = порядок хода (по часовой)
    this.adminId = null;
    this.platform = false;        // стол платформы Zarya Boardgames: имя = ник аккаунта, мест — сколько заказала платформа
    this.maxPlayers = 6;
    this.options = { easy: false, hard: false, hostRule: false };
    this.log = [];
    this.seq = 0;
    this.chat = [];
    this.created = Date.now();
    this.touched = Date.now();
  }

  // ---------------- лобби ----------------
  addPlayer(name) {
    must(this.phase === 'lobby', 'Игра уже началась');
    must(this.players.length < this.maxPlayers, this.maxPlayers < 6 ? 'Все места за этим столом заняты' : 'Максимум 6 игроков');
    name = String(name || '').trim().slice(0, this.platform ? 24 : 20) || ('Игрок ' + (this.players.length + 1));
    const used = new Set(this.players.map(p => p.color));
    const p = {
      id: 'p' + crypto.randomBytes(4).toString('hex'),
      token: crypto.randomBytes(16).toString('hex'),
      name, color: COLOR_ORDER.find(c => !used.has(c)),
      hand: [], table: { ammo: [], heavygun: null, scope: null, knife: null, keycard: null },
      infected: false, isHost: false, arrived: false, eliminated: false,
      chars: { trooper: { hp: 4, room: null, alive: true }, android: { hp: 4, room: null, alive: true } },
    };
    this.players.push(p);
    if (!this.adminId) this.adminId = p.id;
    this.addLog(`${name} присоединился к игре.`);
    return p;
  }
  player(id) { return this.players.find(p => p.id === id); }
  byName(name) { name = String(name || '').trim().toLowerCase(); return this.players.find(p => p.name.toLowerCase() === name); }
  /** Игрок встал из-за стола на платформе: в лобби уходит совсем, в идущей партии остаётся, но место считается свободным. */
  leaveByName(name) {
    const p = this.byName(name);
    if (!p) return 0;
    if (this.phase === 'lobby') {
      this.players.splice(this.players.indexOf(p), 1);
      if (this.adminId === p.id) this.adminId = this.players[0] ? this.players[0].id : null;
      this.addLog(`${p.name} ушёл из-за стола.`);
    } else if (!p.left) {
      p.left = true;
      this.addLog(`${p.name} встал из-за стола.`);
    }
    return 1;
  }
  byToken(t) { return this.players.find(p => p.token === t); }
  pname(p) { return typeof p === 'string' ? (this.player(p) || {}).name : p.name; }
  cname(p, kind) { return `${p.name} (${KIND_RU[kind]})`; }

  addLog(text, to, cls) {
    this.log.push({ seq: ++this.seq, text, to: to || null, cls: cls || null, at: Date.now() });
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
  }
  priv(p, text, cls) { this.addLog(text, typeof p === 'string' ? p : p.id, cls || 'priv'); }

  // ---------------- старт ----------------
  start(byId) {
    must(this.phase === 'lobby', 'Игра уже идёт');
    must(byId === this.adminId, 'Начать игру может только создатель комнаты');
    must(this.players.length >= 2, 'Нужно хотя бы 2 игрока (по правилам 4–6)');
    this.phase = 'play';
    const N = this.players.length;
    shuffle(this.players);                       // случайный порядок мест / первый игрок
    this.players.forEach((p, i) => { p.seat = i; });

    // поле: реактор в центре
    this.cards = []; this.cardPos = new Map(); this.cardSeq = 0;
    this.placeCard(EXP_BY_ID.reactor, 0, 0, 0);
    // колода исследования: Улей в нижние 5 карт второй стопки, открытый терминал во вторую стопку
    const rest = shuffle(EXPLORATION.filter(d => !['reactor', 'hive', 'term1'].includes(d.id)).map(d => d.id));
    const half = Math.ceil(rest.length / 2);
    const top = rest.slice(0, half), bottom = rest.slice(half);
    bottom.push('term1'); shuffle(bottom);
    const pos = bottom.length - 1 - rnd(Math.min(5, bottom.length + 1)) + 1; // в последние 5 позиций
    bottom.splice(Math.max(0, Math.min(bottom.length, pos)), 0, 'hive');
    this.expDeck = top.concat(bottom);

    // паразиты: 5 серых и 5 чёрных (двусторонних)
    this.parasites = [];
    for (let i = 0; i < 5; i++) this.parasites.push({ id: 'g' + i, disc: 'gray', side: 'gray', room: null });
    for (let i = 0; i < 5; i++) this.parasites.push({ id: 'b' + i, disc: 'black', side: 'black', room: null });

    // колода поиска
    this.cardUid = 0;
    const mk = (t, c) => ({ id: 'k' + (++this.cardUid), t, c });
    let deck = [];
    for (const [t, n] of Object.entries(SEARCH_DECK)) for (let i = 0; i < n; i++) deck.push(mk(t));
    shuffle(deck);
    const gas = [];
    for (let i = 0; i < N && deck.some(c => c.t === 'gas'); i++) gas.push(deck.splice(deck.findIndex(c => c.t === 'gas'), 1)[0]);
    const extra = deck.splice(0, Math.max(0, 2 * N - 1));
    const topSet = shuffle(gas.concat(extra, [mk('host')]));
    this.deck = topSet.concat(deck);
    this.discard = [];
    this.removed = [];

    // игроки: 3 карты заражения своего цвета (2 в лёгком режиме)
    const nInf = this.options.easy ? 2 : 3;
    this.infOrder = [];
    for (const p of this.players) {
      for (let i = 0; i < nInf; i++) p.hand.push(mk('infect', p.color));
    }
    this.gasToBurn = this.options.hard ? 4 : 3;
    this.doorsOpen = false;
    this.lastRoll = null; this.rollSeq = 0;
    this.lastScan = null; this.scanSeq = 0;
    this.pending = null; this.over = null;
    this.turn = null; this.turnNo = 0;
    this.addLog('— Игра началась! Порядок хода: ' + this.players.map(p => p.name).join(' → ') + ' —', null, 'sys');

    // раздача по 2 карты; тревога в начале — паразит в Реактор и добрать
    for (const p of this.players) {
      let got = 0;
      while (got < 2 && this.deck.length) {
        const c = this.deck.shift();
        if (c.t === 'alert') {
          this.discard.push(c);
          const par = this.takeParasiteForSpawn();
          if (par) par.room = this.cards[0].id + '.0';
          this.addLog(`${p.name} вытягивает «Тревогу» при раздаче — паразит появляется в Реакторе.`, null, 'alert');
          continue;
        }
        this.giveCard(p, c, 'раздача');
        got++;
      }
    }
    // Первая фаза паразитов происходит до того, как кто-то вошёл на станцию
    this.markerIdx = 0;
    this.turnsSincePP = 999;
    this.curIdx = -1;
    this.nextTurn();
  }

  giveCard(p, c, why) {
    p.hand.push(c);
    if (c.t === 'host') {
      p.isHost = true;
      if (!p.infected) { p.infected = true; this.infOrder.push(p.id); }
      this.priv(p, '☣ Вам досталась карта НОСИТЕЛЯ. Вы заражены! Ваша цель — заразить или убить людей. Не выдавайте себя.', 'infected');
    }
  }

  // ---------------- поле ----------------
  placeCard(def, x, y, rot) {
    const o = orient(def, rot);
    const card = { id: 'C' + (this.cardSeq++), def: def.id, x, y, rot, rooms: o.rooms, e: o.e, red: false, art: def.art || null };
    this.cards.push(card);
    this.cardPos.set(x + ',' + y, card);
    return card;
  }
  cardAt(x, y) { return this.cardPos.get(x + ',' + y); }
  cardById(id) { return this.cards.find(c => c.id === id); }
  roomInfo(key) {
    if (!key) return null;
    const [cid, i] = key.split('.');
    const card = this.cardById(cid);
    if (!card || !card.rooms[+i]) return null;
    return { card, i: +i, type: card.rooms[+i], key };
  }
  roomType(key) { const r = this.roomInfo(key); return r ? r.type : null; }
  roomName(key) { const t = this.roomType(key); return t ? ROOM_TYPES[t].ru : '?'; }

  // слоты стороны, принадлежащие комнате (с индексами)
  roomSideSlots(card, i, side) {
    const dbl = card.rooms.length === 2;
    if (side === 't') return (!dbl || i === 0) ? [{ s: 0, v: card.e.t }] : [];
    if (side === 'b') return (!dbl || i === 1) ? [{ s: 0, v: card.e.b }] : [];
    const arr = card.e[side];
    return dbl ? [{ s: i, v: arr[i] }] : [{ s: 0, v: arr[0] }, { s: 1, v: arr[1] }];
  }
  // все проходы из комнаты: [{to, type:'I'|'D'|'S', dir}]
  links(key) {
    const R = this.roomInfo(key); if (!R) return [];
    const { card, i } = R; const out = [];
    const dbl = card.rooms.length === 2;
    if (dbl) out.push({ to: card.id + '.' + (1 - i), type: 'I', dir: i === 0 ? 'down' : 'up' });
    for (const [dname, d] of Object.entries(DIRS)) {
      const N = this.cardAt(card.x + d.dx, card.y + d.dy); if (!N) continue;
      const mine = this.roomSideSlots(card, i, d.side); if (!mine.length) continue;
      const nd = N.rooms.length === 2;
      if (d.side === 't' || d.side === 'b') {
        const a = mine[0].v, b = N.e[d.opp];
        if (!isWall(a) && !isWall(b)) {
          const ti = nd ? (dname === 'up' ? 1 : 0) : 0;
          out.push({ to: N.id + '.' + ti, type: (a === 'S' || b === 'S') ? 'S' : 'D', dir: dname });
        }
      } else {
        const found = {};
        for (const m of mine) {
          const b = N.e[d.opp][m.s];
          if (isWall(m.v) || isWall(b)) continue;
          const ti = nd ? m.s : 0;
          const ty = (m.v === 'S' || b === 'S') ? 'S' : 'D';
          if (!found[ti] || found[ti] === 'S') found[ti] = ty;
        }
        for (const [ti, ty] of Object.entries(found)) out.push({ to: N.id + '.' + ti, type: ty, dir: dname });
      }
    }
    return out;
  }
  canPassS(p) { return !!(p.table.keycard || this.doorsOpen); }
  passable(p, l) { return l.type !== 'S' || this.canPassS(p); }
  // соседняя комната в направлении (для появления паразита — стены не важны)
  dirNeighbor(key, dname) {
    const R = this.roomInfo(key); const { card, i } = R; const d = DIRS[dname];
    const dbl = card.rooms.length === 2;
    if (dbl && dname === 'down' && i === 0) return card.id + '.1';
    if (dbl && dname === 'up' && i === 1) return card.id + '.0';
    const N = this.cardAt(card.x + d.dx, card.y + d.dy); if (!N) return null;
    if (N.rooms.length === 1) return N.id + '.0';
    if (dname === 'up') return N.id + '.1';
    if (dname === 'down') return N.id + '.0';
    if (dbl) return N.id + '.' + i;
    const s = N.e[d.opp].findIndex(v => !isWall(v));
    return N.id + '.' + (s < 0 ? 0 : s);
  }
  // проверка выкладки карты
  fits(o, x, y) {
    if (this.cardAt(x, y)) return { ok: false };
    let connected = false;
    for (const d of Object.values(DIRS)) {
      const N = this.cardAt(x + d.dx, y + d.dy); if (!N) continue;
      if (d.side === 't' || d.side === 'b') {
        const a = o.e[d.side], b = N.e[d.opp];
        if (pairBad(a, b)) return { ok: false };
        if (!isWall(a)) connected = true;
      } else {
        const A = o.e[d.side], B = N.e[d.opp];
        if (o.rooms.length === 2 && N.rooms.length === 2) {
          for (let s = 0; s < 2; s++) { if (pairBad(A[s], B[s])) return { ok: false }; if (!isWall(A[s]) && !isWall(B[s])) connected = true; }
        } else {
          const a = agg(A), b = agg(B);
          if (pairBad(a, b)) return { ok: false };
          if (!isWall(a)) connected = true;
        }
      }
    }
    return { ok: true, connected };
  }
  placementsFrom(def, roomKey) {
    const R = this.roomInfo(roomKey); const res = [];
    for (const d of Object.values(DIRS)) {
      const mine = this.roomSideSlots(R.card, R.i, d.side);
      if (!mine.some(m => !isWall(m.v))) continue;
      const x = R.card.x + d.dx, y = R.card.y + d.dy;
      if (this.cardAt(x, y)) continue;
      const rots = [0, 180].filter(rot => { const f = this.fits(orient(def, rot), x, y); return f.ok && f.connected && this.connectsTo(orient(def, rot), x, y, R); });
      if (rots.length && !res.some(r => r.x === x && r.y === y)) res.push({ x, y, rots });
    }
    return res;
  }
  // новая карта должна соединяться именно с комнатой исследователя
  connectsTo(o, x, y, R) {
    const tmp = { id: '__tmp', x, y, rooms: o.rooms, e: o.e };
    this.cardPos.set(x + ',' + y, tmp); this.cards.push(tmp);
    const ok = this.links(R.key).some(l => l.to.startsWith('__tmp.'));
    this.cards.pop(); this.cardPos.delete(x + ',' + y);
    return ok;
  }
  placementsAny(def) {
    const cells = new Set(); const res = [];
    for (const c of this.cards) for (const d of Object.values(DIRS)) {
      const x = c.x + d.dx, y = c.y + d.dy, k = x + ',' + y;
      if (cells.has(k) || this.cardAt(x, y)) continue; cells.add(k);
      const rots = [0, 180].filter(rot => { const f = this.fits(orient(def, rot), x, y); return f.ok && f.connected; });
      if (rots.length) res.push({ x, y, rots });
    }
    return res;
  }
  // какую карту исследовать сейчас (если Улей не выложить — следующую)
  exploreCardIdx() {
    if (!this.expDeck.length) return -1;
    if (this.expDeck[0] === 'hive' && !this.placementsAny(EXP_BY_ID.hive).length) return this.expDeck.length > 1 ? 1 : -2;
    return 0;
  }

  // ---------------- кубик и паразиты ----------------
  roll(byName, why) {
    const v = 1 + rnd(4);
    this.lastRoll = { v, by: byName, why, seq: ++this.rollSeq, dir: D4_DIR[v] };
    return v;
  }
  takeParasiteForSpawn() {
    let par = this.parasites.find(q => !q.room && q.disc === 'gray');
    if (!par) { par = this.parasites.find(q => !q.room && q.disc === 'black'); if (par) par.side = 'black'; }
    return par || null;
  }
  spawn(originKey, who) {
    const v = this.roll(who, 'появление паразита');
    const dir = D4_DIR[v];
    let target = this.dirNeighbor(originKey, dir) || originKey;
    let par = this.takeParasiteForSpawn();
    let moved = false;
    if (!par) {
      const onBoard = this.parasites.filter(q => q.room);
      if (!onBoard.length) return;
      par = onBoard[rnd(onBoard.length)]; moved = true;
    }
    par.room = target;
    this.addLog(`🎲 ${who} бросает D4: ${v} (${DIRS[dir].ru}). ${moved ? 'Паразит перемещается' : (par.side === 'black' ? 'Чёрный паразит' : 'Серый паразит') + ' появляется'} в комнате «${this.roomName(target)}».`, null, 'alert');
  }
  parasitesIn(key) { return this.parasites.filter(q => q.room === key); }
  hitParasite(par, n) {
    for (let k = 0; k < n && par.room; k++) {
      if (par.side === 'gray') {
        par.room = null; if (par.disc === 'black') par.side = 'black';
        this.addLog('Паразит уничтожен.', null, 'kill');
      } else {
        const g = this.parasites.find(q => !q.room && q.disc === 'gray');
        if (g) { g.room = par.room; par.room = null; par.side = 'black'; par = g; }
        else par.side = 'gray';
        this.addLog('Чёрный паразит ранен и становится серым.', null, 'kill');
      }
    }
  }

  // ---------------- персонажи ----------------
  alive(p) { return !p.eliminated && (p.chars.trooper.alive || p.chars.android.alive); }
  alivePlayers() { return this.players.filter(p => this.alive(p)); }
  charsIn(key) {
    const out = [];
    for (const p of this.players) for (const k of ['trooper', 'android']) {
      const c = p.chars[k]; if (c.alive && c.room === key) out.push({ p, kind: k, c });
    }
    return out;
  }
  othersIn(key, p) { return [...new Set(this.charsIn(key).filter(x => x.p !== p).map(x => x.p))]; }
  isItem(c) { return c.t !== 'infect' && c.t !== 'host'; }
  canTrade(p) { return p.hand.some(c => this.canGive(p, c)); }
  takeFromHand(p, cardId, type) {
    const i = p.hand.findIndex(c => c.id === cardId && (!type || c.t === type));
    must(i >= 0, 'Такой карты нет на руке');
    return p.hand.splice(i, 1)[0];
  }
  drawSearch() {
    if (!this.deck.length && this.discard.length) {
      this.deck = shuffle(this.discard); this.discard = [];
      this.addLog('Колода поиска закончилась — сброс перемешан в новую колоду.', null, 'sys');
    }
    return this.deck.shift() || null;
  }

  // ---------------- ход ----------------
  nextAliveFrom(idx) {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) { const j = (idx + k) % n; if (this.alive(this.players[j])) return j; }
    return -1;
  }
  nextTurn() {
    if (this.over) return;
    const j = this.nextAliveFrom(this.curIdx < 0 ? this.players.length - 1 : this.curIdx);
    if (j < 0) return this.endGame('infected', 'Все персонажи погибли.');
    const N = this.alivePlayers().length;
    if (this.turnsSincePP >= N + 1) {
      this.turnsSincePP = 0;
      const pp = this.players[j];
      this.markerIdx = j;
      this.parasitePhase(pp, () => {
        this.markerIdx = this.nextAliveFrom(j);
        if (!this.alive(pp)) { this.curIdx = j; return this.nextTurn(); }
        this.beginTurn(j);
      });
    } else this.beginTurn(j);
  }
  beginTurn(j) {
    if (this.over) return;
    const p = this.players[j];
    this.curIdx = j; this.turnsSincePP++; this.turnNo++;
    let first = false;
    if (!p.arrived) {
      p.arrived = true; first = true;
      for (const k of ['trooper', 'android']) p.chars[k].room = this.cards[0].id + '.0';
      this.addLog(`${p.name} прибывает на станцию — оба персонажа в Реакторе.`);
    }
    const ap = ['trooper', 'android'].reduce((s, k) => s + (p.chars[k].alive ? apOf(p.chars[k].hp) : 0), 0);
    this.turn = {
      pid: p.id, ap, first, searched: false, usedTerminal: false, skipUsed: false,
      traded: new Set(), attacked: new Set(), runFree: {},
    };
    this.addLog(`▶ Ход игрока ${p.name} (${ap} ОД).`, null, 'turn');
  }
  endTurn(p) {
    must(this.turn && this.turn.pid === p.id, 'Сейчас не ваш ход');
    must(!this.pending, 'Сначала завершите текущее действие');
    this.addLog(`${p.name} завершает ход.`);
    this.turn = null;
    this.nextTurn();
  }
  parasitePhase(pp, after) {
    if (this.doorsOpen) { this.doorsOpen = false; this.addLog('Двери безопасности снова закрыты.', null, 'sys'); }
    const onBoard = this.parasites.filter(q => q.room);
    this.addLog(`☣ Фаза паразитов (маркер у игрока ${pp.name}).`, null, 'phase');
    if (onBoard.length) {
      const v = this.roll(pp.name, 'движение паразитов');
      const dir = D4_DIR[v];
      let movedN = 0;
      for (const q of onBoard) {
        const R = this.roomInfo(q.room); const dbl = R.card.rooms.length === 2;
        let to = null;
        if (dbl && ((dir === 'down' && R.i === 0) || (dir === 'up' && R.i === 1))) to = R.card.id + '.' + (1 - R.i);
        else { const l = this.links(q.room).find(l => l.dir === dir && l.type === 'D'); if (l) to = l.to; }
        if (to) { q.room = to; movedN++; }
      }
      this.addLog(`🎲 ${pp.name} бросает D4: ${v} — паразиты ползут ${DIRS[dir].ru} (сдвинулось: ${movedN} из ${onBoard.length}).`, null, 'alert');
    } else this.addLog('Паразитов на станции нет.', null, 'sys');
    const batch = [];
    for (const p of this.players) for (const k of ['trooper', 'android']) {
      const c = p.chars[k]; if (!c.alive || !c.room) continue;
      const dmg = this.parasitesIn(c.room).reduce((s, q) => s + (q.side === 'black' ? 2 : 1), 0);
      if (dmg) batch.push({ pid: p.id, kind: k, amt: dmg, src: 'паразиты' });
    }
    this.damage(batch, after);
  }

  // ---------------- урон и броня ----------------
  damage(batch, after) {
    const by = {};
    for (const h of batch) {
      const p = this.player(h.pid); if (!p || !p.chars[h.kind].alive) continue;
      by[h.pid] = by[h.pid] || {}; by[h.pid][h.kind] = (by[h.pid][h.kind] || 0) + h.amt;
    }
    const asks = {};
    for (const [pid, hits] of Object.entries(by)) {
      const p = this.player(pid);
      const armor = p.hand.filter(c => c.t === 'armor').length;
      const maxPlay = armor;
      const same = hits.trooper && hits.android && p.chars.trooper.room === p.chars.android.room;
      const useful = same ? Math.max(hits.trooper, hits.android) : (hits.trooper || 0) + (hits.android || 0);
      const max = Math.min(maxPlay, useful);
      if (max > 0) asks[pid] = { hits, max, src: batch.find(b => b.pid === pid).src };
    }
    const finish = (answers) => {
      this.pending = null;
      for (const [pid, hits] of Object.entries(by)) {
        const p = this.player(pid);
        let n = Math.max(0, Math.min((answers[pid] || 0), asks[pid] ? asks[pid].max : 0));
        if (n) {
          for (let k = 0; k < n; k++) this.discard.push(this.takeFromHand(p, p.hand.find(c => c.t === 'armor').id));
          const same = hits.trooper && hits.android && p.chars.trooper.room === p.chars.android.room;
          for (let k = 0; k < n; k++) {
            if (same) { hits.trooper = Math.max(0, hits.trooper - 1); hits.android = Math.max(0, hits.android - 1); }
            else {
              const kk = (hits.trooper || 0) >= (hits.android || 0) ? 'trooper' : 'android';
              hits[kk] = Math.max(0, (hits[kk] || 0) - 1);
            }
          }
          this.addLog(`🛡 ${p.name} использует бронежилет ×${n}.`, null, 'armor');
        }
        for (const k of ['trooper', 'android']) {
          const amt = hits[k] || 0; if (!amt) continue;
          const c = p.chars[k];
          c.hp = Math.max(0, c.hp - amt);
          this.addLog(`💥 ${this.cname(p, k)} получает ${amt} ур. (здоровье ${c.hp}/4).`, null, 'dmg');
          if (c.hp <= 0) { c.alive = false; c.room = null; this.addLog(`☠ ${this.cname(p, k)} погибает!`, null, 'death'); }
        }
        if (!p.eliminated && !p.chars.trooper.alive && !p.chars.android.alive) {
          p.eliminated = true;
          this.removed.push(...p.hand); p.hand = [];
          for (const t of TABLE_ITEMS) { if (t === 'ammo') p.table.ammo = []; else p.table[t] = null; }
          this.addLog(`☠ ${p.name} выбывает из игры. Его карты уходят из игры.`, null, 'death');
        }
      }
      this.checkWin();
      if (!this.over && after) after();
    };
    if (!Object.keys(asks).length) return finish({});
    // за одним устройством таймера нет: нужно время, чтобы передать его атакованному
    this.pending = { type: 'armor', id: ++this.seq, asks, answers: {}, finish, deadline: this.local ? null : Date.now() + 45000 };
    const pend = this.pending;
    if (this.local) return;
    pend.timer = setTimeout(() => {
      if (this.pending !== pend) return;
      this.addLog('Время на бронежилет вышло.', null, 'sys');
      try { pend.finish(pend.answers); } catch (e) { console.error(e); }
      this.onChange();
    }, 45000);
    if (pend.timer.unref) pend.timer.unref();
  }

  // ---------------- сканирование и победа ----------------
  heatScan(reason) {
    const alive = this.alivePlayers();
    const inf = alive.filter(p => p.infected).length;
    const clean = alive.length - inf;
    this.lastScan = { inf, clean, seq: ++this.scanSeq, reason };
    this.addLog(`🌡 ТЕПЛОВОЕ СКАНИРОВАНИЕ (${reason}): заражённых — ${inf}, чистых — ${clean}.`, null, 'scan');
    if (clean === 0) return this.endGame('infected', 'Сканирование показало: все выжившие заражены.');
    if (clean === 1) {
      const h = alive.find(p => !p.infected);
      const gasHand = h.hand.filter(c => c.t === 'gas').length;
      const gasDeck = this.deck.concat(this.discard).filter(c => c.t === 'gas').length;
      if (!gasHand && !gasDeck) return this.endGame('infected', 'Остался один человек, и канистр больше нет.');
    }
  }
  checkWin() {
    if (this.over || this.phase !== 'play') return;
    if (this.expDeck.length === 1 && this.expDeck[0] === 'hive' && !this.placementsAny(EXP_BY_ID.hive).length)
      return this.endGame('infected', 'Улей невозможно выложить на поле — станция потеряна.');
    const humanTroopers = this.players.filter(p => !p.infected && !p.eliminated && p.chars.trooper.alive);
    if (!humanTroopers.length) this.endGame('infected', 'Не осталось ни одного живого незаражённого Штурмовика — Улей некому сжечь.');
  }
  endGame(side, reason) {
    if (this.over) return;
    let winners;
    if (side === 'humans') winners = this.players.filter(p => !p.infected).map(p => p.id);
    else {
      const inf = this.players.filter(p => p.infected && this.alive(p));
      const last = this.infOrder[this.infOrder.length - 1];
      winners = inf.filter(p => this.infOrder.length <= 1 || p.id !== last).map(p => p.id);
      if (!winners.length) winners = inf.map(p => p.id);
    }
    this.over = { side, reason, winners };
    this.phase = 'over';
    if (this.pending && this.pending.timer) clearTimeout(this.pending.timer);
    this.pending = null;
    this.addLog(side === 'humans' ? `🔥 УЛЕЙ СОЖЖЁН! Люди победили. ${reason}` : `☣ ПОБЕДА ЗАРАЖЁННЫХ. ${reason}`, null, 'over');
  }

  // ---------------- допустимые действия (для подсказок клиенту) ----------------
  charOptions(p, kind) {
    const c = p.chars[kind];
    if (!c.alive || !c.room) return null;
    const t = this.turn; const room = c.room; const R = this.roomInfo(room);
    const o = { room, moves: [], explore: [], search: false, partners: [], terminal: false, heal: false, burn: false, shootRooms: [], adjRooms: [] };
    const links = this.links(room);
    const free = t.runFree[kind] === room;
    for (const l of links) {
      if (this.passable(p, l) && (t.ap >= 1 || free)) o.moves.push({ to: l.to, free, sec: l.type === 'S' });
      if (this.passable(p, l)) o.adjRooms.push(l.to);
    }
    if (t.ap >= 1) {
      const idx = this.exploreCardIdx();
      if (idx >= 0) o.explore = this.placementsFrom(EXP_BY_ID[this.expDeck[idx]], room);
      const icon = ROOM_TYPES[R.type].icon;
      if (icon) {
        o.search = true;
        if (R.type === 'search' && !t.attacked.has(room)) o.partners = this.othersIn(room, p).map(q => q.id);
      }
      if (R.type === 'terminal' && !t.usedTerminal) o.terminal = true;
      if (R.type === 'sickbay') o.heal = true;
      if (R.type === 'hive' && kind === 'trooper' && !p.infected && p.hand.filter(x => x.t === 'gas').length >= this.gasToBurn) o.burn = true;
      if (kind === 'android') { o.shootRooms = [room]; if (p.table.scope) o.shootRooms.push(...o.adjRooms.filter(r => !o.shootRooms.includes(r))); }
    }
    return o;
  }
  optionsFor(p) {
    if (this.phase !== 'play' || !this.turn || this.turn.pid !== p.id || this.pending) return null;
    const idx = this.exploreCardIdx();
    return {
      chars: { trooper: this.charOptions(p, 'trooper'), android: this.charOptions(p, 'android') },
      reveal: (this.turn.ap >= 1 && idx >= 0) ? this.placementsAny(EXP_BY_ID[this.expDeck[idx]]) : [],
      canSkipExplore: !this.turn.skipUsed && this.expDeck.length > 1 && idx === 0 && this.expDeck[0] !== 'hive' && !this.placementsAny(EXP_BY_ID[this.expDeck[0]]).length,
      bullets: p.table.ammo.reduce((s, a) => s + a.bullets, 0),
    };
  }

  // ---------------- ДЕЙСТВИЯ ----------------
  act(pid, a) {
    this.touched = Date.now();
    const p = this.player(pid); must(p, 'Нет такого игрока');
    a = a || {};
    if (a.type === 'chat') {
      const text = String(a.text || '').trim().slice(0, 300); if (!text) return;
      this.chat.push({ seq: ++this.seq, name: p.name, color: p.color, text, at: Date.now() });
      if (this.chat.length > 200) this.chat.shift();
      return;
    }
    if (this.phase === 'lobby') return this.lobbyAct(p, a);
    must(this.phase === 'play', 'Игра окончена');
    const P = this.pending;
    if (a.type === 'armor') { must(P && P.type === 'armor' && P.asks[p.id], 'Сейчас бронежилет не нужен'); return this.armorAnswer(p, a); }
    if (a.type === 'tradePick') { must(P && P.type === 'trade' && (P.a === p.id || P.b === p.id), 'Вы не участвуете в обмене'); return this.tradePick(p, a); }
    must(this.turn && this.turn.pid === p.id, 'Сейчас не ваш ход');
    if (P) {
      must(P.type === 'entry', 'Ожидаем ответа других игроков');
      must(['tradeWith', 'gun', 'knife'].includes(a.type), 'Войдя в комнату с другими, сначала обменяйтесь картами или атакуйте');
    }
    const t = this.turn;
    const needAP = (n = 1) => must(t.ap >= n, 'Не хватает очков действия');
    const ch = (kind) => { must(kind === 'trooper' || kind === 'android', 'Выберите персонажа'); const c = p.chars[kind]; must(c.alive && c.room, 'Персонаж недоступен'); return c; };

    switch (a.type) {
      case 'end': return this.endTurn(p);

      case 'move': {
        const c = ch(a.kind);
        const l = this.links(c.room).find(l => l.to === a.to);
        must(l, 'Туда нельзя пройти');
        must(this.passable(p, l), 'Дверь безопасности закрыта (нужна ключ-карта или терминал)');
        const free = t.runFree[a.kind] === c.room;
        if (!free) needAP();
        const from = c.room;
        delete t.runFree[a.kind];
        if (!free) t.ap--;
        c.room = a.to;
        this.addLog(`${this.cname(p, a.kind)}: ${this.roomName(from)} → ${this.roomName(a.to)}${free ? ' (бег, бесплатно)' : ''}.`);
        return this.onEnter(p, a.kind, a.to);
      }

      case 'explore': {
        const c = ch(a.kind); needAP();
        const idx = this.exploreCardIdx();
        must(idx !== -1, 'Колода исследования пуста');
        if (idx === -2) { this.endGame('infected', 'Улей невозможно выложить — станция поглощена.'); return; }
        const def = EXP_BY_ID[this.expDeck[idx]];
        const pl = this.placementsFrom(def, c.room).find(q => q.x === a.x && q.y === a.y);
        must(pl && pl.rots.includes(a.rot), 'Сюда эту карту выложить нельзя');
        this.expDeck.splice(idx, 1); t.ap--;
        const card = this.placeCard(def, a.x, a.y, a.rot);
        this.addLog(`🧭 ${this.cname(p, a.kind)} исследует: новая локация «${card.rooms.map(r => ROOM_TYPES[r].ru).join(' / ')}».`, null, 'explore');
        if (def.id === 'hive') { this.addLog('☣ ОБНАРУЖЕН УЛЕЙ! Автоматическое тепловое сканирование…', null, 'phase'); this.heatScan('найден Улей'); }
        return;
      }

      case 'exploreSkip': {
        const o = this.optionsFor(p); must(o && o.canSkipExplore, 'Эту карту можно выложить — пропуск не нужен');
        t.skipUsed = true; this.expDeck.push(this.expDeck.shift());
        this.addLog(`${p.name}: верхнюю карту исследования некуда выложить — она уходит под низ колоды.`);
        return;
      }

      case 'search': {
        const c = ch(a.kind); needAP();
        const R = this.roomInfo(c.room);
        must(ROOM_TYPES[R.type].icon, 'Эту комнату нельзя обыскать');
        let partner = null;
        if (a.partner) {
          must(R.type === 'search', 'Совместный обыск только в комнате с лупой');
          must(!t.attacked.has(c.room), 'Вы атаковали здесь игрока — совместный обыск запрещён');
          partner = this.player(a.partner);
          must(partner && partner !== p && this.charsIn(c.room).some(x => x.p === partner), 'Этого игрока нет в комнате');
        }
        t.ap--; t.searched = true; delete t.runFree[a.kind];
        this.addLog(`🔎 ${this.cname(p, a.kind)} обыскивает «${R.type === 'storage' && !R.card.red ? 'Склад (3 карты)' : ROOM_TYPES[R.type].ru}»${partner ? ' вместе с ' + partner.name : ''}.`);
        if (R.card.red) { this.addLog('Комната уже обыскана — шум привлекает паразита!', null, 'alert'); this.spawn(c.room, p.name); }
        if (partner) {
          const drawn = [this.drawSearch(), this.drawSearch()].filter(Boolean);
          shuffle(drawn);
          const who = [p, partner];
          drawn.forEach((card, k) => this.receiveSearch(who[k], card, c.room));
        } else {
          const n = (R.type === 'storage' && !R.card.red) ? 3 : 1;
          for (let k = 0; k < n; k++) { const card = this.drawSearch(); if (card) this.receiveSearch(p, card, c.room); }
        }
        R.card.red = true;
        return;
      }

      case 'terminal': {
        const c = ch(a.kind); needAP();
        const R = this.roomInfo(c.room);
        must(R.type === 'terminal', 'Здесь нет терминала');
        must(!t.usedTerminal, 'Терминал можно использовать один раз за ход');
        let pl = null, def = null, idx = -1;
        if (a.mode === 'reveal') {
          idx = this.exploreCardIdx(); must(idx >= 0, 'Нет карты для показа');
          def = EXP_BY_ID[this.expDeck[idx]];
          pl = this.placementsAny(def).find(q => q.x === a.x && q.y === a.y);
          must(pl && pl.rots.includes(a.rot), 'Сюда карту выложить нельзя');
        } else must(a.mode === 'scan' || a.mode === 'doors', 'Неизвестная функция терминала');
        t.ap--; t.usedTerminal = true;
        if (R.card.red) { this.addLog('Терминал уже использовали — паразит идёт на звук!', null, 'alert'); this.spawn(c.room, p.name); }
        R.card.red = true;
        if (a.mode === 'scan') { this.addLog(`💻 ${p.name} запускает тепловое сканирование с терминала.`); this.heatScan('терминал'); }
        else if (a.mode === 'doors') { this.doorsOpen = true; this.addLog(`💻 ${p.name} открывает ВСЕ двери безопасности до следующей фазы паразитов.`, null, 'sys'); }
        else {
          this.expDeck.splice(idx, 1);
          const card = this.placeCard(def, a.x, a.y, a.rot);
          this.addLog(`💻 ${p.name} включает камеры: открыта локация «${card.rooms.map(r => ROOM_TYPES[r].ru).join(' / ')}».`, null, 'explore');
          if (def.id === 'hive') { this.addLog('☣ ОБНАРУЖЕН УЛЕЙ! Автоматическое тепловое сканирование…', null, 'phase'); this.heatScan('найден Улей'); }
        }
        return;
      }

      case 'heal': {
        const c = ch(a.kind); needAP();
        const R = this.roomInfo(c.room);
        must(R.type === 'sickbay', 'Лечиться можно только в Лазарете');
        const other = a.kind === 'trooper' ? 'android' : 'trooper';
        const both = p.chars[other].alive && p.chars[other].room === c.room;
        t.ap--;
        if (R.card.red) { this.addLog('Лазарет уже использовали — паразит идёт на запах крови!', null, 'alert'); this.spawn(c.room, p.name); }
        R.card.red = true;
        if (both && a.split) {
          for (const k of ['trooper', 'android']) p.chars[k].hp = Math.min(4, p.chars[k].hp + 1);
          this.addLog(`✚ ${p.name} лечит обоих персонажей (+1).`);
        } else {
          const tk = (both && a.target === other) ? other : a.kind;
          p.chars[tk].hp = Math.min(4, p.chars[tk].hp + 2);
          this.addLog(`✚ ${this.cname(p, tk)} лечится в Лазарете (+2).`);
        }
        return;
      }

      case 'equip': {
        const card = p.hand.find(x => x.id === a.card);
        must(card && TABLE_ITEMS.includes(card.t), 'Эту карту нельзя выложить на стол');
        if (card.t !== 'ammo') must(!p.table[card.t], 'Такой предмет уже лежит у вас на столе');
        this.takeFromHand(p, card.id);
        if (card.t === 'ammo') p.table.ammo.push({ card, bullets: AMMO_PER_CARD }); else p.table[card.t] = card;
        this.addLog(`${p.name} выкладывает на стол: ${ITEMS[card.t].ru}.`);
        return;
      }

      case 'energy': {
        this.discard.push(this.takeFromHand(p, a.card, 'energy'));
        t.ap += 2;
        this.addLog(`⚡ ${p.name} пьёт энергетик: +2 ОД.`);
        return;
      }

      case 'firstaid': {
        const c = ch(a.healer);
        const alloc = Array.isArray(a.alloc) ? a.alloc : [];
        let total = 0;
        for (const al of alloc) {
          const q = this.player(al.pid); must(q, 'Нет такого игрока');
          const qc = q.chars[al.kind]; must(qc && qc.alive && qc.room === c.room, 'Лечить можно только персонажей в той же комнате');
          must(al.amt >= 1 && al.amt <= 2, 'Неверное лечение'); total += al.amt;
        }
        must(total >= 1 && total <= 2, 'Аптечка лечит 2 раны');
        this.discard.push(this.takeFromHand(p, a.card, 'firstaid'));
        for (const al of alloc) {
          const q = this.player(al.pid); q.chars[al.kind].hp = Math.min(4, q.chars[al.kind].hp + al.amt);
          this.addLog(`✚ ${p.name} использует аптечку: ${this.cname(q, al.kind)} +${al.amt}.`);
        }
        return;
      }

      case 'scanner': {
        const c = ch(a.kind); needAP();
        const q = this.player(a.target);
        must(q && q !== p && this.charsIn(c.room).some(x => x.p === q), 'Цель должна быть в одной комнате с вашим персонажем');
        this.discard.push(this.takeFromHand(p, a.card, 'scanner'));
        t.ap--;
        this.addLog(`📟 ${this.cname(p, a.kind)} сканирует игрока ${q.name} тепловым сканером.`);
        this.priv(p, `📟 Рука игрока ${q.name}: ` + q.hand.map(x => this.cardLabel(x)).join(', '), 'scanres');
        this.priv(q, `${p.name} увидел все карты у вас на руке.`);
        p.scanReveal = { seq: ++this.seq, name: q.name, hand: q.hand.map(x => ({ t: x.t, c: x.c })) };
        return;
      }

      case 'grenade': {
        const c = ch(a.kind); needAP();
        const l = this.links(c.room).find(l => l.to === a.room);
        must(l && this.passable(p, l), 'Гранату можно бросить только в соседнюю (доступную) комнату');
        this.discard.push(this.takeFromHand(p, a.card, 'grenade'));
        t.ap--; t.attacked.add(a.room);
        this.addLog(`💣 ${this.cname(p, a.kind)} бросает гранату в «${this.roomName(a.room)}»!`, null, 'dmg');
        for (const q of this.parasitesIn(a.room)) this.hitParasite(q, 1);
        const batch = this.charsIn(a.room).map(x => ({ pid: x.p.id, kind: x.kind, amt: 1, src: 'граната' }));
        this.damage(batch, null);
        return;
      }

      case 'gun': {
        const c = ch('android'); needAP();
        const bullets = p.table.ammo.reduce((s, x) => s + x.bullets, 0);
        must(bullets > 0, 'Нет патронов (выложите карту патронов на стол)');
        const shots = p.table.heavygun ? Math.min(2, bullets) : 1;
        const targets = (Array.isArray(a.targets) ? a.targets : []).slice(0, shots);
        must(targets.length >= 1, 'Выберите цель');
        const okRooms = [c.room].concat(p.table.scope ? this.links(c.room).filter(l => this.passable(p, l)).map(l => l.to) : []);
        const resolved = targets.map(tg => this.resolveTarget(p, tg, okRooms));
        if (P) must(resolved.every(r => r.kind && r.room === P.room), 'Войдя в комнату, можно атаковать только персонажа в ней');
        t.ap--;
        for (let k = 0; k < resolved.length; k++) {
          const a0 = p.table.ammo[0]; a0.bullets--; if (a0.bullets <= 0) { this.discard.push(a0.card); p.table.ammo.shift(); }
        }
        return this.doAttack(p, 'android', resolved, 'выстрел');
      }

      case 'knife': {
        must(p.table.knife, 'Нужен боевой нож на столе');
        const c = ch(a.kind); needAP();
        const r = this.resolveTarget(p, a.target, [c.room]);
        if (P) must(r.kind && r.room === P.room, 'Войдя в комнату, можно атаковать только персонажа в ней');
        t.ap--;
        const v = this.roll(p.name, 'удар ножом');
        this.addLog(`🔪 ${this.cname(p, a.kind)} бьёт ножом (${r.label}): на кубике ${v} — ${v >= 3 ? 'попадание!' : 'промах.'}`, null, 'dmg');
        if (r.kind) t.attacked.add(r.room);
        if (P && r.kind) { this.pending = null; }
        if (v >= 3) {
          if (r.par) { this.hitParasite(r.par, 1); return; }
          return this.damage([{ pid: r.p.id, kind: r.kind, amt: 1, src: 'нож' }], null);
        }
        return;
      }

      case 'burn': {
        const c = ch('trooper'); needAP();
        must(this.roomType(c.room) === 'hive', 'Штурмовик должен стоять в Улье');
        must(!p.infected, 'Заражённый не может сжечь Улей');
        const gas = p.hand.filter(x => x.t === 'gas');
        must(gas.length >= this.gasToBurn, `Нужно ${this.gasToBurn} канистры`);
        for (let k = 0; k < this.gasToBurn; k++) this.discard.push(this.takeFromHand(p, gas[k].id));
        t.ap--;
        this.addLog(`🔥 ${p.name}: огнемёт Штурмовика заправлен ${this.gasToBurn} канистрами — Улей горит!`, null, 'over');
        return this.endGame('humans', `${p.name} сжёг Улей.`);
      }

      case 'tradeWith': {
        must(P && P.type === 'entry', 'Сейчас не нужно меняться');
        const q = this.player(a.target);
        must(q && P.partners.includes(q.id), 'С этим игроком нельзя меняться');
        this.pending = { type: 'trade', id: ++this.seq, a: p.id, b: q.id, room: P.room, picks: {} };
        this.addLog(`🔁 ${p.name} обменивается картами с ${q.name}…`, null, 'trade');
        return;
      }

      default: throw new GameError('Неизвестное действие');
    }
  }

  cardLabel(c) { return c.t === 'infect' ? `Заражение (${COLORS[c.c].ru})` : ITEMS[c.t].ru; }

  resolveTarget(p, tg, okRooms) {
    must(tg && typeof tg === 'object', 'Нет цели');
    if (tg.par) {
      const q = this.parasites.find(x => x.id === tg.par && x.room);
      must(q && okRooms.includes(q.room), 'Паразит вне досягаемости');
      return { par: q, room: q.room, label: (q.side === 'black' ? 'чёрный' : 'серый') + ' паразит' };
    }
    const q = this.player(tg.pid); must(q, 'Нет такой цели');
    const qc = q.chars[tg.kind]; must(qc && qc.alive && okRooms.includes(qc.room), 'Цель вне досягаемости');
    must(!(q === p && tg.kind === 'android'), 'Андроид не стреляет в себя');
    return { p: q, kind: tg.kind, room: qc.room, label: this.cname(q, tg.kind) };
  }

  doAttack(p, kind, resolved, what) {
    const t = this.turn;
    const batch = [];
    for (const r of resolved) {
      this.addLog(`🔫 ${this.cname(p, kind)}: ${what} по цели «${r.label}».`, null, 'dmg');
      if (r.par) this.hitParasite(r.par, 1);
      else { batch.push({ pid: r.p.id, kind: r.kind, amt: 1, src: what }); if (r.p !== p) t.attacked.add(r.room); }
    }
    if (this.pending && this.pending.type === 'entry' && batch.length) this.pending = null;
    this.damage(batch, null);
  }

  onEnter(p, kind, key) {
    const t = this.turn;
    const type = this.roomType(key);
    if (type === 'parasite') { this.addLog('Шорох в вентиляции…', null, 'alert'); this.spawn(key, p.name); }
    const others = this.othersIn(key, p);
    if (type === 'run' && !others.length) {
      t.runFree[kind] = key;
      this.priv(p, `🏃 ${KIND_RU[kind]} в комнате «Бег»: следующее перемещение отсюда — бесплатно (если не обыскивать).`);
    }
    // без минимума карт на руке кому-то может быть нечего отдать — с ним обмен не начинаем
    const partners = this.canTrade(p) ? others.filter(q => this.canTrade(q)) : [];
    if (type !== 'reactor' && partners.length && !t.traded.has(key) && !t.attacked.has(key)) {
      this.pending = { type: 'entry', id: ++this.seq, pid: p.id, kind, room: key, partners: partners.map(q => q.id) };
      this.addLog(`${p.name} входит в комнату к ${others.map(q => q.name).join(', ')} — обмен или атака.`, null, 'trade');
    }
  }

  receiveSearch(p, card, roomKey) {
    if (card.t === 'alert') {
      this.discard.push(card);
      this.addLog(`🚨 ${p.name} находит «Тревогу: паразит!»`, null, 'alert');
      const from = ['trooper', 'android'].map(k => p.chars[k]).find(c => c.alive && c.room === roomKey);
      this.spawn(from ? from.room : roomKey, p.name);
      return;
    }
    this.giveCard(p, card);
    this.priv(p, `Вы нашли: ${this.cardLabel(card)}.`, 'found');
  }

  // ---------------- обмен ----------------
  canGive(p, c) {
    if (c.t === 'host') return this.options.hostRule && p.isHost && !p.hand.some(x => x.t === 'infect' && x.c === p.color);
    if (c.t === 'infect') { if (c.c === p.color) return p.infected; return !p.hand.some(x => this.isItem(x)); }
    return true;
  }
  tradePick(p, a) {
    const P = this.pending;
    must(!P.picks[p.id], 'Вы уже выбрали карту');
    const c = p.hand.find(x => x.id === a.card);
    must(c, 'Такой карты нет на руке');
    must(this.canGive(p, c), c.t === 'infect' && c.c === p.color ? 'Незаражённый игрок не может отдавать карты заражения своего цвета' : 'Эту карту сейчас нельзя отдать');
    P.picks[p.id] = c.id;
    if (!(P.picks[P.a] && P.picks[P.b])) return;
    const A = this.player(P.a), B = this.player(P.b);
    const ca = this.takeFromHand(A, P.picks[P.a]), cb = this.takeFromHand(B, P.picks[P.b]);
    this.pending = null;
    if (this.turn) this.turn.traded.add(P.room);
    A.hand.push(cb); B.hand.push(ca);
    this.priv(A, `🔁 Вы отдали «${this.cardLabel(ca)}» и получили от ${B.name}: «${this.cardLabel(cb)}».`, 'trade');
    this.priv(B, `🔁 Вы отдали «${this.cardLabel(cb)}» и получили от ${A.name}: «${this.cardLabel(ca)}».`, 'trade');
    this.addLog(`🔁 ${A.name} и ${B.name} обменялись картами.`, null, 'trade');
    const tryInfect = (g, r, given, back) => {
      const infCard = (given.t === 'infect' && given.c === g.color) || given.t === 'host';
      if (!g.infected || !infCard || r.infected) return;
      if (back.t === 'gas') { this.priv(r, `⛽ Вы получили карту заражения от ${g.name}, но отдали канистру — заражение отбито! (${g.name} заражён)`, 'dodge'); return; }
      r.infected = true; this.infOrder.push(r.id);
      if (given.t === 'host') { r.isHost = true; g.isHost = false; }
      this.priv(r, `☣ ВЫ ЗАРАЖЕНЫ игроком ${g.name}! Теперь вы на стороне паразитов (оба ваших персонажа). Не выдавайте себя.`, 'infected');
      this.priv(g, `☣ Заражение удалось: ${r.name} теперь заражён.`, 'infected');
    };
    tryInfect(A, B, ca, cb); tryInfect(B, A, cb, ca);
    this.checkWin();
  }
  armorAnswer(p, a) {
    const P = this.pending;
    P.answers[p.id] = Math.max(0, Math.min(+a.n || 0, P.asks[p.id].max));
    P.done = P.done || {}; P.done[p.id] = true;
    if (Object.keys(P.asks).every(id => P.done[id])) { clearTimeout(P.timer); P.finish(P.answers); }
  }

  lobbyAct(p, a) {
    if (a.type === 'color') {
      must(COLORS[a.color], 'Нет такого цвета');
      must(!this.players.some(q => q !== p && q.color === a.color), 'Цвет занят');
      p.color = a.color; return;
    }
    if (a.type === 'rename') { must(!this.platform, 'На платформе имя берётся из аккаунта'); p.name = String(a.name || '').trim().slice(0, 20) || p.name; return; }
    if (a.type === 'options') {
      must(p.id === this.adminId, 'Настройки меняет создатель комнаты');
      for (const k of ['easy', 'hard', 'hostRule']) if (k in a) this.options[k] = !!a[k];
      return;
    }
    if (a.type === 'kick') {
      must(p.id === this.adminId, 'Только создатель комнаты');
      const i = this.players.findIndex(q => q.id === a.target && q.id !== this.adminId);
      if (i >= 0) { this.addLog(`${this.players[i].name} удалён из комнаты.`); this.players.splice(i, 1); }
      return;
    }
    if (a.type === 'start') return this.start(p.id);
    throw new GameError('Игра ещё не началась');
  }

  // ---------------- ВИД ДЛЯ ИГРОКА (скрытая информация не уходит!) ----------------
  view(pid) {
    const me = this.player(pid);
    const showAll = this.phase === 'over';
    const v = {
      code: this.code, phase: this.phase, local: this.local, platform: this.platform, maxPlayers: this.maxPlayers, me: pid, adminId: this.adminId, options: this.options,
      colors: COLORS, items: ITEMS, roomTypes: ROOM_TYPES,
      players: this.players.map(p => ({
        id: p.id, name: p.name, color: p.color, seat: p.seat,
        handCount: p.hand.length, eliminated: p.eliminated, arrived: p.arrived,
        chars: p.chars, table: { ammo: p.table.ammo.map(x => x.bullets), heavygun: !!p.table.heavygun, scope: !!p.table.scope, knife: !!p.table.knife, keycard: !!p.table.keycard },
        connected: !!p.connected,
        infected: showAll || p.id === pid ? p.infected : undefined,
        isHost: showAll || p.id === pid ? p.isHost : undefined,
        hand: showAll ? p.hand.map(c => ({ t: c.t, c: c.c })) : undefined,
      })),
      chat: this.chat.slice(-60),
      log: this.log.filter(l => !l.to || l.to === pid).slice(-120),
    };
    if (me) { v.hand = me.hand; v.infected = me.infected; v.isHost = me.isHost; v.scanReveal = me.scanReveal || null; }
    if (this.phase === 'lobby') return v;
    Object.assign(v, {
      cards: this.cards.map(c => ({ id: c.id, def: c.def, x: c.x, y: c.y, rot: c.rot, rooms: c.rooms, e: c.e, red: c.red, art: c.art })),
      parasites: this.parasites.filter(q => q.room).map(q => ({ id: q.id, side: q.side, room: q.room })),
      reserve: { gray: this.parasites.filter(q => !q.room && q.disc === 'gray').length, black: this.parasites.filter(q => !q.room && q.disc === 'black').length },
      expCount: this.expDeck.length,
      expTop: this.expDeck.length ? (() => { const i = Math.max(0, this.exploreCardIdx()); const d = EXP_BY_ID[this.expDeck[i]]; return { def: d.id, o0: orient(d, 0), o180: orient(d, 180), art: d.art || null }; })() : null,
      deckCount: this.deck.length, discardCount: this.discard.length,
      discardTop: this.discard.length ? this.discard[this.discard.length - 1].t : null,
      turn: this.turn ? { pid: this.turn.pid, ap: this.turn.ap, first: this.turn.first, searched: this.turn.searched, usedTerminal: this.turn.usedTerminal, runFree: this.turn.runFree, no: this.turnNo } : null,
      markerPid: this.players[this.markerIdx] ? this.players[this.markerIdx].id : null,
      doorsOpen: this.doorsOpen, lastRoll: this.lastRoll, lastScan: this.lastScan,
      gasToBurn: this.gasToBurn, over: this.over,
      opts: me ? this.optionsFor(me) : null,
    });
    const P = this.pending;
    if (P) {
      if (P.type === 'entry') v.pending = { type: 'entry', id: P.id, pid: P.pid, kind: P.kind, room: P.room, partners: P.partners };
      else if (P.type === 'trade') {
        v.pending = { type: 'trade', id: P.id, a: P.a, b: P.b, room: P.room, picked: Object.keys(P.picks) };
        if (pid === P.a || pid === P.b) v.pending.giveable = me.hand.filter(c => this.canGive(me, c)).map(c => c.id);
      } else if (P.type === 'armor') v.pending = { type: 'armor', id: P.id, waiting: Object.keys(P.asks).filter(id => !(P.done || {})[id]), mine: P.asks[pid] || null, deadline: P.deadline };
    }
    return v;
  }
}

// ---------------------------------------------------------------------------
//  КЛИЕНТ (выполняется в браузере; сервер вставляет этот код в страницу)
// ---------------------------------------------------------------------------
function clientMain() {
  'use strict';
  const IMG = '/assets/img/';
  const TW = 150, TH = 210;
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KIND = { trooper: 'Штурмовик', android: 'Андроид' };
  const DIR_ARROW = { up: '↑', right: '→', down: '↓', left: '←' };
  const ITEM_IMG = { gas: 'gas', ammo: 'ammo', armor: 'armor', keycard: 'keycard', energy: 'energy', firstaid: 'firstaid', grenade: 'grenade', heavygun: 'heavygun', scope: 'scope', knife: 'knife', scanner: 'scanner', alert: 'parasite', host: 'host', infect: 'infect' };

  let S = null;            // последнее состояние с сервера
  let sess = null;         // {code, token}
  let es = null;           // EventSource
  const ui = { sel: 'trooper', mode: null, zoom: 1, panX: 0, panY: 0, fitted: false, seen: { roll: 0, scan: 0, reveal: 0, over: false, chatN: 0 }, tab: 'log', modalKey: null, minimized: {}, lastLogN: 0 };

  // ---------- сессия ----------
  // Платформа Zarya Boardgames открывает стол ссылкой /?name=<ник>&embed=1#/m/<код>: имя — из аккаунта,
  // кнопки «выйти» прячем (встать из-за стола можно на платформе), место запоминаем отдельно для каждого стола.
  const QS = new URLSearchParams(location.search);
  const PLATFORM = { code: ((location.hash.match(/^#\/m\/([A-Za-z0-9]+)/) || [])[1] || '').toUpperCase(), name: (QS.get('name') || '').trim(), embed: QS.has('embed') };
  if (PLATFORM.embed) document.documentElement.classList.add('embed');
  const SESS_KEY = PLATFORM.code ? 'ps_seat:' + PLATFORM.code : 'ps_session';
  function loadSess() { try { return JSON.parse(localStorage.getItem(SESS_KEY) || 'null'); } catch (e) { return null; } }
  function saveSess(s) { try { if (s) localStorage.setItem(SESS_KEY, JSON.stringify(s)); else localStorage.removeItem(SESS_KEY); } catch (e) {} }
  function loadName() { try { return localStorage.getItem('ps_name') || ''; } catch (e) { return ''; } }
  function saveName(n) { try { localStorage.setItem('ps_name', n); } catch (e) {} }

  async function api(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(j.error || ('Ошибка ' + r.status));
    return j;
  }
  async function act(action) {
    if (!sess) return;
    try { await api('/api/action', { code: sess.code, token: sess.token, action }); }
    catch (e) { toast(e.message, 'err'); }
  }

  function connect() {
    if (es) es.close();
    es = new EventSource(`/api/stream?code=${encodeURIComponent(sess.code)}&token=${encodeURIComponent(sess.token)}`);
    es.addEventListener('state', ev => { S = JSON.parse(ev.data); render(); });
    es.addEventListener('gone', () => {
      es.close(); hideCurtain(); renderHandoff(null); saveSess(null); sess = null; S = null;
      if (PLATFORM.code) return renderNotice('Партия закрыта', 'Этого стола больше нет. Создайте новый стол на платформе.');
      toast('Комната не найдена (сервер перезапускался?)', 'err'); renderStart();
    });
    es.onerror = () => { $('#conn') && ($('#conn').className = 'conn bad'); };
    es.onopen = () => { $('#conn') && ($('#conn').className = 'conn ok'); };
  }

  // ---------- вход за стол платформы ----------
  function renderNotice(title, text) {
    document.body.className = 'start';
    $('#app').innerHTML = `<div class="startbox"><div class="startform"><img class="logo" src="${IMG}logo.jpg" alt="Panic Station"><h2>${esc(title)}</h2><p class="lead">${esc(text)}</p></div></div>`;
  }
  async function joinPlatform() {
    try {
      const saved = loadSess(); // место могли освободить на платформе — тогда сервер посадит заново
      const r = await api('/api/join', { code: PLATFORM.code, name: PLATFORM.name, token: saved && saved.token });
      sess = { code: r.code, token: r.token }; saveSess(sess); connect();
    } catch (e) { renderNotice('Не получилось сесть за стол', e.message); }
  }

  // ---------- стартовый экран ----------
  function renderStart() {
    document.body.className = 'start';
    const params = new URLSearchParams(location.search);
    const code = (params.get('code') || '').toUpperCase();
    $('#app').innerHTML = `
      <div class="startbox">
        <img class="cover" src="${IMG}cover.jpg" alt="">
        <div class="startform">
          <img class="logo" src="${IMG}logo.jpg" alt="Panic Station">
          <p class="lead">Recon-6 молчит. Найдите Улей и сожгите его.<br>Но один из вас уже заражён…</p>
          <label>Ваше имя<input id="nm" maxlength="20" value="${esc(loadName())}" placeholder="Например, Саша"></label>
          <div class="row">
            <button id="bCreate" class="btn big">Создать игру</button>
          </div>
          <div class="or">или войти в комнату друга</div>
          <div class="row">
            <input id="cd" maxlength="5" placeholder="КОД" value="${esc(code)}" style="text-transform:uppercase;width:120px;text-align:center;letter-spacing:3px">
            <button id="bJoin" class="btn big">Войти</button>
          </div>
          <div class="or">или</div>
          <button id="bLocal" class="btn big">Играть за одним компьютером</button>
          <details class="pw"><summary>Пароль сервера (если друг его задал)</summary><input id="pw" type="password"></details>
        </div>
      </div>`;
    const nm = () => { const n = $('#nm').value.trim(); saveName(n); return n; };
    $('#bCreate').onclick = async () => {
      try { const r = await api('/api/create', { name: nm(), password: $('#pw').value }); sess = { code: r.code, token: r.token }; saveSess(sess); history.replaceState(null, '', '?code=' + r.code); connect(); }
      catch (e) { toast(e.message, 'err'); }
    };
    $('#bJoin').onclick = async () => {
      const c = $('#cd').value.trim().toUpperCase(); if (!c) return toast('Введите код комнаты', 'err');
      try { const r = await api('/api/join', { code: c, name: nm() }); sess = { code: r.code, token: r.token }; saveSess(sess); history.replaceState(null, '', '?code=' + r.code); connect(); }
      catch (e) { toast(e.message, 'err'); }
    };
    $('#bLocal').onclick = () => renderLocalSetup($('#pw').value);
  }

  // ---------- игра за одним устройством: ввод имён ----------
  function renderLocalSetup(password) {
    document.body.className = 'start';
    let saved = []; try { saved = JSON.parse(localStorage.getItem('ps_local_names') || '[]'); } catch (e) {}
    const names = saved.length >= 2 ? saved : ['', '', '', ''];
    const draw = () => {
      $('#app').innerHTML = `
        <div class="startbox">
          <img class="cover" src="${IMG}cover.jpg" alt="">
          <div class="startform">
            <img class="logo" src="${IMG}logo.jpg" alt="Panic Station">
            <p class="lead">Игра за одним компьютером. Устройство передаётся по кругу: перед каждым ходом экран закрывается, чтобы никто не подсмотрел чужие карты.</p>
            <div class="lnames">${names.map((n, i) => `
              <div class="row"><input data-i="${i}" maxlength="20" value="${esc(n)}" placeholder="Игрок ${i + 1}" style="flex:1">
              ${names.length > 2 ? `<button class="btn tiny ghost" data-del="${i}" title="Убрать">✕</button>` : ''}</div>`).join('')}
            </div>
            ${names.length < 6 ? '<button class="btn" id="bAdd">+ Игрок</button>' : ''}
            <small style="color:var(--mut)">По правилам 4–6 игроков. Порядок хода и цвета определятся случайно.</small>
            <label class="opt"><input type="checkbox" data-opt="easy"> Полегче для людей: 2 карты заражения вместо 3</label>
            <label class="opt"><input type="checkbox" data-opt="hard"> Посложнее для людей: для сожжения Улья нужно 4 канистры</label>
            <label class="opt"><input type="checkbox" data-opt="hostRule"> Правило для новичков-Носителей</label>
            <div class="row">
              <button id="bGo" class="btn big">Начать игру</button>
              <button id="bBack" class="btn ghost">Назад</button>
            </div>
          </div>
        </div>`;
      const sync = () => document.querySelectorAll('.lnames input').forEach(el => { names[+el.dataset.i] = el.value; });
      document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { sync(); names.splice(+b.dataset.del, 1); draw(); });
      if ($('#bAdd')) $('#bAdd').onclick = () => { sync(); names.push(''); draw(); };
      $('#bBack').onclick = renderStart;
      $('#bGo').onclick = async () => {
        sync();
        const list = names.map((n, i) => n.trim() || ('Игрок ' + (i + 1)));
        try { localStorage.setItem('ps_local_names', JSON.stringify(names.map(n => n.trim()))); } catch (e) {}
        const options = {}; document.querySelectorAll('[data-opt]').forEach(el => { options[el.dataset.opt] = el.checked; });
        try {
          const r = await api('/api/create', { local: true, names: list, options, password });
          sess = { code: r.code, local: true, players: r.players, token: r.players[0].token };
          saveSess(sess); history.replaceState(null, '', '?code=' + r.code); connect();
        } catch (e) { toast(e.message, 'err'); }
      };
    };
    draw();
  }

  // ---------- игра за одним устройством: шторка между игроками ----------
  // Чей ввод сейчас нужен: участник обмена / атакованный (бронежилет) / ходящий игрок.
  function needPid() {
    if (!S || S.phase !== 'play') return null;
    const P = S.pending;
    const pickOne = ids => (ids.includes(ui.shownFor) ? ui.shownFor : ids[0]) || null;
    if (P && P.type === 'trade') { const w = [P.a, P.b].filter(id => !P.picked.includes(id)); if (w.length) return pickOne(w); }
    if (P && P.type === 'armor' && P.waiting.length) return pickOne(P.waiting);
    if (P && P.type === 'entry') return P.pid;
    return S.turn ? S.turn.pid : null;
  }
  function localName(pid) { const p = (sess.players || []).find(x => x.pid === pid); return p ? p.name : '?'; }
  function checkCurtain() {
    if (!sess || !sess.local || !S) return;
    if (S.phase === 'over') { hideCurtain(); renderHandoff(null); return; }
    const need = needPid();
    if (!need || need === ui.shownFor) { if (need && S.me === need) hideCurtain(); renderHandoff(null); return; }
    if (need === ui.dismissedFor) renderHandoff(need); else showCurtain(need);
  }
  function showCurtain(need) {
    let c = $('#curtain');
    if (c && c.dataset.need === need && !c.dataset.loading) return;
    if (!c) { c = document.createElement('div'); c.id = 'curtain'; document.body.appendChild(c); }
    c.dataset.need = need; delete c.dataset.loading;
    const pl = S.players.find(p => p.id === need);
    const col = pl ? S.colors[pl.color].hex : '#fff';
    const prev = ui.shownFor && S.me === ui.shownFor ? ui.shownFor : null;
    const why = S.pending && S.pending.type === 'trade' ? 'Нужно выбрать карту для обмена.'
      : S.pending && S.pending.type === 'armor' ? 'Ваших персонажей атакуют — решите, играть ли бронежилет.'
      : 'Ваш ход.';
    c.innerHTML = `<div class="cbox">
        <img class="logo" src="${IMG}logo.jpg" alt="">
        <p>Передайте устройство игроку</p>
        <h2 style="color:${col}">${esc(localName(need))}</h2>
        <p class="cwhy">${why}</p>
        <button class="btn big" id="cShow">Я — ${esc(localName(need))}, показать мой экран</button>
        ${prev ? `<button class="btn ghost" id="cBack">← Вернуться к экрану ${esc(localName(prev))}</button>` : ''}
      </div>`;
    $('#cShow').onclick = () => switchViewer(need);
    if ($('#cBack')) $('#cBack').onclick = () => { ui.dismissedFor = need; hideCurtain(); renderHandoff(need); };
  }
  function hideCurtain() { const c = $('#curtain'); if (c) c.remove(); }
  function renderHandoff(need) {
    let h = $('#handoff');
    if (!need) { if (h) h.remove(); return; }
    if (!h) { h = document.createElement('div'); h.id = 'handoff'; document.body.appendChild(h); }
    h.innerHTML = `Дальше действует <b>${esc(localName(need))}</b> <button class="btn tiny" id="hGo">Закрыть экран и передать</button>`;
    $('#hGo').onclick = () => { ui.dismissedFor = null; renderHandoff(null); showCurtain(need); };
  }
  function switchViewer(pid) {
    ui.shownFor = pid; ui.dismissedFor = null; ui.minimized = {}; ui.sent = null;
    renderHandoff(null);
    if (S && S.me === pid) { hideCurtain(); render(); return; }
    const p = sess.players.find(x => x.pid === pid); if (!p) return;
    closeModal(true);
    const c = $('#curtain'); if (c) { c.dataset.loading = '1'; c.innerHTML = '<div class="cbox"><p>Загрузка…</p></div>'; }
    sess.token = p.token; saveSess(sess);
    S = null; connect();
  }

  // ---------- лобби ----------
  function renderLobby() {
    document.body.className = 'lobby';
    const me = S.players.find(p => p.id === S.me);
    const admin = S.me === S.adminId;
    const link = location.origin + '/?code=' + S.code;
    $('#app').innerHTML = `
      <div class="lobbybox">
        <img class="logo" src="${IMG}logo.jpg" alt="">
        <h2>Комната <span class="code">${esc(S.code)}</span></h2>
        ${S.platform ? '' : `<div class="invite">Ссылка для друзей: <input readonly value="${esc(link)}" id="lnk"> <button class="btn" id="bCopy">Копировать</button></div>`}
        <h3>Игроки (${S.players.length}/${S.maxPlayers || 6}) <small>по правилам 4–6</small></h3>
        <div class="lplayers">${S.players.map(p => `
          <div class="lp ${p.id === S.me ? 'me' : ''}">
            <img src="${IMG}tok_trooper_${p.color}.png" class="lptok" style="border-color:${S.colors[p.color].hex}">
            <div><b>${esc(p.name)}</b>${p.id === S.adminId ? ' <span class="badge">создатель</span>' : ''}${p.connected ? '' : ' <span class="off">(не в сети)</span>'}<br>
            <small>${esc(S.colors[p.color].hero)} — ${esc(S.colors[p.color].ru)}</small></div>
            ${admin && p.id !== S.me ? `<button class="btn tiny" data-kick="${p.id}">✕</button>` : ''}
          </div>`).join('')}
        </div>
        <h3>Ваш цвет</h3>
        <div class="colors">${Object.entries(S.colors).map(([c, d]) => {
          const taken = S.players.some(p => p.color === c && p.id !== S.me);
          return `<button class="cbtn ${me.color === c ? 'on' : ''}" ${taken ? 'disabled' : ''} data-color="${c}" title="${esc(d.hero)}"><img src="${IMG}tok_trooper_${c}.png" style="border-color:${d.hex}"><span>${esc(d.hero)}</span></button>`;
        }).join('')}</div>
        <h3>Настройки ${admin ? '' : '<small>(меняет создатель)</small>'}</h3>
        <label class="opt"><input type="checkbox" data-opt="easy" ${S.options.easy ? 'checked' : ''} ${admin ? '' : 'disabled'}> Полегче для людей: у каждого 2 карты заражения вместо 3</label>
        <label class="opt"><input type="checkbox" data-opt="hard" ${S.options.hard ? 'checked' : ''} ${admin ? '' : 'disabled'}> Посложнее для людей: для сожжения Улья нужно 4 канистры</label>
        <label class="opt"><input type="checkbox" data-opt="hostRule" ${S.options.hostRule ? 'checked' : ''} ${admin ? '' : 'disabled'}> Правило для новичков-Носителей: без карт заражения Носитель может передать саму карту Носителя</label>
        <div class="row" style="margin-top:18px">
          ${admin ? `<button class="btn big" id="bStart" ${S.players.length < 2 ? 'disabled' : ''}>Начать игру</button>` : '<i>Ждём, пока создатель начнёт игру…</i>'}
          <button class="btn" id="bRules">Правила</button>
          <button class="btn ghost" id="bLeave">Выйти</button>
        </div>
      </div>`;
    if ($('#bCopy')) $('#bCopy').onclick = () => { $('#lnk').select(); try { navigator.clipboard.writeText(link); } catch (e) { document.execCommand('copy'); } toast('Ссылка скопирована'); };
    document.querySelectorAll('[data-color]').forEach(b => b.onclick = () => act({ type: 'color', color: b.dataset.color }));
    document.querySelectorAll('[data-opt]').forEach(b => b.onchange = () => act({ type: 'options', [b.dataset.opt]: b.checked }));
    document.querySelectorAll('[data-kick]').forEach(b => b.onclick = () => act({ type: 'kick', target: b.dataset.kick }));
    if ($('#bStart')) $('#bStart').onclick = () => act({ type: 'start' });
    $('#bRules').onclick = showRules;
    $('#bLeave').onclick = leave;
  }
  function leave() {
    if (!confirm('Выйти из комнаты на этом устройстве? (Вернуться можно по коду, но как новый игрок — только пока игра не началась)')) return;
    if (es) es.close(); hideCurtain(); renderHandoff(null); ui.shownFor = ui.dismissedFor = null; ui.seen = { roll: 0, scan: 0, reveal: 0, over: false, chatN: 0 };
    closeModal(true); saveSess(null); sess = null; S = null; history.replaceState(null, '', '/'); renderStart();
  }

  // ---------- главный рендер ----------
  function render() {
    if (!S) return;
    if (S.phase === 'lobby') return renderLobby();
    if (!$('#game')) buildGameShell();
    renderTop(); renderBoard(); renderPlayers(); renderBottom(); renderSide(); renderPending(); handleEvents();
    checkCurtain();
  }

  function buildGameShell() {
    document.body.className = 'ingame';
    ui.fitted = false;
    $('#app').innerHTML = `
      <div id="game">
        <div id="top"></div>
        <div id="boardWrap"><div id="boardInner"></div>
          <div class="zoombtns"><button class="btn tiny" id="zIn">+</button><button class="btn tiny" id="zOut">−</button><button class="btn tiny" id="zFit">⤢</button></div>
          <div id="banner"></div><div id="modeHint"></div><div id="nextExp" title="Следующая карта исследования — её видят все"></div>
        </div>
        <div id="side"><div id="players"></div>
          <div class="tabs"><button data-tab="log" class="on">Журнал</button>${S.local ? '' : '<button data-tab="chat">Чат <span id="chatN"></span></button>'}</div>
          <div id="logbox"></div>
          <div id="chatbox"><div id="chatlog"></div><form id="chatf"><input id="chatin" maxlength="300" placeholder="Сообщение…" autocomplete="off"><button class="btn tiny">→</button></form></div>
        </div>
        <div id="bottom"></div>
      </div>`;
    document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { ui.tab = b.dataset.tab; renderSide(); });
    $('#chatf').onsubmit = e => { e.preventDefault(); const v = $('#chatin').value.trim(); if (v) act({ type: 'chat', text: v }); $('#chatin').value = ''; };
    setupPanZoom();
  }

  // ---------- верхняя панель ----------
  function renderTop() {
    const me = myP();
    const turnP = S.turn && S.players.find(p => p.id === S.turn.pid);
    const myTurn = S.turn && S.turn.pid === S.me;
    const marker = S.players.find(p => p.id === S.markerPid);
    const r = S.lastRoll;
    let status;
    if (S.phase === 'over') status = `<b class="over">Игра окончена</b>`;
    else status = turnP ? (myTurn ? `<b class="yourturn">ВАШ ХОД</b> · <span class="ap">${S.turn.ap} ОД</span>` : `Ходит: <b style="color:${S.colors[turnP.color].hex}">${esc(turnP.name)}</b>`) : 'Фаза паразитов…';
    const roleBadge = S.isHost ? '<span class="role host" title="Только вы это видите">☣ НОСИТЕЛЬ</span>' : S.infected ? '<span class="role inf" title="Только вы это видите">☣ ЗАРАЖЁН</span>' : '<span class="role clean" title="Только вы это видите">ЧЕЛОВЕК</span>';
    $('#top').innerHTML = `
      <img class="tlogo" src="${IMG}logo.jpg" alt="">
      <div class="tstat">${status}</div>
      <div class="tinfo">
        ${S.local && me ? `<span class="chip" title="Чей экран сейчас открыт" style="border-color:${S.colors[me.color].hex}">👤 ${esc(me.name)}</span>` : ''}
        ${roleBadge}
        <span title="Карты исследования (следующая видна всем)" class="chip clickable" id="expChip">🧭 ${S.expCount}</span>
        <span title="Колода поиска / сброс" class="chip">🂠 ${S.deckCount} / ${S.discardCount}</span>
        <span title="Паразиты в запасе: серые / чёрные" class="chip"><img src="${IMG}parasite_gray.png">${S.reserve.gray} <img src="${IMG}parasite_black.png">${S.reserve.black}</span>
        ${marker ? `<span class="chip" title="Следующую фазу паразитов проводит этот игрок">🎲 фаза паразитов: ${esc(marker.name)}</span>` : ''}
        ${S.doorsOpen ? '<span class="chip doors" title="Терминал открыл двери до следующей фазы паразитов">🔓 двери открыты</span>' : ''}
        ${r ? `<span class="chip die" title="Последний бросок: ${esc(r.by)} — ${esc(r.why)}">🎲 ${r.v} ${DIR_ARROW[r.dir]}</span>` : ''}
        <span class="chip">Нужно канистр: ${S.gasToBurn}</span>
      </div>
      <div class="tbtns"><span id="conn" class="conn ok" title="соединение"></span>
        <button class="btn tiny" id="bRules2">Правила</button><button class="btn tiny ghost" id="bLeave2" title="Выйти">⎋</button></div>`;
    $('#bRules2').onclick = showRules; $('#bLeave2').onclick = leave;
    $('#expChip').onclick = () => S.expTop && showModal('Следующая карта исследования', `<div class="bigtile">${tileHTML({ rooms: S.expTop.o0.rooms, e: S.expTop.o0.e, red: false, art: S.expTop.art, id: 'preview' }, { preview: true })}</div><p>Карты исследования двусторонние — все видят, какая комната появится следующей.</p>`, [{ t: 'OK' }]);
  }
  const myP = () => S.players.find(p => p.id === S.me);

  // ---------- поле ----------
  function wallsSVG(e, dbl) {
    const W = TW, H = TH, m = 7;
    let s = '';
    const line = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="wl"/>`;
    const door = (x, y, w, h, v) => v === 'S' ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="sec ${S && S.doorsOpen ? 'open' : ''}"/>` : '';
    // верх/низ
    for (const [side, y] of [['t', m], ['b', H - m]]) {
      const v = e[side];
      if (v === 'W') s += line(m, y, W - m, y);
      else { s += line(m, y, 53, y) + line(97, y, W - m, y) + door(53, y - 4, 44, 8, v); }
    }
    for (const [side, x] of [['l', m], ['r', W - m]]) {
      const v = e[side];
      const gaps = dbl ? [[34, 78, v[0]], [132, 176, v[1]]] : [[83, 127, v[0]]];
      let y0 = m;
      for (const [a, b, val] of gaps) {
        if (val === 'W') continue;
        s += line(x, y0, x, a) + door(x - 4, a, 8, b - a, val); y0 = b;
      }
      s += line(x, y0, x, H - m);
    }
    if (dbl) s += line(m, H / 2, 53, H / 2) + line(97, H / 2, W - m, H / 2);
    return `<svg class="walls" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
  }
  function tileHTML(card, o) {
    o = o || {};
    const dbl = card.rooms.length === 2;
    const rooms = card.rooms.map((rt, i) => {
      const key = card.id + '.' + i;
      const icon = S.roomTypes[rt].icon;
      const cls = ['room', 'rt-' + rt, dbl ? (i === 0 ? 'top' : 'bot') : 'full'];
      if (o.hl && o.hl[key]) cls.push(o.hl[key]);
      return `<div class="${cls.join(' ')}" data-room="${key}">
        ${icon ? `<img class="ricon" src="${IMG}icon_${icon}${card.red ? '_red' : ''}.png" alt="">` : ''}
        <div class="rname">${esc(S.roomTypes[rt].ru)}</div>
        <div class="toks">${o.preview ? '' : tokensHTML(key)}</div>
      </div>`;
    }).join('');
    const rot = card.rot === 180 ? ' rot' : '';
    const art = card.art ? `<div class="art${rot}" style="background-image:url(${IMG}${card.art}.jpg)"></div>` : '';
    return `<div class="tile ${card.art ? 'hasart' : ''} ${card.red ? 'red' : ''}" data-card="${card.id}">${art}${rooms}${wallsSVG(card.e, dbl)}</div>`;
  }
  function tokensHTML(key) {
    let s = '';
    for (const p of S.players) for (const k of ['trooper', 'android']) {
      const c = p.chars[k];
      if (!c.alive || c.room !== key) continue;
      const mine = p.id === S.me;
      const sel = mine && ui.sel === k ? ' sel' : '';
      s += `<div class="tok ch${mine ? ' mine' : ''}${sel}" data-pid="${p.id}" data-kind="${k}" title="${esc(p.name)} — ${KIND[k]} (${c.hp}/4)" style="--pc:${S.colors[p.color].hex}">
        <img src="${IMG}tok_${k}_${p.color}.png" alt=""><span class="kb">${k === 'trooper' ? 'Ш' : 'А'}</span><span class="hp">${'♥'.repeat(c.hp)}</span></div>`;
    }
    for (const q of S.parasites) if (q.room === key) s += `<img class="tok par" src="${IMG}parasite_${q.side}.png" title="${q.side === 'black' ? 'Чёрный паразит (2 урона, 2 попадания)' : 'Серый паразит (1 урон)'}" alt="">`;
    return s;
  }
  function boardBounds(extra) {
    let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    for (const c of S.cards.concat(extra || [])) { x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); y0 = Math.min(y0, c.y); y1 = Math.max(y1, c.y); }
    return { x0: x0 - 1, x1: x1 + 1, y0: y0 - 1, y1: y1 + 1 };
  }
  function renderBoard() {
    const opts = S.opts; const myTurn = !!opts;
    const co = myTurn && opts.chars[ui.sel];
    if (myTurn && !co) { const other = ui.sel === 'trooper' ? 'android' : 'trooper'; if (opts.chars[other]) ui.sel = other; }
    const c2 = myTurn && opts.chars[ui.sel];
    if (!myTurn && ui.mode) ui.mode = null;
    const hl = {};
    let ghosts = [];
    if (c2) {
      if (!ui.mode) for (const m of c2.moves) hl[m.to] = m.free ? 'mv free' : 'mv';
      if (ui.mode === 'explore') ghosts = c2.explore;
      if (ui.mode === 'grenade') for (const r of c2.adjRooms) hl[r] = 'tg';
      hl[c2.room] = (hl[c2.room] || '') + ' cur';
    }
    if (myTurn && ui.mode === 'reveal') ghosts = opts.reveal;
    const B = boardBounds(ghosts);
    const inner = $('#boardInner');
    let html = '';
    for (const c of S.cards) html += `<div class="pos" style="left:${(c.x - B.x0) * TW}px;top:${(c.y - B.y0) * TH}px">${tileHTML(c, { hl })}</div>`;
    // каждое допустимое место и поворот рисуется на поле; два поворота — две уменьшенные карты в клетке
    const ghostTile = rot => { const o = S.expTop[rot === 180 ? 'o180' : 'o0']; return tileHTML({ rooms: o.rooms, e: o.e, red: false, art: S.expTop.art, id: 'g', rot }, { preview: true }); };
    for (const g of ghosts) {
      const pos = `left:${(g.x - B.x0) * TW}px;top:${(g.y - B.y0) * TH}px`;
      if (g.rots.length === 1) html += `<div class="pos gcell" data-gx="${g.x}" data-gy="${g.y}" data-rot="${g.rots[0]}" style="${pos}">${ghostTile(g.rots[0])}<div class="ghostlbl">Выложить сюда${g.rots[0] === 180 ? '<br><small>(повёрнута на 180°)</small>' : ''}</div></div>`;
      else html += `<div class="pos gpair" style="${pos}">${g.rots.map(rot => `<div class="gcell gmini" data-gx="${g.x}" data-gy="${g.y}" data-rot="${rot}">${ghostTile(rot)}<div class="ghostlbl">${rot === 180 ? '↻ 180°' : 'Как есть'}</div></div>`).join('')}</div>`;
    }
    inner.style.width = (B.x1 - B.x0 + 1) * TW + 'px';
    inner.style.height = (B.y1 - B.y0 + 1) * TH + 'px';
    inner.innerHTML = html;
    ui.B = B;
    if (!ui.fitted) { fitBoard(); ui.fitted = true; } else applyTransform();
    // клики
    inner.querySelectorAll('.tok.ch.mine').forEach(el => el.onclick = ev => { ev.stopPropagation(); if (ui.dragged) return; ui.sel = el.dataset.kind; ui.mode = null; render(); });
    inner.querySelectorAll('.room').forEach(el => el.onclick = ev => { if (ui.dragged) return; onRoomClick(el.dataset.room); });
    inner.querySelectorAll('.gcell').forEach(el => el.onclick = ev => { ev.stopPropagation(); if (ui.dragged) return; onGhostClick(+el.dataset.gx, +el.dataset.gy, +el.dataset.rot); });
    const hint = $('#modeHint');
    if (ui.mode === 'explore') hint.innerHTML = 'Выберите место для новой локации <button class="btn tiny" id="mCancel">Отмена</button>';
    else if (ui.mode === 'reveal') hint.innerHTML = 'Терминал: выберите место для новой локации (любое) <button class="btn tiny" id="mCancel">Отмена</button>';
    else if (ui.mode === 'grenade') hint.innerHTML = 'Выберите соседнюю комнату для гранаты <button class="btn tiny" id="mCancel">Отмена</button>';
    else hint.innerHTML = '';
    hint.style.display = hint.innerHTML ? 'block' : 'none';
    const nx = $('#nextExp');
    if (S.expTop) {
      nx.style.display = 'block';
      nx.innerHTML = `Следующая локация <b>${esc(S.expTop.o0.rooms.map(r => S.roomTypes[r].ru).join(' / '))}</b><div class="nxt">${tileHTML({ rooms: S.expTop.o0.rooms, e: S.expTop.o0.e, red: false, art: S.expTop.art, id: 'nx' }, { preview: true })}</div><small>осталось ${S.expCount}</small>`;
      nx.onclick = () => $('#expChip').click();
    } else nx.style.display = 'none';
    if ($('#mCancel')) $('#mCancel').onclick = () => { ui.mode = null; ui.modeData = null; render(); };
  }
  function onRoomClick(key) {
    const opts = S.opts; if (!opts) return showRoomInfo(key);
    const co = opts.chars[ui.sel];
    if (ui.mode === 'grenade') {
      if (co && co.adjRooms.includes(key)) { const d = ui.modeData; ui.mode = null; ui.modeData = null; act({ type: 'grenade', card: d.card, kind: ui.sel, room: key }); }
      return;
    }
    if (!ui.mode && co) {
      const m = co.moves.find(m => m.to === key);
      if (m) return act({ type: 'move', kind: ui.sel, to: key });
      // клик по комнате, где стоит другой мой персонаж — выбрать его
      const other = ui.sel === 'trooper' ? 'android' : 'trooper';
      if (opts.chars[other] && opts.chars[other].room === key && co.room !== key) { ui.sel = other; return render(); }
    }
    showRoomInfo(key);
  }
  function showRoomInfo(key) {
    const card = S.cards.find(c => key.startsWith(c.id + '.'));
    if (!card) return;
    const rt = card.rooms[+key.split('.')[1]];
    const d = S.roomTypes[rt];
    showModal(d.ru, `<p>${esc(d.desc)}</p>${card.red ? '<p class="warn">Карта перевёрнута на красную сторону: повторный обыск/использование привлечёт паразита.</p>' : ''}`, [{ t: 'OK' }]);
  }
  function onGhostClick(x, y, rot) {
    const opts = S.opts; if (!opts) return;
    const list = ui.mode === 'reveal' ? opts.reveal : (opts.chars[ui.sel] || {}).explore || [];
    const g = list.find(q => q.x === x && q.y === y); if (!g || !g.rots.includes(rot)) return;
    const mode = ui.mode; ui.mode = null;
    if (mode === 'reveal') act({ type: 'terminal', kind: ui.sel, mode: 'reveal', x, y, rot });
    else act({ type: 'explore', kind: ui.sel, x, y, rot });
  }

  // pan/zoom
  function applyTransform() { const i = $('#boardInner'); if (i) i.style.transform = `translate(${ui.panX}px,${ui.panY}px) scale(${ui.zoom})`; }
  function fitBoard() {
    const w = $('#boardWrap'), i = $('#boardInner'); if (!w || !i) return;
    const bw = parseFloat(i.style.width), bh = parseFloat(i.style.height);
    ui.zoom = Math.max(0.3, Math.min(1.3, Math.min(w.clientWidth / bw, w.clientHeight / bh) * 0.95));
    ui.panX = (w.clientWidth - bw * ui.zoom) / 2; ui.panY = (w.clientHeight - bh * ui.zoom) / 2;
    applyTransform();
  }
  function setupPanZoom() {
    const w = $('#boardWrap');
    w.addEventListener('wheel', e => {
      e.preventDefault();
      const r = w.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
      const z = Math.max(0.25, Math.min(2.5, ui.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      ui.panX = mx - (mx - ui.panX) * z / ui.zoom; ui.panY = my - (my - ui.panY) * z / ui.zoom; ui.zoom = z; applyTransform();
    }, { passive: false });
    let drag = null;
    w.addEventListener('pointerdown', e => { if (e.target.closest('button,.zoombtns,#modeHint,#banner')) return; drag = { x: e.clientX, y: e.clientY, px: ui.panX, py: ui.panY, moved: false }; ui.dragged = false; });
    window.addEventListener('pointermove', e => {
      if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) { drag.moved = true; ui.dragged = true; }
      if (drag.moved) { ui.panX = drag.px + dx; ui.panY = drag.py + dy; applyTransform(); }
    });
    window.addEventListener('pointerup', () => { drag = null; setTimeout(() => { ui.dragged = false; }, 0); });
    $('#zIn').onclick = () => { ui.zoom = Math.min(2.5, ui.zoom * 1.2); applyTransform(); };
    $('#zOut').onclick = () => { ui.zoom = Math.max(0.25, ui.zoom / 1.2); applyTransform(); };
    $('#zFit').onclick = fitBoard;
    window.addEventListener('resize', () => { if ($('#boardInner')) fitBoard(); });
  }

  // ---------- игроки ----------
  function renderPlayers() {
    $('#players').innerHTML = S.players.map(p => {
      const col = S.colors[p.color];
      const isTurn = S.turn && S.turn.pid === p.id;
      const t = p.table;
      const chips = [];
      if (t.ammo.length) chips.push(`<span class="ti" title="Патроны на столе"><img src="${IMG}item_ammo.jpg">${t.ammo.reduce((a, b) => a + b, 0)}</span>`);
      for (const k of ['heavygun', 'scope', 'knife', 'keycard']) if (t[k]) chips.push(`<span class="ti" title="${esc(S.items[k].ru)}"><img src="${IMG}item_${k}.jpg"></span>`);
      let status = '';
      if (S.phase === 'over') status = p.isHost ? '<span class="role host">НОСИТЕЛЬ</span>' : p.infected ? '<span class="role inf">заражён</span>' : '<span class="role clean">человек</span>';
      return `<div class="pl ${isTurn ? 'turn' : ''} ${p.eliminated ? 'dead' : ''}" style="--pc:${col.hex}">
        <div class="plh"><span class="dot ${p.connected ? 'on' : ''}"></span><b>${esc(p.name)}</b>${p.id === S.me ? ' <small>(вы)</small>' : ''}
          ${S.markerPid === p.id ? '<span title="У этого игрока маркер: он проведёт следующую фазу паразитов" class="mk">🎲</span>' : ''} ${status}
          <span class="hc" title="Карт на руке">🂠${p.handCount}</span></div>
        <div class="plb">${['trooper', 'android'].map(k => {
          const c = p.chars[k];
          return `<div class="mc ${c.alive ? '' : 'rip'}" title="${KIND[k]}: ${c.hp}/4${c.room ? ' — ' + roomLabel(c.room) : ''}"><img src="${IMG}card_${k}_${p.color}.jpg"><div class="mhp">${c.alive ? hearts(c.hp) : '☠'}</div></div>`;
        }).join('')}<div class="tis">${chips.join('')}</div></div>
      </div>`;
    }).join('');
  }
  const hearts = hp => '<span class="hf">' + '♥'.repeat(hp) + '</span><span class="he">' + '♥'.repeat(4 - hp) + '</span>';
  function roomLabel(key) {
    const card = S.cards.find(c => key.startsWith(c.id + '.'));
    return card ? S.roomTypes[card.rooms[+key.split('.')[1]]].ru : '?';
  }

  // ---------- нижняя панель: персонажи, действия, рука ----------
  function cardHTML(c, extra) {
    const it = S.items[c.t];
    const dot = c.t === 'infect' ? `<div class="pdot" style="background:${S.colors[c.c].hex}" title="${esc(S.colors[c.c].ru)}"></div>` : '';
    const name = c.t === 'infect' ? `Заражение <small>${esc(S.colors[c.c].ru)}</small>` : esc(it.ru);
    return `<div class="pcard t-${c.t} ${extra || ''}" data-id="${c.id || ''}" title="${esc(it.ru)} — ${esc(it.desc)}">
      <div class="pimg" style="background-image:url(${IMG}item_${ITEM_IMG[c.t]}.jpg)"></div>${dot}
      <div class="pname">${name}</div>${it.tag ? `<div class="ptag">${esc(it.tag)}</div>` : ''}</div>`;
  }
  function renderBottom() {
    const me = myP(); if (!me) return;
    const opts = S.opts; const myTurn = !!opts;
    const chars = ['trooper', 'android'].map(k => {
      const c = me.chars[k];
      const co = opts && opts.chars[k];
      return `<div class="mychar ${ui.sel === k ? 'sel' : ''} ${c.alive ? '' : 'rip'}" data-kind="${k}">
        <img src="${IMG}card_${k}_${me.color}.jpg"><div class="mcinfo"><b>${KIND[k]}</b><br>${c.alive ? hearts(c.hp) : '☠ погиб'}<br><small>${c.room ? esc(roomLabel(c.room)) : (me.arrived ? '' : 'ещё не на станции')}</small>
        ${co && co.moves.some(m => m.free) ? '<br><small class="free">🏃 бесплатный ход</small>' : ''}</div></div>`;
    }).join('');
    let actions = '';
    if (myTurn) {
      const co = opts.chars[ui.sel];
      const b = (id, label, on, title) => `<button class="btn act" id="${id}" ${on ? '' : 'disabled'} title="${esc(title || '')}">${label}</button>`;
      const bullets = opts.bullets;
      actions = `<div class="apbig" title="Очки действия">${S.turn.ap}<small>ОД</small></div>
        <div class="acts">
          <div class="hint">${co ? `Выбран: <b>${KIND[ui.sel]}</b>. Кликните по подсвеченной комнате, чтобы пройти (1 ОД).` : 'Выберите живого персонажа.'}</div>
          ${b('aExplore', '🧭 Исследовать', co && co.explore.length, 'Выложить следующую карту рядом с комнатой персонажа (1 ОД)')}
          ${opts.canSkipExplore ? b('aSkip', '↧ Карту некуда — под низ', true, 'Верхнюю карту нельзя выложить никуда: убрать под низ колоды (раз в ход)') : ''}
          ${b('aSearch', '🔎 Обыскать', co && co.search, 'Взять карту из колоды поиска (1 ОД)')}
          ${co && co.terminal ? b('aTerm', '💻 Терминал', true, 'Сканирование / двери / камеры (1 ОД)') : ''}
          ${co && co.heal ? b('aHeal', '✚ Лечиться', true, 'Лазарет: +2 здоровья (1 ОД)') : ''}
          ${ui.sel === 'android' && co ? b('aGun', `🔫 Стрелять (${bullets})`, bullets > 0 && S.turn.ap >= 1, 'Выстрел Андроида (1 ОД, 1 патрон)') : ''}
          ${co && me.table.knife ? b('aKnife', '🔪 Нож', S.turn.ap >= 1, 'Атака ножом (1 ОД, D4: 3+)') : ''}
          ${co && co.burn ? b('aBurn', `🔥 СЖЕЧЬ УЛЕЙ`, true, 'Победа людей!') : ''}
          ${b('aEnd', '⏭ Конец хода', true)}
        </div>`;
    } else if (S.phase === 'play' && S.turn && S.turn.pid === S.me) {
      actions = `<div class="acts"><div class="hint">Ваш ход: дождитесь завершения обмена / решения о бронежилете (см. сообщение над полем).</div></div>`;
    } else if (S.phase === 'play') {
      actions = `<div class="acts"><div class="hint">Сейчас не ваш ход. Карты на руке можно разглядывать; бронежилет предложат автоматически, если вас атакуют.</div></div>`;
    } else actions = `<div class="acts"><button class="btn" id="aOver">Итоги игры</button></div>`;
    const hand = S.hand.map(c => cardHTML(c, 'inhand')).join('');
    $('#bottom').innerHTML = `<div class="mychars">${chars}</div><div class="actbox">${actions}</div>
      <div class="handbox"><div class="handtitle">Ваша рука (${S.hand.length})</div><div class="hand">${hand}</div></div>`;
    document.querySelectorAll('.mychar').forEach(el => el.onclick = () => { ui.sel = el.dataset.kind; ui.mode = null; render(); });
    document.querySelectorAll('#bottom .hand .pcard').forEach(el => el.onclick = () => onHandCard(el.dataset.id));
    const on = (id, f) => { const el = $('#' + id); if (el) el.onclick = f; };
    on('aExplore', () => { ui.mode = ui.mode === 'explore' ? null : 'explore'; render(); });
    on('aSkip', () => act({ type: 'exploreSkip' }));
    on('aSearch', doSearch);
    on('aTerm', doTerminal);
    on('aHeal', doHeal);
    on('aGun', () => doAttack('gun'));
    on('aKnife', () => doAttack('knife'));
    on('aBurn', () => confirmModal('Сжечь Улей?', `Штурмовик потратит ${S.gasToBurn} канистры и 1 ОД. Люди победят!`, () => act({ type: 'burn', kind: 'trooper' })));
    on('aEnd', () => {
      if (S.turn.first && !S.turn.searched && S.turn.ap > 0) return confirmModal('Конец хода?', 'По правилам в первый ход каждый должен хотя бы раз обыскать комнату (если это возможно). Всё равно закончить ход?', () => act({ type: 'end' }));
      act({ type: 'end' });
    });
    on('aOver', showOver);
  }

  function doSearch() {
    const co = S.opts.chars[ui.sel];
    if (co.partners.length) {
      const btns = co.partners.map(pid => ({ t: 'Вместе с ' + S.players.find(p => p.id === pid).name, f: () => act({ type: 'search', kind: ui.sel, partner: pid }) }));
      btns.unshift({ t: 'Обыскать одному', f: () => act({ type: 'search', kind: ui.sel }) });
      btns.push({ t: 'Отмена' });
      return showModal('Совместный обыск', '<p>Можно обыскать вместе с другим игроком в этой комнате: вытягиваются 2 карты и случайно раздаются по одной вам и ему.</p>', btns);
    }
    act({ type: 'search', kind: ui.sel });
  }
  function doTerminal() {
    showModal('Компьютерный терминал', '<p>Одна функция за ход, 1 ОД. Если карта уже красная — появится паразит.</p>', [
      { t: '🌡 Тепловое сканирование', f: () => act({ type: 'terminal', kind: ui.sel, mode: 'scan' }) },
      { t: '🔓 Открыть все двери', f: () => act({ type: 'terminal', kind: ui.sel, mode: 'doors' }) },
      { t: '📹 Показать локацию', f: () => { if (!S.opts.reveal.length) return toast('Некуда выложить карту', 'err'); ui.mode = 'reveal'; render(); } },
      { t: 'Отмена' }]);
  }
  function doHeal() {
    const me = myP(); const other = ui.sel === 'trooper' ? 'android' : 'trooper';
    const both = me.chars[other].alive && me.chars[other].room === me.chars[ui.sel].room;
    if (!both) return act({ type: 'heal', kind: ui.sel });
    showModal('Лазарет', '<p>Оба ваших персонажа здесь.</p>', [
      { t: `+2 ${KIND.trooper}`, f: () => act({ type: 'heal', kind: ui.sel, target: 'trooper' }) },
      { t: `+2 ${KIND.android}`, f: () => act({ type: 'heal', kind: ui.sel, target: 'android' }) },
      { t: '+1 обоим', f: () => act({ type: 'heal', kind: ui.sel, split: true }) }, { t: 'Отмена' }]);
  }
  // список целей в комнатах
  function targetsIn(roomsList, opt) {
    const out = [];
    for (const r of roomsList) {
      for (const q of S.parasites) if (q.room === r) out.push({ tg: { par: q.id }, label: `${q.side === 'black' ? '⚫ Чёрный' : '⚪ Серый'} паразит — ${roomLabel(r)}`, par: true });
      for (const p of S.players) for (const k of ['trooper', 'android']) {
        const c = p.chars[k]; if (!c.alive || c.room !== r) continue;
        if (p.id === S.me && opt && opt.notSelf === k) continue;
        out.push({ tg: { pid: p.id, kind: k }, label: `${p.name} — ${KIND[k]} (${c.hp}♥) — ${roomLabel(r)}`, pid: p.id, room: r });
      }
    }
    return out;
  }
  function doAttack(weapon, onlyRoom, kindOverride) {
    const me = myP();
    let kind = weapon === 'gun' ? 'android' : (kindOverride || ui.sel);
    const co = S.opts ? S.opts.chars[kind] : null;
    let rooms;
    if (weapon === 'gun') rooms = co ? co.shootRooms : [me.chars.android.room];
    else rooms = [me.chars[kind].room];
    if (onlyRoom) rooms = rooms.filter(r => r === onlyRoom);
    let list = targetsIn(rooms, { notSelf: weapon === 'gun' ? 'android' : kind });
    if (onlyRoom) list = list.filter(x => !x.par);
    if (!list.length) return toast('Нет целей в досягаемости', 'err');
    const shots = weapon === 'gun' && me.table.heavygun ? Math.min(2, S.opts ? S.opts.bullets : 2) : 1;
    const picked = [];
    const body = `<p>${weapon === 'gun' ? (shots === 2 ? 'Тяжёлый автомат: выберите 2 цели (можно одну и ту же дважды).' : 'Выберите цель выстрела (1 ОД, 1 патрон).') : 'Нож: бросок D4, на 3+ — 1 рана.'}</p>
      <div class="tlist">${list.map((x, i) => `<button class="btn tbtn" data-i="${i}">${esc(x.label)}</button>`).join('')}</div><div id="picked"></div>`;
    showModal(weapon === 'gun' ? '🔫 Выстрел' : '🔪 Нож', body, [{ t: 'Отмена' }], m => {
      m.querySelectorAll('.tbtn').forEach(b => b.onclick = () => {
        const x = list[+b.dataset.i];
        if (weapon === 'knife') { closeModal(); return act({ type: 'knife', kind, target: x.tg }); }
        picked.push(x.tg); $('#picked').textContent = 'Выбрано: ' + picked.length + ' из ' + shots;
        if (picked.length >= shots) { closeModal(); act({ type: 'gun', targets: picked }); }
      });
    });
  }

  function onHandCard(id) {
    const c = S.hand.find(x => x.id === id); if (!c) return;
    const it = S.items[c.t]; const me = myP();
    const myTurn = !!S.opts;
    const btns = [];
    if (myTurn) {
      if (['keycard', 'scope', 'heavygun', 'knife', 'ammo'].includes(c.t)) btns.push({ t: 'Выложить на стол', f: () => act({ type: 'equip', card: id }) });
      if (c.t === 'energy') btns.push({ t: 'Выпить: +2 ОД', f: () => act({ type: 'energy', card: id }) });
      if (c.t === 'firstaid') btns.push({ t: 'Использовать', f: () => doFirstAid(id) });
      if (c.t === 'grenade') btns.push({ t: 'Бросить (1 ОД)', dis: S.turn.ap < 1, f: () => { if (!S.opts.chars[ui.sel]) return toast('Выберите живого персонажа', 'err'); ui.mode = 'grenade'; ui.modeData = { card: id }; render(); } });
      if (c.t === 'scanner') btns.push({ t: 'Сканировать (1 ОД)', dis: S.turn.ap < 1, f: () => doScanner(id) });
    }
    btns.push({ t: 'Закрыть' });
    const extra = c.t === 'infect' ? (c.c === me.color ? (S.infected ? '<p class="warn">Это ваш цвет. Вы заражены — эту карту можно отдать при обмене, чтобы заразить партнёра.</p>' : '<p>Это ваш цвет. Пока вы человек, отдавать её нельзя.</p>') : `<p class="warn">Карта чужого цвета (${esc(S.colors[c.c].ru)}) — значит, игрок этого цвета пытался вас заразить. Она не заражает.</p>`) : '';
    showModal(c.t === 'infect' ? 'Заражение' : it.ru, `<div class="cardview">${cardHTML(c, 'big')}<div><p><i>${esc(it.en)}</i></p><p>${esc(it.desc)}</p>${extra}</div></div>`, btns);
  }
  function doScanner(cardId) {
    const me = myP(); const opts = [];
    for (const k of ['trooper', 'android']) {
      const c = me.chars[k]; if (!c.alive || !c.room) continue;
      for (const p of S.players) if (p.id !== S.me && ['trooper', 'android'].some(kk => p.chars[kk].alive && p.chars[kk].room === c.room) && !opts.some(o => o.pid === p.id)) opts.push({ pid: p.id, kind: k, name: p.name });
    }
    if (!opts.length) return toast('Рядом с вашими персонажами никого нет', 'err');
    showModal('Тепловой сканер', '<p>Чью руку посмотреть?</p>', opts.map(o => ({ t: o.name, f: () => act({ type: 'scanner', card: cardId, kind: o.kind, target: o.pid }) })).concat([{ t: 'Отмена' }]));
  }
  function doFirstAid(cardId) {
    const me = myP();
    const cand = [];
    for (const k of ['trooper', 'android']) {
      const c = me.chars[k]; if (!c.alive || !c.room) continue;
      for (const p of S.players) for (const kk of ['trooper', 'android']) {
        const q = p.chars[kk]; if (q.alive && q.room === c.room && !cand.some(x => x.pid === p.id && x.kind === kk)) cand.push({ healer: k, pid: p.id, kind: kk, label: `${p.name} — ${KIND[kk]} (${q.hp}/4)` });
      }
    }
    const alloc = {};
    const body = `<p>Распределите 2 очка лечения (персонажи в одной комнате с вашим).</p>${cand.map((x, i) => `<div class="farow">${esc(x.label)} <button class="btn tiny" data-i="${i}" data-d="-1">−</button> <b id="fa${i}">0</b> <button class="btn tiny" data-i="${i}" data-d="1">+</button></div>`).join('')}`;
    showModal('✚ Аптечка', body, [{ t: 'Лечить', f: () => {
      const list = Object.entries(alloc).filter(([i, n]) => n > 0).map(([i, n]) => ({ pid: cand[i].pid, kind: cand[i].kind, amt: n }));
      if (!list.length) return toast('Ничего не выбрано', 'err');
      const healers = [...new Set(Object.keys(alloc).filter(i => alloc[i] > 0).map(i => cand[i].healer))];
      act({ type: 'firstaid', card: cardId, healer: healers[0], alloc: list });
    } }, { t: 'Отмена' }], m => m.querySelectorAll('[data-d]').forEach(b => b.onclick = () => {
      const i = +b.dataset.i; const tot = Object.values(alloc).reduce((a, b2) => a + b2, 0);
      const d = +b.dataset.d; const cur = alloc[i] || 0;
      if (d > 0 && tot >= 2) return; if (d < 0 && cur <= 0) return;
      // все цели должны быть в одной комнате (с одним лекарем)
      if (d > 0) { const other = Object.keys(alloc).find(j => alloc[j] > 0 && cand[j].healer !== cand[i].healer); if (other !== undefined) return toast('Лечить можно только в одной комнате', 'err'); }
      alloc[i] = cur + d; m.querySelector('#fa' + i).textContent = alloc[i];
    }));
  }

  // ---------- журнал и чат ----------
  function renderSide() {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
    $('#logbox').style.display = ui.tab === 'log' ? 'block' : 'none';
    $('#chatbox').style.display = ui.tab === 'chat' ? 'flex' : 'none';
    const lb = $('#logbox');
    const atBottom = lb.scrollHeight - lb.scrollTop - lb.clientHeight < 40;
    lb.innerHTML = S.log.map(l => `<div class="le ${l.cls || ''} ${l.to ? 'private' : ''}">${l.to ? '🔒 ' : ''}${esc(l.text)}</div>`).join('');
    if (atBottom || ui.lastLogN !== S.log.length) lb.scrollTop = lb.scrollHeight;
    ui.lastLogN = S.log.length;
    const cl = $('#chatlog');
    cl.innerHTML = S.chat.map(m => `<div class="cm"><b style="color:${S.colors[m.color].hex}">${esc(m.name)}:</b> ${esc(m.text)}</div>`).join('');
    cl.scrollTop = cl.scrollHeight;
    const n = S.chat.length;
    if (ui.tab === 'chat') ui.seen.chatN = n;
    if ($('#chatN')) $('#chatN').textContent = n > ui.seen.chatN ? '(' + (n - ui.seen.chatN) + ')' : '';
  }

  // ---------- ожидания: обмен, броня, вход ----------
  function renderPending() {
    const P = S.pending; const ban = $('#banner');
    let bannerHTML = '';
    if (!P) { if (ui.modalKey && ui.modalKey.startsWith('pend')) closeModal(); ban.style.display = 'none'; return; }
    const nm = id => esc((S.players.find(p => p.id === id) || {}).name);
    const key = 'pend' + P.id;
    const busy = ui.sent === key || (ui.modalKey && !ui.modalKey.startsWith('pend'));
    if (P.type === 'entry') {
      if (P.pid === S.me) {
        bannerHTML = `Вы вошли в комнату к ${P.partners.map(nm).join(', ')}: нужно обменяться или атаковать. <button class="btn tiny" id="bnOpen">Выбрать</button>`;
        if (!ui.minimized[key] && !busy) openEntry(P, key);
      } else bannerHTML = `${nm(P.pid)} вошёл в комнату к ${P.partners.map(nm).join(', ')} и выбирает: обмен или атака…`;
    } else if (P.type === 'trade') {
      const mine = P.a === S.me || P.b === S.me;
      const partner = P.a === S.me ? P.b : P.a;
      if (mine && !P.picked.includes(S.me)) {
        bannerHTML = `Обмен с ${nm(partner)}: выберите карту. <button class="btn tiny" id="bnOpen">Выбрать</button>`;
        if (!ui.minimized[key] && !busy) openTrade(P, key, partner);
      } else if (mine) { bannerHTML = `Ждём, пока ${nm(partner)} выберет карту для обмена…`; if (ui.modalKey === key) closeModal(); }
      else bannerHTML = `${nm(P.a)} и ${nm(P.b)} обмениваются картами (${P.picked.length}/2 выбрали)…`;
    } else if (P.type === 'armor') {
      if (P.mine && P.waiting.includes(S.me)) {
        bannerHTML = `Вас атакуют! Сыграть бронежилет? <button class="btn tiny" id="bnOpen">Решить</button>`;
        if (!ui.minimized[key] && !busy) openArmor(P, key);
      } else { bannerHTML = `Ждём решения о бронежилете: ${P.waiting.map(nm).join(', ')}…`; if (ui.modalKey === key) closeModal(); }
    }
    ban.innerHTML = bannerHTML; ban.style.display = bannerHTML ? 'block' : 'none';
    if ($('#bnOpen')) $('#bnOpen').onclick = () => { ui.minimized[key] = false; ui.sent = null; closeModal(true); renderPending(); };
  }
  function openEntry(P, key) {
    if (ui.modalKey === key) return;
    const nm = id => (S.players.find(p => p.id === id) || {}).name;
    const me = myP();
    const btns = P.partners.map(pid => ({ t: '🔁 Обменяться с ' + nm(pid), f: () => { ui.sent = key; act({ type: 'tradeWith', target: pid }).then(() => { ui.sent = null; }); } }));
    const bullets = me.table.ammo.reduce((a, b) => a + b, 0);
    if (me.chars.android.alive && bullets > 0) btns.push({ t: '🔫 Атаковать (выстрел)', f: () => { ui.minimized[key] = true; doAttack('gun', P.room); } });
    if (me.table.knife) btns.push({ t: '🔪 Атаковать (нож)', f: () => { ui.minimized[key] = true; doAttack('knife', P.room, P.kind); } });
    btns.push({ t: 'Свернуть', f: () => { ui.minimized[key] = true; renderPending(); } });
    showModal('Встреча в комнате', `<p>Вы вошли в комнату «${esc(roomLabel(P.room))}», где есть другие игроки. По правилам нужно <b>обменяться картой</b> с одним из них — или атаковать (тогда обмена не будет).</p><p><small>Заражённый может подсунуть карту заражения своего цвета. Защита — отдать канистру.</small></p>`, btns, null, key, true);
  }
  function openTrade(P, key, partner) {
    if (ui.modalKey === key) return;
    const nm = (S.players.find(p => p.id === partner) || {}).name;
    const can = new Set(P.giveable || []);
    const body = `<p>Обмен с <b>${esc(nm)}</b>: выберите карту, которую отдадите (лицом вниз). Партнёр выбирает одновременно.</p>
      <p><small>Отдав <b>канистру</b>, вы защищены от заражения в этом обмене. Карты своего цвета человек отдавать не может.</small></p>
      <div class="hand pick">${S.hand.map(c => cardHTML(c, can.has(c.id) ? '' : 'no')).join('')}</div>`;
    showModal('🔁 Обмен картами', body, [{ t: 'Свернуть', f: () => { ui.minimized[key] = true; renderPending(); } }], m => {
      m.querySelectorAll('.pick .pcard').forEach(el => el.onclick = () => {
        if (el.classList.contains('no')) return toast('Эту карту сейчас нельзя отдать', 'err');
        const c = S.hand.find(x => x.id === el.dataset.id);
        ui.sent = key; confirmModal('Отдать карту?', `Вы отдадите: <b>${esc(c.t === 'infect' ? 'Заражение (' + S.colors[c.c].ru + ')' : S.items[c.t].ru)}</b>`, () => { act({ type: 'tradePick', card: el.dataset.id }).then(() => { setTimeout(() => { if (ui.sent === key) { ui.sent = null; renderPending(); } }, 1500); }); }, () => { ui.sent = null; });
      });
    }, key, true);
  }
  function openArmor(P, key) {
    if (ui.modalKey === key) return;
    const m = P.mine; const hits = Object.entries(m.hits).filter(([k, n]) => n).map(([k, n]) => `${KIND[k]}: −${n}`).join(', ');
    const send = n => { ui.sent = key; act({ type: 'armor', n }).then(() => setTimeout(() => { if (ui.sent === key) { ui.sent = null; renderPending(); } }, 1500)); };
    const btns = [{ t: 'Не играть', f: () => send(0) }];
    for (let n = 1; n <= m.max; n++) btns.push({ t: `🛡 Бронежилет ×${n}`, f: () => send(n) });
    showModal('Атака: ' + m.src, `<p>Ваши персонажи получают урон: <b>${hits}</b>.</p><p>Каждый бронежилет предотвращает 1 урон (если оба ваших персонажа в одной комнате — защищает обоих). Можно сыграть: до ${m.max}.</p>${P.deadline ? `<p class="timer" data-deadline="${P.deadline}"></p>` : ''}`, btns, null, key, true);
  }

  // ---------- события: кубик, сканирование, рука соперника, финал ----------
  function handleEvents() {
    const r = S.lastRoll;
    if (r && r.seq > ui.seen.roll) {
      if (ui.seen.roll) diceToast(r);
      ui.seen.roll = r.seq;
    }
    const sc = S.lastScan;
    if (sc && sc.seq > ui.seen.scan) {
      ui.seen.scan = sc.seq;
      if (ui.initDone && (!ui.modalKey || !ui.modalKey.startsWith('pend'))) showScan(sc);
    }
    const rv = S.scanReveal;
    if (rv && rv.seq > ui.seen.reveal) {
      const first = ui.seen.reveal === 0 && ui.initDone;
      ui.seen.reveal = rv.seq;
      if (ui.initDone || first) showModal('📟 Рука игрока ' + rv.name, `<div class="hand">${rv.hand.map(c => cardHTML(c)).join('')}</div>`, [{ t: 'OK' }]);
    }
    if (S.over && !ui.seen.over) { ui.seen.over = true; setTimeout(showOver, 600); }
    ui.initDone = true;
  }
  function diceToast(r) {
    const d = document.createElement('div'); d.className = 'dicetoast';
    d.innerHTML = `<div class="die4">${r.v}</div><div><b>${esc(r.by)}</b>: ${esc(r.why)}<br><span class="arr">${DIR_ARROW[r.dir]}</span></div>`;
    document.body.appendChild(d); setTimeout(() => d.classList.add('out'), 2600); setTimeout(() => d.remove(), 3200);
  }
  function showScan(sc) {
    const cards = [];
    for (let i = 0; i < sc.inf; i++) cards.push('<div class="chk red"><span>ЗАРАЖЁН</span></div>');
    for (let i = 0; i < sc.clean; i++) cards.push('<div class="chk blue"><span>ЧИСТ</span></div>');
    for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; }
    showModal('🌡 Тепловое сканирование', `<div class="scanboard" style="background-image:url(${IMG}heatboard.jpg)"><div class="chks">${cards.join('')}</div></div>
      <p class="scanres">Заражённых: <b class="r">${sc.inf}</b> · Чистых: <b class="b">${sc.clean}</b></p><p><small>Причина: ${esc(sc.reason)}. Кто именно заражён — неизвестно. Самое время для обвинений!</small></p>`, [{ t: 'OK' }]);
  }
  function showOver() {
    const o = S.over; if (!o) return;
    const rows = S.players.map(p => `<div class="orow ${o.winners.includes(p.id) ? 'win' : ''}"><b style="color:${S.colors[p.color].hex}">${esc(p.name)}</b> — ${p.isHost ? '☣ Носитель' : p.infected ? 'заражён' : 'человек'}${o.winners.includes(p.id) ? ' 🏆' : ''}
      <div class="hand mini">${(p.hand || []).map(c => cardHTML(c)).join('')}</div></div>`).join('');
    showModal(o.side === 'humans' ? '🔥 Люди победили!' : '☣ Победа заражённых', `<p>${esc(o.reason)}</p>${rows}<p><small>Новая партия: создайте новую комнату (кнопка ⎋ вверху → «Создать игру»).</small></p>`, [{ t: 'OK' }]);
  }

  // ---------- модальные окна ----------
  function showModal(title, body, buttons, onMount, key, sticky) {
    closeModal(true);
    const m = document.createElement('div'); m.id = 'modal'; m.className = 'modal' + (sticky ? ' sticky' : '');
    m.innerHTML = `<div class="mbox"><h3>${esc(title)}</h3><div class="mbody">${body}</div><div class="mbtns">${(buttons || []).map((b, i) => `<button class="btn" data-b="${i}" ${b.dis ? 'disabled' : ''}>${esc(b.t)}</button>`).join('')}</div></div>`;
    document.body.appendChild(m);
    ui.modalKey = key || 'm' + Date.now();
    m.querySelectorAll('.mbtns [data-b]').forEach(el => el.onclick = () => { const b = buttons[+el.dataset.b]; closeModal(); if (b.f) b.f(); });
    if (!sticky) m.addEventListener('click', e => { if (e.target === m) closeModal(); });
    if (onMount) onMount(m);
    const tm = m.querySelector('.timer');
    if (tm) { const tick = () => { if (!document.body.contains(tm)) return; const s = Math.max(0, Math.round((+tm.dataset.deadline - Date.now()) / 1000)); tm.textContent = 'Осталось ' + s + ' с'; setTimeout(tick, 500); }; tick(); }
    return m;
  }
  function closeModal(silent) { const m = $('#modal'); if (m) m.remove(); ui.modalKey = null; if (!silent && S && S.phase === 'play' && $('#game')) setTimeout(renderPending, 0); }
  function confirmModal(title, text, yes, no) { showModal(title, `<p>${text}</p>`, [{ t: 'Да', f: yes }, { t: 'Нет', f: no }]); }
  function toast(msg, cls) {
    const t = document.createElement('div'); t.className = 'toast ' + (cls || ''); t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.classList.add('out'), 3200); setTimeout(() => t.remove(), 3800);
  }

  function showRules() {
    showModal('Правила (кратко)', RULES_HTML, [{ t: 'Закрыть' }]);
  }
  const RULES_HTML = `
  <div class="rules">
  <p><b>Цель людей:</b> провести <b>Штурмовика</b> в <b>Улей</b> и сыграть там 3 <b>канистры</b> (1 ОД). <b>Цель заражённых:</b> заразить или убить всех людей.</p>
  <p><b>Начало.</b> У каждого 3 карты заражения своего цвета + 2 карты из колоды. Среди верхних карт колоды спрятана карта <b>Носителя</b> — кто её получил, тот заражён (игра сама скажет только ему). Персонажи прибывают в Реактор в свой первый ход. В первый ход каждый должен хотя бы раз обыскать комнату.</p>
  <p><b>Ход.</b> Очки действия (ОД): персонаж с 3–4 ♥ даёт 2 ОД, с 1–2 ♥ — 1 ОД. ОД обоих персонажей общие. Каждое действие стоит 1 ОД:</p>
  <ul>
   <li><b>Пройти</b> через проход в соседнюю комнату (кликните подсвеченную комнату). Через закрытую дверь (красно-жёлтая) — только с ключ-картой или после терминала.</li>
   <li><b>Исследовать</b> — выложить следующую карту рядом с комнатой персонажа (проход не может упираться в стену; две двери безопасности нельзя ставить вплотную).</li>
   <li><b>Обыскать</b> комнату со значком — взять карту. Карта комнаты станет красной; повторный обыск красной комнаты привлекает паразита.</li>
   <li><b>Стрелять</b> (только Андроид, нужны патроны на столе), <b>нож</b>, <b>граната</b>, <b>сканер</b> — см. карты.</li>
   <li><b>Терминал</b>: тепловое сканирование (сколько заражённых), открыть все двери до фазы паразитов, или выложить новую локацию где угодно.</li>
   <li><b>Лазарет</b>: +2 ♥.</li>
  </ul>
  <p><b>Предметы</b> можно разыгрывать при любом количестве карт на руке (в этой версии нет правила «минимум 5 карт»). Если вам нечего отдать при обмене, обмен с вами не начинается.</p>
  <p><b>Обмен.</b> Войдя в комнату (кроме Реактора), где есть чужие персонажи, вы обязаны <b>обменяться</b> с одним из игроков картой вслепую — или атаковать его. Заражённый может отдать карту заражения <b>своего цвета</b>: получатель заражается, если в ответ не отдал <b>канистру</b>. Человек не может отдавать карты заражения своего цвета. Заражение действует на обоих ваших персонажей.</p>
  <p><b>Фаза паразитов.</b> Каждый круг (раз в «число игроков + 1» ходов) игрок с маркером бросает D4: все паразиты ползут в одном направлении (1 ↑, 2 →, 3 ↓, 4 ←, как на Реакторе), если там открытый проход. Потом атакуют всех в своей комнате: серый — 1 урон, чёрный — 2. Бронежилет снимает 1 урон (вам предложат сыграть его автоматически).</p>
  <p><b>Паразиты появляются</b> от «Тревоги» в колоде, при входе в комнату с паразитом на значке и при повторном использовании красных комнат: D4 → в соседнюю комнату в этом направлении (стены не мешают).</p>
  <p><b>Конец игры.</b> Люди побеждают, сжигая Улей. Заражённые побеждают, если сканирование показало, что все заражены; если остался один человек без канистр; если не осталось живых незаражённых Штурмовиков. Последний заражённый в победе заражённых не участвует (кроме случая, когда Носитель никого не заразил).</p>
  <p><b>Оригиналы:</b> <a href="/assets/docs/Panic_Station_rules_V2.0.pdf" target="_blank">правила (PDF, англ.)</a> · <a href="/assets/docs/Game_Aid_Front.pdf" target="_blank">памятка 1</a> · <a href="/assets/docs/Game_Aid_Back.pdf" target="_blank">памятка 2</a> · <a href="/assets/docs/Strategy_Humans.pdf" target="_blank">стратегия людей</a> · <a href="/assets/docs/Strategy_Infected.pdf" target="_blank">стратегия заражённых</a></p>
  </div>`;

  // ---------- старт ----------
  sess = loadSess();
  const urlCode = QS.get('code');
  if (sess && urlCode && urlCode.toUpperCase() !== sess.code) sess = null;
  if (PLATFORM.code) joinPlatform();
  else if (sess) connect();
  else renderStart();
}

// ---------------------------------------------------------------------------
//  СТРАНИЦА (HTML + CSS)
// ---------------------------------------------------------------------------
const PAGE_CSS = `
:root{--bg:#0d0f10;--panel:#16191b;--panel2:#1d2124;--line:#2c3236;--text:#e6e1d6;--mut:#8f9599;--acc:#f2b51b;--red:#d23b2c;--blue:#2d8ee6;--grn:#4cc25a}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
body{background:radial-gradient(ellipse at 50% 0%,#1f2a22 0%,#0d0f10 60%) fixed}
h2,h3,.btn,.tstat,.apbig,.pname,.rname{font-family:Impact,"Oswald","Arial Narrow",Haettenschweiler,sans-serif;letter-spacing:.5px}
a{color:var(--acc)}
.btn{background:linear-gradient(#3b4247,#24292d);color:#f0ece2;border:1px solid #59626a;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:15px;text-transform:uppercase;box-shadow:inset 0 1px 0 rgba(255,255,255,.15)}
.btn:hover:not(:disabled){border-color:var(--acc);color:#fff}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn.big{font-size:20px;padding:10px 22px;background:linear-gradient(#c7461f,#7e2210);border-color:#e0703f}
.btn.tiny{font-size:12px;padding:3px 8px}
.btn.ghost{background:transparent}
input{background:#0c0e0f;border:1px solid #4a5157;color:var(--text);border-radius:5px;padding:8px 10px;font-size:15px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
/* старт */
.startbox{display:flex;gap:30px;align-items:center;justify-content:center;min-height:100vh;padding:20px;flex-wrap:wrap}
.startbox .cover{width:300px;max-width:80vw;border-radius:8px;box-shadow:0 0 60px rgba(242,181,27,.25)}
.startform{background:rgba(22,25,27,.92);border:1px solid var(--line);border-radius:10px;padding:24px;width:380px;max-width:92vw;display:flex;flex-direction:column;gap:12px}
.startform .logo,.lobbybox .logo{width:100%;max-width:340px;border-radius:6px}
.lead{color:#cfc6b3;margin:0}
.startform label{display:flex;flex-direction:column;gap:4px;color:var(--mut)}
.or{color:var(--mut);text-align:center;font-size:12px;text-transform:uppercase}
.pw{color:var(--mut);font-size:12px}
/* лобби */
.embed #bLeave,.embed #bLeave2{display:none}
.lobbybox{max-width:760px;margin:20px auto;background:rgba(22,25,27,.94);border:1px solid var(--line);border-radius:10px;padding:24px}
.lobbybox .code{color:var(--acc);letter-spacing:4px}
.invite input{width:340px;max-width:60vw;font-size:12px}
.lplayers{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
.lp{display:flex;gap:10px;align-items:center;background:var(--panel2);padding:8px;border-radius:8px;border:1px solid var(--line)}
.lp.me{border-color:var(--acc)}
.lptok{width:46px;height:46px;border-radius:50%;border:3px solid}
.badge{background:#3a3f43;border-radius:4px;padding:1px 6px;font-size:11px}
.off{color:#a55}
.colors{display:flex;gap:8px;flex-wrap:wrap}
.cbtn{background:var(--panel2);border:2px solid var(--line);border-radius:8px;padding:6px;cursor:pointer;color:var(--text);display:flex;flex-direction:column;align-items:center;width:86px}
.cbtn img{width:50px;height:50px;border-radius:50%;border:3px solid}
.cbtn.on{border-color:var(--acc);background:#2b2a20}
.cbtn:disabled{opacity:.3}
.opt{display:block;margin:6px 0;color:#cfc6b3}
.lnames{display:flex;flex-direction:column;gap:6px}
#curtain{position:fixed;inset:0;z-index:90;background:#0b0d0e;display:flex;align-items:center;justify-content:center;text-align:center}
#curtain .cbox{display:flex;flex-direction:column;gap:12px;align-items:center;max-width:92vw}
#curtain .logo{width:300px;max-width:80vw;border-radius:6px}
#curtain h2{font-size:34px;margin:0}#curtain .cwhy{color:var(--mut)}
#handoff{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:80;background:rgba(40,35,10,.97);border:1px solid var(--acc);border-radius:8px;padding:8px 14px}
/* игра */
body.ingame{overflow:hidden}
#game{display:grid;grid-template-columns:1fr 330px;grid-template-rows:54px 1fr 232px;height:100vh}
#top{grid-column:1/3;display:flex;align-items:center;gap:14px;padding:0 10px;background:linear-gradient(#22272a,#141719);border-bottom:2px solid #3a4146}
.tlogo{height:42px;border-radius:4px}
.tstat{font-size:20px;min-width:220px}
.yourturn{color:var(--acc);text-shadow:0 0 12px rgba(242,181,27,.6)}
.ap{color:#fff}
.over{color:var(--red)}
.tinfo{display:flex;gap:6px;flex-wrap:wrap;flex:1;align-items:center}
.chip{background:#0d1011;border:1px solid #394045;border-radius:12px;padding:2px 9px;font-size:12px;display:inline-flex;align-items:center;gap:3px;white-space:nowrap}
.chip img{width:16px;height:16px}
.chip.clickable{cursor:pointer}
.chip.doors{border-color:var(--grn);color:var(--grn)}
.chip.die{border-color:var(--acc)}
.role{font-family:Impact,sans-serif;border-radius:4px;padding:2px 8px;font-size:13px;letter-spacing:1px}
.role.clean{background:#1b3b5c;color:#bfe0ff}
.role.inf{background:#5c1b1b;color:#ffc9c0}
.role.host{background:#7a0f0f;color:#fff;box-shadow:0 0 10px #c00}
.tbtns{display:flex;gap:6px;align-items:center}
.conn{width:10px;height:10px;border-radius:50%;display:inline-block}
.conn.ok{background:var(--grn)} .conn.bad{background:var(--red)}
#boardWrap{position:relative;overflow:hidden;background:#090b0c url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Cpath d='M0 0h40v40H0z' fill='none' stroke='%23151a1c' stroke-width='1'/%3E%3C/svg%3E");cursor:grab;touch-action:none}
#boardInner{position:absolute;left:0;top:0;transform-origin:0 0}
.pos{position:absolute;width:150px;height:210px}
.tile{position:relative;width:150px;height:210px;border-radius:9px;overflow:hidden;background:#1a1e20;box-shadow:inset 0 0 0 2px #050606}
.tile .art{position:absolute;inset:0;background-size:cover;background-position:center}
.tile .art.rot{transform:rotate(180deg)}
.walls{position:absolute;left:0;top:0;pointer-events:none}
.walls .wl{stroke:#b8c0c6;stroke-width:5;stroke-linecap:round;filter:drop-shadow(0 0 1px #000)}
.walls .sec{fill:url(#hz);stroke:#300;stroke-width:1}
.walls .sec.open{fill:rgba(76,194,90,.55);stroke:#4cc25a;stroke-dasharray:3 2}
.room{position:absolute;left:0;right:0;display:flex;align-items:center;justify-content:center}
.room.full{top:0;bottom:0}.room.top{top:0;height:50%}.room.bot{bottom:0;height:50%}
.room .ricon{position:absolute;width:50px;height:50px;left:50%;top:30%;transform:translate(-50%,-50%);opacity:.95;filter:drop-shadow(0 2px 4px #000)}
.room.top .ricon,.room.bot .ricon{width:38px;height:38px;left:30px;top:50%}
.rname{position:absolute;bottom:12px;left:0;right:0;text-align:center;font-size:11px;color:rgba(255,255,255,.55);text-transform:uppercase;pointer-events:none}
.room.top .rname,.room.bot .rname{bottom:4px;font-size:10px}
.toks{position:absolute;z-index:2;left:8px;right:8px;top:48%;bottom:24px;display:flex;flex-wrap:wrap;gap:3px;justify-content:center;align-content:flex-start;padding:2px}
.room.top .toks,.room.bot .toks{left:52px;right:8px;top:8px;bottom:8px;align-content:center;justify-content:flex-start}
.hasart .toks{top:40%}
.rt-empty{background:radial-gradient(circle at 50% 45%,#3a4246,#15191b 75%)}
.rt-storage{background:radial-gradient(circle at 45% 40%,#6a5326,#1d1710 75%),repeating-linear-gradient(0deg,transparent 0 18px,rgba(0,0,0,.25) 18px 20px)}
.rt-terminal{background:radial-gradient(circle at 50% 40%,#2f7b86,#0f2226 75%)}
.rt-search{background:radial-gradient(circle at 50% 45%,#55606a,#191d21 75%)}
.rt-run{background:radial-gradient(circle at 50% 50%,#6e6a3a,#1c1b10 75%)}
.rt-sickbay{background:radial-gradient(circle at 50% 50%,#7c8a92,#1f2427 75%)}
.rt-parasite{background:radial-gradient(circle at 50% 50%,#55702a,#151c0c 75%)}
.hasart .room{background:none}
.room::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 24px,rgba(255,255,255,.03) 24px 25px),repeating-linear-gradient(0deg,transparent 0 24px,rgba(255,255,255,.03) 24px 25px);pointer-events:none}
.tile.red{box-shadow:inset 0 0 0 2px #050606,inset 0 0 24px rgba(210,40,30,.35)}
.room.mv{cursor:pointer;box-shadow:inset 0 0 0 3px #4cc25a,inset 0 0 30px rgba(76,194,90,.45)}
.room.mv.free{box-shadow:inset 0 0 0 3px #f2b51b,inset 0 0 30px rgba(242,181,27,.5)}
.room.mv:hover{background-color:rgba(76,194,90,.25)}
.room.tg{cursor:crosshair;box-shadow:inset 0 0 0 3px #ff6a2a,inset 0 0 30px rgba(255,106,42,.5)}
.room.cur{outline:2px dashed rgba(242,181,27,.8);outline-offset:-6px}
.gcell{opacity:.55;cursor:pointer;filter:saturate(.6)}
.gcell:hover{opacity:.9}
.gcell .tile{box-shadow:0 0 0 3px #f2b51b,0 0 25px #f2b51b}
.ghostlbl{position:absolute;left:0;right:0;top:45%;text-align:center;font-family:Impact,sans-serif;color:#fff;text-shadow:0 0 6px #000,0 0 3px #000;font-size:16px;pointer-events:none}
.gpair{width:150px;height:210px;display:flex;align-items:center;justify-content:space-between;padding:0 2px;box-sizing:border-box}
.gmini{position:relative;width:72px;height:101px}
.gmini .tile{transform:scale(.48);transform-origin:top left}
.gmini .ghostlbl{top:auto;bottom:-20px;font-size:13px}
#nextExp{position:absolute;left:8px;top:8px;z-index:5;background:rgba(15,17,18,.92);border:1px solid var(--acc);border-radius:8px;padding:6px;text-align:center;cursor:pointer;font-size:12px;color:var(--mut)}
#nextExp .nxt{width:90px;height:126px;margin:4px auto 0;overflow:hidden}
#nextExp .nxt .tile{transform:scale(.6);transform-origin:top left}
#nextExp b{color:#fff;display:block;font-size:13px}
.tok{width:38px;height:38px;border-radius:50%;position:relative;flex:0 0 auto}
.tok.ch{border:3px solid var(--pc);box-shadow:0 2px 5px #000;background:#000}
.tok.ch img{width:100%;height:100%;border-radius:50%;display:block}
.tok.ch.mine{cursor:pointer}
.tok.ch.sel{box-shadow:0 0 0 3px #fff,0 0 14px 4px var(--acc);z-index:3}
.tok .kb{position:absolute;right:-5px;top:-5px;background:var(--pc);color:#000;font:bold 10px/14px Arial;width:15px;height:15px;border-radius:50%;text-align:center;border:1px solid #000}
.tok .hp{position:absolute;left:50%;bottom:-8px;transform:translateX(-50%);font-size:9px;color:#ff4d4d;text-shadow:0 0 2px #000,0 0 2px #000;white-space:nowrap;letter-spacing:-1px}
.tok.par{width:34px;height:34px;border-radius:50%;box-shadow:0 2px 6px #000}
.zoombtns{position:absolute;right:8px;top:8px;display:flex;flex-direction:column;gap:4px;z-index:5}
#banner{display:none;position:absolute;left:50%;top:10px;transform:translateX(-50%);background:rgba(60,20,10,.95);border:1px solid #e0703f;border-radius:8px;padding:8px 14px;z-index:6;max-width:80%;text-align:center}
#modeHint{display:none;position:absolute;left:50%;bottom:10px;transform:translateX(-50%);background:rgba(40,35,10,.95);border:1px solid var(--acc);border-radius:8px;padding:8px 14px;z-index:6}
#side{grid-row:2/4;grid-column:2;display:flex;flex-direction:column;background:var(--panel);border-left:2px solid #2c3236;min-height:0}
#players{overflow:auto;max-height:52%;padding:6px;display:flex;flex-direction:column;gap:5px}
.pl{background:var(--panel2);border-left:4px solid var(--pc);border-radius:6px;padding:5px 7px}
.pl.turn{box-shadow:0 0 0 1px var(--acc),0 0 12px rgba(242,181,27,.35)}
.pl.dead{opacity:.45}
.plh{display:flex;gap:6px;align-items:center}
.plh .hc{margin-left:auto;color:var(--mut)}
.dot{width:8px;height:8px;border-radius:50%;background:#733}.dot.on{background:var(--grn)}
.mk{color:var(--acc)}
.plb{display:flex;gap:5px;align-items:flex-end;margin-top:3px}
.mc{position:relative;width:44px}
.mc img{width:44px;border-radius:3px;display:block}
.mc.rip img{filter:grayscale(1) brightness(.4)}
.mhp{font-size:10px;text-align:center;letter-spacing:-1px}
.hf{color:#ff4d4d}.he{color:#444}
.tis{display:flex;gap:3px;flex-wrap:wrap;margin-left:4px}
.ti{display:inline-flex;align-items:center;gap:2px;font-size:11px;background:#0c0e0f;border-radius:4px;padding:1px 3px}
.ti img{width:22px;height:22px;object-fit:contain}
.tabs{display:flex;border-top:1px solid var(--line)}
.tabs button{flex:1;background:none;border:0;color:var(--mut);padding:6px;cursor:pointer;font-family:Impact,sans-serif;font-size:14px}
.tabs button.on{color:var(--acc);border-bottom:2px solid var(--acc)}
#logbox{flex:1;overflow:auto;padding:6px 8px;font-size:12.5px;min-height:0}
.le{padding:2px 0;border-bottom:1px solid #1f2427}
.le.turn{color:var(--acc);font-weight:bold;margin-top:4px}
.le.phase{color:#ff8a5c;font-weight:bold}
.le.alert{color:#d6e36b}.le.dmg{color:#ff9b8a}.le.death{color:#ff5050;font-weight:bold}
.le.scan{color:#9fd3ff;font-weight:bold}.le.trade{color:#c9b6ff}.le.explore{color:#9fe0a8}.le.sys{color:var(--mut)}
.le.over{color:#fff;background:#5a1d10;padding:4px}
.le.private{background:#14262f;border-left:3px solid #2d8ee6;padding-left:5px}
.le.infected{background:#3b0d0d;border-left-color:#d23b2c;color:#ffb3a8;font-weight:bold}
#chatbox{flex:1;flex-direction:column;min-height:0}
#chatlog{flex:1;overflow:auto;padding:6px 8px}
#chatf{display:flex;gap:4px;padding:6px}#chatf input{flex:1}
#bottom{grid-column:1;display:flex;gap:10px;padding:8px;background:linear-gradient(#171a1c,#0f1112);border-top:2px solid #2c3236;min-width:0}
.mychars{display:flex;flex-direction:column;gap:6px}
.mychar{display:flex;gap:6px;background:var(--panel2);border:2px solid var(--line);border-radius:8px;padding:4px;cursor:pointer;width:178px}
.mychar img{width:64px;border-radius:4px}
.mychar.sel{border-color:var(--acc);box-shadow:0 0 10px rgba(242,181,27,.35)}
.mychar.rip img{filter:grayscale(1) brightness(.4)}
.mcinfo{font-size:12px}
.free{color:var(--acc)}
.actbox{display:flex;gap:8px;width:330px;flex:0 0 330px}
.apbig{font-size:46px;line-height:1;color:var(--acc);text-align:center;min-width:54px}
.apbig small{display:block;font-size:13px;color:var(--mut)}
.acts{display:flex;flex-wrap:wrap;gap:5px;align-content:flex-start}
.acts .hint{width:100%;font-size:12px;color:var(--mut)}
.btn.act{font-size:13px;padding:5px 9px}
#aBurn{background:linear-gradient(#ff7a1a,#a52a00);border-color:#ffb36b;animation:pulse 1s infinite alternate}
@keyframes pulse{to{box-shadow:0 0 18px #ff7a1a}}
.handbox{flex:1;min-width:0;display:flex;flex-direction:column}
.handtitle{font-size:12px;color:var(--mut)}
.hand{display:flex;gap:6px;overflow-x:auto;padding:4px 2px 6px}
.hand.mini .pcard{width:58px;height:82px}
.hand.mini .pname,.hand.mini .ptag{display:none}
.pcard{position:relative;flex:0 0 auto;width:104px;height:150px;border-radius:8px;background:linear-gradient(145deg,#8d969c,#3b4146 40%,#9aa3a8 60%,#2d3236);padding:5px;cursor:pointer;box-shadow:0 3px 8px #000;transition:transform .12s}
.pcard:hover{transform:translateY(-4px)}
.pcard .pimg{width:100%;height:96px;border-radius:5px;background:#000 center/contain no-repeat;box-shadow:inset 0 0 0 2px #111}
.pcard.t-infect .pimg{background-size:cover}
.pcard .pname{font-size:13px;text-align:center;color:#111;margin-top:3px;line-height:1.05;text-shadow:0 1px 0 rgba(255,255,255,.4)}
.pcard .pname small{display:block;font-size:10px;font-family:Arial}
.pcard .ptag{position:absolute;top:8px;left:8px;background:rgba(0,0,0,.75);color:#ddd;font-size:9px;border-radius:3px;padding:0 3px}
.pcard .pdot{position:absolute;top:80px;left:50%;transform:translateX(-50%);width:22px;height:22px;border-radius:50%;border:2px solid #222;box-shadow:0 0 6px #000,inset 0 -3px 4px rgba(0,0,0,.4)}
.pcard.t-host{background:linear-gradient(145deg,#c33,#400 50%,#c33)}
.pcard.t-host .pname{color:#fff;text-shadow:0 1px 2px #000}
.pcard.no{opacity:.35;cursor:not-allowed}
.pcard.big{width:150px;height:216px}.pcard.big .pimg{height:150px}.pcard.big .pdot{top:125px}
.cardview{display:flex;gap:16px;align-items:flex-start}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:50}
.mbox{background:linear-gradient(#22272a,#181b1d);border:2px solid #59626a;border-radius:12px;padding:16px 20px;max-width:min(760px,94vw);max-height:90vh;overflow:auto;box-shadow:0 10px 40px #000}
.mbox h3{margin:0 0 8px;font-size:22px;color:var(--acc)}
.mbtns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.warn{color:#ffb3a8}
.tlist{display:flex;flex-direction:column;gap:5px}
.tbtn{text-transform:none;font-family:system-ui,Arial;text-align:left}
.farow{display:flex;align-items:center;gap:6px;margin:4px 0}
.rotchoice{display:flex;gap:20px}.rc{cursor:pointer;text-align:center}.rc:hover .tile{box-shadow:0 0 0 3px var(--acc)}
.bigtile{display:flex;justify-content:center}
.toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:#24292d;border:1px solid var(--acc);color:#fff;padding:10px 18px;border-radius:8px;z-index:100;transition:opacity .5s}
.toast.err{border-color:var(--red);background:#3a1612}
.toast.out,.dicetoast.out{opacity:0}
.dicetoast{position:fixed;right:350px;top:70px;display:flex;gap:12px;align-items:center;background:rgba(20,22,24,.95);border:2px solid var(--acc);border-radius:10px;padding:10px 16px;z-index:60;transition:opacity .5s;animation:pop .35s}
@keyframes pop{from{transform:scale(.5) rotate(-20deg)}}
.die4{width:0;height:0;border-left:28px solid transparent;border-right:28px solid transparent;border-bottom:48px solid #c62b1f;position:relative;font:bold 22px Impact;color:#fff}
.die4{display:flex;align-items:flex-end;justify-content:center;line-height:44px;text-indent:-2px}
.arr{font-size:28px;color:var(--acc)}
.scanboard{background-size:cover;background-position:center;border-radius:8px;padding:30px 20px;min-height:160px}
.chks{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
.chk{width:70px;height:100px;border-radius:7px;display:flex;align-items:flex-end;justify-content:center;font:12px Impact;color:#fff;padding-bottom:6px;box-shadow:0 3px 10px #000;animation:flip .6s both}
.chk:nth-child(2){animation-delay:.2s}.chk:nth-child(3){animation-delay:.4s}.chk:nth-child(4){animation-delay:.6s}.chk:nth-child(5){animation-delay:.8s}.chk:nth-child(6){animation-delay:1s}
.chk.red{background:radial-gradient(circle at 50% 35%,#ff6a50 0 14%,transparent 15%),linear-gradient(#7d1410,#2a0605)}
.chk.blue{background:radial-gradient(circle at 50% 35%,#7cc8ff 0 14%,transparent 15%),linear-gradient(#11477d,#06182a)}
@keyframes flip{from{transform:rotateY(90deg)}}
.scanres{font-size:20px;font-family:Impact,sans-serif}.scanres .r{color:#ff5a45}.scanres .b{color:#5ab0ff}
.orow{padding:6px;border-bottom:1px solid var(--line)}.orow.win{background:#2b2a14}
.rules{max-width:680px;font-size:14px}.rules li{margin:3px 0}
@media (max-width:1000px){#game{grid-template-columns:1fr;grid-template-rows:54px 55vh auto auto;height:auto}body.ingame{overflow:auto}#side{grid-row:auto;grid-column:1;height:420px}#bottom{flex-wrap:wrap}.actbox{flex:1 1 300px}}
`;

const PAGE_HTML = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Panic Station — онлайн</title>
<link rel="icon" href="/assets/img/parasite_black.png">
<style>${PAGE_CSS}</style></head>
<body>
<svg width="0" height="0" style="position:absolute"><defs>
<pattern id="hz" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#c22"/><rect width="4" height="8" fill="#f2c21b"/></pattern>
</defs></svg>
<div id="app"></div>
<script>(${clientMain.toString()})();</script>
</body></html>`;

// ---------------------------------------------------------------------------
//  СЕРВЕР (HTTP + Server-Sent Events, без внешних библиотек)
// ---------------------------------------------------------------------------
const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ASSETS_DIR = path.resolve(process.env.ASSETS_DIR || path.join(__dirname, 'assets'));
const GAME_PASSWORD = process.env.GAME_PASSWORD || '';
const PLATFORM_SECRET = process.env.PLATFORM_SECRET || '';
const BGIO_NAME = 'panic-station'; // имя игры в лобби-API для платформы
const rooms = new Map(); // code -> { game, listeners:Set }

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c; do { c = Array.from({ length: 5 }, () => A[rnd(A.length)]).join(''); } while (rooms.has(c));
  return c;
}
function broadcast(room) {
  for (const l of room.listeners) sendState(room, l);
}
function sendState(room, l) {
  try { l.res.write(`event: state\ndata: ${JSON.stringify(room.game.view(l.pid))}\n\n`); } catch (e) { /* ignore */ }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', ch => { d += ch; if (d.length > 1e5) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}
function closeRoom(code) {
  const room = rooms.get(code);
  if (!room) return false;
  rooms.delete(code);
  if (room.game.pending && room.game.pending.timer) clearTimeout(room.game.pending.timer);
  for (const l of room.listeners) { try { l.res.write('event: gone\ndata: {}\n\n'); l.res.end(); } catch (e) {} }
  return true;
}
/**
 * Партия глазами платформы (как лобби-API boardgame.io): места 0..N-1, у занятых — name;
 * gameover.winners — номера мест победителей (по ним платформа считает рейтинг).
 */
function matchMeta(g) {
  const seats = g.platform ? g.maxPlayers : Math.max(g.players.length, 1);
  const players = Array.from({ length: Math.max(seats, g.players.length) }, (_, id) => {
    const p = g.players[id];
    return p && !p.left ? { id, name: p.name } : { id };
  });
  const gameover = g.over ? {
    side: g.over.side, reason: g.over.reason,
    winners: g.over.winners.map(pid => String(g.players.findIndex(p => p.id === pid))),
  } : null;
  return { matchID: g.code, players, gameover };
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function serveAsset(req, res, rel) {
  let file;
  try { file = path.resolve(ASSETS_DIR, decodeURIComponent(rel)); } catch (e) { res.writeHead(400); return res.end(); }
  if (!file.startsWith(ASSETS_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(file).pipe(res);
  });
}

function startServer() {
  if (!fs.existsSync(path.join(ASSETS_DIR, 'img'))) {
    console.warn(`\n⚠  Не найдена папка с картинками: ${ASSETS_DIR}/img\n   Распакуйте архив с ассетами рядом с этим файлом (должна получиться папка ./assets).\n`);
  }
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    try {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(PAGE_HTML);
      }
      if (req.method === 'GET' && p.startsWith('/assets/')) return serveAsset(req, res, p.slice('/assets/'.length));
      if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true, rooms: rooms.size });

      // ---- платформа Zarya Boardgames: лобби-API в духе boardgame.io и служебные маршруты ----
      if (req.method === 'POST' && p === `/games/${BGIO_NAME}/create`) {
        const b = await readBody(req);
        const code = newCode();
        const room = { game: null, listeners: new Set() };
        room.game = new Game(code, () => broadcast(room));
        room.game.platform = true;
        room.game.maxPlayers = Math.max(2, Math.min(6, Math.floor(+b.numPlayers) || 6));
        rooms.set(code, room);
        return json(res, 200, { matchID: code });
      }
      const metaM = req.method === 'GET' && p.match(new RegExp(`^/games/${BGIO_NAME}/([A-Za-z0-9]+)$`));
      if (metaM) {
        const room = rooms.get(metaM[1].toUpperCase());
        return room ? json(res, 200, matchMeta(room.game)) : json(res, 404, { error: 'Партия не найдена' });
      }
      const platM = PLATFORM_SECRET && p.match(/^\/platform\/matches\/([A-Za-z0-9]+)(\/leave)?$/);
      if (platM) {
        if (req.headers['x-platform-secret'] !== PLATFORM_SECRET) return json(res, 403, { error: 'forbidden' });
        const code = platM[1].toUpperCase();
        if (req.method === 'DELETE' && !platM[2]) return json(res, 200, { ok: closeRoom(code) });
        if (req.method === 'POST' && platM[2]) {
          const room = rooms.get(code);
          if (!room) return json(res, 404, { error: 'Партия не найдена' });
          const b = await readBody(req);
          const left = room.game.leaveByName(b.playerName);
          if (left) broadcast(room);
          return json(res, 200, { left });
        }
      }

      if (req.method === 'POST' && p === '/api/create') {
        const b = await readBody(req);
        if (GAME_PASSWORD && b.password !== GAME_PASSWORD) return json(res, 403, { error: 'Неверный пароль сервера' });
        const code = newCode();
        const room = { game: null, listeners: new Set() };
        room.game = new Game(code, () => broadcast(room));
        if (b.local) {
          // игра за одним устройством: сразу все игроки, лобби не нужно
          const names = (Array.isArray(b.names) ? b.names : []).slice(0, 6);
          if (names.length < 2) return json(res, 400, { error: 'Нужно хотя бы 2 игрока' });
          const g = room.game;
          g.local = true;
          const pls = names.map(n => g.addPlayer(n));
          for (const k of ['easy', 'hard', 'hostRule']) g.options[k] = !!(b.options && b.options[k]);
          g.start(g.adminId);
          rooms.set(code, room);
          return json(res, 200, { code, local: true, players: pls.map(p => ({ pid: p.id, token: p.token, name: p.name })) });
        }
        rooms.set(code, room);
        const pl = room.game.addPlayer(b.name);
        return json(res, 200, { code, token: pl.token, pid: pl.id });
      }
      if (req.method === 'POST' && p === '/api/join') {
        const b = await readBody(req);
        const code = String(b.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return json(res, 404, { error: 'Комната не найдена' });
        if (b.token) { const pl = room.game.byToken(b.token); if (pl) { pl.left = false; return json(res, 200, { code, token: pl.token, pid: pl.id }); } }
        // за столом платформы ник = аккаунт: второго игрока с тем же ником не пускаем (место сохранено в браузере, где садились)
        if (room.game.platform && room.game.byName(b.name)) return json(res, 409, { error: 'Вы уже сидите за этим столом в другом браузере — откройте игру там' });
        const pl = room.game.addPlayer(b.name);
        broadcast(room);
        return json(res, 200, { code, token: pl.token, pid: pl.id });
      }
      if (req.method === 'GET' && p === '/api/stream') {
        const room = rooms.get(String(u.searchParams.get('code') || '').toUpperCase());
        const pl = room && room.game.byToken(u.searchParams.get('token'));
        if (!pl) { res.writeHead(404, { 'Content-Type': 'text/event-stream' }); return res.end('event: gone\ndata: {}\n\n'); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\n\n');
        const l = { pid: pl.id, res };
        room.listeners.add(l);
        pl.connected = true;
        broadcast(room);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
        req.on('close', () => {
          clearInterval(ping); room.listeners.delete(l);
          pl.connected = [...room.listeners].some(x => x.pid === pl.id);
          broadcast(room);
        });
        return;
      }
      if (req.method === 'POST' && p === '/api/action') {
        const b = await readBody(req);
        const room = rooms.get(String(b.code || '').toUpperCase());
        const pl = room && room.game.byToken(b.token);
        if (!pl) return json(res, 404, { error: 'Сессия не найдена — войдите заново' });
        try {
          room.game.act(pl.id, b.action);
          if (room.game.phase === 'play') room.game.checkWin();
        } catch (e) {
          if (e instanceof GameError) { broadcast(room); return json(res, 400, { error: e.message }); }
          console.error('Ошибка в действии', b.action, e);
          broadcast(room);
          return json(res, 500, { error: 'Внутренняя ошибка: ' + e.message });
        }
        broadcast(room);
        return json(res, 200, { ok: true });
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      console.error(e);
      try { json(res, 500, { error: String(e.message || e) }); } catch (e2) {}
    }
  });
  // удаляем заброшенные комнаты (без активности > 24 ч)
  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) if (now - room.game.touched > 24 * 3600e3 && !room.listeners.size) rooms.delete(code);
  }, 3600e3).unref();
  server.listen(PORT, HOST, () => {
    console.log(`\n  PANIC STATION запущен:  http://localhost:${PORT}   (слушает ${HOST}:${PORT})`);
    console.log(`  Картинки берутся из:    ${ASSETS_DIR}\n`);
  });
  return server;
}

if (require.main === module) startServer();
module.exports = { Game, GameError, EXPLORATION, EXP_BY_ID, orient, startServer, SEARCH_DECK, rooms, matchMeta };
