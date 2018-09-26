#!/usr/bin/env node

global.Promise = require('bluebird')

const appConf = require('app-conf')
const blocked = require('blocked-at')
const defer = require('golike-defer').default
const fromCallback = require('promise-toolbox/fromCallback')
const fromEvent = require('promise-toolbox/fromEvent')
const redis = require('redis')
const size = require('lodash/size')
const Statsd = require('node-statsd-client')
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
  const statsd = new Statsd.Client('localhost', 8125)

  const config = await appConf.load('xo-server', {
    appDir: `/usr/local/share/node_modules/xo-server/`,
    ignoreUnknownFormats: true,
  })

  blocked(
    (time, stack) => {
      statsd.timing('blocked', time)

      console.warn(
        `%s - Blocked for %sms, operation started here:`,
        new Date().toISOString(),
        time
      )
      console.warn(stack.join('\n'))
    },
    {
      threshold: 50,
    }
  )

  const redisClient = createRedisClient(config)
  $defer(fromCallback, cb => redisClient.quit(cb))

  const serversDb = new Servers({
    connection: redisClient,
    prefix: 'xo:server',
    indexes: ['host'],
  })

  let size = 0
  const updateSize = diff => {
    statsd.count('objects', (size += diff))
  }
  updateSize(0)

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

    const { objects } = xapi
    xapi.on('add', objects => {
      updateSize(size(objects))
    })
    xapi.on('remove', objects => {
      updateSize(-size(objects))
    })

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
