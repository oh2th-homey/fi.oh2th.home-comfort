'use strict';

const { localDate, localTime, updateCapabilities } = require('oh2th-homey-helpers');
const mainDevice = require('../main-device');
const waterUse = require('../../lib/water-use');
const { outOfOrder } = require('../../lib/capabilities');

const TODAY = 'meter_water.today';
const MONTH = 'meter_water.month';
const FLOW = 'measure_water';
const LAST_USE = 'text_last_use';
const COST_TODAY = 'measure_monetary.today';
const COST_MONTH = 'measure_monetary.month';
const COST_TITLES = { [COST_TODAY]: { en: 'Water cost today' }, [COST_MONTH]: { en: 'Water cost this month' } };
// A "Last use was …" button labels the use going on, or the last one when it ended at most this long ago.
const LABEL_WINDOW_MS = 15 * 60 * 1000;
// Per water use category (and Unknown): litres and cost today and this month, e.g. meter_water.shower_today.
const categoryCaps = (category) => ({
  today: `meter_water.${category}_today`,
  month: `meter_water.${category}_month`,
  costToday: `measure_monetary.${category}_today`,
  costMonth: `measure_monetary.${category}_month`
});
const labelButton = (category) => `button.${category}`;

/**
 * Water Monitor (issue #37): the house water meter's litres and cost today and this month, and its flow cut into uses
 * (lib/water-use.js). Read only. The costs come from its settings Water price and Base fee, in the Home Controller's
 * currency.
 */
module.exports = class waterMonitorDevice extends mainDevice {
  async onInitDevice() {
    this.sourceListeners = {};
    this.totals = this.getStoreValue('totals') || null;
    this.meterLast = this.getStoreValue('meterLast');
    this.flowLast = null;
    this.use = null;
    this.dirty = false;
    await this.resetGuesses();
    await this.renameTapToSink();
    await this.refreshMeter();
    await this.subscribeSources();
  }

  /**
   * @description Meters picked before the flow capability was stored (flowCap) are checked again, so a meter with
   * measure_water_flow gets its flow without a repair.
   */
  async refreshMeter() {
    const meter = this.getStoreValue('meter');
    if (!meter || meter.flowCap !== undefined) return;
    try {
      const checked = await this.driver.checkMeter({ id: meter.id });
      this.log(`${this.getName()} - refreshMeter - ${checked.name}: meter ${checked.meter}, flow ${checked.flowCap}`);
      await this.setStoreValue('meter', checked);
    } catch (error) {
      this.error(`${this.getName()} - refreshMeter - ${error}`);
    }
  }

  /**
   * @description Once: categories used to be guessed from fixed patterns. Their litres go back to Unknown, and only the
   * labelled uses of today and this month are counted in their categories again.
   */
  async resetGuesses() {
    if (this.getStoreValue('categoryRule') === 'learned') return;
    if (this.totals) {
      let totals = { ...this.totals, cats: {} };
      for (const label of this.getStoreValue('labels') || []) {
        if (waterUse.monthOf(this.date(label.end)) !== totals.month) continue;
        const date = this.date(label.end);
        const sums = totals.cats[label.category] || { todayL: 0, monthL: 0 };
        totals = { ...totals, cats: { ...totals.cats, [label.category]: { todayL: sums.todayL + (date === totals.date ? label.litres : 0), monthL: sums.monthL + label.litres } } };
      }
      this.totals = totals;
      await this.setStoreValue('totals', this.totals).catch(this.error);
    }
    const last = this.getStoreValue('lastUse');
    if (last && !last.labelled && last.category) await this.setStoreValue('lastUse', { ...last, category: waterUse.UNKNOWN }).catch(this.error);
    await this.setStoreValue('categoryRule', 'learned').catch(this.error);
    this.log(`${this.getName()} - resetGuesses - guessed categories back to Unknown`);
  }

  /**
   * @description Once: the category tap was renamed sink (its capabilities too; the old ones are removed by
   * checkCapabilities): the chosen categories, totals, last use, uses and samples follow.
   */
  async renameTapToSink() {
    const chosen = this.getStoreValue('categories') || [];
    if (!chosen.includes('tap')) return;
    const rename = (item) => (item && item.category === 'tap' ? { ...item, category: 'sink' } : item);
    await this.setStoreValue('categories', chosen.map((category) => (category === 'tap' ? 'sink' : category)));
    if (this.totals && this.totals.cats && this.totals.cats.tap) {
      const { tap, ...cats } = this.totals.cats;
      this.totals = { ...this.totals, cats: { ...cats, sink: tap } };
      await this.setStoreValue('totals', this.totals).catch(this.error);
    }
    await this.setStoreValue('lastUse', rename(this.getStoreValue('lastUse'))).catch(this.error);
    for (const key of ['uses', 'labels']) await this.setStoreValue(key, (this.getStoreValue(key) || []).map(rename)).catch(this.error);
    this.log(`${this.getName()} - renameTapToSink - done`);
  }

  async onDeleted() {
    this.unsubscribeSources();
    await super.onDeleted();
  }

  async onUninit() {
    this.unsubscribeSources();
    await this.save();
    await super.onUninit();
  }

  meter() {
    return this.getStoreValue('meter') || {};
  }

  /**
   * @description The water use categories chosen at pairing or repair (lib/water-use.js CATEGORIES).
   */
  categories() {
    return waterUse.chosenCategories(this.getStoreValue('categories'));
  }

  /**
   * @description The categories shown: the chosen ones and Unknown, or none when none is chosen (uses need a flow).
   */
  shownCategories() {
    const chosen = this.meter().flow ? this.categories() : [];
    return chosen.length ? [...chosen, waterUse.UNKNOWN] : [];
  }

  categoryTitle(category) {
    return this.homey.__(`monitor.category.${category}`);
  }

  hasCosts() {
    return this.price() !== null || this.baseFee() !== null;
  }

  /**
   * @description The manifest's capabilities, the costs with a water price or base fee, the flow and Last use with a flow
   * source, litres (and costs) per chosen category, and the Last use was buttons, in this order: Homey shows them in
   * the order they were added and they can't be moved there, so ones that would come out of order are added again.
   */
  async checkCapabilities() {
    const capabilities = [...(this.driver.manifest.capabilities || [])];
    if (this.hasCosts()) capabilities.push(COST_TODAY, COST_MONTH);
    if (this.meter().flow) capabilities.push(FLOW, LAST_USE);
    for (const category of this.shownCategories()) {
      const caps = categoryCaps(category);
      capabilities.push(caps.today, caps.month);
      if (this.hasCosts()) capabilities.push(caps.costToday, caps.costMonth);
    }
    // "Last use was …" buttons for the chosen categories.
    if (this.meter().flow) capabilities.push(...this.categories().map(labelButton));
    const reorder = outOfOrder(this.getCapabilities(), capabilities);
    if (reorder.length) this.log(`${this.getName()} - checkCapabilities - adding again in order: ${reorder.join(', ')}`);
    for (const cap of reorder) await this.removeCapability(cap).catch(this.error);
    const result = await updateCapabilities(this, capabilities, this.getCapabilities());
    if (result.added.includes(FLOW)) await this.setCapabilityOptions(FLOW, { title: { en: 'Flow' }, units: { en: 'l/min' }, decimals: 1 }).catch(this.error);
    // Titles of the category tiles and buttons: set when added, and again when a category was renamed.
    for (const category of this.shownCategories()) {
      const caps = categoryCaps(category);
      const title = this.categoryTitle(category);
      await this.setTitle(caps.today, { title: { en: `${title} today` }, units: { en: 'l' }, decimals: 0 }, result.added);
      await this.setTitle(caps.month, { title: { en: `${title} this month` }, units: { en: 'm³' }, decimals: 2 }, result.added);
    }
    for (const category of this.categories()) {
      const title = this.homey.__('monitor.last_use_was', { category: this.categoryTitle(category) });
      await this.setTitle(labelButton(category), { title: { en: title } }, result.added);
    }
    if (result.added.some((cap) => cap.startsWith('measure_monetary.'))) await this.applyCurrency();
    await this.setCapabilityListeners();
    return result;
  }

  /**
   * @description A capability's options when it was just added or its title differs (a renamed category).
   * setCapabilityOptions replaces the options: pass them all.
   */
  async setTitle(cap, options, added) {
    let current = null;
    try {
      current = this.getCapabilityOptions(cap);
    } catch (error) {
      current = null;
    }
    const title = current && current.title && typeof current.title === 'object' ? current.title.en : current && current.title;
    if (!added.includes(cap) && title === options.title.en) return;
    await this.setCapabilityOptions(cap, options).catch(this.error);
  }

  /**
   * @description Listeners of the "Last use was …" buttons the device has, each registered once.
   */
  async setCapabilityListeners() {
    this.buttonListeners = this.buttonListeners || new Set();
    for (const category of waterUse.CATEGORIES) {
      const button = labelButton(category);
      if (!this.hasCapability(button) || this.buttonListeners.has(button)) continue;
      this.registerCapabilityListener(button, () => this.onLabel(category));
      this.buttonListeners.add(button);
    }
  }

  /**
   * @description "Last use was <category>": the use going on gets the category when it ends; the last use (ended at
   * most LABEL_WINDOW_MS ago) is moved to it, its litres with it. Pressed again, it moves again. The use's latest label
   * is kept as a sample for learning, with the category it was first guessed as.
   */
  async onLabel(category) {
    const at = Date.now();
    this.log(`${this.getName()} - onLabel - ${category}`);
    if (this.use && this.use.confirmed) {
      this.pendingLabel = { start: this.use.start, category };
      // Shown at once in Last use; counted when the use ends.
      await this.showLastUse(at);
      return;
    }
    const last = this.getStoreValue('lastUse');
    if (!last || at - last.end > LABEL_WINDOW_MS) throw new Error(this.homey.__('monitor.no_recent_use'));
    const from = last.category || waterUse.UNKNOWN;
    this.totals = waterUse.moveCategory(waterUse.rollover(this.totals, this.date(at)), this.date(last.end), from, category, last.litres);
    this.dirty = true;
    // The same category as it was assigned by its pattern: a confirmation, the litres stay.
    if (category === from) this.log(`${this.getName()} - onLabel - confirmed ${category}`);
    const labelled = { ...last, category, labelled: true, auto: false };
    await this.setStoreValue('lastUse', labelled).catch(this.error);
    const uses = (this.getStoreValue('uses') || []).map((use) => (use.start === last.start ? labelled : use));
    await this.setStoreValue('uses', uses).catch(this.error);
    await this.keepLabel(labelled, last.guessed || from);
    await this.show(at);
  }

  /**
   * @description The ticked categories for the Last use was flow card, filtered by the typed text.
   */
  categoryChoices(query) {
    const text = String(query || '').toLowerCase();
    return this.categories()
      .map((id) => ({ id, name: this.categoryTitle(id) }))
      .filter((choice) => choice.name.toLowerCase().includes(text));
  }

  /**
   * @description Flow action Last use was <category>, e.g. from a button next to the shower: as the device's button.
   */
  async onAction_WATER_LAST_USE_WAS(category) {
    if (!this.categories().includes(category)) throw new Error(this.homey.__('monitor.not_ticked'));
    await this.onLabel(category);
  }

  /**
   * @description A learning sample (lib/water-use.js keepSample): a labelled use, or one its pattern assigned, with what
   * it was guessed as. A relabel replaces the use's sample, so a wrong assignment stops teaching its category.
   */
  async keepLabel(use, guessed) {
    await this.setStoreValue('labels', waterUse.keepSample(this.getStoreValue('labels'), { ...use, guessed })).catch(this.error);
  }

  /**
   * @description The title of a cost capability: the house's (Water cost today) or a category's (Shower cost today).
   */
  costTitle(cap) {
    if (COST_TITLES[cap]) return COST_TITLES[cap];
    const [, key] = cap.split('.');
    const month = key.endsWith('_month');
    const title = this.categoryTitle(key.replace(/_(today|month)$/, ''));
    return { en: `${title} cost ${month ? 'this month' : 'today'}` };
  }

  /**
   * @description The cost capabilities' unit: the Home Controller's currency.
   */
  async applyCurrency() {
    const controller = this.homey.app.findController();
    const units = { en: controller ? controller.currency() : '€' };
    for (const cap of this.getCapabilities().filter((id) => id.startsWith('measure_monetary.'))) {
      // setCapabilityOptions replaces the options: pass title and decimals too.
      await this.setCapabilityOptions(cap, { title: this.costTitle(cap), units, decimals: 2 }).catch(this.error);
    }
  }

  /**
   * @description A positive number setting, null when 0 or not set.
   */
  positiveSetting(key) {
    const value = Number(this.getSetting(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /**
   * @description The water price per m³ (setting Water price), null when not set.
   */
  price() {
    return this.positiveSetting('water_price');
  }

  /**
   * @description The water bill's fixed fee per month (setting Base fee), null when not set.
   */
  baseFee() {
    return this.positiveSetting('base_fee');
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log(`${this.getName()} - onSettings - changed: ${changedKeys}`);
    // Settings are saved after this returns: show or hide the costs then.
    if (changedKeys.includes('water_price') || changedKeys.includes('base_fee')) this.setTimer('costs', () => this.onCostSettings(), 500);
  }

  async onCostSettings() {
    await this.checkCapabilities();
    await this.applyCurrency();
    await this.show(Date.now());
  }

  async onReady() {
    // The Home Controller's currency may have changed meanwhile.
    await this.applyCurrency();
    await this.show(Date.now());
  }

  /**
   * Sources: the water meter's meter_water and flow (measure_water or measure_water_flow), chosen at pairing or repair.
   */
  sources() {
    const { id, name, meter, flow, flowCap } = this.meter();
    if (!id) return [];
    const list = [];
    if (meter) list.push({ key: 'meter', id, name, cap: 'meter_water' });
    if (flow) list.push({ key: 'flow', id, name, cap: flowCap || FLOW });
    return list;
  }

  async subscribeSources() {
    for (const source of this.sources()) {
      if (this.sourceListeners[source.key]) continue;
      const listener = () => this.onSource(source.key).catch(this.error);
      try {
        await this.homey.app.members.subscribe(source.id, source.cap, listener);
        this.sourceListeners[source.key] = { id: source.id, cap: source.cap, listener };
        // The current reading: the meter's starting point, the flow shown.
        await this.onSource(source.key);
      } catch (error) {
        // Retried from onInterval, e.g. when the meter's app starts later.
        this.error(`${this.getName()} - subscribeSources - ${source.key} - ${error}`);
      }
    }
  }

  unsubscribeSources() {
    for (const { id, cap, listener } of Object.values(this.sourceListeners || {})) this.homey.app.members.unsubscribe(id, cap, listener);
    this.sourceListeners = {};
  }

  read(key) {
    const source = this.sourceListeners[key];
    const reading = source ? this.homey.app.members.read(source.id, source.cap) : null;
    if (!reading || !reading.available || typeof reading.value !== 'number' || !Number.isFinite(reading.value)) return null;
    return reading.value;
  }

  date(ms) {
    return localDate(this.homey.clock.getTimezone(), ms);
  }

  async onSource(key) {
    const at = Date.now();
    if (key === 'meter') {
      const step = waterUse.meterStep(this.meterLast, this.read('meter'));
      if (step.last !== this.meterLast) {
        this.meterLast = step.last;
        this.dirty = true;
      }
      if (step.litres > 0) await this.addLitres(at, step.litres);
      await this.confirmUse(at);
    } else if (key === 'flow') {
      const flow = this.read('flow');
      // Without meter_water the litres come from the flow.
      if (!this.meter().meter) await this.integrateFlow(at, flow);
      await this.setValue(FLOW, flow === null ? null : Math.round(flow * 10) / 10);
      const step = waterUse.useStep(this.use, at, flow);
      this.use = step.use;
      if (step.ended) await this.onUseEnded(step.ended);
      // The use counts once the meter reading confirms it; a flow-only meter can't, its uses count at once.
      if (step.started) await this.confirmUse(at, !this.meter().meter);
      // The flow stopped: the use ends after the gap, also without another reading.
      if (this.use && this.use.zeroSince === at) this.setTimer('useEnd', () => this.checkUseEnd(), waterUse.END_GAP_MS + 1000);
      await this.showLastUse(at);
    }
  }

  async integrateFlow(at, flow) {
    const step = waterUse.flowStep(this.flowLast, at, flow);
    this.flowLast = step.last;
    if (step.litres > 0) await this.addLitres(at, step.litres);
  }

  async addLitres(at, litres) {
    this.totals = waterUse.addLitres(this.totals, this.date(at), litres);
    this.dirty = true;
    await this.showTotals();
  }

  async checkUseEnd(at = Date.now()) {
    const check = waterUse.checkEnd(this.use, at);
    this.use = check.use;
    if (check.ended) await this.onUseEnded(check.ended);
    await this.showLastUse(at);
  }

  /**
   * @description Confirm the running use by the meter reading (lib/water-use.js confirmUse); Water use started runs then.
   */
  async confirmUse(at, confirmNow = false) {
    if (!this.use) return;
    const result = waterUse.confirmUse(this.use, this.meterLast, confirmNow);
    this.use = result.use;
    if (!result.confirmed) return;
    await this.triggerFlow('water_use_started', { flow: Math.round(this.use.peak * 10) / 10 });
    await this.showLastUse(at);
  }

  async onUseEnded(ended) {
    // A flow the meter reading never confirmed: no water passed. Kept apart to follow how often it happens.
    if (!ended.confirmed) {
      this.log(`${this.getName()} - flow without water: ${ended.litres.toFixed(1)} l by the flow in ${Math.round((ended.end - ended.start) / 1000)} s, not a use`);
      await this.setStoreValue('ghosts', waterUse.keepUse(this.getStoreValue('ghosts'), ended)).catch(this.error);
      return;
    }
    const minutes = Math.round(((ended.end - ended.start) / 60000) * 10) / 10;
    const litres = Math.round(ended.litres * 10) / 10;
    const cost = waterUse.cost(ended.litres, this.price());
    // Its category: the one learned pattern that fits it, else Unknown until a button labels it.
    const chosen = this.categories();
    const guessed = chosen.length ? waterUse.classify(ended, waterUse.learnPatterns(this.getStoreValue('labels'), chosen)) : null;
    // Labelled with a button while it ran.
    const label = this.pendingLabel && this.pendingLabel.start === ended.start ? this.pendingLabel.category : null;
    this.pendingLabel = null;
    const category = label || guessed;
    this.log(`${this.getName()} - use ended: ${category || 'use'} ${litres} l in ${minutes} min, peak ${ended.peak.toFixed(1)} l/min`);
    if (category && category !== waterUse.UNKNOWN) {
      this.totals = waterUse.addCategory(this.totals, this.date(ended.end), category, ended.litres);
      this.dirty = true;
      await this.showTotals();
    }
    const auto = !label && !!category && category !== waterUse.UNKNOWN;
    const last = { ...ended, cost, category, guessed, ...(label ? { labelled: true } : {}), ...(auto ? { auto: true } : {}) };
    await this.setStoreValue('lastUse', last).catch(this.error);
    await this.setStoreValue('uses', waterUse.keepUse(this.getStoreValue('uses'), last)).catch(this.error);
    // A labelled use teaches its category; so does one its pattern assigned, until a button moves it elsewhere.
    if (label || auto) await this.keepLabel(last, guessed);
    await this.triggerFlow('water_use_ended', {
      litres,
      minutes,
      flow: Math.round(ended.average * 10) / 10,
      cost: cost === null ? 0 : Math.round(cost * 100) / 100,
      category: category ? this.categoryTitle(category) : ''
    });
  }

  /**
   * @description Every minute: the day and month roll over, a use without readings ends, a constant flow is counted
   * (without meter_water), and the totals are saved.
   */
  async onInterval(now) {
    const at = now.getTime();
    if (localTime(this, now).minutes % 5 === 0) await this.subscribeSources();
    if (!this.meter().meter && this.flowLast) await this.integrateFlow(at, this.flowLast.flow);
    if (this.use) await this.checkUseEnd(at);
    const rolled = waterUse.rollover(this.totals, this.date(at));
    if (!this.totals || rolled.date !== this.totals.date) {
      this.totals = rolled;
      this.dirty = true;
    }
    await this.save();
    await this.show(at);
  }

  /**
   * @description The totals and the meter's last reading are saved together, so a restart counts what came in between.
   */
  async save() {
    if (!this.dirty) return;
    this.dirty = false;
    await this.setStoreValue('totals', this.totals).catch(this.error);
    await this.setStoreValue('meterLast', this.meterLast).catch(this.error);
  }

  async show(at) {
    await this.showTotals();
    await this.showLastUse(at);
  }

  async showTotals() {
    const totals = this.totals || { todayL: 0, monthL: 0 };
    await this.setValue(TODAY, Math.round(totals.todayL));
    await this.setValue(MONTH, Math.round(totals.monthL) / 1000);
    if (this.hasCapability(COST_TODAY)) {
      // The litres at the water price, plus the base fee's share of the days so far.
      const price = this.price();
      const fee = waterUse.baseFee(this.baseFee(), this.totals ? this.totals.date : this.date(Date.now()));
      const round = (value) => Math.round(value * 100) / 100;
      await this.setValue(COST_TODAY, round((waterUse.cost(totals.todayL, price) ?? 0) + (fee ? fee.today : 0)));
      await this.setValue(COST_MONTH, round((waterUse.cost(totals.monthL, price) ?? 0) + (fee ? fee.month : 0)));
    }
    // Per category: litres, and the litres at the water price (the base fee stays in the house's cost).
    const shown = this.shownCategories();
    if (!shown.length) return;
    const sums = waterUse.categoryTotals(this.totals, this.categories());
    for (const category of shown) {
      const caps = categoryCaps(category);
      const { todayL, monthL } = sums[category];
      await this.setValue(caps.today, Math.round(todayL));
      await this.setValue(caps.month, Math.round(monthL) / 1000);
      if (this.hasCapability(caps.costToday)) {
        await this.setValue(caps.costToday, Math.round((waterUse.cost(todayL, this.price()) ?? 0) * 100) / 100);
        await this.setValue(caps.costMonth, Math.round((waterUse.cost(monthL, this.price()) ?? 0) * 100) / 100);
      }
    }
  }

  /**
   * @description Last use: the use going on, or the last finished one; – before the first.
   */
  async showLastUse(at) {
    if (!this.hasCapability(LAST_USE)) return;
    await this.setValue(LAST_USE, this.lastUseText(at));
  }

  lastUseText(at) {
    const time = (ms) => localTime(this, new Date(ms)).time;
    if (this.use && this.use.confirmed) {
      const { use } = this;
      // The flow stopped: shown as finished at once, though it ends (and is counted) only after the gap, in case the
      // water runs again.
      const text = Number.isFinite(use.zeroSince)
        ? this.homey.__('monitor.last_use.ended', { start: time(use.start), end: time(use.zeroSince), litres: use.litres < 10 ? use.litres.toFixed(1) : String(Math.round(use.litres)), flow: (use.litres / Math.max(1 / 60, (use.zeroSince - use.start) / 60000)).toFixed(1) })
        : this.homey.__('monitor.last_use.running', { start: time(use.start), litres: Math.round(waterUse.runningLitres(use, at)) });
      // Labelled while it runs: the category shows at once.
      const label = this.pendingLabel && this.pendingLabel.start === this.use.start ? this.pendingLabel.category : null;
      return label ? `${this.categoryTitle(label)} ${Number.isFinite(use.zeroSince) ? text : `${text.charAt(0).toLowerCase()}${text.slice(1)}`}` : text;
    }
    const last = this.getStoreValue('lastUse');
    if (!last) return this.homey.__('water.start.none');
    const litres = last.litres < 10 ? last.litres.toFixed(1) : String(Math.round(last.litres));
    let text = this.homey.__('monitor.last_use.ended', { start: time(last.start), end: time(last.end), litres, flow: last.average.toFixed(1) });
    if (last.category) text = `${this.categoryTitle(last.category)} ${text}`;
    return this.date(last.start) === this.date(at) ? text : `${this.date(last.start)} ${text}`;
  }

  /**
   * @description The totals, the running use and the recent uses, for GET /water.
   */
  learningState() {
    return {
      id: this.getData().id,
      name: this.getName(),
      driver: 'water-monitor',
      meter: this.meter(),
      categories: this.categories(),
      sources: Object.keys(this.sourceListeners || {}),
      totals: this.totals,
      meterLast: this.meterLast,
      price: this.price(),
      baseFee: this.baseFee(),
      use: this.use,
      uses: this.getStoreValue('uses') || [],
      ghosts: this.getStoreValue('ghosts') || [],
      labels: this.getStoreValue('labels') || []
    };
  }

  /**
   * @description Repair: the water meter and the categories. A meter's reading is a new starting point; today's and the
   * month's litres stay, also per category (a category no longer chosen counts in Unknown).
   */
  async onRepairMeter(meter, categories) {
    this.log(`${this.getName()} - onRepairMeter - ${meter.name}: meter ${meter.meter}, flow ${meter.flow}, categories ${categories.join(', ') || 'none'}`);
    await this.setStoreValue('categories', categories);
    // The same meter keeps its starting point and the use going on: only the categories changed.
    if (meter.id !== this.meter().id || meter.flowCap !== this.meter().flowCap) {
      this.unsubscribeSources();
      this.clearTimer('useEnd');
      this.use = null;
      this.flowLast = null;
      this.meterLast = null;
      this.dirty = true;
    }
    await this.setStoreValue('meter', meter);
    await this.checkCapabilities();
    await this.applyCurrency();
    await this.subscribeSources();
    await this.save();
    await this.show(Date.now());
    return true;
  }
};
