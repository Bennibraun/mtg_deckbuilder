
// Owned cards are filtered locally from the bulk database. Fields that depend on the
// printing (set, price, artist...) or that are not reimplemented here fall back to
// scanning Scryfall search pages; `local` is null in that case.
function buildQuery() {
  const v = id => $(id).value.trim();
  const low = s => (s || '').toLowerCase();
  const quote = x => /[\s()"]/.test(x) ? `"${x.replace(/"/g, '')}"` : x;
  const checked = cls => [...document.querySelectorAll(`.${cls}:checked`)].map(e => e.value);
  const any = terms => terms.length > 1 ? `(${terms.join(' or ')})` : terms[0] || '';
  const cmp = (a, op, b) => ({ '=': a === b, '<': a < b, '<=': a <= b, '>': a > b, '>=': a >= b, '!=': a !== b })[op];
  const setCmp = (have, op, want) => {
    const sub = [...have].every(x => want.has(x)), sup = [...want].every(x => have.has(x));
    return op === '=' ? sub && sup : op === '<=' ? sub : sup;
  };
  const user = [v('q')], tests = [c => !c.hidden];
  let local = !v('q');
  if (v('name')) { user.push(`name:${quote(v('name'))}`); tests.push(c => low(c.name).includes(low(v('name')))); }
  if (v('oracle')) {
    user.push(`o:${quote(v('oracle'))}`);
    // o: skips reminder text; ~ stands for the card's name or "this <object>"
    const self = /\bthis (artifact|battle|creature|enchantment|land|planeswalker|permanent|spell|card|equipment|aura|vehicle|saga)\b/g;
    tests.push(c => {
      let t = low(c.oracle_text).replace(/\([^)]*\)/g, '');
      for (const n of [c.name, ...c.name.split(' // '), c.name.split(',')[0]]) t = t.replaceAll(low(n), '~');
      return t.replace(self, '~').includes(low(v('oracle')));
    });
  }
  for (const w of v('type').split(/\s+/).filter(Boolean)) {
    const neg = w[0] === '-', word = low(neg ? w.slice(1) : w);
    user.push(`${neg ? '-' : ''}t:${word}`);
    tests.push(c => low(c.type_line).includes(word) !== neg);
  }
  const cols = checked('col');
  if (cols.length) {
    const op = $('cop').value, want = new Set(cols.filter(x => x !== 'c'));
    user.push(`c${op}${cols.join('')}`);
    tests.push(c => setCmp(new Set(c.colors.map(low)), op, want));
  }
  const identity = ids => { const want = new Set(ids.filter(x => x !== 'c')); return c => c.color_identity.every(x => want.has(low(x))); };
  const cid = checked('cid');
  if (cid.length) { user.push(`id<=${cid.join('')}`); tests.push(identity(cid)); }
  if (v('statv') !== '') {
    const stat = $('stat').value, op = $('statop').value, n = Number(v('statv'));
    user.push(`${stat}${op}${v('statv')}`);
    // power/toughness/loyalty hold one value per face; any face may match
    const vals = c => stat === 'mv' ? [c.cmc] : stat === 'pt' ? c.power.map((p, i) => Number(p) + Number(c.toughness[i]))
      : ({ pow: c.power, tou: c.toughness, loy: c.loyalty }[stat]).map(Number);
    tests.push(c => vals(c).some(x => cmp(x, op, n)));
  }
  const fmt = $('fmt').value, fop = $('fop').value;
  if (fmt && fop !== 'f') {
    user.push(`${fop}:${fmt}`);
    tests.push(c => c.legalities[fmt] === fop);
  }
  if ($('isCmd').checked) {
    user.push('is:commander');
    tests.push(c => c.commander);
  }
  const remote = [
    v('mana') && `m:${v('mana').replace(/\s/g, '')}`,
    any(checked('game').map(g => `game:${g}`)),
    any(v('set').split(/[\s,]+/).filter(Boolean).map(c => `s:${c}`)),
    any(checked('rar').map(r => `r:${r}`)),
    ...v('crit').split(/\s+/).filter(Boolean).map(w => w[0] === '-' ? `-is:${w.slice(1)}` : `is:${w}`),
    v('price') !== '' && `${$('cur').value}${$('curop').value}${v('price')}`,
    v('artist') && `a:${quote(v('artist'))}`,
    v('flavor') && `ft:${quote(v('flavor'))}`,
    $('lang').value && `lang:${$('lang').value}`,
    $('prefer').value && `prefer:${$('prefer').value}`,
  ].filter(Boolean);
  if (remote.length || $('prints').checked || $('extras').checked) local = false;
  user.push(...remote);
  const defaults = [];
  if (fmt && fop === 'f') { defaults.push(`f:${fmt}`); tests.push(c => ['legal', 'restricted'].includes(c.legalities[fmt])); }
  if ($('inId').checked && deck.commander) { defaults.push(`id<=${deck.identity || 'c'}`); tests.push(identity([...(deck.identity || 'c')])); }
  const u = user.filter(Boolean);
  return { q: u.concat(defaults).join(' '), local: local ? c => tests.every(t => t(c)) : null };
}

const sorters = {
  name: (a, b) => a.name.localeCompare(b.name),
  cmc: (a, b) => a.cmc - b.cmc,
  edhrec: (a, b) => (a.edhrec_rank ?? 1e9) - (b.edhrec_rank ?? 1e9),
};
const edhStat = c => statFor(edh, c.name);
const bySynergy = () => ['syn', 'inc'].includes($('order').value);

// Commander sorts put cards EDHREC lists for the commander first, highest first;
// the rest keep their previous order.
function sortCards(list, localSort) {
  const o = $('order').value;
  if (bySynergy()) {
    list.sort((a, b) => (edhStat(b)?.[o] ?? -Infinity) - (edhStat(a)?.[o] ?? -Infinity));
    if ($('dir').value === 'asc') list.reverse();
  } else if (localSort) {
    list.sort(sorters[o] || sorters.edhrec);
    if ($('dir').value === 'desc') list.reverse();
  }
  return list;
}

let gen = 0, redraw = () => {};  // redraw re-renders the latest results, e.g. after the deck changes
const MAX_PAGES = 60, MAX_OTHER = 175;

async function search() {
  if (!deck) return;  // decks still loading
  const my = ++gen;
  const { q, local } = buildQuery();
  $('full').textContent = q;
  let ownedList = [], otherList = [], total = 0;
  const draw = redraw = () => {
    const notInDeck = c => !inDeck(deck, c.name);
    const owned = sortCards(ownedList, local).filter(notInDeck);
    const other = sortCards(otherList, false).filter(notInDeck).slice(0, MAX_OTHER);
    $('owned').replaceChildren(...owned.map(c => cardEl(c)));
    $('other').replaceChildren(...other.map(c => cardEl(c)));
    $('nOwned').textContent = owned.length;
    $('nOther').textContent = other.length + (total - ownedList.length > MAX_OTHER ? ` of ${total - ownedList.length}` : '');
  };
  draw();
  if (!q) { $('status').textContent = ''; return; }
  const order = bySynergy() ? 'edhrec' : $('order').value;
  const params = new URLSearchParams({ q, order, dir: $('dir').value, unique: $('prints').checked ? 'prints' : 'cards', include_extras: $('extras').checked });
  let url = 'https://api.scryfall.com/cards/search?' + params;
  if (local) {
    ownedList = ownedCards.filter(local);
    if (bySynergy()) otherList = edhCards.filter(c => !isOwned(c.name) && local(c));
    draw();
  }
  const seen = new Set(otherList.map(c => c.name));
  const maxPages = local ? 1 : MAX_PAGES;
  let page = 0;
  while (url && page < maxPages) {
    $('status').textContent = `loading page ${page + 1}...`;
    const r = await (await fetch(url)).json();
    if (my !== gen) return;
    if (r.object === 'error') { $('status').textContent = r.details; return; }
    total = r.total_cards;
    for (const c of r.data) {
      if (isOwned(c.name)) { if (!local) ownedList.push(c); }
      else if (!seen.has(c.name)) { seen.add(c.name); otherList.push(c); }
    }
    draw();
    url = r.has_more ? r.next_page : null;
    page++;
    if (url && page < maxPages) { await sleep(500); if (my !== gen) return; }
  }
  $('status').textContent = `${total} matches` + (local ? ' (owned: local database)' : url ? ` (scanned first ${MAX_PAGES} pages for owned cards, refine query)` : ' (owned: scanned Scryfall pages)');
}

// Search view for cards with a strategy's Scryfall tags, within the deck's colors
function findStrategy(query) {
  for (const id of ['name', 'oracle', 'type']) $(id).value = '';
  $('q').value = `(${query})`;
  $('inId').checked = true;
  showView('search'); searchSoon();
}

let timer;
const searchSoon = () => { clearTimeout(timer); timer = setTimeout(search, 400); };

function cardEl(c) {
  const d = el('div', 'card' + (isOwned(c.name) ? ' owned' : ''));
  d.innerHTML = `<img src="${big(small(c))}" loading="lazy">`;
  d.querySelector('img').title = `${c.name} (click to add)`;
  d.onclick = () => { addTo(deck, c); renderDeck(); };
  const s = edhStat(c);
  if (s) {
    const b = el('span', 'edh', `${s.syn >= 0 ? '+' : ''}${Math.round(s.syn * 100)}% syn · ${pct(s.inc)}`);
    b.title = 'EDHREC: synergy with your commander, share of its decks running this card';
    d.appendChild(b);
  }
  const users = decksWith(c.name).filter(x => x !== deck);
  if (users.length) {
    const b = el('span', 'where', `in ${users.length} deck${users.length > 1 ? 's' : ''}`);
    b.title = users.map(x => x.name).join('\n') + (isOwned(c.name) ? `\nyou own ${ownedCount(c.name)}` : '');
    d.appendChild(b);
  }
  const acts = el('div', 'acts'), act = (label, fn) => {
    const b = el('button', null, label);
    b.onclick = e => { e.stopPropagation(); fn(); };
    acts.appendChild(b);
  };
  act('Maybe', () => { addMaybe(deck, c); renderDeck(); });
  act('Fit?', () => fitOne(c));
  if (commanders.has(c.name)) act('Commander', () => { setCommanderOf(deck, c); renderDeck(); loadEdh(); });
  if (deck.commander && !deck.partner && cardData[deck.commander] && canPair(cardData[deck.commander], c))
    act(pairing(c).background ? 'Background' : 'Partner', () => { setPartnerOf(deck, c); renderDeck(); loadEdh(); });
  d.appendChild(acts);
  return d;
}
