# Selective Sync

## Deployment

### Build & Push (from local Mac)

```bash
cd filebrowser
docker build -f Dockerfile.s6 --platform linux/arm64 -t ghcr.io/ghyeongl/selective-syncer:s6-arm64 .
docker push ghcr.io/ghyeongl/selective-syncer:s6-arm64
```

### Deploy to homepi1

```bash
ssh homepi1 'cd /home/pi/Devkits/packages/containers/selective-syncer && docker compose pull && docker compose up -d'
```

### Verify

```bash
ssh homepi1 'docker logs selective-syncer --tail 20'
```

### Image names

- **homepi1**: `ghcr.io/ghyeongl/selective-syncer:s6-arm64`
- Compose location: `/home/pi/Devkits/packages/containers/selective-syncer/docker-compose.yml`

## Submodule

`filebrowser/` is a git submodule (detached HEAD). Commit inside submodule first, then update parent repo.

## Tests

```bash
cd filebrowser && go test ./sync/... -count=1
```
