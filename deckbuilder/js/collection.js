
function shoppingNeeds() {
  const need = {};
  for (const d of Object.values(decks)) for (const n of [...cmdrs(d), ...d.cards]) {
    if (d.info[n]?.any) continue;
    const e = need[n] ??= { name: n, decks: [], used: 0 };
    e.decks.push(d.name); e.used += isCmdr(d, n) ? 1 : qty(d, n);
  }
  return Object.values(need);
}

let prices = {};
async function renderShop(fetchPrices) {
  const list = shoppingNeeds().filter(e => !isOwned(e.name));
  if (fetchPrices) {
    const want = list.map(e => e.name);
    for (let i = 0; i < want.length; i += 75) {
      $('shopstatus').textContent = `loading prices ${i}/${want.length}...`;
      const r = await (await fetch('https://api.scryfall.com/cards/collection', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: want.slice(i, i + 75).map(name => ({ name: front(name) })) }) })).json();
      for (const c of r.data || []) prices[c.name] = prices[front(c.name)] = Number(c.prices.usd || c.prices.usd_foil) || 0;
      await sleep(100);
    }
    $('shopstatus').textContent = '';
  }
  for (const e of list) e.usd = prices[e.name] ?? (Number(cardData[e.name]?.usd) || 0);
  list.sort((a, b) => (b.usd || 0) - (a.usd || 0));
  const total = list.reduce((s, e) => s + (e.usd || 0) * e.used, 0);
  const t = el('table');
  t.innerHTML = `<tr><th>Card</th><th class="num">Copies</th><th>Decks</th><th class="num">Price</th></tr>`;
  for (const e of list) {
    const tr = el('tr');
    tr.append(el('td', null, e.name), el('td', 'num', e.used), el('td', 'dim', e.decks.join(', ')), el('td', 'num', e.usd ? `$${e.usd.toFixed(2)}` : '–'));
    preview(tr, cardData[e.name] && small(cardData[e.name]));
    t.append(tr);
  }
  $('shop').replaceChildren(list.length ? t : el('div', 'dim', 'You own every card in your decks.'), el('h4', null, `${list.length} cards, about $${total.toFixed(2)}`));

  const short = shoppingNeeds().filter(e => isOwned(e.name) && e.used > ownedCount(e.name));
  const t2 = el('table');
  t2.innerHTML = `<tr><th>Card</th><th class="num">Owned</th><th class="num">Used</th><th>Decks</th></tr>`;
  for (const e of short) { const tr = el('tr'); tr.append(el('td', null, e.name), el('td', 'num', ownedCount(e.name)), el('td', 'num', e.used), el('td', 'dim', e.decks.join(', '))); t2.append(tr); }
  $('short').replaceChildren(short.length ? t2 : el('div', 'dim', 'You have enough copies for every deck.'));
}
$('shopgo').onclick = () => renderShop(true);
$('shopcopy').onclick = () => navigator.clipboard.writeText(shoppingNeeds().filter(e => !isOwned(e.name)).map(e => `${e.used} ${e.name}`).join('\n'));

$('scango').onclick = async () => {
  const cmds = ownedCards.filter(c => c.commander && !c.hidden);
  const results = [];
  let done = 0;
  $('scango').disabled = true;
  await pool(cmds, 3, async c => {
    const p = await edhPage(`commanders/${slug(c.name)}`);
    $('scanstatus').textContent = `scanning ${++done}/${cmds.length}...`;
    const stats = statsOf(p);
    let have = 0, all = 0, n = 0, total = 0;
    for (const [name, s] of Object.entries(stats)) {
      if (name.includes(' // ') && stats[front(name)] === s) continue;  // counted under the front name too
      if (/^(Plains|Island|Swamp|Mountain|Forest)$/.test(name)) continue;
      all += s.inc; total++;
      if (isOwned(name)) { have += s.inc; n++; }
    }
    if (total) results.push({ c, cover: have / all, n, total });
  });
  $('scango').disabled = false;
  $('scanstatus').textContent = `${results.length} commanders with EDHREC pages`;
  results.sort((a, b) => b.cover - a.cover);
  const t = el('table');
  t.innerHTML = `<tr><th>Commander</th><th class="num">Coverage</th><th class="num">EDHREC cards owned</th><th>Your decks</th><th></th></tr>`;
  for (const { c, cover, n, total } of results.slice(0, 40)) {
    const tr = el('tr'), td = el('td'), row = el('div', 'cmdrow'), img = el('img');
    img.src = small(c) || ''; preview(img, small(c));
    row.append(img, el('span', null, c.name)); td.append(row);
    const b = el('button', null, 'New deck');
    b.onclick = () => { const name = uniqueName(front(c.name)); decks[name] = emptyDeck(name); setCommanderOf(decks[name], c); openDeck(name); showView('tune'); };
    const act = el('td'); act.append(b);
    tr.append(td, el('td', 'num', pct(cover)), el('td', 'num', `${n} / ${total}`), el('td', 'dim', decksWith(c.name).map(d => d.name).join(', ')), act);
    t.append(tr);
  }
  $('scan').replaceChildren(t);
};
