# PRD: Syncthing Selective Sync Manager

## 개요

Pi 4에서 Archives(전체 파일)와 Spaces(동기화 대상 부분집합)를 관리하는 데몬 + 웹 UI. entries DB를 SSOT로 두고, 웹 UI에서 파일/폴더를 select/deselect하면 데몬이 양쪽 디스크를 동기화한다. Syncthing은 Spaces 폴더만 spoke 기기들과 동기화한다.

## 배경

### 현재 문제

- Syncthing의 Spaces 폴더(211GB)가 Pi의 USB 드라이브(113GB)를 초과
- 수동으로 Spaces → Archives(WD Purple 4TB)로 미러 후 삭제하는 워크플로우를 반복 중
- Syncthing은 Selective Sync를 공식 지원하지 않음 ([GitHub #7985](https://github.com/syncthing/syncthing/issues/7985), [#3940](https://github.com/syncthing/syncthing/issues/3940))
- .stignore 기반 접근은 오프라인 spoke, iOS 에이전트 불가 등의 문제로 불가
- Seafile 등 대안 플랫폼은 양방향 부분집합 동기화를 네이티브 지원하지 않음

### 목표 상태

- Archives(전체)와 Spaces(부분집합)를 DB 기반으로 관리
- Spaces 폴더: 현재 USB 드라이브가 아닌 4TB HDD의 protected/ 내 Archives와 같은 레벨에서 통합 관리
- 웹 UI는 FileBrowser 고유 로직(fs 직접 읽기)이 아닌 entries DB를 기반으로 표시
- 웹 UI에서 select/deselect만으로 동기화 대상 제어
- Spoke에서의 변경사항이 Archives에 자동 반영
- 수동 미러/삭제 워크플로우 제거

### 구현 환경

- Backend: Go 기반, 클린아키텍처 및 클린코드 기준 준용
- Frontend: FileBrowser 코드 컨벤션을 따름 (Vue, TypeScript)
- filebrowser/ 내 코드를 수정해 이 PRD를 만족시키는 것이 목표
- 빌드: FileBrowser와 통합 바이너리, 단일 Docker
- DB: SQLite (modernc.org/sqlite, pure Go) — entries/spaces_view 전용. FileBrowser DB(BoltDB)는 그대로 유지
- sync.db 경로: filebrowser.db와 같은 디렉토리에 고정 (설정 불필요)

```
# 실제 환경 디스크 구조
pi@pi1:~/Drives $ ls -al
Archive -> /srv/dev-disk-by-uuid-9241a63c-.../protected/Archive/
MidHub  -> /srv/dev-disk-by-uuid-b7c4b07a-.../alternative/MidHub/
Spaces  -> /srv/dev-disk-by-uuid-0a723d02-.../storage/Spaces/

# 테스트는 프로젝트 루트의 Archives/ Spaces/ 폴더에서만 수행
# 실제 파일/환경을 다루므로, 위험한 동작 전 반드시 사용자 확인
```

## 파일 상태 모델

### 7변수 정의

| 변수 | 의미 | 유효 조건 |
|------|------|----------|
| A_disk | Archives 디스크에 파일 존재 | 항상 |
| A_db | entries 테이블에 row 존재 | 항상 |
| S_disk | Spaces 디스크에 파일 존재 | 항상 |
| S_db | spaces_view 테이블에 row 존재 | A_db=1 필수 (FK) |
| selected | entries.selected = true | A_db=1 필수 |
| A_dirty | A_disk.mtime ≠ A_db.mtime | A_disk=1 AND A_db=1 |
| S_dirty | S_disk.mtime ≠ S_db.synced_mtime | S_disk=1 AND S_db=1 |

### 제약 조건

- A_db=0 → selected=0, S_db=0 (entries가 없으면 FK 위반, selected 불가)
- A_dirty: A_disk=0 OR A_db=0이면 N/A (비교 대상 없음)
- S_dirty: S_disk=0 OR S_db=0이면 N/A (비교 대상 없음)

### 정상 상태

| 상태 | A_disk | A_db | S_disk | S_db | sel | A_d | S_d |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 미존재 | 0 | 0 | 0 | 0 | 0 | - | - |
| archived | 1 | 1 | 0 | 0 | 0 | 0 | - |
| synced | 1 | 1 | 1 | 1 | 1 | 0 | 0 |

모든 불일치 상태의 데몬 처리 목표는 위 세 가지 중 하나로 수렴하는 것이다.

---

## 진리표

### Group A: A_db=0 (untracked)

A_db=0이면 selected=0, S_db=0 고정. dirty 모두 N/A.

| # | A_disk | A_db | S_disk | S_db | sel | A_d | S_d | 의미 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|------|
| 1 | 0 | 0 | 0 | 0 | 0 | - | - | 미존재 (정상) |
| 2 | 1 | 0 | 0 | 0 | 0 | - | - | Archives untracked |
| 3 | 0 | 0 | 1 | 0 | 0 | - | - | Spaces untracked (Spoke 생성) |
| 4 | 1 | 0 | 1 | 0 | 0 | - | - | 양쪽 untracked |

### Group B: A_db=1, A_disk=0 (Archives 디스크 유실)

A_dirty N/A (A_disk=0).

| # | A_disk | A_db | S_disk | S_db | sel | A_d | S_d | 의미 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|------|
| 5 | 0 | 1 | 0 | 0 | 0 | - | - | 복구 불가 |
| 6 | 0 | 1 | 0 | 0 | 1 | - | - | 복구 불가 (selected) |
| 7 | 0 | 1 | 0 | 1 | 0 | - | - | 양쪽 디스크 없음 |
| 8 | 0 | 1 | 0 | 1 | 1 | - | - | 양쪽 디스크 없음 (selected) |
| 9 | 0 | 1 | 1 | 0 | 0 | - | - | Archives 유실, Spaces 생존, unselected |
| 10 | 0 | 1 | 1 | 0 | 1 | - | - | Archives 유실, Spaces 생존, selected |
| 11 | 0 | 1 | 1 | 1 | 0 | - | 0 | Archives 유실, S synced, unselected |
| 12 | 0 | 1 | 1 | 1 | 0 | - | 1 | Archives 유실, S dirty, unselected |
| 13 | 0 | 1 | 1 | 1 | 1 | - | 0 | Archives 유실, S synced, selected |
| 14 | 0 | 1 | 1 | 1 | 1 | - | 1 | Archives 유실, S dirty, selected |

### Group C: A_disk=1, A_db=1, S_disk=0, S_db=0

S_dirty N/A.

| # | A_disk | A_db | S_disk | S_db | sel | A_d | S_d | 의미 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|------|
| 15 | 1 | 1 | 0 | 0 | 0 | 0 | - | archived (정상) |
| 16 | 1 | 1 | 0 | 0 | 0 | 1 | - | archived + Archives 수정됨 |
| 17 | 1 | 1 | 0 | 0 | 1 | 0 | - | select 대기 |
| 18 | 1 | 1 | 0 | 0 | 1 | 1 | - | select 대기 + Archives 수정됨 |

### Group D: A_disk=1, A_db=1, S_disk=0, S_db=1

S_dirty N/A (S_disk=0).

| # | A_disk | A_db | S_disk | S_db | sel | A_d | S_d | 의미 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|------|
| 19 | 1 | 1 | 0 | 1 | 0 | 0 | - | S_db 잔존 (고아) |
| 20 | 1 | 1 | 0 | 1 | 0 | 1 | - | S_db 잔존 + Archives 수정됨 |
| 21 | 1 | 1 | 0 | 1 | 1 | 0 | - | selected인데 Spaces 유실 |
| 22 | 1 | 1 | 0 | 1 | 1 | 1 | - | selected + Spaces 유실 + Archives 수정됨 |

### Group E: A_disk=1, A_db=1, S_disk=1, S_db=0

S_dirty N/A (S_db=0).

| # | A_disk | A_db | S_disk | S_db | sel | A_d | S_d | 의미 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|------|
| 23 | 1 | 1 | 1 | 0 | 0 | 0 | - | Spaces 잔존, unselected |
| 24 | 1 | 1 | 1 | 0 | 0 | 1 | - | Spaces 잔존 + Archives 수정됨 |
| 25 | 1 | 1 | 1 | 0 | 1 | 0 | - | selected, S_db 누락 |
| 26 | 1 | 1 | 1 | 0 | 1 | 1 | - | selected, S_db 누락 + Archives 수정됨 |

### Group F: A_disk=1, A_db=1, S_disk=1, S_db=1

A_dirty, S_dirty 모두 유효.

| # | A_disk | A_db | S_disk | S_db | sel | A_d | S_d | 의미 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|------|
| 27 | 1 | 1 | 1 | 1 | 0 | 0 | 0 | deselect 대기 |
| 28 | 1 | 1 | 1 | 1 | 0 | 0 | 1 | deselect 대기 + Spoke 수정 |
| 29 | 1 | 1 | 1 | 1 | 0 | 1 | 0 | deselect 대기 + Archives 수정 |
| 30 | 1 | 1 | 1 | 1 | 0 | 1 | 1 | deselect 대기 + 양쪽 수정 (conflict) |
| 31 | 1 | 1 | 1 | 1 | 1 | 0 | 0 | synced (정상) |
| 32 | 1 | 1 | 1 | 1 | 1 | 0 | 1 | Spoke 수정 |
| 33 | 1 | 1 | 1 | 1 | 1 | 1 | 0 | Archives SSH 수정 |
| 34 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 양쪽 수정 (conflict) |

---

## 데몬 우선순위 파이프라인

데몬은 한 파일에 대해 P0→P1→P2→P3→P4를 순서대로 평가한다. 각 단계의 진입조건이 참이면 해당 동작을 실행하고, 변경된 상태로 다음 단계를 이어서 평가한다. 한 번의 tick에서 한 파일에 대해 여러 단계가 연속 실행될 수 있다.

### P0. Archives 디스크 확보

**진입조건:** A_disk=0

**동작:**
- S_disk=1 → SafeCopy S→A → A_disk=1. **A_db=1이면 entries UPDATE(mtime, size) → A_dirty=0**
- S_disk=0, A_db=1 → spaces_view DELETE(있으면), entries DELETE → **#1로 종료** (후속 단계 스킵)
- S_disk=0, A_db=0 → **#1로 종료**

**통과 후 보장:** A_disk=1 (또는 미존재로 종료)

**보강 근거:** P0에서 cp S→A 후 entries.mtime을 갱신하지 않으면 A_dirty=1로 남아 P2에서 동일 내용을 다시 cp함 (#12, #14에서 발견). 디스크 I/O 후 해당 DB row가 있으면 같은 단계에서 UPDATE.

### P1. DB 등록

**진입조건:** A_db=0 (P0 통과 후 A_disk=1 보장)

**동작:**
- S_disk=0 → entries INSERT (stat(Archives), selected=0)
- S_disk=1 → entries INSERT (stat(Archives), selected=1)

**통과 후 보장:** A_db=1. PK는 Archives inode (stat().st_ino).

### P2. 변경 동기화

**진입조건:** A_disk=1 AND A_db=1 AND (A_dirty=1 OR S_dirty=1)

**동작:** A_dirty와 S_dirty를 동시에 평가:

| A_dirty | S_dirty | 동작 |
|:---:|:---:|------|
| 1 | N/A 또는 0 | entries UPDATE (mtime, size). selected=1 AND S_disk=1이면 추가로 SafeCopy A→S, spaces_view UPDATE |
| 0 | 1 | SafeCopy S→A, entries UPDATE (mtime, size), spaces_view UPDATE (synced_mtime) |
| 1 | 1 | **CONFLICT:** Archives/path → path_conflict-{N} rename, entries INSERT (conflict copy, selected=1). SafeCopy S→A, entries UPDATE, spaces_view UPDATE |

**통과 후 보장:** A_dirty=0, S_dirty=0. 양쪽 디스크 내용과 DB mtime 일치.

### P3. 목표 상태 실현

**진입조건:** selected와 S_disk 불일치

**동작:**

| selected | S_disk | 동작 |
|:---:|:---:|------|
| 1 | 0 | SafeCopy A→S. **S_db=1이면 spaces_view UPDATE(synced_mtime) → S_dirty=0** |
| 0 | 1 | MockDelete S (→ .trash/) |

**통과 후 보장:** selected=1이면 S_disk=1, selected=0이면 S_disk=0

**보강 근거:** P3에서 cp A→S 후 spaces_view.synced_mtime을 갱신하지 않으면 다음 tick에서 S_dirty=1로 오판하여 불필요한 역방향 cp 발생 (#21, #22에서 발견).

### P4. DB 정합성

**진입조건:** S_db와 S_disk 불일치

**동작:**

| S_disk | S_db | 동작 |
|:---:|:---:|------|
| 1 | 0 | spaces_view INSERT (synced_mtime = stat(Spaces).st_mtime, checked_at = now) |
| 0 | 1 | spaces_view DELETE |

**통과 후 보장:** S_db=1 ↔ S_disk=1

### 검증 결과

34개 상태 전부 한 tick 수렴 확인 완료. P0/P3 보강 전에는 #12, #14(불필요 cp), #21, #22(2 tick 소요) 문제가 있었으나, 보강 후 34/34 한 tick 수렴.

34개 상태 × 모든 disk I/O 지점 × 가능한 외부 이벤트 ≈ 90개 조합의 중간 이벤트 검증도 완료. 진리표 밖으로 벗어나는 경우 없음. 허용된 위험 3개 패턴 (P0 cp 중 SSH dest 충돌, P2 Spoke wins SSH 덮어씀, P3 rm 직전 Spoke 수정)은 설계 의도 또는 극단적 타이밍.

---

## I/O 시나리오 (상태별)

각 시나리오는 Input(현재 7변수), 파이프라인 경로(각 단계의 진입/통과/스킵), Output(목표 정상 상태), Validation(검증 조건)으로 구성된다.

### #1. 미존재 (정상)

**Input:** A_disk=0, A_db=0, S_disk=0, S_db=0, sel=0

**파이프라인:**
- P0: A_db=0이지만 A_disk=0, S_disk=0 → 등록할 대상 없음 → **스킵**

**Output:** 동일 (정상)


---

### #2. Archives untracked

**Input:** A_disk=1, A_db=0, S_disk=0, S_db=0, sel=0

**파이프라인:**
- P0: A_disk=1 → 스킵
- P1: A_db=0, S_disk=0 → entries INSERT (stat(Archives), sel=0) → **A_db=1, sel=0, A_dirty=0**
- P2~P4: 스킵

**Output:** → #15 (archived)


---

### #3. Spaces untracked (Spoke 생성)

**Input:** A_disk=0, A_db=0, S_disk=1, S_db=0, sel=0

**파이프라인:**
- P0: A_disk=0, S_disk=1 → SafeCopy S→A → **A_disk=1** (A_db=0이므로 entries UPDATE 없음)
- P1: A_db=0, S_disk=1 → entries INSERT (stat(Archives), sel=1) → **A_db=1, sel=1**
- P2~P3: 스킵
- P4: S_disk=1, S_db=0 → spaces_view INSERT → **S_db=1**

**Output:** → #31 (synced)

**설계 근거:** 기존 P0(DB등록)→P1(디스크확보) 순서에서는 entries INSERT 시 PK(Archives inode)가 필요한데 A_disk=0이라 inode가 없어 순환 의존성 발생. P0↔P1 교환으로 해결.

---

### #4. 양쪽 untracked

**Input:** A_disk=1, A_db=0, S_disk=1, S_db=0, sel=0

**파이프라인:**
- P0: A_disk=1 → 스킵
- P1: A_db=0, S_disk=1 → entries INSERT (stat(Archives), sel=1) → **A_db=1, sel=1**
- P2~P3: 스킵
- P4: S_disk=1, S_db=0 → spaces_view INSERT → **S_db=1**
- (다음 tick에서 S_dirty 평가: Spaces.mtime ≠ Archives.mtime이면 #32로 감지 → P2에서 해소)

**Output:** → #31 (synced) (mtime 차이 시 다음 tick에서 #32 경유)


---

### #5. Archives 유실, 복구 불가

**Input:** A_disk=0, A_db=1, S_disk=0, S_db=0, sel=0

**파이프라인:**
- P0: A_disk=0, S_disk=0, A_db=1 → entries DELETE → **#1로 종료**

**Output:** → #1 (미존재)

---

### #6. Archives 유실, 복구 불가 (selected)

**Input:** A_disk=0, A_db=1, S_disk=0, S_db=0, sel=1

**파이프라인:** #5와 동일
- P0: S_disk=0 → entries DELETE → **#1로 종료**

**Output:** → #1 (미존재)

---

### #7. 양쪽 디스크 없음

**Input:** A_disk=0, A_db=1, S_disk=0, S_db=1, sel=0

**파이프라인:**
- P0: A_disk=0, S_disk=0, A_db=1 → spaces_view DELETE, entries DELETE → **#1로 종료**

**Output:** → #1 (미존재)

---

### #8. 양쪽 디스크 없음 (selected)

**Input:** A_disk=0, A_db=1, S_disk=0, S_db=1, sel=1

**파이프라인:** #7과 동일
- P0: S_disk=0 → spaces_view DELETE, entries DELETE → **#1로 종료**

**Output:** → #1 (미존재)

---

### #9. Archives 유실, Spaces 생존, unselected

**Input:** A_disk=0, A_db=1, S_disk=1, S_db=0, sel=0

**파이프라인:**
- P0: A_disk=0, S_disk=1 → SafeCopy S→A. A_db=1 → entries UPDATE(mtime, size) → **A_disk=1, A_dirty=0**
- P1: A_db=1 → 스킵
- P2: 스킵
- P3: sel=0, S_disk=1 → MockDelete S → **S_disk=0**
- P4: 일치 → 스킵

**Output:** → #15 (archived)

---

### #10. Archives 유실, Spaces 생존, selected

**Input:** A_disk=0, A_db=1, S_disk=1, S_db=0, sel=1

**파이프라인:**
- P0: A_disk=0, S_disk=1 → SafeCopy S→A. A_db=1 → entries UPDATE → **A_disk=1, A_dirty=0**
- P1: A_db=1 → 스킵
- P2~P3: 스킵
- P4: S_disk=1, S_db=0 → spaces_view INSERT → **S_db=1**

**Output:** → #31 (synced)

---

### #11. Archives 유실, S synced, unselected

**Input:** A_disk=0, A_db=1, S_disk=1, S_db=1, sel=0, S_dirty=0

**파이프라인:**
- P0: A_disk=0, S_disk=1 → SafeCopy S→A. A_db=1 → entries UPDATE → **A_disk=1, A_dirty=0**
- P1: A_db=1 → 스킵
- P2: 스킵
- P3: sel=0, S_disk=1 → MockDelete S → **S_disk=0**
- P4: S_db=1, S_disk=0 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)

---

### #12. Archives 유실, S dirty, unselected

**Input:** A_disk=0, A_db=1, S_disk=1, S_db=1, sel=0, S_dirty=1

**파이프라인:**
- P0: A_disk=0, S_disk=1 → SafeCopy S→A. A_db=1 → entries UPDATE(mtime, size) → **A_disk=1, A_dirty=0**
- P1: A_db=1 → 스킵
- P2: S_dirty=1 → spaces_view UPDATE(synced_mtime) → **S_dirty=0** (내용 동일이므로 cp 스킵 가능)
- P3: sel=0, S_disk=1 → MockDelete S → **S_disk=0**
- P4: S_db=1, S_disk=0 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)

---

### #13. Archives 유실, S synced, selected

**Input:** A_disk=0, A_db=1, S_disk=1, S_db=1, sel=1, S_dirty=0

**파이프라인:**
- P0: A_disk=0, S_disk=1 → SafeCopy S→A. A_db=1 → entries UPDATE → **A_disk=1, A_dirty=0**
- P1: A_db=1 → 스킵
- P2~P4: 스킵

**Output:** → #31 (synced)

---

### #14. Archives 유실, S dirty, selected

**Input:** A_disk=0, A_db=1, S_disk=1, S_db=1, sel=1, S_dirty=1

**파이프라인:**
- P0: A_disk=0, S_disk=1 → SafeCopy S→A. A_db=1 → entries UPDATE → **A_disk=1, A_dirty=0**
- P1: A_db=1 → 스킵
- P2: S_dirty=1 → spaces_view UPDATE(synced_mtime) → **S_dirty=0**
- P3~P4: 스킵

**Output:** → #31 (synced)

---

### #15. archived (정상)

**Input:** A_disk=1, A_db=1, S_disk=0, S_db=0, sel=0, A_dirty=0

**파이프라인:** 모든 단계 스킵 (정상)

**Output:** 동일


---

### #16. archived + Archives SSH 수정

**Input:** A_disk=1, A_db=1, S_disk=0, S_db=0, sel=0, A_dirty=1

**파이프라인:**
- P0: A_disk=1 → 스킵
- P1: A_db=1 → 스킵
- P2: A_dirty=1, S_dirty N/A → entries UPDATE (mtime, size) → **A_dirty=0**
- P3: sel=0, S_disk=0 → 일치 → 스킵
- P4: 일치 → 스킵

**Output:** → #15 (archived)

---

### #17. select 대기

**Input:** A_disk=1, A_db=1, S_disk=0, S_db=0, sel=1, A_dirty=0

**파이프라인:**
- P0~P2: 스킵
- P3: sel=1, S_disk=0 → SafeCopy A→S → **S_disk=1** (S_db=0이므로 spaces_view UPDATE 없음)
- P4: S_disk=1, S_db=0 → spaces_view INSERT → **S_db=1**

**Output:** → #31 (synced)

---

### #18. select 대기 + Archives 수정됨

**Input:** A_disk=1, A_db=1, S_disk=0, S_db=0, sel=1, A_dirty=1

**파이프라인:**
- P0~P1: 스킵
- P2: A_dirty=1 → entries UPDATE (mtime, size). sel=1이지만 S_disk=0이므로 cp 불필요 → **A_dirty=0**
- P3: sel=1, S_disk=0 → SafeCopy A→S (최신 Archives) → **S_disk=1**
- P4: S_disk=1, S_db=0 → spaces_view INSERT → **S_db=1**

**Output:** → #31 (synced)

---

### #19. S_db 잔존 (고아)

**Input:** A_disk=1, A_db=1, S_disk=0, S_db=1, sel=0, A_dirty=0

**파이프라인:**
- P0~P2: 스킵
- P3: sel=0, S_disk=0 → 일치 → 스킵
- P4: S_disk=0, S_db=1 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)


---

### #20. S_db 잔존 + Archives 수정됨

**Input:** A_disk=1, A_db=1, S_disk=0, S_db=1, sel=0, A_dirty=1

**파이프라인:**
- P0~P1: 스킵
- P2: A_dirty=1 → entries UPDATE → **A_dirty=0**
- P3: sel=0, S_disk=0 → 일치 → 스킵
- P4: S_disk=0, S_db=1 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)


---

### #21. selected인데 Spaces 유실

**Input:** A_disk=1, A_db=1, S_disk=0, S_db=1, sel=1, A_dirty=0

**파이프라인:**
- P0~P2: 스킵
- P3: sel=1, S_disk=0 → SafeCopy A→S → **S_disk=1**. S_db=1 → spaces_view UPDATE(synced_mtime) → **S_dirty=0**
- P4: 일치 → 스킵

**Output:** → #31 (synced)

---

### #22. selected + Spaces 유실 + Archives 수정됨

**Input:** A_disk=1, A_db=1, S_disk=0, S_db=1, sel=1, A_dirty=1

**파이프라인:**
- P0~P1: 스킵
- P2: A_dirty=1 → entries UPDATE. sel=1이지만 S_disk=0이므로 cp 불필요 → **A_dirty=0**
- P3: sel=1, S_disk=0 → SafeCopy A→S (최신) → **S_disk=1**. S_db=1 → spaces_view UPDATE(synced_mtime) → **S_dirty=0**
- P4: 일치 → 스킵

**Output:** → #31 (synced)

---

### #23. Spaces 잔존, unselected

**Input:** A_disk=1, A_db=1, S_disk=1, S_db=0, sel=0, A_dirty=0

**파이프라인:**
- P0~P2: 스킵
- P3: sel=0, S_disk=1 → MockDelete S → **S_disk=0**

---

### #24. Spaces 잔존 + Archives 수정됨, unselected

**Input:** A_disk=1, A_db=1, S_disk=1, S_db=0, sel=0, A_dirty=1

**파이프라인:**
- P0~P1: 스킵
- P2: A_dirty=1 → entries UPDATE → **A_dirty=0**
- P3: sel=0, S_disk=1 → MockDelete S → **S_disk=0**
- P4: 일치 → 스킵

**Output:** → #15 (archived)


---

### #25. selected, S_db 누락

**Input:** A_disk=1, A_db=1, S_disk=1, S_db=0, sel=1, A_dirty=0

**파이프라인:**
- P0~P2: 스킵 (S_dirty N/A since S_db=0)
- P3: sel=1, S_disk=1 → 일치 → 스킵
- P4: S_disk=1, S_db=0 → spaces_view INSERT → **S_db=1**

**Output:** → #31 (synced)


---

### #26. selected, S_db 누락 + Archives 수정됨

**Input:** A_disk=1, A_db=1, S_disk=1, S_db=0, sel=1, A_dirty=1

**파이프라인:**
- P0~P1: 스킵
- P2: A_dirty=1 → entries UPDATE. sel=1, S_disk=1이지만 S_db=0이므로 cp A→S 판단 불가 → **A_dirty=0**
- P3: sel=1, S_disk=1 → 일치 → 스킵
- P4: S_disk=1, S_db=0 → spaces_view INSERT → **S_db=1**
- (다음 tick: A.mtime ≠ S.mtime이면 S_dirty=1 → #32 → P2에서 cp S→A 또는 A_dirty=0이므로 A→S. 실제로는 Archives가 더 최신이므로 Archives wins를 위해 P2에서 A_dirty 해소 시 S_disk에도 반영 필요)

**주의:** P2에서 A_dirty 해소 시 S_disk=1이고 sel=1이면 cp A→S도 함께 실행해야 다음 tick 불필요. 이를 위해 P2의 A_dirty=1 동작에 "sel=1 AND S_disk=1이면 cp A→S, spaces_view UPDATE" 포함.

**수정 파이프라인:**
- P2: A_dirty=1, sel=1, S_disk=1 → entries UPDATE + cp A→S → **A_dirty=0**
- P4: S_db=0 → spaces_view INSERT → **S_db=1**

**Output:** → #31 (synced)


---

### #27. deselect 대기

**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=0, A_dirty=0, S_dirty=0

**파이프라인:**
- P0~P2: 스킵
- P3: sel=0, S_disk=1 → MockDelete S → **S_disk=0**
- P4: S_disk=0, S_db=1 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)


---

### #28. deselect 대기 + Spoke 수정

**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=0, A_dirty=0, S_dirty=1

**파이프라인:**
- P0~P1: 스킵
- P2: S_dirty=1, A_dirty=0 → SafeCopy S→A (Spoke 수정분 보존), entries UPDATE, spaces_view UPDATE → **S_dirty=0**
- P3: sel=0, S_disk=1 → MockDelete S → **S_disk=0**
- P4: S_disk=0, S_db=1 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)


---

### #29. deselect 대기 + Archives SSH 수정

**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=0, A_dirty=1, S_dirty=0

**파이프라인:**
- P0~P1: 스킵
- P2: A_dirty=1, S_dirty=0 → entries UPDATE. sel=0이므로 Spaces 반영 불필요 → **A_dirty=0**
- P3: sel=0, S_disk=1 → MockDelete S → **S_disk=0**
- P4: S_disk=0, S_db=1 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)


---

### #30. deselect 대기 + 양쪽 수정 (conflict)

**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=0, A_dirty=1, S_dirty=1

**파이프라인:**
- P0~P1: 스킵
- P2: A_dirty=1 AND S_dirty=1 → **CONFLICT**
  1. Archives/path → Archives/path_conflict-{N} rename
  2. entries INSERT (conflict copy, selected=1)
  3. cp S→A (Spoke wins), entries UPDATE, spaces_view UPDATE
  → **A_dirty=0, S_dirty=0**
- P3: sel=0, S_disk=1 → MockDelete S → **S_disk=0**
- P4: S_disk=0, S_db=1 → spaces_view DELETE → **S_db=0**
- (conflict copy는 다음 tick에서 #17 → P3 cp A→S → P4 INSERT → #31)

**Output:** 원본 → #15 (archived), conflict copy → #17 → #31 (Spoke에 전파)


---

### #31. synced (정상)

**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=1, A_dirty=0, S_dirty=0

**파이프라인:** 모든 단계 스킵 (정상)

**Output:** 동일


---

### #32. Spoke 수정

**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=1, A_dirty=0, S_dirty=1

**파이프라인:**
- P0~P1: 스킵
- P2: S_dirty=1, A_dirty=0 → SafeCopy S→A, entries UPDATE, spaces_view UPDATE → **S_dirty=0**
- P3: sel=1, S_disk=1 → 일치 → 스킵
- P4: 일치 → 스킵

**Output:** → #31 (synced)


---

### #33. Archives SSH 수정

**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=1, A_dirty=1, S_dirty=0

**파이프라인:**
- P0~P1: 스킵
- P2: A_dirty=1, S_dirty=0 → entries UPDATE. sel=1 AND S_disk=1 → SafeCopy A→S, spaces_view UPDATE → **A_dirty=0**
- P3: sel=1, S_disk=1 → 일치 → 스킵
- P4: 일치 → 스킵

**Output:** → #31 (synced)


---

### #34. 양쪽 수정 (conflict)

**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=1, A_dirty=1, S_dirty=1

**파이프라인:**
- P0~P1: 스킵
- P2: A_dirty=1 AND S_dirty=1 → **CONFLICT**
  1. Archives/path → Archives/path_conflict-{N} rename
  2. entries INSERT (conflict copy, selected=1)
  3. cp S→A (Spoke wins), entries UPDATE, spaces_view UPDATE
  → **A_dirty=0, S_dirty=0**
- P3: sel=1, S_disk=1 → 일치 → 스킵
- P4: 일치 → 스킵
- (conflict copy: 다음 tick #17 → #31)

**Output:** 원본 → #31 (synced, Spoke 내용), conflict copy → #17 → #31


---

## 기능 요구사항

### F1. 파일 트리 탐색

FileBrowser의 네이티브 파일 탐색 기능으로 대체한다. 단, 하위 폴더 전개 시 다음 하위 레벨(n+1)까지 prefetch 캐싱을 완료해야 한다.

### F2. 파일 관리

FileBrowser의 네이티브 기능으로 대체한다. (프리뷰, 편집, 업로드, 다운로드, 복사/이동/삭제 등)

### F3. 파일 공유

FileBrowser의 네이티브 공유 기능으로 대체한다. (공유 링크, QR 코드, 비밀번호/만료 설정 등)

### F4. Selective Sync

핵심 기능. 트리에서 체크박스로 Spaces에 포함할 파일/폴더를 제어한다.

**시나리오 4-1: 파일 select**
- 트리의 각 항목 옆에 체크박스 표시
- 사용자가 체크 → POST /select {inodes: [...]}
- entries.selected = 1 → 데몬이 #17 경로 실행 (P3→P4)

**시나리오 4-2: 폴더 select**
- 상위 폴더 체크 시 하위 전체를 재귀적으로 selected=1 변경
- 선택된 총 용량이 실시간으로 합산 표시

**시나리오 4-3: 파일/폴더 deselect**
- 사용자가 체크 해제 → POST /deselect {inodes: [...]}
- entries.selected = 0 → 데몬이 #27 경로 실행 (P3→P4)
- Archives 파일은 변경 없음

**시나리오 4-4: 용량 경고**
- 선택된 총 용량이 Spaces 디스크 가용 공간을 초과한다
- 경고 메시지: "선택됨: 85GB / Spaces 여유: 68GB"
- select은 허용하되 경고 표시 (사용자 판단에 맡김)

**시나리오 4-5: 상태 표시**

데몬이 7변수를 평가한 결과를 10개 UI 상태로 매핑하여 텍스트 레이블로 표시한다.

| UI 상태 | 레이블 | 해당 # | 조건 |
|---------|--------|--------|------|
| archived | archived | 15 | A_disk=1, A_db=1, S_disk=0, S_db=0, sel=0, A_dirty=0 |
| synced | synced | 31 | A_disk=1, A_db=1, S_disk=1, S_db=1, sel=1, A_dirty=0, S_dirty=0 |
| syncing | syncing | 17, 18 | sel=1, S_disk=0 |
| removing | removing | 27, 28, 29 | sel=0, S_disk=1, S_db=1 |
| updating | updating | 32, 33 | A_dirty XOR S_dirty (한쪽만 dirty) |
| conflict | conflict | 30, 34 | A_dirty=1 AND S_dirty=1 |
| recovering | recovering | 9~14 | A_disk=0, S_disk=1 (Archives 복구 중) |
| lost | lost | 5~8 | A_disk=0, S_disk=0, A_db=1 (디스크 유실) |
| untracked | untracked | 2, 3, 4 | A_db=0 (DB 미등록) |
| repairing | repairing | 19~26 | S_db ↔ S_disk 불일치 |

데몬 처리 완료 시 실시간 갱신 (WebSocket 또는 polling)

### F5. 사용자 관리

**시나리오 5-1: 다중 사용자**
- 관리자가 사용자를 추가하고, 접근 가능한 디렉토리 범위를 지정한다
- 각 사용자는 자신의 범위 내에서만 파일을 탐색/관리할 수 있다

**시나리오 5-2: 권한 제어**
- 관리자가 사용자별로 업로드, 삭제, 공유, select/deselect 권한을 설정한다
- 권한이 없는 기능의 UI 요소는 비활성화된다

### F6. 검색

**시나리오 6-1: 파일 검색**
- 사용자가 검색어를 입력한다
- entries DB에서 name LIKE 매칭
- 결과에 상태 레이블(archived/synced/syncing/removing/updating/conflict/recovering/lost/untracked/repairing)이 표시된다

## UI 와이어프레임

```
┌──────────────────────────────────────────────────────────┐
│  Sync Manager                                🔍 검색     │
├──────────┬───────────────────────────────────────────────┤
│          │  📁 Archives > Documents > Work               │
│ 사이드바  │                                               │
│          │  ☑ [synced]  Report.docx     (2.1 MB)  2026-02│
│ Archives │  ☑ [synced]  Slides.pptx     (8.3 MB)  2026-01│
│ 3.2 TB   │  ☐ [archived] OldProject/   (1.2 GB)  2025-12│
│ 여유     │  ☑ [syncing] BigFile.zip     (4.1 GB)  2026-02│
│          │  ☑ [synced]  Notes/          (340 MB)  2026-02│
│ Spaces   │                                               │
│ 57.4 GB  │                                               │
│ ─────── │                                               │
│ 68.2 GB  │                                               │
│ 여유     │───────────────────────────────────────────────│
│          │  Spaces: 57.4 GB / 여유: 68.2 GB              │
│ 설정     │  pending: 1 copy, 0 delete                    │
└──────────┴───────────────────────────────────────────────┘
```

## 아키텍처

### 디스크 구조

```
Pi 4TB HDD (protected/):
├── Archives/          ← entries 전체의 구체화
│   ├── (파일/폴더)
│   ├── .trash/        ← 데몬 삭제 시 보관 (TTL 30일)
│   └── .stversions/   ← Syncthing versioning 저장소
└── Spaces/            ← entries.selected=1인 것의 구체화 (같은 HDD)

Syncthing: Spaces/ 폴더만 동기화 (spoke 기기들과)
           versioning은 Archives/.stversions에 저장

# 같은 디스크이므로 향후 BTRFS 전환 시 cp --reflink 즉시 복사 가능
# 현재(ext4)는 같은 디스크 내 cp로 30~50MB/s
```

### SSOT

**entries DB가 SSOT.** selected 포함 파일의 모든 메타데이터를 entries가 소유. 양쪽 디스크는 DB의 파생물(구체화). spaces_view는 self-action 판별 전용.

```
         entries DB  ← SSOT (selected 포함)
        spaces_view  ← Spaces 디스크 mtime 추적
           /         \
 Archives 디스크    Spaces 디스크
 (전체)             (부분집합)
```

### DB 스키마

```sql
CREATE TABLE entries (
    inode      INTEGER PRIMARY KEY,   -- stat().st_ino (Archives 파일시스템)
    parent_ino INTEGER REFERENCES entries(inode),  -- NULL = root
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK(type IN ('dir','video','audio','image','pdf','text','blob')),
    size       INTEGER,               -- dir은 NULL
    mtime      INTEGER NOT NULL,      -- 나노초 (부동소수점 비교 문제 방지)
    selected   INTEGER NOT NULL DEFAULT 0,  -- 0=archived, 1=synced 목표
    UNIQUE(parent_ino, name)          -- rm+touch 시 inode 교체: ON CONFLICT DO UPDATE SET inode=...
);

CREATE INDEX idx_parent ON entries(parent_ino);
CREATE INDEX idx_selected ON entries(selected);

-- Spaces 디스크 동기화 상태 추적 (S_dirty 계산)
CREATE TABLE spaces_view (
    entry_ino    INTEGER PRIMARY KEY REFERENCES entries(inode),
    synced_mtime INTEGER NOT NULL,    -- 나노초
    checked_at   INTEGER NOT NULL     -- 나노초
);
```

- entries PK = Archives inode. 같은 파일시스템 내에서 유일. 디스크 분리 시에도 스키마 변경 불필요.
- UNIQUE(parent_ino, name): 같은 디렉토리에 같은 이름의 다른 inode 파일이 생기면(rm+touch) ON CONFLICT로 기존 row를 교체.
- type 7가지: 스캔 시 mime.TypeByExtension()으로 판별. 프론트엔드 아이콘/프리뷰 라우팅에 사용.
- mtime 나노초: REAL 대신 INTEGER로 부동소수점 비교 오차 방지.
- FK: spaces_view.entry_ino → entries.inode. 삭제 시 spaces_view 먼저, 삽입 시 entries 먼저.

### 컴포넌트

```
┌────────────┐      ┌─────────────┐      ┌──────────────┐
│  Web UI     │      │   Daemon     │      │  Syncthing    │
│ (읽기+API)  │──────│ (DB+디스크)  │      │ (Spaces 동기) │
└────────────┘      └──────┬──────┘      └──────┬───────┘
  DB 직접 읽기        unix   │  inotify           │
  POST /select       socket │  감시 (양쪽)        │
  POST /deselect       hint │                     │
                           ▼                     ▼
                    ┌──────────┐          ┌──────────┐
                    │ Archives  │          │  Spaces   │
                    │  디스크    │          │  디스크   │
                    │ +.trash   │          │          │
                    │ +.stver   │          │          │
                    └──────────┘          └──────────┘
```

## 이벤트 처리 아키텍처

### eval queue (싱글 워커)

```
┌─────────────┐  ┌─────────────┐
│ inotify     │  │ Web UI      │
│ (Archives)  │  │ POST /select│
│ (Spaces)    │  │ POST /desel │
└──────┬──────┘  └──────┬──────┘
       │                │
       ▼                ▼
┌─────────────────────────────────────────────┐
│              debounce (300ms)                │
│  같은 path 이벤트 합침, MOVED 짝 매칭       │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│           eval queue (Set<path>)             │
│  "이 path를 재평가하라" 신호만               │
│  이벤트 종류(CREATE, MODIFY 등)는 버림       │
│  Set이므로 중복 자동 제거                    │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│         worker (싱글 스레드)                  │
│  while queue not empty:                      │
│    path = queue.pop()                        │
│    stat() 양쪽 + DB 조회 → 7변수 계산       │
│    P0 → P1 → P2 → P3 → P4                  │
└─────────────────────────────────────────────┘
```

**이벤트 종류 무시:** 워커가 7변수를 매번 처음부터 계산하므로 이벤트 순서 의존성 제거.

**Self-action 처리:** 데몬 cp가 inotify 유발 → 큐에 재적재 → 다음 평가에서 #31(정상) → no-op. suppress set 불필요.

**싱글 워커 근거:** 멀티스레드에서 같은 파일에 대해 cp와 rm이 동시에 실행되면 무결성 파괴. Pi 4 I/O 병목은 HDD(30~50MB/s, 같은 디스크 내 cp)이므로 병렬 cp의 이점 없음.

**전체 스캔:** 기동 시 1회 + IN_Q_OVERFLOW 시에만. 주기적 폴링 없음.

### SafeCopy 프로토콜

모든 cp(P0, P2, P3)가 사용하는 안전한 복사:

```go
func SafeCopy(ctx context.Context, src, dstTmp, dst string, queue EvalQueue) error {
    in, _ := os.Open(src)
    defer in.Close()
    mtimeBefore := mustStat(src).ModTime()

    out, _ := os.Create(dstTmp)
    defer out.Close()

    for {
        if ctx.Err() != nil {      // 같은 path 새 이벤트 → cancel
            os.Remove(dstTmp)
            return ctx.Err()
        }
        _, err := io.CopyN(out, in, 100*1024*1024)  // 100MB 청크
        if errors.Is(err, io.EOF) { break }
        if err != nil { os.Remove(dstTmp); return err }
    }
    out.Close()

    if !mustStat(src).ModTime().Equal(mtimeBefore) {  // source 변경 감지
        os.Remove(dstTmp)
        return ErrSourceChanged  // 다음 tick 재시도
    }
    return os.Rename(dstTmp, dst)  // atomic
}
```

- **청크 단위 취소:** 100MB마다 context cancel 확인. 같은 디스크 cp 기준 ~2.5초 간격.
- **mtime 검증:** cp 완료 후 source mtime 비교. 변경 시 tmp 삭제, 다음 tick 재시도.
- **atomic rename:** tmp → dst. 중간 상태 파일이 목적지에 노출되지 않음.

### MockDelete

P3 deselect 시 Spaces 파일을 즉시 삭제하지 않고 .trash로 이동:

```
MockDelete(path) → mv Spaces/path → Spaces/.trash/YYYY-MM-DD/path
```

### Rename 처리

inotify MOVED_FROM/TO는 cookie 값으로 짝 매칭:
- MOVED_FROM 수신 → cookie 보관, ~50ms 대기
- 같은 cookie의 MOVED_TO 도착 → entries UPDATE(parent_ino, name)
- 미도착 → 삭제 처리 (데이터 손실 없음, 다음 스캔에서 재등록)

### .sync-conflict 파일

`*.sync-conflict-*` 패턴은 scanner에서 무시. entries에 등록하지 않음.

### inotify debounce

```
inotify 이벤트 수집 (300ms 윈도우)
  ├─ MOVED_FROM/TO → inode 짝 매칭
  ├─ DELETE → CREATE 동일 경로 → atomic write → MODIFY로 합침
  ├─ 동일 파일 MODIFY 중복 제거
  └─ 최종: 영향받은 path를 eval queue에 push
```

### Daemon 기동 (recovery)

```
1. Archives + Spaces 디스크 full walk
2. entries + spaces_view와 diff
3. 모든 파일에 대해 7변수 계산
4. 불일치 항목에 파이프라인 실행
```

### inotify IN_Q_OVERFLOW

이벤트 유실 감지 → Daemon 기동과 동일한 full scan 실행.

## 데이터 보호

### Syncthing Versioning (Spaces)

Syncthing 자체 versioning 설정으로 Spoke 발 변경에 대한 구버전을 보관한다. 데몬과 연동 없이 독립적으로 동작한다.

```xml
<folder id="spaces">
  <versioning type="staggered">
    <param key="maxAge" val="2592000"/>     <!-- 30일 -->
    <param key="cleanInterval" val="3600"/>
    <fsPath>/archives/.stversions</fsPath>  <!-- Archives 디스크에 저장 -->
  </versioning>
</folder>
```

Spoke에서의 수정/삭제 시 Syncthing이 Spaces 반영 전에 구버전을 `.stversions`에 보관한다. 랜섬웨어로 Spoke 파일이 암호화되어도 `.stversions`에서 복구 가능하다.

### Archives Trashcan (삭제 전용)

데몬이 Archives 파일을 삭제할 때 `.trash`에 복사 후 삭제한다. 덮어쓰기 시에는 동작하지 않는다.

```
Archives/
├── files/          ← 실제 파일
├── .trash/         ← 삭제된 파일 보관
│   └── 2026-02-12/
│       └── Documents/report.docx
└── .stversions/    ← Syncthing versioning 저장소
```

**자동 정리:**
```bash
# cron: 30일 지난 항목 삭제
find /archives/.trash -mtime +30 -delete
```

### Conflict 처리

양쪽 동시 수정 (#30, #34) 시 P2에서 감지:
1. Archives 기존 파일을 `path_conflict-{N}`으로 rename
2. conflict copy에 대해 entries INSERT (selected=1)
3. Spoke wins: Spaces 내용을 Archives에 반영
4. conflict copy가 selected=1이므로 다음 tick에서 #17 경로로 Spoke에 자동 전파 → 사용자가 인지

### 보호 범위 요약

| 위협 | 보호 수단 | 복구 경로 |
|------|----------|----------|
| Spoke 파일 수정 (랜섬 포함) | Syncthing .stversions | .stversions에서 구버전 복원 |
| Spoke 파일 삭제 | Archives .trash | .trash에서 복원 |
| Archives 직접 수정 (SSH) | 없음 | - |
| Archives 직접 삭제 (SSH) | 없음 | - |

## 제약 사항

- entries DB가 SSOT이므로, 디스크와 DB 불일치는 "아직 해소되지 않은 상태"로 취급 (eventual consistency)
- inotify 커널 큐 기본 8192개, 초과 시 IN_Q_OVERFLOW → full scan fallback
- Archives와 Spaces 모두 inotify 감시 대상
- SSH에서 Archives 파일을 직접 삭제하면 trashcan 보호를 받지 못함 (허용된 위험)
- SSH에서 Archives 파일을 직접 수정하면 versioning 보호를 받지 못함 (허용된 위험)
- Syncthing은 Spaces 폴더만 동기화, Archives는 Syncthing과 무관
- 양쪽 동시 수정 conflict 시 Spoke wins (Archives SSH 수정분은 conflict copy로 보존)

### 허용된 위험 (검증 완료)

34개 상태 × 모든 disk I/O 지점 × 가능한 외부 이벤트 ≈ 90개 조합 검증 완료. 진리표 밖으로 벗어나는 경우 없음.

| 패턴 | 설명 | 판정 |
|------|------|------|
| P0 cp S→A 중 SSH가 같은 path에 A 파일 생성 | source(S) mtime만 검증 → dest(A) 충돌 미감지, SSH 파일 덮어씀 | 극히 드묾 |
| P2 cp S→A 중 SSH가 A 수정 (Spoke wins) | SSH 수정분 덮어씀 | 설계 의도 |
| P3 rm S 직전 Spoke 수정 | P2→P3 사이 극소 시간에 Spoke 수정 끼어듦 → 미반영. Syncthing 전파 속도 고려 시 실제로는 S_dirty=1로 잡혀 #28 경유 | sel=0이므로 의도된 동작 |

## 향후 확장

- 다중 기기 관리: 원격 기기의 동기화 설정도 관리 (각 기기에 에이전트 필요)
- 자동 규칙: 파일 유형별 필터 (예: "영상 파일 제외", "문서만 동기화")
- 용량 알림: 디스크 사용량 임계치 초과 시 알림
- hash 기반 무결성 검증: 야간 배치로 BLAKE3 해싱, silent corruption 감지
- BTRFS 전환: 읽기전용 스냅샷으로 SSH 직접 조작에 대한 보호 강화, reflink으로 trashcan 공간 절약