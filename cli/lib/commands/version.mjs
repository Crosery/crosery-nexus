export default {
  name: 'version',
  aliases: [],
  hidden: true,
  summary: '版本',
  help: `cradmin version

打印 cradmin（随控制台仓库发版）的版本号与 RELEASE.json 的 releaseId。不联网。
`,
  options: {},
  async run(ctx) {
    const data = { cradmin: ctx.version, releaseId: ctx.releaseId || null, node: process.version }
    ctx.output(data, () => ctx.ui.line(`cradmin ${ctx.version}${ctx.releaseId ? `（${ctx.releaseId}）` : ''}`))
  },
}
