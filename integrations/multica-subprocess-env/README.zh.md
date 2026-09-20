# @lechun-dev/dsh-multica-subprocess-env

[English](README.md) | 中文

## 概述

这是 fork 本地的 DeepSeek Harness 插件：把 Multica 任务凭据（`MULTICA_TOKEN`）送进 harness 通过 `ctx.subprocess` 启动的每一个子进程。没有它，seam 的凭据清除会把这个变量删掉，任务里的每条 `multica` 命令都会 fail-closed。这个 fork 已经把一份快照打进 `@deepseek-ai/dsh-base`，所以从本检出构建的 CLI、Web、桌面都会默认加载它，不必再往 profile 加一行。源码仍放在 pnpm workspace 之外，合并上游时不会被当成 release member；卸载时会精确还原被装饰的方法。

## 目录

- [为什么需要它](#why-it-exists)
- [安装](#install)
- [接入 profile](#wire-it-into-a-profile)
- [验收](#verify)
- [实现方式](#how-it-works)
- [开发](#develop)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="why-it-exists"></a>
## 为什么需要它

Multica runner 会把任务凭据注入 harness 进程，而 agent 的 shell 必须再次看到它：一旦缺失，`multica auth status`、`multica issue get`、`multica issue comment add` 都会以 `agent execution context requires MULTICA_TOKEN to be a task-scoped mat_ token` 拒绝执行。

凭据丢在子进程边界上。`packages/subprocess/subprocess/src/index.ts` 用 `scrubbedParentEnv()` 构造每个子进程的环境，它会丢掉匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的名字；`MULTICA_TOKEN` 正好命中，所以模型 `bash` 启动的子进程永远拿不到它。同一个文件也写明了官方留的出口：spawn spec 的显式 `env` 层在清除**之后**合并，因此被显式转发的条目可以存活。

本插件就为已挂载 provider 服务的每一次 spawn 提供这个显式条目：bash 与 PowerShell 命令、终端会话、语言服务器、hook 命令，以及 subagent 后端。它完全不碰清除逻辑本身，也就保住了 harness「凭据不会隐式泄漏给子进程」的规则。

<a id="install"></a>
## 安装

把模块拷进 fork 检出目录，然后构建一次：

```sh
cp -R multica-subprocess-env /Users/lq/work/lechun/code/DSH/integrations/
cd /Users/lq/work/lechun/code/DSH/integrations/multica-subprocess-env
node ../../node_modules/typescript/bin/tsc -p tsconfig.json
```

本文件旁边的 `install.sh` 会替你构建、刷新 `dsh-base` 里的快照并跑测试（`bash install.sh`）。`bash install.sh --wire --yes` 还会把下面那条 profile 行写进去，这一步只给官方 npm `dsh` 用；在本检出上不要加 `--wire`，以免 profile 再挂一份。构建要求仓库本身已构建过一次（`pnpm run build:lib:host`），因为模块的两个类型依赖是通过它自己的 `tsconfig.json` paths 映射解析到 `vendor/cordis/lib/types` 和 `packages/subprocess/subprocess/lib/types` 的。除此之外不需要安装任何东西：产出的 `lib/index.js` 没有任何 import，而仓库的 `.gitignore` 本来就会忽略 `lib/`。

<a id="wire-it-into-a-profile"></a>
## 接入 profile

这个 fork 已经在 `packages/bundle/base/cordis.patch.yml` 里插入了该插件。用本检出运行时，不要再往 `~/.dsh/profiles/multica/cordis.patch.yml` 追加第二行。下面的例子只给官方 npm `dsh`（或没有跑这个 fork 的机器）用；写到 `~/.dsh/profiles/multica/cordis.patch.yml`（写进 `~/.dsh/cordis.patch.yml` 则对本机所有 profile 生效）：

```yaml
- insert:
    - id: multica-subprocess-env
      name: '/Users/lq/work/lechun/code/DSH/integrations/multica-subprocess-env/lib/index.js'
```

这一行在所有 bundle 层之后应用，因此它装饰的是该 profile 实际挂载的那个 `ctx.subprocess` provider。不需要重启任何东西：每个任务都会新起一个 harness 进程。

等某个任务验证凭据确实送达后，先前的两个临时手段就不再需要了：全局 `node_modules` 里打过补丁的 `dsh-subprocess`（用 `npm i -g @deepseek-ai/dsh` 或重装恢复），以及智能体的 `DSH_ENV_PASSTHROUGH` 环境变量。

<a id="verify"></a>
## 验收

接入之后新起的任务里，agent 执行：

```sh
env | grep -c '^MULTICA_TOKEN='   # 1
multica auth status               # task identity
```

在本机，模块自带的测试会通过已安装的 provider 打开一个真实子进程，并断言三种情形 —— 其中对照组恰好证明了插件所修的那个 bug：

```sh
cd /Users/lq/work/lechun/code/DSH/integrations/multica-subprocess-env
npm test
```

`tests/child-env.test.mjs` 直接挂载已安装的 provider，找不到 harness 时会带说明跳过（可用 `DSH_INSTALL_ROOT=<…>/node_modules/@deepseek-ai` 指定）。`tests/loader-composition.test.mjs` 则通过真实的 Cordis Loader 读取 `cordis.yml` 复现同样的证明，同时覆盖上面那种绝对路径行的写法。

<a id="how-it-works"></a>
## 实现方式

`apply()` 从注入的 `ctx.subprocess` 上取到 `spawn` 与 `spawnTerminal`，替换成把 `forwardedEnv()` 合并到调用方 `env` 条目之下的包装函数，并通过 `ctx.effect()` 注册还原逻辑。转发内容在 spawn 时刻计算，所以任务之间出现或消失的凭据都会被如实反映，无需重载任何东西；没有任何凭据时，spec 原样返回。

两个细节让这层装饰是诚实的。原方法以它们自己的 receiver 调用，因为 provider 可能读取实例状态。还原带身份判断：若在插件加载期间有别的代码替换了某个入口，卸载时不会覆盖那个替换。

另一种写法是在 provider 位置挂一个 `dsh-subprocess-local` 子类，如果 fork 将来需要改 provider 行为而不是装饰它，那才是正确的形状。本模块选择装饰，是因为它依赖的 seam 契约只有两个有文档的方法，而子类会继承某个实现的内脏；也因为这里出 bug 只是让凭据重新被清除，而不会把子进程能力一起弄坏。

<a id="develop"></a>
## 开发

```sh
npm run build       # tsc -p tsconfig.json -> lib/
npm run typecheck   # tsc -p tsconfig.json --noEmit
npm test            # build, then node --test tests/
```

源码与测试都是普通 ESM。`src/index.ts` 只 import 类型，因此产出的模块没有任何运行时依赖，可以从任意路径加载。测试套件不需要安装依赖：它读取仓库里已构建的 Cordis，真实子进程相关的用例则使用本机已安装的 harness。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **转发名单写死在源码里。** `FORWARDED_ENV_NAMES` 只声明了 `MULTICA_TOKEN`，与 runner 当前注入的内容一致；要加第二个「像凭据」的变量是改一行加一个测试，在出现第二个使用者之前不存在配置面。
- **harness 不负责启动的子进程够不到。** MCP stdio server 由 MCP SDK 自己启动、不走 seam，需要用它自己的 `mcp-client` 配置里的 `env` 字段；任何直接调用 `child_process` 的插件同理。
- **就地装饰跟随的是 seam，不是某个实现。** 若上游重命名了 `spawn` 或 `spawnTerminal`，包装会失配、凭据会悄悄消失；`tests/child-env.test.mjs` 会让这种改动失败而不是放它过去，修法是重新指向那两个被捕获的方法。
- **`lib/` 是构建产物。** 它被仓库 `.gitignore` 忽略，所以对着官方 npm `dsh` 跑 `install.sh --wire` 仍然要先构建；这个 fork 提交在 `packages/bundle/base/plugins/` 里的快照不依赖它。
- **验收需要 harness。** 两个真实进程用例在找不到已安装 harness 时会跳过，这让纯单元用例在任何地方都能跑，但把端到端断言留给装有 harness 的机器。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

2026-09-20 为 lechun fork 编写，用来取代「给已安装的 dsh-subprocess 打临时补丁 + 一个智能体环境变量」这两招。这个 fork 现在把构建产物的快照打进 `@deepseek-ai/dsh-base`，从本检出构建的 CLI、Web、桌面不必再写 profile 行；`install.sh --wire` 只留给官方 npm `dsh`。已在本次机器上对着已安装的 harness（`dsh 0.1.5-rc.2`、Node 22）验证，fork 检出为 `0.1.6-alpha.2`：对照组的 spawn 报告 `<unset>`，被装饰的 spawn 报告出凭据；Loader 从一个生成的 `cordis.yml` 挂载了两行，没有 unloaded 条目。`dsh --profile multica --patch <patch> --dump-config` 会把 profile 上的 insert 行排在 bundle 层之后。本模块刻意不做成 workspace 包：`packages/*/*` 成员是可发布的 release member，新增一个还会在每次合并上游时牵动 `docs/config-catalog.md`、`docs/module-graph.md`、`tsconfig.base.json` 和 `pnpm-lock.yaml`。

</details>
