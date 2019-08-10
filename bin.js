#!/usr/bin/env node

'use strict'

const pino = require('pino')
const log = pino({name: 'tg-gif-export-bot'})

const URI = require('urijs')
const path = require('path')
const mainURL = process.argv[3]

const hapi = require('@hapi/hapi')
const boom = require('@hapi/boom')

const emoji = require('emoji-dictionary')
const prom = (f) => new Promise((resolve, reject) => f((err, res) => err ? reject(err) : resolve(res)))
const renderLottie = require('puppeteer-lottie')
const zlib = require('zlib')
const fs = require('fs')

const HELLO = `*This bot turns Telegram GIFs into real .gifs!*

Just send me your GIFs and I'll convert them!
 \\* Links to .mp4s get downloaded and converted as well
 \\* Animated stickers are also supported

Oh, and could you please...
 \\* Report bugs when you spot them: https://github.com/mkg20001/tg-sticker-convert-bot/issues
 \\* Donate: https://paypal.me/mkg20001
`

const core = require('teleutils')('gif-export-bot', {
  token: process.argv[2],
  helloMessage: HELLO
})

async function doConvert (input, reply, opt) {
  let output = core.tmp('_converted.gif')

  log.info({input: input.path, output: output.path}, 'Converting...')

  await core.exec('ffmpeg', ['-i', input.path, output.path])

  await postConvert(input, output, reply, opt)
}
async function postConvert (input, output, reply, opt) {
  let {chat: {id: cid}, message_id: msgId, document: {file_id: id, file_name: fName}} = await reply.file(output.path, opt)
  if (fName.endsWith('_')) { fName = fName.replace(/_$/, '') }
  fName = encodeURI(fName)

  await bot.sendMessage(cid, `Here's the link to download the GIF: ${mainURL}/${id}/${fName}?dl=1

And here's the preview: ${mainURL}/${id}/${fName}

Donate to keep this bot up! https://paypal.me/mkg20001`, {webPreview: false, replyToMessage: msgId})

  // clean disk
  input.cleanup()
  output.cleanup()
}

const nameToGif = (name) => {
  name = path.basename(name)
  const parsed = path.parse(name)
  parsed.ext = '.gif_'
  delete parsed.base
  return path.format(parsed)
}

const beConfused = async (msg) => {
  return msg.reply.file(path.join(__dirname, 'confused.webp'), {fileName: 'confused.webp', asReply: true})
}
const handleSticker = async (msg) => {
  const sticker = msg.sticker

  const location = await core.fetch.tg(sticker)

  if (sticker.is_animated) {
    let buffer = await prom(cb => fs.readFile(location.path, cb))
    if (buffer[0] !== 123) { // 123 is {, if not at begin then ungzip first
      buffer = await prom(cb => zlib.gunzip(buffer, cb))
    }
    location.cleanup() // cleanup original file

    // we have a JSON file now
    const lottie = core.tmp('_sticker.json')
    const generated = core.tmp('_generated.gif')
    fs.writeFileSync(lottie.path, buffer)

    await renderLottie({
      path: lottie.path,
      output: generated.path,
      width: sticker.width,
      height: sticker.height,
      style: {
        background: 'black'
      }
    })

    await msg.track('convert/animated_sticker')
    await postConvert(lottie, generated, msg.reply, {fileName: nameToGif('animated_sticker.gif'), asReply: true})
  } else {
    await msg.reply.text('This sticker isn\'t animated. There\'s no point in converting it into a gif, but have your GIF anyways :P', {asReply: true})
    const gif = core.tmp('_generated.gif')
    await core.exec('convert', [location.path, gif.path])
    await msg.track('convert/sticker')
    await postConvert(location, gif, msg.reply, {fileName: nameToGif((msg.sticker.emoji ? emoji.getName(msg.sticker.emoji) + '_sticker' : 'sticker') + '.gif'), asReply: true})
  }
}
const handleDocument = async (msg) => {
  const doc = msg.document
  if (!doc.mime_type.startsWith('video/')) {
    return msg.reply.text('That doesn\'t look like a video')
  }

  const location = await core.fetch.tg(doc)

  await msg.track('convert/document')
  await doConvert(location, msg.reply, {fileName: nameToGif(doc.file_name || 'animation.gif'), asReply: true})
}
const handleText = async (msg) => {
  if (msg.text.trim().startsWith('/')) { // ignore cmds
    return
  }

  let urls = []
  URI.withinString(msg.text, (url) => urls.push(url))
  if (!urls.length) {
    // TODO: friendly error
    return msg.reply.text('Didn\'t find any URLs in your message', {asReply: true})
  }

  if (urls.length > 20) {
    // TODO: friendly error
    return msg.reply.text('Too many URLs!')
  }

  await Promise.all(urls.map(async (url) => {
    try {
      const loc = await core.fetch.web(url)
      await doConvert(loc, msg.reply, {fileName: nameToGif(url), asReply: true})
    } catch (e) {
      // TODO: rewrite
      msg.reply.text('ERROR: Couldn\'t convert ' + url, {webPreview: false, asReply: true})
      log.error(e)
      core.error.captureException(e)
    }
  }))
}

const {bot} = core

bot.on('sticker', handleSticker)
bot.on('document', handleDocument)
bot.on('photo', beConfused)
bot.on('text', handleText)
bot.on('forward', (msg) => {
  switch (true) {
    case Boolean(msg.sticker):
      return handleSticker(msg)
    case Boolean(msg.document):
      return handleDocument(msg)
    case Boolean(msg.text):
      return handleText(msg)
    case Boolean(msg.photo):
      return beConfused(msg)
    default: {} // eslint-disable-line no-empty
  }
})

const main = async () => {
  const server = hapi.server({
    port: 12486,
    host: 'localhost'
  })

  await server.register({
    plugin: require('hapi-pino'),
    options: {name: 'tg-gif-export-bot'}
  })

  if (process.env.SENTRY_DSN) { // TODO: this seems to cause heap out of memory
    await server.register({
      plugin: require('hapi-sentry'),
      options: {client: core.error}
    })
  }

  await server.register({
    plugin: require('@hapi/inert')
  })

  await server.route({
    path: '/',
    method: 'GET',
    handler: async (request, h) => {
      return h.redirect('https://t.me/gif_export_bot')
    }
  })

  await server.route({
    path: '/{id}/{real}',
    method: 'GET',
    config: {
      handler: async (request, h) => {
        let file
        try {
          file = await bot.getFile(request.params.id)
        } catch (e) {
          if (e.error_code === 400) {
            throw boom.notFound()
          } else {
            throw e
          }
        }
        log.info(file, 'Downloading %s...', file.file_id)
        const loc = await core.fetch.web(file.fileLink, path.basename(file.file_path || ''))

        if (request.query.dl) {
          return h.file(loc.path, {confine: false}).header('content-description', 'File Transfer').header('type', 'application/octet-stream').header('content-disposition', 'attachment; filename=' + JSON.stringify(request.params.real)).header('content-transfer-encoding', 'binary')
        } else {
          return h.file(loc.path, {confine: false}).type('image/gif')
        }

        // TODO: call loc.cleanup() afterwards
      }
    }
  })

  await server.start()

  core.start()
}

main().then(() => {}, console.error)
