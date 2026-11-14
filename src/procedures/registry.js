const { createResult } = require('../actions/primitives/result');
const { gotoCoordinates, jump } = require('../actions/primitives/movement');
const { breakBlockAt, placeBlockOnFace } = require('../actions/primitives/blocks');
const { equipItem, consumeItem, craftRecipe, dropItem } = require('../actions/primitives/items');
const { openContainer, depositItem, withdrawItem, closeContainer } = require('../actions/primitives/container');
const { attackEntity, followEntity } = require('../actions/primitives/combat');

/**
 * Registry holding all authorized procedure actions and mapping them to executable functions
 */
class ActionRegistry {
  constructor() {
    this.actions = new Map();
  }

  /**
   * Register a new executable action in the registry
   * @param {object} actionDefinition Action specification object
   * @param {string} actionDefinition.id Unique action identifier
   * @param {string} actionDefinition.description Action operational description
   * @param {Function} actionDefinition.handler Async execution handler
   * @param {object} [actionDefinition.parametersSchema={}] Required and optional parameters schema
   * @param {number} [actionDefinition.defaultTimeoutMs=10000] Default execution timeout in milliseconds
   */
  register(actionDefinition) {
    if (!actionDefinition || typeof actionDefinition.id !== 'string') {
      throw new Error("Action definition must provide a valid 'id' string");
    }
    if (typeof actionDefinition.handler !== 'function') {
      throw new Error(`Action '${actionDefinition.id}' must provide an executable handler function`);
    }

    this.actions.set(actionDefinition.id, {
      id: actionDefinition.id,
      description: actionDefinition.description || '',
      handler: actionDefinition.handler,
      parametersSchema: actionDefinition.parametersSchema || {},
      outputSchema: actionDefinition.outputSchema || null,
      defaultTimeoutMs: actionDefinition.defaultTimeoutMs || 10000
    });
  }

  /**
   * Retrieve registered action definition by id
   * @param {string} actionId Unique action identifier
   * @returns {object|null} Registered action specification
   */
  get(actionId) {
    return this.actions.get(actionId) || null;
  }

  /**
   * Check whether an action identifier exists in the registry
   * @param {string} actionId Action identifier
   * @returns {boolean} True if registered
   */
  has(actionId) {
    return this.actions.has(actionId);
  }

  /**
   * Return array of all registered action descriptors
   * @returns {object[]} Array of registered action specifications
   */
  list() {
    return Array.from(this.actions.values());
  }
}

/**
 * Instantiate and populate an action registry with standard Mineflayer primitives
 * @returns {ActionRegistry} Fully configured action registry
 */
function createDefaultRegistry() {
  const registry = new ActionRegistry();

  registry.register({
    id: 'goto_coordinates',
    description: 'Navigate bot towards world coordinates (x, y, z)',
    parametersSchema: {
      required: ['x', 'y', 'z'],
      optional: ['range', 'timeoutMs'],
      types: {
        x: 'number',
        y: 'number',
        z: 'number',
        range: 'number',
        timeoutMs: 'number'
      },
      allowAdditionalProperties: false
    },
    outputSchema: {
      position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
      distance: { type: 'number' }
    },
    defaultTimeoutMs: 30000,
    handler: async (bot, params, context = {}) => {
      const { x, y, z, range, timeoutMs } = params;
      return await gotoCoordinates(bot, Number(x), Number(y), Number(z), {
        range: range !== undefined ? Number(range) : 1,
        timeoutMs: timeoutMs || context.timeoutMs,
        abortSignal: context.abortSignal
      });
    }
  });

  registry.register({
    id: 'jump',
    description: 'Execute physical jump with apex detection',
    parametersSchema: {
      optional: ['durationMs', 'waitForApex', 'timeoutMs'],
      types: {
        durationMs: 'number',
        waitForApex: 'boolean',
        timeoutMs: 'number'
      },
      allowAdditionalProperties: false
    },
    outputSchema: {
      initialY: { type: 'number' },
      peakY: { type: 'number' },
      heightGained: { type: 'number' }
    },
    defaultTimeoutMs: 2000,
    handler: async (bot, params = {}, context = {}) => {
      return await jump(bot, {
        durationMs: params.durationMs,
        waitForApex: params.waitForApex !== undefined ? Boolean(params.waitForApex) : false,
        timeoutMs: params.timeoutMs || context.timeoutMs,
        abortSignal: context.abortSignal
      });
    }
  });

  registry.register({
    id: 'break_block',
    description: 'Mine and break world block at given coordinates',
    parametersSchema: {
      required: ['position'],
      optional: ['maxDistance', 'timeoutMs'],
      types: {
        position: 'object',
        maxDistance: 'number',
        timeoutMs: 'number'
      },
      allowAdditionalProperties: false
    },
    outputSchema: {
      position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
      blockName: { type: 'string' }
    },
    defaultTimeoutMs: 15000,
    handler: async (bot, params, context = {}) => {
      return await breakBlockAt(bot, params.position, {
        maxDistance: params.maxDistance,
        timeoutMs: params.timeoutMs || context.timeoutMs,
        abortSignal: context.abortSignal
      });
    }
  });

  registry.register({
    id: 'place_block',
    description: 'Place an item from inventory against a reference block face',
    parametersSchema: {
      required: ['itemName', 'referencePosition', 'faceVector'],
      optional: ['maxDistance', 'timeoutMs'],
      types: {
        itemName: 'string',
        referencePosition: 'object',
        faceVector: 'object',
        maxDistance: 'number',
        timeoutMs: 'number'
      },
      allowAdditionalProperties: false
    },
    outputSchema: {
      position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
      blockName: { type: 'string' }
    },
    defaultTimeoutMs: 10000,
    handler: async (bot, params, context = {}) => {
      return await placeBlockOnFace(bot, params.itemName, params.referencePosition, params.faceVector, {
        maxDistance: params.maxDistance,
        timeoutMs: params.timeoutMs || context.timeoutMs,
        abortSignal: context.abortSignal
      });
    }
  });

  registry.register({
    id: 'equip_item',
    description: 'Equip inventory item into target equipment slot',
    parametersSchema: {
      required: ['itemName'],
      optional: ['destination', 'timeoutMs'],
      types: {
        itemName: 'string',
        destination: 'string',
        timeoutMs: 'number'
      },
      allowAdditionalProperties: false
    },
    outputSchema: {
      itemName: { type: 'string' },
      destination: { type: 'string' }
    },
    defaultTimeoutMs: 5000,
    handler: async (bot, params, context = {}) => {
      return await equipItem(bot, params.itemName, params.destination || 'hand', {
        timeoutMs: params.timeoutMs || context.timeoutMs,
        abortSignal: context.abortSignal
      });
    }
  });

  registry.register({
    id: 'consume_item',
    description: 'Eat food or drink beverage from inventory',
    parametersSchema: {
      required: ['itemName'],
      optional: ['timeoutMs'],
      types: {
        itemName: 'string',
        timeoutMs: 'number'
      },
      allowAdditionalProperties: false
    },
    outputSchema: {
      itemName: { type: 'string' },
      consumedCount: { type: 'number' },
      food: { type: 'number' },
      health: { type: 'number' }
    },
    defaultTimeoutMs: 8000,
    handler: async (bot, params, context = {}) => {
      return await consumeItem(bot, params.itemName, {
        timeoutMs: params.timeoutMs || context.timeoutMs,
        abortSignal: context.abortSignal
      });
    }
  });

  registry.register({
    id: 'craft_recipe',
    description: 'Craft recipe via player grid or nearby crafting table',
    parametersSchema: {
      required: ['recipe'],
      optional: ['count', 'tableBlock', 'timeoutMs'],
      types: {
        recipe: ['string', 'object'],
        count: 'number',
        tableBlock: 'object',
        timeoutMs: 'number'
      },
      allowAdditionalProperties: false
    },
    outputSchema: {
      item: { type: 'string' },
      count: { type: 'number' },
      gainedCount: { type: 'number' },
      expectedCount: { type: 'number' }
    },
    defaultTimeoutMs: 10000,
    handler: async (bot, params, context = {}) => {
      let recipeObj = params.recipe;
      if (typeof recipeObj === 'string') {
        const mcData = bot.registry || require('minecraft-data')(bot.version || '1.20.4');
        const itemDef = mcData?.itemsByName?.[recipeObj];
        if (itemDef) {
          const recipes = bot.recipesFor ? bot.recipesFor(itemDef.id, null, params.count || 1, params.tableBlock) : [];
          recipeObj = recipes[0] || { result: { id: itemDef.id, count: 1 } };
        }
      }

      return await craftRecipe(bot, recipeObj, params.count || 1, params.tableBlock || null, {
        timeoutMs: params.timeoutMs || context.timeoutMs,
        abortSignal: context.abortSignal
      });
    }
  });

  registry.register({
    id: 'drop_item',
    description: 'Drop specific quantity of inventory items on the ground',
    parametersSchema: {
      required: ['itemName'],
      optional: ['count', 'timeoutMs'],
      types: {
        itemName: 'string',
        count: 'number',
        timeoutMs: 'number'
      },
      allowAdditionalProperties: false
    },
    outputSchema: {
      itemName: { type: 'string' },
      droppedCount: { type: 'number' }
    },
    defaultTimeoutMs: 5000,
    handler: async (bot, params, context = {}) => {
      return await dropItem(bot, params.itemName, params.count || 1, {
        timeoutMs: params.timeoutMs || context.timeoutMs,
        abortSignal: context.abortSignal
      });
    }
  });

  registry.register({
    id: 'open_container',
    description: 'Open a chest, barrel, or furnace container block',
    parametersSchema: {
      required: ['containerBlock'],
      optional: ['timeoutMs'],
      types: {
        containerBlock: 'object',
        timeoutMs: 'number'
      },
      allowAdditionalProperties: false
    },
    outputSchema: {
      window: { type: 'object' },
      containerType: { type: 'string' },
      position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } }
    },
    defaultTimeoutMs: 8000,
    handler: async (bot, params, context = {}) => {
      return await openContainer(bot, params.containerBlock, {
        timeoutMs: params.timeoutMs || context.timeoutMs,
        abortSignal: context.abortSignal
      });
    }
  });

  registry.register({
    id: 'deposit_item',
    description: 'Deposit items from inventory into open container window',
    parametersSchema: {
      required: ['containerWindow', 'itemName'],
      optional: ['count', 'timeoutMs'],
      types: {
        containerWindow: 'object',
        itemName: 'string',
        count: 'number',
        timeoutMs: 'number'
      },
      allowAdditionalProperties: false
    },
    outputSchema: {
      itemName: { type: 'string' },
      depositedCount: { type: 'number' }
    },
    defaultTimeoutMs: 8000,
    handler: async (bot, params, context = {}) => {
      return await depositItem(bot, params.containerWindow, params.itemName, params.count || 1, {
        timeoutMs: params.timeoutMs || context.timeoutMs,
        abortSignal: context.abortSignal
      });
    }
  });

  registry.register({
    id: 'withdraw_item',
    description: 'Withdraw items from container into player inventory',
    parametersSchema: {
      required: ['containerWindow', 'itemName'],
      optional: ['count', 'timeoutMs'],
      types: {
        containerWindow: 'object',
        itemName: 'string',
        count: 'number',
        timeoutMs: 'number'
      },
      allowAdditionalProperties: false
    },
    outputSchema: {
      itemName: { type: 'string' },
      withdrawnCount: { type: 'number' }
    },
    defaultTimeoutMs: 8000,
    handler: async (bot, params, context = {}) => {
      return await withdrawItem(bot, params.containerWindow, params.itemName, params.count || 1, {
        timeoutMs: params.timeoutMs || context.timeoutMs,
        abortSignal: context.abortSignal
      });
    }
  });

  registry.register({
    id: 'close_container',
    description: 'Close currently open container window',
    parametersSchema: {
      optional: ['containerWindow'],
      types: {
        containerWindow: 'object'
      },
      allowAdditionalProperties: false
    },
    outputSchema: {},
    defaultTimeoutMs: 3000,
    handler: async (bot, params = {}) => {
      return await closeContainer(bot, params.containerWindow || null);
    }
  });

  registry.register({
    id: 'attack_entity',
    description: 'Strike target entity with weapon and range verification',
    parametersSchema: {
      required: ['targetEntity'],
      optional: ['maxDistance', 'autoEquipWeapon', 'timeoutMs'],
      types: {
        targetEntity: 'object',
        maxDistance: 'number',
        autoEquipWeapon: 'boolean',
        timeoutMs: 'number'
      },
      allowAdditionalProperties: false
    },
    outputSchema: {
      entityId: { type: ['number', 'string'] },
      targetEliminated: { type: 'boolean' },
      damageDealt: { type: 'number' },
      remainingHealth: { type: 'number' }
    },
    defaultTimeoutMs: 5000,
    handler: async (bot, params, context = {}) => {
      return await attackEntity(bot, params.targetEntity, {
        maxDistance: params.maxDistance,
        autoEquipWeapon: params.autoEquipWeapon,
        timeoutMs: params.timeoutMs || context.timeoutMs,
        abortSignal: context.abortSignal
      });
    }
  });

  registry.register({
    id: 'follow_entity',
    description: 'Follow target entity dynamically maintaining designated range',
    parametersSchema: {
      required: ['targetEntity'],
      optional: ['range', 'timeoutMs'],
      types: {
        targetEntity: 'object',
        range: 'number',
        timeoutMs: 'number'
      },
      allowAdditionalProperties: false
    },
    outputSchema: {
      entityId: { type: ['number', 'string'] },
      distance: { type: 'number' },
      range: { type: 'number' }
    },
    defaultTimeoutMs: 30000,
    handler: async (bot, params, context = {}) => {
      return await followEntity(bot, params.targetEntity, {
        range: params.range,
        timeoutMs: params.timeoutMs || context.timeoutMs,
        abortSignal: context.abortSignal
      });
    }
  });

  registry.register({
    id: 'find_block',
    description: 'Search nearby world for block matching target name',
    parametersSchema: {
      required: ['block'],
      optional: ['maxDistance'],
      types: {
        block: 'string',
        maxDistance: 'number'
      },
      allowAdditionalProperties: false
    },
    outputSchema: {
      block: { type: 'string' },
      position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } }
    },
    defaultTimeoutMs: 5000,
    handler: async (bot, params) => {
      const blockName = params.block;
      const maxDistance = params.maxDistance || 32;

      if (!bot.findBlock) {
        return createResult(false, 'error', null, 'Bot cannot inspect world blocks');
      }

      const mcData = bot.registry || require('minecraft-data')(bot.version || '1.20.4');
      const targetId = mcData?.blocksByName?.[blockName]?.id;

      const found = bot.findBlock({
        matching: (b) => b && (b.name === blockName || b.type === targetId),
        maxDistance
      });

      if (!found) {
        return createResult(false, 'not_found', { block: blockName }, `Block '${blockName}' was not found within range`);
      }

      return createResult(true, 'found', {
        block: found.name,
        position: { x: found.position.x, y: found.position.y, z: found.position.z }
      }, null);
    }
  });

  return registry;
}

module.exports = {
  ActionRegistry,
  createDefaultRegistry
};
