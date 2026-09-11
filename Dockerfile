# glm2api — OpenAI 兼容网关（匿名 GLM 网页版转发）
# 多阶段构建：builder 装依赖 → runner 精简运行

FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
# 仅安装生产依赖（playwright-core 不含浏览器，省体积）
RUN npm install --omit=dev
COPY . .

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# chromium（浏览器驱动模式用）+ 运行用户
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1001 appuser
COPY --from=builder /app /app
USER appuser
EXPOSE 3000
# CHROMIUM_PATH 指向镜像内 chromium，方便浏览器模式（GLM2API_BROWSER=1）直接启用
ENV CHROMIUM_PATH=/usr/bin/chromium
CMD ["node", "src/server.js"]
