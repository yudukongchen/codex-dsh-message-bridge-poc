# Codex 与 DSH 最小通信验证

## 功能

Codex 调用本地命令发送文本，已启动的 DSH 桌面实例在独立会话中处理消息，扩展将模型回复经 Windows 命名管道返回给调用方。这个版本用于验证两个桌面端之间的消息往返，不定义角色、任务流程或执行验收规则。

扩展调用 DSH 桌面端自带的 `sessionController.create` / `prompt` / `cancel` 接口，监听 `session/event`。收到与请求 `rpcId` 对应的用户消息后，按轮次收集助手文本（多步骤时以最后一条为准），等待 `turn/end` 后返回。`accepted` 只表示接收成功，不作为完成结果。

0.2.2 起区分真实用户消息与 DSH 注入的上下文。`agent-instructions`、`runtime-context`、`skill-catalog` 和 `time-context` 虽然也使用 `user/message` 事件，但不参与请求准入或冲突判定。额外用户消息和未知来源仍会触发归属冲突。

0.2.0 起请求状态集中在 `request-state.mjs`（阶段、结算一次、归属冲突），管道与连接文件处理集中在 `transport.mjs`；`dsh-plugin.mjs` 负责 DSH 适配，`bridge.mjs` 保留命令行入口与客户端请求。

## 使用

在 Windows 上执行，需要 Node.js 22 或更高版本，以及 PowerShell 7。安装、卸载和安装测试统一使用 `pwsh`，不支持 Windows PowerShell 5.1。

0.3.1 起扩展以 npm 包安装：profile 只保存包名与工作目录，不再指向仓库里的 `file://` 文件。桌面 profile 由客户端独占管理，`dsh` 命令行会拒绝直接操作，必须用客户端自带的 shim；桌面端也不接受符号链接，所以只能安装 tarball，不能用 `link`。

```powershell
# 1. 打包到 ~/.dsh/plugin-tarballs/（只含运行所需文件）
npm run pack:plugin
# 2. 用客户端自带 shim 装入 desktop profile（写 dependencies、node_modules 与 dsh.profile.bundles）
$shim = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $shim plugin --profile desktop add "$env:USERPROFILE\.dsh\plugin-tarballs\codex-dsh-message-bridge-poc-0.3.1.tgz"
# 3. 校验 manifest 与 profile 包状态，保护状态目录 ACL，写入工作目录覆盖条目
pwsh -NoProfile -File .\install.ps1
# 4. 保存工作，完全退出并重新启动 DSH 后检查连接
node .\bridge.mjs ping
# 不发送模型请求的体检：manifest、profile 条目、包三处登记、状态目录权限、连接文件与管道握手。
node .\bridge.mjs doctor
# 默认模型改变后，让下一条消息使用新的测试会话（保留旧历史并回报旧会话 id）。
node .\bridge.mjs new-session
# 发送消息，等待回复，最长约 2 分钟。
node .\bridge.mjs send '请只回复：执行完成，请检查。'
# 多行或含特殊字符的文本走标准输入，不依赖 shell 拼接。
Get-Content .\任务说明.md -Raw | node .\bridge.mjs send -
Get-Content .\任务说明.md -Raw | node .\bridge.mjs send --stdin
# 取消桥接会话当前一轮（只影响桥接专用会话；确认不等于完成，返回最终结束状态）。
node .\bridge.mjs cancel
```

`install.ps1` 的 `-Cwd` 指定桥接会话的工作目录（默认本仓库目录），写入 profile 的同 id 覆盖条目；`-SkipPackageCheck` 只供临时 profile 的测试使用。升级时先同步 `package.json` 与 `dsh-plugin.mjs` 的 `version`，重新打包后用 shim `remove` 再 `add`——同版本重装不会让宿主重新导入入口。旧版 `file://` 条目需手工迁移：脚本检测到旧标记块会拒绝改写或整体删除，因为该块可能同时包含 `web` 等无关条目。

## 双向收件箱（0.3.0 起）

双方现在可以独立留言。收件箱直接保存到 `~/.dsh/bridge-poc/inbox/`，不依赖 DSH 插件在线，也不占用模型请求。发送成功返回 `queued`，表示消息已保存，接收方处理后再用 `ack` 确认。

```powershell
# 为一次协作指定唯一频道，双方使用相同名称。
$channel = 'work-20261024-01'
# Codex 给 DSH 留言。
node .\bridge.mjs inbox post --as codex --channel $channel --id request-1 '请查看测试结果。'
# DSH 查看自己的未读消息；读取不会确认。
node .\bridge.mjs inbox read --as dsh --channel $channel
# DSH 主动给 Codex 留言，无需先收到 Codex 请求。
node .\bridge.mjs inbox post --as dsh --channel $channel --id report-1 '测试完成，有一处需要讨论。'
# Codex 工作期间等待新消息，最多等待 30 秒；有未读立即返回。
node .\bridge.mjs inbox watch --as codex --channel $channel --wait-ms 30000
# 确认时使用 read/watch 返回的 messages[].id。
node .\bridge.mjs inbox ack --as codex --channel $channel --id '<消息的完整 id>'
```

`--id` 在发送时是调用方指定的重试键，省略时自动生成。同一发送方、同一频道、同一键的重试返回原消息；内容不同则报 `inbox-key-conflict`。确认时必须使用返回的 64 位消息 id。`--reply-to` 可关联本频道中收到的消息；多行文本使用 `--stdin`。

频道必填，只接受小写英文、数字、下划线和连字符，长度为 1～100 个字符，以字母或数字开头，排除 Windows 保留设备名。`--as` 默认为 `codex`，DSH 调用时指定 `--as dsh`。每次读取最多 20 条，`--limit` 可缩小批次；处理并确认后继续读取，直到 `unread` 为 0。

收件箱命令可以立即使用，无需重启 DSH。内存中的插件仍会显示旧版本号，完全重启 DSH 后显示 0.3.1。初次使用须先运行安装脚本保护状态目录；目录权限确实不合规时返回 `inbox-insecure-acl`，无法执行本机权限自检时返回 `inbox-acl-unverified` 并附 `hint` 说明原因（例如受限沙箱拦截子进程）。两者都拒绝保存消息；后者应在普通终端重新运行。

双方须在任务开始、耗时操作之间及结束前检查收件箱。`watch` 只在命令运行期间检查，每 250 ms 一次，最长等待 60 秒；超时返回 `timedOut: true`，未读消息保留。本版尚未接入桌面聊天的全局自动检查或自动唤醒。具体命令、DSH 接入说明和验证结果见 [双向收件箱交付记录](双向收件箱-20261024.md)。

0.2.1 起，安装与 `doctor` 会同时检查最近的 `package.json` 及模块导出的名称和版本，两者必须一致。创建会话期间取消会直接终止当前请求，迟到的创建结果不会继续投递。`new-session` 后尚未发送新消息时，`cancel` 返回 `no-session`，不会操作历史会话。

超时可用环境变量 `DSH_BRIDGE_TIMEOUT_MS` 调整客户端等待上限（毫秒，默认 125000）；服务端等待由插件 `config.timeoutMs` 控制（默认 120000），时区取 `config.timezone`（默认 `Asia/Shanghai`）。

安装只向 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加带标记的扩展条目；重复安装会校验当前条目是否指向本项目，损坏或重复的标记块会拒绝写入并保留原文件。原有模型、权限和其他插件设置不变。会话工作目录为本项目目录，沿用 DSH 自己的模型与权限配置；桥接器不扩大代理的执行权限。

## 返回值与退出码

统一结构 `{ requestId, sessionId, status, reply, errorCode }`；失败发生在会话建立之前时使用空值。`ping` 额外返回协议版本、插件版本、空闲/忙碌阶段（`idle` / `creating-session` / `awaiting-admission` / `awaiting-completion` / `awaiting-recovery`）与恢复状态，不含令牌或提示词。

- 只有 DSH 发出正常完成事件且存在文本时，`status` 才为 `completed`；正常结束但没有文本时返回 `empty-reply`。取消、错误和输出截断不会报告为正常完成；模型错误保留安全错误码（如 `REQUEST_EXTENSION`），不输出原始异常对象。
- 连接与协议失败（含 `endpoint-not-loaded`、`endpoint-stale`、`endpoint-version`、`endpoint-malformed`、`unauthorized`、`invalid-json`、`message-too-large` 等）退出码为 1，错误信息为可理解的中文提示，不含堆栈、令牌或凭据。
- 任务未正常完成（`error`、`empty-reply`、`aborted` 等）退出码为 2。成功为 0。
- 请求超时只停止等待，不自动取消 DSH 任务；超时后桥接会隔离旧会话，下一次发送使用新会话，迟到的旧请求结果不会归入新请求。`ping` 的 `recovery` 字段说明上一轮任务是否可能仍在运行。

## 本地连接与卸载

扩展不读取账户凭据，不开放 TCP 端口，不调用外部服务。通信使用随机名称的本机管道和随机连接令牌，输入上限 64 KB、回复上限 1 MB、并发客户端上限 4。连接文件 `~/.dsh/bridge-poc/endpoint.json` 的暂存文件也在受保护目录内创建，再原子替换最终文件。安装时的 Windows ACL 限制到当前用户、管理员和系统，`doctor` 分别检查目录和实际文件的授权。插件退出时只删除属于自己实例的连接文件，旧实例退出不影响新实例。DSH 自身仍会根据原有模型配置访问模型服务。

```powershell
# 移除配置覆盖条目
pwsh -NoProfile -File .\uninstall.ps1
# 移除 profile 中的插件包（dependencies / node_modules / dsh.profile.bundles 三处）
$shim = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $shim plugin --profile desktop remove codex-dsh-message-bridge-poc
# 完全退出并重新启动 DSH，卸载生效。
```

卸载脚本先备份当前配置，仅移除带本扩展标记且完整的包名覆盖块；标记半截、重复或仍是旧版 `file://` 结构时拒绝写入并显示备份位置。插件包由 shim 移除；收件箱和连接状态目录 `~/.dsh/bridge-poc` 不会自动删除，需要时手工清理。独立测试会话仍保留在 DSH 历史中，可从桌面界面删除。

## 验证结果与限制

2026 年 10 月 25 日，0.3.1 把安装方式从 `file://` 改为 npm 包：仓库新增 `dsh.bundle.patch`、`files` 白名单与 `pack:plugin`，profile 改为包名覆盖条目；`install.ps1`/`uninstall.ps1` 改为校验 profile 的依赖、`dsh.profile.bundles` 与 `node_modules` 版本，并拒绝改写或整体删除可能含其他条目的旧标记块。Node 测试 52 项、安装测试 22 项通过；本机 desktop profile 实测安装后 `ping` 返回 0.3.1，收件箱写入/读取与确认正常，`doctor` 12 项全部通过。迁移时发现旧标记块内还包着 `web-deepseek-api` / `web` 两条无关配置，若按旧版 `uninstall.ps1` 整体删除会一并丢失，本次已保留并在新脚本中加拒绝条件。运行中的旧 `file://` 实例仍在内存里，完全重启 DSH 后才会只按包加载；重启后的 `send` 往返尚未复测。

2026 年 10 月 24 日，0.2.2 修复了真实请求收到上下文事件后误报 `attribution-conflict` 的问题。36 项桥接及诊断测试、16 项安装测试全部通过。已在本机 DSH 上完成三轮真实消息往返，包括精确标记回复、保留上下文的连续消息，以及 DSH 只读检查代码后的长回复；三轮复用同一会话。使用方式不变，更新后需完全重启 DSH。修复前后证据、协同复核意见和未验证事项见 [0.2.2 交付验证记录](消息归属修复验证-20261024.md)。

以下为 0.2.1 及更早版本的历史记录，其真实往返限制以本次交付记录为准。

2026 年 10 月 17 日，0.2.1 的 `npm test` 共 32 项通过，`npm run test:install` 共 16 项通过。新增覆盖失败后定时器清理、失败后再次发送、超时后第二次完整往返、迟到旧事件、创建阶段取消、取消完成与确认的事件顺序、包元数据回归和实际 Windows ACL。测试使用模拟 DSH、虚假连接数据及临时目录，未发送真实模型请求。详细记录见 [修复验证记录](修复验证记录-20261017.md)。

本机只读 `doctor` 确认包元数据和状态目录及文件权限通过，但当前配置缺少扩展条目，连接文件协议版本不匹配。需要运行安装脚本，保存工作并完全重启 DSH，再执行 `doctor`。本次没有改动真实 DSH 配置或重启桌面程序。

以下保留 0.2.0 的历史验证结果。

2026 年 10 月 17 日（0.2.0 本机管道集成测试）：25 项通过，覆盖实际往返、其它会话隔离、悬挂 `create`/`prompt` 的期限内返回、超时后重发与恢复状态、迟到结果隔离、接收确认不计为完成、鉴权拒绝、模型错误回传、空回复、手动插串冲突、畸形事件、重复结束事件、多步骤文本、陈旧/畸形连接文件、非法 JSON、启动失败回滚、实例替换、忙拒绝、客户端断开清理、连接数上限、取消回报。测试使用模拟 DSH 接口，未发送真实模型请求。

安装与卸载脚本另有 13 项 PowerShell 校验（`install.test.ps1`，全程临时目录）：缺 `version` 时配置保持原样、重复安装不新增条目、半截/重复标记可识别、含空格和单引号的路径生成有效配置、并发修改拒绝写入、备份不撞名、卸载保留其他插件条目。

真实模型验证仍需完成：免费模型（`our-free-model / space-bunny-free`）与官方 DeepSeek 模型尚未在 0.2.1 上复测。0.1.0 时仅免费模型往返成功过一次（约 4.5 秒，退出码 0）。`REQUEST_EXTENSION` 的最终根因已由项目外排查记录定位为最近的 `package.json` 缺少版本号。0.2.1 的安装校验和 `doctor` 已覆盖这一条件。模拟测试不能替代真实模型往返。

请求回复模式复用一个独立会话，`new-session` 让下一次发送创建新会话并采用当前默认模型，不自动删除历史、不默认取消旧任务。一次只允许一个模型请求。双向收件箱独立排队，双方通过命令读取留言；它不自动唤醒已经结束的 Codex 聊天，也不主动向其他 Codex 聊天投递消息。DSH 原生接口没有稳定兼容承诺，升级后需要重跑测试与真实往返。

运行测试：

```powershell
npm test                # 管道往返与诊断，含实际 Windows ACL 检查
npm run test:install    # PowerShell 7 安装/卸载校验
```

Codex 沙箱可能阻止本机管道连接，需要允许相应本机命令后验证。测试通过不能替代真实模型往返验证。
