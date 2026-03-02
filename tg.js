#!/usr/bin/env node
import { Telegraf, Markup } from 'telegraf'
import mineflayer from 'mineflayer'
import dotenv from 'dotenv'
import express from 'express'  // 👈 ЭТА СТРОКА ОТСУТСТВУЕТ!

dotenv.config()

const tgBot = new Telegraf(process.env.BOT_TOKEN)
let mcBot = null
let currentWindow = null
let ownerId = null

const app = express()
const PORT = process.env.PORT || 3000

app.get('/', (req, res) => res.send('🤖 Mineflayer TG Bot на Render'))
app.get('/health', (req, res) => res.status(200).send('alive ✅'))

app.listen(PORT, () => {
  console.log(`✅ Healthcheck сервер запущен на порту ${PORT}`)
})

// Основная клавиатура
const mainKeyboard = Markup.keyboard([
  ['🚀 Подключить', '⛔ Отключить'],
  ['📍 Позиция', '❤️ Здоровье'],
  ['⬆️ Вперёд', '⬅️ Влево', '➡️ Вправо', '⬇️ Назад'],
  ['⤴️ Прыжок', '📦 Обновить окно']
]).resize()

tgBot.start(async (ctx) => {
  ownerId = ctx.from.id
  await ctx.reply('🤖 <b>Mineflayer Telegram Control</b>\n\nПиши сообщения — они идут в Minecraft чат!', { parse_mode: 'HTML', ...mainKeyboard })
})

// Подключение
tgBot.hears('🚀 Подключить', (ctx) => {
  if (mcBot) return ctx.reply('❌ Бот уже запущен')
  ctx.reply('Напиши:\n<code>connect localhost 25565 WebBot</code>', { parse_mode: 'HTML' })
})

tgBot.on('text', async (ctx) => {
  if (ctx.from.id !== ownerId) return
  const text = ctx.message.text.trim()

  if (text.startsWith('connect ')) {
    const [, host = 'localhost', portStr = '25565', ...nameParts] = text.split(/\s+/)
    const port = parseInt(portStr) || 25565
    const username = nameParts.join(' ') || `WebBot${Math.floor(Math.random() * 1000)}`
    startMCBot(ctx, host, port, username)
  } 
  else if (mcBot && !text.startsWith('connect') && !['🚀 Подключить', '⛔ Отключить', '📍 Позиция', '❤️ Здоровье', '📦 Обновить окно'].includes(text)) {
    mcBot.chat(text)
    ctx.reply(`→ ${text}`)
  }
})

async function startMCBot(ctx, host, port, username) {
  ctx.reply(`🚀 Запуск <b>${username}</b> на ${host}:${port}...`, { parse_mode: 'HTML' })

  mcBot = mineflayer.createBot({
    host,
    port,
    username,
    version: false,
    skipValidation: true,
    connectTimeout: 30000
  })

  // Автопринятие ресурс-пака
  mcBot.on('resourcePack', (url) => {
    ctx.reply(`📦 Авто-принятие ресурс-пака: ${url}`)
    mcBot.acceptResourcePack()
  })
  mcBot.on('resourcePackSend', (url) => {
    ctx.reply(`📦 Авто-принятие (resourcePackSend): ${url}`)
    mcBot.acceptResourcePack()
  })

  mcBot.once('spawn', () => {
    ctx.reply(`✅ <b>${mcBot.username}</b> заспавнился!`, mainKeyboard)
  })

  mcBot.on('chat', (username, message) => {
    if (username === mcBot.username) return
    ctx.reply(`💬 <b>${username}:</b> ${message}`, { parse_mode: 'HTML' })
  })

  mcBot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString().trim()
    if (text) ctx.reply(`📢 [сервер] ${text}`)
  })

  mcBot.on('windowOpen', (window) => {
    currentWindow = window
    sendWindow(ctx, window)
  })

  mcBot.on('windowClose', () => {
    currentWindow = null
    ctx.reply('🗄️ Окно закрыто')
  })

  mcBot.on('kicked', (reason) => ctx.reply(`🚪 Кикнут: ${reason || 'неизвестно'}`))
  mcBot.on('error', (err) => ctx.reply(`❌ Ошибка: ${err.message}`))
  mcBot.on('end', () => {
    ctx.reply('🔌 Соединение закрыто')
    mcBot = null
  })
}

// Движение
const moveMap = {
  '⬆️ Вперёд': 'forward',
  '⬇️ Назад': 'back',
  '⬅️ Влево': 'left',
  '➡️ Вправо': 'right',
  '⤴️ Прыжок': 'jump'
}

Object.entries(moveMap).forEach(([btnText, control]) => {
  tgBot.hears(btnText, (ctx) => {
    if (!mcBot) return ctx.reply('❌ Бот не запущен')
    mcBot.setControlState(control, true)
    setTimeout(() => mcBot.setControlState(control, false), control === 'jump' ? 130 : 400)
    ctx.reply(`➡️ ${btnText}`)
  })
})

// Статус
tgBot.hears('📍 Позиция', (ctx) => {
  if (!mcBot?.entity) return ctx.reply('❌ Бот не в игре')
  const p = mcBot.entity.position
  ctx.reply(`📍 x:${p.x.toFixed(1)} y:${p.y.toFixed(1)} z:${p.z.toFixed(1)}`)
})

tgBot.hears('❤️ Здоровье', (ctx) => {
  if (!mcBot) return ctx.reply('❌ Бот не в игре')
  ctx.reply(`❤️ Здоровье: ${mcBot.health.toFixed(1)}`)
})

// Окно
tgBot.hears('📦 Обновить окно', (ctx) => {
  if (currentWindow) sendWindow(ctx, currentWindow)
  else ctx.reply('🗄️ Нет открытого окна')
})

tgBot.hears('⛔ Отключить', (ctx) => {
  if (mcBot) {
    mcBot.quit()
    mcBot = null
    ctx.reply('⛔ Бот отключён')
  } else ctx.reply('Бот не запущен')
})

// Отправка окна (ЛКМ + ПКМ)
async function sendWindow(ctx, window) {
  const title = window.title?.toString() || 'Меню'
  const rows = []
  let row = []

  window.slots.forEach((item, i) => {
    const name = item 
      ? `${item.displayName || item.name} ${item.count > 1 ? 'x' + item.count : ''}`.slice(0, 18)
      : 'пусто'
    
    row.push(Markup.button.callback(`[${i}] ${name}`, `click_${i}_0`))   // ЛКМ
    row.push(Markup.button.callback('ПКМ', `click_${i}_1`))               // ПКМ

    if (row.length === 6) {   // удобный размер
      rows.push(row)
      row = []
    }
  })
  if (row.length) rows.push(row)

  await ctx.reply(`🗃️ <b>${title}</b>`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(rows)
  })
}

// Обработка кликов по слотам
tgBot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data
  if (!data.startsWith('click_')) return

  const [, slot, button] = data.split('_').map(Number)
  if (mcBot && currentWindow) {
    try {
      mcBot.clickWindow(slot, button, 0)
      await ctx.answerCbQuery(`✅ Клик: слот ${slot} (${button ? 'ПКМ' : 'ЛКМ'})`)
      
      // автообновление окна
      setTimeout(() => {
        if (currentWindow) sendWindow(ctx, currentWindow)
      }, 300)
    } catch (e) {
      await ctx.answerCbQuery('❌ Ошибка клика')
    }
  }
})

tgBot.launch()
console.log(`
╔════════════════════════════════════════════╗
║   Mineflayer Telegram Control запущен!     ║
║   → Открой бота и нажми /start             ║
╚════════════════════════════════════════════╝
`)
