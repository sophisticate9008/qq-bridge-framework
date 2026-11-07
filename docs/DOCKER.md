# Docker 安装与更新

Release 提供 Linux x64（amd64）及 ARM64 的 `qq-bridge-framework-版本-docker-架构.tar.gz` 镜像归档。镜像内已包含 Node.js、锁定生产依赖、WebUI、字体及原生排版组件；QQ 协议端与 DSH 作为独立服务连接。每个架构使用原生 GitHub runner 构建和运行，输入为同一提交的完整发行包。

下载对应架构的镜像归档并核对 `SHA256SUMS` 后：

```sh
docker load -i qq-bridge-framework-1.13.1-docker-amd64.tar.gz
docker compose up -d
docker compose logs -f framework
```

`compose.yaml` 使用镜像标签 `qq-bridge-framework:1.13.1`，初始只将管理页面绑定到宿主回环 `http://127.0.0.1:3210`。首次启动自动初始化缺失的管理配置；已有配置、管理令牌和聊天数据直接复用。首次页面初始化后，管理令牌位于持久卷中，按页面提供的路径读取；不要将令牌写入 compose 文件。可通过 `docker compose exec framework cat /opt/qbf/data/admin/gateway-admin.token` 在自己的终端读取令牌。

新安装的 `framework-data` 卷挂载 `/opt/qbf/data` 保存配置、会话和业务状态，`framework-workspace` 挂载 `/opt/qbf/workspace` 保存任务脚本与成果，`framework-private` 挂载 `/opt/qbf/private` 保存私人扩展。

容器以非 root 的 node 用户运行。bind mount 目录须允许该用户读写，敏感配置保持私有权限。升级时保留所有现有卷；不把已有数据复制到镜像层。

DSH 和 OneBot 地址在容器中应能实际访问。相同 compose 网络使用服务名；宿主服务可以使用 `host.docker.internal`，Linux 的 host-gateway 已在示例中登记。宿主仅监听 127.0.0.1 的服务无法直接经该地址访问，应使用受限的容器网络配置或明确配置服务监听地址。DSH 本机文件发现只适用于当前容器可访问的安装与鉴权文件；跨容器连接使用高级设置中的远程连接方式。连接授权不授予进程管理权限。

更新时备份所有持久卷，载入新镜像，修改 compose 的版本标签，再运行 `docker compose up -d`。不要使用 `docker compose down -v`，该选项会删除数据卷。WebUI 可以查看当前版本与正式 Release；容器更新由 Docker/Compose 完成。同主版本新镜像复用现有数据，跨主版本按迁移说明操作。容器退出时 Compose 的 `unless-stopped` 策略恢复服务，用户主动停止则保持停止。
