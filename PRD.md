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
| 23 | 1 | 1 | 1 | 0 | 0 | 0 | - | Spaces 외부 유입 (S_db=0) |
| 24 | 1 | 1 | 1 | 0 | 0 | 1 | - | Spaces 외부 유입 + A 수정 (파일: conflict) |
| 25 | 1 | 1 | 1 | 0 | 1 | 0 | - | selected, S_db 누락 |
| 26 | 1 | 1 | 1 | 0 | 1 | 1 | - | selected, S_db 누락 + Archives 수정됨 |

### Group F: A_disk=1, A_db=1, S_disk=1, S_db=1

A_dirty, S_dirty 모두 유효.

| # | A_disk | A_db | S_disk | S_db | sel | A_d | S_d | 의미 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|------|
| 27 | 1 | 1 | 1 | 1 | 0 | 0 | 0 | deselect 대기 |
| 28 | 1 | 1 | 1 | 1 | 0 | 0 | 1 | deselect 대기 + Spoke 수정 |
| 29 | 1 | 1 | 1 | 1 | 0 | 1 | 0 | deselect 대기 + Archives 수정 |
| 30 | 1 | 1 | 1 | 1 | 0 | 1 | 1 | deselect 대기 + 양쪽 수정 |
| 31 | 1 | 1 | 1 | 1 | 1 | 0 | 0 | synced (정상) |
| 32 | 1 | 1 | 1 | 1 | 1 | 0 | 1 | Spoke 수정 |
| 33 | 1 | 1 | 1 | 1 | 1 | 1 | 0 | Archives SSH 수정 |
| 34 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 양쪽 수정 (conflict) |

---

## 데몬 우선순위 파이프라인

데몬은 한 파일에 대해 P1→P2→P3→P4→P5를 순서대로 평가한다. 각 단계의 진입조건이 참이면 해당 동작을 실행하고, 변경된 상태로 다음 단계를 이어서 평가한다. 한 번의 tick에서 한 파일에 대해 여러 단계가 연속 실행될 수 있다.

### P1. Archives 디스크 확보

**진입조건:** A_disk=0

**동작:**
- S_disk=1 → SafeCopy S→A → A_disk=1. **A_db=1이면 entries UPDATE(mtime, size) → A_dirty=0**
- S_disk=0, A_db=1 → spaces_view DELETE(있으면), entries DELETE → **#1로 종료** (후속 단계 스킵)
- S_disk=0, A_db=0 → **#1로 종료**

**통과 후 보장:** A_disk=1 (또는 미존재로 종료)

**보강 근거:** P1에서 cp S→A 후 entries.mtime을 갱신하지 않으면 A_dirty=1로 남아 P3에서 동일 내용을 다시 cp함 (#12, #14에서 발견). 디스크 I/O 후 해당 DB row가 있으면 같은 단계에서 UPDATE.

### P2. DB 등록

**진입조건:** A_db=0 (P1 통과 후 A_disk=1 보장)

**동작:**
- S_disk=0 → entries INSERT (stat(Archives), selected=0)
- S_disk=1 → entries INSERT (stat(Archives), selected=1)

**통과 후 보장:** A_db=1. PK는 Archives inode (stat().st_ino).

### P3. 변경 동기화

**진입조건:** A_disk=1 AND A_db=1 AND (A_dirty=1 OR S_dirty=1 OR (S_disk=1 AND S_db=0))

**동작:** 먼저 외부 유입(S_db=0 + S_disk=1)을 판별하고, 아니면 A_dirty와 S_dirty를 평가:

**외부 유입 (S_db=0 + S_disk=1):**

| selected | A_dirty | 동작 |
|:---:|:---:|------|
| 0 | 0 | p2ExternalAccept: SafeCopy S→A (Spoke wins), entries UPDATE(mtime, size, selected=1) |
| 0 | 1 | p2ExternalConflict: Archives rename → conflict-{N}, entries INSERT(conflict, sel=1). SafeCopy S→A, entries UPDATE(mtime, size, selected=1) |
| 1 | - | p2Reconcile: mtime 기반 copy 방향 결정 (디렉토리는 스킵, P5에서 baseline 생성) |

**변경 동기화 (S_db=1 또는 S_disk=0):**

| A_dirty | S_dirty | 동작 |
|:---:|:---:|------|
| 1 | N/A 또는 0 | entries UPDATE (mtime, size). selected=1 AND S_disk=1이면 추가로 SafeCopy A→S, spaces_view UPDATE |
| 0 | 1 | SafeCopy S→A, entries UPDATE (mtime, size), spaces_view UPDATE (synced_mtime) |
| 1 | 1 (sel=1) | **CONFLICT:** Archives/path → path_conflict-{N} rename, entries INSERT (conflict copy, selected=1). SafeCopy S→A, entries UPDATE, spaces_view UPDATE |
| 1 | 1 (sel=0) | **deselect 우선:** S_dirty 무시. entries UPDATE(mtime, size)만 실행. P4에서 MockDelete |

**통과 후 보장:** A_dirty=0, S_dirty=0 (또는 deselect 시 S_dirty는 P4 삭제로 소멸). 양쪽 디스크 내용과 DB mtime 일치.

### P4. 목표 상태 실현

**진입조건:** selected와 S_disk 불일치

**동작:**

| selected | S_disk | S_db | 동작 |
|:---:|:---:|:---:|------|
| 1 | 0 | 0 | 첫 동기화: SafeCopy A→S |
| 1 | 0 | 1 | 외부 삭제 (syncthing 등): **deselect** (selected=0). re-copy하지 않음 |
| 0 | 1 | - | MockDelete S (→ .trash/) |

**통과 후 보장:** selected=1 AND S_db=0이면 S_disk=1, selected=0이면 S_disk=0

**S_db 분기 근거:** Syncthing이 Mac 삭제를 Spaces에 전파하면 S_disk=0이 되지만 S_db=1은 유지됨 (syncthing은 DB를 건드리지 않음). S_db=1이면 이전에 Spaces에 동기화된 적이 있으므로 "외부 삭제"로 판단하고 deselect. S_db=0이면 한 번도 Spaces에 간 적 없는 "첫 동기화"이므로 copy A→S. re-copy 시 syncthing과 무한 루프 발생 (삭제 → 복사 → syncthing 전파 → 삭제 → 복사...).

### P5. DB 정합성

**진입조건:** S_db와 S_disk 불일치

**동작:**

| S_disk | S_db | 동작 |
|:---:|:---:|------|
| 1 | 0 | spaces_view INSERT (synced_mtime = stat(Spaces).st_mtime, checked_at = now) |
| 0 | 1 | spaces_view DELETE |

**통과 후 보장:** S_db=1 ↔ S_disk=1

### 검증 결과

34개 상태 전부 한 tick 수렴 확인 완료. P1/P4 보강 전에는 #12, #14(불필요 cp), #21, #22(2 tick 소요) 문제가 있었으나, 보강 후 34/34 한 tick 수렴.

34개 상태 × 모든 disk I/O 지점 × 가능한 외부 이벤트 ≈ 90개 조합의 중간 이벤트 검증도 완료. 진리표 밖으로 벗어나는 경우 없음. 허용된 위험 3개 패턴 (P1 cp 중 SSH dest 충돌, P3 Spoke wins SSH 덮어씀, P4 rm 직전 Spoke 수정)은 설계 의도 또는 극단적 타이밍.

---

## I/O 시나리오 (상태별)

각 시나리오는 Input(현재 7변수), 파이프라인 경로(각 단계의 진입/통과/스킵), Output(목표 정상 상태), Validation(검증 조건)으로 구성된다.

### #1. 미존재 (정상)

**UI 상태:** (없음)
**Input:** A_disk=0, A_db=0, S_disk=0, S_db=0, sel=0

**파이프라인:**
- P1: A_db=0이지만 A_disk=0, S_disk=0 → 등록할 대상 없음 → **스킵**

**Output:** 동일 (정상)


---

### #2. Archives untracked

**UI 상태:** `untracked`
**Input:** A_disk=1, A_db=0, S_disk=0, S_db=0, sel=0

**파이프라인:**
- P1: A_disk=1 → 스킵
- P2: A_db=0, S_disk=0 → entries INSERT (stat(Archives), sel=0) → **A_db=1, sel=0, A_dirty=0**
- P3~P5: 스킵

**Output:** → #15 (archived)


---

### #3. Spaces untracked (Spoke 생성)

**UI 상태:** `untracked`
**Input:** A_disk=0, A_db=0, S_disk=1, S_db=0, sel=0

**파이프라인:**
- P1: A_disk=0, S_disk=1 → SafeCopy S→A → **A_disk=1** (A_db=0이므로 entries UPDATE 없음)
- P2: A_db=0, S_disk=1 → entries INSERT (stat(Archives), sel=1) → **A_db=1, sel=1**
- P3~P4: 스킵
- P5: S_disk=1, S_db=0 → spaces_view INSERT → **S_db=1**

**Output:** → #31 (synced)

**설계 근거:** 기존 P1(DB등록)→P2(디스크확보) 순서에서는 entries INSERT 시 PK(Archives inode)가 필요한데 A_disk=0이라 inode가 없어 순환 의존성 발생. P1↔P2 교환으로 해결.

---

### #4. 양쪽 untracked

**UI 상태:** `untracked`
**Input:** A_disk=1, A_db=0, S_disk=1, S_db=0, sel=0

**파이프라인:**
- P1: A_disk=1 → 스킵
- P2: A_db=0, S_disk=1 → entries INSERT (stat(Archives), sel=1) → **A_db=1, sel=1**
- P3~P4: 스킵
- P5: S_disk=1, S_db=0 → spaces_view INSERT → **S_db=1**
- (다음 tick에서 S_dirty 평가: Spaces.mtime ≠ Archives.mtime이면 #32로 감지 → P3에서 해소)

**Output:** → #31 (synced) (mtime 차이 시 다음 tick에서 #32 경유)

> **실측: 내용이 다르면 위 해소가 성립하지 않는다 (미해결, 데이터 유실)**
>
> barefoot 측정(pi3, image 5146f5fb82b7). 양쪽에 같은 경로, 다른 내용, 빈 카탈로그:
>
> | mtime | Archives | Spaces | 충돌 사본 | 카탈로그 |
> |---|---|---|---|---|
> | Spaces 최신 | **덮어써짐** | Spaces 버전 | 없음 | synced |
> | Archives 최신 | Archives 버전 | **덮어써짐** | 없음 | synced |
> | 동일 | Archives 버전 | Spaces 버전 | 없음 | **synced인데 서로 다름** |
>
> 앞의 두 줄은 진 쪽 바이트가 `*.sync-conflict-*`도 `.trash`도 로그 경고도 없이
> 사라진다. 세 번째 줄에서는 어느 쪽도 최신이 아니라 복사 방향이 정해지지 않아
> **#32 경유가 일어나지 않는다** — baseline만 생성되고 두 파일이 영구히 어긋난
> 채 synced로 보고된다. 전체 재스캔으로도 복구되지 않는다.
>
> #24는 카탈로그 행이 있을 때 진 쪽을 `path_conflict-N`으로 보존한다. 메커니즘도
> 의도도 이미 있는데 **행이 없으면 그 경로에 도달하지 못한다** — 즉 충돌 보호가
> 카탈로그 상태에 의존한다. DB를 비우면 보호가 조용히 사라지고, CI e2e는 매
> 실행마다 `database/`를 비운다.
>
> 정책 미결: 진 쪽을 `path_conflict-N`으로 보존할 것인가(#24와 일관), 그리고
> mtime이 같고 크기가 다른 경우를 어떻게 처리할 것인가. 크기까지 같으면 해시
> 없이는 탐지 불가이며, 그 한계는 명시해 둔다.
> 상세: `filebrowser/docs/issues/untracked-conflict-data-loss.md`


---

### #5. Archives 유실, 복구 불가

**UI 상태:** `lost`
**Input:** A_disk=0, A_db=1, S_disk=0, S_db=0, sel=0

**파이프라인:**
- P1: A_disk=0, S_disk=0, A_db=1 → entries DELETE → **#1로 종료**

**Output:** → #1 (미존재)

---

### #6. Archives 유실, 복구 불가 (selected)

**UI 상태:** `lost`
**Input:** A_disk=0, A_db=1, S_disk=0, S_db=0, sel=1

**파이프라인:** #5와 동일
- P1: S_disk=0 → entries DELETE → **#1로 종료**

**Output:** → #1 (미존재)

---

### #7. 양쪽 디스크 없음

**UI 상태:** `lost`
**Input:** A_disk=0, A_db=1, S_disk=0, S_db=1, sel=0

**파이프라인:**
- P1: A_disk=0, S_disk=0, A_db=1 → spaces_view DELETE, entries DELETE → **#1로 종료**

**Output:** → #1 (미존재)

---

### #8. 양쪽 디스크 없음 (selected)

**UI 상태:** `lost`
**Input:** A_disk=0, A_db=1, S_disk=0, S_db=1, sel=1

**파이프라인:** #7과 동일
- P1: S_disk=0 → spaces_view DELETE, entries DELETE → **#1로 종료**

**Output:** → #1 (미존재)

---

### #9. Archives 유실, Spaces 생존, unselected

**UI 상태:** `recovering`
**Input:** A_disk=0, A_db=1, S_disk=1, S_db=0, sel=0

**설계 근거:** S_db=0 + S_disk=1은 외부 유입 패턴과 동일. Archives 유실 후 Spaces에서 복구한 파일을 다시 삭제하는 것은 비합리적이므로 accept하여 synced로 수렴.

**파이프라인:**
- P1: A_disk=0, S_disk=1 → SafeCopy S→A. A_db=1 → entries UPDATE(mtime, size) → **A_disk=1, A_dirty=0**
- P2: A_db=1 → 스킵
- P3: S_db=0 + S_disk=1 → 외부 유입 감지. entries UPDATE selected=1. SafeCopy S→A (Spoke wins) → entries UPDATE(mtime, size) → **sel=1**
- P4: sel=1, S_disk=1 → 일치 → 스킵
- P5: S_db=0 → spaces_view INSERT → **S_db=1**

**Output:** → #31 (synced)

---

### #10. Archives 유실, Spaces 생존, selected

**UI 상태:** `recovering`
**Input:** A_disk=0, A_db=1, S_disk=1, S_db=0, sel=1

**파이프라인:**
- P1: A_disk=0, S_disk=1 → SafeCopy S→A. A_db=1 → entries UPDATE → **A_disk=1, A_dirty=0**
- P2: A_db=1 → 스킵
- P3~P4: 스킵
- P5: S_disk=1, S_db=0 → spaces_view INSERT → **S_db=1**

**Output:** → #31 (synced)

---

### #11. Archives 유실, S synced, unselected

**UI 상태:** `recovering`
**Input:** A_disk=0, A_db=1, S_disk=1, S_db=1, sel=0, S_dirty=0

**파이프라인:**
- P1: A_disk=0, S_disk=1 → SafeCopy S→A. A_db=1 → entries UPDATE → **A_disk=1, A_dirty=0**
- P2: A_db=1 → 스킵
- P3: 스킵
- P4: sel=0, S_disk=1 → MockDelete S → **S_disk=0**
- P5: S_db=1, S_disk=0 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)

---

### #12. Archives 유실, S dirty, unselected

**UI 상태:** `recovering`
**Input:** A_disk=0, A_db=1, S_disk=1, S_db=1, sel=0, S_dirty=1

**파이프라인:**
- P1: A_disk=0, S_disk=1 → SafeCopy S→A. A_db=1 → entries UPDATE(mtime, size) → **A_disk=1, A_dirty=0**
- P2: A_db=1 → 스킵
- P3: S_dirty=1 → spaces_view UPDATE(synced_mtime) → **S_dirty=0** (내용 동일이므로 cp 스킵 가능)
- P4: sel=0, S_disk=1 → MockDelete S → **S_disk=0**
- P5: S_db=1, S_disk=0 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)

---

### #13. Archives 유실, S synced, selected

**UI 상태:** `recovering`
**Input:** A_disk=0, A_db=1, S_disk=1, S_db=1, sel=1, S_dirty=0

**파이프라인:**
- P1: A_disk=0, S_disk=1 → SafeCopy S→A. A_db=1 → entries UPDATE → **A_disk=1, A_dirty=0**
- P2: A_db=1 → 스킵
- P3~P5: 스킵

**Output:** → #31 (synced)

---

### #14. Archives 유실, S dirty, selected

**UI 상태:** `recovering`
**Input:** A_disk=0, A_db=1, S_disk=1, S_db=1, sel=1, S_dirty=1

**파이프라인:**
- P1: A_disk=0, S_disk=1 → SafeCopy S→A. A_db=1 → entries UPDATE → **A_disk=1, A_dirty=0**
- P2: A_db=1 → 스킵
- P3: S_dirty=1 → spaces_view UPDATE(synced_mtime) → **S_dirty=0**
- P4~P5: 스킵

**Output:** → #31 (synced)

---

### #15. archived (정상)

**UI 상태:** `archived`
**Input:** A_disk=1, A_db=1, S_disk=0, S_db=0, sel=0, A_dirty=0

**파이프라인:** 모든 단계 스킵 (정상)

**Output:** 동일


---

### #16. archived + Archives SSH 수정

**UI 상태:** `archived`
**Input:** A_disk=1, A_db=1, S_disk=0, S_db=0, sel=0, A_dirty=1

**파이프라인:**
- P1: A_disk=1 → 스킵
- P2: A_db=1 → 스킵
- P3: A_dirty=1, S_dirty N/A → entries UPDATE (mtime, size) → **A_dirty=0**
- P4: sel=0, S_disk=0 → 일치 → 스킵
- P5: 일치 → 스킵

**Output:** → #15 (archived)

---

### #17. select 대기

**UI 상태:** `syncing`
**Input:** A_disk=1, A_db=1, S_disk=0, S_db=0, sel=1, A_dirty=0

**파이프라인:**
- P1~P3: 스킵
- P4: sel=1, S_disk=0, S_db=0 → 첫 동기화: SafeCopy A→S, spaces_view INSERT → **S_disk=1, S_db=1**
- P5: 일치 → 스킵

**Output:** → #31 (synced)

---

### #18. select 대기 + Archives 수정됨

**UI 상태:** `syncing`
**Input:** A_disk=1, A_db=1, S_disk=0, S_db=0, sel=1, A_dirty=1

**파이프라인:**
- P1~P2: 스킵
- P3: A_dirty=1 → entries UPDATE (mtime, size). sel=1이지만 S_disk=0이므로 cp 불필요 → **A_dirty=0**
- P4: sel=1, S_disk=0 → SafeCopy A→S (최신 Archives) → **S_disk=1**
- P5: S_disk=1, S_db=0 → spaces_view INSERT → **S_db=1**

**Output:** → #31 (synced)

---

### #19. S_db 잔존 (고아)

**UI 상태:** `repairing`
**Input:** A_disk=1, A_db=1, S_disk=0, S_db=1, sel=0, A_dirty=0

**파이프라인:**
- P1~P3: 스킵
- P4: sel=0, S_disk=0 → 일치 → 스킵
- P5: S_disk=0, S_db=1 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)


---

### #20. S_db 잔존 + Archives 수정됨

**UI 상태:** `repairing`
**Input:** A_disk=1, A_db=1, S_disk=0, S_db=1, sel=0, A_dirty=1

**파이프라인:**
- P1~P2: 스킵
- P3: A_dirty=1 → entries UPDATE → **A_dirty=0**
- P4: sel=0, S_disk=0 → 일치 → 스킵
- P5: S_disk=0, S_db=1 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)


---

### #21. selected + 외부 Spaces 삭제

**UI 상태:** `repairing`
**Input:** A_disk=1, A_db=1, S_disk=0, S_db=1, sel=1, A_dirty=0

**설계 근거:** S_db=1은 이전에 Spaces에 동기화된 적이 있다는 의미. 그런데 S_disk=0이면 외부에서 삭제된 것 (syncthing이 Mac 삭제를 전파). syncthing은 DB를 건드리지 않으므로 S_db로 "첫 동기화"(S_db=0)와 "외부 삭제"(S_db=1)를 구분 가능. re-copy하면 syncthing과 무한 루프 발생.

**파이프라인:**
- P1~P3: 스킵
- P4: sel=1, S_disk=0, **S_db=1** → 외부 삭제 감지 → **deselect (sel=0)**
- P5: S_disk=0, S_db=1 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)

---

### #22. selected + 외부 Spaces 삭제 + Archives 수정됨

**UI 상태:** `repairing`
**Input:** A_disk=1, A_db=1, S_disk=0, S_db=1, sel=1, A_dirty=1

**설계 근거:** #21과 동일. ADirty는 P3에서 선처리되므로 P4 도달 시 이미 해소.

**파이프라인:**
- P1~P2: 스킵
- P3: A_dirty=1 → entries UPDATE. sel=1이지만 S_disk=0이므로 cp 불필요 → **A_dirty=0**
- P4: sel=1, S_disk=0, **S_db=1** → 외부 삭제 감지 → **deselect (sel=0)**
- P5: S_disk=0, S_db=1 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)

---

### #23. Spaces 외부 유입 (unselected, S_db 없음)

**UI 상태:** `repairing`
**Input:** A_disk=1, A_db=1, S_disk=1, S_db=0, sel=0, A_dirty=0

**설계 근거:** S_db=0은 이 파일이 Spaces에서 관리된 적이 없다는 의미. 그런데 S_disk=1이면 SSH/SMB 등 외부 경로로 Spaces에 유입된 것. selected=1로 전환하고 Spoke wins로 S 내용을 A에 반영.

**S_db=0 vs S_db=1 구분:** S_db=1이면 이전에 동기화됐다가 deselect된 것 → MockDelete(#25와 대조). S_db=0이면 한 번도 동기화된 적 없음 → 외부 유입.

**파이프라인:**
- P1~P2: 스킵
- P3: S_db=0 + S_disk=1 → 외부 유입 감지. entries UPDATE selected=1. A_dirty=0이므로 SafeCopy S→A (Spoke wins) → entries UPDATE(mtime, size) → **A_dirty=0**
- P4: sel=1, S_disk=1 → 일치 → 스킵
- P5: S_db=0 → spaces_view INSERT → **S_db=1**

**Output:** → #31 (synced)

---

### #24. Spaces 외부 유입 + Archives 수정됨 (conflict)

**UI 상태:** `conflict`
**Input:** A_disk=1, A_db=1, S_disk=1, S_db=0, sel=0, A_dirty=1

**설계 근거:** S_db=0 + S_disk=1 = 외부 유입. A_dirty=1 = SSH/SMB로 Archives도 수정됨. 양쪽 모두 사용자 의도가 담긴 변경이므로 conflict. (디렉토리는 A_dirty=false이므로 이 시나리오에 진입 불가.)

**파이프라인:**
- P1~P2: 스킵
- P3: S_db=0 + S_disk=1 + A_dirty=1 → **conflict 감지.**
  1. Archives/path → Archives/path_conflict-archive rename (#4의 split과 같은 origin 태그)
  2. conflict entries INSERT(selected=1)
  3. Spoke wins: SafeCopy S→A → entries UPDATE(mtime, size) → **A_dirty=0**
  4. entries UPDATE selected=1
- P4: sel=1, S_disk=1 → 일치 → 스킵
- P5: S_db=0 → spaces_view INSERT → **S_db=1**

**Output:** → #31 (synced). 파일의 경우 conflict copy → 다음 tick에서 #17 경로로 Spaces 전파


---

### #25. selected, S_db 누락

**UI 상태:** `repairing`
**Input:** A_disk=1, A_db=1, S_disk=1, S_db=0, sel=1, A_dirty=0

**파이프라인:**
- P1~P2: 스킵
- P3: S_db=0 + S_disk=1 + sel=1 → p2Reconcile (baseline 없으므로 mtime 기반 copy 방향 결정). mtime 일치 시 스킵, 불일치 시 최신→구버전 SafeCopy
- P4: sel=1, S_disk=1 → 일치 → 스킵
- P5: S_disk=1, S_db=0 → spaces_view INSERT → **S_db=1**

**Output:** → #31 (synced)


---

### #26. selected, S_db 누락 + Archives 수정됨

**UI 상태:** `repairing`
**Input:** A_disk=1, A_db=1, S_disk=1, S_db=0, sel=1, A_dirty=1

**파이프라인:**
- P1~P2: 스킵
- P3: A_dirty=1 → entries UPDATE. sel=1, S_disk=1이지만 S_db=0이므로 cp A→S 판단 불가 → **A_dirty=0**
- P4: sel=1, S_disk=1 → 일치 → 스킵
- P5: S_disk=1, S_db=0 → spaces_view INSERT → **S_db=1**
- (다음 tick: A.mtime ≠ S.mtime이면 S_dirty=1 → #32 → P3에서 cp S→A 또는 A_dirty=0이므로 A→S. 실제로는 Archives가 더 최신이므로 Archives wins를 위해 P3에서 A_dirty 해소 시 S_disk에도 반영 필요)

**주의:** P3에서 A_dirty 해소 시 S_disk=1이고 sel=1이면 cp A→S도 함께 실행해야 다음 tick 불필요. 이를 위해 P3의 A_dirty=1 동작에 "sel=1 AND S_disk=1이면 cp A→S, spaces_view UPDATE" 포함.

**수정 파이프라인:**
- P3: A_dirty=1, sel=1, S_disk=1 → entries UPDATE + cp A→S → **A_dirty=0**
- P5: S_db=0 → spaces_view INSERT → **S_db=1**

**Output:** → #31 (synced)


---

### #27. deselect 대기

**UI 상태:** `removing`
**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=0, A_dirty=0, S_dirty=0

**파이프라인:**
- P1~P3: 스킵
- P4: sel=0, S_disk=1 → MockDelete S → **S_disk=0**
- P5: S_disk=0, S_db=1 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)


---

### #28. deselect 대기 + Spoke 수정

**UI 상태:** `removing`
**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=0, A_dirty=0, S_dirty=1

**파이프라인:**
- P1~P2: 스킵
- P3: S_dirty=1, A_dirty=0 → SafeCopy S→A (Spoke 수정분 보존), entries UPDATE, spaces_view UPDATE → **S_dirty=0**
- P4: sel=0, S_disk=1 → MockDelete S → **S_disk=0**
- P5: S_disk=0, S_db=1 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)


---

### #29. deselect 대기 + Archives SSH 수정

**UI 상태:** `removing`
**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=0, A_dirty=1, S_dirty=0

**파이프라인:**
- P1~P2: 스킵
- P3: A_dirty=1, S_dirty=0 → entries UPDATE. sel=0이므로 Spaces 반영 불필요 → **A_dirty=0**
- P4: sel=0, S_disk=1 → MockDelete S → **S_disk=0**
- P5: S_disk=0, S_db=1 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)


---

### #30. deselect 대기 + 양쪽 수정

**UI 상태:** `removing`
**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=0, A_dirty=1, S_dirty=1

**설계 근거:** selected=0 + S_db=1 = deselect 의도 명확. S에서 수정이 있었어도 사용자가 deselect한 이상 그 수정분은 버린다. conflict가 아니다.

**파이프라인:**
- P1~P2: 스킵
- P3: A_dirty=1 → entries UPDATE(mtime, size) → **A_dirty=0**. S_dirty는 삭제 예정이므로 무시.
- P4: sel=0, S_disk=1 → MockDelete S → **S_disk=0**
- P5: S_disk=0, S_db=1 → spaces_view DELETE → **S_db=0**

**Output:** → #15 (archived)


---

### #31. synced (정상)

**UI 상태:** `synced`
**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=1, A_dirty=0, S_dirty=0

**파이프라인:** 모든 단계 스킵 (정상)

**Output:** 동일


---

### #32. Spoke 수정

**UI 상태:** `updating`
**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=1, A_dirty=0, S_dirty=1

**파이프라인:**
- P1~P2: 스킵
- P3: S_dirty=1, A_dirty=0 → SafeCopy S→A, entries UPDATE, spaces_view UPDATE → **S_dirty=0**
- P4: sel=1, S_disk=1 → 일치 → 스킵
- P5: 일치 → 스킵

**Output:** → #31 (synced)


---

### #33. Archives SSH 수정

**UI 상태:** `updating`
**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=1, A_dirty=1, S_dirty=0

**파이프라인:**
- P1~P2: 스킵
- P3: A_dirty=1, S_dirty=0 → entries UPDATE. sel=1 AND S_disk=1 → SafeCopy A→S, spaces_view UPDATE → **A_dirty=0**
- P4: sel=1, S_disk=1 → 일치 → 스킵
- P5: 일치 → 스킵

**Output:** → #31 (synced)


---

### #34. 양쪽 수정 (conflict)

**UI 상태:** `conflict`
**Input:** A_disk=1, A_db=1, S_disk=1, S_db=1, sel=1, A_dirty=1, S_dirty=1

**파이프라인:** (디렉토리는 A_dirty/S_dirty=false이므로 이 시나리오에 진입 불가.)
- P1~P2: 스킵
- P3: A_dirty=1 AND S_dirty=1 → **CONFLICT.**
  1. Archives/path → Archives/path_conflict-{N} rename
  2. entries INSERT (conflict copy, selected=1)
  3. cp S→A (Spoke wins), entries UPDATE, spaces_view UPDATE
  → **A_dirty=0, S_dirty=0**
- P4: sel=1, S_disk=1 → 일치 → 스킵
- P5: 일치 → 스킵
- (conflict copy: 다음 tick #17 → #31)

**Output:** 원본 → #31 (synced, Spoke 내용), conflict copy → #17 → #31


---

## 이동 진리표 (Move truth table)

기존 34개 시나리오 진리표는 **경로 하나**에 대한 상태 모델이다(A_disk, A_db,
S_disk, S_db, sel, A_dirty, S_dirty). 그런데 이동은 본질적으로 **경로 두 개**가
얽힌 사건이라 그 모델로는 표현이 안 된다. 그래서 이동은 경로가 아니라
**동일성(inode)** 을 기준으로 하는 별도의 표가 필요하다.

현재 구현에는 이동 감지가 없다. 그 결과 이동은 "옛 경로에서 사라짐 + 새 경로에
생김" 두 사건으로 분해되어 **양쪽 모두 남는 중복**이 만들어진다
(filebrowser/docs/issues/rename-collision-duplicates.md 참조).

### 판별 변수

| 변수 | 의미 |
|---|---|
| `M_A` | Archives에서 처리 중인 경로 P의 inode I가 카탈로그에 있고, 카탈로그가 기록한 경로 ≠ P |
| `M_S` | (2단계) Spaces 경로 P의 inode가 `spaces_view.spaces_ino`에 있고, 기록된 경로 ≠ P |
| `ID_ok` | `entries.mtime == mtime(P)` **그리고** `entries.size == size(P)` |
| `sel` | 해당 엔트리의 selected |
| `S_src` | Spaces에 **출발** 경로가 존재 |
| `Q` | 이 배치에 아직 처리 안 된 큐 항목이 남아 있음 |

`ID_ok`가 핵심 안전장치다. ext4는 inode 번호를 재사용하므로 "같은 inode가 다른
경로에 있음"이 곧 이동을 뜻하지 않는다. 진짜 `mv`는 경로 외에 아무것도 바꾸지
않으므로 mtime과 size가 정확히 일치해야 한다. 하나라도 어긋나면 이동으로 보지
않는다.

### 감지는 "생성 쪽"에서만 가능하다

디스크에 존재하는 경로를 처리할 때는 `statFile`이 이미 inode를 주므로
`GetEntry(inode)` 한 번(PK 조회, O(1))으로 판별이 끝난다. 반대로 **사라진 쪽**은
판별이 불가능하다 — inode I가 어디로 갔는지 알려면 트리 전체를 뒤져야 한다.
그래서 사라진 경로는 큐가 빌 때까지 **판단을 미룬다**.

### M. Archives 이동

| # | M_A | ID_ok | sel | S_src | 의미 | 동작 |
|---|:---:|:---:|:---:|:---:|---|---|
| M1 | 1 | 1 | 0 | 0 | 미선택 항목 이동 | 행만 이동(`parent_ino`/`name` UPDATE). Spaces 무관 |
| M2 | 1 | 1 | 1 | 1 | 동기화된 항목 이동 | 행 이동 + **Spaces도 rename**(재복사 아님) |
| M3 | 1 | 1 | 1 | 0 | 선택됐으나 Spaces에 없음 | 행 이동 후 P4가 목적지로 A→S 복사 |
| M4 | 1 | 0 | - | - | inode 재사용 의심 | 이동 아님 → 기존 동작(구 행 삭제 후 신규 등록) |
| M5 | 0 | - | - | - | 이동 아님 | 기존 P1~P5 그대로 |

**디렉터리 이동은 행 하나만 고치면 된다.** 경로는 `parent_ino` 사슬을 거슬러
계산되므로, 옮겨진 디렉터리의 `parent_ino`/`name`만 바꾸면 하위 항목의 경로는
자동으로 따라온다. 지금처럼 하위 트리를 통째로 지울 필요가 없고, 하위 항목의
`selected`도 보존된다.

### D. 사라진 출발 경로

| # | A_disk | A_db | Q | 동작 |
|---|:---:|:---:|:---:|---|
| D1 | 0 | 1 | 1 | 목적지가 아직 큐에 남아 있을 수 있음 → **판단 보류**(재큐, 최대 N회) |
| D2 | 0 | 1 | 0 | 진짜 삭제·유실 → 기존 P1 (#5~#14) |

보류가 필요한 이유: 지금은 P1가 먼저 돌아 `A_disk=0, S_disk=1`을 "Archives 유실"로
읽고 Spaces에서 되살린다(#13). 그러면 목적지를 보기도 전에 출발 경로가 부활해
중복이 확정된다. 보류는 감지 로직이 아니라, **P1가 성급하게 증거를 없애지
못하게** 막는 장치다.

### N. Spaces 이동 — 이동으로 다루지 않는다 (발자국 정책)

**결정**: Spaces 쪽 이동은 Archives에서 이동으로 재현하지 않는다. 새 위치를
등록하고, **옛 위치는 Archives에 남긴 채 deselect한다.** 사용자가 원하면 직접
지운다.

근거는 Spaces가 **손실 있는 뷰**라는 것이다. spoke 사용자는 디렉터리 안에서
선택된 부분집합만 본다. 그가 디렉터리를 rename했다고 해서 Archives에서 그가 본
적 없는 파일까지 옮기면, 볼 수 없었던 것에 대해 동의 없이 행동하는 셈이 된다.
아무것도 지우지 않으면 그 위험 자체가 성립하지 않는다. Archives는 store이고,
store에서의 삭제는 언제나 명시적 사용자 행위여야 한다.

**이 정책은 이미 구현되어 있다.** 이동 감지가 없어서 Spaces 이동이 "옛 경로에서
사라짐 + 새 경로에 생김"으로 분해되는데, 그 결과가 정확히 이 정책이다. 실측:

`mv Spaces/A/f.txt Spaces/Bdir/f.txt` (A/unsel.txt는 Archives에만 존재)

```
Archives/  A/f.txt      sel=0   ← 발자국, deselect됨 (되살아나지 않음)
           A/unsel.txt  sel=0   ← 그대로. spoke가 본 적 없는 파일
           Bdir/f.txt   sel=1   ← 새 위치
Spaces/    A/           (빈 디렉터리)
           Bdir/f.txt
```

따라서:

- **`spaces_ino` 컬럼(schema v5)은 필요 없다.** Spaces 쪽 동일성을 추적할 이유가
  사라진다.
- **N1/N2 행은 폐기한다.** 이동으로 판정할 일이 없다.
- **P0의 범위는 M 표 + D 표(Archives 쪽)로 한정된다.**

남는 잔재는 Spaces에 빈 디렉터리(`A/`)가 하나 남는 것뿐이다. Archives/A가
존재하므로 #3 승격을 유발하지 않는다. 데이터 위험이 아니라 미관 문제다.

### 방향 비대칭 (설계 원칙)

| 방향 | 의미 |
|---|---|
| Archives → Spaces | **이동한다.** store는 전부 알고 있으므로 안전하다 |
| Spaces → Archives | **복사하고 발자국을 남긴다.** 뷰가 진부분집합이므로 삭제하지 않는다 |

### 감지 불가 (의도적으로 기존 동작으로 폴백)

- **파일시스템을 넘는 이동**: `mv`가 복사+삭제가 되어 inode가 바뀐다. Archives는
  단일 마운트이므로 내부 이동은 안전하지만, 외부에서 들어오는 이동은 이동이 아니다.
- **이동과 수정이 한 번에**(`mv a b && echo x >> b`): mtime/size가 달라져 `ID_ok=0`.
  중복이 생기지만 지금과 같은 동작이므로 더 나빠지지는 않는다.

### 빠진 원시 연산: 동일성 단언 (identity assertion)

P0을 P1 앞에 붙이는 독립 모듈로 설계하면 절반만 얻는다. 실제로 빠져 있는 것은
**"이 경로에 있는 inode가 내 행이 주장하는 그 inode인가"** 라는 단언이다.

이동 감지는 이 단언의 한 소비자일 뿐이다:

| 관점 | 뜻 |
|---|---|
| `M_A` | 이 inode가 **내 행이 주장하지 않는 경로**에 있다 → 이동 |
| 역방향 | 이 경로에 **내 행이 주장하지 않는 inode**가 있다 → 정체·전치 |

두 번째가 없어서 생기는 실측 사례: a, b 모두 selected+synced 상태에서
`mv -f Archives/a.txt Archives/b.txt` 후

```
                 카탈로그   디스크
Archives/a.txt   274086     274088    ← 전치됨
Archives/b.txt   274088     274086    ← 전치됨

Archives/b.txt = SOURCE-CONTENT (정상)
Spaces/b.txt   = TARGET-CONTENT (덮어쓰기 이전, 갱신 안 됨)
```

두 파일 모두 15바이트에 mtime이 나노초까지 동일하므로 mtime·size 검사로는 잡히지
않는다. `spaces_ino`가 있어도 못 잡는다 — Spaces 파일은 건드려지지 않아 inode가
그대로다. 손상은 전적으로 Archives 쪽이다. 전체 재스캔으로도 남는다.

잡는 방법은 훨씬 싸다: 경로를 stat해서 얻은 inode를 행의 inode와 비교한다.
syscall 한 번이고 `statFile`은 이미 inode를 반환한다 — 비교를 하지 않을 뿐이다.

**따라서 이 단언은 각 단계가 이미 수행하는 상태 수집(state gathering)에 넣고,
이동 감지를 그 분기 중 하나로 둔다.** 상세: `filebrowser/docs/issues/catalog-inode-transposition.md`

### P0이 드러낼 새 요구사항: 빈 컨테이너 정리

`selected`는 위로만 전파되고 옆으로는 전파되지 않는다. 디렉터리의 `selected=1`은
"내 밑에 선택된 자손이 하나 이상 있다"는 뜻이지 "내 밑이 전부 선택됐다"가 아니다.
선택된 디렉터리는 내용에 대한 주장이 아니라 **컨테이너**이며, Spaces는 선택된
잎을 담는 데 필요한 만큼만 실체화된 투영이다.

덕분에 M2는 혼합 선택 디렉터리에서도 모호하지 않다 — 컨테이너를 rename하면
투영이 따라온다.

그런데 **잎이 컨테이너 밖으로 나가면** 그 컨테이너가 Spaces에 존재할 이유가
사라진다. 지금은 되살아남 버그가 이를 가리고 있어(잎이 다시 채워져서) 문제가
드러나지 않는다. P0이 이동을 실제로 이동시키는 순간 요구사항이 된다:

> 선택된 자손이 하나도 남지 않은 컨테이너는 Spaces에서 제거하고 deselect한다.

그렇게 하지 않으면 빈 디렉터리가 Spaces에 남고, Archives와 카탈로그 양쪽에 없는
경로가 되어 다음 패스에서 #3으로 승격된다 — 중복이 다른 문으로 되돌아온다.

### 목적지 충돌 — 점유 행을 지우고 원본 행을 옮긴다 (원자적, 롤백 가능)

**결정**: 목적지가 점유되어 있으면 **점유 행을 삭제하고 원본 행을 목적지로
옮긴다**. 단 전체 연산은 원자적이어야 하며, 어느 단계든 실패하면 아무것도
적용하지 않고 P1~P5로 흘려보낸다.

근거: 파일시스템 수준에서는 **충돌이 이미 해소되어 있다.** POSIX `rename(2)`는
원자적 교체이므로 `mv -f a b`는 옛 b를 unlink하고 a의 inode를 경로 b에 놓는다.
OS가 이미 승자를 정했다. 우리가 부르는 "충돌"은 파일시스템이 이미 결론 낸 사안에
대해 두 행이 어긋나 있는 **카탈로그 충돌**일 뿐이다.

```
mv -f a b 이후
디스크    경로 b = a의 inode + a의 내용,  경로 a 없음
카탈로그  row_a(Ia, 경로 a)   row_b(Ib, 경로 b)   ← Ib는 해제됨

해소:     row_b 삭제, row_a를 경로 b로 이동
결과:     행 하나, Ia, 경로 b — 디스크와 일치
```

삭제는 추측이 아니다. `stat(b).Ino == Ia ≠ Ib`가 row_b의 파일이 사라졌음을
증명한다. **점유 행의 staleness는 "그 행이 주장하는 경로가 여전히 그 행의
inode를 담고 있는가"로 판정한다** — syscall 한 번, O(1)이다.
"inode Ib가 어딘가에 아직 존재하는가"를 묻지 말 것: 트리 전체 스캔이 필요하고,
재사용된 inode 때문에 답이 무의미하다(실측에서 되살아난 파일이 Ib를 재사용했다).

#### 원자성과 롤백

Spaces 쪽에서 충돌이 재발한다. 양쪽 모두 selected였다면 Spaces에 `a`와 (옛 내용의)
`b`가 모두 있다. `os.Rename`은 `rename(2)`이므로 교체하지만, 그러면 옛 `Spaces/b`가
파괴되어 보상 동작이 복원할 대상을 잃는다.

`SafeCopy`가 이미 쓰는 방식(임시로 쓰고 rename)을 rename에 적용한다:

```
BEGIN
  assert stat(Archives/b).Ino == row_a.inode    ← a의 파일이 이제 b에 있다
  assert stat(Archives/b).Ino != row_b.inode    ← 점유자가 죽었음이 증명됨
  rename Spaces/b → Spaces/b.<tmp>              ← 파괴하지 말고 치워둔다
  rename Spaces/a → Spaces/b
  DELETE row_b        (spaces_view는 CASCADE)
  UPDATE row_a → b의 parent_ino/name
COMMIT  → 치워둔 임시 파일 unlink
실패 시: ROLLBACK, Spaces/b → Spaces/a 되돌리고 임시 파일 복원
```

임시 이름은 `*.sync-tmp` 형태여야 `.syncignore`가 건너뛰고 워처가 연산 도중
새 파일로 큐에 넣지 않는다.

#### 안전 바닥 (safety floor)

**P0은 전부 적용되거나 아무것도 적용되지 않는다. 어떤 단언이 실패하거나 어떤
단계가 에러를 내면 아무것도 적용하지 않고 P1~P5로 흘려보낸다.**

34행 진리표는 이미 정의되고 테스트된 상태 기계이므로, P0이 포기했을 때의 최악은
**현재 동작(중복)** 이다. P0은 현 상태보다 나빠질 수 없고 나아지기만 한다.
"P0이 옳다"보다 훨씬 신뢰하기 쉬운 성질이다.

이로써 (a)/(b) 선택이 사라진다: **(b)를 시도하고 실패하면 (a)로 떨어진다.**
사전에 확신할 필요가 없다.

**남은 위험**: 보상 rename 자체가 실패할 수 있다. Syncthing이 Spaces에 동시
기록하므로 그 사이 옛 이름이 재생성될 수 있다. 완전히 막을 수 없으므로 보상
동작은 best-effort로 두되 **크게 로그를 남긴다.** 보상 실패는 Archives와
카탈로그 양쪽에 없는 경로에 Spaces 내용을 남기고, 다음 패스에서 #3으로
승격된다 — 시끄럽지만 데이터 유실은 아니다.

### 파이프라인 배치

이동 판정은 **P1보다 앞**에 온다. P1의 복구 분기가 출발 경로를 되살리기 전에
가로채야 하기 때문이다.

```
P0 (이동 해소) → P1 (Archives 복구) → P2 → P3 → P4 → P5
```

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
- entries.selected = 1 → 데몬이 #17 경로 실행 (P4→P5)

**시나리오 4-2: 폴더 select**
- 상위 폴더 체크 시 하위 전체를 재귀적으로 selected=1 변경
- 선택된 총 용량이 실시간으로 합산 표시

**시나리오 4-3: 파일/폴더 deselect**
- 사용자가 체크 해제 → POST /deselect {inodes: [...]}
- entries.selected = 0 → 데몬이 #27 경로 실행 (P4→P5)
- Archives 파일은 변경 없음

**시나리오 4-4: 용량 경고**
- 선택된 총 용량이 Spaces 디스크 가용 공간을 초과한다
- 경고 메시지: "선택됨: 85GB / Spaces 여유: 68GB"
- select은 허용하되 경고 표시 (사용자 판단에 맡김)

**시나리오 4-5: 상태 표시**

데몬이 7변수를 평가한 결과를 10개 UI 상태로 매핑하여 텍스트 레이블로 표시한다.

| UI 상태 | 레이블 | 해당 # | 조건 |
|---------|--------|--------|------|
| archived | archived | 15, 16 | A_disk=1, A_db=1, S_disk=0, S_db=0, sel=0 |
| synced | synced | 31 | A_disk=1, A_db=1, S_disk=1, S_db=1, sel=1, A_dirty=0, S_dirty=0 |
| syncing | syncing | 17, 18 | sel=1, S_disk=0, S_db=0 |
| removing | removing | 27, 28, 29, 30 | sel=0, S_disk=1, S_db=1 |
| updating | updating | 32, 33 | sel=1, A_dirty XOR S_dirty (한쪽만 dirty) |
| conflict | conflict | 24, 34 | 양쪽 내용 충돌. #34: sel=1, A_dirty=1, S_dirty=1. #24: 외부 유입(S_db=0, S_disk=1) + A_dirty=1 |
| recovering | recovering | 9~14 | A_disk=0, S_disk=1 (Archives 복구 중) |
| lost | lost | 5~8 | A_disk=0, S_disk=0, A_db=1 (디스크 유실) |
| untracked | untracked | 2, 3, 4 | A_db=0 (DB 미등록) |
| repairing | repairing | 19~23, 25, 26 | S_db ↔ S_disk 불일치 (#24 제외, conflict로 분류) |

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
│    P1 → P2 → P3 → P4 → P5                  │
└─────────────────────────────────────────────┘
```

**이벤트 종류 무시:** 워커가 7변수를 매번 처음부터 계산하므로 이벤트 순서 의존성 제거.

**Self-action 처리:** 데몬 cp가 inotify 유발 → 큐에 재적재 → 다음 평가에서 #31(정상) → no-op. suppress set 불필요.

**싱글 워커 근거:** 멀티스레드에서 같은 파일에 대해 cp와 rm이 동시에 실행되면 무결성 파괴. Pi 4 I/O 병목은 HDD(30~50MB/s, 같은 디스크 내 cp)이므로 병렬 cp의 이점 없음.

**전체 스캔:** 기동 시 1회 + IN_Q_OVERFLOW 시에만. 주기적 폴링 없음.

### SafeCopy 프로토콜

모든 cp(P1, P3, P4)가 사용하는 안전한 복사:

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

P4 deselect 시 Spaces 파일을 즉시 삭제하지 않고 .trash로 이동:

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

양쪽 동시 수정 (#30, #34) 시 P3에서 감지:
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
| P1 cp S→A 중 SSH가 같은 path에 A 파일 생성 | source(S) mtime만 검증 → dest(A) 충돌 미감지, SSH 파일 덮어씀 | 극히 드묾 |
| P3 cp S→A 중 SSH가 A 수정 (Spoke wins) | SSH 수정분 덮어씀 | 설계 의도 |
| P4 rm S 직전 Spoke 수정 | P3→P4 사이 극소 시간에 Spoke 수정 끼어듦 → 미반영. Syncthing 전파 속도 고려 시 실제로는 S_dirty=1로 잡혀 #28 경유 | sel=0이므로 의도된 동작 |

## 향후 확장

- 다중 기기 관리: 원격 기기의 동기화 설정도 관리 (각 기기에 에이전트 필요)
- 자동 규칙: 파일 유형별 필터 (예: "영상 파일 제외", "문서만 동기화")
- 용량 알림: 디스크 사용량 임계치 초과 시 알림
- hash 기반 무결성 검증: 야간 배치로 BLAKE3 해싱, silent corruption 감지
- BTRFS 전환: 읽기전용 스냅샷으로 SSH 직접 조작에 대한 보호 강화, reflink으로 trashcan 공간 절약