import { prepare, start, verifySnapshots, defaultRuntime } from '../deploy/magpie/local.mjs'

const [command, ...args] = process.argv.slice(2)
const options = {}
for (let i = 0; i < args.length; i += 2) {
  const names = { '--runtime': 'runtime', '--source': 'source', '--catalog': 'catalogPath',
    '--bridge-port': 'bridgePort', '--gateway-port': 'gatewayPort', '--web-port': 'webPort' }
  const key = names[args[i]]
  if (!key || !args[i + 1]) throw new Error('Unknown option or missing value')
  options[key] = key.endsWith('Port') ? Number(args[i + 1]) : args[i + 1]
}

try {
  if (command === 'prepare') console.log(JSON.stringify(await prepare(options), null, 2))
  else if (command === 'start') await start(options.runtime || defaultRuntime)
  else if (command === 'verify') console.log(JSON.stringify(await verifySnapshots(options.runtime || defaultRuntime), null, 2))
  else throw new Error('Usage: node scripts/magpie-local.mjs prepare|start|verify [--runtime DIR] [--source DIR] [--catalog FILE]')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
