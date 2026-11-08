import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'

const run = promisify(execFile)
const logger = pino({ level: 'silent' })
const OWNER = 'Lordave'
const PREFIX = '.'
const DATA_DIR = process.env.DATA_DIR || '.'
const SAVE_DIR = `${DATA_DIR}/saved`
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5'
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Safari/537.36'
fs.mkdirSync(SAVE_DIR, { recursive: true })

// ---------- tiny JSON storage ----------
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(`${DATA_DIR}/${f}`, 'utf8')) } catch { return d } }
const save = (f, v) => fs.writeFileSync(`${DATA_DIR}/${f}`, JSON.stringify(v, null, 2))
const settings = { autoVV: true, autoStatus: false, afk: null, ...load('settings.json', {}) }
const notes = load('notes.json', {})
const WATCH = new Set(load('watch.json', (process.env.WATCH || '').split(',').map(s => s.trim()).filter(Boolean)))
const persist = () => { save('settings.json', settings); save('notes.json', notes); save('watch.json', [...WATCH]) }

const EXT = { imageMessage: 'jpg', videoMessage: 'mp4', audioMessage: 'ogg' }
const numberOf = jid => (jid || '').split('@')[0].split(':')[0]
const getJSON = async u => (await fetch(u, { headers: { 'user-agent': UA } })).json()
const getText = async u => (await fetch(u, { headers: { 'user-agent': UA } })).text()
const history = {} // per-chat AI memory
const afkSeen = {}
const startedAt = Date.now()

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(`${DATA_DIR}/auth`)
  const sock = makeWASocket({ auth: state, logger })
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true })
    if (connection === 'open') console.log('Connected')
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) start()
      else console.log('Logged out. Delete the auth folder and rescan.')
    }
  })

  const me = () => jidNormalizedUser(sock.user.id)
  const unwrap = m =>
    m?.viewOnceMessage?.message || m?.viewOnceMessageV2?.message ||
    m?.viewOnceMessageV2Extension?.message || m

  const download = msgLike => downloadMediaMessage(msgLike, 'buffer', {}, {
    logger, reuploadRequest: sock.updateMediaMessage,
  })

  async function saveAndSend(msgLike, label) {
    const type = Object.keys(msgLike.message)[0]
    if (!EXT[type]) return false
    const buffer = await download(msgLike)
    fs.writeFileSync(`${SAVE_DIR}/${Date.now()}.${EXT[type]}`, buffer)
    const content =
      type === 'imageMessage' ? { image: buffer, caption: label } :
      type === 'videoMessage' ? { video: buffer, caption: label } :
      { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }
    await sock.sendMessage(me(), content)
    return true
  }

  const quotedOf = c => {
    const x = c.m.extendedTextMessage?.contextInfo
    if (!x?.quotedMessage) return null
    return { key: { remoteJid: c.jid, id: x.stanzaId, participant: x.participant }, message: unwrap(x.quotedMessage) }
  }

  async function sendUrl(c, url) {
    const res = await fetch(url, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > 50 * 1024 * 1024) throw new Error('File too large (50MB max)')
    const type = (res.headers.get('content-type') || '').split(';')[0]
    let content
    if (type.startsWith('image/')) content = { image: buf }
    else if (type.startsWith('audio/')) content = { audio: buf, mimetype: type }
    else if (type.startsWith('video/')) content = { video: buf }
    else content = { document: buf, mimetype: type || 'application/octet-stream',
                     fileName: url.split('/').pop().split('?')[0] || 'file' }
    await sock.sendMessage(c.jid, content, { quoted: c.msg })
  }

  async function ytdlp(query, audio) {
    const base = `${DATA_DIR}/tmp_${Date.now()}`
    const target = /^https?:\/\//.test(query) ? query : `ytsearch1:${query}`
    const args = audio
      ? ['-x', '--audio-format', 'mp3', '--no-playlist', '-o', `${base}.%(ext)s`, target]
      : ['-f', 'best[ext=mp4][filesize<50M]/best[filesize<50M]/best', '--no-playlist', '-o', `${base}.%(ext)s`, target]
    await run('yt-dlp', args, { timeout: 240000 })
    const file = fs.readdirSync(DATA_DIR).find(f => f.startsWith(path.basename(base)))
    if (!file) throw new Error('Download failed')
    const buf = fs.readFileSync(`${DATA_DIR}/${file}`)
    fs.unlinkSync(`${DATA_DIR}/${file}`)
    if (buf.length > 60 * 1024 * 1024) throw new Error('Result too large for WhatsApp')
    return buf
  }

  // ---------- Command registry ----------
  const commands = {}
  const add = (name, cat, d, fn) => { commands[name] = { cat, d, run: fn } }
  const arg = c => c.args.join(' ')

  // --- Basics
  add('ping', 'Basics', 'Check the bot is alive', async c => {
    const t = Date.now(); await c.reply('pong'); await c.reply(`${Date.now() - t}ms`)
  })
  add('menu', 'Basics', 'List all commands', async c => {
    const groups = {}
    for (const [k, v] of Object.entries(commands)) (groups[v.cat] ||= []).push(`${PREFIX}${k} - ${v.d}`)
    c.reply(Object.entries(groups).map(([g, l]) => `*${g}*\n${l.join('\n')}`).join('\n\n'))
  })
  add('help', 'Basics', 'Same as menu', c => commands.menu.run(c))
  add('about', 'Basics', 'Who made this bot', c => c.reply(`I'm a personal WhatsApp bot created by ${OWNER}.`))
  add('time', 'Basics', 'Current time', c => c.reply(new Date().toLocaleString()))
  add('stats', 'Basics', 'Uptime and memory', c => c.reply(
    `Uptime: ${Math.floor((Date.now() - startedAt) / 60000)} min\nRAM: ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB\n` +
    `Host: ${os.platform()} ${os.arch()}\nNode: ${process.version}\nCommands: ${Object.keys(commands).length}`))

  // --- Settings
  const toggle = (name, key, d) => add(name, 'Settings', d, c => {
    settings[key] = c.args[0] === 'on'; persist(); c.reply(`${key}: ${settings[key] ? 'on' : 'off'}`)
  })
  toggle('autovv', 'autoVV', 'Auto-save view-once: .autovv on|off')
  toggle('autostatus', 'autoStatus', 'Auto-save statuses: .autostatus on|off')
  add('afk', 'Settings', 'Auto-reply to DMs: .afk <message> | .afk off', c => {
    settings.afk = c.args[0] === 'off' || !c.args.length ? null : arg(c); persist()
    c.reply(settings.afk ? `AFK on: ${settings.afk}` : 'AFK off')
  })
  add('watch', 'Settings', 'Relay list: .watch add|remove <number> | list', c => {
    const [sub, num] = c.args
    if (sub === 'add' && num) WATCH.add(num.replace(/\D/g, ''))
    else if (sub === 'remove' && num) WATCH.delete(num.replace(/\D/g, ''))
    persist(); c.reply(`Watching: ${[...WATCH].join(', ') || 'nobody'}`)
  })

  // --- Media
  add('save', 'Media', 'Reply to media/status/view-once to save it', async c => {
    const q = quotedOf(c); if (!q) return c.reply('Reply to a media message with .save')
    if (!(await saveAndSend(q, 'Saved'))) c.reply('Unsupported media type')
  })
  add('dl', 'Media', 'Download a direct file link: .dl <url>', async c => {
    if (!/^https?:\/\//.test(c.args[0] || '')) return c.reply('Usage: .dl <url>')
    await sendUrl(c, c.args[0])
  })
  add('yta', 'Media', 'Song/audio from YouTube etc: .yta <link or name>', async c => {
    if (!c.args.length) return c.reply('Usage: .yta <link or song name>')
    await c.reply('Downloading...')
    await sock.sendMessage(c.jid, { audio: await ytdlp(arg(c), true), mimetype: 'audio/mpeg' }, { quoted: c.msg })
  })
  add('ytv', 'Media', 'Video from YouTube/TikTok etc: .ytv <link or name>', async c => {
    if (!c.args.length) return c.reply('Usage: .ytv <link or search>')
    await c.reply('Downloading...')
    await sock.sendMessage(c.jid, { video: await ytdlp(arg(c), false) }, { quoted: c.msg })
  })
  add('sticker', 'Media', 'Reply to image/video to make a sticker', async c => {
    const q = quotedOf(c); if (!q) return c.reply('Reply to an image or short video')
    const { Sticker } = await import('wa-sticker-formatter')
    const st = new Sticker(await download(q), { pack: OWNER, author: 'Bot', type: 'full', quality: 60 })
    await sock.sendMessage(c.jid, await st.toMessage(), { quoted: c.msg })
  })
  add('qr', 'Media', 'Make a QR code: .qr <text>', c =>
    sendUrl(c, `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(arg(c))}`))
  add('ss', 'Media', 'Screenshot a website: .ss <url>', c =>
    sendUrl(c, `https://image.thum.io/get/width/1280/${c.args[0]}`))
  add('dog', 'Media', 'Random dog photo', async c => sendUrl(c, (await getJSON('https://dog.ceo/api/breeds/image/random')).message))
  add('cat', 'Media', 'Random cat photo', c => sendUrl(c, 'https://cataas.com/cat'))

  // --- Scraping
  add('title', 'Scrape', 'Page title/description/image: .title <url>', async c => {
    const h = await getText(c.args[0])
    const pick = r => (h.match(r) || [])[1]?.trim()
    c.reply([
      `Title: ${pick(/<title[^>]*>([^<]*)<\/title>/i) || '-'}`,
      `Description: ${pick(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']*)/i) || '-'}`,
      `Image: ${pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)/i) || '-'}`,
    ].join('\n'))
  })
  add('links', 'Scrape', 'List links on a page: .links <url>', async c => {
    const h = await getText(c.args[0])
    const base = new URL(c.args[0])
    const out = [...new Set([...h.matchAll(/href=["']([^"'#]+)["']/gi)].map(m => { try { return new URL(m[1], base).href } catch { return null } }).filter(Boolean))]
    c.reply(out.slice(0, 25).join('\n') || 'No links found')
  })
  add('images', 'Scrape', 'List image URLs on a page: .images <url>', async c => {
    const h = await getText(c.args[0])
    const base = new URL(c.args[0])
    const out = [...new Set([...h.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => { try { return new URL(m[1], base).href } catch { return null } }).filter(Boolean))]
    c.reply(out.slice(0, 15).join('\n') || 'No images found')
  })
  add('text', 'Scrape', 'Readable text of a page: .text <url>', async c => {
    const h = await getText(c.args[0])
    const t = h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    c.reply(t.slice(0, 1800) || 'No text found')
  })
  add('short', 'Scrape', 'Shorten a link: .short <url>', async c =>
    c.reply(await getText(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(c.args[0])}`)))
  add('ip', 'Scrape', 'IP/domain info: .ip <ip>', async c => {
    const d = await getJSON(`https://ipwho.is/${c.args[0] || ''}`)
    c.reply(d.success ? `${d.ip}\n${d.city}, ${d.region}, ${d.country}\nISP: ${d.connection?.isp}` : 'Lookup failed')
  })

  // --- Smart / AI
  add('ai', 'Smart', 'Ask the AI (remembers chat): .ai <question> | .ai reset', async c => {
    const q = arg(c)
    if (!q) return c.reply('Usage: .ai <question>')
    if (q === 'reset') { delete history[c.jid]; return c.reply('Memory cleared') }
    if (!process.env.ANTHROPIC_API_KEY) return c.reply('Set ANTHROPIC_API_KEY first')
    const h = (history[c.jid] ||= [])
    h.push({ role: 'user', content: q })
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1000,
        system: `You are a smart personal WhatsApp assistant created by ${OWNER}. If asked who made you, say ${OWNER}. Keep replies short and chat-friendly.`,
        messages: h.slice(-12),
      }),
    })
    const data = await res.json()
    const out = data.content?.map(b => b.text || '').join('') || data.error?.message || 'No response'
    h.push({ role: 'assistant', content: out })
    c.reply(out)
  })
  add('tr', 'Smart', 'Translate: .tr <lang code> <text>', async c => {
    const [lang, ...rest] = c.args
    const d = await getJSON(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(rest.join(' '))}&langpair=autodetect|${lang}`)
    c.reply(d.responseData?.translatedText || 'Translation failed')
  })
  add('define', 'Smart', 'Dictionary: .define <word>', async c => {
    const d = await getJSON(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(c.args[0])}`)
    const m = d[0]?.meanings?.[0]
    c.reply(m ? `${d[0].word} (${m.partOfSpeech})\n${m.definitions[0].definition}` : 'Not found')
  })
  add('wiki', 'Smart', 'Wikipedia summary: .wiki <topic>', async c => {
    const d = await getJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(arg(c))}`)
    c.reply(d.extract || 'Not found')
  })
  add('weather', 'Smart', 'Weather: .weather <city>', async c =>
    c.reply(await getText(`https://wttr.in/${encodeURIComponent(arg(c))}?format=3`)))
  add('currency', 'Smart', 'Convert: .currency 100 usd ngn', async c => {
    const [amt, from, to] = c.args
    const d = await getJSON(`https://open.er-api.com/v6/latest/${from.toUpperCase()}`)
    const r = d.rates?.[to.toUpperCase()]
    c.reply(r ? `${amt} ${from.toUpperCase()} = ${(amt * r).toFixed(2)} ${to.toUpperCase()}` : 'Unknown currency')
  })

  // --- Fun
  add('joke', 'Fun', 'Random joke', async c => { const d = await getJSON('https://official-joke-api.appspot.com/random_joke'); c.reply(`${d.setup}\n${d.punchline}`) })
  add('quote', 'Fun', 'Random quote', async c => { const d = (await getJSON('https://zenquotes.io/api/random'))[0]; c.reply(`"${d.q}" - ${d.a}`) })
  add('advice', 'Fun', 'Random advice', async c => c.reply((await getJSON('https://api.adviceslip.com/advice')).slip.advice))
  add('catfact', 'Fun', 'Random cat fact', async c => c.reply((await getJSON('https://catfact.ninja/fact')).fact))
  add('flip', 'Fun', 'Flip a coin', c => c.reply(Math.random() < 0.5 ? 'Heads' : 'Tails'))
  add('dice', 'Fun', 'Roll a dice', c => c.reply(String(1 + Math.floor(Math.random() * 6))))
  add('8ball', 'Fun', 'Magic 8-ball: .8ball <question>', c => c.reply(
    ['Yes', 'No', 'Maybe', 'Definitely', 'Ask again later', 'Unlikely', 'Without a doubt'][Math.floor(Math.random() * 7)]))
  add('rand', 'Fun', 'Random number: .rand 1 100', c => {
    const [a = 1, b = 100] = c.args.map(Number); c.reply(String(a + Math.floor(Math.random() * (b - a + 1))))
  })
  add('choose', 'Fun', 'Pick one: .choose a | b | c', c => {
    const o = arg(c).split('|').map(s => s.trim()).filter(Boolean); c.reply(o[Math.floor(Math.random() * o.length)] || 'Give me options')
  })

  // --- Tools
  add('calc', 'Tools', 'Calculator: .calc 2*(3+4)', c => {
    const e = arg(c).replace(/\^/g, '**')
    if (!/^[\d+\-*/().%\s]+$/.test(e)) return c.reply('Numbers and + - * / ( ) % ^ only')
    c.reply(String(Function(`"use strict"; return (${e})`)()))
  })
  add('pass', 'Tools', 'Generate a password: .pass 16', c => c.reply(
    crypto.randomBytes(48).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, Math.min(+c.args[0] || 16, 64))))
  add('uuid', 'Tools', 'Generate a UUID', c => c.reply(crypto.randomUUID()))
  add('hash', 'Tools', 'SHA-256 of text: .hash <text>', c => c.reply(crypto.createHash('sha256').update(arg(c)).digest('hex')))
  add('b64e', 'Tools', 'Base64 encode', c => c.reply(Buffer.from(arg(c)).toString('base64')))
  add('b64d', 'Tools', 'Base64 decode', c => c.reply(Buffer.from(arg(c), 'base64').toString('utf8')))
  add('reverse', 'Tools', 'Reverse text', c => c.reply([...arg(c)].reverse().join('')))
  add('upper', 'Tools', 'UPPERCASE text', c => c.reply(arg(c).toUpperCase()))
  add('lower', 'Tools', 'lowercase text', c => c.reply(arg(c).toLowerCase()))
  add('wc', 'Tools', 'Word/char count', c => c.reply(`Words: ${c.args.length}\nChars: ${arg(c).length}`))
  add('remind', 'Tools', 'Reminder in minutes: .remind 10 call mom', c => {
    const mins = Number(c.args[0]); const text = c.args.slice(1).join(' ')
    if (!mins || !text) return c.reply('Usage: .remind <minutes> <text>')
    setTimeout(() => sock.sendMessage(me(), { text: `Reminder: ${text}` }), mins * 60000)
    c.reply(`I'll remind you in ${mins} min (lost if the bot restarts)`)
  })
  add('note', 'Tools', 'Save/read a note: .note <name> [text]', c => {
    const [name, ...rest] = c.args
    if (!name) return c.reply('Usage: .note <name> [text]')
    if (rest.length) { notes[name] = rest.join(' '); persist(); return c.reply('Saved') }
    c.reply(notes[name] || 'No such note')
  })
  add('notes', 'Tools', 'List notes', c => c.reply(Object.keys(notes).join(', ') || 'No notes'))
  add('delnote', 'Tools', 'Delete a note: .delnote <name>', c => { delete notes[c.args[0]]; persist(); c.reply('Deleted') })

  // --- Groups
  add('tagall', 'Groups', 'Mention everyone in a group', async c => {
    if (!c.jid.endsWith('@g.us')) return c.reply('Groups only')
    const meta = await sock.groupMetadata(c.jid)
    const ids = meta.participants.map(p => p.id)
    await sock.sendMessage(c.jid, { text: ids.map(i => `@${numberOf(i)}`).join(' '), mentions: ids })
  })
  add('groupinfo', 'Groups', 'Group details', async c => {
    if (!c.jid.endsWith('@g.us')) return c.reply('Groups only')
    const m = await sock.groupMetadata(c.jid)
    c.reply(`${m.subject}\nMembers: ${m.participants.length}\nCreated: ${new Date(m.creation * 1000).toDateString()}`)
  })

  // ---------- Message handler ----------
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      try {
        if (!msg.message) continue
        const jid = msg.key.remoteJid
        const m = msg.message

        // View-once auto-save
        const inner = m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message
        if (inner && settings.autoVV && !msg.key.fromMe) {
          await saveAndSend({ key: msg.key, message: inner }, `View-once from ${msg.pushName || jid}`)
          continue
        }

        // Status auto-save
        if (jid === 'status@broadcast') {
          if (settings.autoStatus && !msg.key.fromMe)
            await saveAndSend(msg, `Status from ${msg.pushName || msg.key.participant}`)
          continue
        }

        // Relay selected people into your own chat
        const sender = numberOf(msg.key.participant || jid)
        if (!msg.key.fromMe && WATCH.has(sender)) {
          const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || ''
          const label = `From ${msg.pushName || sender}${jid.endsWith('@g.us') ? ' (group)' : ''}:`
          const mt = Object.keys(m)[0]
          if (EXT[mt]) await saveAndSend(msg, `${label} ${text}`.trim())
          else await sock.sendMessage(me(), { text: `${label}\n${text || `[${mt}]`}` })
        }

        // AFK auto-reply (DMs only, once per hour per person)
        if (!msg.key.fromMe && settings.afk && !jid.endsWith('@g.us')) {
          if (!afkSeen[jid] || Date.now() - afkSeen[jid] > 3600000) {
            afkSeen[jid] = Date.now()
            await sock.sendMessage(jid, { text: `${OWNER} is away: ${settings.afk}` })
          }
        }

        // Commands (only from you)
        if (!msg.key.fromMe) continue
        const text = m.conversation || m.extendedTextMessage?.text || ''
        if (!text.startsWith(PREFIX)) continue
        const [name, ...args] = text.slice(PREFIX.length).trim().split(/\s+/)
        const cmd = commands[name.toLowerCase()]
        if (!cmd) continue
        const c = { msg, m, jid, args, reply: t => sock.sendMessage(jid, { text: t }, { quoted: msg }) }
        try { await cmd.run(c) } catch (e) { await c.reply(`Error: ${e.message}`) }
      } catch (e) {
        console.error('Handler error:', e.message)
      }
    }
  })
}

// Tiny health endpoint (for uptime pings / hosts that expect a port)
http.createServer((_, res) => res.end('ok')).listen(process.env.PORT || 3000)

start()
