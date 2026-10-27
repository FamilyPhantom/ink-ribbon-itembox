/**
 * Ink Ribbon: Item Box (optional add-on module for the Ink Ribbon system).
 *
 * - The Safe Room itself is part of the Ink Ribbon system (v0.7.0+, Horror bar > Safe Room).
 * - While a Safe Room is open, every survivor's Inventory tab shows the shared Item Box
 *   (Resident Evil style): drag items in to stash them, click or drag them out to take them.
 * - Outside a Safe Room only the GM can open the box (Horror bar > Box).
 *
 * Only the GM's client changes the box: players send requests over the module socket.
 * Uses the system's add-on API: game.inkRibbon.inventory, the "inkRibbon.renderHorrorBar" hook,
 * and Foundry's "renderInkCharacterSheet" hook.
 */

const MOD = "ink-ribbon-itembox";
const TYPE = `${MOD}.storage`;                     // module-defined Actor sub-type
const SOCKET = `module.${MOD}`;
const { HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;
const inv = () => game.inkRibbon?.inventory;

export const getItemBox = () => game.actors.find(a => a.type === TYPE);
/** The Safe Room is a system rule (Ink Ribbon v0.7.0+): read it from the system. */
export const isSafeRoomOpen = () => !!game.inkRibbon?.safeRoom?.isOpen();
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* -------------------------------------------- */
/*  Data model + box creation                   */
/* -------------------------------------------- */

class StorageData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return { notes: new foundry.data.fields.StringField({ required: true, blank: true, initial: "" }) };
  }
}

/** True once Foundry has loaded this module's Actor type (needs a world relaunch after install). */
function installed() {
  const ok = game.documentTypes?.Actor?.includes(TYPE);
  if (!ok && game.user.isGM) ui.notifications.error(
    "Item Box: Foundry hasn't registered the Item Box actor type yet. Fully close Foundry, start it again and relaunch the world.",
    { permanent: true });
  return ok;
}

export async function ensureItemBox() {
  if (!installed()) return null;
  return getItemBox() ?? Actor.create({ name: "Safe Room Item Box", type: TYPE, img: "icons/svg/chest.svg" });
}

/* -------------------------------------------- */
/*  Moving items                                */
/* -------------------------------------------- */

/** Fresh item data with its inventory position cleared (or set to `placement`). */
function cleanData(item, quantity, placement = null) {
  const data = item.toObject();
  delete data._id;
  foundry.utils.mergeObject(data, { "system.quick": false, "system.inv": { x: -1, y: -1, rot: false } });
  if (data.type === "armour") data.system.equipped = false;
  if (data.type === "gear") data.system.ready = false;
  if (quantity !== undefined) data.system.quantity = quantity;
  if (placement?.zone === "worn") data.system.equipped = true;
  else if (placement) for (const [k, v] of Object.entries(inv().placementUpdate(placement))) foundry.utils.setProperty(data, k, v);
  return data;
}

const qtyText = (item, n) => (item.type === "gear" && n !== 1 ? ` x${n}` : "");
const whisperFor = actor => game.users.filter(u => u.isGM || actor?.testUserPermission(u, "OWNER")).map(u => u.id);
const boxCard = (actor, text) => ChatMessage.create({
  speaker: { alias: "Item Box" }, whisper: whisperFor(actor),
  content: `<div class="ir-card"><h3>Item Box</h3><p>${text}</p></div>`
});

/** Ask how many of a stack to move (gear with quantity > 1). Returns null if cancelled. */
async function askQuantity(item, verb) {
  const max = item.system.quantity;
  if (item.type !== "gear" || max <= 1) return item.type === "gear" ? max : undefined;
  const result = await DialogV2.prompt({
    window: { title: `${verb} ${item.name}` },
    content: `<div class="form-group"><label>How many? (max ${max})</label>
      <input type="number" name="qty" value="${max}" min="1" max="${max}" autofocus></div>`,
    ok: { label: verb, callback: (event, button) => Number(button.form.elements.qty.value) },
    rejectClose: false
  });
  return result ? Math.clamp(result, 1, max) : null;
}

/** Ask the active GM's client to do something (or do it now if we are the GM). */
function request(data, run) {
  if (game.user.isGM) return run(data);
  if (!game.users.activeGM) return ui.notifications.warn("The GM needs to be online to use the Item Box.");
  game.socket.emit(SOCKET, data);
}

/** Put a survivor's item into the box. */
export async function storeItem(item) {
  if (!item?.parent) return;
  if (!isSafeRoomOpen()) return ui.notifications.warn("You can only use the Item Box in a Safe Room.");
  const quantity = await askQuantity(item, "Store");
  if (quantity === null) return;
  return request({ action: "store", actorUuid: item.parent.uuid, itemId: item.id, quantity, userId: game.user.id }, gmStore);
}

async function gmStore({ actorUuid, itemId, quantity, userId }) {
  const requester = game.users.get(userId);
  if (!requester?.isGM && !isSafeRoomOpen()) return;
  const actor = await fromUuid(actorUuid);
  const item = actor?.items.get(itemId);
  if (!item || (!requester?.isGM && !actor.testUserPermission(requester, "OWNER"))) return;
  const box = await ensureItemBox();
  if (!box) return;
  const isGear = item.type === "gear";
  const n = isGear ? Math.clamp(quantity ?? item.system.quantity, 1, item.system.quantity) : undefined;

  const stack = isGear && box.items.find(i => i.type === "gear" && i.name === item.name);   // same-name gear stacks
  if (stack) await stack.update({ "system.quantity": stack.system.quantity + n });
  else await box.createEmbeddedDocuments("Item", [cleanData(item, n)]);
  if (isGear && n < item.system.quantity) await item.update({ "system.quantity": item.system.quantity - n });
  else await item.delete();
  return boxCard(actor, `<b>${esc(actor.name)}</b> stored <b>${esc(item.name)}${qtyText(item, n ?? 1)}</b>.`);
}

/** A survivor (or the GM) takes an item out while a Safe Room is open. */
export async function takeItem(item, actor, placement = null) {
  if (!item || !actor) return;
  if (!isSafeRoomOpen() && !game.user.isGM) return ui.notifications.warn("You can only use the Item Box in a Safe Room.");
  const quantity = await askQuantity(item, "Take");
  if (quantity === null) return;
  return request({ action: "take", boxItemId: item.id, actorUuid: actor.uuid, quantity, placement, userId: game.user.id }, gmTake);
}

async function gmTake({ boxItemId, actorUuid, quantity, placement, userId }) {
  const requester = game.users.get(userId);
  if (!requester?.isGM && !isSafeRoomOpen()) return;
  const actor = await fromUuid(actorUuid);
  const item = getItemBox()?.items.get(boxItemId);
  if (!actor || !item) return;                                // someone else may have just taken it
  if (!requester?.isGM && !actor.testUserPermission(requester, "OWNER")) return;
  if (item.type === "gear") quantity = Math.clamp(quantity ?? item.system.quantity, 1, item.system.quantity);
  if (placement?.zone === "worn")                              // wearing one armour takes the others off
    await actor.updateEmbeddedDocuments("Item", actor.items.filter(i => i.type === "armour" && i.system.equipped)
      .map(i => ({ _id: i.id, "system.equipped": false, "system.inv.x": -1 })));
  await actor.createEmbeddedDocuments("Item", [cleanData(item, quantity, placement)]);
  if (item.type === "gear" && quantity < item.system.quantity) await item.update({ "system.quantity": item.system.quantity - quantity });
  else await item.delete();
  return boxCard(actor, `<b>${esc(actor.name)}</b> takes <b>${esc(item.name)}${qtyText(item, quantity ?? 1)}</b> out of the Item Box.`);
}

/**
 * A survivor's item was dropped on the GM's Item Box sheet. Foundry's default would copy it
 * (create in the box, leave the original), so route it through gmStore, which moves it.
 * Returns true if handled. Items from the sidebar or a compendium still use the default (a new item).
 */
const PACKABLE = ["weapon", "armour", "gear"];
function storeFromSheet(item, box) {
  if (!(item?.parent instanceof Actor) || item.parent === box) return false;
  if (!game.user.isGM) return true;
  if (!PACKABLE.includes(item.type)) { ui.notifications.warn("Only weapons, armour and gear go in the Item Box."); return true; }
  (async () => {
    const quantity = await askQuantity(item, "Store");
    if (quantity === null) return;
    await gmStore({ actorUuid: item.parent.uuid, itemId: item.id, quantity, userId: game.user.id });
  })();
  return true;
}

/** GM: hand an item to a survivor from the box sheet (any time, Safe Room or not). */
async function giveItem(item, actor, placement = null) {
  if (!game.user.isGM || !item || !actor) return;
  const quantity = await askQuantity(item, "Give");
  if (quantity === null) return;
  return gmTake({ boxItemId: item.id, actorUuid: actor.uuid, quantity, placement, userId: game.user.id });
}


/* -------------------------------------------- */
/*  GM sheet for the box                        */
/* -------------------------------------------- */

class ItemBoxSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["ink-ribbon", "sheet", "actor", "storage"],
    position: { width: 560, height: 640 },
    window: { resizable: true },
    form: { submitOnChange: true },
    actions: {
      give: ItemBoxSheet.#onGive,
      editItem: ItemBoxSheet.#onEdit,
      deleteItem: ItemBoxSheet.#onDelete
    }
  };
  static PARTS = { sheet: { template: `modules/${MOD}/templates/storage.hbs`, scrollable: [".ir-body"] } };

  async _prepareContext(options) {
    const ctx = await super._prepareContext(options);
    const actor = this.document;
    ctx.actor = actor;
    ctx.system = actor.system;
    ctx.safeRoom = isSafeRoomOpen();
    ctx.characters = game.actors.filter(a => a.type === "character").map(a => ({ id: a.id, name: a.name }));
    const groups = { weapon: "Weapons", gear: "Ammo & Gear", armour: "Armour" };
    const sections = {};
    for (const t of inv()?.itemTiles(actor.items) ?? []) (sections[groups[t.type] ?? "Other"] ??= []).push(t);
    ctx.sections = Object.entries(sections).map(([label, rows]) => ({ label, rows }));
    ctx.count = actor.items.size;
    return ctx;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    // Drag a row onto a survivor's grid to hand it over (a move, not a copy).
    for (const row of this.element.querySelectorAll("tr[data-item-id]")) {
      row.draggable = true;
      row.addEventListener("dragstart", ev => {
        const item = this.document.items.get(row.dataset.itemId);
        inv().drag.current = { foreign: true, item, onDrop: (sheet, placement) => giveItem(item, sheet.document, placement) };
        ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "InkBoxItem", id: item.id }));
        ev.stopPropagation();
      });
      row.addEventListener("dragend", () => { inv().drag.current = null; });
    }
  }

  _item(target) { return this.document.items.get(target.closest("[data-item-id]")?.dataset.itemId); }

  /** Backup for the dropActorSheetData hook below: dropping a survivor's item here moves it. */
  async _onDropItem(event, item) {
    const doc = item instanceof foundry.abstract.Document ? item : await Item.implementation.fromDropData(item);
    if (storeFromSheet(doc, this.document)) return null;
    return super._onDropItem(event, item);
  }

  static #onGive(event, target) {
    const actor = game.actors.get(target.closest("[data-item-id]").querySelector("select.give-to")?.value);
    if (!actor) return ui.notifications.warn("Pick a survivor to give it to.");
    giveItem(this._item(target), actor);
  }
  static #onEdit(event, target) { this._item(target)?.sheet.render(true); }
  static #onDelete(event, target) { const i = this._item(target); i?.deleteDialog?.() ?? i?.delete(); }
}

/* -------------------------------------------- */
/*  Survivor sheet: Item Box panel + Store      */
/* -------------------------------------------- */

function panelHTML(box) {
  const tiles = (inv()?.itemTiles(box?.items ?? []) ?? []).map(t => `
    <div class="inv-tile box-tile ${t.type}" data-box-item-id="${t.id}" draggable="true" data-tooltip="${esc(t.name)}: click or drag to take">
      <img src="${esc(t.img)}" alt="">${t.badge ? `<span class="tile-badge">${esc(t.badge)}</span>` : ""}<span class="tile-name">${esc(t.name)}</span>
    </div>`).join("");
  return `<div class="inv-itembox open">
    <div class="box-head"><div class="box-lid"></div>
      <div class="box-text"><b>Item Box</b><small>Drag items here to stash them. Click or drag an item out to take it.</small></div></div>
    <div class="box-contents">${tiles || `<span class="hint">The box is empty.</span>`}</div>
  </div>`;
}

Hooks.on("renderInkCharacterSheet", (app, element) => {
  const el = element instanceof HTMLElement ? element : element?.[0];
  if (app.tab !== "inventory" || !app.isEditable || !isSafeRoomOpen() || !inv()) return;
  const side = el?.querySelector(".inv-side");
  if (!side) return;
  const actor = app.document;

  // Store button in the Examine panel.
  const exam = el.querySelector(".inv-examine[data-item-id]");
  const buttons = exam?.querySelector(".exam-buttons");
  if (buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Store";
    btn.dataset.tooltip = "Put it in the Safe Room Item Box";
    btn.addEventListener("click", () => {
      const item = actor.items.get(exam.dataset.itemId);
      if (item) { app.selectedItemId = null; storeItem(item); }
    });
    buttons.querySelector('[data-action="editItem"]')?.before(btn) ?? buttons.append(btn);
  }

  // The box panel, above the Add buttons.
  const box = getItemBox();
  side.querySelector(".inv-add")?.insertAdjacentHTML("beforebegin", panelHTML(box));
  const panel = side.querySelector(".inv-itembox");

  // Drop one of this survivor's items on the panel = store it.
  panel.addEventListener("dragover", ev => { ev.preventDefault(); ev.stopPropagation(); panel.classList.add("drop-hover"); });
  panel.addEventListener("dragleave", ev => { if (!panel.contains(ev.relatedTarget)) panel.classList.remove("drop-hover"); });
  panel.addEventListener("drop", async ev => {
    ev.preventDefault(); ev.stopPropagation();
    panel.classList.remove("drop-hover");
    if (inv().drag.current?.foreign) return;                   // dragging a box item back onto the box: nothing to do
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(ev);
    const item = data?.type === "Item" && data.uuid ? await fromUuid(data.uuid) : null;
    if (item?.parent !== actor) return ui.notifications.warn("Drag one of this survivor's items into the Item Box.");
    app.selectedItemId = null;
    storeItem(item);
  });

  // Box tiles: click = take into the first free spot; drag = take to a chosen spot.
  for (const tile of panel.querySelectorAll(".box-tile")) {
    const item = () => getItemBox()?.items.get(tile.dataset.boxItemId);
    tile.addEventListener("click", () => {
      const it = item();
      if (!it) return;
      if (it.system.size > 0 && !inv().resolveInventory(actor).grid.firstFitItem(it))
        return ui.notifications.warn(`No room in your inventory for ${it.name}.`);
      takeItem(it, actor);
    });
    tile.addEventListener("dragstart", ev => {
      const it = item();
      if (!it) return;
      inv().drag.current = { foreign: true, item: it, onDrop: (sheet, placement) => takeItem(it, sheet.document, placement) };
      // Not Foundry Item data on purpose: dropping it anywhere else must not copy the item.
      ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "InkBoxItem", id: it.id }));
      ev.dataTransfer.effectAllowed = "move";
      ev.stopPropagation();
      requestAnimationFrame(() => tile.classList.add("dragging"));
    });
    tile.addEventListener("dragend", () => {
      inv().drag.current = null;
      tile.classList.remove("dragging");
      app.clearDropHighlight?.();
    });
  }
});

// Dropping a survivor's item on the Item Box sheet: move it, don't copy it.
Hooks.on("dropActorSheetData", (actor, sheet, data) => {
  if (actor?.type !== TYPE || data?.type !== "Item" || !data.uuid) return;
  const item = fromUuidSync(data.uuid);
  if (storeFromSheet(item, actor)) return false;
});

/* -------------------------------------------- */
/*  Horror bar controls                         */
/* -------------------------------------------- */

// The system draws the Safe Room button; the module only adds the GM's Box button.
Hooks.on("inkRibbon.renderHorrorBar", el => {
  if (!game.user.isGM) return;
  el.insertAdjacentHTML("beforeend", `<a data-irbox="box" title="Open the Item Box">Box</a>`);
  el.querySelector('[data-irbox="box"]').addEventListener("click", async () => (await ensureItemBox())?.sheet.render(true));
});

// Safe Room opened or closed (system hook): make sure the box exists, refresh box sheets.
Hooks.on("inkRibbon.safeRoom", async open => {
  if (open && game.user === game.users.activeGM) await ensureItemBox();
  rerender();
});

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

/** Re-render open survivor sheets and box sheets (Safe Room toggled, box contents changed). */
function rerender() {
  for (const app of foundry.applications.instances?.values() ?? []) {
    if ((app.document?.type === "character" || app instanceof ItemBoxSheet) && app.rendered) app.render();
  }
}

/** The Item Box used to be part of the system (Actor type "storage", v0.4). Move its contents over. */
async function migrateSystemBox() {
  for (const id of [...(game.actors.invalidDocumentIds ?? [])]) {
    try {
      const src = game.actors.getInvalid(id, { strict: false })?._source;
      if (src?.type !== "storage") continue;
      const box = await ensureItemBox();
      if (!box) return;
      const items = (src.items ?? []).map(i => { const d = foundry.utils.deepClone(i); delete d._id; return d; });
      if (items.length) await box.createEmbeddedDocuments("Item", items);
      await Actor.implementation.deleteDocuments([id]);
      ui.notifications.info(`Item Box: moved ${items.length} item(s) from the old system Item Box.`);
    } catch (err) {
      console.warn(`${MOD} | Could not migrate the old Item Box actor ${id}`, err);
    }
  }
}

Hooks.once("init", () => {
  CONFIG.Actor.dataModels[TYPE] = StorageData;
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, MOD, ItemBoxSheet, { types: [TYPE], makeDefault: true, label: "Safe Room Item Box" });
});

Hooks.once("ready", async () => {
  if (!game.inkRibbon?.inventory || !game.inkRibbon?.safeRoom) return ui.notifications.warn("Ink Ribbon Item Box needs the Ink Ribbon system v0.7.0 or later.");
  game.socket.on(SOCKET, data => {
    if (game.user !== game.users.activeGM) return;              // only one GM answers
    if (data?.action === "store") gmStore(data);
    if (data?.action === "take") gmTake(data);
  });
  for (const hook of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(hook, item => { if (item.parent?.type === TYPE) rerender(); });
  }
  game.inkRibbon.itemBox = { getItemBox, storeItem, takeItem };
  game.inkRibbon.renderHorrorBar?.();                           // add our Horror bar buttons now
  if (game.user === game.users.activeGM) {
    installed();
    await migrateSystemBox();
  }
});
