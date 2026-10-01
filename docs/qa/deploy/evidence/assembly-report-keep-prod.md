# 组装报告（由 assemble-release.mjs 生成）

- releaseId: `20261001-server-only` ｜ 模式: `keep-prod` ｜ 基底: `20260928-reset-clears-cooldown`
- 本地 commit: `fabd4fe6365925af09401e401556102e71176faf`（工作区干净）
- 组装树: 342 个文件 / 5.88 MB；MANIFEST 条目 339
- 本地文件动作统计: replace=31 keep-prod=159 add=46
- dist: 49 个文件，树哈希 `655bec5e91a5acc6c0be87bd1816a84a42d39df4bb83ca427b9b564c76f1462f`

## 校验结论

| 校验 | 结果 | 说明 |
| --- | --- | --- |
| V1 不缺失生产文件 | PASS | 生产 MANIFEST 299 条；缺失 0；预期缺失（构建元数据/AppleDouble）5；内容变化 31；非 dist 新增 47；dist 替换 0+0 |
| V2 dist 与源码一致 | PASS | keep-prod 模式：未重建 dist（49 个文件，树哈希 655bec5e91a5acc6…） |
| V3 Node 版本 | WARN | 本地构建用的 node：v26.7.0；生产 runtime（/opt/crosery-node-current）：v24.20.0；package.json engines.node：>=24 <25；本地 node major 26 是否落在 >=24 <25：false |
| V4 MANIFEST 自洽 | PASS | 逐条重算比对 |
| V5 禁运清单 | PASS | docs/qa、.env、data、node_modules、*.log、*.tar.gz 均未进入 |

## ⚠ 警告

- V3 本地构建 node v26.7.0 ≠ 生产 runtime v24.20.0：dist 由非生产版本构建，建议改为在生产 release 目录内用 /opt/crosery-node-current 构建（runbook 模式 V），或至少保留本次 WARN 作为已知风险
- V3 本地 node v26.7.0 不满足 engines >=24 <25（生产 node 满足）

## V1 明细

- 缺失的生产文件（必须为空）：无
- 预期缺失（`.cache/*.tsbuildinfo` 构建元数据、AppleDouble）：._.DS_Store, .cache/tsconfig.app.tsbuildinfo, .cache/tsconfig.node.tsbuildinfo, .cache/tsconfig.server.tsbuildinfo, src/._.DS_Store
- 相对生产内容不同的文件：31 个（见 release-plan.md 逐文件表）
- 生产 dist 被替换：0 个旧 chunk 移除、0 个新 chunk 加入（Vue 构建，整体替换，见 V2）
- 新增且生产没有的文件：47 个：.DS_Store, deploy/magpie/CONSOLE-KERNEL.md, deploy/magpie/README.md, deploy/magpie/UPSTREAM.md, deploy/magpie/build.sh, deploy/magpie/kernel/main.go, deploy/magpie/local.mjs, deploy/magpie/upstream/API.md, deploy/magpie/upstream/LICENSE, deploy/magpie/upstream/api.json, docs/research/magpie-cpa-integration.md, packages/contracts/magpie-upstream.generated.ts, packages/contracts/magpie-upstream.ts, scripts/ab-report.mjs, scripts/build-magpie-kernel.mjs, scripts/magpie-api/main.go, scripts/magpie-api/main_test.go, scripts/magpie-console-password.mjs, scripts/magpie-console-password.test.mjs, scripts/magpie-console-smoke.mjs, scripts/magpie-console.mjs, scripts/magpie-local.mjs, scripts/magpie-local.test.mjs, scripts/magpie-service.mjs, scripts/magpie-smoke.mjs, scripts/magpie-upstream.mjs, scripts/magpie-upstream.test.mjs, scripts/tuffex-icon-classes.mjs, server/abLab.ts, server/magpieControl.test.ts, server/magpieControl.ts, server/magpieEngine.test.ts, server/magpieEngine.ts, server/magpieMigration.test.ts, server/magpieMigration.ts, server/magpieOAuth.test.ts, server/magpieOAuth.ts, server/magpieRuntime.ts, server/magpieUpstream.test.ts, server/magpieUpstream.ts …

## 本地文件的发布动作（逐文件，完整）

| 动作 | 文件 | 本地 sha256 | 生产 sha256 |
| --- | --- | --- | --- |
| replace | `.env.example` | `56b919d5aeecd016…` | `01b54bc765cb9577…` |
| replace | `.gitignore` | `50833712bbb06895…` | `4f82f9b1ddee7403…` |
| keep-prod | `deploy/data-plane/BACKUP-RESTORE.md` | `e48908dde9f40690…` | `e48908dde9f40690…` |
| keep-prod | `deploy/data-plane/compose.yaml` | `4bcc3003216dd4b2…` | `4bcc3003216dd4b2…` |
| keep-prod | `deploy/data-plane/cron.example` | `e7cfa2be763e2228…` | `e7cfa2be763e2228…` |
| keep-prod | `deploy/data-plane/data-plane.env.example` | `c4446e380cb12703…` | `c4446e380cb12703…` |
| keep-prod | `deploy/data-plane/Dockerfile.data` | `576d79251dc081e3…` | `576d79251dc081e3…` |
| keep-prod | `deploy/data-plane/Dockerfile.data.dockerignore` | `1dea0359f33f190e…` | `1dea0359f33f190e…` |
| keep-prod | `deploy/data-plane/initdb/10-runtime-roles.sh` | `45e364bdd91000f4…` | `45e364bdd91000f4…` |
| keep-prod | `deploy/data-plane/README.md` | `0f6d1971f32c6ba2…` | `0f6d1971f32c6ba2…` |
| keep-prod | `deploy/data-plane/scripts/archive-wal.sh` | `589882e21e3748fa…` | `589882e21e3748fa…` |
| keep-prod | `deploy/data-plane/scripts/backup.sh` | `740793a5635dbe0b…` | `740793a5635dbe0b…` |
| keep-prod | `deploy/data-plane/scripts/postgres-entrypoint.sh` | `70e790d888ab6326…` | `70e790d888ab6326…` |
| keep-prod | `deploy/data-plane/scripts/wal-sync.sh` | `1ec2ea7d6483ae1a…` | `1ec2ea7d6483ae1a…` |
| keep-prod | `deploy/data-plane/scripts/webdav-base-job.sh` | `84d6005fefa0e229…` | `84d6005fefa0e229…` |
| keep-prod | `deploy/data-plane/scripts/webdav-base-upload.mjs` | `203f57de73bcb5c6…` | `203f57de73bcb5c6…` |
| keep-prod | `deploy/data-plane/scripts/webdav-restore-download.mjs` | `fc6caad0374da643…` | `fc6caad0374da643…` |
| keep-prod | `deploy/data-plane/scripts/webdav-wal-job.sh` | `c77e0cd7830256ee…` | `c77e0cd7830256ee…` |
| keep-prod | `deploy/data-plane/scripts/webdav-wal-upload.mjs` | `559e678d6dbc7170…` | `559e678d6dbc7170…` |
| keep-prod | `deploy/data-plane/scripts/with-file-secrets.sh` | `2474fd2c634b3699…` | `2474fd2c634b3699…` |
| keep-prod | `deploy/data-plane/systemd/crosery-cpe-backup.service` | `e8af723e4f91e302…` | `e8af723e4f91e302…` |
| keep-prod | `deploy/data-plane/systemd/crosery-cpe-backup.timer` | `2ee3136f376cc01d…` | `2ee3136f376cc01d…` |
| keep-prod | `deploy/data-plane/systemd/crosery-cpe-data.service` | `811c71acf9eefb89…` | `811c71acf9eefb89…` |
| keep-prod | `deploy/data-plane/systemd/crosery-cpe-wal-sync.service` | `44a9a5daf2e816c6…` | `44a9a5daf2e816c6…` |
| keep-prod | `deploy/data-plane/systemd/crosery-cpe-wal-sync.timer` | `83b054e95624e3f4…` | `83b054e95624e3f4…` |
| keep-prod | `deploy/data-plane/tailscale-grants.example.hujson` | `66133ce8f6148602…` | `66133ce8f6148602…` |
| keep-prod | `deploy/data-plane/tests/data-secrets.test.sh` | `e737a5926f44bedc…` | `e737a5926f44bedc…` |
| keep-prod | `deploy/data-plane/tests/postgres-secrets.test.sh` | `0b14610cf35a7461…` | `0b14610cf35a7461…` |
| keep-prod | `deploy/data-plane/tests/wal-archive.test.sh` | `46b4789a0fed6c91…` | `46b4789a0fed6c91…` |
| keep-prod | `deploy/edge/README.md` | `f0781bed0d5b6955…` | `f0781bed0d5b6955…` |
| keep-prod | `deploy/edge/systemd/crosery-api-console.service` | `04676d679f32ce86…` | `04676d679f32ce86…` |
| add | `deploy/magpie/build.sh` | `680ff2892d9f1fe2…` | — |
| add | `deploy/magpie/CONSOLE-KERNEL.md` | `b0708e02fd722b8a…` | — |
| add | `deploy/magpie/kernel/main.go` | `febb89ec360db699…` | — |
| add | `deploy/magpie/local.mjs` | `fc9332f51251cd17…` | — |
| add | `deploy/magpie/README.md` | `d3cfc5ccf6c14eaa…` | — |
| add | `deploy/magpie/UPSTREAM.md` | `a28a1dd58f207da1…` | — |
| add | `deploy/magpie/upstream/api.json` | `3b84a81c0a5dd723…` | — |
| add | `deploy/magpie/upstream/API.md` | `0a4e389cd736753c…` | — |
| add | `deploy/magpie/upstream/LICENSE` | `79d2c8444715d4bc…` | — |
| keep-prod | `deploy/nginx/ai-crsery-location-snippet.conf` | `1e06a90ee1c53a0e…` | `1e06a90ee1c53a0e…` |
| keep-prod | `deploy/nginx/console-compression.conf` | `17e71f27b385d4bf…` | `17e71f27b385d4bf…` |
| keep-prod | `deploy/nginx/crosery-console-unlimited.conf` | `dcf9082308616905…` | `dcf9082308616905…` |
| keep-prod | `deploy/nginx/ibuki-perip-limit.conf` | `2e89b19c745018a7…` | `2e89b19c745018a7…` |
| keep-prod | `deploy/systemd/crosery-console-backfill-cost.service` | `ba6c2aaa58f18c68…` | `ba6c2aaa58f18c68…` |
| keep-prod | `deploy/systemd/crosery-console-backfill-cost.timer` | `cc618efb662a4f57…` | `cc618efb662a4f57…` |
| keep-prod | `deploy/systemd/crosery-nginx-policy-sync.path` | `792ff4251b7bc5ca…` | `792ff4251b7bc5ca…` |
| keep-prod | `deploy/systemd/crosery-nginx-policy-sync.service` | `3903d040cdaee452…` | `3903d040cdaee452…` |
| keep-prod | `docs.html` | `454ac019dee8c1b2…` | `454ac019dee8c1b2…` |
| add | `docs/research/magpie-cpa-integration.md` | `0ddc3c64f2e3fe3d…` | — |
| keep-prod | `LICENSE` | `029e26db7aad8db1…` | `029e26db7aad8db1…` |
| add | `MANIFEST.sha256` | `a7d4576f2b853d62…` | — |
| replace | `package-lock.json` | `38617c801a822441…` | `ff7c7f87525c92d2…` |
| replace | `package.json` | `a5ef38f7978965ea…` | `7daf307f5b4b7a09…` |
| keep-prod | `packages/contracts/contracts.test.ts` | `d3a53cf5f4549234…` | `d3a53cf5f4549234…` |
| keep-prod | `packages/contracts/index.ts` | `b30c66606c9520ae…` | `b30c66606c9520ae…` |
| add | `packages/contracts/magpie-upstream.generated.ts` | `1af18692eeef76d6…` | — |
| add | `packages/contracts/magpie-upstream.ts` | `438eb6e44b811eba…` | — |
| keep-prod | `packages/contracts/package.json` | `e339e104c55467fa…` | `e339e104c55467fa…` |
| keep-prod | `packages/contracts/tsconfig.json` | `b145dbd6a2f97db4…` | `b145dbd6a2f97db4…` |
| replace | `README.md` | `b8f7f0654d8416eb…` | `eb6307713ac7322d…` |
| replace | `RELEASE.json` | `f0ec481579cddeea…` | `8b49a789b224a4d6…` |
| add | `scripts/ab-report.mjs` | `38f5de98b70ec7b3…` | — |
| keep-prod | `scripts/backfill-cost.mjs` | `7fb53821c2bc400b…` | `7fb53821c2bc400b…` |
| keep-prod | `scripts/backfill-data-plane.mjs` | `bb9d9737ec55c0e7…` | `bb9d9737ec55c0e7…` |
| keep-prod | `scripts/backfill-data-plane.test.mjs` | `25d660fa1f067d21…` | `25d660fa1f067d21…` |
| keep-prod | `scripts/benchmark-api.mjs` | `8a97ea0f09b33ae6…` | `8a97ea0f09b33ae6…` |
| add | `scripts/build-magpie-kernel.mjs` | `5160b7de1adaff03…` | — |
| keep-prod | `scripts/build-pricing.mjs` | `5d24eadfe8fcf2ba…` | `5d24eadfe8fcf2ba…` |
| keep-prod | `scripts/check-bundle-budget.mjs` | `420a2ebdd5e99474…` | `420a2ebdd5e99474…` |
| add | `scripts/magpie-api/main_test.go` | `f703f90cabeecb9e…` | — |
| add | `scripts/magpie-api/main.go` | `366bd7e9b4bbee91…` | — |
| add | `scripts/magpie-console-password.mjs` | `a316d9d1046761fd…` | — |
| add | `scripts/magpie-console-password.test.mjs` | `1fa1ef114d6c40d9…` | — |
| add | `scripts/magpie-console-smoke.mjs` | `30671e4ad9799ad9…` | — |
| add | `scripts/magpie-console.mjs` | `9e7d03379d31e0f2…` | — |
| add | `scripts/magpie-local.mjs` | `20e8652601a96ee6…` | — |
| add | `scripts/magpie-local.test.mjs` | `5a92de446579cdfc…` | — |
| add | `scripts/magpie-service.mjs` | `86709ec221f5fc12…` | — |
| add | `scripts/magpie-smoke.mjs` | `7639ca93a5b7a2ea…` | — |
| add | `scripts/magpie-upstream.mjs` | `8d48120b273d2bec…` | — |
| add | `scripts/magpie-upstream.test.mjs` | `6396a09c7501b5cd…` | — |
| add | `scripts/tuffex-icon-classes.mjs` | `9307d3f1550ea05c…` | — |
| add | `server/abLab.ts` | `111357b3ad2be12e…` | — |
| keep-prod | `server/accountQuota.test.ts` | `49bcb5a530ea9b50…` | `49bcb5a530ea9b50…` |
| keep-prod | `server/accountQuota.ts` | `73532b3c51123dcb…` | `73532b3c51123dcb…` |
| replace | `server/analyticsNavigationFallback.test.ts` | `8e87d2bcbb4d3da8…` | `411e8a529b0d2dae…` |
| replace | `server/antigravityQuota.test.ts` | `44de2215884703af…` | `0162edd7827a86ba…` |
| keep-prod | `server/antigravityQuota.ts` | `6cafbc02a1b0b970…` | `6cafbc02a1b0b970…` |
| keep-prod | `server/auth.test.ts` | `cc52c9f602fb2f1d…` | `cc52c9f602fb2f1d…` |
| keep-prod | `server/auth.ts` | `3f7f0a2a00cc1319…` | `3f7f0a2a00cc1319…` |
| replace | `server/cacheAnalytics.test.ts` | `6f5151dc3bf0041a…` | `556b3ff49ffdf238…` |
| keep-prod | `server/cacheAnalytics.ts` | `ab8febcfb26eb3c2…` | `ab8febcfb26eb3c2…` |
| replace | `server/cacheLiveHistory.test.ts` | `95c7cad7df211478…` | `5ab8f7f638ab09d9…` |
| keep-prod | `server/cacheLiveHistory.ts` | `4bf4370817b810d8…` | `4bf4370817b810d8…` |
| keep-prod | `server/cacheStats.test.ts` | `b56f7106b7b2eeec…` | `b56f7106b7b2eeec…` |
| keep-prod | `server/cacheStats.ts` | `8840b20be1ac0be4…` | `8840b20be1ac0be4…` |
| keep-prod | `server/cacheTrend.test.ts` | `bf1022730d8d43c9…` | `bf1022730d8d43c9…` |
| keep-prod | `server/cacheTrend.ts` | `b983c3e5a4271e2f…` | `b983c3e5a4271e2f…` |
| keep-prod | `server/channelDiscovery.test.ts` | `9d27632bdd37f6fa…` | `9d27632bdd37f6fa…` |
| keep-prod | `server/channelDiscovery.ts` | `a34a33780080f420…` | `a34a33780080f420…` |
| keep-prod | `server/channels.ts` | `80df0acd7cf85149…` | `80df0acd7cf85149…` |
| replace | `server/channelView.test.ts` | `6719f1d8fd8baa15…` | `c92163cf69a1ed2b…` |
| keep-prod | `server/channelView.ts` | `08378191ed1f0080…` | `08378191ed1f0080…` |
| replace | `server/claudeQuotaCache.test.ts` | `207b6eec6c104b12…` | `8946efb08b6f4d7f…` |
| keep-prod | `server/claudeQuotaCache.ts` | `ae69b7a0fb67cf3a…` | `ae69b7a0fb67cf3a…` |
| keep-prod | `server/clientAgent.test.ts` | `1af7aa6355a5a80b…` | `1af7aa6355a5a80b…` |
| keep-prod | `server/clientAgent.ts` | `a21dca71702505c4…` | `a21dca71702505c4…` |
| keep-prod | `server/codexAccount.test.ts` | `ed4b7d52164089ab…` | `ed4b7d52164089ab…` |
| keep-prod | `server/codexAccount.ts` | `03bca397cee43c42…` | `03bca397cee43c42…` |
| keep-prod | `server/config.test.ts` | `a9c6ec17df91762e…` | `a9c6ec17df91762e…` |
| replace | `server/config.ts` | `66f5760e727e6ef8…` | `77cdbf772bcaed66…` |
| keep-prod | `server/cooldownClear.test.ts` | `cb60cff75b395c4c…` | `cb60cff75b395c4c…` |
| keep-prod | `server/cpa.test.ts` | `c6f250985591a61c…` | `c6f250985591a61c…` |
| replace | `server/cpa.ts` | `cd3ac927d23aeb61…` | `bd97f7ed62279405…` |
| keep-prod | `server/credentials.test.ts` | `b0f151c41f458bc7…` | `b0f151c41f458bc7…` |
| keep-prod | `server/credentials.ts` | `0c9aa582b7159a34…` | `0c9aa582b7159a34…` |
| keep-prod | `server/credentialUpload.test.ts` | `27d1ea80de2b66db…` | `27d1ea80de2b66db…` |
| keep-prod | `server/credentialUpload.ts` | `5c9b74b060eb7987…` | `5c9b74b060eb7987…` |
| keep-prod | `server/credentialUploadBatch.test.ts` | `7183e5a08cddbca7…` | `7183e5a08cddbca7…` |
| keep-prod | `server/credentialUploadBatch.ts` | `06828e245f6db222…` | `06828e245f6db222…` |
| keep-prod | `server/credentialUploadMerge.test.ts` | `8537bba575bfa83f…` | `8537bba575bfa83f…` |
| keep-prod | `server/credentialUploadMerge.ts` | `88d7b75c73c2d88f…` | `88d7b75c73c2d88f…` |
| replace | `server/currentChannels.test.ts` | `6bf797b02237e0ee…` | `7ed4cb7b11967b83…` |
| keep-prod | `server/currentChannels.ts` | `0b5144a8a75c3582…` | `0b5144a8a75c3582…` |
| keep-prod | `server/dashboardSnapshot.test.ts` | `7bffc75d20697c4d…` | `7bffc75d20697c4d…` |
| keep-prod | `server/dashboardSnapshot.ts` | `7984158b99ca12a1…` | `7984158b99ca12a1…` |
| keep-prod | `server/dataPlane.test.ts` | `cf6afcb41f055636…` | `cf6afcb41f055636…` |
| keep-prod | `server/dataPlane.ts` | `995e3b667cd37e8d…` | `995e3b667cd37e8d…` |
| keep-prod | `server/db.ts` | `e2dd87e441702b41…` | `e2dd87e441702b41…` |
| replace | `server/gatewayStatus.test.ts` | `5f5dc4a37868b39b…` | `b92fd0198f58270c…` |
| replace | `server/groups.test.ts` | `c94f1633e0453872…` | `0e4e9717f4788593…` |
| keep-prod | `server/groups.ts` | `31b0fba921f552ce…` | `31b0fba921f552ce…` |
| replace | `server/index.ts` | `e64bb0ad13497977…` | `6d070bcde589beb5…` |
| replace | `server/keyChannelAccess.test.ts` | `7b658726830f5fb6…` | `1aa76dd9ebc6d235…` |
| keep-prod | `server/keyChannelAccess.ts` | `e13a1c640b01ee9e…` | `e13a1c640b01ee9e…` |
| replace | `server/keyModelAccess.test.ts` | `2301ea81133cca23…` | `d67f09a24f728fc6…` |
| keep-prod | `server/keyModelAccess.ts` | `a1b08bce500000c5…` | `a1b08bce500000c5…` |
| keep-prod | `server/keyNaming.test.ts` | `5acfec7d95c80675…` | `5acfec7d95c80675…` |
| keep-prod | `server/keyNaming.ts` | `5a321e480e46b45d…` | `5a321e480e46b45d…` |
| keep-prod | `server/keyPoolReconcile.test.ts` | `4b3d3487a6df8def…` | `4b3d3487a6df8def…` |
| keep-prod | `server/keySecrets.test.ts` | `9b9e12beb8dc0ecd…` | `9b9e12beb8dc0ecd…` |
| keep-prod | `server/keySecrets.ts` | `cce4bdd8eff3c316…` | `cce4bdd8eff3c316…` |
| replace | `server/liveStream.test.ts` | `209860b4eb27bf30…` | `d96bf9c640a07a53…` |
| keep-prod | `server/liveStream.ts` | `b6fdfe65aec41362…` | `b6fdfe65aec41362…` |
| add | `server/magpieControl.test.ts` | `c662efb31e0bd0b5…` | — |
| add | `server/magpieControl.ts` | `974d0a392a0b554f…` | — |
| add | `server/magpieEngine.test.ts` | `d01cd41969adade6…` | — |
| add | `server/magpieEngine.ts` | `a82a2607ad512379…` | — |
| add | `server/magpieMigration.test.ts` | `2b2fae02fb29d47d…` | — |
| add | `server/magpieMigration.ts` | `87847d283ebf18b2…` | — |
| add | `server/magpieOAuth.test.ts` | `01be9f9e6add54f4…` | — |
| add | `server/magpieOAuth.ts` | `ec6b04d55e13391c…` | — |
| add | `server/magpieRuntime.ts` | `5eec1ed5edfa167a…` | — |
| add | `server/magpieUpstream.test.ts` | `f5861e3c9121e313…` | — |
| add | `server/magpieUpstream.ts` | `e249ed65cc1d9765…` | — |
| keep-prod | `server/managementCapability.ts` | `091cf1bf71fac007…` | `091cf1bf71fac007…` |
| keep-prod | `server/managementDegrade.test.ts` | `7892c9f5f2569e7a…` | `7892c9f5f2569e7a…` |
| replace | `server/modelCatalog.test.ts` | `9656e1fd5989e465…` | `e812f06e631b78cc…` |
| replace | `server/modelCatalog.ts` | `51b579e4fdd25c72…` | `d4f87beca5437777…` |
| keep-prod | `server/modelIdentity.ts` | `212977c1676ac893…` | `212977c1676ac893…` |
| replace | `server/modelIndex.test.ts` | `fc48934dae1ea399…` | `b64d4f9d34828f3f…` |
| keep-prod | `server/modelIndex.ts` | `47716f08d79d3ffc…` | `47716f08d79d3ffc…` |
| add | `server/modelSync.test.ts` | `28c33d1bc5c618b1…` | — |
| add | `server/modelSync.ts` | `8df6e0551a9132ed…` | — |
| keep-prod | `server/monitorQuotaShare.test.ts` | `f6dbb518fd1933cb…` | `f6dbb518fd1933cb…` |
| keep-prod | `server/monitorQuotaShare.ts` | `8cbae44d73923090…` | `8cbae44d73923090…` |
| keep-prod | `server/multipartUpload.test.ts` | `ac50f59b8abfd722…` | `ac50f59b8abfd722…` |
| keep-prod | `server/multipartUpload.ts` | `3e312a51211c3d6c…` | `3e312a51211c3d6c…` |
| keep-prod | `server/nativeResponses.ts` | `06069d3d73993916…` | `06069d3d73993916…` |
| keep-prod | `server/nginxCompression.test.ts` | `2a8fc01e6c4b437b…` | `2a8fc01e6c4b437b…` |
| keep-prod | `server/nginxUnlimitedApply.test.ts` | `6e276cd65bf48634…` | `6e276cd65bf48634…` |
| keep-prod | `server/nginxUnlimitedApply.ts` | `8ebf7959fa7f17be…` | `8ebf7959fa7f17be…` |
| keep-prod | `server/nginxUnlimitedApplyCli.ts` | `3d28e5ce46d7b773…` | `3d28e5ce46d7b773…` |
| keep-prod | `server/nginxUnlimitedDeploy.test.ts` | `28748863e117077d…` | `28748863e117077d…` |
| keep-prod | `server/nginxUnlimitedPolicy.test.ts` | `32952c946ea936ad…` | `32952c946ea936ad…` |
| keep-prod | `server/nginxUnlimitedPolicy.ts` | `47336a5479a3b422…` | `47336a5479a3b422…` |
| keep-prod | `server/nginxUnlimitedReconciler.test.ts` | `325ddc6eb30da5ce…` | `325ddc6eb30da5ce…` |
| keep-prod | `server/nginxUnlimitedReconciler.ts` | `75688b5b827a8804…` | `75688b5b827a8804…` |
| keep-prod | `server/nginxUnlimitedSync.test.ts` | `f40586e62ab1d871…` | `f40586e62ab1d871…` |
| keep-prod | `server/nginxUnlimitedSync.ts` | `d34350028263ca0d…` | `d34350028263ca0d…` |
| replace | `server/oauthAndVersion.test.ts` | `1f0f210bf00a4e67…` | `fb79e45f3f044b64…` |
| replace | `server/oauthGroupResilience.test.ts` | `1d5ca0d4b0dafe2d…` | `e9e67abf2cc31627…` |
| keep-prod | `server/policy.test.ts` | `2f0e7562dc0f1864…` | `2f0e7562dc0f1864…` |
| keep-prod | `server/policy.ts` | `ae1d1dc5bebe3f44…` | `ae1d1dc5bebe3f44…` |
| keep-prod | `server/pricing.data.json` | `db0f549fce0af2ec…` | `db0f549fce0af2ec…` |
| keep-prod | `server/pricing.test.ts` | `56ec72bfe18cf67f…` | `56ec72bfe18cf67f…` |
| keep-prod | `server/pricing.ts` | `d536e2ec29fde0d8…` | `d536e2ec29fde0d8…` |
| keep-prod | `server/proxyPresets.test.ts` | `9b901a93a6832c47…` | `9b901a93a6832c47…` |
| keep-prod | `server/proxyPresets.ts` | `4025a393449ab532…` | `4025a393449ab532…` |
| keep-prod | `server/publicUsage.test.ts` | `722d9c70ee6a5d0f…` | `722d9c70ee6a5d0f…` |
| keep-prod | `server/publicUsage.ts` | `d168ce619aaf5314…` | `d168ce619aaf5314…` |
| keep-prod | `server/quota.test.ts` | `0feee4862bdc2f32…` | `0feee4862bdc2f32…` |
| keep-prod | `server/quota.ts` | `a1f43f2d9ccb47b4…` | `a1f43f2d9ccb47b4…` |
| keep-prod | `server/quotaEnforcer.ts` | `312b8a55e9e37ec2…` | `312b8a55e9e37ec2…` |
| keep-prod | `server/quotaLedger.test.ts` | `90af559b1b56a2c4…` | `90af559b1b56a2c4…` |
| keep-prod | `server/quotaLedger.ts` | `eadeb292f475c7fd…` | `eadeb292f475c7fd…` |
| replace | `server/reportingGroups.test.ts` | `b9c4c55db67cc36a…` | `b646da46af40ec42…` |
| keep-prod | `server/reportingGroups.ts` | `6ddce90549b099b5…` | `6ddce90549b099b5…` |
| replace | `server/reportPageFrontend.test.ts` | `c8fe759c7a4856a2…` | `a373e24e9fe7dd55…` |
| replace | `server/reportPageLoads.test.ts` | `e290afdcf88a9245…` | `5cd24591dd6919ce…` |
| replace | `server/reportRouteWiring.test.ts` | `163848739b104331…` | `503682fc2362b2c1…` |
| keep-prod | `server/reportSnapshotCache.test.ts` | `2b8601caf4d510e5…` | `2b8601caf4d510e5…` |
| keep-prod | `server/reportSnapshotCache.ts` | `62ae986b65b90ab3…` | `62ae986b65b90ab3…` |
| keep-prod | `server/requestCoordinator.test.ts` | `4e5907ac058b3223…` | `4e5907ac058b3223…` |
| keep-prod | `server/requestCoordinator.ts` | `a94e7f670f869db5…` | `a94e7f670f869db5…` |
| add | `server/rtkPlane.ts` | `94b19d02d95e4493…` | — |
| add | `server/rtkService.test.ts` | `d52fad22169bc5ca…` | — |
| add | `server/rtkService.ts` | `2d1d039ab9437e59…` | — |
| keep-prod | `server/snapshotStore.test.ts` | `0515bc404b9f062f…` | `0515bc404b9f062f…` |
| keep-prod | `server/snapshotStore.ts` | `8794e2ae485878cb…` | `8794e2ae485878cb…` |
| keep-prod | `server/sqliteReadWorker.mjs` | `421cbd860570dc98…` | `421cbd860570dc98…` |
| keep-prod | `server/sqliteReadWorker.test.ts` | `8cfa344861b80466…` | `8cfa344861b80466…` |
| keep-prod | `server/sqliteReadWorker.ts` | `4eb93a14e4ba3d59…` | `4eb93a14e4ba3d59…` |
| keep-prod | `server/staticEntryCaching.test.ts` | `687cd9fc6d54aba2…` | `687cd9fc6d54aba2…` |
| keep-prod | `server/sync.ts` | `dd5e282313ef9320…` | `dd5e282313ef9320…` |
| keep-prod | `server/syncScheduler.test.ts` | `031da32bcee017f2…` | `031da32bcee017f2…` |
| add | `server/testDataDir.ts` | `2cb6077a8987d9af…` | — |
| keep-prod | `server/timeRange.test.ts` | `1b71007ee4f735fc…` | `1b71007ee4f735fc…` |
| keep-prod | `server/timeRange.ts` | `4d846e10252d6476…` | `4d846e10252d6476…` |
| keep-prod | `server/timeWindow.test.ts` | `c164ba079af26cc3…` | `c164ba079af26cc3…` |
| keep-prod | `server/tokenSql.ts` | `8c03cf525a0ffad1…` | `8c03cf525a0ffad1…` |
| keep-prod | `server/uploadGate.test.ts` | `304d5e31686c1db5…` | `304d5e31686c1db5…` |
| keep-prod | `server/uploadGate.ts` | `2ee7ecaa6fc17ccf…` | `2ee7ecaa6fc17ccf…` |
| keep-prod | `server/usageBreakdown.test.ts` | `0332e9dcd32e7ab8…` | `0332e9dcd32e7ab8…` |
| keep-prod | `server/usageBreakdown.ts` | `3cad15fa41541ed5…` | `3cad15fa41541ed5…` |
| replace | `server/usageDetails.test.ts` | `09db903b5169ac74…` | `94379992c260d85c…` |
| keep-prod | `server/usageDetails.ts` | `c5c26ed4399eadde…` | `c5c26ed4399eadde…` |
| keep-prod | `server/usageOverview.test.ts` | `b08e9d86a5ca413e…` | `b08e9d86a5ca413e…` |
| keep-prod | `server/usageOverview.ts` | `f2110d34576031a4…` | `f2110d34576031a4…` |
| keep-prod | `server/usageReports.ts` | `de42cd8eebc5ccdb…` | `de42cd8eebc5ccdb…` |
| keep-prod | `server/usageRollup.ts` | `f3daae696a072b87…` | `f3daae696a072b87…` |
| keep-prod | `server/zipEntries.ts` | `892d79c33610e94f…` | `892d79c33610e94f…` |
| keep-prod | `tsconfig.json` | `91434fd9d32940ba…` | `91434fd9d32940ba…` |
| keep-prod | `tsconfig.node.json` | `afc4620f8c23f3cd…` | `afc4620f8c23f3cd…` |
| keep-prod | `tsconfig.server.json` | `acc8c1aa4c9bc61e…` | `acc8c1aa4c9bc61e…` |

## 被排除的本地文件（不进入 release）

- 统计：keep-prod 模式：保留生产 React 前端 × 74；工作区缺失 × 73；never-ship 规则 × 123
- 明细（前 40）：.oxlintrc.json, "docs/Crosery-API-Console-\347\256\241\347\220\206\345\221\230\344\275\277\347\224\250\350\257\264\346\230\216.docx", docs/qa/COORDINATION.md, docs/qa/ab/README.md, docs/qa/ab/comparison.md, "docs/qa/ab/shots/00-lab-\345\205\245\345\217\243.png", "docs/qa/ab/shots/01-lab-\346\212\225\347\245\250\346\210\220\345\212\237.png", "docs/qa/ab/shots/f1-keys-a-\345\210\227\350\241\250.png", "docs/qa/ab/shots/f1-keys-a-\345\210\240\351\231\244\347\241\256\350\256\244\345\217\240\345\261\202.png", "docs/qa/ab/shots/f1-keys-a-\345\210\267\346\226\260\345\220\216\344\270\242\345\244\261.png", "docs/qa/ab/shots/f1-keys-a-\346\220\234\347\264\242\345\220\216.png", "docs/qa/ab/shots/f1-keys-a-\351\242\235\345\272\246\345\274\271\347\252\227.png", "docs/qa/ab/shots/f1-keys-b-\345\210\227\350\241\250.png", "docs/qa/ab/shots/f1-keys-b-\345\210\240\351\231\244\347\241\256\350\256\244.png", "docs/qa/ab/shots/f1-keys-b-\345\210\267\346\226\260\345\220\216\344\277\235\346\214\201.png", "docs/qa/ab/shots/f1-keys-b-\351\207\215\347\275\256\346\234\211\347\241\256\350\256\244.png", "docs/qa/ab/shots/f2-rtk-a-\344\270\273\350\247\206\345\233\276.png", "docs/qa/ab/shots/f2-rtk-a-\346\226\207\346\241\243\351\235\242.png", "docs/qa/ab/shots/f2-rtk-b-\346\226\260\345\242\236RTK\351\235\242.png", "docs/qa/ab/shots/f3-dash-a-\345\244\261\350\264\245\346\200\201.png", "docs/qa/ab/shots/f3-dash-a-\351\246\226\345\261\217.png", "docs/qa/ab/shots/f3-dash-b-\345\244\261\350\264\245\346\200\201.png", "docs/qa/ab/shots/f3-dash-b-\351\246\226\345\261\217.png", "docs/qa/ab/shots/r1-dashboard-a-\346\227\240\345\206\231\350\267\257\345\276\204.png", "docs/qa/ab/shots/r1-help-a-\345\244\215\345\210\266\346\227\240\350\257\267\346\261\202.png", "docs/qa/ab/shots/r1-keys-a-\351\207\215\347\275\256\350\242\253\346\213\246.png", "docs/qa/ab/shots/r1-oauth-a-\345\274\200\345\247\213\347\231\273\345\275\225\350\242\253\346\213\246.png", "docs/qa/ab/shots/r1-vote-\351\200\232\351\201\223\346\201\242\345\244\215.png", docs/qa/blue/dead-tree-cleanup.md, docs/qa/blue/rtk-control-plane.md, docs/qa/blue/rtk-round2-fixes.md, docs/qa/blue/rtk-round3-fixes.md, docs/qa/blue/shots/after-analytics-deeplink-30d.png, docs/qa/blue/shots/after-analytics-mobile-390.png, docs/qa/blue/shots/after-channels-mobile-390.png, docs/qa/blue/shots/after-charts-desktop.png, docs/qa/blue/shots/after-dashboard-desktop.png, docs/qa/blue/shots/after-keys-deeplink-search.png, docs/qa/blue/shots/after-keys-delete-confirm-focus.png, docs/qa/blue/shots/after-keys-delete-confirm.png …

> 本脚本只在临时目录组装；真实上机时基底用 `cp -a` 从生产 release 复制（含 node_modules），本演练快照不含 node_modules。
