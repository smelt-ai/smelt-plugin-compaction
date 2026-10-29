# 压缩调优

[smelt](https://github.com/smelt-ai/smelt) 的面板插件：按你自己的用法，给 Pi 的每个模型算出最省的自动压缩点。

Pi 默认在「上下文窗口 − 16384」时才压缩，1M 窗口的模型要到 98% 才动手。那时每次调用都要把将近一百万 token 读一遍，压缩时还得把八十多万 token 交给模型写摘要，又慢又贵。早一点压缩又会多出摘要和返工的开销。哪个点最划算，取决于你的对话怎么长、压缩后要读回多少东西，只能拿你自己的记录算。

## 它做什么

1. 读 `~/.pi/agent/sessions` 里你的全部 Pi 会话，取出每次模型调用的 usage（输入、缓存读写、输出、费用）和每次压缩。
2. 对每个模型、每个候选压缩点（5 万起，每 1 万一档，到「窗口 − 16384」为止），把你这段时间的对话按原样重放一遍：上下文按当时真实的增长来长，越过候选点就模拟一次压缩。一次压缩的代价是读一遍上下文、写一份摘要、把摘要写进缓存，以及压缩后把摘要漏掉的东西再读回来（返工，从你自己压缩过的会话里量出来）。
3. 各类 token 按这个模型实际的价钱折成普通输入 token 再相加（缓存读便宜、输出贵；不计费的订阅用常见比例），取总成本最低的点。最低点 1% 以内取最大的（压缩越少丢得越少）；量得到压缩耗时的，不建议比现在等得更久的点；省不到 3% 不建议改。
4. 界面上每个模型一张卡片：现在在哪压缩、建议在哪、能省多少、压缩次数怎么变、成本曲线、你的用法统计。

点「采用」把建议写进 `~/.pi/agent/settings.json`：

```json
{ "compaction": { "modelOverrides": { "provider/model": { "reserveTokens": 744000 } } } }
```

Pi 在上下文超过「窗口 − reserveTokens」时压缩，所以 1M 窗口写 744000 就是在 25.6 万时压缩。新开的 Pi 会话生效。「撤销」删掉这一项。你自己给某个模型设过 `reserveTokens` 的，插件不改。写入时和 Pi 用同一把锁（`settings.json.lock`）。

重放算法移植自 [magpie](https://github.com/yetone/magpie) 的 `internal/tune`（MIT，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。和原版的差别：压缩发生在哪里直接读会话里的 `compaction` 记录，不靠「提示词骤降」去猜，回退造成的骤降不会算成压缩。

## 怎么跑的

插件脚本跑在 smelt 的 UI 线程上，几百 MB 的会话文件不能在那里读。重活在子进程里做：smelt 自带的 `~/.smelt/bin/smelt-pi` 是 Bun 编出来的，带上 `BUN_BE_BUN=1` 就是一个 Bun，插件用它跑 `engine/cli.js`，读它一行行输出的 JSON。不需要另装 Node 或 Bun。

各模型的窗口取自 `smelt-pi --list-models`（Pi 判断压缩用的就是这份），`~/.pi/agent/models.json` 里有精确 `contextWindow` 的以它为准。

插件自己的数据在 `~/.smelt/plugin-data/com.smelt.compaction-tune/state.sqlite3`：每个会话文件读出的调用（大小和修改时间没变就不重读），和插件写过哪些设置。

## 安装

需要带「面板插件」设置页的 smelt，用过 Pi（`~/.smelt/bin/smelt-pi` 已经装好）。暂时只支持 macOS 和 Linux。

```bash
git clone https://github.com/smelt-ai/smelt-plugin-compaction
```

打开 smelt 的 **设置 → 通用 → 面板插件**，点「导入插件目录」选这个目录，插件会出现在右侧 Tool Panel（`Opt+Cmd+B`）。边改边看就建软链：

```bash
ln -s "$PWD/smelt-plugin-compaction" ~/.smelt/plugins/compaction-tune
```

## 开发

```
main.js            界面：起引擎子进程、画结果
format.js          界面上的数字和说法
engine/cli.js      引擎入口（Bun）：analyze / apply / undo
engine/tune.js     重放和挑点
engine/pi.js       读 Pi 的会话文件
engine/windows.js  模型窗口
engine/pi-settings.js  Pi 设置里的压缩点
engine/store.js    插件的 SQLite（bun:sqlite）
```

不碰界面和 `bun:sqlite` 的模块用 Node 测：

```bash
node --test tests/
```

单独跑引擎：

```bash
BUN_BE_BUN=1 ~/.smelt/bin/smelt-pi engine/cli.js analyze --home ~ --smelt-pi ~/.smelt/bin/smelt-pi
```

插件的 `console.log` 和脚本错误写在 `~/.smelt/app.log`，带 `[plugin]` 标记。

## 许可

[Apache-2.0](LICENSE)
