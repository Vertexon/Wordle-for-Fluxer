import { Client, GatewayDispatchEvents } from '@discordjs/core';
import { REST } from '@discordjs/rest';
import { WebSocketManager } from '@discordjs/ws';
import { createCanvas } from 'canvas';

const token = process.env['FLUXER_BOT_TOKEN'];

if (!token) {
    throw new Error('You forgot the token!');
}

const rest = new REST({ api: 'https://api.fluxer.app', version: '1' }).setToken(token);
const gateway = new WebSocketManager({ intents: 0, rest, token, version: '1' });
const client = new Client({ rest, gateway });

const activeGames = new Map();
const dailyLeaderboards = new Map();
const completedUsersToday = new Set(); // Tracks users who have finished today's game
let dailyWordCache = { dateString: '', word: '' };

const COLOURS = {
    GREEN: '#538d4e',
    YELLOW: '#b59f3b',
    GREY: '#3a3a3c',
    EMPTY: '#121213',
    OUTLINE: '#3a3a3c',
    KEY_AVAIL: '#818384'
};

async function isValidWord(word) {
    try {
        const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
        return response.ok; 
    } catch (error) {
        console.error("Dictionary API failed. Allowing guess to prevent game crash.", error);
        return true;
    }
}

async function getDailyWord() {
    const today = new Date().toISOString().split('T')[0];
    
    if (dailyWordCache.dateString === today && dailyWordCache.word) {
        return dailyWordCache.word;
    }
    
    try {
        const response = await fetch(`https://www.nytimes.com/svc/wordle/v2/${today}.json`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        const secretWord = data.solution.toUpperCase();
        
        // Update cache and wipe the leaderboards/completed lists for the new day
        dailyWordCache = { dateString: today, word: secretWord };
        dailyLeaderboards.clear();
        completedUsersToday.clear(); 
        
        return secretWord;
    } catch (error) {
        console.error("Failed to fetch daily word.", error);
        return 'PLANT';
    }
}

client.on(GatewayDispatchEvents.MessageCreate, async ({ api, data }) => {
    if (data.author.bot) return;

    const content = data.content?.trim().toUpperCase();
    if (!content) return;

    // 1. START GAME
    if (content === '!WORDLE' && data.guild_id) {
        // We fetch the word first to ensure the cache (and completed list) resets if it's a new day
        const secretWord = await getDailyWord();

        if (activeGames.has(data.author.id)) {
            await api.channels.createMessage(data.channel_id, {
                content: "You already have a game in progress in your DMs!",
                message_reference: { message_id: data.id }
            });
            return;
        }

        // Check if the user has already finished today's challenge
        if (completedUsersToday.has(data.author.id)) {
            await api.channels.createMessage(data.channel_id, {
                content: "You have already completed today's official Wordle! Come back tomorrow.",
                message_reference: { message_id: data.id }
            });
            return;
        }
        
        activeGames.set(data.author.id, {
            word: secretWord,
            guesses: [], 
            originChannelId: data.channel_id,
            originGuildId: data.guild_id
        });

        try {
            const dmChannel = await api.users.createDM(data.author.id);
            await api.channels.createMessage(dmChannel.id, {
                content: "🟩 **Wordle Started!**\nReply here with your first 5-letter guess for today's official word."
            });

            await api.channels.createMessage(data.channel_id, {
                content: "I've sent you a DM to start today's official Wordle challenge!",
                message_reference: { message_id: data.id }
            });
        } catch (err) {
            activeGames.delete(data.author.id);
            await api.channels.createMessage(data.channel_id, {
                content: "I couldn't DM you. Please check your privacy settings."
            });
        }
        return;
    }

    // 2. GAMEPLAY
    if (!data.guild_id && activeGames.has(data.author.id)) {
        const game = activeGames.get(data.author.id);

        if (content.length !== 5 || !/^[A-Z]{5}$/.test(content)) {
            await api.channels.createMessage(data.channel_id, {
                content: "Please guess a valid **5-letter** word."
            });
            return;
        }

        const isRealWord = await isValidWord(content);
        if (!isRealWord) {
            await api.channels.createMessage(data.channel_id, {
                content: `**${content}** is not in the dictionary. Please try another word.`
            });
            return;
        }

        game.guesses.push(content);

        const isWin = content === game.word;
        const isGameOver = isWin || game.guesses.length >= 6;

        const imageBuffer = await generateDMImage(game.guesses, game.word);

        if (isGameOver) {
            // Lock the user out from playing again today
            completedUsersToday.add(data.author.id);

            const resultText = isWin 
                ? `🎉 Spot on! The word was **${game.word}**.` 
                : `💀 Hard luck. The word was **${game.word}**.`;

            await api.channels.createMessage(data.channel_id, {
                content: resultText,
                files: [{ name: 'wordle.png', data: imageBuffer }]
            });

            if (!dailyLeaderboards.has(game.originGuildId)) {
                dailyLeaderboards.set(game.originGuildId, []);
            }
            
            const serverBoard = dailyLeaderboards.get(game.originGuildId);
            serverBoard.push({
                username: data.author.username,
                gridColours: calculateGridColours(game.guesses, game.word)
            });

            const summaryBuffer = await generateMultiplayerImage(serverBoard);

            try {
                await api.channels.createMessage(game.originChannelId, {
                    embeds: [{
                        title: `Wordle No. ${dailyWordCache.dateString}`,
                        description: `**${data.author.username}** finished the daily challenge! (${serverBoard.length} player${serverBoard.length > 1 ? 's' : ''} today)`,
                        color: isWin ? 0x538d4e : 0x3a3a3c
                    }],
                    files: [{ name: 'summary.png', data: summaryBuffer }]
                });
            } catch (err) {
                console.error("Failed to post result to server:", err);
            }

            activeGames.delete(data.author.id);
        } else {
            await api.channels.createMessage(data.channel_id, {
                content: `Guess ${game.guesses.length}/6:`,
                files: [{ name: 'wordle.png', data: imageBuffer }]
            });
        }
    }
});

client.on(GatewayDispatchEvents.Ready, ({ data }) => {
    console.log(`Wordle bot is online as @${data.user.username}`);
});

function calculateGridColours(guesses, secretWord) {
    const grid = [];
    for (let row = 0; row < 6; row++) {
        const guess = guesses[row];
        if (!guess) {
            grid.push(Array(5).fill('EMPTY'));
            continue;
        }

        let colours = Array(5).fill('GREY');
        let guessArr = guess.split('');
        let secretArr = secretWord.split('');

        for (let i = 0; i < 5; i++) {
            if (guessArr[i] === secretArr[i]) {
                colours[i] = 'GREEN';
                secretArr[i] = null;
                guessArr[i] = null;
            }
        }
        for (let i = 0; i < 5; i++) {
            if (guessArr[i]) {
                const idx = secretArr.indexOf(guessArr[i]);
                if (idx !== -1) {
                    colours[i] = 'YELLOW';
                    secretArr[idx] = null;
                }
            }
        }
        grid.push(colours);
    }
    return grid;
}

async function generateDMImage(guesses, secretWord) {
    const width = 350;
    const height = 600;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = COLOURS.EMPTY;
    ctx.fillRect(0, 0, width, height);

    const gridColours = calculateGridColours(guesses, secretWord);
    const boxSize = 62;
    const gap = 8;
    const startX = (width - (5 * boxSize + 4 * gap)) / 2;
    const startY = 10;

    ctx.font = 'bold 34px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let row = 0; row < 6; row++) {
        for (let col = 0; col < 5; col++) {
            const x = startX + col * (boxSize + gap);
            const y = startY + row * (boxSize + gap);
            const status = gridColours[row][col];

            if (status === 'EMPTY') {
                ctx.strokeStyle = COLOURS.OUTLINE;
                ctx.lineWidth = 2;
                ctx.strokeRect(x, y, boxSize, boxSize);
            } else {
                ctx.fillStyle = COLOURS[status];
                ctx.fillRect(x, y, boxSize, boxSize);
                ctx.fillStyle = '#ffffff';
                ctx.fillText(guesses[row][col], x + boxSize / 2, y + boxSize / 2 + 2);
            }
        }
    }

    const keyStatus = new Map();
    for (let row = 0; row < guesses.length; row++) {
        const guess = guesses[row];
        for (let col = 0; col < 5; col++) {
            const letter = guess[col];
            const status = gridColours[row][col];
            const current = keyStatus.get(letter);
            
            if (status === 'GREEN') keyStatus.set(letter, 'GREEN');
            else if (status === 'YELLOW' && current !== 'GREEN') keyStatus.set(letter, 'YELLOW');
            else if (status === 'GREY' && current !== 'GREEN' && current !== 'YELLOW') keyStatus.set(letter, 'GREY');
        }
    }

    const rows = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
    const keyW = 28;
    const keyH = 40;
    const keyGap = 6;
    let keyY = startY + 6 * (boxSize + gap) + 15;

    ctx.font = 'bold 16px sans-serif';

    rows.forEach(rowStr => {
        let keyX = (width - (rowStr.length * (keyW + keyGap) - keyGap)) / 2;
        for (let char of rowStr) {
            const status = keyStatus.get(char);
            ctx.fillStyle = status ? COLOURS[status] : COLOURS.KEY_AVAIL;
            
            ctx.beginPath();
            ctx.roundRect(keyX, keyY, keyW, keyH, 4);
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.fillText(char, keyX + keyW / 2, keyY + keyH / 2 + 1);

            keyX += keyW + keyGap;
        }
        keyY += keyH + keyGap;
    });

    return canvas.toBuffer('image/png');
}

async function generateMultiplayerImage(players) {
    const boxSize = 20;
    const gap = 4;
    const playerWidth = (5 * boxSize + 4 * gap) + 40;
    const height = 220;
    const width = Math.max(1, players.length) * playerWidth;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = COLOURS.EMPTY;
    ctx.fillRect(0, 0, width, height);

    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';

    players.forEach((player, index) => {
        const startX = index * playerWidth;
        const centerX = startX + (playerWidth / 2);
        
        ctx.fillStyle = '#ffffff';
        let displayName = player.username.length > 10 ? player.username.substring(0, 8) + '..' : player.username;
        ctx.fillText(displayName, centerX, 30);

        const gridStartX = startX + 20;
        const gridStartY = 50;

        for (let row = 0; row < 6; row++) {
            for (let col = 0; col < 5; col++) {
                const x = gridStartX + col * (boxSize + gap);
                const y = gridStartY + row * (boxSize + gap);
                const status = player.gridColours[row][col];

                if (status === 'EMPTY') {
                    ctx.strokeStyle = COLOURS.OUTLINE;
                    ctx.lineWidth = 1.5;
                    ctx.strokeRect(x, y, boxSize, boxSize);
                } else {
                    ctx.fillStyle = COLOURS[status];
                    ctx.fillRect(x, y, boxSize, boxSize);
                }
            }
        }
    });

    return canvas.toBuffer('image/png');
}

gateway.connect();