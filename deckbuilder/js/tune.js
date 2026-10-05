// Tune tab: collapsible sections (open state remembered per browser), sorted by the "Sort by" choice.

const sortBy = () => $('tunerank').value;
const byPrice = () => sortBy().startsWith('price');
// EDHREC rank, higher is better: synergy is "how much more than other decks of these colors",
// inclusion how many decks of this commander run it. Price sorts fall back to synergy where price
// means nothing (cut candidates) and to break ties.
const rank = s => !s ? -Infinity : sortBy() === 'inc' ? s.inc : sortBy() === 'score' ? score(s) : s.syn;
// suggestion order: price (cards without one last), else EDHREC rank
function suggestionOrder(a, b) {
  const tie = rank(edhStat(b)) - rank(edhStat(a));
  if (!byPrice()) return tie;
  const pa = usdOf(a) || Infinity, pb = usdOf(b) || Infinity;
  if (pa === pb) return tie;
  if (sortBy() === 'price-desc') return pa === Infinity ? 1 : pb === Infinity ? -1 : pb - pa;
  return pa - pb;
}
const setCount = (id, text) => { $(id + '-n').textContent = text; };

async function renderTune() {
  const d = deck;
  $('tunetitle').textContent = d.name;
  if (!d.commander) {
    $('tunestatus').textContent = 'Set a commander to get suggestions.';
    for (const id of ['cuts', 'upgrades', 'buy', 'avg', 'combos']) { $(id).innerHTML = ''; setCount(id, ''); }
    return;
  }
  $('tunestatus').textContent = '';
  renderCombos(d);
  const base = await deckPage(d, 'commanders', '');
  if (d !== deck) return;
  $('theme').replaceChildren(new Option('all decks', ''), ...(base?.themes || []).map(t => new Option(`${t.value} (${t.count})`, t.slug)));
  $('theme').value = d.theme;

  // cards EDHREC doesn't list for this commander rank lowest
  const cuts = d.cards.filter(n => !d.info[n]?.any).map(n => ({ n, s: statFor(edh, n) }))
    .sort((a, b) => rank(a.s) - rank(b.s) || (d.info[b.n]?.cmc || 0) - (d.info[a.n]?.cmc || 0)).slice(0, 15);
  $('cuts').replaceChildren(...cuts.map(({ n, s }) => {
    const li = deckRow(n, { buttons: [['?', 'Which decks does this fit?', async () => { const [c] = await lookup([n]); if (c) fitOne(c); }], ['↓', 'Move to maybeboard', () => { removeFrom(d, n); d.maybe.push(n); save(d); renderDeck(); }], ['×', 'Remove', () => { removeFrom(d, n); renderDeck(); }, 'del']] });
    li.insertBefore(el('span', 'dim', describe(s)), li.querySelector('.x'));
    return li;
  }));
  setCount('cuts', cuts.length);

  const candidates = edhCards.filter(c => !inDeck(d, c.name)).sort(suggestionOrder);
  const ups = candidates.filter(c => isOwned(c.name));
  $('upgrades').replaceChildren(...ups.slice(0, 40).map(c => cardEl(c, { price: byPrice() })));
  if (!ups.length) $('upgrades').append(el('div', 'dim', edhCards.length ? 'Every EDHREC card you own is already in the deck.' : 'No EDHREC data for this commander.'));
  setCount('upgrades', ups.length > 40 ? `40 of ${ups.length}` : ups.length);

  const max = $('buymax').value === '' ? Infinity : Number($('buymax').value);
  const buy = candidates.filter(c => !isOwned(c.name) && (Number(c.usd) || 0) <= max);
  $('buy').replaceChildren(...buy.slice(0, 40).map(c => cardEl(c, { price: true })));
  if (!buy.length) $('buy').append(el('div', 'dim', edhCards.length ? 'Nothing left to buy at this price.' : 'No EDHREC data for this commander.'));
  setCount('buy', buy.length > 40 ? `40 of ${buy.length}` : buy.length);

  const avgPage = await deckPage(d, 'average-decks');
  if (d !== deck) return;
  const box = $('avg');
  box.innerHTML = '';
  if (!avgPage?.deck?.length) { setCount('avg', ''); box.append(el('div', 'dim', 'EDHREC has no average deck here.')); return; }
  const avgNames = avgPage.deck.map(x => x[0]).filter(n => !isCmdr(d, n) && !/^(Plains|Island|Swamp|Mountain|Forest|Wastes)$/.test(n));
  const missing = avgNames.filter(n => !inDeck(d, n) && !inDeck(d, front(n)));
  const extra = d.cards.filter(n => !d.info[n]?.any && !avgNames.includes(n) && !avgNames.some(a => front(a) === n));
  const missingCards = (await lookup(missing)).filter(Boolean);
  if (d !== deck) return;
  const mOwned = missingCards.filter(c => isOwned(c.name)), mOther = missingCards.filter(c => !isOwned(c.name));
  setCount('avg', `${missing.length} missing, ${mOwned.length} owned`);
  box.append(el('h4', null, `In the average deck, not yours: ${mOwned.length} owned`));
  const g = el('div', 'results compact'); g.append(...mOwned.map(c => cardEl(c))); box.append(g);
  box.append(el('h4', null, `…and ${mOther.length} you don't own`));
  const g2 = el('div', 'results compact'); g2.append(...mOther.map(c => cardEl(c, { price: true }))); box.append(g2);
  box.append(el('h4', null, `Only in yours (${extra.length})`), el('div', 'dim', extra.join(' · ')));
}
$('theme').onchange = () => { deck.theme = $('theme').value; save(); loadEdh(); };

// remembered settings: rank, max price, and which sections are open
const tunePrefs = (() => { try { return JSON.parse(localStorage.getItem('tune') || '{}'); } catch { return {}; } })();
const saveTunePrefs = () => { try { localStorage.setItem('tune', JSON.stringify(tunePrefs)); } catch {} };
$('tunerank').value = tunePrefs.rank || 'syn';
$('buymax').value = tunePrefs.max ?? '';
$('tunerank').onchange = () => { tunePrefs.rank = $('tunerank').value; saveTunePrefs(); renderTune(); };
let buyTimer;
$('buymax').oninput = () => { tunePrefs.max = $('buymax').value; saveTunePrefs(); clearTimeout(buyTimer); buyTimer = setTimeout(renderTune, 300); };
for (const box of document.querySelectorAll('.tunebox')) {
  const key = box.dataset.key;
  if (tunePrefs.open?.[key] !== undefined) box.open = tunePrefs.open[key];
  box.ontoggle = () => { (tunePrefs.open ??= {})[key] = box.open; saveTunePrefs(); };
}
