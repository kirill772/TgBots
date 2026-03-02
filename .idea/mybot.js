const mineflayer = require("mineflayer");
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
const port = 3000;
const { exec } = require('child_process');

const fs = require('fs');
const path = require('path');

if (process.pkg) {
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, `bot-manager-${Date.now()}.log`);
    const originalLog = console.log;
    const originalError = console.error;
    console.log = function(...args) {
        const message = args.join(' ') + '\n';
        fs.appendFileSync(logFile, `[LOG] ${message}`);
        originalLog.apply(console, args);
    };
    console.error = function(...args) {
        const message = args.join(' ') + '\n';
        fs.appendFileSync(logFile, `[ERROR] ${message}`);
        originalError.apply(console, args);
    };
    console.log('Логирование активировано. Логи сохраняются в:', logFile);
}

if (process.pkg) {
    __dirname = path.dirname(process.execPath);
}

app.use(bodyParser.json());
app.use(express.static('public'));

console.clear();
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║      Bot-Manager - Запущен!                                  ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log(`║ Веб-интерфейс: http://localhost:${port}                      ║`);
console.log('║ 3D просмотр каждого бота на отдельном порту                 ║');
console.log('║ (первый бот: 3007, второй: 3008, и т.д.)                    ║');
console.log('║                                                              ║');
console.log('║ Функции:                                                     ║');
console.log('║  • Подключение нескольких ботов с интервалом                ║');
console.log('║  • Авто-вход (/register + /login)                           ║');
console.log('║  • Клики в GUI меню (ПКМ/ЛКМ)                               ║');
console.log('║  • Отображение открытых окон                                ║');
console.log('║  • Авто-принятие ресурспаков                                ║');
console.log('║                                                              ║');
console.log('║ Откройте браузер и перейдите по адресу выше                  ║');
console.log('║ Для выхода нажмите Ctrl + C                                  ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');

if (process.platform === 'win32') {
    setTimeout(() => {
        exec(`start http://localhost:${port}`, (error) => {
            if (error) {
                console.log('Не удалось открыть браузер автоматически');
            }
        });
    }, 1000);
}

let bots = [];
let botCounter = 0;
let selectedBots = new Set();

function connectBotsWithInterval(config, count = 1, interval = 8000, autoAuth = false, password = "tricept") {
    const botIds = [];
    for (let i = 0; i < count; i++) {
        setTimeout(() => {
            const botUsername = count > 1 ? config.username + '_' + i : config.username;
            console.log(`Подключение бота ${botUsername}...`);
            const botId = createBot({
                ...config,
                username: botUsername
            }, autoAuth, password);
            if (botId !== null) {
                botIds.push(botId);
                broadcast({
                    type: 'info',
                    message: `Бот ${botUsername} подключается...${autoAuth ? ' (авто-вход)' : ''}`
                });
            }
        }, i * interval);
    }
    return botIds;
}

function createBot(config, autoAuth = false, password = "tricept") {
    const botId = botCounter++;
    const viewerPort = 3007 + botId;

    try {
        const bot = mineflayer.createBot({
            host: config.host,
            port: config.port || 25565,
            version: config.version || false,
            username: config.username,
            viewDistance: "tiny",
            auth: 'offline',
            skipValidation: true,
            connectTimeout: 30000
        });

        bot.id = botId;
        bot.config = config;
        bot.viewerPort = viewerPort;
        bot.connected = false;
        bot.autoAuth = autoAuth;
        bot.authPassword = password;
        bot.authDone = false;
        bot.window = null;

        bot.once('spawn', () => {
            bot.connected = true;
            console.log(`✓ Бот ${config.username} подключился`);

            try {
                mineflayerViewer(bot, {
                    port: viewerPort,
                    firstPerson: true,
                    viewDistance: 25
                });
                console.log(`  → 3D экран: http://localhost:${viewerPort}`);
            } catch (error) {
                console.log(`  ⚠ Не удалось запустить 3D просмотр: ${error.message}`);
            }

            if (bot.autoAuth && !bot.authDone) {
                setTimeout(() => {
                    if (bot.connected) {
                        bot.chat(`/register ${bot.authPassword} ${bot.authPassword}`);
                    }
                }, 1000);
                setTimeout(() => {
                    if (bot.connected) {
                        bot.chat(`/login ${bot.authPassword}`);
                        bot.authDone = true;
                    }
                }, 3000);
            }

            broadcast({
                type: 'bot_status',
                botId,
                status: 'online',
                username: config.username,
                viewerPort: viewerPort,
                host: config.host,
                port: config.port,
                autoAuth: bot.autoAuth
            });
        });

        // Автоматическое принятие ресурспаков
        bot.on('resourcePack', (url, hash) => {
            console.log(`[${config.username}] Принят ресурспак: ${url}`);
            bot.acceptResourcePack();
        });

        bot.on('resourcePackSend', (url, hash) => {
            console.log(`[${config.username}] Принят ресурспак (send): ${url}`);
            bot.acceptResourcePack();
        });

        bot.on('message', (message) => {
            const chatMessage = message.toString();
            broadcast({
                type: 'chat',
                botId,
                username: config.username,
                message: chatMessage
            });
        });

        bot.on('windowOpen', (window) => {
            bot.window = window;
            
            // Логируем содержимое окна
            console.log(`\n=== ОТКРЫТО ОКНО У БОТА ${config.username} ===`);
            console.log(`Заголовок: ${window.title}`);
            
            // Получаем информацию о слотах
            const slots = [];
            for (let i = 0; i < window.containerItems.length; i++) {
                const item = window.slots[i];
                if (item) {
                    console.log(`  Слот ${i}: ${item.displayName || item.name} x${item.count}`);
                    slots.push({
                        slot: i,
                        name: item.name,
                        displayName: item.displayName || item.name,
                        count: item.count
                    });
                } else {
                    console.log(`  Слот ${i}: Пусто`);
                    slots.push({
                        slot: i,
                        name: 'empty',
                        displayName: 'Пусто',
                        count: 0
                    });
                }
            }
            console.log('=====================================\n');

            broadcast({
                type: 'window_open',
                botId: bot.id,
                username: bot.config.username,
                title: window.title?.toString() || 'Меню',
                slots: slots
            });
        });

        bot.on('windowClose', () => {
            console.log(`Бот ${config.username} закрыл окно`);
            bot.window = null;
            broadcast({
                type: 'window_close',
                botId: bot.id
            });
        });

        bot.on('kicked', (reason) => {
            bot.connected = false;
            broadcast({
                type: 'bot_status',
                botId,
                status: 'kicked',
                reason
            });
        });

        bot.on('error', (err) => {
            bot.connected = false;
            broadcast({
                type: 'bot_status',
                botId,
                status: 'error',
                error: err.message
            });
        });

        bot.on('end', () => {
            bot.connected = false;
            broadcast({
                type: 'bot_status',
                botId,
                status: 'offline'
            });
        });

        bots.push(bot);
        return botId;
    } catch (error) {
        console.error('Ошибка создания бота:', error);
        return null;
    }
}

// Функции управления
function toggleBotSelection(botId) {
    if (selectedBots.has(botId)) {
        selectedBots.delete(botId);
    } else {
        selectedBots.add(botId);
    }
    return Array.from(selectedBots);
}

function sendToSelectedBots(message) {
    const results = [];
    selectedBots.forEach(botId => {
        const bot = bots.find(b => b.id === botId);
        if (bot && bot.connected) {
            try {
                bot.chat(message);
                results.push({ botId, success: true, username: bot.config.username });
            } catch (error) {
                results.push({ botId, success: false, error: error.message });
            }
        }
    });
    return results;
}

function controlSelectedBots(action, value) {
    const results = [];
    selectedBots.forEach(botId => {
        const bot = bots.find(b => b.id === botId);
        if (bot && bot.connected) {
            try {
                switch(action) {
                    case 'forward':
                        bot.setControlState('forward', true);
                        setTimeout(() => bot.setControlState('forward', false), 500);
                        break;
                    case 'back':
                        bot.setControlState('back', true);
                        setTimeout(() => bot.setControlState('back', false), 500);
                        break;
                    case 'left':
                        bot.setControlState('left', true);
                        setTimeout(() => bot.setControlState('left', false), 500);
                        break;
                    case 'right':
                        bot.setControlState('right', true);
                        setTimeout(() => bot.setControlState('right', false), 500);
                        break;
                    case 'jump':
                        bot.setControlState('jump', true);
                        setTimeout(() => bot.setControlState('jump', false), 200);
                        break;
                }
                results.push({ botId, success: true, username: bot.config.username });
            } catch (error) {
                results.push({ botId, success: false, error: error.message });
            }
        }
    });
    return results;
}

// API эндпоинты
app.post('/connect-interval', (req, res) => {
    const { host, port, username, version, count, interval, autoAuth, password } = req.body;

    if (!host || !username) {
        return res.status(400).json({ error: 'Не указаны обязательные параметры' });
    }

    const botCount = parseInt(count) || 1;
    const connectInterval = parseInt(interval) || 8000;

    const botIds = connectBotsWithInterval({
        host,
        port: port || 25565,
        username,
        version: version || false
    }, botCount, connectInterval, autoAuth || false, password || "tricept");

    res.json({
        success: true,
        botIds,
        message: `Запущено подключение ${botCount} ботов с интервалом ${connectInterval}мс${autoAuth ? ' (авто-вход включен)' : ''}`
    });
});

app.post('/connect', (req, res) => {
    const { host, port, username, version, autoAuth, password } = req.body;

    if (!host || !username) {
        return res.status(400).json({ error: 'Не указаны обязательные параметры' });
    }

    const botId = createBot({
        host,
        port: port || 25565,
        username,
        version: version || false,
        transactionTimeout: 30000
    }, autoAuth || false, password || "tricept");

    if (botId !== null) {
        res.json({
            success: true,
            botId,
            message: `Бот ${username} создан${autoAuth ? ' (авто-вход включен)' : ''}`
        });
    } else {
        res.status(500).json({ error: 'Ошибка создания бота' });
    }
});

app.post('/disconnect', (req, res) => {
    const { botId } = req.body;
    const bot = bots.find(b => b.id === parseInt(botId));

    if (bot) {
        selectedBots.delete(parseInt(botId));
        bot.quit();
        bots = bots.filter(b => b.id !== parseInt(botId));
        res.json({ success: true, message: `Бот #${botId} отключен` });
    } else {
        res.status(404).json({ error: 'Бот не найден' });
    }
});

app.post('/disconnect-all', (req, res) => {
    bots.forEach(bot => {
        try {
            bot.quit();
        } catch (e) {}
    });
    bots = [];
    selectedBots.clear();
    res.json({ success: true, message: 'Все боты отключены' });
});

app.post('/send', (req, res) => {
    const { botId, message, sendToAll } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Сообщение не может быть пустым' });
    }

    if (sendToAll === true) {
        const results = [];
        bots.forEach(bot => {
            if (bot.connected) {
                try {
                    bot.chat(message);
                    results.push({ botId: bot.id, success: true, username: bot.config.username });
                } catch (error) {
                    results.push({ botId: bot.id, success: false, error: error.message });
                }
            }
        });
        res.json({
            success: true,
            message: 'Сообщение отправлено всем ботам',
            results
        });
    } else if (botId === undefined || botId === null) {
        const results = sendToSelectedBots(message);
        res.json({
            success: true,
            message: 'Сообщение отправлено выбранным ботам',
            results,
            selectedBots: Array.from(selectedBots)
        });
    } else {
        const bot = bots.find(b => b.id === parseInt(botId));
        if (bot && bot.connected) {
            bot.chat(message);
            res.json({ success: true, message: 'Сообщение отправлено' });
        } else {
            res.status(404).json({ error: 'Бот не найден или не подключен' });
        }
    }
});

app.post('/control', (req, res) => {
    const { botId, action, value, controlSelected } = req.body;

    if (controlSelected === true) {
        const results = controlSelectedBots(action, value);
        res.json({
            success: true,
            message: 'Команда выполнена для выбранных ботов',
            results,
            selectedBots: Array.from(selectedBots)
        });
    } else {
        const bot = bots.find(b => b.id === parseInt(botId));
        if (!bot || !bot.connected) {
            return res.status(404).json({ error: 'Бот не найден или не подключен' });
        }

        try {
            switch(action) {
                case 'forward':
                    bot.setControlState('forward', true);
                    setTimeout(() => bot.setControlState('forward', false), 500);
                    break;
                case 'back':
                    bot.setControlState('back', true);
                    setTimeout(() => bot.setControlState('back', false), 500);
                    break;
                case 'left':
                    bot.setControlState('left', true);
                    setTimeout(() => bot.setControlState('left', false), 500);
                    break;
                case 'right':
                    bot.setControlState('right', true);
                    setTimeout(() => bot.setControlState('right', false), 500);
                    break;
                case 'jump':
                    bot.setControlState('jump', true);
                    setTimeout(() => bot.setControlState('jump', false), 200);
                    break;
            }
            res.json({ success: true, message: 'Команда выполнена' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
});

app.post('/select-bot', (req, res) => {
    const { botId } = req.body;
    const selected = toggleBotSelection(parseInt(botId));
    res.json({
        success: true,
        selectedBots: selected,
        message: selected.includes(parseInt(botId)) ?
            `Бот #${botId} выбран` : `Бот #${botId} снят с выбора`
    });
});

app.post('/select-all-bots', (req, res) => {
    bots.forEach(bot => {
        if (bot.connected) {
            selectedBots.add(bot.id);
        }
    });
    res.json({
        success: true,
        selectedBots: Array.from(selectedBots),
        message: 'Все боты выбраны'
    });
});

app.post('/deselect-all-bots', (req, res) => {
    selectedBots.clear();
    res.json({
        success: true,
        selectedBots: [],
        message: 'Все боты сняты с выбора'
    });
});

// Эндпоинт для кликов в GUI (как в примере)
app.post('/click-gui-slot', (req, res) => {
    const { botId, slot, mouseButton = 0 } = req.body;

    if (botId === 'selected') {
        const results = [];
        selectedBots.forEach(id => {
            const bot = bots.find(b => b.id === id);
            if (bot && bot.connected && bot.window) {
                try {
                    // Используем bot.clickWindow как в примере
                    // mouseButton: 0 - ЛКМ, 1 - ПКМ
                    bot.clickWindow(parseInt(slot), parseInt(mouseButton), 0);
                    
                    results.push({ botId: id, success: true, username: bot.config.username });

                    broadcast({
                        type: 'gui_click',
                        botId: id,
                        username: bot.config.username,
                        slot: slot,
                        mouseButton: mouseButton
                    });
                } catch (error) {
                    console.error(`Ошибка клика у бота ${id}:`, error);
                    results.push({ botId: id, success: false, error: error.message });
                }
            } else {
                results.push({ botId: id, success: false, error: 'Нет открытого окна' });
            }
        });
        res.json({
            success: true,
            message: 'Клик выполнен для выбранных ботов',
            results
        });
    } else {
        const bot = bots.find(b => b.id === parseInt(botId));
        if (!bot || !bot.connected) {
            return res.status(404).json({ error: 'Бот не найден' });
        }

        if (!bot.window) {
            return res.status(400).json({ error: 'У бота нет открытого окна' });
        }

        try {
            bot.clickWindow(parseInt(slot), parseInt(mouseButton), 0);
            res.json({ success: true, message: `Клик по слоту ${slot} выполнен` });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
});

// Эндпоинт для отправки команд (/shop, /grief и т.д.)
app.post('/send-command', (req, res) => {
    const { botId, command } = req.body;

    if (!command) {
        return res.status(400).json({ error: 'Команда не может быть пустой' });
    }

    if (botId === 'selected') {
        const results = [];
        selectedBots.forEach(id => {
            const bot = bots.find(b => b.id === id);
            if (bot && bot.connected) {
                try {
                    bot.chat(command);
                    results.push({ botId: id, success: true, username: bot.config.username });
                } catch (error) {
                    results.push({ botId: id, success: false, error: error.message });
                }
            }
        });
        res.json({
            success: true,
            message: `Команда ${command} отправлена выбранным ботам`,
            results
        });
    } else {
        const bot = bots.find(b => b.id === parseInt(botId));
        if (!bot || !bot.connected) {
            return res.status(404).json({ error: 'Бот не найден или не подключен' });
        }

        try {
            bot.chat(command);
            res.json({ success: true, message: `Команда ${command} отправлена` });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
});

// Получение информации об открытом окне
app.get('/window-info/:botId', (req, res) => {
    const botId = parseInt(req.params.botId);
    const bot = bots.find(b => b.id === botId);

    if (!bot || !bot.connected) {
        return res.status(404).json({ error: 'Бот не найден' });
    }

    if (!bot.window) {
        return res.json({ hasWindow: false, message: 'Нет открытого окна' });
    }

    const slots = [];
    for (let i = 0; i < bot.window.containerItems.length; i++) {
        const item = bot.window.slots[i];
        slots.push({
            slot: i,
            name: item ? item.name : 'empty',
            displayName: item ? (item.displayName || item.name) : 'Пусто',
            count: item ? item.count : 0
        });
    }

    res.json({
        hasWindow: true,
        title: bot.window.title?.toString() || 'Меню',
        slotCount: bot.window.containerItems.length,
        slots: slots
    });
});

// HTML страница (с панельками как в примере)
const html = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Управление ботами Minecraft</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            padding: 20px;
            line-height: 1.5;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        
        h2 {
            color: #58a6ff;
            margin: 20px 0 10px;
            font-size: 1.8rem;
        }
        
        h3 {
            color: #8b949e;
            margin: 15px 0 5px;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 15px;
            margin: 20px 0;
        }
        
        .stat-card {
            background: #161b22;
            border-radius: 8px;
            padding: 20px;
            text-align: center;
            border: 1px solid #30363d;
        }
        
        .stat-card h4 {
            color: #8b949e;
            font-size: 14px;
            margin-bottom: 10px;
        }
        
        .stat-value {
            font-size: 2rem;
            font-weight: bold;
            color: #58a6ff;
        }
        
        .dashboard {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
        }
        
        .panel {
            background: #161b22;
            border-radius: 8px;
            padding: 20px;
            border: 1px solid #30363d;
        }
        
        .panel h2 {
            margin-top: 0;
            border-bottom: 1px solid #30363d;
            padding-bottom: 10px;
        }
        
        .form-group {
            margin-bottom: 15px;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 5px;
            color: #8b949e;
        }
        
        .form-group input,
        .form-group select {
            width: 100%;
            padding: 8px 10px;
            background: #0d1117;
            color: #e6edf3;
            border: 1px solid #30363d;
            border-radius: 6px;
            font-size: 14px;
        }
        
        .form-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }
        
        button {
            background: #238636;
            color: white;
            border: none;
            padding: 8px 14px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.2s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        
        button:hover {
            background: #2ea043;
        }
        
        button.secondary {
            background: #21262d;
            color: #e6edf3;
            border: 1px solid #30363d;
        }
        
        button.secondary:hover {
            background: #30363d;
        }
        
        button.warning {
            background: #bf8700;
        }
        
        button.warning:hover {
            background: #d29922;
        }
        
        button.danger {
            background: #c62828;
        }
        
        button.danger:hover {
            background: #b71c1c;
        }
        
        .selection-actions {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 10px;
            margin: 15px 0;
        }
        
        .bots-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 15px;
            margin-top: 20px;
        }
        
        .bot-card {
            background: #161b22;
            border-radius: 8px;
            padding: 15px;
            border: 1px solid #30363d;
        }
        
        .bot-card.selected {
            border: 2px solid #58a6ff;
        }
        
        .bot-card.online {
            border-left: 4px solid #238636;
        }
        
        .bot-card.offline {
            border-left: 4px solid #c62828;
        }
        
        .bot-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        
        .bot-header h3 {
            margin: 0;
            color: #e6edf3;
        }
        
        .bot-status {
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: bold;
        }
        
        .bot-status.online {
            background: #23863620;
            color: #2ea043;
            border: 1px solid #238636;
        }
        
        .bot-status.offline {
            background: #c6282820;
            color: #f85149;
            border: 1px solid #c62828;
        }
        
        .bot-info {
            margin: 10px 0;
            padding: 10px 0;
            border-top: 1px solid #30363d;
            border-bottom: 1px solid #30363d;
        }
        
        .info-line {
            margin: 5px 0;
            color: #8b949e;
        }
        
        .info-line a {
            color: #58a6ff;
            text-decoration: none;
        }
        
        .info-line a:hover {
            text-decoration: underline;
        }
        
        .chat-container {
            height: 300px;
            overflow-y: auto;
            background: #0d1117;
            border: 1px solid #30363d;
            border-radius: 8px;
            padding: 15px;
            margin: 10px 0;
        }
        
        .chat-message {
            padding: 8px;
            margin: 5px 0;
            background: #161b22;
            border-radius: 5px;
            border-left: 4px solid #58a6ff;
            word-break: break-word;
        }
        
        .chat-message.bot {
            border-left-color: #2ea043;
        }
        
        .chat-message.system {
            border-left-color: #8b949e;
            font-style: italic;
            color: #8b949e;
        }
        
        .notification {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 25px;
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 8px;
            color: #e6edf3;
            display: none;
            z-index: 1000;
            min-width: 300px;
            box-shadow: 0 5px 15px rgba(0,0,0,.5);
        }
        
        /* Стили для GUI как в примере */
        .gui-container {
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 8px;
            padding: 20px;
            margin-top: 20px;
        }
        
        .quick-commands {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 8px;
            margin-bottom: 20px;
        }
        
        .quick-commands button {
            padding: 8px;
            font-size: 13px;
            background: #21262d;
        }
        
        .command-row {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }
        
        .command-row input {
            flex: 1;
            padding: 8px 12px;
            background: #0d1117;
            color: #e6edf3;
            border: 1px solid #30363d;
            border-radius: 6px;
            font-size: 14px;
        }
        
        .command-row button {
            width: auto;
            padding: 8px 25px;
        }
        
        .window-title {
            background: #0d1117;
            border: 1px solid #30363d;
            border-radius: 6px;
            padding: 12px;
            margin: 15px 0;
            color: #58a6ff;
            font-weight: bold;
        }
        
        #inventory {
            display: grid;
            grid-template-columns: repeat(9, 1fr);
            gap: 4px;
            margin: 15px 0;
            background: #0d1117;
            border: 1px solid #30363d;
            border-radius: 8px;
            padding: 15px;
        }
        
        .slot {
            aspect-ratio: 1;
            background: #21262d;
            border: 2px solid #30363d;
            border-radius: 5px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #e6edf3;
            font-size: 14px;
            cursor: pointer;
            position: relative;
            transition: all 0.2s;
        }
        
        .slot:hover {
            background: #30363d;
            border-color: #58a6ff;
            transform: scale(1.05);
        }
        
        .slot.empty {
            opacity: 0.5;
        }
        
        .slot .count {
            position: absolute;
            bottom: 2px;
            right: 4px;
            color: #f0c674;
            font-weight: bold;
            font-size: 10px;
        }
        
        .slot-info {
            font-size: 10px;
            color: #8b949e;
            margin-top: 5px;
            text-align: center;
        }
        
        .viewer-links {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 10px;
            margin-top: 15px;
        }
        
        .viewer-link {
            display: block;
            padding: 12px;
            background: #21262d;
            border: 1px solid #30363d;
            border-radius: 6px;
            text-decoration: none;
            color: #58a6ff;
            transition: all 0.2s;
        }
        
        .viewer-link:hover {
            background: #30363d;
            border-color: #58a6ff;
        }
        
        .badge {
            display: inline-block;
            padding: 2px 6px;
            background: #23863620;
            border: 1px solid #238636;
            border-radius: 4px;
            color: #2ea043;
            font-size: 11px;
            margin-left: 5px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1 style="text-align: center; margin-bottom: 20px;">🤖 Управление ботами Minecraft</h1>
        
        <div class="stats-grid">
            <div class="stat-card">
                <h4>Всего ботов</h4>
                <div class="stat-value" id="totalBots">0</div>
            </div>
            <div class="stat-card">
                <h4>Выбрано</h4>
                <div class="stat-value" id="selectedBotsCount">0</div>
            </div>
            <div class="stat-card">
                <h4>Онлайн</h4>
                <div class="stat-value" id="onlineBots">0</div>
            </div>
        </div>
        
        <div class="dashboard">
            <div class="panel">
                <h2>🔌 Подключение</h2>
                <div class="form-group">
                    <label>Адрес сервера:</label>
                    <input type="text" id="serverAddress" placeholder="mc.example.com" value="mc.AngelGrief.net">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Порт:</label>
                        <input type="text" id="serverPort" value="25565">
                    </div>
                    <div class="form-group">
                        <label>Версия:</label>
                        <input type="text" id="version" value="1.21.1">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Ник бота:</label>
                        <input type="text" id="nickname" value="DayAngel">
                    </div>
                    <div class="form-group">
                        <label>Кол-во:</label>
                        <input type="number" id="botCount" min="1" value="1">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Интервал (мс):</label>
                        <input type="number" id="interval" value="8000">
                    </div>
                    <div class="form-group">
                        <label style="display: flex; align-items: center; gap: 5px;">
                            <input type="checkbox" id="autoAuth" checked>
                            Авто-вход
                        </label>
                    </div>
                </div>
                <div class="form-group" id="passwordRow">
                    <label>Пароль:</label>
                    <input type="text" id="authPassword" value="tricept">
                </div>
                <div class="form-row">
                    <button onclick="connectBots()">▶ Подключить</button>
                    <button class="warning" onclick="connectBotsWithInterval()">⏱ С интервалом</button>
                </div>
                
                <div class="selection-actions">
                    <button class="secondary" onclick="selectAllBots()">✓ Выбрать всех</button>
                    <button class="secondary" onclick="deselectAllBots()">✗ Снять выбор</button>
                    <button class="danger" onclick="disconnectAllBots()">⏻ Откл. всех</button>
                </div>
            </div>
            
            <div class="panel">
                <h2>🎮 Управление</h2>
                <div class="form-group">
                    <label>Сообщение:</label>
                    <input type="text" id="message" placeholder="Введите сообщение..." onkeypress="if(event.key==='Enter')sendMessage()">
                </div>
                <div class="form-row">
                    <button onclick="sendToSelected()">👥 Выбранным</button>
                    <button class="success" onclick="sendToAllBots()">📢 Всем</button>
                </div>
                
                <h3 style="margin: 15px 0 5px;">🚶 Движение</h3>
                <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px;">
                    <button onclick="controlSelected('forward')">↑</button>
                    <button onclick="controlSelected('left')">←</button>
                    <button onclick="controlSelected('back')">↓</button>
                    <button onclick="controlSelected('right')">→</button>
                    <button onclick="controlSelected('jump')">⤴</button>
                </div>
            </div>
        </div>
        
        <h2>📋 Список ботов</h2>
        <div id="botsList" class="bots-grid"></div>
        
        <!-- GUI секция как в примере -->
        <div class="gui-container">
            <h2 style="margin-top: 0;">🪟 GUI / Меню</h2>
            <p style="color: #8b949e;">Открытые окна (/shop, /grief, /menu и т.д.)</p>
            
            <div class="quick-commands">
                <button onclick="sendCommand('/shop')">/shop</button>
                <button onclick="sendCommand('/grief')">/grief</button>
                <button onclick="sendCommand('/menu')">/menu</button>
                <button onclick="sendCommand('/kit')">/kit</button>
                <button onclick="sendCommand('/warp')">/warp</button>
                <button onclick="sendCommand('/spawn')">/spawn</button>
                <button onclick="sendCommand('/home')">/home</button>
                <button onclick="sendCommand('/trade')">/trade</button>
            </div>
            
            <div class="command-row">
                <input type="text" id="customCommand" placeholder="/command" value="/shop">
                <button class="success" onclick="sendCustomCommand()">Отправить команду</button>
            </div>
            
            <div class="window-title" id="windowTitle">Нет открытого окна</div>
            
            <!-- Сетка слотов как в примере -->
            <div id="inventory"></div>
            
            <div style="display: flex; gap: 10px; justify-content: center;">
                <button class="secondary" onclick="refreshWindowInfo()">🔄 Обновить</button>
            </div>
        </div>
        
        <h2>💬 Чат</h2>
        <div id="chatLog" class="chat-container"></div>
        
        <h2>👁 3D просмотр</h2>
        <div id="viewerPorts" class="viewer-links"></div>
    </div>
    
    <div id="notification" class="notification">
        <span id="notificationText">Готово!</span>
    </div>
    
    <script>
        let selectedBots = new Set();
        let botsData = {};
        
        document.addEventListener('DOMContentLoaded', function() {
            const autoAuth = document.getElementById('autoAuth');
            const passwordRow = document.getElementById('passwordRow');
            autoAuth.addEventListener('change', function() {
                passwordRow.style.display = this.checked ? 'block' : 'none';
            });
        });
        
        function showNotification(message, type = 'success') {
            const notification = document.getElementById('notification');
            document.getElementById('notificationText').textContent = message;
            notification.style.backgroundColor = type === 'error' ? '#c62828' : type === 'warning' ? '#bf8700' : '#161b22';
            notification.style.display = 'flex';
            setTimeout(() => {
                notification.style.display = 'none';
            }, 3000);
        }
        
        async function connectBots() {
            const serverAddress = document.getElementById('serverAddress').value.trim();
            const serverPort = document.getElementById('serverPort').value.trim();
            const nickname = document.getElementById('nickname').value.trim();
            const botCount = parseInt(document.getElementById('botCount').value) || 1;
            const version = document.getElementById('version').value.trim();
            const autoAuth = document.getElementById('autoAuth').checked;
            const password = document.getElementById('authPassword').value.trim();
            
            for (let i = 0; i < botCount; i++) {
                const botUsername = botCount > 1 ? nickname + '_' + i : nickname;
                
                try {
                    const response = await fetch('/connect', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            host: serverAddress,
                            port: serverPort || 25565,
                            username: botUsername,
                            version: version || false,
                            autoAuth: autoAuth,
                            password: password
                        })
                    });
                    
                    const data = await response.json();
                    if (data.success) {
                        showNotification('Бот ' + botUsername + ' подключается...');
                    }
                } catch (error) {
                    showNotification('Ошибка: ' + error.message, 'error');
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        async function connectBotsWithInterval() {
            const serverAddress = document.getElementById('serverAddress').value.trim();
            const serverPort = document.getElementById('serverPort').value.trim();
            const nickname = document.getElementById('nickname').value.trim();
            const botCount = parseInt(document.getElementById('botCount').value) || 1;
            const version = document.getElementById('version').value.trim();
            const interval = parseInt(document.getElementById('interval').value) || 8000;
            const autoAuth = document.getElementById('autoAuth').checked;
            const password = document.getElementById('authPassword').value.trim();
            
            try {
                const response = await fetch('/connect-interval', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        host: serverAddress,
                        port: serverPort || 25565,
                        username: nickname,
                        version: version || false,
                        count: botCount,
                        interval: interval,
                        autoAuth: autoAuth,
                        password: password
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    showNotification(data.message);
                }
            } catch (error) {
                showNotification('Ошибка: ' + error.message, 'error');
            }
        }
        
        async function toggleBotSelection(botId) {
            try {
                const response = await fetch('/select-bot', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ botId })
                });
                
                const data = await response.json();
                if (data.success) {
                    selectedBots = new Set(data.selectedBots);
                    showNotification(data.message);
                    updateBotsList();
                    updateStats();
                }
            } catch (error) {
                showNotification('Ошибка: ' + error.message, 'error');
            }
        }
        
        async function selectAllBots() {
            const response = await fetch('/select-all-bots', { method: 'POST' });
            const data = await response.json();
            if (data.success) {
                selectedBots = new Set(data.selectedBots);
                showNotification(data.message);
                updateBotsList();
                updateStats();
            }
        }
        
        async function deselectAllBots() {
            const response = await fetch('/deselect-all-bots', { method: 'POST' });
            const data = await response.json();
            if (data.success) {
                selectedBots = new Set(data.selectedBots);
                showNotification(data.message);
                updateBotsList();
                updateStats();
            }
        }
        
        async function disconnectBot(botId) {
            const response = await fetch('/disconnect', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ botId })
            });
            
            const data = await response.json();
            if (data.success) {
                selectedBots.delete(parseInt(botId));
                delete botsData[botId];
                showNotification('Бот отключен');
                updateBotsList();
                updateStats();
            }
        }
        
        async function disconnectAllBots() {
            const response = await fetch('/disconnect-all', { method: 'POST' });
            const data = await response.json();
            if (data.success) {
                selectedBots.clear();
                botsData = {};
                showNotification('Все боты отключены');
                updateBotsList();
                updateStats();
            }
        }
        
        async function sendToSelected() {
            const message = document.getElementById('message').value.trim();
            if (!message) return;
            
            const response = await fetch('/send', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ message })
            });
            
            const data = await response.json();
            if (data.success) {
                showNotification('Сообщение отправлено');
                document.getElementById('message').value = '';
            }
        }
        
        async function sendToAllBots() {
            const message = document.getElementById('message').value.trim();
            if (!message) return;
            
            const response = await fetch('/send', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ message, sendToAll: true })
            });
            
            const data = await response.json();
            if (data.success) {
                showNotification('Сообщение отправлено всем');
                document.getElementById('message').value = '';
            }
        }
        
        function sendCommand(command) {
            document.getElementById('customCommand').value = command;
            sendCustomCommand();
        }
        
        async function sendCustomCommand() {
            const command = document.getElementById('customCommand').value.trim();
            if (!command) return;
            
            const response = await fetch('/send-command', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ 
                    botId: 'selected',
                    command: command
                })
            });
            
            const data = await response.json();
            if (data.success) {
                showNotification('Команда ' + command + ' отправлена');
                setTimeout(refreshWindowInfo, 2000);
            }
        }
        
        async function controlSelected(action, value) {
            const response = await fetch('/control', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ action, value, controlSelected: true })
            });
            
            const data = await response.json();
            if (data.success) {
                showNotification('Команда выполнена');
            }
        }
        
        // Функции для GUI как в примере
        async function refreshWindowInfo() {
            if (selectedBots.size === 0) {
                showNotification('Нет выбранных ботов', 'error');
                return;
            }
            
            const botId = Array.from(selectedBots)[0];
            
            try {
                const response = await fetch('/window-info/' + botId);
                const data = await response.json();
                
                if (data.hasWindow) {
                    document.getElementById('windowTitle').textContent = data.title || 'Меню';
                    renderGuiSlots(data.slots);
                } else {
                    document.getElementById('windowTitle').textContent = 'Нет открытого окна';
                    document.getElementById('inventory').innerHTML = '';
                }
            } catch (error) {
                showNotification('Ошибка: ' + error.message, 'error');
            }
        }
        
        function renderGuiSlots(slots) {
            const inventory = document.getElementById('inventory');
            if (!inventory || !slots) return;
            
            let html = '';
            
            for (let i = 0; i < slots.length; i++) {
                const slot = slots[i];
                const hasItem = slot.name !== 'empty';
                
                html += '<div class="slot ' + (hasItem ? '' : 'empty') + '" ';
                html += 'onclick="clickGuiSlot(' + slot.slot + ', 0)" ';
                html += 'oncontextmenu="event.preventDefault(); clickGuiSlot(' + slot.slot + ', 1)">';
                html += hasItem ? '📦' : '⬜';
                if (slot.count > 1) {
                    html += '<span class="count">' + slot.count + '</span>';
                }
                html += '</div>';
            }
            
            inventory.innerHTML = html;
        }
        
        async function clickGuiSlot(slot, mouseButton) {
            try {
                const response = await fetch('/click-gui-slot', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ 
                        botId: 'selected',
                        slot: slot,
                        mouseButton: mouseButton
                    })
                });
                
                const data = await response.json();
                if (data.success) {
                    showNotification('Клик по слоту ' + slot + ' (' + (mouseButton === 0 ? 'ЛКМ' : 'ПКМ') + ')');
                    setTimeout(refreshWindowInfo, 500);
                } else {
                    showNotification('Ошибка: ' + (data.error || 'Не удалось кликнуть'), 'error');
                }
            } catch (error) {
                showNotification('Ошибка: ' + error.message, 'error');
            }
        }
        
        function addToChat(text, type = 'system') {
            const chatLog = document.getElementById('chatLog');
            const messageDiv = document.createElement('div');
            messageDiv.className = 'chat-message ' + type;
            messageDiv.textContent = text;
            chatLog.appendChild(messageDiv);
            chatLog.scrollTop = chatLog.scrollHeight;
        }
        
        function updateBotsList() {
            const botsList = document.getElementById('botsList');
            if (!botsList) return;
            
            if (Object.keys(botsData).length === 0) {
                botsList.innerHTML = '<p style="text-align:center;color:#8b949e;padding:20px;">Нет подключенных ботов</p>';
                return;
            }
            
            let html = '';
            for (const [botId, bot] of Object.entries(botsData)) {
                const isSelected = selectedBots.has(parseInt(botId));
                const isOnline = bot.status === 'online';
                
                html += '<div class="bot-card ' + (isOnline ? 'online' : 'offline') + ' ' + (isSelected ? 'selected' : '') + '">';
                html += '<div class="bot-header">';
                html += '<h3>🤖 ' + bot.username + '</h3>';
                html += '<span class="bot-status ' + (isOnline ? 'online' : 'offline') + '">';
                html += isOnline ? 'Online' : 'Offline';
                html += '</span>';
                html += '</div>';
                html += '<div class="bot-info">';
                html += '<div class="info-line">ID: #' + botId + '</div>';
                html += '<div class="info-line">' + bot.host + ':' + bot.port + '</div>';
                if (bot.viewerPort) {
                    html += '<div class="info-line"><a href="http://localhost:' + bot.viewerPort + '" target="_blank">👁 3D просмотр (порт ' + bot.viewerPort + ')</a></div>';
                }
                html += '</div>';
                html += '<div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 5px;">';
                html += '<button onclick="toggleBotSelection(' + botId + ')" style="background: ' + (isSelected ? '#58a6ff' : '#21262d') + '">';
                html += (isSelected ? '✓ Выбран' : 'Выбрать');
                html += '</button>';
                html += '<button class="danger" onclick="disconnectBot(' + botId + ')">Отключить</button>';
                html += '</div>';
                html += '</div>';
            }
            
            botsList.innerHTML = html;
        }
        
        function updateStats() {
            const total = Object.keys(botsData).length;
            const selected = selectedBots.size;
            const online = Object.values(botsData).filter(b => b.status === 'online').length;
            
            document.getElementById('totalBots').textContent = total;
            document.getElementById('selectedBotsCount').textContent = selected;
            document.getElementById('onlineBots').textContent = online;
        }
        
        // WebSocket для получения обновлений
        const ws = new WebSocket('ws://localhost:' + 3000 + '/ws');
        
        ws.onmessage = function(event) {
            const data = JSON.parse(event.data);
            
            if (data.type === 'chat') {
                addToChat(data.username + ': ' + data.message, 'bot');
            } else if (data.type === 'bot_status') {
                botsData[data.botId] = { ...botsData[data.botId], ...data };
                updateBotsList();
                updateStats();
                
                if (data.status === 'online') {
                    addToChat('✅ Бот ' + data.username + ' подключился', 'system');
                } else if (data.status === 'kicked') {
                    addToChat('❌ Бот ' + data.username + ' кикнут', 'system');
                }
            } else if (data.type === 'window_open') {
                if (selectedBots.has(data.botId)) {
                    document.getElementById('windowTitle').textContent = data.title || 'Меню';
                    renderGuiSlots(data.slots);
                }
                addToChat('📦 ' + data.username + ' открыл меню: ' + (data.title || 'окно'), 'system');
            } else if (data.type === 'window_close') {
                if (selectedBots.has(data.botId)) {
                    document.getElementById('windowTitle').textContent = 'Нет открытого окна';
                    document.getElementById('inventory').innerHTML = '';
                }
                addToChat('📦 Бот закрыл окно', 'system');
            } else if (data.type === 'info') {
                showNotification(data.message);
            } else if (data.type === 'error') {
                showNotification(data.message, 'error');
            }
        };
        
        ws.onopen = function() {
            console.log('WebSocket подключен');
        };
        
        ws.onclose = function() {
            setTimeout(() => {
                showNotification('Переподключение...', 'warning');
                location.reload();
            }, 3000);
        };
        
        setInterval(updateStats, 5000);
    </script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.send(html);
});

const WebSocket = require('ws');
const server = app.listen(port);
const wss = new WebSocket.Server({ server });

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

wss.on('connection', (ws) => {
    bots.forEach(bot => {
        if (bot.connected) {
            ws.send(JSON.stringify({
                type: 'bot_status',
                botId: bot.id,
                username: bot.config.username,
                host: bot.config.host,
                port: bot.config.port,
                viewerPort: bot.viewerPort,
                status: 'online',
                autoAuth: bot.autoAuth
            }));
        }
    });
});

console.log(`Сервер запущен на порту ${port}`);