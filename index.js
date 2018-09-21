#!/usr/bin/env node

const appConf = require('app-conf')
const blocked = require('blocked-at')
const defer = require('golike-defer').default
const fromCallback = require('promise-toolbox/fromCallback')
const fromEvent = require('promise-toolbox/fromEvent')
const redis = require('redis')
const { Xapi } = require('xen-api')

const asyncMap = require('./async-map')
const RedisCollection = require('./collection/redis')

class Servers extends RedisCollection {
  async create(params) {
    const { host } = params

    if (await this.exists({ host })) {
      throw new Error('server already exists')
    }

    return /* await */ this.add(params)
  }

  async get(properties) {
    const servers = await super.get(properties)

    // Deserializes
    servers.forEach(server => {
      if (server.error) {
        server.error = parseProp('server', server, 'error', '')
      } else {
        delete server.error
      }
    })

    return servers
  }
}

const createRedisClient = ({ redis: config = {} }) =>
  redis.createClient({
    path: config.socket,
    rename_commands: config.rename_commands,
    url: config.uri,
  })

const main = defer(async $defer => {
  blocked((time, stack) => {
    console.log(`Blocked for ${time}ms, operation started here:`, stack)
  })

  const config = await appConf.load('xo-server', {
    appDir: `/usr/local/share/node_modules/xo-server/`,
    ignoreUnknownFormats: true,
  })

  const redisClient = createRedisClient(config)
  $defer(fromCallback, cb => redisClient.quit(cb))

  const serversDb = new Servers({
    connection: redisClient,
    prefix: 'xo:server',
    indexes: ['host'],
  })

  const xapis = await asyncMap(serversDb.get(), async server => {
    const xapi = new Xapi({
      allowUnauthorized: Boolean(server.allowUnauthorized),
      auth: {
        user: server.username,
        password: server.password,
      },
      readOnly: true,
      url: server.host,
    })
    await xapi.connect()
    console.log('connected to %s', xapi._humanId)

    $defer(async () => {
      await xapi.disconnect()
      console.log('disconnected from %s', xapi._humanId)
    })

    return xapi
  })

  await fromEvent(process, 'SIGINT')
  console.log('SIGINT received, stopping…')
})
main().catch(console.error.bind(console, 'FATAL'))
