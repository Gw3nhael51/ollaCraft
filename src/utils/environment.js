const { Vec3 } = require('vec3');

function scanEnvironment(bot, radius) {
  const blocks = {};
  const botPosition = bot.entity.position.floored();

  for (let x = -radius; x <= radius; x++) {
    for (let y = -radius; y <= radius; y++) {
      for (let z = -radius; z <= radius; z++) {
        const targetPos = botPosition.offset(x, y, z);
        const block = bot.blockAt(targetPos);
        if (block && block.name !== 'air' && block.name !== 'cave_air') {
          blocks[block.name] = (blocks[block.name] || 0) + 1;
        }
      }
    }
  }
  return blocks;
}

function checkTerrainSituation(bot) {
  const pos = bot.entity.position.floored();
  const directions = [
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1)
  ];

  let solidSides = 0;
  for (const dir of directions) {
    const feetBlock = bot.blockAt(pos.plus(dir));
    const headBlock = bot.blockAt(pos.plus(dir).offset(0, 1, 0));
    if (feetBlock?.boundingBox === 'block' && headBlock?.boundingBox === 'block') {
      solidSides++;
    }
  }

  if (solidSides >= 3) {
    return "Bloqué dans un trou ou un fossé étroit. Action recommandée : unstuck.";
  }
  return "Terrain libre.";
}

module.exports = { scanEnvironment, checkTerrainSituation };
