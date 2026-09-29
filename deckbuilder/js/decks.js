
let saving = Promise.resolve();  // keep saves in order
const postDeck = (name, d) => saving = saving.then(() =>
  fetch('decks.json', { method: 'POST', body: JSON.stringify({ name, deck: d }) }));
function save(d = deck) { postDeck(d.name, d); }

const emptyDeck = name => ({ name, commander: null, partner: null, identity: '', theme: '', cards: [], qty: {}, maybe: [], log: [], info: {} });
function upgrade(d) {  // fields added after decks were first saved
  d.info ??= {}; d.qty ??= {}; d.maybe ??= []; d.log ??= []; d.theme ??= ''; d.partner ??= null;
  return d;
}

const qty = (d, name) => d.qty[name] || 1;
const cmdrs = d => [d.commander, d.partner].filter(Boolean);  // one or two commanders
const isCmdr = (d, name) => cmdrs(d).includes(name);
const deckSize = d => d.cards.reduce((n, c) => n + qty(d, c), cmdrs(d).length);
const inDeck = (d, name) => isCmdr(d, name) || d.cards.includes(name);
const decksWith = name => Object.values(decks).filter(d => inDeck(d, name));

// Every change to the main deck goes through here so it lands in the history.
function change(d, entry) {
  d.log.push({ t: new Date().toISOString(), ...entry });
  if (d.log.length > 1000) d.log.splice(0, d.log.length - 1000);
}

function addTo(d, c) {
  remember(d, c);
  if (inDeck(d, c.name)) {
    if (!d.info[c.name].any) return false;
    const from = qty(d, c.name);
    d.qty[c.name] = from + 1;
    change(d, { op: 'q', name: c.name, from, to: from + 1 });
  } else {
    d.cards.push(c.name);
    change(d, { op: '+', name: c.name });
  }
  d.maybe = d.maybe.filter(n => n !== c.name);
  save(d);
  return true;
}

function removeFrom(d, name) {
  if (!d.cards.includes(name)) return;
  d.cards = d.cards.filter(n => n !== name);
  change(d, { op: '-', name, n: qty(d, name) });
  delete d.qty[name];
  save(d);
}

function setQty(d, name, to) {
  if (to < 1) return removeFrom(d, name);
  change(d, { op: 'q', name, from: qty(d, name), to });
  if (to === 1) delete d.qty[name]; else d.qty[name] = to;
  save(d);
}

// Second commanders: Partner, Partner with X, Partner—<group>, Friends forever,
// Choose a Background + Background, Doctor's companion + Time Lord Doctor.
function pairing(c) {
  if (!c) return null;
  const t = oracleOf(c).replace(/\([^)]*\)/g, ''), type = c.type_line || '';
  const m = t.match(/Partner with ([^\n]+)/);
  if (m) return { with: m[1].trim() };
  const g = t.match(/Partner—([^\n]+)/);
  if (g) return { group: g[1].trim() };
  if (/(^|, )partner\s*(,|$)/im.test(t)) return { partner: true };
  if (/Friends forever/i.test(t)) return { friends: true };
  if (/Choose a Background/i.test(t)) return { chooser: true };
  if (/\bBackground\b/.test(type)) return { background: true };
  if (/Doctor's companion/i.test(t)) return { companion: true };
  if (/Time Lord Doctor/.test(type)) return { doctor: true };
  return null;
}
function canPair(a, b) {
  const x = pairing(a), y = pairing(b);
  if (!x || !y || a.name === b.name) return false;
  if (x.with || y.with) return x.with === b.name || y.with === a.name;
  if (x.group || y.group) return x.group === y.group;
  return !!(x.partner && y.partner || x.friends && y.friends || x.chooser && y.background || x.background && y.chooser || x.companion && y.doctor || x.doctor && y.companion);
}
// Scryfall query for cards that can pair with `c`
function partnerQuery(c) {
  const x = pairing(c);
  if (!x) return null;
  if (x.with) return { q: `!"${x.with}"`, label: 'Find partner' };
  if (x.group) return { q: `o:"partner—${x.group}"`, label: 'Find partner' };
  if (x.partner) return { q: 'keyword:partner -o:"partner with" -o:"partner—"', label: 'Find partner' };
  if (x.friends) return { q: 'keyword:"friends forever"', label: 'Find partner' };
  if (x.chooser) return { q: 't:background', label: 'Find background' };
  if (x.background) return { q: 'o:"choose a background"', label: 'Find commander' };
  if (x.companion) return { q: 't:"time lord" t:doctor', label: 'Find Doctor' };
  if (x.doctor) return { q: `keyword:"doctor's companion"`, label: 'Find companion' };
}

const WUBRG = 'wubrg';
function refreshIdentity(d) {
  const ids = cmdrs(d).map(n => d.info[n]?.id);
  if (ids.every(x => x !== undefined)) d.identity = [...WUBRG].filter(x => ids.some(i => i.includes(x))).join('');
}

function setCommanderOf(d, c) {
  change(d, { op: 'c', name: c?.name || null, from: d.commander, fromPartner: d.partner, fromId: d.identity });
  if (c) {
    if (!cardData[c.name]) keep(c);  // Scryfall result: needed to find partners
    remember(d, c);
    d.commander = c.name;
    d.cards = d.cards.filter(n => n !== c.name);
    if (d.partner && !(cardData[d.partner] && canPair(c, cardData[d.partner]))) d.partner = null;
  } else { d.commander = d.partner; d.partner = null; }
  if (!d.commander) d.identity = '';
  refreshIdentity(d);
  d.theme = '';
  save(d);
}

function setPartnerOf(d, c) {
  change(d, { op: 'p', name: c?.name || null, from: d.partner, fromId: d.identity });
  if (c) {
    if (!cardData[c.name]) keep(c);
    remember(d, c);
    d.partner = c.name;
    d.cards = d.cards.filter(n => n !== c.name);
    d.maybe = d.maybe.filter(n => n !== c.name);
  } else d.partner = null;
  refreshIdentity(d);
  d.theme = '';
  save(d);
}

function undo() {
  const e = deck.log.at(-1);
  if (!e || e.op === 'import') return;
  deck.log.pop();
  if (e.op === '+') { deck.cards = deck.cards.filter(n => n !== e.name); delete deck.qty[e.name]; }
  if (e.op === '-') { deck.cards.push(e.name); if (e.n > 1) deck.qty[e.name] = e.n; }
  if (e.op === 'q') { if (e.from > 1) deck.qty[e.name] = e.from; else delete deck.qty[e.name]; if (!deck.cards.includes(e.name)) deck.cards.push(e.name); }
  if (e.op === 'c') { deck.commander = e.from; deck.partner = e.fromPartner ?? deck.partner; deck.identity = e.fromId || ''; }
  if (e.op === 'p') { deck.partner = e.from; deck.identity = e.fromId || ''; }
  save(); renderDeck();
  if (e.op === 'c' || e.op === 'p') loadEdh();
}
$('undo').onclick = undo;

function renderDeckList() {
  $('decks').innerHTML = '';
  for (const name of Object.keys(decks).sort()) {
    const d = decks[name];
    $('decks').add(new Option(`${name} (${deckSize(d)})`, name, false, name === deck.name));
  }
}

function openDeck(name) {
  deck = upgrade(decks[name]);
  localStorage.setItem('deckName', name);
  edh = {}; edhCards = []; edhPageNow = null;
  renderDeckList(); renderDeck(); fillDeckInfo(); loadEdh();
}

function askName(suggestion) {
  const name = prompt('Deck name', suggestion)?.trim();
  if (name && decks[name]) alert(`A deck named "${name}" already exists.`);
  return name && !decks[name] ? name : null;
}

function uniqueName(base) {
  let name = base, i = 2;
  while (decks[name]) name = `${base} ${i++}`;
  return name;
}

async function loadDecks() {
  decks = await (await fetch('decks.json')).json();
  Object.values(decks).forEach(upgrade);
  const old = JSON.parse(localStorage.getItem('deck') || 'null');  // deck saved in the browser before server storage
  if (old && (old.commander || old.cards?.length)) {
    const name = uniqueName('My deck');
    decks[name] = upgrade({ ...old, name });
    postDeck(name, decks[name]);
  }
  localStorage.removeItem('deck');
  if (!Object.keys(decks).length) { decks['Deck 1'] = emptyDeck('Deck 1'); postDeck('Deck 1', decks['Deck 1']); }
  const last = localStorage.getItem('deckName');
  openDeck(decks[last] ? last : Object.keys(decks).sort()[0]);
}

$('decks').onchange = () => openDeck($('decks').value);
$('newdeck').onclick = () => {
  let i = 1;
  while (decks[`Deck ${i}`]) i++;
  const name = askName(`Deck ${i}`);
  if (!name) return;
  decks[name] = emptyDeck(name);
  postDeck(name, decks[name]);
  openDeck(name);
};
$('rendeck').onclick = () => {
  const name = askName(deck.name);
  if (!name) return;
  postDeck(deck.name, null);
  delete decks[deck.name];
  deck.name = name;
  decks[name] = deck;
  save(); openDeck(name);
};
$('deldeck').onclick = () => {
  if (!confirm(`Delete "${deck.name}"?`)) return;
  postDeck(deck.name, null);
  delete decks[deck.name];
  if (!Object.keys(decks).length) { decks['Deck 1'] = emptyDeck('Deck 1'); postDeck('Deck 1', decks['Deck 1']); }
  openDeck(Object.keys(decks).sort()[0]);
};

// ---------- import ----------

// Lines like "1 Name", "1x Name (SET) 123 *F*", "Name", with section headers
// (Commander, Deck, Sideboard...) or Archidekt tags like [Commander{top}].
function parseList(text) {
  const out = [];
  let section = 'deck';
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    const head = line.toLowerCase().replace(/[:\s]*(\(\d+\))?\s*$/, '');
    if (/^commanders?$/.test(head)) { section = 'commander'; continue; }
    if (/^(sideboard|maybeboard|maybe|considering|companion)$/.test(head)) { section = 'maybe'; continue; }
    if (/^(deck|main|mainboard|main deck)$/.test(head)) { section = 'deck'; continue; }
    const sb = /^sb:\s*/i.test(line);
    line = line.replace(/^sb:\s*/i, '');
    const m = line.match(/^(?:(\d+)x?\s+)?(.+?)(?:\s+\(\w+\)(?:\s+[\w-]+)?)?(?:\s+\*\w+\*)*(?:\s+\[([^\]]*)\])?(?:\s+\^[^^]*\^)?\s*$/);
    if (!m) continue;
    if (!m[1] && /\(\d+\)$/.test(line)) continue;  // "Creatures (30)" style group headers
    const tag = (m[3] || '').toLowerCase();
    const where = tag.includes('commander') ? 'commander' : /maybe|sideboard/.test(tag) || sb ? 'maybe' : section;
    out.push({ n: Number(m[1] || 1), name: m[2].trim(), where });
  }
  return out;
}

$('impdeck').onclick = () => { $('imptext').value = ''; $('impname').value = ''; $('impdlg').showModal(); };
$('impdlg').onclose = async () => {
  if ($('impdlg').returnValue !== 'ok') return;
  const rows = parseList($('imptext').value);
  if (!rows.length) return alert('No cards found in the pasted text.');
  if ($('impfirst').checked && !rows.some(r => r.where === 'commander')) rows[0].where = 'commander';
  const cards = await lookup(rows.map(r => r.name));
  const missing = rows.filter((r, i) => !cards[i]).map(r => r.name);
  const name = uniqueName($('impname').value.trim() || rows.find(r => r.where === 'commander')?.name || 'Imported deck');
  const d = decks[name] = emptyDeck(name);
  rows.forEach((r, i) => {
    const c = cards[i];
    if (!c) return;
    remember(d, c);
    if (r.where === 'commander' && !d.commander) d.commander = c.name;
    else if (r.where === 'commander' && !d.partner) d.partner = c.name;
    else if (r.where === 'maybe') { if (!d.maybe.includes(c.name)) d.maybe.push(c.name); }
    else if (!inDeck(d, c.name)) { d.cards.push(c.name); if (r.n > 1) d.qty[c.name] = r.n; }
    else d.qty[c.name] = qty(d, c.name) + r.n;
  });
  refreshIdentity(d);
  change(d, { op: 'import', name: `${d.cards.length} cards` });
  save(d); openDeck(name);
  if (missing.length) alert(`Not found:\n${missing.join('\n')}`);
};
