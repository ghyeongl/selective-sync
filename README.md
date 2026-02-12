# Selective Sync Manager

Pi 4에서 Archives(4TB 전체 파일)와 Spaces(Syncthing 동기화 대상 부분집합)를 관리하는 데몬 + 웹 UI.

## 구조

```
selective-sync/
├── filebrowser/          ← FileBrowser fork (submodule)
│   ├── sync/             ← Selective Sync 핵심 패키지
│   │   ├── daemon.go     ← 데몬 (inotify + eval queue + pipeline)
│   │   ├── pipeline.go   ← P0~P4 상태 수렴 파이프라인
│   │   ├── store.go      ← SQLite CRUD
│   │   ├── scanner.go    ← 디스크 스캐너
│   │   ├── fileops.go    ← SafeCopy, SoftDelete
│   │   ├── handlers.go   ← HTTP API (/api/sync/*)
│   │   └── ...
│   └── frontend/src/
│       ├── components/sync/  ← SyncCheckbox, SyncStatusBadge, SpacesUsageBar
│       └── stores/sync.ts    ← Pinia 스토어
├── PRD.md                ← 상세 설계 문서
└── Archives/, Spaces/    ← 로컬 테스트용 (gitignore)
```

## 동작 원리

1. **entries DB가 SSOT** — SQLite에 Archives 전체 파일 카탈로그 저장
2. **웹 UI에서 체크박스** select/deselect → Spaces에 파일 복사/삭제
3. **데몬이 inotify 감시** → 7변수 계산 → P0~P4 파이프라인으로 34개 상태 자동 수렴
4. **Syncthing은 Spaces 폴더만** spoke 기기들과 동기화

## 상태 모델

| 상태 | 설명 |
|------|------|
| archived | Archives에만 존재 (정상) |
| synced | 양쪽 동기화 완료 (정상) |
| syncing | Spaces로 복사 대기 |
| removing | Spaces에서 삭제 대기 |
| updating | 한쪽 변경 전파 중 |
| conflict | 양쪽 동시 수정 |
| recovering | Archives 복구 중 |
| lost | 양쪽 디스크 유실 |
| untracked | DB 미등록 |
| repairing | DB 불일치 정리 중 |

## 빌드

```bash
cd filebrowser
export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"

# 백엔드
go build -o filebrowser .

# 프론트엔드
cd frontend && pnpm install && pnpm run build
```

## 실행

```bash
./filebrowser \
  --database ./filebrowser.db \
  --archives-path /path/to/Archives \
  --spaces-path /path/to/Spaces
```

sync.db는 filebrowser.db와 같은 디렉토리에 자동 생성됩니다.

## 개발

filebrowser는 git submodule입니다:

```bash
# 클론
git clone --recurse-submodules git@github.com:ghyeongl/selective-sync.git

# submodule 변경 반영
cd filebrowser
git add . && git commit -m "..." && git push
cd ..
git add filebrowser && git commit -m "update filebrowser submodule"
```

## 테스트

```bash
cd filebrowser
export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"
go test ./sync/ -v
```
