/**
 * Equipment management module for armor, shields, and weapons
 */

const ARMOR_PRIORITY = {
  head: ['diamond_helmet', 'iron_helmet', 'golden_helmet', 'leather_helmet'],
  torso: ['diamond_chestplate', 'iron_chestplate', 'golden_chestplate', 'leather_chestplate'],
  legs: ['diamond_leggings', 'iron_leggings', 'golden_leggings', 'leather_leggings'],
  feet: ['diamond_boots', 'iron_boots', 'golden_boots', 'leather_boots']
};

const ARMOR_SLOT_IDS = {
  head: 5,
  torso: 6,
  legs: 7,
  feet: 8
};

/**
 * Find best inventory item matching an armor destination slot without downgrading
 * @param {object} bot Mineflayer bot instance
 * @param {string} slot Destination armor slot ('head', 'torso', 'legs', 'feet')
 * @returns {object|null} Best matching armor item or null
 */
function getBestArmorForSlot(bot, slot) {
  const priorityList = ARMOR_PRIORITY[slot];
  if (!priorityList) return null;

  const slotId = ARMOR_SLOT_IDS[slot];
  const currentlyWorn = slotId ? bot.inventory.slots[slotId] : null;
  const currentTierIndex = currentlyWorn ? priorityList.indexOf(currentlyWorn.name) : -1;

  const inventoryItems = bot.inventory.items();
  for (let i = 0; i < priorityList.length; i++) {
    // Skip candidate if currently worn piece is equal or higher tier
    if (currentTierIndex !== -1 && currentTierIndex <= i) {
      return null;
    }

    const candidateName = priorityList[i];
    const item = inventoryItems.find(invItem => invItem.name === candidateName);
    if (item) return item;
  }

  return null;
}

/**
 * Equip all best available armor pieces and off-hand shield
 * @param {object} bot Mineflayer bot instance
 * @returns {Promise<string[]>} Array of equipped item names
 */
async function autoEquipArmorAndShield(bot) {
  const equipped = [];
  const slots = ['head', 'torso', 'legs', 'feet'];

  // Equip best available upgrade for each armor slot
  const equipResults = await Promise.all(slots.map(async slot => {
    const bestItem = getBestArmorForSlot(bot, slot);
    if (bestItem) {
      try {
        await bot.equip(bestItem, slot);
        return bestItem.name;
      } catch {
        // Tolerate equipment error if rejected by server
      }
    }
    return null;
  }));

  equipped.push(...equipResults.filter(Boolean));

  // Equip shield to off-hand if not already holding one
  const currentOffHand = bot.inventory.slots[45];
  if (currentOffHand?.name !== 'shield') {
    const shieldItem = bot.inventory.items().find(i => i.name === 'shield');
    if (shieldItem) {
      try {
        await bot.equip(shieldItem, 'off-hand');
        equipped.push('shield');
      } catch {
        // Tolerate equipment error if off-hand is already occupied
      }
    }
  }

  return equipped;
}

/**
 * Handle manual or AI-requested equip action
 * @param {object} bot Mineflayer bot instance
 * @param {string} target Target item or category to equip
 * @returns {Promise<{ success: boolean, message: string }>} Result of the equipment operation
 */
async function skillEquip(bot, target) {
  if (!target || target === 'all' || target === 'armor') {
    const equipped = await autoEquipArmorAndShield(bot);
    if (equipped.length === 0) {
      return { success: true, message: "No better armor or shield found to equip." };
    }
    return { success: true, message: `Successfully equipped: ${equipped.join(', ')}.` };
  }

  // Confirm immediately if shield is already held in off-hand slot
  const cleanTarget = target.toLowerCase().trim();
  if (cleanTarget === 'shield' && bot.inventory.slots[45]?.name === 'shield') {
    return { success: true, message: "Shield is already equipped in off-hand." };
  }

  // Confirm immediately if requested armor piece is already worn
  const wornArmorSlots = [5, 6, 7, 8];
  const alreadyWorn = wornArmorSlots.map(id => bot.inventory.slots[id]).find(s => s?.name.toLowerCase().includes(cleanTarget));
  if (alreadyWorn) {
    return { success: true, message: `'${alreadyWorn.name}' is already equipped.` };
  }

  const item = bot.inventory.items().find(i => i.name.toLowerCase().includes(cleanTarget));
  if (!item) {
    return { success: false, message: `No item matching '${target}' in inventory.` };
  }

  let destination = 'hand';
  if (item.name === 'shield') destination = 'off-hand';
  else if (item.name.endsWith('_helmet')) destination = 'head';
  else if (item.name.endsWith('_chestplate')) destination = 'torso';
  else if (item.name.endsWith('_leggings')) destination = 'legs';
  else if (item.name.endsWith('_boots')) destination = 'feet';

  try {
    await bot.equip(item, destination);
    return { success: true, message: `Equipped ${item.name} to ${destination}.` };
  } catch (err) {
    return { success: false, message: `Failed to equip ${item.name}: ${err.message}` };
  }
}

module.exports = {
  skillEquip,
  autoEquipArmorAndShield,
  getBestArmorForSlot
};
