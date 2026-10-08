const mineflayer = require('mineflayer')
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'TestBot' })
bot.on('spawn', () => {
  const item = bot.registry.itemsByName['wooden_pickaxe']
  bot.chat('/clear TestBot')
  setTimeout(() => { bot.chat('/give TestBot oak_planks 3'); bot.chat('/give TestBot stick 2'); }, 500)
  
  setTimeout(() => {
    const dummyTable = { name: 'crafting_table', type: bot.registry.blocksByName['crafting_table'].id }
    try {
      const r1 = bot.recipesFor(item.id, null, 1, null)
      console.log('Without table:', r1.length)
      const r2 = bot.recipesFor(item.id, null, 1, dummyTable)
      console.log('With dummy table:', r2.length)
    } catch(e) {
      console.log('Error:', e.message)
    }
    bot.quit()
    process.exit(0)
  }, 2000)
})
