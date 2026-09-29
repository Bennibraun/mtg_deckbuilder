
// Creature types a deck is built around: shared by at least 8 cards and a third of its creatures.
function tribesOf(d) {
  const counts = {};
  let creatures = 0;
  for (const n of [...cmdrs(d), ...d.cards]) {
    const t = d.info[n]?.type || '';
    if (/Creature/.test(t)) creatures++;
    for (const sub of new Set((t.split(' — ')[1] || '').split(/\s+|\/\//).filter(Boolean))) counts[sub] = (counts[sub] || 0) + 1;
  }
  return Object.keys(counts).filter(s => counts[s] >= Math.max(8, creatures / 3));
}

// Cards in a deck to cut for `c`, weakest EDHREC score first: cards sharing a role with it
// (ramp, removal...), else the same card type, else any card that's a land when `c` is.
function cutFor(d, stats, c) {
  const want = typeOf(c.type_line), land = want === 'Land', roles = rolesOf(c);
  const pool = d.cards.filter(n => !d.info[n]?.any && (typeOf(d.info[n]?.type) === 'Land') === land);
  const sameRole = pool.filter(n => (d.info[n]?.roles || []).some(r => roles.includes(r)));
  const sameType = pool.filter(n => typeOf(d.info[n]?.type) === want);
  const list = (sameRole.length ? sameRole : sameType.length ? sameType : pool)
    .map(n => ({ name: n, s: statFor(stats, n), score: score(statFor(stats, n)), cmc: d.info[n]?.cmc || 0 }));
  list.sort((a, b) => a.score - b.score || b.cmc - a.cmc);
  return list;
}
const rolesOf = c => (c.roles || cardData[c.name]?.roles || []).filter(r => r !== 'tutor' && !(r === 'ramp' && isLand(c)));

let fitGen = 0;

// Scores cards against every deck with a commander. Returns rows {c, fits, best}, best first;
// each fit {d, stats, s, top, tribe, partner, combos, score, signal, has}.
async function scoreCards(cards, status = () => {}, { tops: withTops = true } = {}) {
  cards = [...new Map(cards.map(c => [c.name, c])).values()];
  await lookup(cards.map(c => c.name));  // roles for Scryfall results
  const withCmd = Object.values(decks).filter(d => d.commander);
  if (!withCmd.length) return null;
  // card info for decks that haven't been opened since it was stored
  const noInfo = withCmd.flatMap(d => [...cmdrs(d), ...d.cards].filter(n => !d.info[n]?.roles).map(n => [d, n]));
  if (noInfo.length) {
    await lookup(noInfo.map(x => x[1]));
    const changed = new Set();
    for (const [d, n] of noInfo) if (cardData[n]?.roles) { remember(d, cardData[n]); changed.add(d); }
    for (const d of changed) { refreshIdentity(d); save(d); }
  }
  status(`loading EDHREC and combos for ${withCmd.length} decks...`);
  const [deckPages, deckComboResults] = await Promise.all([
    Promise.all(withCmd.map(d => deckPage(d))),
    Promise.all(withCmd.map(d => deckCombos(d))),
  ]);
  // EDHREC's top commanders for each card; skipped for big lists to go easy on EDHREC
  const tops = {};
  if (withTops && cards.length <= 60) {
    let done = 0;
    await pool(cards, 4, async c => {
      const p = await edhPage('cards/' + slug(c.name));
      tops[c.name] = new Set((p?.lists.find(l => l.header === 'Top Commanders')?.cards || []).map(x => x[0]));
      status(`loading EDHREC card pages... ${++done}/${cards.length}`);
    });
  }
  const info = withCmd.map((d, i) => ({ d, stats: statsOf(deckPages[i]), tribes: tribesOf(d), pieces: missingPieces(d, deckComboResults[i]) }));
  const rows = cards.map(card => {
    const c = cardData[card.name]?.roles ? { ...card, roles: cardData[card.name].roles } : card;
    const sub = (c.type_line.split(' — ')[1] || '').split(/\s+/);
    const text = lower(oracleOf(c));
    const fits = [];
    for (const { d, stats, tribes, pieces } of info) {
      const partner = !d.partner && cardData[d.commander] && canPair(cardData[d.commander], c);
      if (!partner && !c.color_identity.every(x => d.identity.includes(x.toLowerCase()))) continue;
      const s = statFor(stats, c.name), top = cmdrs(d).some(n => tops[c.name]?.has(n));
      const tribe = tribes.find(t => sub.includes(t) || new RegExp(`\\b${t.toLowerCase()}s?\\b`).test(text));
      const combos = pieces[norm(front(c.name))] || [];
      const sc = score(s) + (top ? 0.3 : 0) + (tribe ? 0.25 : 0) + (partner ? 0.3 : 0) + (combos.length ? 0.4 : 0);
      fits.push({ d, stats, s, top, tribe, partner, combos, score: sc, signal: !!(s || top || tribe || partner || combos.length), has: inDeck(d, c.name) });
    }
    fits.sort((a, b) => b.score - a.score);
    return { c, fits, best: fits.find(f => f.signal && !f.has)?.score ?? -1 };
  });
  return rows.sort((a, b) => b.best - a.best || isOwned(b.c.name) - isOwned(a.c.name));
}

async function runFit(input, label) {
  const my = ++fitGen;
  const status = t => { if (my === fitGen) $('fitstatus').textContent = t; };
  $('fitout').innerHTML = '';
  status('looking up cards...');
  const cards = Array.isArray(input) ? (await lookup(input)).filter(Boolean) : await input(status);
  const rows = await scoreCards(cards, status);
  if (my !== fitGen) return;
  if (!rows) return status('None of your decks has a commander yet.');
  fitRows = rows; fitLabel = label;
  renderFit();
}

// "Where does this fit?" for one card, from anywhere in the app
function fitOne(c) {
  showView('fit');
  $('fitnames').value = c.name;
  runFit(async () => [cardData[c.name]?.roles ? cardData[c.name] : c], c.name);
}

let fitRows = [], fitLabel = '';
function renderFit() {
  const all = $('fitall').checked, ownedOnly = $('fitowned').checked;
  const rows = fitRows.filter(r => (all || r.fits.some(f => f.signal)) && (!ownedOnly || isOwned(r.c.name)));
  $('fitstatus').textContent = `${fitLabel}: ${fitRows.length} cards, ${fitRows.filter(r => r.fits.some(f => f.signal)).length} with a match in your decks` + (rows.length > 200 ? ' (showing 200)' : '');
  $('fitout').replaceChildren(...rows.slice(0, 200).map(fitRow));
}
$('fitall').onchange = $('fitowned').onchange = renderFit;

function fitRow({ c, fits }) {
  const row = el('div', 'fit');
  const img = el('img');
  img.src = small(c) || ''; img.loading = 'lazy';
  preview(img, small(c));
  const body = el('div');
  const title = el('div', 'title', c.name);
  if (isOwned(c.name)) title.append(el('span', 'tag own', `owned ×${ownedCount(c.name)}`));
  const users = decksWith(c.name);
  if (users.length) title.append(el('span', 'tag', 'in ' + users.map(d => d.name).join(', ')));
  body.append(title, el('div', 'dim', c.type_line));
  const chips = el('div', 'chips');
  const shown = fits.filter(f => f.signal || $('fitall').checked);
  if (!shown.length) body.append(el('div', 'dim', fits.length ? `On color for ${fits.length} decks, no EDHREC or creature type match` : 'Off color for all your decks'));
  shown.forEach((f, i) => chips.append(fitChip(c, f, i === 0 && !f.has)));
  body.append(chips);
  row.append(img, body);
  return row;
}

function fitChip(c, f, best) {
  const { d, s } = f;
  const chip = el('div', 'chip' + (best ? ' best' : ''));
  chip.append(el('div', 'd', d.name));
  const why = [];
  if (s) why.push(`${s.syn >= 0 ? '+' : ''}${Math.round(s.syn * 100)}% synergy, in ${pct(s.inc)} of decks`);
  if (f.top) why.push(`a top commander for this card`);
  if (f.tribe) why.push(`${f.tribe} deck`);
  if (f.partner) why.push(pairing(c).background ? 'can be its background' : 'can be its second commander');
  if (f.combos.length) why.push(`completes ${f.combos.length} combo${f.combos.length > 1 ? 's' : ''}: ${f.combos[0].produces[0] || ''}`);
  const roles = rolesOf(c);
  if (roles.length) why.push(roles.map(r => ROLE_NAMES[r]).join(', '));
  chip.append(el('div', 'why', why.join(' · ') || 'on color'));
  if (f.combos.length) chip.lastChild.title = f.combos.map(x => `${x.cards.join(' + ')}: ${x.produces.join(', ')}`).join('\n');
  const acts = el('div', 'acts');
  if (f.has) { acts.append(el('span', 'tag', 'already in deck')); chip.append(acts); return chip; }
  const done = t => { acts.replaceChildren(el('span', 'tag', t)); if (d === deck) renderDeck(); };
  const btn = (label, fn) => { const b = el('button', null, label); b.onclick = fn; acts.append(b); return b; };
  if (f.partner) btn(pairing(c).background ? 'Set background' : 'Set partner', () => { setPartnerOf(d, c); done('second commander'); if (d === deck) loadEdh(); });
  btn('Add', () => { addTo(d, c); done('added'); });
  const cuts = cutFor(d, f.stats, c);
  if (cuts.length) {
    const sel = el('select');
    for (const x of cuts.slice(0, 15)) sel.add(new Option(`${x.name} (${describe(x.s)})`, x.name));
    btn('Swap for', () => { removeFrom(d, sel.value); addTo(d, c); done(`swapped for ${sel.value}`); });
    acts.append(sel);
  }
  btn('Maybe', () => { addMaybe(d, c); done('on maybeboard'); });
  chip.append(acts);
  return chip;
}

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (queue.length) await fn(queue.shift()); }));
}

$('fitgo').onclick = () => {
  const names = parseList($('fitnames').value).map(r => r.name);
  if (names.length) runFit(names, 'pasted cards');
};
$('fitnew').onclick = async () => {
  const a = await (await fetch('additions.json')).json();
  const names = Object.keys(a.cards || {});
  if (!names.length) return ($('fitstatus').textContent = a.date ? `No new cards in the upload on ${a.date}` : 'Upload a new Cards.txt to see what was added since the previous one.');
  runFit(names, `added on ${a.date}`);
};
$('setgo').onclick = () => {
  const code = $('fitset').value.trim().toLowerCase();
  if (code) reviewSet(code);
};
