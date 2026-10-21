# Ink Ribbon: Item Box

Optional add-on module for the **Ink Ribbon** Foundry VTT system (v0.7.0+). It is not part of the Ink Ribbon rules.

- **Safe Room:** part of the system since v0.7.0. The GM opens or closes it from the Horror bar (top of the screen); this module shows the Item Box while it's open.
- **Item Box:** one box shared by the whole party, like Resident Evil's. While a Safe Room is open, every survivor's Inventory tab shows it: drag items in to stash them, click or drag them out to take them. Stacks of the same gear merge; moving a stack asks how many.
- **GM:** the Horror bar's **Box** button opens the box any time (Give items, drag rows onto a survivor's grid, edit or delete).

Every change to the box is made by the GM's client, so a GM must be online.

## Install
- Foundry / The Forge: install from the manifest URL `https://github.com/conrad251125/ink-ribbon-itembox/releases/latest/download/module.json`, then enable it in the world.
- After installing (or updating `module.json`), fully restart Foundry so the Item Box actor type is registered.

Upgrading from Ink Ribbon system v0.4 (where the box was built in): the old box's contents are moved into the module's box automatically the first time the GM loads the world with this module enabled.
