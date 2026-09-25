import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const service = fs.readFileSync(new URL('../deploy/systemd/crosery-nginx-policy-sync.service', import.meta.url), 'utf8')
const pathUnit = fs.readFileSync(new URL('../deploy/systemd/crosery-nginx-policy-sync.path', import.meta.url), 'utf8')
const location = fs.readFileSync(new URL('../deploy/nginx/ai-crsery-location-snippet.conf', import.meta.url), 'utf8')
const zone = fs.readFileSync(new URL('../deploy/nginx/ibuki-perip-limit.conf', import.meta.url), 'utf8')

test('root worker has fixed paths and a constrained one-shot systemd sandbox', () => {
  assert.match(service, /Type=oneshot/)
  assert.match(service, /ExecStart=\/opt\/crosery-api-console\/node_modules\/\.bin\/tsx server\/nginxUnlimitedApplyCli\.ts/)
  assert.match(service, /NoNewPrivileges=true/)
  assert.match(service, /ProtectSystem=full/)
  assert.match(service, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/)
  assert.match(service, /ReadWritePaths=\/opt\/crosery-api-console\/data \/etc\/nginx\/generated \/etc\/nginx\/backup\/crosery-api-console/)
  assert.doesNotMatch(service, /%[iInN]/)
  assert.doesNotMatch(service, /\/bin\/(?:ba)?sh|-c\s/)
})

test('path unit watches only the fixed root-owned policy file', () => {
  assert.match(pathUnit, /PathChanged=\/opt\/crosery-api-console\/data\/nginx-unlimited-policy\.json/)
  assert.match(pathUnit, /Unit=crosery-nginx-policy-sync\.service/)
  assert.doesNotMatch(pathUnit, /PathExistsGlob|DirectoryNotEmpty/)
})

test('nginx keeps fail-closed default while generated unlimited keys clear the zone key', () => {
  assert.match(location, /set \$ibuki_perip_key \$binary_remote_addr;/)
  assert.match(location, /include \/etc\/nginx\/generated\/crosery-console-unlimited\.conf;/)
  assert.match(location, /limit_conn ibuki_perip 5;/)
  assert.match(location, /limit_conn_status 429;/)
  assert.doesNotMatch(location, /fangzhiyu|Bearer sk-/)
  assert.equal((zone.match(/limit_conn_zone/g) || []).length, 1)
  assert.match(zone, /zone=ibuki_perip:10m/)
})
