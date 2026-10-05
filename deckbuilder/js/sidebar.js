
const TYPES = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land'];
const LABELS = { Sorcery: 'Sorceries', Other: 'Other' };
const typeOf = t => TYPES.find(x => (t || '').includes(x)) || 'Other';
const small = c => c.image_uris?.small || c.card_faces?.[0]?.image_uris?.small;
const big = url => url?.replace('/small/', '/normal/');
const large = url => url?.replace('/small/', '/large/');
const colorsOf = c => c.colors || c.card_faces?.[0]?.colors || [];
const oracleOf = c => c.oracle_text || (c.card_faces || []).map(f => f.oracle_text || '').join('\n');
const anyNumber = c => /\bBasic\b/.test(c.type_line) || /deck can have any number of cards named/i.test(oracleOf(c));
const remember = (d, c) => {
  if (cardData[c.name]?.roles) c = cardData[c.name];  // prefer the database entry, which has roles and strategy tags
  d.info[c.name] = { img: small(c), type: c.type_line, cmc: c.cmc ?? 0, colors: colorsOf(c), any: anyNumber(c), id: c.color_identity.join('').toLowerCase(), roles: c.roles, tags: c.tags };
};
const COLORS = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
// Each grouper returns the groups a card belongs to; a card can have several strategies.
const groupers = {
  type: i => [typeOf(i.type)],
  cost: i => [i.cmc >= 7 ? '7+' : String(i.cmc)],
  color: i => [i.colors.length > 1 ? 'Multicolor' : COLORS[i.colors[0]] || 'Colorless'],
  strategy: i => i.tags?.length ? i.tags : ['No strategy tag'],
  none: () => ['Cards'],
};
const groupOrder = {
  type: [...TYPES, 'Other'],
  cost: ['0', '1', '2', '3', '4', '5', '6', '7+'],
  color: [...Object.values(COLORS), 'Multicolor', 'Colorless'],
  none: ['Cards'],
};
// strategies are ordered by how many cards they have
const orderGroups = (by, groups) => by !== 'strategy' ? groupOrder[by] : Object.keys(groups)
  .sort((a, b) => (a === 'No strategy tag') - (b === 'No strategy tag') || groups[b].length - groups[a].length);

$('preview').onload = e => { if (e.target.src === e.target.dataset.want) e.target.style.display = 'block'; };

function preview(elem, img) {
  const p = $('preview');
  elem.onmouseenter = () => {
    if (!img) return;
    const r = elem.getBoundingClientRect(), src = large(img);
    p.style.top = Math.max(8, Math.min(r.top - 60, innerHeight - 480)) + 'px';
    p.style.left = (r.left > 360 ? r.left - 348 : r.right + 12) + 'px';
    // stay hidden until the new image has loaded, so the previous card never flashes
    p.dataset.want = src;
    if (p.src === src && p.complete) p.style.display = 'block';
    else { p.style.display = 'none'; p.src = src; }
  };
  elem.onmouseleave = () => { p.dataset.want = ''; p.style.display = 'none'; };
}

// Deck list filter set from the stats panel: {label, test(card), query} (query: Scryfall search for more)
let deckFilter = null;
function showOnly(label, test, query) {
  deckFilter = deckFilter?.label === label ? null : { label, test, query };
  renderDeck();
  if (deckFilter) $('deckfilter').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderFilter(shown, cmds) {
  const box = $('deckfilter');
  box.innerHTML = '';
  if (!deckFilter) return;
  const bar = el('div', 'filterbar');
  bar.append(el('span', null, `${deckFilter.label}: ${shown} card${shown === 1 ? '' : 's'}` + (cmds.length ? ` + ${cmds.join(' and ')}` : '')));
  if (deckFilter.query) {
    const more = el('button', null, 'Find more');
    more.onclick = () => findStrategy(deckFilter.query);
    bar.append(more);
  }
  const all = el('button', null, 'Show all');
  all.onclick = () => { deckFilter = null; renderDeck(); };
  bar.append(all);
  box.append(bar);
}

// Copies of a card used across all decks, when that's more than you own.
function shortage(name) {
  if (!isOwned(name) || deck.info[name]?.any) return null;
  const users = decksWith(name);
  const used = users.reduce((n, d) => n + (isCmdr(d, name) ? 1 : qty(d, name)), 0);
  return used > ownedCount(name) ? `You own ${ownedCount(name)}, used ${used}× in: ${users.map(d => d.name).join(', ')}` : null;
}

function deckRow(name, { onName, buttons }) {
  const li = el('li');
  const short = shortage(name);
  li.className = short ? 'short' : isOwned(name) ? 'owned' : '';
  li.title = short || (isOwned(name) ? `owned (${ownedCount(name)})` : 'not owned');
  li.append(el('span', 'dot'), el('span', 'q', qty(deck, name) > 1 ? qty(deck, name) : ''), el('span', 'n', name));
  if (onName) { li.querySelector('.n').style.cursor = 'pointer'; li.querySelector('.n').onclick = onName; }
  for (const [label, title, fn, cls] of buttons) {
    const b = el('button', 'x' + (cls ? ' ' + cls : ''), label);
    b.title = title;
    b.onclick = e => { e.stopPropagation(); fn(); };
    li.appendChild(b);
  }
  preview(li, deck.info[name]?.img);
  return li;
}

function renderDeck() {
  $('preview').style.display = 'none';
  const box = $('cmdbox');
  box.innerHTML = '';
  $('cmdtitle').textContent = deck.partner ? 'Commanders' : 'Commander';
  for (const name of cmdrs(deck)) {
    const c = el('div', 'cmd'), img = el('img'), b = el('button', null, 'Remove');
    img.src = big(deck.info[name]?.img) || ''; img.alt = name;
    b.onclick = () => { if (name === deck.partner) setPartnerOf(deck, null); else setCommanderOf(deck, null); renderDeck(); loadEdh(); };
    c.append(img, b);
    box.append(c);
  }
  if (!deck.commander) box.innerHTML = '<div class="empty">Hover a legendary creature in the results and click "Commander", or use ★ in the deck list</div>';
  const pq = !deck.partner && partnerQuery(cardData[deck.commander]);
  $('findpartner').hidden = !pq;
  if (pq) {
    $('findpartner').textContent = pq.label;
    $('findpartner').onclick = () => {  // partners may add colors, so drop the identity filter
      $('q').value = pq.q; $('inId').checked = false;
      showView('search'); searchSoon();
    };
  }
  $('count').textContent = deckSize(deck);
  const by = $('dgroup').value, sort = $('dsort').value, groups = {};
  const info = n => ({ cmc: 0, colors: [], ...deck.info[n] });
  const names = deck.cards.filter(n => !deckFilter || (cardData[n] && deckFilter.test(cardData[n])));
  renderFilter(names.reduce((t, n) => t + qty(deck, n), 0), deckFilter ? cmdrs(deck).filter(n => cardData[n] && deckFilter.test(cardData[n])) : []);
  if (sort !== 'added') names.sort((a, b) => sort === 'cmc' && info(a).cmc - info(b).cmc || a.localeCompare(b));
  for (const n of names) for (const g of groupers[by](info(n))) (groups[g] ??= []).push(n);
  $('deck').innerHTML = '';
  for (const t of orderGroups(by, groups)) {
    if (!groups[t]) continue;
    const g = el('div', 'group');
    const label = by === 'type' ? LABELS[t] || t + 's' : by === 'cost' ? `Mana value ${t}` : t;
    g.innerHTML = `<h4><span>${label}</span><span>${groups[t].reduce((n, c) => n + qty(deck, c), 0)}</span></h4><ul></ul>`;
    for (const name of groups[t]) {
      const i = info(name), buttons = [];
      if (i.any) buttons.push(['−', 'One fewer', () => { setQty(deck, name, qty(deck, name) - 1); renderDeck(); }], ['+', 'One more', () => { setQty(deck, name, qty(deck, name) + 1); renderDeck(); }]);
      if (commanders.has(name)) buttons.push(['★', 'Make commander', async () => { const [c] = await lookup([name]); setCommanderOf(deck, c); renderDeck(); loadEdh(); }]);
      if (deck.commander && !deck.partner && cardData[name] && cardData[deck.commander] && canPair(cardData[deck.commander], cardData[name]))
        buttons.push(['☆', 'Make second commander (partner / background)', () => { setPartnerOf(deck, cardData[name]); renderDeck(); loadEdh(); }]);
      buttons.push(['?', 'Which decks does this fit?', async () => { const [c] = await lookup([name]); if (c) fitOne(c); }]);
      buttons.push(['↓', 'Move to maybeboard', () => { removeFrom(deck, name); deck.maybe.push(name); save(); renderDeck(); }]);
      buttons.push(['×', 'Remove', () => { removeFrom(deck, name); renderDeck(); }, 'del']);
      g.querySelector('ul').appendChild(deckRow(name, { buttons }));
    }
    $('deck').appendChild(g);
  }
  renderMaybe(); renderHistory(); renderDeckList(); renderStats();
  redraw();
  if (currentView === 'tune') renderTune();
  if (currentView === 'play') renderPlay();
  if (currentView === 'dash') renderDash();
}

function renderMaybe() {
  const box = $('maybebox');
  box.innerHTML = '';
  if (!deck.maybe.length) return;
  box.append(el('h3', null, `Maybeboard (${deck.maybe.length})`));
  const ul = el('ul');
  for (const name of deck.maybe) {
    ul.appendChild(deckRow(name, { onName: undefined, buttons: [
      ['↑', 'Move into the deck', async () => { const [c] = await lookup([name]); addTo(deck, c); renderDeck(); }],
      ['×', 'Remove', () => { deck.maybe = deck.maybe.filter(n => n !== name); save(); renderDeck(); }, 'del'],
    ] }));
  }
  box.append(ul);
}

function addMaybe(d, c) {
  remember(d, c);
  if (!d.maybe.includes(c.name) && !inDeck(d, c.name)) d.maybe.push(c.name);
  save(d);
}

function renderHistory() {
  const box = $('history');
  box.innerHTML = '';
  $('undo').disabled = !deck.log.length || deck.log.at(-1).op === 'import';
  const days = {};
  for (const e of deck.log) (days[new Date(e.t).toLocaleDateString('sv')] ??= []).push(e);  // sv formats as YYYY-MM-DD
  for (const day of Object.keys(days).sort().reverse().slice(0, 30)) {
    box.append(el('h4', null, day));
    for (const e of days[day].slice().reverse()) {
      const line = el('div', 'log');
      if (e.op === '+') line.append(el('span', 'add', '+ ' + e.name));
      else if (e.op === '-') line.append(el('span', 'rem', '− ' + e.name + (e.n > 1 ? ` ×${e.n}` : '')));
      else if (e.op === 'q') line.textContent = `${e.name}: ${e.from} → ${e.to}`;
      else if (e.op === 'c') line.textContent = e.name ? `Commander: ${e.name}` : `Removed commander ${e.from}`;
      else if (e.op === 'p') line.textContent = e.name ? `Second commander: ${e.name}` : `Removed second commander ${e.from}`;
      else if (e.op === 'import') line.textContent = `Imported (${e.name})`;
      box.append(line);
    }
  }
}

// Fill in images and types for deck cards saved before they were stored.
async function fillDeckInfo() {
  const d = deck;
  const names = [...cmdrs(d), ...d.cards, ...d.maybe];
  await lookup(names);
  const missing = names.filter(n => cardData[n]?.tags && String(d.info[n]?.tags) !== String(cardData[n].tags));  // new or retagged
  missing.forEach(n => remember(d, cardData[n]));
  refreshIdentity(d);
  if (missing.length) save(d);
  if (d === deck) renderDeck();
}

// Enter adds the card, Shift+Enter checks which decks it fits. Suggestions: owned cards
// containing the text, then Scryfall's autocomplete over every card.
$('quick').onkeydown = async e => {
  if (e.key !== 'Enter') return;
  const name = $('quick').value.trim();
  if (!name) return;
  const [c] = await lookup([name]);
  if (!c) { $('quick').style.borderColor = 'var(--bad)'; return; }
  $('quick').style.borderColor = '';
  $('quick').value = '';
  if (e.shiftKey) return fitOne(c);
  $('status').textContent = addTo(deck, c) ? `added ${c.name}` : `${c.name} is already in the deck`;
  renderDeck();
};
let quickTimer;
$('quick').oninput = () => {
  clearTimeout(quickTimer);
  const q = $('quick').value.trim();
  if (q.length < 2) return;
  quickTimer = setTimeout(async () => {
    const mine = ownedCards.filter(c => norm(c.name).includes(norm(q))).slice(0, 8).map(c => c.name);
    const r = await (await fetch('https://api.scryfall.com/cards/autocomplete?q=' + encodeURIComponent(q))).json().catch(() => ({}));
    if ($('quick').value.trim() !== q) return;
    $('allnames').replaceChildren(...[...new Set([...mine, ...(r.data || [])])].slice(0, 20).map(n => new Option(n)));
  }, 150);
};
addEventListener('keydown', e => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('quick').focus(); }
  if (e.key === 'Escape') $('preview').style.display = 'none';
});

// ---------- stats ----------

const lower = s => (s || '').toLowerCase().replace(/\([^)]*\)/g, '');
const isLand = c => /\bLand\b/.test(c.type_line.split(' // ')[0]);
// Themes a deck leans into, ranked by how many more cards it has for each than a typical Commander
// deck with as many nonland cards would. `cards`: database entries for the deck's cards and commanders.
function topThemes(d, cards, limit = 10) {
  const n = c => isCmdr(d, c.name) ? 1 : qty(d, c.name);
  const nonland = cards.filter(c => !isLand(c)), size = nonland.reduce((s, c) => s + n(c), 0);
  return Object.entries(strategies).filter(([, s]) => s.kind === 'theme').map(([label, s]) => {
    const hits = nonland.filter(c => (c.tags || []).includes(label));
    const count = hits.reduce((t, c) => t + n(c), 0), expected = size * s.rate;
    return { label, s, hits, count, expected, excess: count - expected };
  }).filter(t => t.count >= 3 && t.excess > 1).sort((a, b) => b.excess - a.excess).slice(0, limit);
}

// Roles come from Scryfall Tagger (see ROLE_TAGS in server.py); [label, role, template count]
const ROLES = [['Ramp', 'ramp', 10], ['Card draw', 'draw', 10], ['Removal', 'removal', 8], ['Board wipes', 'wipe', 3], ['Tutors', 'tutor', 0]];
const ROLE_NAMES = { ramp: 'ramp', draw: 'card draw', removal: 'removal', wipe: 'board wipe', tutor: 'tutor' };
const hasRole = (c, role) => (c.roles || []).includes(role) && !(role === 'ramp' && isLand(c));

function renderStats() {
  const box = $('stats');
  if (!$('statsbox').open) return;
  const cards = deck.cards.map(n => cardData[n]).filter(Boolean);
  box.innerHTML = '';
  if (cards.length < deck.cards.length) { box.textContent = 'loading...'; return; }
  const n = c => qty(deck, c.name);
  const all = [...cmdrs(deck).map(n => cardData[n]).filter(Boolean), ...cards];

  // mana curve of nonland cards, with EDHREC's average deck as dashed markers
  box.append(el('h4', null, 'Mana curve (nonland)'));
  const curve = Array(8).fill(0), avg = Array(8).fill(0);
  for (const c of cards) if (!isLand(c)) curve[Math.min(7, Math.floor(c.cmc))] += n(c);
  for (const [k, v] of Object.entries(edhPageNow?.curve || {})) avg[Math.min(7, Number(k))] += v;
  const top = Math.max(...curve, ...avg, 1);
  const bars = el('div', 'bars');
  curve.forEach((v, i) => {
    const col = el('div');
    col.title = `${v} cards at ${i}${i === 7 ? '+' : ''}` + (avg[i] ? `, EDHREC average ${avg[i]}` : '');
    const bar = el('i'); bar.style.height = (v / top * 55) + 'px';
    col.append(el('span', null, v || ''), bar, el('span', null, i === 7 ? '7+' : i));
    if (avg[i]) { const m = el('b'); m.style.bottom = (avg[i] / top * 55 + 14) + 'px'; col.append(m); }
    bars.append(col);
  });
  box.append(bars);

  // counts against a common template (37 lands, 10 ramp, 10 draw, 8 removal, 3 wipes)
  box.append(el('h4', null, 'Deck template'));
  const lands = cards.filter(isLand).reduce((s, c) => s + n(c), 0);
  // a stats label that filters the deck list to the cards it counts
  const filterLink = (label, test, query) => {
    const a = el('a', 'filter' + (deckFilter?.label === label ? ' on' : ''), label);
    a.href = '#';
    a.title = 'Show these cards in the deck list';
    a.onclick = e => { e.preventDefault(); showOnly(label, test, query); };
    return a;
  };
  const meter = (label, have, want, test) => {
    const m = el('div', 'meter' + (have < want ? ' low' : ''));
    const track = el('span', 'track'), fill = el('i');
    fill.style.width = (want ? Math.min(100, have / want * 100) : have ? 100 : 0) + '%';
    track.append(fill);
    m.append(filterLink(label, test), track, el('span', null, want ? `${have} / ${want}` : have));
    box.append(m);
  };
  meter('Lands', lands, 37, isLand);
  for (const [label, role, want] of ROLES) {
    const hits = cards.filter(c => hasRole(c, role));
    meter(label, hits.reduce((s, c) => s + n(c), 0), want, c => hasRole(c, role));
  }

  // Themes the deck leans into, ranked by how many more cards it has for each than a typical
  // Commander deck with this many nonland cards would. Click one to see its cards, + to search for more.
  const themes = topThemes(deck, all);
  if (themes.length) {
    box.append(el('h4', null, 'Top strategies'));
    const most = Math.max(...themes.map(t => t.count));
    for (const t of themes) {
      const row = el('div', 'meter theme'), track = el('span', 'track'), fill = el('i'), more = el('button', 'x', '+');
      fill.style.width = t.count / most * 100 + '%';
      track.append(fill);
      more.title = `Find more ${t.label.toLowerCase()} cards`;
      more.onclick = () => findStrategy(t.s.query);
      const stat = el('span', null, `${t.count} · ${(t.count / Math.max(t.expected, 0.1)).toFixed(1)}×`);
      stat.title = `${t.count} cards; a typical deck this size has ${t.expected.toFixed(1)}`;
      row.append(filterLink(t.label, c => !isLand(c) && (c.tags || []).includes(t.label), t.s.query), track, stat, more);
      box.append(row);
    }
  }

  // colored mana symbols in costs vs. lands that make each color
  const ids = [...(deck.identity || '').toUpperCase()];
  if (ids.length) {
    box.append(el('h4', null, 'Colors: share of mana symbols / land sources'));
    const pips = {}, sources = {};
    for (const c of cards) {
      if (isLand(c)) { for (const x of c.produced_mana || []) sources[x] = (sources[x] || 0) + n(c); continue; }
      for (const [, sym] of (c.mana_cost || '').matchAll(/\{([^}]+)\}/g)) for (const x of ids) if (sym.includes(x)) pips[x] = (pips[x] || 0) + n(c);
    }
    const total = Object.values(pips).reduce((a, b) => a + b, 0) || 1;
    for (const x of ids) {
      const m = el('div', 'meter');
      const track = el('span', 'track'), fill = el('i');
      fill.style.width = (pips[x] || 0) / total * 100 + '%';
      track.append(fill);
      m.append(el('span', null, COLORS[x]), track, el('span', null, `${pct((pips[x] || 0) / total)} / ${sources[x] || 0}`));
      m.title = `${pips[x] || 0} ${COLORS[x].toLowerCase()} symbols in mana costs, ${sources[x] || 0} lands that make ${COLORS[x].toLowerCase()}`;
      box.append(m);
    }
  }

  // Commander brackets: 1-2 allow no Game Changers and no two-card combos, 3 allows up to three
  // Game Changers and only late-game two-card combos, 4+ anything
  const gc = all.filter(c => c.game_changer);
  const d = deck, combos = combosNow(d, () => { if (d === deck) renderStats(); });
  const two = twoCardCombos(combos);
  box.append(el('h4', null, `Bracket: Game Changers ${gc.length}, two-card combos ${combos ? two.length : '…'}`));
  const bracket = gc.length > 3 ? 'Bracket 4+' : gc.length || two.length ? 'Bracket 3 at least' + (two.length ? ' (4 if the combos can win early)' : '') : 'Fits brackets 1–2';
  box.append(el('div', 'dim', bracket));
  if (gc.length) box.append(el('div', 'dim', 'Game Changers: ' + gc.map(c => c.name).join(', ')));
  for (const c of two) box.append(el('div', 'dim', `Combo: ${c.cards.join(' + ')} (${c.produces[0] || ''})`));

  const value = all.reduce((s, c) => s + (Number(c.usd) || 0) * (isCmdr(deck, c.name) ? 1 : n(c)), 0);
  const missing = all.filter(c => !isOwned(c.name)).reduce((s, c) => s + (Number(c.usd) || 0) * n(c), 0);
  box.append(el('h4', null, `Value: $${value.toFixed(0)}`), el('div', 'dim', `$${missing.toFixed(0)} of it in cards you don't own`));
}
$('statsbox').ontoggle = async () => { if ($('statsbox').open) { await lookup([...cmdrs(deck), ...deck.cards]); renderStats(); } };
