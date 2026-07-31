# Cursor Bridge 아키텍처

## 목표

Cursor Bridge는 승인된 작업의 실행을 조율하는 애플리케이션 규칙과 macOS, SQLite,
Git, GitHub, Cursor SDK 같은 외부 기술을 분리한다. 핵심 규칙은 바깥 구현을 직접
참조하지 않고, 바깥 구현이 안쪽에서 정의한 포트를 구현한다.

```text
domain
  ├─ job 상태·전이 정책
  ├─ 승인 Task 계약
  └─ 구성 값 객체
       ↑
application
  ├─ workflow use case
  └─ WorkflowStatePort / PublicationStatePort / WorkflowAdapter
       ↑
outbound adapters
  ├─ SQLite JobStore
  ├─ Cursor implementer
  ├─ Git worktree / candidate / publication
  ├─ independent verifier
  └─ report / attestation writer
       ↑
composition roots
  ├─ worker / supervisor
  ├─ MCP server
  └─ CLI / bootstrap
```

의존성 화살표는 안쪽을 향한다. `src/application`과 `src/domain`은 SQLite, Cursor SDK,
MCP SDK, 프로세스 실행기 같은 outbound adapter를 import하지 않는다.

## 핵심 경계

- `src/domain/job.ts`는 Job과 Attempt 상태, 합법적인 Attempt 전이, 전달 결과의
  데이터 계약을 소유한다.
- `src/application/workflow-ports.ts`는 workflow가 요구하는 저장소 및 외부 실행
  포트를 소유한다. SQLite나 SDK 타입은 이 계약에 노출하지 않는다.
- `src/application/workflow.ts`는 기존 import 경로를 보존하는 facade다.
  `workflow-execution.ts`가 승인 작업의 준비, 구현, 제한된 repair, 게시 및 cleanup
  단계를 조율한다. `workflow-review-policy.ts`는 범위 평가, 검증 실패 선택과 repair
  피드백 생성을 맡고, `workflow-failure-handler.ts`는 실패, 취소 확인, 지연된 전달
  완료와 진단 보고를 별도로 처리한다.
- `src/state.ts`의 `JobStore`는 SQLite adapter facade다. 원자성이 필요한 Job/Attempt
  전이는 facade에 남기고, 스키마, 레코드 매핑, effect/event 원장과 전달 lifecycle은
  집중된 협력자에게 위임한다.
- `src/real-adapter.ts`의 `RealWorkflowAdapter`는 outbound adapter facade다. Cursor,
  worktree, 검증, GitHub 게시, artifact 작성 책임은 각각 독립 협력자에게 위임하며
  생성자에서 대체 구현을 주입할 수 있다.
- 각 outbound 협력자는 `PublicationStatePort` 전체가 아니라 실제로 사용하는
  메서드만 `Pick`한 좁은 계약을 받는다. 전체 포트는 조립점에서만 구현을 묶는 데
  사용한다.
- `src/worker.ts`는 기본 production 조립을 제공하지만 `WorkerDependencies`를 통해
  구성 로더, Task 로더, adapter factory, workflow 실행기를 명시적으로 주입할 수 있다.

## Cursor 실행 복구와 supervisor 경계

- `src/adapters/cursor-runner.ts`는 Attempt에 기록된 `agentId`/`runId`를 먼저
  읽는다. SDK local store에서 run이 `running`이고 `wait` capability를 가진
  authoritative live handle이면 기존 run을 그대로 재연결해 모니터링한다. persisted
  detached handle처럼 `supports("wait")`가 거짓인 run은 `RECOVERY_REQUIRED`와
  redacted report를 가진 fenced `BLOCKED` 결과로 끝내며, resume/send/cancel/follow-up
  또는 orphan retirement를 자동 수행하지 않는다. `local.force`로 만료시키거나
  follow-up을 만들지 않는다. Attempt에
  run ID가 없더라도 agent의 active run 목록을 생성 시각과 ID로 결정적으로 정렬해
  하나를 선택하고, worker lease가 보유한 SQLite transition으로 identity를 원자적으로
  다시 결속한다. 과거 구현이 남긴 `force_send` terminal marker도 오류 확정으로
  소비하지 않고 동일 agent의 최신 active run을 먼저 재조정한다. Cursor stream
  event는 run별 durable outbox에서 `PENDING`으로 먼저 보존한 뒤 로그에 기록하고
  `LOGGED`로 전이한다. stable event marker를 사용하는 로그 writer와 reclaim drain은
  write 성공 후 worker가 중단돼도 재전달하고 confirmed event를 중복 기록하지 않는다.
  stream 종료 직전 drain이 남은 pending을 확인하며, 로그 sink가 계속 실패하면
  `CURSOR_TRANSPORT_UNCERTAIN`으로 Attempt를 active/reclaimable 상태에 둔다. 로그
  파일 자체도 atomic lock으로 read/recheck/append를 직렬화한다.
- SDK 전송 오류는 task의 `max_repair_attempts`와 별도의 3회 bounded retry를
  사용한다. 각 재시도 전에 local run 목록으로 이미 수락된 run을 확인하므로
  ambiguous send가 중복 run을 만들지 않는다. 연결이 끝내 불확실하면
  `CURSOR_TRANSPORT_UNCERTAIN` 진단을 남기고 Attempt를 active 상태로 보존해 다음
  supervisor가 lease 만료 후 재조정한다.
- `src/supervisor.ts`는 claim, heartbeat, workflow 처리의 예외를 프로세스 경계에서
  흡수하고 250ms부터 최대 30초까지 bounded exponential backoff를 적용한다. active
  claim heartbeat timer는 claim이 해결되기 전까지 process-referenced 상태로 유지해
  detached/replay 작업이 code 0 자연 종료로 사라지지 않게 하며, completion/error/finally
  경로에서 정리한다. SIGTERM/SIGINT는 process claim과 bounded grace race를 거친 뒤
  참조된 미해결 handle도 강제로 종료해 lease 만료/reclaim을 보장한다. 예외가
  난 Attempt를 임의로 FAILED로 만들지 않으며, `supervisor.log`와 Job log에 전송
  진단을 남긴 뒤 replacement supervisor가 durable lease를 reclaim할 수 있게 한다.

## 조립 원칙

- 구체 구현 생성은 `worker`, `supervisor`, `mcp`, `cli` 같은 composition root에서만
  수행한다.
- 애플리케이션 서비스에 기능별 인터페이스를 무조건 추가하지 않는다. 실제 외부
  부작용 또는 테스트 대체점이 있는 경계에만 포트를 둔다.
- SQLite transaction을 여러 객체가 독립적으로 소유하지 않는다. 협력자는 같은
  connection을 사용하고 transaction 시작·완료의 책임은 한 lifecycle operation에
  유지한다.
- `git.ts`, `workflow.ts`, `task.ts`는 기존 import 경로 호환을 위한 얇은 facade다.
  새 내부 코드는 가능한 한 책임별 모듈 또는 안쪽 계약을 직접 참조한다.

## 자동 가드

`tests/architecture.test.ts`는 다음 회귀를 차단한다.

- domain/application에서 outbound adapter로 향하는 import
- 상대 source import cycle
- 700줄을 넘는 구현 파일
- 180줄을 넘는 개별 함수, 메서드 또는 생성자
- 900줄을 넘는 테스트 스위트

파일 길이 가드는 단순히 줄 수를 줄이기 위한 규칙이 아니다. 파일이 한 가지 변경
이유를 갖는지 다시 검토하도록 만드는 상한이며, 의미 없는 조각내기보다 응집된
협력자와 이름 있는 실행 단계 추출을 우선한다. 테스트 상한도 Cursor 실행, Git 게시,
artifact 작성처럼 실제 production 책임을 따라 시나리오를 나누도록 유도한다.
