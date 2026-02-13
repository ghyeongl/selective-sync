# E2E Test Specification: Selective Sync Manager

## 개요

기존 단위 테스트(86개)는 개별 컴포넌트를 격리 테스트한다. E2E 테스트는 **전체 흐름**을 검증한다:
- HTTP API 호출 → 데몬 큐 → 파이프라인 → 디스크 상태 변화
- 파일시스템 이벤트 → inotify → debounce → 큐 → 파이프라인 → 디스크

---

## 1. 테스트 인프라

### 1.1 하네스: `e2eEnv`

```go
type e2eEnv struct {
    store        *Store
    daemon       *Daemon
    handlers     *Handlers
    server       *httptest.Server   // 실제 HTTP 서버
    archivesRoot string             // t.TempDir()/Archives
    spacesRoot   string             // t.TempDir()/Spaces
    trashRoot    string             // t.TempDir()/.trash
    ctx          context.Context
    cancel       context.CancelFunc
    client       *http.Client
}
```

**Setup**:
1. `t.TempDir()`에 Archives/, Spaces/ 생성
2. SQLite DB 생성 (store_test.go의 `setupTestDB` 패턴)
3. `Store`, `Daemon`, `Handlers` 생성
4. `httptest.Server`에 라우트 등록
5. `go daemon.Run(ctx)` 시작
6. `e2eEnv` 반환

**Teardown** (`t.Cleanup`):
1. `cancel()` → 데몬 중지
2. HTTP 서버 Close
3. DB Close
4. `t.TempDir()` 자동 정리

### 1.2 헬퍼 함수

```go
// 파일 조작
env.writeArchive(relPath, content []byte)
env.writeSpaces(relPath, content []byte)
env.mkdirArchive(relPath)
env.mkdirSpaces(relPath)
env.removeArchive(relPath)
env.removeSpaces(relPath)
env.readArchive(relPath) []byte
env.readSpaces(relPath) []byte
env.fileExistsArchive(relPath) bool
env.fileExistsSpaces(relPath) bool
env.fileExistsTrash(relPath) bool

// HTTP API
env.postSelect(inodes []uint64) *http.Response
env.postDeselect(inodes []uint64) *http.Response
env.getEntries(parentIno *uint64) []SyncEntryResponse
env.getEntry(inode uint64) *SyncEntryResponse
env.getStats() SyncStatsResponse

// 유틸리티
env.waitConverge(timeout, predicate func() bool)   // 50ms 폴링, time.Sleep 금지
env.findEntryByName(name string) *SyncEntryResponse // entries 목록에서 이름 검색
```

### 1.3 실행 방법

```bash
# 빌드 태그로 분리
//go:build e2e

# 실행
go test ./sync/ -tags e2e -v -timeout 120s

# 특정 그룹만
go test ./sync/ -tags e2e -v -run TestE2E_Select
```

### 1.4 타이밍

- Watcher debounce: 300ms (`watcher.go:14`)
- SafeCopy 청크: 256KB (`fileops.go:12`)
- `waitConverge` 기본 timeout: 5초, 폴링 간격: 50ms

### 1.5 플랫폼 제약

- Linux 전용 (inotify, `syscall.Stat_t`)
- inode는 API 응답에서 동적으로 조회 (하드코딩 금지)
- `t.Parallel()` 사용 가능 (각 테스트 독립 TempDir), 단 inotify watch 수 커널 제한 주의

---

## 2. 테스트 그룹

### Group A: Cold Start & Seeding

데몬 시작 시 기존 디스크 파일을 올바르게 DB에 등록하는지 검증.

---

#### A1: 빈 디렉토리

**테스트명**: `TestE2E_ColdStart_EmptyDirectories`

**사전조건**: Archives/, Spaces/ 모두 비어있음

**절차**:
1. e2eEnv 시작 (빈 디렉토리)
2. 500ms 대기 (seed + reconcile)
3. `GET /api/sync/entries` 호출

**기대결과**:
- API: `{"items": []}` — 빈 목록
- DB: entries 0행
- Stats: `selectedSize == 0`

**검증**:
```go
entries := env.getEntries(nil)
assert.Empty(t, entries)
assert.Equal(t, int64(0), env.getStats().SelectedSize)
```

---

#### A2: Archives만 있는 경우

**테스트명**: `TestE2E_ColdStart_ArchivesOnly`

**사전조건**:
```
Archives/
  Documents/
    notes.txt    (13 bytes)
    readme.txt   (22 bytes)
  Photos/
    photo1.jpg   (100KB)
```

**절차**:
1. 파일 구조 생성
2. e2eEnv 시작
3. waitConverge: entries 5개 등록될 때까지
4. 루트 + Documents 하위 조회

**기대결과**:
- 루트: "Documents" (dir), "Photos" (dir) — 모두 `status: "archived"`, `selected: false`
- Documents 하위: "notes.txt", "readme.txt"
- DB: entries 5행, spaces_view 0행
- Spaces/ 비어있음
- Stats: `selectedSize == 0`

**검증**:
```go
rootEntries := env.getEntries(nil)
assert.Len(t, rootEntries, 2)
for _, e := range rootEntries {
    assert.Equal(t, "archived", e.Status)
    assert.False(t, e.Selected)
}
docEntry := env.findEntryByName("Documents")
docChildren := env.getEntries(&docEntry.Inode)
assert.Len(t, docChildren, 2)
```

---

#### A3: 양쪽에 겹치는 파일

**테스트명**: `TestE2E_ColdStart_BothDirectories`

**사전조건**:
```
Archives/
  report.txt   (content: "archive version")
  data.csv     (100 bytes)
Spaces/
  report.txt   (content: "archive version", 같은 mtime)
```

**절차**:
1. 파일 생성. report.txt는 Archives에서 Spaces로 복사 후 `os.Chtimes`로 mtime 동기화
2. e2eEnv 시작, waitConverge

**기대결과**:
- report.txt: `selected: true`, `status: "synced"` (시나리오 #31)
- data.csv: `selected: false`, `status: "archived"` (시나리오 #15)
- DB: entries 2행, spaces_view 1행 (report.txt)

**검증**:
```go
report := env.findEntryByName("report.txt")
assert.True(t, report.Selected)
assert.Equal(t, "synced", report.Status)

data := env.findEntryByName("data.csv")
assert.False(t, data.Selected)
assert.Equal(t, "archived", data.Status)
```

---

#### A4: Spaces에만 있는 파일 (Spoke 생성, 시나리오 #3)

**테스트명**: `TestE2E_ColdStart_SpacesOnlyFile`

**사전조건**:
```
Archives/  (비어있음)
Spaces/
  spoke-created.txt  (content: "from spoke")
```

**절차**:
1. Spaces에만 파일 생성
2. e2eEnv 시작
3. waitConverge: Archives/spoke-created.txt 생성될 때까지

**기대결과**:
- Archives/spoke-created.txt 생성됨 (P0: SafeCopy S→A)
- 내용: "from spoke"
- API: `selected: true`, `status: "synced"`
- DB: entries 1행 (selected=true), spaces_view 1행

**검증**:
```go
env.waitConverge(5*time.Second, func() bool {
    return env.fileExistsArchive("spoke-created.txt")
})
content := env.readArchive("spoke-created.txt")
assert.Equal(t, []byte("from spoke"), content)
entry := env.findEntryByName("spoke-created.txt")
assert.True(t, entry.Selected)
assert.Equal(t, "synced", entry.Status)
```

---

### Group B: Select Flow (API → 큐 → 파이프라인 → 디스크)

사용자 워크플로우의 핵심: API로 select → 데몬이 Spaces에 복사.

---

#### B1: 단일 파일 Select (시나리오 #15 → #17 → #31)

**테스트명**: `TestE2E_SelectSingleFile`

**사전조건**:
- Archives/document.txt (content: "hello world", 11 bytes)
- Spaces/ 비어있음
- Seed 완료: entry archived

**절차**:
1. e2eEnv 시작, seed 대기
2. `GET /api/sync/entries`에서 inode 확인
3. `POST /api/sync/select` — `{"inodes": [<inode>]}`
4. waitConverge: Spaces/document.txt 생성

**기대결과**:
- POST 응답: HTTP 200
- Spaces/document.txt 존재, content == "hello world"
- mtime 일치 (Archives ↔ Spaces)
- API: `selected: true`, `status: "synced"`
- DB: entries.selected=1, spaces_view 행 존재

**검증**:
```go
resp := env.postSelect([]uint64{inode})
assert.Equal(t, 200, resp.StatusCode)

env.waitConverge(5*time.Second, func() bool {
    return env.fileExistsSpaces("document.txt")
})
content := env.readSpaces("document.txt")
assert.Equal(t, []byte("hello world"), content)

entry := env.getEntry(inode)
assert.True(t, entry.Selected)
assert.Equal(t, "synced", entry.Status)
```

---

#### B2: 폴더 재귀 Select (PRD F4-2)

**테스트명**: `TestE2E_SelectFolderRecursive`

**사전조건**:
```
Archives/
  Projects/
    alpha/
      main.go     (100 bytes)
      README.md   (50 bytes)
    beta/
      index.js    (80 bytes)
```
모든 entry seed 완료, 미선택.

**절차**:
1. e2eEnv 시작, seed 대기
2. "Projects" 디렉토리 inode 확인
3. `POST /api/sync/select` — Projects inode
4. waitConverge: 3개 파일 모두 Spaces에 존재

**기대결과**:
- Spaces/Projects/alpha/main.go, README.md, beta/index.js 모두 존재
- 모든 entry `selected: true`
- Stats: `selectedSize == 230` (100 + 50 + 80)
- childTotalCount/childSelectedCount 정확

**검증**:
```go
env.postSelect([]uint64{projectsIno})
env.waitConverge(5*time.Second, func() bool {
    return env.fileExistsSpaces("Projects/beta/index.js")
})
assert.True(t, env.fileExistsSpaces("Projects/alpha/main.go"))
assert.True(t, env.fileExistsSpaces("Projects/alpha/README.md"))

stats := env.getStats()
assert.Equal(t, int64(230), stats.SelectedSize)

projects := env.findEntryByName("Projects")
assert.Equal(t, 2, *projects.ChildTotalCount)    // alpha, beta
assert.Equal(t, 2, *projects.ChildSelectedCount)
```

---

#### B3: 복수 파일 동시 Select

**테스트명**: `TestE2E_SelectMultipleFiles`

**사전조건**: Archives/ — a.txt (10B), b.txt (20B), c.txt (30B)

**절차**:
1. a.txt, c.txt의 inode 확인
2. `POST /api/sync/select` — `{"inodes": [a_ino, c_ino]}`
3. waitConverge

**기대결과**:
- Spaces/a.txt, Spaces/c.txt 존재. Spaces/b.txt 없음
- a.txt, c.txt: `selected: true`. b.txt: `selected: false`
- Stats: `selectedSize == 40`

---

### Group C: Deselect Flow (API → 큐 → 파이프라인 → 디스크)

---

#### C1: 단일 파일 Deselect (시나리오 #31 → #27 → #15)

**테스트명**: `TestE2E_DeselectSingleFile`

**사전조건**:
- Archives/report.txt, Spaces/report.txt 모두 존재 (synced 상태)
- entry selected=true

**절차**:
1. e2eEnv 시작, synced 확인
2. `POST /api/sync/deselect` — report.txt inode
3. waitConverge: Spaces/report.txt 사라짐

**기대결과**:
- Spaces/report.txt **없음**
- Archives/report.txt 변경 없음
- .trash/YYYY-MM-DD/report.txt 존재 (SoftDelete)
- API: `selected: false`, `status: "archived"`
- DB: selected=0, spaces_view 삭제됨

**검증**:
```go
env.postDeselect([]uint64{inode})
env.waitConverge(5*time.Second, func() bool {
    return !env.fileExistsSpaces("report.txt")
})
assert.True(t, env.fileExistsArchive("report.txt"))
assert.True(t, env.fileExistsTrash("report.txt"))

entry := env.getEntry(inode)
assert.False(t, entry.Selected)
assert.Equal(t, "archived", entry.Status)
```

---

#### C2: 폴더 재귀 Deselect

**테스트명**: `TestE2E_DeselectFolderRecursive`

**사전조건**: Projects/ 트리 전체 synced 상태 (양쪽 모두 존재, 전체 선택)

**절차**:
1. e2eEnv 시작, 전체 synced 확인
2. "Projects" inode로 deselect
3. waitConverge

**기대결과**:
- 모든 하위 파일 Spaces에서 제거 → .trash/
- Archives 변경 없음
- Stats: selectedSize == 0

---

### Group D: 파일시스템 이벤트 (inotify → Watcher → 큐 → 파이프라인)

HTTP API 없이, 디스크 변경만으로 데몬이 올바르게 처리하는지 검증.

---

#### D1: Archives 새 파일 자동 등록

**테스트명**: `TestE2E_WatcherNewArchiveFile`

**사전조건**: 데몬 실행 중, Archives/, Spaces/ 비어있음

**절차**:
1. `os.WriteFile`로 Archives/newfile.txt 생성 (content: "watcher test")
2. waitConverge: DB에 entry 등록

**기대결과**:
- DB: entries 1행, type="text", selected=false
- API: `status: "archived"`
- Spaces/ 비어있음
- 감지 소요 시간: < 2초 (debounce 300ms + 처리)

**검증**:
```go
os.WriteFile(env.archivesRoot+"/newfile.txt", []byte("watcher test"), 0644)
env.waitConverge(3*time.Second, func() bool {
    return env.findEntryByName("newfile.txt") != nil
})
entry := env.findEntryByName("newfile.txt")
assert.Equal(t, "archived", entry.Status)
assert.False(t, entry.Selected)
```

---

#### D2: Archives 새 디렉토리 자동 등록

**테스트명**: `TestE2E_WatcherNewArchiveDirectory`

**사전조건**: 데몬 실행 중

**절차**:
1. `os.MkdirAll`로 Archives/NewFolder/ 생성
2. Archives/NewFolder/file.txt 생성
3. waitConverge

**기대결과**:
- "NewFolder" (type=dir), "file.txt" (type=text) 모두 DB 등록
- Watcher가 NewFolder/를 재귀적으로 감시 목록에 추가 (`watcher.go:87`)

---

#### D3: Spoke 편집 — Spaces 파일 수정 (S_dirty, 시나리오 #32)

**테스트명**: `TestE2E_SpokeEdit`

**사전조건**: Archives/doc.txt, Spaces/doc.txt synced

**절차**:
1. e2eEnv 시작, synced 확인
2. 10ms 대기 후 Spaces/doc.txt 내용 변경 ("spoke edited content")
3. waitConverge: Archives/doc.txt 내용이 새 내용과 일치

**기대결과**:
- Archives/doc.txt 내용 = "spoke edited content" (S→A 전파)
- DB: entries.mtime 갱신, spaces_view.synced_mtime 갱신
- API: `status: "synced"` (수렴 후)

**검증**:
```go
time.Sleep(10 * time.Millisecond)
env.writeSpaces("doc.txt", []byte("spoke edited content"))
env.waitConverge(5*time.Second, func() bool {
    content, _ := os.ReadFile(env.archivesRoot + "/doc.txt")
    return string(content) == "spoke edited content"
})
entry := env.findEntryByName("doc.txt")
assert.Equal(t, "synced", entry.Status)
```

---

#### D4: SSH 편집 — Archives 파일 수정 (A_dirty, 시나리오 #33)

**테스트명**: `TestE2E_SSHEdit`

**사전조건**: Archives/config.yaml, Spaces/config.yaml synced

**절차**:
1. e2eEnv 시작, synced 확인
2. 10ms 대기 후 Archives/config.yaml 내용 변경 ("ssh edited")
3. waitConverge: Spaces/config.yaml 내용이 새 내용과 일치

**기대결과**:
- Spaces/config.yaml 내용 = "ssh edited" (A→S 전파, selected=true이므로)
- API: `status: "synced"`

**검증**:
```go
time.Sleep(10 * time.Millisecond)
env.writeArchive("config.yaml", []byte("ssh edited"))
env.waitConverge(5*time.Second, func() bool {
    content, _ := os.ReadFile(env.spacesRoot + "/config.yaml")
    return string(content) == "ssh edited"
})
```

---

#### D5: 양쪽 동시 수정 → Conflict (시나리오 #34)

**테스트명**: `TestE2E_Conflict`

**사전조건**: Archives/shared.txt, Spaces/shared.txt synced (content: "original")

**절차**:
1. e2eEnv 시작, synced 확인
2. 양쪽 동시 수정:
   - Archives/shared.txt → "archives edit" (mtime A)
   - 10ms 후 Spaces/shared.txt → "spaces edit" (mtime B ≠ A)
3. waitConverge: conflict 파일 생성

**기대결과**:
- Archives/shared.txt = "spaces edit" (Spoke wins 원칙)
- Archives/shared_conflict-1.txt = "archives edit" (conflict copy)
- Spaces/shared.txt = "spaces edit" (변경 없음, winner)
- DB: 원본 entry mtime 갱신, conflict entry 생성 (selected=true)
- 다음 tick: conflict copy가 Spaces에 자동 전파

**검증**:
```go
time.Sleep(10 * time.Millisecond)
env.writeArchive("shared.txt", []byte("archives edit"))
time.Sleep(10 * time.Millisecond)
env.writeSpaces("shared.txt", []byte("spaces edit"))

env.waitConverge(5*time.Second, func() bool {
    return env.fileExistsArchive("shared_conflict-1.txt")
})
assert.Equal(t, []byte("spaces edit"), env.readArchive("shared.txt"))
assert.Equal(t, []byte("archives edit"), env.readArchive("shared_conflict-1.txt"))

// conflict copy가 Spaces에 전파되는지 확인
env.waitConverge(5*time.Second, func() bool {
    return env.fileExistsSpaces("shared_conflict-1.txt")
})
```

---

#### D6: Archives 삭제 → Spaces에서 복구 (P0 Recovery, 시나리오 #9~#14)

**테스트명**: `TestE2E_RecoveryFromSpaces`

**사전조건**: Archives/important.txt, Spaces/important.txt synced (content: "precious data")

**절차**:
1. e2eEnv 시작, synced 확인
2. `os.Remove`로 Archives/important.txt 삭제
3. waitConverge: Archives/important.txt 복원

**기대결과**:
- Archives/important.txt 복원됨 (P0: SafeCopy S→A)
- 내용 = "precious data"
- Spaces/important.txt 변경 없음
- API: `status: "synced"` (entry.selected 유지)

**검증**:
```go
os.Remove(env.archivesRoot + "/important.txt")
env.waitConverge(5*time.Second, func() bool {
    return env.fileExistsArchive("important.txt")
})
assert.Equal(t, []byte("precious data"), env.readArchive("important.txt"))
```

---

#### D7: 양쪽 삭제 → DB 정리 (Lost, 시나리오 #5~#8)

**테스트명**: `TestE2E_LostBothDeleted`

**사전조건**: Archives/ephemeral.txt, Spaces/ephemeral.txt synced

**절차**:
1. e2eEnv 시작, synced 확인. inode 기록
2. 양쪽 모두 삭제
3. waitConverge: entry가 DB에서 제거

**기대결과**:
- DB: entries에서 해당 행 삭제, spaces_view도 삭제
- API: entry가 목록에 나타나지 않음

**검증**:
```go
os.Remove(env.archivesRoot + "/ephemeral.txt")
os.Remove(env.spacesRoot + "/ephemeral.txt")
env.waitConverge(5*time.Second, func() bool {
    return env.findEntryByName("ephemeral.txt") == nil
})
```

---

### Group E: 에러 복구 & 데몬 재시작

---

#### E1: Dirty State에서 데몬 재시작

**테스트명**: `TestE2E_DaemonRestartDirtyState`

**사전조건**:
- Archives/file.txt seed 완료 (archived)
- API로 select → 데몬 즉시 중지 (cp 완료 전)

**절차**:
1. e2eEnv 시작, seed 대기
2. file.txt select
3. 즉시 `cancel()` — 데몬 중지 (Spaces 복사 미완료 가능)
4. 새 Daemon을 같은 store/directories로 생성
5. 새 데몬 시작
6. waitConverge

**기대결과**:
- fullReconcile이 selected=true, S_disk=0 상태를 발견
- P3에서 A→S 복사 실행
- 최종: Spaces/file.txt 존재, `status: "synced"`

**검증**:
```go
// Phase 1: 첫 데몬
env1 := setupE2E(t)
env1.writeArchive("file.txt", []byte("restart test"))
// seed 대기
env1.postSelect([]uint64{ino})
env1.cancel() // 즉시 중지

// Phase 2: 새 데몬 (같은 DB/디렉토리)
daemon2 := NewDaemon(env1.store, env1.archivesRoot, env1.spacesRoot)
ctx2, cancel2 := context.WithCancel(context.Background())
defer cancel2()
go daemon2.Run(ctx2)

waitConverge(5*time.Second, func() bool {
    return fileExists(env1.spacesRoot + "/file.txt")
})
assert.Equal(t, []byte("restart test"), readFile(env1.spacesRoot+"/file.txt"))
```

---

#### E2: 고아 spaces_view 정리 (시나리오 #19)

**테스트명**: `TestE2E_DaemonRestart_OrphanSpacesView`

**사전조건**:
- Synced file.txt → 데몬 중지 → Spaces/file.txt 외부 삭제 + DB에서 deselect
- 상태: S_db=1, S_disk=0, sel=0 (#19)

**절차**:
1. e2eEnv 시작, sync 완료
2. 데몬 중지
3. Spaces/file.txt 삭제, `store.SetSelected` 직접 호출로 deselect
4. 새 데몬 시작
5. waitConverge

**기대결과**:
- P4가 고아 spaces_view 행 삭제
- entry: selected=false, status="archived"
- Spaces/에 파일 없음

---

#### E3: DB 없이 Spaces 파일 존재 (시나리오 #3)

**테스트명**: `TestE2E_DaemonRestart_SpacesOnlyFile`

**사전조건**: DB 비어있음, Spaces/newfile.txt만 존재

**절차**:
1. Spaces/newfile.txt 생성
2. 데몬 시작
3. waitConverge

**기대결과**:
- P0: SafeCopy S→A, P1: entries INSERT, P4: spaces_view INSERT
- 최종: synced, selected=true, 양쪽 파일 존재

---

### Group F: 상태 레이블 정확성 (PRD F4-5)

---

#### F1: 10가지 상태별 API 응답 검증

**테스트명**: `TestE2E_StatusLabels`

데몬 워커를 **실행하지 않고** (seed만, `Run()` 호출 안함) 디스크+DB 상태를 수동 구성한 후 HTTP 핸들러를 직접 호출하여 status 필드를 검증한다. 이렇게 하면 파이프라인이 상태를 수렴시키기 전에 과도 상태의 레이블을 확인할 수 있다.

| 서브테스트 | 구성 | 기대 status |
|-----------|------|------------|
| archived | A_disk=1, entry(sel=0), S_disk=0, no spaces_view | `"archived"` |
| synced | A_disk=1, entry(sel=1), S_disk=1, spaces_view(mtime 일치) | `"synced"` |
| syncing | A_disk=1, entry(sel=1), S_disk=0, no spaces_view | `"syncing"` |
| removing | A_disk=1, entry(sel=0), S_disk=1, spaces_view(mtime 일치) | `"removing"` |
| updating-spoke | A_disk=1, entry(sel=1), S_disk=1(다른 mtime), spaces_view | `"updating"` |
| updating-ssh | A_disk=1(다른 mtime), entry(sel=1), S_disk=1, spaces_view | `"updating"` |
| conflict | A_disk=1(다른 mtime), entry(sel=1), S_disk=1(다른 mtime), spaces_view | `"conflict"` |
| recovering | A_disk=0, entry(sel=1), S_disk=1, spaces_view | `"recovering"` |
| lost | A_disk=0, entry(sel=0), S_disk=0, no spaces_view | `"lost"` |
| untracked | A_disk=1, no entry (DB 미등록) | `"untracked"` — 주: HandleListEntries는 DB 기반이므로 untracked 파일은 목록에 나타나지 않음. 이 케이스는 `ComputeState` 단위 테스트로 커버 |
| repairing | A_disk=1, entry(sel=0), S_disk=0, spaces_view(고아) | `"repairing"` |

**검증 방식**: 데몬 미시작 → DB/디스크 수동 구성 → `HandleListEntries` 직접 호출 → 응답의 `status` 필드 확인

---

### Group G: 용량/Stats (PRD F4-4)

---

#### G1: select/deselect에 따른 selectedSize 정확성

**테스트명**: `TestE2E_StatsAccuracy`

**사전조건**: Archives/ — small.txt (100B), medium.txt (1000B), large.txt (10000B)

**절차**:
1. seed 후 stats 확인 — baseline
2. small.txt + medium.txt select → stats
3. large.txt select → stats
4. medium.txt deselect → stats

**기대결과**:
| 단계 | selectedSize |
|------|-------------|
| 1 | 0 |
| 2 | 1100 |
| 3 | 11100 |
| 4 | 10100 |

모든 응답에 `spacesTotal > 0`, `spacesFree > 0` 포함.

---

#### G2: spacesTotal/spacesFree 값 존재

**테스트명**: `TestE2E_CapacityWarningData`

**사전조건**: 일부 파일 selected

**절차**:
1. `GET /api/sync/stats`

**기대결과**:
- `selectedSize`, `spacesTotal`, `spacesFree` 모두 정수
- 프론트엔드가 `selectedSize > spacesFree` 비교로 경고 표시 가능
- `syscall.Statfs` 통합 검증 (`handlers.go:186-191`)

---

### Group H: 동시성

---

#### H1: 같은 파일 빠른 select → deselect

**테스트명**: `TestE2E_RapidSelectDeselect`

**사전조건**: Archives/toggle.txt seed 완료 (archived)

**절차**:
1. select
2. 즉시 (대기 없이) deselect
3. waitConverge

**기대결과**:
- 최종: `selected: false`, `status: "archived"`
- Spaces/toggle.txt **없음**
- 큐 dedup(`queue.go:27`)이 이벤트를 합치고, 파이프라인은 현재 상태 기준으로 평가하므로 최종 deselect 상태가 우선

---

#### H2: 서로 다른 파일 동시 select

**테스트명**: `TestE2E_ConcurrentSelectsDifferentFiles`

**사전조건**: Archives/ — f1.txt ~ f5.txt (5개)

**절차**:
1. 5개 파일 inode를 단일 `POST /api/sync/select`로 전송
2. waitConverge

**기대결과**:
- 5개 모두 Spaces에 복사, 모두 synced
- 싱글 워커가 순차 처리하지만 전부 완료

---

#### H3: select 중 파일시스템 변경

**테스트명**: `TestE2E_SelectDuringFsChange`

**사전조건**: Archives/evolving.txt seed 완료

**절차**:
1. select 호출
2. 동시에 Archives/evolving.txt 내용 수정 (SSH 편집 시뮬레이션)
3. waitConverge

**기대결과**:
- SafeCopy가 source mtime 변경 감지 시 `ErrSourceModified` → 재시도
- 최종: Spaces/evolving.txt = 최신 Archives 내용
- `fileops.go:94-103`의 mtime 검증 동작 확인

---

### Group I: 엣지 케이스

---

#### I1: 숨김 파일 무시

**테스트명**: `TestE2E_HiddenFilesSkipped`

**사전조건**: Archives/.hidden, Archives/.DS_Store 존재

**절차**: e2eEnv 시작, seed 대기

**기대결과**:
- entries에 등록되지 않음 (`scanner.go:41`)
- API 응답에 나타나지 않음

---

#### I2: .sync-conflict 파일 무시

**테스트명**: `TestE2E_SyncConflictFilesSkipped`

**사전조건**: Archives/file.sync-conflict-20260101-123456.txt 존재

**절차**: e2eEnv 시작, seed 대기

**기대결과**:
- entries에 등록되지 않음 (`scanner.go:36`)
- Watcher도 무시 (`watcher.go:75`)

---

#### I3: 깊은 중첩 디렉토리

**테스트명**: `TestE2E_DeeplyNestedTree`

**사전조건**: Archives/a/b/c/d/e/deep.txt (content: "deep file")

**절차**:
1. seed 대기
2. 루트 "a" 디렉토리 select
3. waitConverge

**기대결과**:
- Spaces/a/b/c/d/e/deep.txt 존재, 내용 일치
- 중간 디렉토리 전부 생성
- DB parent_ino 체인 정확

---

#### I4: 대용량 파일 mtime 보존

**테스트명**: `TestE2E_LargeFileMtimePreserved`

**사전조건**: Archives/bigfile.bin (1MB, 랜덤 바이트, 알려진 mtime)

**절차**:
1. seed 대기
2. bigfile.bin select
3. waitConverge

**기대결과**:
- Spaces/bigfile.bin 내용 동일
- mtime 나노초 단위 일치 (`os.Chtimes` in SafeCopy, `fileops.go:106`)
- 시스템 전반의 나노초 mtime 비교가 정상 동작함을 확인

---

#### I5: 같은 이름, 다른 레벨

**테스트명**: `TestE2E_SameNameDifferentLevels`

**사전조건**:
```
Archives/
  README.md      (content: "root readme")
  docs/
    README.md    (content: "docs readme")
```

**절차**:
1. seed 대기
2. 루트 README.md + docs/ 모두 select
3. waitConverge

**기대결과**:
- Spaces/README.md = "root readme"
- Spaces/docs/README.md = "docs readme"
- DB entries: 서로 다른 inode, 서로 다른 parent_ino
- UNIQUE(parent_ino, name) 제약 충족

---

### Group J: Watcher 고유 동작

---

#### J1: Debounce 합침

**테스트명**: `TestE2E_WatcherDebounce`

**사전조건**: 데몬 실행 중, Archives/ 비어있음

**절차**:
1. Archives/burst.txt 쓰기
2. 100ms 내에 다른 내용으로 덮어쓰기
3. 100ms 내에 다시 덮어쓰기
4. waitConverge (> 300ms debounce + 처리)

**기대결과**:
- 파이프라인 평가 1회만 수행 (debounce가 pending map에서 합침, `watcher.go:79`)
- DB entry의 mtime = 마지막 쓰기 시점

---

#### J2: 파일 이름 변경 감지

**테스트명**: `TestE2E_WatcherRename`

**사전조건**: Archives/old-name.txt seed 완료

**절차**:
1. `os.Rename(Archives/old-name.txt, Archives/new-name.txt)`
2. waitConverge

**기대결과**:
- Watcher가 MOVED_FROM(old) + MOVED_TO(new) 이벤트 발생
- old-name.txt: P0에서 A_disk=0 감지 → 정리
- new-name.txt: P1에서 새로 등록
- 최종: "new-name.txt" entry만 존재

---

#### J3: Spaces 파일 삭제 → 자동 복구 (Self-healing)

**테스트명**: `TestE2E_WatcherSpacesDelete`

**사전조건**: file.txt synced (양쪽 존재, selected=true)

**절차**:
1. `os.Remove(Spaces/file.txt)`
2. waitConverge

**기대결과**:
- Watcher가 Spaces 삭제 감지 → 큐에 push
- 파이프라인: selected=true, S_disk=0 → P3에서 A→S 복사
- Spaces/file.txt 자동 복원

---

### Group K: 풀 라이프사이클

---

#### K1: 전체 사용자 워크플로우

**테스트명**: `TestE2E_FullUserWorkflow`

**절차**:
1. Archives에 doc.txt, photo.jpg, video.mp4 생성
2. seed → 모두 archived 확인
3. doc.txt select → synced 확인
4. Spaces/doc.txt 수정 (Spoke edit) → Archives 업데이트 확인
5. photo.jpg select → synced 확인
6. doc.txt deselect → Spaces에서 제거, Archives 유지 확인
7. Archives/photo.jpg 수정 (SSH edit) → Spaces 업데이트 확인
8. 각 단계에서 stats 확인

**기대결과**: 각 단계가 예상 상태 전이와 디스크 내용을 만족

---

#### K2: 대량 트리 일괄 select/deselect

**테스트명**: `TestE2E_BulkOperationsLargeTree`

**사전조건**: Archives/ — 10개 디렉토리 × 5개 파일 = 50+ 파일

**절차**:
1. seed
2. 루트 select (재귀) → 50+ 파일 Spaces에 복사
3. waitConverge
4. 전체 Spaces 확인
5. 루트 deselect → 50+ 파일 제거
6. waitConverge
7. Spaces 빈 상태 확인

**기대결과**:
- 전체 select: 50+ 파일 Spaces 존재, stats = 전체 크기
- 전체 deselect: Spaces 비어있음, stats = 0
- 큐 backpressure 처리 정상

---

## 3. 커버리지 매트릭스

### PRD 시나리오 ↔ E2E 테스트 매핑

| 시나리오 | 테스트 |
|---------|--------|
| #1 미존재 | A1 |
| #2 Archives untracked | D1, D2 |
| #3 Spaces untracked | A4, E3 |
| #4 양쪽 untracked | A3 |
| #5~#8 Lost | D7 |
| #9~#14 Recovering | D6 |
| #15 Archived | A2, B1(전), C1(후) |
| #17 Syncing | B1(중간), F1 |
| #19~#26 Repairing | E2, F1 |
| #27~#29 Removing | C1(중간), F1 |
| #30, #34 Conflict | D5 |
| #31 Synced | B1(후), A3 |
| #32 Spoke edit | D3 |
| #33 SSH edit | D4 |

### PRD 기능 요구사항 ↔ E2E 테스트 매핑

| 기능 | 테스트 |
|------|--------|
| F4-1: 파일 select | B1, B3 |
| F4-2: 폴더 select | B2 |
| F4-3: 파일/폴더 deselect | C1, C2 |
| F4-4: 용량 경고 | G1, G2 |
| F4-5: 상태 표시 | F1 (10가지) |

---

## 4. 파일 구조

```
filebrowser/sync/
  e2e_test.go              ← e2eEnv 하네스, 헬퍼, 공통 setup
  e2e_coldstart_test.go    ← Group A (4개)
  e2e_select_test.go       ← Group B (3개)
  e2e_deselect_test.go     ← Group C (2개)
  e2e_fsevents_test.go     ← Group D (7개)
  e2e_recovery_test.go     ← Group E (3개)
  e2e_status_test.go       ← Group F (1개, 11 서브)
  e2e_stats_test.go        ← Group G (2개)
  e2e_concurrent_test.go   ← Group H (3개)
  e2e_edge_test.go         ← Group I (5개)
  e2e_watcher_test.go      ← Group J (3개)
  e2e_lifecycle_test.go    ← Group K (2개)
```

빌드 태그: `//go:build e2e` — 일반 `go test`에서 제외, 명시적 `-tags e2e`로만 실행.
