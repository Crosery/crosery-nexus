import { createHmac, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'

const COOKIE = 'crosery_console_session'
const MAX_AGE = 12 * 60 * 60 * 1000

function sign(value: string) {
  return createHmac('sha256', config.sessionSecret).update(value).digest('hex')
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function validateCredentials(username: string, password: string, expectedUsername: string, expectedPassword: string) {
  return safeEqual(username, expectedUsername) && safeEqual(password, expectedPassword)
}

export function login(username: string, password: string, response: Response) {
  if (!config.consoleUsername || !config.consolePassword || !config.sessionSecret) throw new Error('控制台登录配置缺失')
  if (!validateCredentials(username, password, config.consoleUsername, config.consolePassword)) return false
  const expires = Date.now() + MAX_AGE
  const payload = `${expires}.${sign(String(expires))}`
  response.cookie(COOKIE, payload, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    maxAge: MAX_AGE,
    path: '/',
  })
  return true
}

export function logout(response: Response) {
  response.clearCookie(COOKIE, { path: '/' })
}

export function isAuthenticated(request: Request) {
  const value = request.cookies?.[COOKIE]
  if (typeof value !== 'string') return false
  const [expiresText, signature] = value.split('.')
  const expires = Number(expiresText)
  return Number.isFinite(expires) && expires > Date.now() && safeEqual(signature || '', sign(expiresText))
}

export function requireAuth(request: Request, response: Response, next: NextFunction) {
  if (!isAuthenticated(request)) return response.status(401).json({ error: '请先登录' })
  next()
}
