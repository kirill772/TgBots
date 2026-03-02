#!/usr/bin/env node

import { createServer } from 'http'
import { Server } from 'socket.io'
import express from 'express'
import mineflayer from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'
import { mineflayer as viewer } from 'prismarine-viewer'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer)

const PORT = 3000
const VIEWER_PORT = 3001
const CONFIG_FILE = path.join(__dirname, 'bots-config.json')

let bots = new Map()
let botSettings = new Map()
let botWindows = new Map()
let viewers = new Map()
let autoJoinIntervals = new Map()
let botChatLogs = new Map() // Сохраняем историю чата для каждого бота

async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8')
    return JSON.parse(data)
  } catch {
    return { bots: [] }
  }
}

async function saveConfig() {
  const config = {
    bots: Array.from(botSettings.values()).map(s => ({
      id: s.id,
      name: s.name,
      host: s.host,
      port: s.port,
      version: s.version,
      username: s.username,
      password: s.password,
      autoJoin: s.autoJoin,
      interval: s.interval
    }))
  }
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2))
}

app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8')
  res.send(html)
})

app.use('/viewer', express.static(path.join(__dirname, 'node_modules/prismarine-viewer/public')))

app.get('/api/bots', async (req, res) => {
  const config = await loadConfig()
  res.json(config)
})

io.on('connection', socket => {
  console.log('✨ Новое подключение')

  socket.on('getBotsList', async () => {
    const config = await loadConfig()
    const botsList = config.bots.map(b => ({
      ...b,
      online: bots.has(b.id),
      health: bots.get(b.id)?.health || 0,
      food: bots.get(b.id)?.food || 0,
      position: bots.get(b.id)?.entity?.position || null,
      viewer: viewers.has(b.id),
      window: botWindows.has(b.id) ? {
        title: botWindows.get(b.id).title?.toString() || 'Меню',
        slots: getSlotsInfo(botWindows.get(b.id))
      } : null,
      chatLog: botChatLogs.get(b.id) || []
    }))
    socket.emit('botsList', botsList)
  })

  socket.on('connectBots', async (data) => {
    const count = parseInt(data.count) || 1
    
    for (let i = 0; i < count; i++) {
      const botId = Date.now().toString() + i
      const username = data.username + (count > 1 ? (i + 1) : '')
      
      try {
        console.log(`🔌 Подключение бота ${username} к ${data.host}:${data.port}`)
        
        const bot = mineflayer.createBot({
          host: data.host || 'localhost',
          port: parseInt(data.port) || 25565,
          username: username,
          version: data.version || false,
          skipValidation: true,
          connectTimeout: 30000,
          auth: 'offline' // ВАЖНО: используем оффлайн режим для пиратки
        })

        // Инициализируем чат лог для бота
        botChatLogs.set(botId, [])

        // Автопринятие ресурс-паков
        bot.on('resourcePack', (url, hash) => {
          console.log(`[${username}] Принятие ресурс-пака: ${url}`)
          bot.acceptResourcePack()
          addToChatLog(botId, 'Система', `📦 Принят ресурс-пак`)
        })

        bot.on('resourcePackSend', (url, hash) => {
          console.log(`[${username}] Принятие ресурс-пака: ${url}`)
          bot.acceptResourcePack()
          addToChatLog(botId, 'Система', `📦 Принят ресурс-пак`)
        })

        bot.loadPlugin(pathfinder)

        const settings = {
          id: botId,
          name: username,
          host: data.host,
          port: data.port,
          version: data.version,
          username: username,
          password: data.password,
          autoJoin: data.autoJoin,
          interval: data.interval,
          createdAt: new Date().toISOString()
        }

        bots.set(botId, bot)
        botSettings.set(botId, settings)
        setupBotHandlers(bot, botId, socket)

        // Авто-переподключение с интервалом
        if (data.interval && parseInt(data.interval) > 0) {
          setupAutoJoin(botId, settings)
        }

      } catch (e) {
        console.error('Ошибка создания бота:', e)
        socket.emit('notification', { type: 'error', message: `❌ Ошибка: ${e.message}` })
      }
    }

    await saveConfig()
    const updatedList = await getBotsList()
    io.emit('botsList', updatedList)
  })

  socket.on('disconnectAllBots', () => {
    bots.forEach((bot, id) => {
      bot.quit()
      bots.delete(id)
      botWindows.delete(id)
      viewers.delete(id)
      botChatLogs.delete(id)
      if (autoJoinIntervals.has(id)) {
        clearInterval(autoJoinIntervals.get(id))
        autoJoinIntervals.delete(id)
      }
    })
    io.emit('botsList', [])
  })

  socket.on('selectAllBots', () => {
    socket.emit('selectAllBots')
  })

  socket.on('deselectAllBots', () => {
    socket.emit('deselectAllBots')
  })

  socket.on('sendToSelected', ({ message, selectedBots }) => {
    selectedBots.forEach(botId => {
      const bot = bots.get(botId)
      if (bot) {
        try {
          bot.chat(message)
          addToChatLog(botId, bot.username, message)
        } catch (e) {
          console.error('Ошибка отправки сообщения:', e)
        }
      }
    })
  })

  socket.on('sendToAll', ({ message }) => {
    bots.forEach((bot, botId) => {
      try {
        bot.chat(message)
        addToChatLog(botId, bot.username, message)
      } catch (e) {
        console.error('Ошибка отправки сообщения:', e)
      }
    })
  })

  socket.on('startViewer', ({ botId }) => {
    const bot = bots.get(botId)
    if (!bot) return

    try {
      const viewerPort = VIEWER_PORT + viewers.size
      viewer(bot, { port: viewerPort, showNames: true })
      viewers.set(botId, viewerPort)
      socket.emit('notification', { type: 'success', message: `👁️ Viewer на порту ${viewerPort}` })
      socket.emit('viewerStarted', { botId, port: viewerPort })
    } catch (e) {
      socket.emit('notification', { type: 'error', message: '❌ Ошибка viewer: ' + e.message })
    }
  })

  socket.on('deleteBot', async (botId) => {
    if (bots.has(botId)) {
      const bot = bots.get(botId)
      bot.quit()
      bots.delete(botId)
      botWindows.delete(botId)
      viewers.delete(botId)
      botSettings.delete(botId)
      botChatLogs.delete(botId)
      if (autoJoinIntervals.has(botId)) {
        clearInterval(autoJoinIntervals.get(botId))
        autoJoinIntervals.delete(botId)
      }
      await saveConfig()
      
      const updatedList = await getBotsList()
      io.emit('botsList', updatedList)
    }
  })

  socket.on('botCommand', ({ botId, command, args }) => {
    const bot = bots.get(botId)
    if (!bot) return

    switch(command) {
      case 'chat':
        try {
          bot.chat(args.message)
          addToChatLog(botId, bot.username, args.message)
        } catch (e) {
          console.error('Ошибка отправки сообщения:', e)
        }
        break
      case 'move':
        moveBot(bot, args.direction)
        break
case 'clickSlot':
  if (!botWindows.has(botId)) return
  try {
    // Используем try-catch для обработки ошибок
    bot.clickWindow(args.slot, args.mouseButton || 0, 0)
      .catch(err => {
        // Игнорируем ошибки от сервера
        console.log(`[${bot.username}] Клик по слоту ${args.slot} игнорирован (сервер не ответил)`)
      })
  } catch (e) {
    // Игнорируем ошибки
    console.log(`[${bot.username}] Ошибка клика: ${e.message}`)
  }
  break
      case 'closeWindow':
        if (botWindows.has(botId)) {
          bot.closeWindow(botWindows.get(botId))
        }
        break
      case 'command':
        try {
          bot.chat('/' + args.command)
          addToChatLog(botId, bot.username, '/' + args.command)
        } catch (e) {}
        break
    }
  })
})

async function getBotsList() {
  const config = await loadConfig()
  return config.bots.map(b => ({
    ...b,
    online: bots.has(b.id),
    health: bots.get(b.id)?.health || 0,
    food: bots.get(b.id)?.food || 0,
    position: bots.get(b.id)?.entity?.position || null,
    viewer: viewers.has(b.id),
    viewerPort: viewers.get(b.id),
    window: botWindows.has(b.id) ? {
      title: botWindows.get(b.id).title?.toString() || 'Меню',
      slots: getSlotsInfo(botWindows.get(b.id))
    } : null,
    chatLog: botChatLogs.get(b.id) || []
  }))
}

function getSlotsInfo(window) {
  if (!window) return []
  return window.slots.map((item, i) => {
    if (!item) return { slot: i, name: 'empty', displayName: 'Пусто', count: 0 }
    return {
      slot: i,
      name: item.name,
      displayName: item.displayName || item.name,
      count: item.count || 1
    }
  })
}

function addToChatLog(botId, username, message) {
  if (!botChatLogs.has(botId)) {
    botChatLogs.set(botId, [])
  }
  const logs = botChatLogs.get(botId)
  logs.push({ username, message, time: Date.now() })
  if (logs.length > 50) logs.shift() // Храним последние 50 сообщений
  io.emit('botChat', { botId, username, message })
}

function setupAutoJoin(botId, settings) {
  const interval = setInterval(() => {
    const bot = bots.get(botId)
    if (!bot || !bot.entity) {
      // Переподключаемся
      const newBot = mineflayer.createBot({
        host: settings.host,
        port: parseInt(settings.port),
        username: settings.username,
        version: settings.version || false,
        skipValidation: true,
        auth: 'offline'
      })
      
      newBot.on('resourcePack', (url, hash) => newBot.acceptResourcePack())
      newBot.on('resourcePackSend', (url, hash) => newBot.acceptResourcePack())
      
      bots.set(botId, newBot)
      setupBotHandlers(newBot, botId, io)
      addToChatLog(botId, 'Система', '🔄 Переподключение...')
    }
  }, parseInt(settings.interval))
  
  autoJoinIntervals.set(botId, interval)
}

function setupBotHandlers(bot, botId, socket) {
  bot.once('spawn', () => {
    console.log(`🤖 Бот ${bot.username} заспавнился`)
    addToChatLog(botId, 'Система', `✨ Бот заспавнился`)
    io.emit('botEvent', { botId, type: 'spawn', message: `✨ ${bot.username} заспавнился` })
  })

  bot.on('health', () => {
    io.emit('botUpdate', { botId, health: bot.health, food: bot.food })
  })

  bot.on('chat', (username, message) => {
    if (username !== bot.username) {
      addToChatLog(botId, username, message)
    }
  })

  bot.on('message', (jsonMsg) => {
    const message = jsonMsg.toString()
    addToChatLog(botId, '📢 Сервер', message)
  })

  bot.on('windowOpen', (window) => {
    botWindows.set(botId, window)
    const slots = getSlotsInfo(window)
    io.emit('botWindowOpen', { 
      botId, 
      title: window.title?.toString() || 'Меню',
      slots: slots
    })
    addToChatLog(botId, 'Система', `📦 Открыто окно: ${window.title?.toString() || 'Меню'}`)
  })

  bot.on('windowClose', () => {
    botWindows.delete(botId)
    io.emit('botWindowClose', { botId })
    addToChatLog(botId, 'Система', '❌ Окно закрыто')
  })

  bot.on('kicked', (reason) => {
    const reasonStr = reason?.toString() || 'неизвестно'
    addToChatLog(botId, 'Система', `👢 Кикнут: ${reasonStr}`)
    io.emit('botEvent', { botId, type: 'kicked', message: `👢 Кикнут: ${reasonStr}` })
  })

  bot.on('end', () => {
    addToChatLog(botId, 'Система', '🔌 Отключен')
    io.emit('botEvent', { botId, type: 'disconnect', message: '🔌 Отключен' })
  })

  bot.on('error', (err) => {
    console.error(`Ошибка бота ${bot.username}:`, err)
    addToChatLog(botId, 'Система', `❌ Ошибка: ${err.message}`)
  })

  const interval = setInterval(() => {
    if (bot?.entity) {
      io.emit('botPosition', { botId, position: bot.entity.position })
    }
  }, 1000)

  bot.once('end', () => clearInterval(interval))
}

function moveBot(bot, direction) {
  const controls = { 
    forward: 'forward', 
    back: 'back', 
    left: 'left', 
    right: 'right', 
    jump: 'jump' 
  }
  if (controls[direction]) {
    bot.setControlState(controls[direction], true)
    setTimeout(() => bot.setControlState(controls[direction], false), direction === 'jump' ? 120 : 400)
  }
}

httpServer.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════════════════╗
  ║     🚀 Mineflayer Bot Control Panel v5.0                 ║
  ║     📍 http://localhost:${PORT}                            ║
  ║     🔧 Оффлайн режим (пиратка)                           ║
  ║     📦 Автопринятие ресурс-паков                         ║
  ║     💬 Рабочий чат и инвентарь                           ║
  ╚══════════════════════════════════════════════════════════╝
  `)
})

const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🤖 Управление ботами Minecraft</title>
  <script src="/socket.io/socket.io.js"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    body {
      background: #1a1b2f;
      color: #fff;
      padding: 20px;
    }

    .container {
      max-width: 1600px;
      margin: 0 auto;
    }

    .header {
      background: #232538;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border: 1px solid #2f3142;
    }

    .header h1 {
      font-size: 24px;
      display: flex;
      align-items: center;
      gap: 10px;
      color: #8b5cf6;
    }

    .stats {
      display: flex;
      gap: 20px;
    }

    .stat-item {
      background: #2a2c3e;
      padding: 8px 16px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
      border: 1px solid #36384a;
    }

    .stat-value {
      font-weight: bold;
      color: #8b5cf6;
    }

    .connection-panel {
      background: #232538;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
      border: 1px solid #2f3142;
    }

    .panel-title {
      font-size: 18px;
      margin-bottom: 15px;
      color: #8b5cf6;
    }

    .grid-4 {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 15px;
      margin-bottom: 15px;
    }

    .input-group {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .input-group label {
      font-size: 12px;
      color: #9ca3af;
    }

    .input-group input, .input-group select {
      background: #2a2c3e;
      border: 1px solid #36384a;
      border-radius: 6px;
      padding: 10px;
      color: #fff;
      font-size: 14px;
    }

    .input-group input:focus, .input-group select:focus {
      outline: none;
      border-color: #8b5cf6;
    }

    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #9ca3af;
    }

    .button-group {
      display: flex;
      gap: 10px;
      margin-top: 10px;
      flex-wrap: wrap;
    }

    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s;
    }

    .btn-primary {
      background: #8b5cf6;
      color: white;
    }

    .btn-primary:hover {
      background: #7c3aed;
    }

    .btn-secondary {
      background: #2f3142;
      color: #fff;
      border: 1px solid #4a4c5e;
    }

    .btn-secondary:hover {
      background: #36384a;
    }

    .btn-danger {
      background: #dc2626;
      color: white;
    }

    .btn-danger:hover {
      background: #b91c1c;
    }

    .btn-success {
      background: #10b981;
      color: white;
    }

    .btn-success:hover {
      background: #059669;
    }

    .control-panel {
      background: #232538;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
      border: 1px solid #2f3142;
    }

    .control-row {
      display: flex;
      gap: 15px;
      align-items: center;
      flex-wrap: wrap;
    }

    .chat-input {
      flex: 1;
      display: flex;
      gap: 10px;
      min-width: 300px;
    }

    .chat-input input {
      flex: 1;
      background: #2a2c3e;
      border: 1px solid #36384a;
      border-radius: 6px;
      padding: 12px;
      color: #fff;
      font-size: 14px;
    }

    .chat-input input:focus {
      outline: none;
      border-color: #8b5cf6;
    }

    .movement-buttons {
      display: flex;
      gap: 5px;
    }

    .move-btn {
      width: 40px;
      height: 40px;
      background: #2f3142;
      border: 1px solid #4a4c5e;
      border-radius: 6px;
      color: #fff;
      cursor: pointer;
      transition: all 0.2s;
    }

    .move-btn:hover {
      background: #8b5cf6;
      border-color: #8b5cf6;
    }

    .gui-panel {
      background: #232538;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
      border: 1px solid #2f3142;
    }

    .gui-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
      gap: 10px;
      margin: 15px 0;
    }

    .gui-button {
      background: #2f3142;
      border: 1px solid #4a4c5e;
      border-radius: 6px;
      padding: 10px;
      color: #fff;
      cursor: pointer;
      text-align: center;
      transition: all 0.2s;
    }

    .gui-button:hover {
      background: #8b5cf6;
      border-color: #8b5cf6;
    }

    .command-input {
      display: flex;
      gap: 10px;
      margin: 15px 0;
    }

    .command-input input {
      flex: 1;
      background: #2a2c3e;
      border: 1px solid #36384a;
      border-radius: 6px;
      padding: 10px;
      color: #fff;
    }

    .window-info {
      background: #2a2c3e;
      border-radius: 6px;
      padding: 15px;
      margin: 15px 0;
      text-align: center;
      border: 1px solid #36384a;
    }

    .window-info.active {
      border-color: #8b5cf6;
      background: #2f3142;
    }

    .bots-container {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(450px, 1fr));
      gap: 20px;
    }

    .bot-card {
      background: #232538;
      border-radius: 12px;
      border: 1px solid #2f3142;
      overflow: hidden;
    }

    .bot-card.selected {
      border-color: #8b5cf6;
      box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.3);
    }

    .bot-header {
      background: #2a2c3e;
      padding: 15px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #2f3142;
    }

    .bot-name {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 500;
    }

    .bot-status {
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 4px;
    }

    .status-online {
      background: #10b981;
      color: white;
    }

    .status-offline {
      background: #6b7280;
      color: white;
    }

    .bot-select {
      width: 20px;
      height: 20px;
      cursor: pointer;
    }

    .bot-body {
      padding: 15px;
    }

    .bot-stats {
      display: flex;
      gap: 20px;
      margin-bottom: 15px;
      background: #2a2c3e;
      padding: 10px;
      border-radius: 6px;
    }

    .stat {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .position {
      font-family: monospace;
      background: #2a2c3e;
      padding: 8px;
      border-radius: 6px;
      text-align: center;
      margin-bottom: 15px;
      font-size: 13px;
    }

    .inventory-section {
      background: #2a2c3e;
      border-radius: 6px;
      padding: 10px;
      margin: 10px 0;
      border: 1px solid #8b5cf6;
    }

    .inventory-title {
      color: #8b5cf6;
      font-size: 14px;
      margin-bottom: 10px;
    }

    .inventory-grid {
      display: grid;
      grid-template-columns: repeat(9, 1fr);
      gap: 4px;
    }

    .inventory-slot {
      aspect-ratio: 1;
      background: #36384a;
      border: 1px solid #4a4c5e;
      border-radius: 4px;
      cursor: pointer;
      position: relative;
    }

    .inventory-slot:hover {
      border-color: #8b5cf6;
      transform: scale(1.1);
    }

    .inventory-slot.empty {
      opacity: 0.3;
    }

    .slot-count {
      position: absolute;
      bottom: 2px;
      right: 4px;
      color: #fbbf24;
      font-size: 10px;
      font-weight: bold;
    }

    .chat-log {
      background: #1a1b2f;
      border-radius: 6px;
      padding: 10px;
      height: 150px;
      overflow-y: auto;
      font-size: 12px;
      margin: 10px 0;
      border: 1px solid #36384a;
    }

    .chat-message {
      padding: 4px 0;
      border-bottom: 1px solid #2f3142;
      word-break: break-word;
    }

    .chat-message:last-child {
      border-bottom: none;
    }

    .chat-message .system {
      color: #8b5cf6;
    }

    .chat-message .server {
      color: #fbbf24;
    }

    .viewer-link {
      display: block;
      text-align: center;
      padding: 8px;
      background: #8b5cf6;
      color: white;
      text-decoration: none;
      border-radius: 6px;
      margin: 10px 0;
    }

    .notification {
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 12px 24px;
      border-radius: 6px;
      color: white;
      animation: slideIn 0.3s;
      z-index: 1000;
    }

    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    .notification.success { background: #10b981; }
    .notification.error { background: #dc2626; }
    .notification.info { background: #3b82f6; }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <h1>
        <i class="fas fa-robot"></i>
        Управление ботами Minecraft (Пиратка)
      </h1>
      <div class="stats">
        <div class="stat-item">
          <i class="fas fa-server"></i>
          <span>Всего: <span class="stat-value" id="totalBots">0</span></span>
        </div>
        <div class="stat-item">
          <i class="fas fa-check-circle"></i>
          <span>Выбрано: <span class="stat-value" id="selectedBots">0</span></span>
        </div>
        <div class="stat-item">
          <i class="fas fa-plug"></i>
          <span>Онлайн: <span class="stat-value" id="onlineBots">0</span></span>
        </div>
      </div>
    </div>

    <!-- Connection Panel -->
    <div class="connection-panel">
      <div class="panel-title">
        <i class="fas fa-plug"></i> Подключение (Оффлайн режим)
      </div>
      <div class="grid-4">
        <div class="input-group">
          <label>Адрес сервера</label>
          <input type="text" id="host" value="localhost">
        </div>
        <div class="input-group">
          <label>Порт</label>
          <input type="number" id="port" value="25565">
        </div>
        <div class="input-group">
          <label>Версия</label>
          <select id="version">
            <option value="false">Авто</option>
            <option value="1.20.4">1.20.4</option>
            <option value="1.19.4">1.19.4</option>
            <option value="1.18.2">1.18.2</option>
            <option value="1.17.1">1.17.1</option>
            <option value="1.16.5">1.16.5</option>
          </select>
        </div>
        <div class="input-group">
          <label>Ник бота</label>
          <input type="text" id="username" value="Bot">
        </div>
        <div class="input-group">
          <label>Кол-во</label>
          <input type="number" id="botCount" value="1" min="1" max="10">
        </div>
        <div class="input-group">
          <label>Интервал (мс)</label>
          <input type="number" id="interval" value="0">
        </div>
        <div class="input-group">
          <label>Пароль (если есть)</label>
          <input type="password" id="password" value="">
        </div>
        <div class="checkbox-group">
          <input type="checkbox" id="autoJoin">
          <label>Авто-вход</label>
        </div>
      </div>
      <div class="button-group">
        <button class="btn btn-primary" onclick="connectBots()">
          <i class="fas fa-plug"></i> Подключить
        </button>
        <button class="btn btn-secondary" onclick="selectAllBots()">
          <i class="fas fa-check-square"></i> Выбрать всех
        </button>
        <button class="btn btn-secondary" onclick="deselectAllBots()">
          <i class="fas fa-square"></i> Снять выбор
        </button>
        <button class="btn btn-danger" onclick="disconnectAllBots()">
          <i class="fas fa-power-off"></i> Откл. всех
        </button>
      </div>
    </div>

    <!-- Control Panel -->
    <div class="control-panel">
      <div class="control-row">
        <div class="chat-input">
          <input type="text" id="globalMessage" placeholder="Введите сообщение...">
          <button class="btn btn-primary" onclick="sendToSelected()">
            <i class="fas fa-paper-plane"></i> Выбранным
          </button>
          <button class="btn btn-secondary" onclick="sendToAll()">
            <i class="fas fa-globe"></i> Всем
          </button>
        </div>
        <div class="movement-buttons">
          <button class="move-btn" onclick="moveSelected('forward')"><i class="fas fa-arrow-up"></i></button>
          <button class="move-btn" onclick="moveSelected('back')"><i class="fas fa-arrow-down"></i></button>
          <button class="move-btn" onclick="moveSelected('left')"><i class="fas fa-arrow-left"></i></button>
          <button class="move-btn" onclick="moveSelected('right')"><i class="fas fa-arrow-right"></i></button>
          <button class="move-btn" onclick="moveSelected('jump')"><i class="fas fa-arrow-up"></i> ⬆</button>
        </div>
      </div>
    </div>

    <!-- GUI Panel -->
    <div class="gui-panel">
      <div class="panel-title">
        <i class="fas fa-window-maximize"></i> GUI / Меню
      </div>
      <div class="gui-grid">
        <button class="gui-button" onclick="sendCommandToSelected('/shop')">/shop</button>
        <button class="gui-button" onclick="sendCommandToSelected('/grief')">/grief</button>
        <button class="gui-button" onclick="sendCommandToSelected('/menu')">/menu</button>
        <button class="gui-button" onclick="sendCommandToSelected('/kit')">/kit</button>
        <button class="gui-button" onclick="sendCommandToSelected('/warp')">/warp</button>
        <button class="gui-button" onclick="sendCommandToSelected('/spawn')">/spawn</button>
        <button class="gui-button" onclick="sendCommandToSelected('/home')">/home</button>
        <button class="gui-button" onclick="sendCommandToSelected('/trade')">/trade</button>
      </div>
      <div class="command-input">
        <input type="text" id="customCommand" placeholder="/shop">
        <button class="btn btn-primary" onclick="sendCustomCommand()">
          <i class="fas fa-paper-plane"></i> Отправить команду
        </button>
      </div>
      <div id="windowInfo" class="window-info">
        Нет открытого окна
      </div>
      <button class="btn btn-secondary" style="margin-top: 10px;" onclick="refreshWindows()">
        <i class="fas fa-sync"></i> Обновить
      </button>
    </div>

    <!-- Bots List -->
    <div class="bots-container" id="botsContainer"></div>
  </div>

  <script>
    const socket = io()
    let botsData = []
    let selectedBots = new Set()

    socket.emit('getBotsList')

    socket.on('botsList', (bots) => {
      console.log('Получен список ботов:', bots)
      botsData = bots
      updateBotsGrid(bots)
      updateStats()
    })

    socket.on('botUpdate', ({ botId, health, food }) => {
      const bot = botsData.find(b => b.id === botId)
      if (bot) {
        bot.health = health
        bot.food = food
        updateBotsGrid(botsData)
      }
    })

    socket.on('botPosition', ({ botId, position }) => {
      const bot = botsData.find(b => b.id === botId)
      if (bot) {
        bot.position = position
        updateBotsGrid(botsData)
      }
    })

    socket.on('botChat', ({ botId, username, message }) => {
      console.log('Чат от бота:', botId, username, message)
      const bot = botsData.find(b => b.id === botId)
      if (bot) {
        if (!bot.chatLog) bot.chatLog = []
        bot.chatLog.push({ username, message, time: Date.now() })
        if (bot.chatLog.length > 50) bot.chatLog.shift()
        updateBotsGrid(botsData)
      }
      addChatMessage(botId, username, message)
    })

    socket.on('botWindowOpen', ({ botId, title, slots }) => {
      console.log('Открыто окно:', botId, title)
      const bot = botsData.find(b => b.id === botId)
      if (bot) {
        bot.window = { title, slots }
        updateBotsGrid(botsData)
        document.getElementById('windowInfo').innerHTML = \`📦 Открыто: \${title}\`
        document.getElementById('windowInfo').classList.add('active')
      }
    })

    socket.on('botWindowClose', ({ botId }) => {
      const bot = botsData.find(b => b.id === botId)
      if (bot) {
        bot.window = null
        updateBotsGrid(botsData)
      }
      document.getElementById('windowInfo').innerHTML = 'Нет открытого окна'
      document.getElementById('windowInfo').classList.remove('active')
    })

    socket.on('viewerStarted', ({ botId, port }) => {
      const bot = botsData.find(b => b.id === botId)
      if (bot) {
        bot.viewer = true
        bot.viewerPort = port
        updateBotsGrid(botsData)
      }
    })

    socket.on('notification', ({ type, message }) => {
      showNotification(message, type)
    })

    socket.on('selectAllBots', () => {
      botsData.forEach(bot => selectedBots.add(bot.id))
      updateBotsGrid(botsData)
      updateStats()
    })

    socket.on('deselectAllBots', () => {
      selectedBots.clear()
      updateBotsGrid(botsData)
      updateStats()
    })

    function connectBots() {
      const data = {
        host: document.getElementById('host').value,
        port: document.getElementById('port').value,
        version: document.getElementById('version').value,
        username: document.getElementById('username').value,
        count: document.getElementById('botCount').value,
        password: document.getElementById('password').value,
        autoJoin: document.getElementById('autoJoin').checked,
        interval: document.getElementById('interval').value
      }
      console.log('Подключение ботов:', data)
      socket.emit('connectBots', data)
    }

    function disconnectAllBots() {
      if (confirm('Отключить всех ботов?')) {
        socket.emit('disconnectAllBots')
        selectedBots.clear()
      }
    }

    function selectAllBots() {
      botsData.forEach(bot => selectedBots.add(bot.id))
      updateBotsGrid(botsData)
      updateStats()
    }

    function deselectAllBots() {
      selectedBots.clear()
      updateBotsGrid(botsData)
      updateStats()
    }

    function toggleBotSelection(botId) {
      if (selectedBots.has(botId)) {
        selectedBots.delete(botId)
      } else {
        selectedBots.add(botId)
      }
      updateBotsGrid(botsData)
      updateStats()
    }

    function sendToSelected() {
      const message = document.getElementById('globalMessage').value.trim()
      if (!message) {
        showNotification('Введите сообщение', 'error')
        return
      }
      if (selectedBots.size === 0) {
        showNotification('Выберите ботов', 'error')
        return
      }
      socket.emit('sendToSelected', { 
        message: message, 
        selectedBots: Array.from(selectedBots) 
      })
      document.getElementById('globalMessage').value = ''
    }

    function sendToAll() {
      const message = document.getElementById('globalMessage').value.trim()
      if (!message) {
        showNotification('Введите сообщение', 'error')
        return
      }
      socket.emit('sendToAll', { message: message })
      document.getElementById('globalMessage').value = ''
    }

    function moveSelected(direction) {
      selectedBots.forEach(botId => {
        socket.emit('botCommand', { botId, command: 'move', args: { direction } })
      })
    }

    function sendCommandToSelected(command) {
      selectedBots.forEach(botId => {
        socket.emit('botCommand', { botId, command: 'command', args: { command: command.substring(1) } })
      })
    }

    function sendCustomCommand() {
      const command = document.getElementById('customCommand').value.trim()
      if (command) {
        sendCommandToSelected(command)
        document.getElementById('customCommand').value = ''
      }
    }

    function refreshWindows() {
      socket.emit('getBotsList')
    }

    function sendChat(botId) {
      const input = document.getElementById(\`chat-\${botId}\`)
      if (!input) return
      
      const message = input.value.trim()
      if (message) {
        socket.emit('botCommand', { 
          botId: botId, 
          command: 'chat', 
          args: { message: message } 
        })
        input.value = ''
      }
    }

    function startViewer(botId) {
      socket.emit('startViewer', { botId })
    }

    function clickSlot(botId, slot, mouseButton = 0, event) {
      if (event) event.preventDefault()
      socket.emit('botCommand', { botId, command: 'clickSlot', args: { slot, mouseButton } })
    }

    function closeWindow(botId) {
      socket.emit('botCommand', { botId, command: 'closeWindow' })
    }

    function addChatMessage(botId, username, message) {
      const chatLog = document.getElementById(\`chat-log-\${botId}\`)
      if (chatLog) {
        const msgDiv = document.createElement('div')
        msgDiv.className = 'chat-message'
        
        let userClass = ''
        if (username.includes('Система')) userClass = 'system'
        else if (username.includes('Сервер')) userClass = 'server'
        
        msgDiv.innerHTML = \`<span class="\${userClass}"><b>\${username}:</b> \${message}</span>\`
        chatLog.appendChild(msgDiv)
        chatLog.scrollTop = chatLog.scrollHeight
      }
    }

    function updateBotsGrid(bots) {
      const container = document.getElementById('botsContainer')
      
      if (bots.length === 0) {
        container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 50px; background: #232538; border-radius: 12px;">Нет ботов</div>'
        return
      }

      // Сохраняем значения полей ввода
      const chatInputs = {}
      bots.forEach(bot => {
        const input = document.getElementById(\`chat-\${bot.id}\`)
        if (input) {
          chatInputs[bot.id] = input.value
        }
      })

      container.innerHTML = bots.map(bot => createBotCard(bot)).join('')

      // Восстанавливаем значения
      setTimeout(() => {
        bots.forEach(bot => {
          const input = document.getElementById(\`chat-\${bot.id}\`)
          if (input && chatInputs[bot.id] !== undefined) {
            input.value = chatInputs[bot.id]
          }
        })
      }, 0)
    }

    function createBotCard(bot) {
      const isSelected = selectedBots.has(bot.id)
      const healthPercent = (bot.health / 20) * 100 || 0
      
      return \`
        <div class="bot-card \${isSelected ? 'selected' : ''}">
          <div class="bot-header">
            <div class="bot-name">
              <input type="checkbox" class="bot-select" 
                     \${isSelected ? 'checked' : ''} 
                     onchange="toggleBotSelection('\${bot.id}')">
              <i class="fas fa-robot"></i>
              \${bot.name}
            </div>
            <span class="bot-status status-\${bot.online ? 'online' : 'offline'}">
              \${bot.online ? '🟢 Онлайн' : '🔴 Оффлайн'}
            </span>
          </div>
          
          <div class="bot-body">
            <div class="bot-stats">
              <div class="stat">
                <i class="fas fa-heart" style="color: #ef4444;"></i>
                <span>\${Math.round(bot.health || 0)}/20</span>
              </div>
              <div class="stat">
                <i class="fas fa-drumstick-bite" style="color: #fbbf24;"></i>
                <span>\${Math.round(bot.food || 0)}/20</span>
              </div>
            </div>

            \${bot.position ? \`
              <div class="position">
                <i class="fas fa-map-marker-alt"></i>
                X: \${Math.round(bot.position.x)} Y: \${Math.round(bot.position.y)} Z: \${Math.round(bot.position.z)}
              </div>
            \` : ''}

            \${!bot.viewer && bot.online ? \`
              <button class="btn btn-secondary" style="width: 100%; margin: 10px 0;" onclick="startViewer('\${bot.id}')">
                <i class="fas fa-eye"></i> 3D просмотр
              </button>
            \` : ''}

            \${bot.viewer && bot.viewerPort ? \`
              <a href="http://localhost:\${bot.viewerPort}" target="_blank" class="viewer-link">
                <i class="fas fa-eye"></i> 3D просмотр
              </a>
            \` : ''}

            \${bot.window ? \`
              <div class="inventory-section">
                <div class="inventory-title">
                  <i class="fas fa-box"></i> \${bot.window.title}
                </div>
                <div class="inventory-grid">
                  \${bot.window.slots.map(slot => \`
                    <div class="inventory-slot \${slot.name === 'empty' ? 'empty' : ''}"
                         onclick="clickSlot('\${bot.id}', \${slot.slot}, 0, event)"
                         oncontextmenu="clickSlot('\${bot.id}', \${slot.slot}, 1, event)"
                         title="\${slot.displayName}">
                      \${slot.count > 1 ? \`<span class="slot-count">\${slot.count}</span>\` : ''}
                    </div>
                  \`).join('')}
                </div>
                <button class="btn btn-secondary" style="width: 100%; margin-top: 10px;" onclick="closeWindow('\${bot.id}')">
                  <i class="fas fa-times"></i> Закрыть окно
                </button>
              </div>
            \` : ''}

            <div class="chat-log" id="chat-log-\${bot.id}">
              \${bot.chatLog && bot.chatLog.length > 0 ? 
                bot.chatLog.map(msg => \`
                  <div class="chat-message">
                    <span class="\${msg.username.includes('Система') ? 'system' : (msg.username.includes('Сервер') ? 'server' : '')}">
                      <b>\${msg.username}:</b> \${msg.message}
                    </span>
                  </div>
                \`).join('') 
                : '<div class="chat-message">Чат бота...</div>'
              }
            </div>

            <div style="display: flex; gap: 5px; margin-top: 10px;">
              <input type="text" id="chat-\${bot.id}" placeholder="Сообщение..." 
                     style="flex: 1; background: #2a2c3e; border: 1px solid #36384a; border-radius: 4px; padding: 8px; color: #fff;"
                     onkeypress="if(event.key==='Enter') sendChat('\${bot.id}')">
              <button class="btn btn-primary" style="padding: 8px 12px;" onclick="sendChat('\${bot.id}')">
                <i class="fas fa-paper-plane"></i>
              </button>
            </div>
          </div>
        </div>
      \`
    }

    function updateStats() {
      document.getElementById('totalBots').textContent = botsData.length
      document.getElementById('selectedBots').textContent = selectedBots.size
      document.getElementById('onlineBots').textContent = botsData.filter(b => b.online).length
    }

    function showNotification(message, type) {
      const notification = document.createElement('div')
      notification.className = \`notification \${type}\`
      notification.innerHTML = message
      document.body.appendChild(notification)
      
      setTimeout(() => {
        notification.remove()
      }, 3000)
    }

    // Глобальный обработчик Enter
    document.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        if (e.target.id === 'globalMessage') {
          sendToSelected()
        } else if (e.target.id.startsWith('chat-')) {
          const botId = e.target.id.replace('chat-', '')
          sendChat(botId)
        }
      }
    })
  </script>
</body>
</html>`

export {}