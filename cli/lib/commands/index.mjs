// 命令注册表：一词英文小写 + 别名 + 中文摘要（顺序即总帮助里的顺序）。
import accounts from './accounts.mjs'
import audit from './audit.mjs'
import { login, logout, whoami } from './auth.mjs'
import channels from './channels.mjs'
import config from './config.mjs'
import doctor from './doctor.mjs'
import keys from './keys.mjs'
import models from './models.mjs'
import proxy from './proxy.mjs'
import rtk from './rtk.mjs'
import settings from './settings.mjs'
import status from './status.mjs'
import sync from './sync.mjs'
import usage from './usage.mjs'
import version from './version.mjs'

export const COMMANDS = [status, channels, models, keys, accounts, proxy, usage, sync, rtk, settings, config, audit, login, logout, whoami, doctor, version]

export function findCommand(name) {
  const key = String(name || '').toLowerCase()
  if (!key) return null
  return COMMANDS.find(command => command.name === key || (command.aliases || []).includes(key)) || null
}
