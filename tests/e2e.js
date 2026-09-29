// Drives the deckbuilder served by run.sh on port 8765. Each step asserts on what the page
// shows; any page error or console error fails the run.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const URL = 'http://127.0.0.1:8765/';
const today = new Date().toISOString().slice(0, 10);

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL });
  const p = await context.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => m.type() === 'error' && errors.push(m.text()));
  p.on('dialog', d => d.accept(d.type() === 'prompt' ? 'Wilson' : undefined));
  // one "new" set so the alert shows up regardless of today's real releases
  await p.route('https://api.scryfall.com/sets', r => r.fulfill({ json: { data: [
    { code: 'lci', name: 'Test Set', released_at: today, set_type: 'expansion', digital: false, card_count: 286 },
  ] } }));
  const text = sel => p.textContent(sel);
  const clipboard = () => p.evaluate(() => navigator.clipboard.readText());
  // Buttons that only show on hover; lists re-render as data arrives, so retry until the click lands.
  const hoverClick = (item, button, what) => until(async () => {
    try { await item.hover({ timeout: 2000 }); await item.locator(button).click({ timeout: 2000 }); return true; } catch { return false; }
  }, what);
  const step = async (name, fn) => { process.stdout.write(`${name}... `); await fn(); console.log('ok'); };
  const until = async (fn, what, ms = 60000) => {
    for (const end = Date.now() + ms; Date.now() < end; await p.waitForTimeout(250)) if (await fn()) return;
    assert.fail(`timed out waiting for ${typeof what === 'function' ? await what() : what}`);
  };

  await step('load', async () => {
    await p.goto(URL);
    await until(async () => /owned cards loaded|matches/.test(await text('#status')), 'collection');
    await until(async () => (await p.$$('#decks option')).length > 0, 'decks');
    // tokens share names with real cards; lookups must return the real one
    const elves = await p.evaluate(() => fetch('cards.json', { method: 'POST', body: '["Llanowar Elves"]' }).then(r => r.json()));
    assert.deepEqual(elves.map(c => c.type_line), ['Creature — Elf Druid']);
    // Cards.txt lines without a count still count as owned
    const owned = await p.evaluate(() => fetch('owned.json').then(r => r.json()));
    assert.ok(owned.some(c => c.name === 'Command Tower' && c.owned === 1), 'count-less line');
    const cmdrList = await p.evaluate(() => fetch('commanders.json').then(r => r.json()));
    assert.ok(cmdrList.includes('Infinite Guideline Station'), 'is:commander list');
  });

  await step('import a deck', async () => {
    await p.click('#impdeck');
    await p.fill('#imptext', `Commander\n1 Gishath, Sun's Avatar (LCI) 229\n\nDeck\n1 Sol Ring\n1x Arcane Signet (CMM) 1 *F*\n12 Forest\n1 Basalt Monolith\n1 Regisaur Alpha\n1 Etali, Primal Conqueror\n1 Cultivate\n1 Kodama's Reach\n1 Beast Within\n1 Evolving Wilds\n1 Soul Warden\n1 Daxos, Blessed by the Sun\n1 Heliod, Sun-Crowned\n1 Not A Real Card\n\nSideboard\n1 Zacama, Primal Calamity`);
    await p.click('#impdlg button[value=ok]');
    await until(async () => (await text('#count')) === '25', async () => `deck count 25, have ${await text('#count')}: ${await text('#deck')}`);
    assert.match(await text('#maybebox'), /Zacama/);
  });

  await step('stats use role tags', async () => {
    await p.click('#statsbox summary');
    await until(async () => /Ramp\s*[1-9]/.test(await text('#stats')), 'ramp count');
    assert.match(await text('#stats'), /Lands\s*13 \/ 37/);
    await p.selectOption('#dgroup', 'strategy');
    await until(async () => /Ramp\d/.test(await text('#deck')), 'strategy groups');
    await p.selectOption('#dgroup', 'type');
    await until(async () => /Top strategies[\s\S]*Lifegain/.test(await text('#stats')), 'lifegain among top strategies');
    await p.click('#stats .theme a:text-is("Lifegain")');  // filters the deck list
    await until(async () => /Lifegain: 3 cards/.test(await text('#deckfilter')), 'deck filter');
    assert.deepEqual((await p.$$eval('#deck li .n', ns => ns.map(n => n.textContent))).sort(), ['Daxos, Blessed by the Sun', 'Heliod, Sun-Crowned', 'Soul Warden']);
    await p.click('#deckfilter button:text-is("Find more")');
    await until(async () => /otag:lifegain/.test(await text('#full')), 'strategy search');
    await p.click('#deckfilter button:text-is("Show all")');
    await until(async () => (await p.$$('#deck li')).length > 10, 'filter cleared');
    await p.click('#tabs button[data-view=search]');
    await until(async () => /two-card combos \d/.test(await text('#stats')), 'combo count');
  });

  await step('quick add, undo', async () => {
    await p.fill('#quick', 'swords to plowshares');
    await p.press('#quick', 'Enter');
    await until(async () => (await text('#count')) === '26', 'added');
    await p.click('#histbox summary');
    await p.click('#undo');
    await until(async () => (await text('#count')) === '25', 'undone');
  });

  await step('copy unowned', async () => {
    await p.click('#exportmissing');
    const list = await clipboard();
    assert.doesNotMatch(list, /Sol Ring|Forest/);  // owned, basic
    assert.equal(list, '');  // every other card in the deck is in the fixture collection
  });

  await step('partner and background', async () => {
    await p.click('#newdeck');
    await p.fill('#quick', 'Wilson, Refined Grizzly');
    await p.press('#quick', 'Enter');
    await hoverClick(p.locator('#deck li', { hasText: 'Wilson' }), 'button[title="Make commander"]', 'make commander');
    await until(async () => (await p.textContent('#findpartner')) === 'Find background', 'find background button');
    await p.click('#findpartner');
    await until(async () => (await p.$$('#other .card')).length > 0, 'backgrounds');
    await hoverClick(p.locator('#other .card').first(), '.acts button:has-text("Background")', 'set background');
    await until(async () => (await text('#cmdtitle')) === 'Commanders', 'two commanders');
    assert.equal(await p.isVisible('#findpartner'), false);
    await p.locator('#cmdbox .cmd').nth(1).locator('button').click();  // remove the background again
    await until(async () => (await text('#cmdtitle')) === 'Commander', 'background removed');
    assert.equal(await p.isVisible('#findpartner'), true);
  });

  await step('fit check: pasted cards, combos, swaps', async () => {
    await p.selectOption('#decks', "Gishath, Sun's Avatar");
    await p.click('#tabs button[data-view=fit]');
    await p.fill('#fitnames', 'Pantlaza, Sun-Favored\nRings of Brighthearth\nSword Coast Sailor\nLightning Bolt');
    await p.click('#fitgo');
    await until(async () => /pasted cards: 4 cards/.test(await text('#fitstatus')), 'fit results');
    const rows = await p.$$eval('.fit', rs => rs.map(r => r.textContent));
    assert.ok(rows.some(r => r.includes('Pantlaza') && r.includes('synergy')), 'Pantlaza fits Gishath');
    assert.ok(rows.some(r => r.includes('Rings of Brighthearth') && r.includes('completes')), 'Rings completes the Basalt Monolith combo');
    assert.ok(rows.some(r => r.includes('Sword Coast Sailor') && r.includes('can be its background')), 'Sword Coast Sailor as a background for Wilson');
    const chip = p.locator('.fit', { hasText: 'Pantlaza' }).locator('.chip').first();
    const cut = await chip.locator('select').inputValue();
    await chip.locator('button', { hasText: 'Swap for' }).click();
    await until(async () => /swapped/.test(await chip.textContent()), 'swap');
    assert.doesNotMatch(await text('#deck'), new RegExp(cut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(await text('#deck'), /Pantlaza/);
  });

  await step('fit check from a deck row', async () => {
    await hoverClick(p.locator('#deck li', { hasText: 'Sol Ring' }), 'button[title="Which decks does this fit?"]', 'fit button');
    await until(async () => /Sol Ring: 1 cards/.test(await text('#fitstatus')), 'single card fit');
  });

  await step('tune: cuts, upgrades, combos', async () => {
    await p.click('#tabs button[data-view=tune]');
    await until(async () => (await p.$$('#cuts li')).length > 0, 'cut candidates');
    await until(async () => /In the deck \(\d+\)[\s\S]*One card away \(\d+/.test(await text('#combos')), 'combos');
  });

  await step('playtest', async () => {
    await p.click('#tabs button[data-view=play]');
    await until(async () => /2–4 lands/.test(await text('#odds')), 'odds');
    assert.equal((await p.$$('#hand .card')).length, 7);
    await p.click('#drawone');
    assert.equal((await p.$$('#hand .card')).length, 8);
    await p.click('#mulligan');
    assert.match(await text('#handinfo'), /mulligan 1/);
  });

  await step('collection: shopping list', async () => {
    await p.click('#tabs button[data-view=coll]');
    await until(async () => /cards, about \$/.test(await text('#shop')), 'shopping list');
  });

  await step('new set alert', async () => {
    await until(async () => /Test Set.*\d+ cards? fit your decks/.test(await text('#alerts')), 'set alert count', 120000);
    await p.locator('.alert button', { hasText: 'Review' }).click();
    await until(async () => /set LCI: \d+ cards/.test(await text('#fitstatus')), 'set review', 120000);
    await until(async () => !/Test Set/.test(await text('#alerts')), 'alert cleared');
  });

  await step('phone layout', async () => {
    await p.setViewportSize({ width: 390, height: 844 });
    assert.equal(await p.isVisible('#side'), false);
    await p.click('#tabs button[data-view=deck]');
    assert.equal(await p.isVisible('#side'), true);
    assert.equal(await p.isVisible('#v-search'), false);
    const width = await p.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 390, `page is ${width}px wide`);
    await p.click('#tabs button[data-view=search]');
    assert.equal(await p.isVisible('#side'), false);
  });

  assert.deepEqual(errors, [], 'page errors');
  await browser.close();
  console.log('all passed');
})().catch(e => { console.error('\n' + (e.stack || e)); process.exit(1); });
