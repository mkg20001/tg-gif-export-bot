#!/usr/bin/env node

'use strict'

const pino = require('pino')
const log = pino({name: 'tg-gif-export-bot'})

const URI = require('urijs')
const path = require('path')
const mainURL = process.argv[3]
const renderLottie = require('puppeteer-lottie')
const fs = require('fs')

const hapi = require('@hapi/hapi')
const boom = require('@hapi/boom')

const HELLO = `*This bot turns Telegram GIFs into real .gifs!*

Just send me your GIFs and I'll convert them!
 \\* Links to .mp4s get downloaded and converted as well

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

  await postConvert(reply, input, output, opt)
}
async function doConvertTGS (input, reply, opt) {
  /*

  TODO:
   - check input gzip, decomp

  */

  const output = core.tmp('_converted.gif')

  await renderLottie({
    path: input.path,
    output: output.path,
    width: 640
  })

  await postConvert(reply, input, output, opt)
}
async function postConvert (reply, input, output, opt) {
  let {chat: {id: cid}, message_id: msgId, document: {file_id: id, file_name: fName}} = await reply(Object.assign(opt, {source: fs.createReadStream(output.path)}))
  if (fName.endsWith('_')) { fName = fName.replace(/_$/, '') }
  fName = encodeURI(fName)

  bot.telegram.sendMessage(cid, `Here's the link to download the GIF: ${mainURL}/${id}/${fName}?dl=1

And here's the preview: ${mainURL}/${id}/${fName}

Donate to keep this bot up! https://paypal.me/mkg20001`, {disable_web_page_preview: true, reply_to_message_id: msgId})

  // clean disk
  input.cleanup()
  output.cleanup()
}

const nameToGif = (name) => {
  name = path.basename(name)
  const parsed = path.parse(name)
  parsed.ext = '.gif_'
  delete parsed.base
  const out = path.format(parsed)
  return out.replace(/\.gif\./gmi, '.')
}

const beConfused = async (msg) => {
  console.log(msg.message.message_id)
  return msg.replyWithFile(path.join(__dirname, 'confused.webp'), {file_name: 'confused.webp', reply_to_message_id: msg.message_id})
}
const handleDocument = async (msg) => {
  const doc = msg.message.document
  if (!doc.mime_type.startsWith('video/')) {
    return msg.reply('That doesn\'t look like a video', {reply_to_message_id: msg.message_id})
  }

  const location = await core.fetch.tg(doc)

  await msg.track('convert/document')
  await doConvert(location, msg.replyWithDocument, {file_name: nameToGif(doc.file_name || 'animation.gif'), reply_to_message_id: msg.message_id})
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
const handleSticker = async (msg) => {
  console.log(msg)
}

const {bot} = core

bot.on('sticker', handleSticker)
bot.on('document', handleDocument)
bot.on('photo', beConfused)
bot.on('text', handleText)
bot.on('forward', (msg) => {
  switch (true) {
    case Boolean(msg.document):
      handleDocument(msg)
      break
    case Boolean(msg.text):
      handleText(msg)
      break
    case Boolean(msg.photo):
      beConfused(msg)
      break
    case Boolean(msg.sticker):
      handleSticker(msg)
      break
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
