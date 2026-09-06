# One long-running Bun process with the SQLite file on a Fly volume at /data.
# Deps first so a source-only change reuses the install layer.
FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

# The volume is mounted here; the DB must not live in the image.
ENV PUPPET_DB=/data/theater.sqlite
ENV PORT=4300
EXPOSE 4300

CMD ["bun", "run", "src/server/index.ts"]
