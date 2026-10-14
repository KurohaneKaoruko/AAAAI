# ============================================================
# AAAAI —— 多阶段构建
# 阶段一：安装全部依赖并构建（服务端 dist + WebUI web/dist）
# 阶段二：仅携带生产依赖与构建产物运行
# ============================================================

FROM node:22-alpine AS builder
WORKDIR /app

# 先装依赖，命中 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.server.json ./
COPY src ./src
COPY web ./web
COPY config ./config

RUN npm run build

# ---------- 运行阶段 ----------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    AAAAI_CONFIG=/app/config/default.yaml \
    AAAAI_DATA_DIR=/app/data

# 生产依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 构建产物与配置
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY config ./config

# 运行时数据（连接/密钥/自选）以卷挂载持久化
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node
EXPOSE 8787

# 健康检查：/api/health 无需鉴权
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/health > /dev/null || exit 1

CMD ["node", "dist/index.js"]