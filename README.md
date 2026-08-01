# Codex Cursor Bridge

Codex가 계획하고 사용자가 승인한 작업을 Cursor가 구현하도록 위임하는 개인용 macOS 개발 도구입니다. Bridge는 승인된 Task 외의 자유 형식 프롬프트나 저장소 경로를 MCP로 받지 않으며, 격리된 Git worktree에서 구현한 결과를 독립 검증한 뒤 Draft PR까지만 게시합니다.

## 핵심 실행 모델

1. Task 승인은 대상 GitHub 저장소, 기준 SHA, PR destination branch, 컨텍스트 blob digest, 정책 버전, 검증 프로필에 결속됩니다.
2. 커밋된 Task의 commit/blob SHA를 SQLite Job에 기록합니다.
3. launchd가 관리하는 supervisor가 Job을 원자적으로 claim하고 lease/heartbeat를 유지합니다.
4. Cursor는 프로젝트 설정 source가 비활성화된 SDK sandbox에서 구조화된 `completed`, `blocked`, `needs_input` 결과를 제출하며, repair가 필요하면 실패 명령과 출력을 다음 시도에 내구적으로 보존합니다.
5. Bridge는 승인 기준에서 만든 독립 Git index, 최소 환경, 네트워크 차단 sandbox로 검증하고, 검증 전후의 immutable candidate tree와 변경 범위를 다시 대조합니다. `required_new_tests`가 있으면 삭제되지 않은 테스트 파일 변경도 최종 후보에 포함되어야 하며, 다른 검증 실패와 함께 제한된 repair 근거로 전달됩니다.
6. 최종 후보 tree/patch hash가 고정된 뒤 Git hook·commit/push signing을 비활성화하고, 등록된 fetch/push 원격에만 commit, push, Draft PR을 멱등 체크포인트로 수행합니다.
7. 성공 상태는 `DELIVERED_REVIEW_REQUIRED`입니다. 자동 구현 완료가 사람/Codex 리뷰 완료를 뜻하지 않습니다.

프로세스가 중단되면 만료된 lease를 새 supervisor가 회수합니다. 취소도 저장된 PID를 종료하지 않고 `CANCEL_REQUESTED`를 기록한 뒤 실행기가 실제 취소를 확인해야 `CANCELLED`가 됩니다. 다만 `PUBLISHING`은 원격 부작용의 point-of-no-return이므로 취소를 새로 받지 않고 게시 readback과 전달 상태 확정을 끝냅니다.

## 요구 사항

- macOS (Apple Silicon 또는 Intel)
- Node.js 22.13 이상, pnpm 11.10.0
- Codex CLI/app, Cursor API key
- launchd 환경에서도 비대화형 인증이 가능한 Git 및 GitHub CLI

## Mac에 설치

```bash
git clone <repository-url> CodexCursorBridge
cd CodexCursorBridge
pnpm install --frozen-lockfile
pnpm bootstrap
```

`pnpm bootstrap`은 다음을 수행합니다.

- Bridge 빌드
- 기존 macOS Keychain 항목에 비어 있지 않은 Cursor API key가 있으면 그대로 재사용(저장 명령을 호출하지 않음)
- 항목이 없거나 비어 있을 때만 보이는 터미널의 네이티브 Keychain prompt로 새 key 저장(명령 인자·환경 변수·로그로 전달하지 않음)
- 계정에서 실제 사용 가능한 Grok 모델 선택 및 `effort=high`, `fast=false` variant 명시적 고정
- repo-local `cursor-bridge` Codex plugin 설치
- `~/.codex/config.toml`에 네 개의 좁은 MCP 도구 등록
- `com.codex-cursor-bridge.supervisor` launchd service 설치

Bootstrap은 유효한 Keychain 항목을 `-U`로 갱신하지 않습니다. 여러 bootstrap이 동시에 실행되면 `$CURSOR_BRIDGE_HOME/.bootstrap-keychain.sqlite`(기본값 `~/.config/codex-cursor-bridge/.bootstrap-keychain.sqlite`)의 `BEGIN IMMEDIATE` transaction이 inspect부터 prompt/store와 검증까지 직렬화됩니다. 실제 interactive `security` child는 owner-only 보조 SQLite guard와 PID·UID·시작시각·명령행 identity marker가 종료될 때까지 함께 유지되므로, bootstrap 부모가 crash해도 child가 끝나거나 종료된 것을 확인하기 전에는 두 번째 prompt/store가 시작되지 않습니다. lock database와 guard에는 비밀을 쓰지 않고 파일은 owner-only로 보호합니다. 입력이 취소되거나 저장에 실패하면 새 key를 확인할 때까지 중단하고 Codex 설정, plugin, launchd 등록을 변경하지 않으므로, prompt가 보이는 macOS Terminal에서 다시 실행하세요. 기존 key를 교체하려면 먼저 명시적인 운영 절차로 Keychain 항목을 회전한 뒤 bootstrap을 재실행해야 합니다.

모델 ID와 검증된 variant params(`effort=high`, `fast=false`)·저장소 경로는 `~/.config/codex-cursor-bridge/config.json`, Job DB·로그·보고서·attestation·생성 worktree는 같은 디렉터리 아래에 저장됩니다. 기존 model-ID-only 설정도 계속 읽을 수 있으며, 실행 시 라이브 모델 목록에서 high-effort non-fast variant로 승격됩니다. `pnpm bootstrap`을 다시 실행하면 해당 params가 설정에 명시적으로 저장됩니다. Cursor SDK 재개 상태도 같은 디렉터리 아래에 저장되며 저장소에는 커밋되지 않습니다.

## 대상 저장소 등록

```bash
pnpm repo:add -- --alias my-service --path /absolute/path/to/my-service
```

명령은 실제 GitHub `origin`과 기본 브랜치를 확인합니다.

## Task 작성과 승인

```bash
mkdir -p tasks/my-service
cp examples/TASK-template.yaml tasks/my-service/TASK-001.yaml
# status: draft 상태에서 범위, 인수 조건, 검증, 중단 조건을 작성하고 사용자 승인을 받습니다.
pnpm task:approve -- --repository my-service --task TASK-001
git add tasks/my-service/TASK-001.yaml
git commit -m "docs: approve TASK-001"
```

승인 시 알 수 없는 Task 필드와 모호한 scope negation을 거부하고 대상 저장소의 fetch/push 원격을 모두 확인합니다. 새 Draft PR이면 기본 브랜치 SHA와 destination branch를, 기존 PR이면 같은 저장소에 있는 열린 Draft PR의 현재 head SHA·head branch·destination branch를 고정합니다. `context_files`도 해당 SHA의 blob ID로 해시됩니다. 승인 후에는 반드시 Task 파일을 커밋해야 dispatch할 수 있습니다.

Codex에 출력된 alias, Task ID, spec version, spec hash로 시작을 요청합니다. `cursor_start_task`는 Job ID를 즉시 반환하고 실제 실행은 supervisor가 계속합니다. 상태 조회, 취소, 보고서 조회에는 나머지 세 MCP 도구를 사용합니다.

## 상태와 운영

- 진행: `QUEUED`, `PREPARING`, `IMPLEMENTING`, `VERIFYING`, `REPAIRING`, `PUBLISHING`
- 취소 확인 중: `CANCEL_REQUESTED`
- 성공 전달: `DELIVERED_REVIEW_REQUIRED`
- 사람 확인 필요: `BLOCKED`, `FAILED`, `STALE_SPEC`, `SCOPE_VIOLATION`, `CANCELLED`

실행 로그, 보고서, attestation, SQLite 진단은 자격 증명 형태를 마스킹하고 소유자 전용 권한으로 저장합니다. 보고서와 attestation은 재작성할 때도 원자적으로 교체하며 `0600` 권한을 다시 강제합니다. 전달 완료 직후 정리가 실패하면 남은 worktree 또는 local branch를 확인할 수 있습니다. 정리 도중 프로세스가 종료되면 `cleanupStatus: PENDING`일 수 있으며, 이때 최종 진실은 Draft PR과 attestation입니다.

로컬 누적 성과는 다음으로 볼 수 있습니다.

```bash
pnpm stats
```

전체 전달 수, 첫 시도 전달률, 제한된 repair 후 전달 수, 차단·실패·취소 수를 JSON으로 출력합니다.

## 업데이트와 제거

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm bootstrap

pnpm uninstall
pnpm uninstall -- --delete-key  # Keychain 항목도 삭제
```

Bootstrap은 관리하는 Codex 설정 블록만 교체하고 기존 설정을 백업합니다. Uninstall은 MCP/plugin/launchd 등록을 제거하지만 Job 이력과 저장소 등록은 보존합니다.

## 개발 검증

```bash
pnpm verify
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/cursor-bridge
pnpm smoke:cursor
```

`pnpm smoke:cursor`는 임시 로컬 저장소만 사용하며 push나 PR 생성은 하지 않습니다.
의존성 방향과 composition root 원칙은
[`docs/architecture/cursor-bridge.md`](docs/architecture/cursor-bridge.md)에 정리되어
있으며 `tests/architecture.test.ts`가 계층 역참조, import cycle, 과대 구현 파일,
과대 함수와 과대 테스트 스위트를 검사합니다.
